const { groupsForKeys, readFieldVersions } = require('../fieldMerge')
const { applyDirect } = require('./directApplier')
const { normalizeType } = require('./protocol')

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)))
}

function opIdOf(op) {
  return String((op && (op.operation_id || op.operationId || op.opId)) || '')
}

function actorOf(op) {
  return String((op && (op.actor_id || op.actorId || op.userId)) || '')
}

function typeOf(op) {
  return normalizeType(op && (op.operation_type || op.type))
}

function payloadOf(op) {
  return (op && op.payload) || {}
}

function undoTargetId(op) {
  const payload = payloadOf(op)
  if (payload.undoOf) return String(payload.undoOf)
  if (typeOf(op) === 'operation.undo') {
    return String(payload.targetOperationId || payload.target_operation_id || '')
  }
  return ''
}

function redoTargetId(op) {
  const payload = payloadOf(op)
  if (payload.redoOf) return String(payload.redoOf)
  if (typeOf(op) === 'operation.redo') {
    return String(payload.targetOperationId || payload.target_operation_id || '')
  }
  return ''
}

function inverseOf(op) {
  return (op && (op.inverse_payload || op.inversePayload)) || null
}

function versionOf(op) {
  return Number((op && (op.version || op.serverRevision)) || 0)
}

function reject(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  err.statusCode = code === 'NOT_FOUND' ? 404 : 409
  Object.assign(err, extra)
  return err
}

function laterTouchesUid(op, uid) {
  const payload = payloadOf(op)
  const event = (op && op.event) || {}
  const ev = event.payload || {}
  const list = unique([
    payload.uid,
    ev.uid,
    ...(Array.isArray(payload.removed) ? payload.removed : []),
    ...(Array.isArray(ev.removed) ? ev.removed : []),
    ...(Array.isArray(event.affectedUids) ? event.affectedUids : [])
  ])
  return list.includes(uid)
}

function laterFieldGroups(op) {
  const payload = payloadOf(op)
  const event = (op && op.event) || {}
  const patch = payload.patch || payload.data || event.payload && event.payload.patch
  if (patch && typeof patch === 'object') {
    return groupsForKeys(Object.keys(patch).filter(key => key !== 'uid'))
  }
  if (payload.text != null) return groupsForKeys(['text'])
  if (payload.note != null) return groupsForKeys(['note'])
  return []
}

function isStructureInverse(type) {
  return (
    type === 'node.move' ||
    type === 'node.reorder' ||
    type === 'node.delete' ||
    type === 'node.restore' ||
    type === 'node.insert' ||
    type === 'node.batch'
  )
}

function evaluateUndo(target, laterOperations, actorId) {
  if (!target) return { ok: false, code: 'NOT_FOUND', error: 'operation not found' }
  if (actorOf(target) !== String(actorId || '')) {
    return { ok: false, code: 'UNDO_FORBIDDEN', error: '只能撤销自己的操作' }
  }
  const type = typeOf(target)
  if (type === 'operation.undo' || type === 'operation.redo') {
    return { ok: false, code: 'UNDO_FORBIDDEN', error: '不能再撤销一次撤销/重做操作' }
  }
  const inverse = inverseOf(target)
  if (!inverse || !inverse.type) {
    return { ok: false, code: 'UNDO_UNSUPPORTED', error: '该操作没有可逆数据' }
  }
  const later = Array.isArray(laterOperations) ? laterOperations : []
  const targetId = opIdOf(target)
  const undos = later.filter(op => undoTargetId(op) === targetId)
  if (undos.length) {
    const lastUndo = undos[undos.length - 1]
    const redone = later.some(
      op => redoTargetId(op) === targetId && versionOf(op) > versionOf(lastUndo)
    )
    if (!redone) {
      return { ok: false, code: 'ALREADY_UNDONE', error: '该操作已经撤销' }
    }
  }
  return { ok: true, inverse, target }
}

function evaluateRedo(original, laterOperations, actorId) {
  if (!original) return { ok: false, code: 'NOT_FOUND', error: 'operation not found' }
  if (actorOf(original) !== String(actorId || '')) {
    return { ok: false, code: 'REDO_FORBIDDEN', error: '只能重做自己撤销的操作' }
  }
  const later = Array.isArray(laterOperations) ? laterOperations : []
  const originalId = opIdOf(original)
  const undoOp = later.find(op => undoTargetId(op) === originalId)
  if (!undoOp) {
    return { ok: false, code: 'REDO_UNAVAILABLE', error: '该操作尚未撤销，无法重做' }
  }
  const afterUndo = later.filter(op => versionOf(op) > versionOf(undoOp))
  if (afterUndo.some(op => redoTargetId(op) === originalId)) {
    return { ok: false, code: 'ALREADY_REDONE', error: '该操作已经重做' }
  }
  return {
    ok: true,
    forward: {
      type: typeOf(original),
      payload: payloadOf(original)
    },
    undoOp
  }
}

function isActiveOp(op, later) {
  const id = opIdOf(op)
  const undos = (later || []).filter(item => undoTargetId(item) === id)
  if (!undos.length) return true
  const lastUndo = undos[undos.length - 1]
  return (later || []).some(
    item => redoTargetId(item) === id && versionOf(item) > versionOf(lastUndo)
  )
}

function stable(value) {
  try {
    return JSON.stringify(value)
  } catch (err) {
    return String(value)
  }
}

function forwardValue(target, key) {
  const payload = payloadOf(target)
  if (payload.patch && payload.patch[key] !== undefined) return payload.patch[key]
  if (payload.data && payload.data[key] !== undefined) return payload.data[key]
  return payload[key]
}

async function assertFieldSafe(store, target, inverse, later, actorId, kind) {
  const type = normalizeType(inverse.type)
  const uid = (inverse.payload && inverse.payload.uid) || (payloadOf(target).uid)
  if (!uid || type === 'node.batch') return
  const code = kind === 'redo' ? 'REDO_CONFLICT' : 'UNDO_CONFLICT'
  const order = kind === 'redo' ? 'REDO_OUT_OF_ORDER' : 'UNDO_OUT_OF_ORDER'
  const live = await store.getLive(uid)
  const activeLater = (later || []).filter(op => isActiveOp(op, later) && !undoTargetId(op) && !redoTargetId(op))
  if (type === 'node.update') {
    if (!live) throw reject(code, '目标节点已被删除，无法撤销/重做')
    const patch = inverse.payload.patch || inverse.payload.data || inverse.payload || {}
    const keys = Object.keys(patch).filter(key => {
      if (!key) return false
      if (groupsForKeys([key]).length === 0 && !['text', 'note', 'fillColor'].includes(key)) {
        return false
      }
      return ![
        'uid',
        'parent',
        'parentUid',
        'parent_uid',
        'index',
        'position',
        'confirm_sop_change',
        'undoOf',
        'redoOf',
        'ops',
        'rows',
        'patch',
        'data',
        'clientSeq',
        'baseRevision',
        'baseVersion'
      ].includes(key)
    })
    keys.forEach(key => {
      const current = live.data[key]
      const wanted = patch[key]
      if (stable(current) === stable(wanted === null ? undefined : wanted) || (wanted === null && current === undefined)) {
        return
      }
      const expected =
        kind === 'redo'
          ? ((inverseOf(target) && (inverseOf(target).payload.patch || inverseOf(target).payload)) || {})[key]
          : forwardValue(target, key)
      if (expected !== undefined && stable(current) === stable(expected)) return
      const blocker = activeLater.find(op => laterTouchesUid(op, uid))
      if (blocker && actorOf(blocker) === String(actorId || '')) {
        throw reject(order, '请先处理自己之后的相关操作', {
          overlappingUids: [uid],
          blockingVersion: versionOf(blocker)
        })
      }
      throw reject(code, '该内容已被其他协作者修改，无法直接撤销。', {
        overlappingUids: [uid],
        blockingVersion: blocker ? versionOf(blocker) : null,
        blockingActorId: blocker ? actorOf(blocker) : null
      })
    })
    return
  }
  if (isStructureInverse(type)) {
    const blocker = activeLater.find(op => {
      if (undoTargetId(op) === opIdOf(target) || redoTargetId(op) === opIdOf(target)) {
        return false
      }
      return laterTouchesUid(op, uid) && isStructureInverse(typeOf(op))
    })
    if (!blocker) return
    if (actorOf(blocker) !== String(actorId || '')) {
      throw reject(code, '相关结构已被其他协作者修改，无法直接撤销。', {
        overlappingUids: [uid],
        blockingVersion: versionOf(blocker),
        blockingActorId: actorOf(blocker)
      })
    }
    throw reject(order, '请先处理自己之后的相关操作', {
      overlappingUids: [uid],
      blockingVersion: versionOf(blocker)
    })
  }
}

function generatedFromInverse(inverse, extra = {}) {
  return {
    type: inverse.type,
    payload: {
      ...(inverse.payload || {}),
      confirm_sop_change: true,
      ...extra
    }
  }
}

async function applyUndoOrRedo(store, raw, options = {}) {
  const lookup = options.lookup
  if (!lookup || typeof lookup.getOperation !== 'function') {
    throw reject('UNDO_UNSUPPORTED', '缺少 operation lookup')
  }
  const type = normalizeType(raw.type)
  const payload = raw.payload || {}
  const targetId = String(
    payload.targetOperationId || payload.target_operation_id || payload.targetOpId || ''
  )
  const target = await lookup.getOperation(targetId)
  if (!target) throw reject('NOT_FOUND', 'operation not found')
  const later = await lookup.listAfter(versionOf(target))
  const actorId = raw.userId || raw.actorId
  const version = Number(options.version) || 0
  if (type === 'operation.undo') {
    const verdict = evaluateUndo(target, later, actorId)
    if (!verdict.ok) throw reject(verdict.code, verdict.error)
    await assertFieldSafe(store, target, verdict.inverse, later, actorId, 'undo')
    const generated = generatedFromInverse(verdict.inverse, {
      undoOf: opIdOf(target)
    })
    if (normalizeType(generated.type) === 'map.replace') {
      if (typeof options.applyReplace !== 'function') {
        throw reject('UNDO_UNSUPPORTED', '无法撤销整图导入')
      }
      const replaced = await options.applyReplace(generated)
      if (replaced.event && replaced.event.payload) {
        replaced.event.payload.undoOf = opIdOf(target)
      }
      replaced.generatedType = 'map.replace'
      return replaced
    }
    const applied = await applyDirect(store, { ...generated, roomKey: raw.roomKey }, { version })
    if (applied.event && applied.event.payload) {
      applied.event.payload.undoOf = opIdOf(target)
    }
    applied.generatedType = generated.type
    return applied
  }
  const verdict = evaluateRedo(target, later, actorId)
  if (!verdict.ok) throw reject(verdict.code, verdict.error)
  const redoSource = inverseOf(verdict.undoOp) || verdict.forward
  const forward = generatedFromInverse(redoSource, {
    redoOf: opIdOf(target)
  })
  await assertFieldSafe(
    store,
    target,
    forward,
    later.filter(op => versionOf(op) > versionOf(verdict.undoOp)),
    actorId,
    'redo'
  )
  if (normalizeType(forward.type) === 'map.replace') {
    if (typeof options.applyReplace !== 'function') {
      throw reject('UNDO_UNSUPPORTED', '无法重做整图导入')
    }
    const replaced = await options.applyReplace(forward)
    if (replaced.event && replaced.event.payload) {
      replaced.event.payload.redoOf = opIdOf(target)
    }
    replaced.generatedType = 'map.replace'
    return replaced
  }
  const applied = await applyDirect(store, { ...forward, roomKey: raw.roomKey }, { version })
  if (applied.event && applied.event.payload) {
    applied.event.payload.redoOf = opIdOf(target)
  }
  applied.generatedType = forward.type
  return applied
}

function createMemoryLookup(room) {
  return {
    async getOperation(id) {
      return room.opsById.get(id) || null
    },
    async listAfter(version) {
      return (room.ops || []).filter(op => Number(op.version || op.serverRevision) > Number(version))
    }
  }
}

function createPgLookup(client, roomKey) {
  return {
    async getOperation(id) {
      const res = await client.query(
        `select room_key, version, operation_id, actor_id, client_id,
                operation_type, payload, event, inverse_payload
         from room_operations
         where room_key = $1 and operation_id = $2`,
        [roomKey, id]
      )
      return res.rows[0] || null
    },
    async listAfter(version) {
      const res = await client.query(
        `select room_key, version, operation_id, actor_id, client_id,
                operation_type, payload, event, inverse_payload
         from room_operations
         where room_key = $1 and version > $2
         order by version asc
         limit 1000`,
        [roomKey, Number(version) || 0]
      )
      return res.rows
    }
  }
}

module.exports = {
  evaluateUndo,
  evaluateRedo,
  applyUndoOrRedo,
  createMemoryLookup,
  createPgLookup,
  undoTargetId
}
