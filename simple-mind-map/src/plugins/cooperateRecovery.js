const DEFAULT_RESNAPSHOT_GAP = 500

export function operationRequiresResnapshot(item) {
  const event = (item && item.event) || item || {}
  const payload = event.payload || {}
  const type = String(event.type || (item && item.operation_type) || '')
  return (
    payload.resnapshot === true ||
    event.resnapshot === true ||
    type === 'map.replaced' ||
    type === 'batch.applied'
  )
}

export function planCollabRecovery(
  lastAppliedVersion,
  targetVersion,
  maxGap = DEFAULT_RESNAPSHOT_GAP
) {
  const last = Number(lastAppliedVersion) || 0
  const target = Number(targetVersion)
  if (!Number.isFinite(target) || target <= last) {
    return { type: 'ignore', lastAppliedVersion: last }
  }
  if (target - last > maxGap) {
    return { type: 'resnapshot', version: target }
  }
  return { type: 'fetch_operations', afterVersion: last, version: target }
}

function findParentUid(obj, uid) {
  return (
    Object.keys(obj || {}).find(id =>
      ((obj[id] && obj[id].children) || []).includes(uid)
    ) || null
  )
}

function cloneNodes(obj) {
  return JSON.parse(JSON.stringify(obj || {}))
}

function applySiblingPositionsFromPayload(next, payload) {
  const map = payload && payload.siblingPositions
  if (!map || typeof map !== 'object') return
  Object.keys(map).forEach(uid => {
    if (next[uid]) next[uid].position = map[uid]
  })
}

function placeChild(next, parentUid, uid, payload) {
  applySiblingPositionsFromPayload(next, payload)
  if (payload.position && next[uid]) next[uid].position = payload.position
  const kids = [...((next[parentUid] && next[parentUid].children) || [])].filter(
    id => id !== uid
  )
  const canSort =
    payload.position &&
    (payload.reindex || kids.some(id => next[id] && next[id].position))
  if (canSort) {
    kids.push(uid)
    kids.sort((a, b) => {
      const pa = (next[a] && next[a].position) || ''
      const pb = (next[b] && next[b].position) || ''
      if (pa !== pb) {
        if (!pa) return 1
        if (!pb) return -1
        return pa < pb ? -1 : 1
      }
      return String(a).localeCompare(String(b))
    })
  } else {
    const index = payload.index
    if (index == null || index < 0 || index > kids.length) kids.push(uid)
    else kids.splice(index, 0, uid)
  }
  next[parentUid] = { ...next[parentUid], children: kids }
}

export function applyCollabEvent(obj, event) {
  const next = cloneNodes(obj)
  const type = event && event.type
  const payload = (event && event.payload) || {}
  if (type === 'map.updated') return next
  if (type === 'node.inserted') {
    const uid = payload.uid
    const parentUid =
      payload.parentUid || payload.parent_uid || payload.parent || 'root'
    if (!uid || !next[parentUid]) throw new Error('parent missing')
    if (!next[uid]) {
      const data = { uid, ...(payload.data || {}) }
      if (payload.text != null && data.text == null) data.text = payload.text
      if (payload.note != null && data.note == null) data.note = payload.note
      next[uid] = {
        isRoot: false,
        data,
        children: [],
        position: payload.position || ''
      }
    } else if (payload.position) {
      next[uid] = { ...next[uid], position: payload.position }
    }
    placeChild(next, parentUid, uid, payload)
    return next
  }
  if (type === 'node.updated' || type === 'node.moved' || type === 'node.reordered') {
    const uid = payload.uid
    if (!uid || !next[uid]) throw new Error('node not found')
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    if (
      type === 'node.moved' ||
      type === 'node.reordered' ||
      parent !== undefined ||
      payload.index !== undefined
    ) {
      const oldParent = findParentUid(next, uid)
      if (oldParent && next[oldParent]) {
        next[oldParent] = {
          ...next[oldParent],
          children: (next[oldParent].children || []).filter(id => id !== uid)
        }
      }
      const parentUid = parent || oldParent
      if (parentUid && next[parentUid]) {
        placeChild(next, parentUid, uid, payload)
      }
    }
    const patch = payload.patch || payload.data
    if (patch && typeof patch === 'object') {
      const nextData = { ...(next[uid].data || {}), ...patch, uid }
      if (payload.text != null) nextData.text = payload.text
      if (payload.note != null) nextData.note = payload.note
      next[uid] = { ...next[uid], data: nextData }
    }
    return next
  }
  if (type === 'node.deleted') {
    const uid = payload.uid
    const parentUid = findParentUid(next, uid)
    const keepChildren = !!(payload.keepChildren || payload.keep_children)
    const promoted = payload.promoted || (next[uid] && next[uid].children) || []
    if (keepChildren && parentUid && next[parentUid]) {
      const kids = []
      ;(next[parentUid].children || []).forEach(id => {
        if (id === uid) kids.push(...promoted)
        else kids.push(id)
      })
      next[parentUid] = { ...next[parentUid], children: kids }
      delete next[uid]
      return next
    }
    const removed =
      payload.removed && payload.removed.length ? payload.removed : [uid]
    Object.keys(next).forEach(id => {
      const kids = next[id] && next[id].children
      if (!Array.isArray(kids)) return
      const filtered = kids.filter(child => !removed.includes(child))
      if (filtered.length !== kids.length) {
        next[id] = { ...next[id], children: filtered }
      }
    })
    removed.forEach(id => {
      delete next[id]
    })
    return next
  }
  if (type === 'node.restored') {
    return applyRestoreEvent(next, payload)
  }
  if (type === 'operation.undone') {
    const inverse = payload.inverse
    if (!inverse || !inverse.type) return next
    if (inverse.type === 'node.restore') {
      return applyRestoreEvent(next, inverse.payload || {})
    }
    if (inverse.type === 'node.delete') {
      return applyCollabEvent(next, {
        type: 'node.deleted',
        payload: inverse.payload || {}
      })
    }
    if (
      inverse.type === 'node.update' ||
      inverse.type === 'node.move' ||
      inverse.type === 'node.reorder'
    ) {
      return applyCollabEvent(next, {
        type:
          inverse.type === 'node.reorder' ? 'node.reordered' : 'node.moved',
        payload: inverse.payload || {}
      })
    }
    return next
  }
  if (type === 'operation.redone') {
    const forward = payload.forward
    if (!forward || !forward.type) return next
    if (forward.type === 'node.insert') {
      return applyCollabEvent(next, {
        type: 'node.inserted',
        payload: forward.payload || {}
      })
    }
    if (forward.type === 'node.delete') {
      return applyCollabEvent(next, {
        type: 'node.deleted',
        payload: forward.payload || {}
      })
    }
    if (
      forward.type === 'node.update' ||
      forward.type === 'node.move' ||
      forward.type === 'node.reorder'
    ) {
      return applyCollabEvent(next, {
        type:
          forward.type === 'node.reorder'
            ? 'node.reordered'
            : forward.type === 'node.move'
              ? 'node.moved'
              : 'node.updated',
        payload: forward.payload || {}
      })
    }
    if (forward.type === 'node.restore') {
      return applyRestoreEvent(next, forward.payload || {})
    }
    return next
  }
  throw new Error(`unsupported event type: ${type}`)
}

function applyRestoreEvent(obj, payload = {}) {
  const next = cloneNodes(obj)
  const nodes = payload.nodes || {}
  Object.keys(nodes).forEach(uid => {
    next[uid] = cloneNodes(nodes[uid])
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

export function applyCollabEvents(obj, operations) {
  let nodes = cloneNodes(obj)
  for (let i = 0; i < operations.length; i++) {
    const item = operations[i]
    if (operationRequiresResnapshot(item)) {
      return { type: 'resnapshot', nodes, index: i }
    }
    nodes = applyCollabEvent(nodes, item.event || item)
  }
  return { type: 'apply', nodes }
}

const STRUCTURAL_EVENT_TYPES = new Set([
  'node.inserted',
  'node.deleted',
  'node.moved',
  'node.reordered',
  'node.updated',
  'map.replaced',
  'batch.applied',
  'operation.undone',
  'operation.redone'
])

export function affectedUidsFromOperation(item) {
  const event = (item && item.event) || item || {}
  const payload = event.payload || {}
  const uids = [
    ...(Array.isArray(event.affectedUids) ? event.affectedUids : []),
    payload.uid,
    payload.parentUid,
    payload.parent_uid,
    payload.parent,
    payload.fromParent,
    payload.from_parent
  ].filter(Boolean)
  if (Array.isArray(payload.removed)) {
    payload.removed.forEach(uid => {
      if (uid) uids.push(uid)
    })
  }
  return uids
}

export function markDirtySubtrees(loadedUids, operations) {
  const loaded =
    loadedUids instanceof Set ? loadedUids : new Set(loadedUids || [])
  const dirty = {}
  ;(operations || []).forEach(item => {
    const event = (item && item.event) || item || {}
    const version = Number(item.version || event.version || 0)
    const payload = event.payload || {}
    const type = String(event.type || item.operation_type || '')
    const uids = affectedUidsFromOperation(item)
    if (STRUCTURAL_EVENT_TYPES.has(type)) {
      uids.forEach(uid => {
        dirty[uid] = Math.max(dirty[uid] || 0, version)
      })
      const parent = payload.parentUid || payload.parent_uid || payload.parent
      if (parent) dirty[parent] = Math.max(dirty[parent] || 0, version)
      return
    }
    const hasUnloaded = uids.some(uid => !loaded.has(uid))
    if (!hasUnloaded) return
    uids.forEach(uid => {
      if (!loaded.has(uid)) return
      dirty[uid] = Math.max(dirty[uid] || 0, version)
    })
  })
  return dirty
}

export function planAfterOperations(
  lastAppliedVersion,
  payload = {},
  maxGap = DEFAULT_RESNAPSHOT_GAP
) {
  const last = Number(lastAppliedVersion) || 0
  const operations = Array.isArray(payload.operations) ? payload.operations : []
  const current = Number(payload.currentVersion)
  const nextVersion = Number.isFinite(current)
    ? current
    : operations.length
      ? Number(operations[operations.length - 1].version) || last
      : last
  if (payload.hasMore || nextVersion - last > maxGap) {
    return { type: 'resnapshot', version: nextVersion }
  }
  if (!operations.length && nextVersion > last) {
    return { type: 'resnapshot', version: nextVersion }
  }
  if (operations.some(operationRequiresResnapshot)) {
    return { type: 'resnapshot', version: nextVersion }
  }
  return {
    type: 'apply',
    operations,
    version: Math.max(last, nextVersion)
  }
}

export { DEFAULT_RESNAPSHOT_GAP }
