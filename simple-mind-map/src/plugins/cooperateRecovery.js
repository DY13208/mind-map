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
      next[uid] = { isRoot: false, data, children: [] }
    }
    const kids = [...(next[parentUid].children || [])]
    if (!kids.includes(uid)) {
      const index = payload.index
      if (index == null || index < 0 || index > kids.length) kids.push(uid)
      else kids.splice(index, 0, uid)
      next[parentUid] = { ...next[parentUid], children: kids }
    }
    return next
  }
  if (type === 'node.updated' || type === 'node.moved') {
    const uid = payload.uid
    if (!uid || !next[uid]) throw new Error('node not found')
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    if (type === 'node.moved' || parent !== undefined || payload.index !== undefined) {
      const oldParent = findParentUid(next, uid)
      if (oldParent && next[oldParent]) {
        next[oldParent] = {
          ...next[oldParent],
          children: (next[oldParent].children || []).filter(id => id !== uid)
        }
      }
      const parentUid = parent || oldParent
      if (parentUid && next[parentUid]) {
        const kids = [...(next[parentUid].children || [])]
        const index = payload.index
        if (index == null || index < 0 || index > kids.length) kids.push(uid)
        else kids.splice(index, 0, uid)
        next[parentUid] = { ...next[parentUid], children: kids }
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
  throw new Error(`unsupported event type: ${type}`)
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
