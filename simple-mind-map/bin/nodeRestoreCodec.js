const { comparePositions, generateNKeysBetween } = require('./fractionalIndex')

function positionForPayload(payload = {}) {
  return payload.position == null ? '' : String(payload.position)
}

function payloadParent(payload = {}) {
  return payload.parentUid || payload.parent_uid || payload.parent || null
}

function normalizeRows(rows, payload = {}) {
  const normalized = (rows || [])
    .filter(row => row && row.uid != null)
    .map(row => ({
      uid: String(row.uid),
      parent_uid: row.parent_uid || row.parentUid || null,
      position: row.position == null ? '' : String(row.position),
      data: { ...(row.data || {}), uid: String(row.uid) },
      is_root: !!(row.is_root || row.isRoot)
    }))
  if (!normalized.length) return normalized

  const byUid = new Map(normalized.map(row => [row.uid, row]))
  const requestedRoot = payload.uid == null ? null : String(payload.uid)
  const rootUid =
    (requestedRoot && byUid.has(requestedRoot) && requestedRoot) ||
    normalized.find(row => !byUid.has(String(row.parent_uid || '')))?.uid ||
    normalized[0].uid
  const root = byUid.get(rootUid) || normalized[0]
  const parentUid = payloadParent(payload)
  if (parentUid) root.parent_uid = String(parentUid)
  const rootPosition = positionForPayload(payload)
  if (rootPosition) root.position = rootPosition

  return assignMissingSiblingPositions(normalized, rootUid)
}

function normalizeRestoreRows(payload = {}) {
  if (Array.isArray(payload.rows) && payload.rows.length) {
    return normalizeRows(payload.rows, payload)
  }

  const nodes = payload.nodes && typeof payload.nodes === 'object'
    ? payload.nodes
    : {}
  const entries = Object.entries(nodes).filter(([, node]) => node && typeof node === 'object')
  if (!entries.length) return []

  const nodeIds = new Set(entries.map(([uid]) => String(uid)))
  const parentByUid = new Map()
  entries.forEach(([parentUid, node]) => {
    ;(Array.isArray(node.children) ? node.children : []).forEach(childUid => {
      const child = String(childUid)
      if (nodeIds.has(child) && !parentByUid.has(child)) {
        parentByUid.set(child, String(parentUid))
      }
    })
  })

  const requestedRoot = payload.uid != null ? String(payload.uid) : null
  const rootUid = (requestedRoot && nodeIds.has(requestedRoot) && requestedRoot) ||
    entries.map(([uid]) => String(uid)).find(uid => !parentByUid.has(uid)) ||
    String(entries[0][0])
  const externalParent = payloadParent(payload)
  const rows = entries.map(([rawUid, node]) => {
    const uid = String(rawUid)
    const nodeParent = node.parentUid || node.parent_uid
    const parentUid = uid === rootUid
      ? externalParent || nodeParent || null
      : parentByUid.get(uid) || nodeParent || null
    return {
      uid,
      parent_uid: parentUid,
      position: node.position == null ? '' : String(node.position),
      data: { ...(node.data || {}), uid },
      is_root: !!(node.isRoot || node.is_root)
    }
  })
  const rowByUid = new Map(rows.map(row => [row.uid, row]))
  const orderedUids = []
  const visited = new Set()
  const visit = uid => {
    if (!nodeIds.has(uid) || visited.has(uid)) return
    visited.add(uid)
    orderedUids.push(uid)
    const node = nodes[uid]
    ;(Array.isArray(node && node.children) ? node.children : []).forEach(childUid => {
      visit(String(childUid))
    })
  }
  visit(rootUid)
  entries.forEach(([uid]) => visit(String(uid)))
  const orderedRows = orderedUids.map(uid => rowByUid.get(uid)).filter(Boolean)
  const root = orderedRows.find(row => row.uid === rootUid)
  if (root) {
    const rootPosition = positionForPayload(payload)
    if (rootPosition) root.position = rootPosition
  }
  return assignMissingSiblingPositions(orderedRows, rootUid, true)
}

function assignMissingSiblingPositions(rows, rootUid, preserveSourceOrder = false) {
  const groups = new Map()
  rows.forEach((row, index) => {
    const parentUid = row.parent_uid || ''
    if (!groups.has(parentUid)) groups.set(parentUid, [])
    groups.get(parentUid).push({ row, index })
  })
  groups.forEach(group => {
    const seen = new Set()
    const complete = group.every(({ row }) => {
      if (!row.position || seen.has(row.position)) return false
      seen.add(row.position)
      return true
    })
    const orderedByPosition = [...group].sort((a, b) =>
      comparePositions(a.row.position, b.row.position, a.row.uid, b.row.uid)
    )
    const orderMismatch = orderedByPosition.some(
      (item, index) => item.row.uid !== group[index].row.uid
    )
    if (complete && (!preserveSourceOrder || !orderMismatch)) return

    // The serialized node children arrays (legacy) and row order (Direct) are
    // the only reliable ordering source when old records have no positions.
    const keys = generateNKeysBetween(null, null, group.length)
    group.forEach(({ row }, index) => {
      if (row.uid !== rootUid || !row.position) row.position = keys[index] || row.position || ''
    })
  })
  return rows
}

function restoreRowsToNodes(rows = []) {
  const nodes = {}
  const byParent = new Map()
  rows.forEach(row => {
    nodes[row.uid] = {
      isRoot: !!row.is_root,
      data: { ...(row.data || {}), uid: row.uid },
      children: [],
      position: row.position || ''
    }
    if (row.parent_uid) {
      if (!byParent.has(row.parent_uid)) byParent.set(row.parent_uid, [])
      byParent.get(row.parent_uid).push(row)
    }
  })
  byParent.forEach((children, parentUid) => {
    if (!nodes[parentUid]) return
    children.sort((a, b) => {
      const byPosition = comparePositions(a.position, b.position)
      return byPosition || String(a.uid).localeCompare(String(b.uid))
    })
    nodes[parentUid].children = children.map(row => row.uid)
  })
  return nodes
}

module.exports = { normalizeRestoreRows, restoreRowsToNodes }
