function unique(list) {
  return [...new Set((list || []).filter(Boolean))]
}

function primaryUidsOf(operation) {
  const event = (operation && operation.event) || {}
  const payload = event.payload || (operation && operation.payload) || {}
  const inverse = (operation && operation.inverse_payload) || {}
  const inv = inverse.payload || {}
  const restored =
    inv.nodes && typeof inv.nodes === 'object' ? Object.keys(inv.nodes) : []
  return unique([
    payload.uid,
    inv.uid,
    ...(Array.isArray(payload.removed) ? payload.removed : []),
    ...restored
  ])
}

function affectedUidsOf(operation) {
  const event = (operation && operation.event) || {}
  const payload = event.payload || (operation && operation.payload) || {}
  return unique([
    ...(Array.isArray(event.affectedUids) ? event.affectedUids : []),
    payload.uid,
    payload.parentUid,
    payload.parent_uid,
    payload.parent,
    ...(Array.isArray(payload.removed) ? payload.removed : [])
  ])
}

function targetOperationIdOf(operation) {
  const payload =
    (operation && operation.event && operation.event.payload) ||
    (operation && operation.payload) ||
    {}
  return payload.targetOperationId || payload.target_operation_id || ''
}

function redoTargetOperationIdOf(operation) {
  const payload =
    (operation && operation.event && operation.event.payload) ||
    (operation && operation.payload) ||
    {}
  return (
    payload.targetOperationId ||
    payload.target_operation_id ||
    payload.forwardTargetOperationId ||
    ''
  )
}

function findUndoFor(originalOperationId, laterOperations) {
  return (laterOperations || []).find(
    op =>
      op.operation_type === 'operation.undo' &&
      targetOperationIdOf(op) === originalOperationId
  )
}

function evaluateRedo(original, laterOperations, actorId) {
  if (!original) {
    return { ok: false, code: 'NOT_FOUND', error: 'operation not found' }
  }
  if (String(original.actor_id || '') !== String(actorId || '')) {
    return {
      ok: false,
      code: 'REDO_FORBIDDEN',
      error: '只能重做自己撤销的操作'
    }
  }
  if (original.operation_type === 'operation.undo') {
    return {
      ok: false,
      code: 'REDO_FORBIDDEN',
      error: '不能直接重做撤销操作本身'
    }
  }
  const later = Array.isArray(laterOperations) ? laterOperations : []
  const undoOp = findUndoFor(original.operation_id, later)
  if (!undoOp) {
    return {
      ok: false,
      code: 'REDO_UNAVAILABLE',
      error: '该操作尚未撤销，无法重做'
    }
  }
  const afterUndo = later.filter(op => Number(op.version) > Number(undoOp.version))
  if (
    afterUndo.some(
      op =>
        op.operation_type === 'operation.redo' &&
        redoTargetOperationIdOf(op) === original.operation_id
    )
  ) {
    return {
      ok: false,
      code: 'ALREADY_REDONE',
      error: '该操作已经重做'
    }
  }
  const mine = new Set(primaryUidsOf(original))
  if (!mine.size) {
    affectedUidsOf(original).forEach(uid => mine.add(uid))
  }
  for (let i = 0; i < afterUndo.length; i++) {
    const op = afterUndo[i]
    if (
      op.operation_type === 'operation.redo' &&
      redoTargetOperationIdOf(op) === original.operation_id
    ) {
      continue
    }
    const overlap = unique([
      ...primaryUidsOf(op),
      ...affectedUidsOf(op)
    ]).filter(uid => mine.has(uid))
    if (!overlap.length) continue
    if (String(op.actor_id || '') !== String(actorId || '')) {
      return {
        ok: false,
        code: 'REDO_CONFLICT',
        error: '后续其他用户修改了相关节点，不能直接重做',
        overlappingUids: overlap,
        blockingVersion: op.version,
        blockingActorId: op.actor_id
      }
    }
    return {
      ok: false,
      code: 'REDO_OUT_OF_ORDER',
      error: '请先处理自己之后的相关操作',
      overlappingUids: overlap,
      blockingVersion: op.version
    }
  }
  return {
    ok: true,
    forward: {
      type: original.operation_type,
      payload: original.payload || {}
    },
    undoOperationId: undoOp.operation_id,
    undoVersion: undoOp.version
  }
}

function evaluateUndo(target, laterOperations, actorId) {
  if (!target) {
    return { ok: false, code: 'NOT_FOUND', error: 'operation not found' }
  }
  if (String(target.actor_id || '') !== String(actorId || '')) {
    return {
      ok: false,
      code: 'UNDO_FORBIDDEN',
      error: '只能撤销自己的操作'
    }
  }
  if (target.operation_type === 'operation.undo') {
    return {
      ok: false,
      code: 'UNDO_FORBIDDEN',
      error: '不能再撤销一次撤销操作'
    }
  }
  const inverse = target.inverse_payload
  if (!inverse || !inverse.type) {
    return {
      ok: false,
      code: 'UNDO_UNSUPPORTED',
      error: '该操作没有可逆数据'
    }
  }
  const later = Array.isArray(laterOperations) ? laterOperations : []
  if (
    later.some(
      op =>
        op.operation_type === 'operation.undo' &&
        targetOperationIdOf(op) === target.operation_id
    )
  ) {
    return {
      ok: false,
      code: 'ALREADY_UNDONE',
      error: '该操作已经撤销'
    }
  }
  const mine = new Set(primaryUidsOf(target))
  if (!mine.size) {
    affectedUidsOf(target).forEach(uid => mine.add(uid))
  }
  for (let i = 0; i < later.length; i++) {
    const op = later[i]
    const overlap = unique([
      ...primaryUidsOf(op),
      ...affectedUidsOf(op)
    ]).filter(uid => mine.has(uid))
    if (!overlap.length) continue
    if (String(op.actor_id || '') !== String(actorId || '')) {
      return {
        ok: false,
        code: 'UNDO_CONFLICT',
        error: '后续其他用户修改了相关节点，不能直接撤销',
        overlappingUids: overlap,
        blockingVersion: op.version,
        blockingActorId: op.actor_id
      }
    }
    return {
      ok: false,
      code: 'UNDO_OUT_OF_ORDER',
      error: '请先撤销自己之后的相关操作',
      overlappingUids: overlap,
      blockingVersion: op.version
    }
  }
  return { ok: true, inverse }
}

function applyRestore(obj, payload = {}) {
  const next = JSON.parse(JSON.stringify(obj || {}))
  const nodes = payload.nodes || {}
  Object.keys(nodes).forEach(uid => {
    next[uid] = JSON.parse(JSON.stringify(nodes[uid]))
  })
  ;(payload.rows || []).forEach(row => {
    next[row.uid] = {
      isRoot: !!row.is_root,
      data: { ...(row.data || {}), uid: row.uid },
      children: (next[row.uid] && next[row.uid].children) || [],
      position: row.position || ''
    }
  })
  ;(payload.rows || []).forEach(row => {
    const parentUid = row.parent_uid
    if (!parentUid || !next[parentUid]) return
    const kids = [...(next[parentUid].children || [])]
    if (!kids.includes(row.uid)) kids.push(row.uid)
    next[parentUid] = { ...next[parentUid], children: kids }
  })
  const uid = payload.uid
  const parentUid = payload.parentUid || payload.parent_uid || payload.parent
  const promoted = (uid && next[uid] && next[uid].children) || []
  if (parentUid && next[parentUid] && uid) {
    let kids = [...(next[parentUid].children || [])].filter(id => id !== uid)
    kids = kids.filter(id => !promoted.includes(id))
    const index = Number(payload.index)
    if (!Number.isFinite(index) || index < 0 || index > kids.length) {
      kids.push(uid)
    } else {
      kids.splice(index, 0, uid)
    }
    next[parentUid] = { ...next[parentUid], children: kids }
  }
  return next
}

function applyInverseOperation(obj, operation) {
  const inverse = operation && operation.inverse_payload
  if (!inverse || !inverse.type) {
    const err = new Error('缺少逆向操作，无法重建该版本')
    err.code = 'SNAPSHOT_UNAVAILABLE'
    throw err
  }
  if (inverse.type === 'node.delete') {
    const { applyCollabEvent } = require('./collabRecovery')
    return applyCollabEvent(obj, {
      type: 'node.deleted',
      payload: inverse.payload || {}
    })
  }
  if (
    inverse.type === 'node.update' ||
    inverse.type === 'node.move' ||
    inverse.type === 'node.reorder'
  ) {
    const { applyCollabEvent } = require('./collabRecovery')
    return applyCollabEvent(obj, {
      type:
        inverse.type === 'node.reorder'
          ? 'node.reordered'
          : inverse.type === 'node.move'
            ? 'node.moved'
            : 'node.moved',
      payload: inverse.payload || {}
    })
  }
  if (inverse.type === 'node.restore') {
    return applyRestore(obj, inverse.payload || {})
  }
  const err = new Error(`不支持的逆向操作: ${inverse.type}`)
  err.code = 'SNAPSHOT_UNAVAILABLE'
  throw err
}

function reconstructByInverses(currentNodes, laterOperations) {
  let nodes = JSON.parse(JSON.stringify(currentNodes || {}))
  const later = [...(laterOperations || [])].sort(
    (a, b) => Number(b.version) - Number(a.version)
  )
  for (let i = 0; i < later.length; i++) {
    nodes = applyInverseOperation(nodes, later[i])
  }
  return nodes
}

module.exports = {
  affectedUidsOf,
  evaluateUndo,
  evaluateRedo,
  applyRestore,
  applyInverseOperation,
  reconstructByInverses
}
