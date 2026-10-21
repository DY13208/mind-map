'use strict'

const crypto = require('crypto')

const SUBTREE_TOKEN_ROWS_SQL = `with recursive room_rows as materialized (
  select uid, parent_uid, position, node_version
  from room_nodes
  where room_key = $1 and deleted_at is null
), walk(uid, parent_uid, position, node_version, trail, cycle) as (
  select uid, parent_uid, position, node_version, array[uid]::text[], false
  from room_rows
  where uid = $2
  union all
  select n.uid, n.parent_uid, n.position, n.node_version,
         w.trail || n.uid, n.uid = any(w.trail)
  from walk w join room_rows n on n.parent_uid = w.uid
  where not w.cycle
)
select uid, parent_uid, position, node_version, cycle from walk`

const SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL = `with recursive room_rows as materialized (
  select uid, parent_uid, position, node_version
  from room_nodes
  where room_key = $1 and deleted_at is null
), roots as materialized (
  select distinct root_uid
  from unnest($2::text[]) as requested(root_uid)
  where root_uid <> ''
), walk(root_uid, uid, parent_uid, position, node_version, trail, cycle) as (
  select roots.root_uid, node.uid, node.parent_uid, node.position, node.node_version,
         array[node.uid]::text[], false
  from roots
  join room_rows node on node.uid = roots.root_uid
  union all
  select w.root_uid, n.uid, n.parent_uid, n.position, n.node_version,
         w.trail || n.uid, n.uid = any(w.trail)
  from walk w join room_rows n on n.parent_uid = w.uid
  where not w.cycle
)
select distinct uid, parent_uid, position, node_version, cycle from walk`

function uniqueUids(uids) {
  return Array.from(new Set((uids || [])
    .map(uid => String(uid == null ? '' : uid).trim())
    .filter(Boolean)))
}

async function readSubtreeRows(dbOrQuery, roomKey, uid) {
  // Materializing the live rows for only this room prevents stale/missing
  // statistics from making PostgreSQL rescan room_nodes per recursive row.
  const query = typeof dbOrQuery === 'function'
    ? dbOrQuery
    : dbOrQuery && typeof dbOrQuery.query === 'function'
      ? dbOrQuery.query.bind(dbOrQuery)
      : null
  if (!query) throw new TypeError('readSubtreeRows requires a query-capable database')
  const result = await query(SUBTREE_TOKEN_ROWS_SQL, [String(roomKey || ''), String(uid || '')])
  return result && Array.isArray(result.rows) ? result.rows : []
}

async function readSubtreeRowsForRoots(dbOrQuery, roomKey, uids) {
  const roots = uniqueUids(uids)
  if (!roots.length) return []
  const query = typeof dbOrQuery === 'function'
    ? dbOrQuery
    : dbOrQuery && typeof dbOrQuery.query === 'function'
      ? dbOrQuery.query.bind(dbOrQuery)
      : null
  if (!query) throw new TypeError('readSubtreeRowsForRoots requires a query-capable database')
  const result = await query(SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL, [String(roomKey || ''), roots])
  return result && Array.isArray(result.rows) ? result.rows : []
}

function compareText(left, right) {
  const a = String(left == null ? '' : left)
  const b = String(right == null ? '' : right)
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeSubtreeRows(rows) {
  return (rows || [])
    .map(row => ({
      uid: String(row && row.uid || ''),
      parent_uid: row && row.parent_uid != null ? String(row.parent_uid) : null,
      position: String(row && row.position || ''),
      node_version: Math.max(0, Number(row && row.node_version) || 0)
    }))
    .filter(row => row.uid)
    .sort((a, b) =>
      compareText(a.uid, b.uid) ||
      compareText(a.parent_uid, b.parent_uid) ||
      compareText(a.position, b.position) ||
      a.node_version - b.node_version
    )
}

function subtreeToken(rows) {
  const canonical = normalizeSubtreeRows(rows).map(row => [
    row.uid,
    row.parent_uid,
    row.position,
    row.node_version
  ])
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function subtreeTokensFromRows(rows, rootUids) {
  const roots = uniqueUids(rootUids)
  const rowsByUid = new Map()
  const childrenByParent = new Map()
  for (const row of rows || []) {
    if (row && (row.cycle === true || row.cycle === 't')) {
      const err = new Error('导图节点关系存在循环，无法计算子树校验值')
      err.code = 'NODE_GRAPH_CYCLE'
      err.statusCode = 409
      throw err
    }
    const uid = String(row && row.uid || '')
    if (!uid || rowsByUid.has(uid)) continue
    const normalized = {
      uid,
      parent_uid: row && row.parent_uid != null ? String(row.parent_uid) : null,
      position: String(row && row.position || ''),
      node_version: Math.max(0, Number(row && row.node_version) || 0)
    }
    rowsByUid.set(uid, normalized)
    if (normalized.parent_uid) {
      const siblings = childrenByParent.get(normalized.parent_uid) || []
      siblings.push(uid)
      childrenByParent.set(normalized.parent_uid, siblings)
    }
  }

  const tokens = new Map()
  for (const rootUid of roots) {
    if (!rowsByUid.has(rootUid)) {
      tokens.set(rootUid, null)
      continue
    }
    const subtreeRows = []
    const stack = [rootUid]
    const seen = new Set()
    while (stack.length) {
      const uid = stack.pop()
      if (seen.has(uid)) {
        const err = new Error('导图节点关系存在循环，无法计算子树校验值')
        err.code = 'NODE_GRAPH_CYCLE'
        err.statusCode = 409
        throw err
      }
      seen.add(uid)
      const row = rowsByUid.get(uid)
      if (!row) continue
      subtreeRows.push(row)
      ;(childrenByParent.get(uid) || []).forEach(childUid => stack.push(childUid))
    }
    tokens.set(rootUid, subtreeToken(subtreeRows))
  }
  return tokens
}

module.exports = {
  SUBTREE_TOKEN_ROWS_SQL,
  SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL,
  readSubtreeRows,
  readSubtreeRowsForRoots,
  normalizeSubtreeRows,
  subtreeToken,
  subtreeTokensFromRows
}
