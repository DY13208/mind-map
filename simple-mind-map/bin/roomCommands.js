const mindDoc = require('./mindDoc')
const { insertPositionAt } = require('./fractionalIndex')

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
    if (!uid || !before[uid]) throw new Error('node not found')
    const oldLocation = parentPosition(before, uid)
    const oldData = { ...(before[uid].data || {}) }
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    if (parent !== undefined || payload.index !== undefined) {
      mindDoc.moveNodeOnDoc(ydoc, { uid, parent, index: payload.index })
    }
    const patch = dataFields(payload.patch || payload.data || payload)
    if (Object.keys(patch).length) mindDoc.updateNodeOnDoc(ydoc, uid, patch)
    const moved = parent !== undefined || payload.index !== undefined || payload.position
    const after = mindDoc.readObject(ydoc)
    const newLocation = parentPosition(after, uid)
    const stamp = moved
      ? stampPositions(ydoc, newLocation.parentUid, uid)
      : {
          position: newLocation.position,
          index: newLocation.index,
          reindexed: false
        }
    return {
      result: { uid, position: stamp.position, index: stamp.index },
      inversePayload: {
        type: 'node.update',
        payload: {
          uid,
          parentUid: oldLocation.parentUid,
          index: oldLocation.index,
          position: oldLocation.position,
          data: oldData
        }
      },
      event: withAuthoritativeOrder(
        {
          type: moved ? 'node.moved' : 'node.updated',
          payload: { ...payload, uid },
          affectedUids: [uid, oldLocation.parentUid, parent].filter(Boolean)
        },
        stamp
      )
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
  if (command.type === 'operation.undo') {
    const inverse = payload.inverse || payload
    if (!inverse || !inverse.type || inverse.type === 'operation.undo') {
      throw new Error('缺少可执行的逆向操作')
    }
    const applied = applyNodeCommand(ydoc, {
      type: inverse.type,
      payload: {
        ...(inverse.payload || {}),
        confirm_sop_change: true
      }
    })
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
