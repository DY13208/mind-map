const mindDoc = require('./mindDoc')

const COMMAND_META_KEYS = [
  'uid',
  'parent',
  'parentUid',
  'parent_uid',
  'index',
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
  if (!parentUid) return { parentUid: null, index: -1 }
  return {
    parentUid,
    index: (obj[parentUid].children || []).indexOf(uid)
  }
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
  const payload = command.payload || {}
  if (payload.confirm_sop_change === true) return
  const target =
    command.type === 'node.insert'
      ? payload.parentUid || payload.parent_uid || payload.parent || 'root'
      : payload.uid
  if (mindDoc.isWithinSop(obj, target)) throw sopError()
}

function applyNodeCommand(ydoc, command) {
  const payload = command.payload || {}
  const before = mindDoc.readObject(ydoc)
  assertSopAllowed(before, command)
  if (command.type === 'node.insert') {
    const parent =
      payload.parentUid || payload.parent_uid || payload.parent || 'root'
    const result = mindDoc.addNodeOnDoc(ydoc, {
      parent,
      uid: payload.uid,
      text: payload.text,
      note: payload.note,
      index: payload.index
    })
    const patch = dataFields(payload.data || payload)
    if (Object.keys(patch).length) mindDoc.updateNodeOnDoc(ydoc, result.uid, patch)
    if (payload.uid !== result.uid) payload.uid = result.uid
    return {
      result,
      inversePayload: { type: 'node.delete', payload: { uid: result.uid } },
      event: {
        type: 'node.inserted',
        payload: { ...payload, uid: result.uid, parentUid: result.parent_uid },
        affectedUids: [result.uid, result.parent_uid].filter(Boolean)
      }
    }
  }
  if (command.type === 'node.update' || command.type === 'node.move') {
    const uid = payload.uid
    if (!uid || !before[uid]) throw new Error('node not found')
    const oldLocation = parentPosition(before, uid)
    const oldData = { ...(before[uid].data || {}) }
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    if (parent !== undefined || payload.index !== undefined) {
      mindDoc.moveNodeOnDoc(ydoc, { uid, parent, index: payload.index })
    }
    const patch = dataFields(payload.patch || payload.data || payload)
    if (Object.keys(patch).length) mindDoc.updateNodeOnDoc(ydoc, uid, patch)
    return {
      result: { uid },
      inversePayload: {
        type: 'node.update',
        payload: {
          uid,
          parentUid: oldLocation.parentUid,
          index: oldLocation.index,
          data: oldData
        }
      },
      event: {
        type:
          parent !== undefined || payload.index !== undefined
            ? 'node.moved'
            : 'node.updated',
        payload: { ...payload, uid },
        affectedUids: [uid, oldLocation.parentUid, parent].filter(Boolean)
      }
    }
  }
  if (command.type === 'node.delete') {
    const uid = payload.uid
    if (!uid || !before[uid]) throw new Error('node not found')
    const oldLocation = parentPosition(before, uid)
    const keepChildren = !!(payload.keepChildren || payload.keep_children)
    const result = keepChildren
      ? mindDoc.deleteCurrentNodeOnDoc(ydoc, uid)
      : mindDoc.deleteNodeOnDoc(ydoc, uid)
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
  throw new Error(`unsupported operation type: ${command.type}`)
}

module.exports = {
  parentPosition,
  dataFields,
  assertSopAllowed,
  applyNodeCommand
}
