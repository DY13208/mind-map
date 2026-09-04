const mindDoc = require('./mindDoc')
const { insertPositionAt } = require('./fractionalIndex')
const { mergeNodeDataLww } = require('./fieldMerge')
const {
  parentDeletedError,
  nodeDeletedError,
  moveConflictError,
  uidReusedError,
  cycleError,
  commandError
} = require('./conflictErrors')

const COMMAND_META_KEYS = [
  'uid',
  'parent',
  'parentUid',
  'parent_uid',
  'index',
  'position',
  'operationId',
  'operation_id',
  'actorId',
  'actor_id',
  'clientId',
  'client_id',
  'baseVersion',
  'base_version',
  'type',
  'payload',
  'confirm_sop_change',
  'keep_children',
  'keepChildren'
]

function parentPosition(obj, uid) {
  const parentUid = Object.keys(obj || {}).find(id => {
    return ((obj[id] && obj[id].children) || []).includes(uid)
  })
  if (!parentUid) return { parentUid: null, index: -1, position: '' }
  return {
    parentUid,
    index: (obj[parentUid].children || []).indexOf(uid),
    position: (obj[uid] && obj[uid].position) || ''
  }
}

function writeNodePatch(ydoc, obj, uids) {
  const patch = {}
  ;(uids || []).forEach(uid => {
    if (uid && obj[uid]) patch[uid] = obj[uid]
  })
  if (!Object.keys(patch).length) return
  mindDoc.applyObjectToDoc(ydoc, patch, {
    previousObject: ydoc.getMap().toJSON(),
    deleteUids: []
  })
}

function stampPositions(ydoc, parentUid, uid) {
  const obj = mindDoc.readObject(ydoc)
  if (!parentUid || !uid || !obj[uid]) {
    return { position: '', index: -1, reindexed: false }
  }
  const assigned = insertPositionAt(obj, parentUid, uid)
  const uids = assigned.reindexed ? Object.keys(assigned.positions || {}) : [uid]
  writeNodePatch(ydoc, obj, uids)
  const kids = (obj[parentUid] && obj[parentUid].children) || []
  return {
    position: (obj[uid] && obj[uid].position) || assigned.position || '',
    index: kids.indexOf(uid),
    reindexed: !!assigned.reindexed,
    siblingPositions: assigned.reindexed ? assigned.positions : undefined
  }
}

function withAuthoritativeOrder(event, stamp) {
  const payload = {
    ...(event.payload || {}),
    position: stamp.position,
    index: stamp.index
  }
  if (stamp.reindexed) {
    payload.reindex = true
    payload.siblingPositions = stamp.siblingPositions
  }
  return { ...event, payload }
}

function dataFields(input = {}) {
  const patch = { ...(input || {}) }
  COMMAND_META_KEYS.forEach(key => delete patch[key])
  return patch
}

function sopError() {
  const err = new Error('修改SOP前必须获得用户确认并设置confirm_sop_change=true')
  err.statusCode = 400
  err.code = 'SOP_CONFIRM_REQUIRED'
  return err
}

function assertSopAllowed(obj, command) {
  const { inspectSopChange, sopConfirmError } = require('../src/utils/collabSopGuard')
  const payload = command.payload || {}
  const trace = inspectSopChange({
    type: command.type,
    payload,
    nodes: obj,
    targetUid: payload.uid,
    currentNodes: obj
  })
  if (trace.required) throw sopConfirmError(trace)
}

function wrapMindDocError(err) {
  const message = String((err && err.message) || err || '')
  if (/找不到父节点/.test(message)) throw parentDeletedError()
  if (/找不到节点/.test(message)) throw nodeDeletedError()
  if (/节点已存在/.test(message)) {
    throw commandError(message, 'UID_EXISTS', 409)
  }
  if (/不能把节点移动到自己/.test(message)) throw cycleError()
  throw err
}

function applyNodeCommand(ydoc, command, options = {}) {
  const payload = command.payload || {}
  const before = mindDoc.readObject(ydoc)
  const nextVersion = Number(options.version) || 0
  const deletedUids = options.deletedUids || new Set()
  const allowUidReuse = options.allowUidReuse === true
  assertSopAllowed(before, command)
  if (command.type === 'node.insert') {
    const parent =
      payload.parentUid || payload.parent_uid || payload.parent || 'root'
    if (!before[parent]) throw parentDeletedError(parent)
    const requestedUid = String(payload.uid || '').trim()
    if (requestedUid && before[requestedUid]) {
      throw commandError(`节点已存在: ${requestedUid}`, 'UID_EXISTS', 409)
    }
    if (requestedUid && !allowUidReuse && deletedUids.has(requestedUid)) {
      throw uidReusedError(requestedUid)
    }
    let result
    try {
      result = mindDoc.addNodeOnDoc(ydoc, {
        parent,
        uid: payload.uid,
        text: payload.text,
        note: payload.note,
        index: payload.index
      })
    } catch (err) {
      wrapMindDocError(err)
    }
    const patch = dataFields(payload.data || payload)
    if (Object.keys(patch).length) {
      const merged = mergeNodeDataLww({}, patch, nextVersion)
      mindDoc.updateNodeOnDoc(ydoc, result.uid, merged.data)
    }
    if (payload.uid !== result.uid) payload.uid = result.uid
    const stamp = stampPositions(ydoc, result.parent_uid, result.uid)
    return {
      result: { ...result, position: stamp.position, index: stamp.index },
      inversePayload: { type: 'node.delete', payload: { uid: result.uid } },
      event: withAuthoritativeOrder(
        {
          type: 'node.inserted',
          payload: { ...payload, uid: result.uid, parentUid: result.parent_uid },
          affectedUids: [result.uid, result.parent_uid].filter(Boolean)
        },
        stamp
      )
    }
  }
  if (command.type === 'node.update' || command.type === 'node.move') {
    const uid = payload.uid
    const moving =
      payload.parentUid !== undefined ||
      payload.parent_uid !== undefined ||
      payload.parent !== undefined ||
      payload.index !== undefined ||
      payload.position !== undefined
    if (!uid || !before[uid]) {
      throw moving ? moveConflictError(uid) : nodeDeletedError(uid)
    }
    const oldLocation = parentPosition(before, uid)
    const oldData = { ...(before[uid].data || {}) }
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    if (parent !== undefined || payload.index !== undefined) {
      if (parent !== undefined && parent != null && !before[parent]) {
        throw parentDeletedError(parent)
      }
      try {
        mindDoc.moveNodeOnDoc(ydoc, { uid, parent, index: payload.index })
      } catch (err) {
        wrapMindDocError(err)
      }
    }
    const patch = dataFields(payload.patch || payload.data || payload)
    let changedFields = Object.keys(patch)
    let fieldVersions = {}
    if (Object.keys(patch).length) {
      const merged = mergeNodeDataLww(oldData, patch, nextVersion)
      changedFields = merged.changedFields
      fieldVersions = merged.fieldVersions
      // Only write changed collaborative fields + field versions.
      const writePatch = {}
      changedFields.forEach(key => {
        writePatch[key] = merged.data[key] === undefined ? null : merged.data[key]
      })
      if (Object.keys(fieldVersions).length) writePatch.__fv = fieldVersions
      mindDoc.updateNodeOnDoc(ydoc, uid, writePatch)
    }
    const moved = moving
    const after = mindDoc.readObject(ydoc)
    const newLocation = parentPosition(after, uid)
    const stamp = moved
      ? stampPositions(ydoc, newLocation.parentUid, uid)
      : {
          position: newLocation.position,
          index: newLocation.index,
          reindexed: false
        }
    const inverseData = {}
    changedFields.forEach(key => {
      inverseData[key] = oldData[key] === undefined ? null : oldData[key]
    })
    if (Object.keys(fieldVersions).length) {
      inverseData.__fv = { ...(oldData.__fv || {}) }
    }
    return {
      result: { uid, position: stamp.position, index: stamp.index },
      inversePayload: {
        type: moved ? 'node.move' : 'node.update',
        payload: {
          uid,
          parentUid: oldLocation.parentUid,
          index: oldLocation.index,
          position: oldLocation.position,
          ...(moved ? { data: oldData } : { patch: inverseData })
        }
      },
      event: withAuthoritativeOrder(
        {
          type: moved ? 'node.moved' : 'node.updated',
          payload: {
            ...payload,
            uid,
            ...(changedFields.length ? { changedFields } : {}),
            ...(Object.keys(fieldVersions).length ? { fieldVersions } : {})
          },
          affectedUids: [uid, oldLocation.parentUid, parent].filter(Boolean)
        },
        stamp
      )
    }
  }
  if (command.type === 'node.reorder') {
    const uid = payload.uid
    if (!uid || !before[uid]) throw moveConflictError(uid)
    const oldLocation = parentPosition(before, uid)
    if (!oldLocation.parentUid) {
      throw commandError('根节点不能重排', 'REORDER_ROOT', 400)
    }
    const requestedParent =
      payload.parentUid || payload.parent_uid || payload.parent
    if (
      requestedParent !== undefined &&
      requestedParent != null &&
      String(requestedParent) !== String(oldLocation.parentUid)
    ) {
      throw commandError(
        'node.reorder 不能更换父节点，请使用 node.move',
        'REORDER_PARENT_CHANGED',
        400
      )
    }
    if (payload.index === undefined && payload.position === undefined) {
      throw commandError('node.reorder 需要 index 或 position', 'REORDER_TARGET', 400)
    }
    try {
      mindDoc.moveNodeOnDoc(ydoc, {
        uid,
        parent: oldLocation.parentUid,
        index: payload.index
      })
    } catch (err) {
      wrapMindDocError(err)
    }
    const after = mindDoc.readObject(ydoc)
    const newLocation = parentPosition(after, uid)
    const stamp = stampPositions(ydoc, newLocation.parentUid, uid)
    return {
      result: {
        uid,
        parent_uid: newLocation.parentUid,
        position: stamp.position,
        index: stamp.index
      },
      inversePayload: {
        type: 'node.reorder',
        payload: {
          uid,
          parentUid: oldLocation.parentUid,
          index: oldLocation.index,
          position: oldLocation.position
        }
      },
      event: withAuthoritativeOrder(
        {
          type: 'node.reordered',
          payload: {
            uid,
            parentUid: newLocation.parentUid,
            index: stamp.index,
            fromIndex: oldLocation.index
          },
          affectedUids: [uid, newLocation.parentUid].filter(Boolean)
        },
        stamp
      )
    }
  }
  if (command.type === 'node.delete') {
    const uid = payload.uid
    if (!uid || !before[uid]) throw nodeDeletedError(uid)
    const oldLocation = parentPosition(before, uid)
    const keepChildren = !!(payload.keepChildren || payload.keep_children)
    let result
    try {
      result = keepChildren
        ? mindDoc.deleteCurrentNodeOnDoc(ydoc, uid)
        : mindDoc.deleteNodeOnDoc(ydoc, uid)
    } catch (err) {
      wrapMindDocError(err)
    }
    const removedNodes = {}
    ;(result.removed || [uid]).forEach(id => {
      if (before[id]) removedNodes[id] = before[id]
    })
    return {
      result,
      inversePayload: {
        type: 'node.restore',
        payload: {
          uid,
          parentUid: oldLocation.parentUid,
          index: oldLocation.index,
          position: oldLocation.position,
          nodes: removedNodes
        }
      },
      event: {
        type: 'node.deleted',
        payload: {
          uid,
          removed: result.removed || [],
          keepChildren,
          promoted: result.promoted || []
        },
        affectedUids: [uid, oldLocation.parentUid, ...(result.removed || [])].filter(
          Boolean
        )
      }
    }
  }
  if (command.type === 'node.restore') {
    const restored = restoreNodesOnDoc(ydoc, payload)
    const parentUid = payload.parentUid || payload.parent_uid || payload.parent
    if (parentUid && !mindDoc.readObject(ydoc)[parentUid] && !before[parentUid]) {
      // parent may already be restored as part of nodes payload
    }
    const stamp = stampPositions(ydoc, parentUid, payload.uid)
    return {
      result: { ...restored, position: stamp.position, index: stamp.index },
      inversePayload: {
        type: 'node.delete',
        payload: { uid: payload.uid, confirm_sop_change: true }
      },
      event: withAuthoritativeOrder(
        {
          type: 'node.restored',
          payload: {
            uid: payload.uid,
            parentUid,
            restored: restored.restored
          },
          affectedUids: uniqueUids([
            payload.uid,
            parentUid,
            ...(restored.restored || [])
          ])
        },
        stamp
      )
    }
  }
  if (command.type === 'operation.redo') {
    const forward = payload.forward || {}
    if (!forward || !forward.type) {
      throw new Error('缺少可执行的重做操作')
    }
    const applied = applyNodeCommand(
      ydoc,
      {
        type: forward.type,
        payload: {
          ...(forward.payload || {}),
          confirm_sop_change: true
        }
      },
      {
        ...options,
        allowUidReuse:
          options.allowUidReuse === true ||
          forward.type === 'node.restore' ||
          forward.type === 'node.insert'
      }
    )
    return {
      result: applied.result,
      inversePayload: applied.inversePayload,
      event: {
        type: 'operation.redone',
        payload: {
          targetOperationId: payload.targetOperationId,
          undoOperationId: payload.undoOperationId,
          forwardType: forward.type,
          forward
        },
        affectedUids: (applied.event && applied.event.affectedUids) || []
      }
    }
  }
  if (command.type === 'operation.undo') {
    const inverse = payload.inverse || payload
    if (!inverse || !inverse.type || inverse.type === 'operation.undo') {
      throw new Error('缺少可执行的逆向操作')
    }
    const applied = applyNodeCommand(
      ydoc,
      {
        type: inverse.type,
        payload: {
          ...(inverse.payload || {}),
          confirm_sop_change: true
        }
      },
      {
        ...options,
        allowUidReuse:
          options.allowUidReuse === true || inverse.type === 'node.restore'
      }
    )
    return {
      result: applied.result,
      inversePayload: {
        type: 'operation.redo',
        payload: {
          targetOperationId: payload.targetOperationId,
          originalType: command.type
        }
      },
      event: {
        type: 'operation.undone',
        payload: {
          targetOperationId: payload.targetOperationId,
          targetVersion: payload.targetVersion,
          inverseType: inverse.type,
          inverse
        },
        affectedUids: (applied.event && applied.event.affectedUids) || []
      }
    }
  }
  throw new Error(`unsupported operation type: ${command.type}`)
}

function uniqueUids(list) {
  return [...new Set((list || []).filter(Boolean))]
}

function restoreNodesOnDoc(ydoc, payload = {}) {
  const obj = mindDoc.readObject(ydoc)
  const nodes = payload.nodes || {}
  Object.keys(nodes).forEach(uid => {
    obj[uid] = JSON.parse(JSON.stringify(nodes[uid]))
  })
  const uid = payload.uid
  const parentUid = payload.parentUid || payload.parent_uid || payload.parent
  const promoted = (uid && obj[uid] && obj[uid].children) || []
  if (parentUid && obj[parentUid] && uid) {
    let kids = [...(obj[parentUid].children || [])].filter(id => id !== uid)
    kids = kids.filter(id => !promoted.includes(id))
    const index = Number(payload.index)
    if (!Number.isFinite(index) || index < 0 || index > kids.length) {
      kids.push(uid)
    } else {
      kids.splice(index, 0, uid)
    }
    obj[parentUid] = { ...obj[parentUid], children: kids }
  }
  mindDoc.applyObjectToDoc(ydoc, obj, { replace: true })
  return { uid, restored: Object.keys(nodes) }
}

module.exports = {
  parentPosition,
  dataFields,
  assertSopAllowed,
  applyNodeCommand
}
