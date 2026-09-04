/* global module:readonly */

function publishServiceRecoveryTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('SERVICE_RECOVERY_TRACE', next)
  }
  if (typeof window === 'undefined') return next
  window.__SERVICE_RECOVERY_TRACE__ = next
  return next
}

function publishRoomIntegrityReport(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('ROOM_INTEGRITY_REPORT', next)
  }
  if (typeof window === 'undefined') return next
  window.__ROOM_INTEGRITY_REPORT__ = next
  return next
}

function publishRoomLoadTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('ROOM_LOAD_TRACE', next)
  }
  if (typeof window === 'undefined') return next
  window.__ROOM_LOAD_TRACE__ = next
  window.__ROOM_LOAD_TRACE_LOG__ = window.__ROOM_LOAD_TRACE_LOG__ || []
  window.__ROOM_LOAD_TRACE_LOG__.push(next)
  if (window.__ROOM_LOAD_TRACE_LOG__.length > 40) {
    window.__ROOM_LOAD_TRACE_LOG__.shift()
  }
  return next
}

function describeReplaceLock(startedAt, now = Date.now(), ttl = 120000) {
  if (!startedAt) {
    return {
      locked: false,
      lockOwner: '',
      lockCreatedAt: null,
      lockAge: 0,
      TTL: ttl,
      expired: false
    }
  }
  const lockAge = now - startedAt
  const expired = lockAge >= ttl
  return {
    locked: !expired,
    lockOwner: 'process-memory',
    lockCreatedAt: startedAt,
    lockAge,
    TTL: ttl,
    expired
  }
}

function shouldQuarantineOutboxOp(op) {
  if (!op) return false
  const type = String(op.type || op.operation_type || '')
  if (type === 'map.replace' || type === 'map.replaced') return true
  const code = String(op.errorCode || op.code || '')
  if (
    code === 'IMPORT_TOO_LARGE' ||
    code === 'IMPORT_APPLY_FAILED' ||
    code === 'OUTBOX_NON_CLONEABLE_PAYLOAD' ||
    code === 'SOP_CONFIRM_REQUIRED' ||
    code === 'FORBIDDEN' ||
    code === 'INVALID_CLIENT_ID' ||
    code === 'UID_REUSED' ||
    code === 'UID_ALREADY_EXISTS'
  ) {
    return true
  }
  try {
    const bytes = JSON.stringify(op.payload || {}).length
    if (bytes > 2 * 1024 * 1024) return true
  } catch (err) {
    return true
  }
  return false
}

function estimateOpBytes(op) {
  try {
    return JSON.stringify(op && op.payload != null ? op.payload : op || {}).length
  } catch (err) {
    return 0
  }
}

function summarizeOutbox(rows = []) {
  return (rows || []).map(item => ({
    opId: item.opId || item.operationId,
    type: item.type,
    status: item.status,
    bytes: estimateOpBytes(item),
    quarantined: item.status === 'quarantined' || shouldQuarantineOutboxOp(item)
  }))
}

async function inspectRoom(db, roomKey) {
  const key = String(roomKey || '')
  const roomRes = await db.query(
    `select room_key, title, version, updated_at, metadata,
            octet_length(coalesce(nodes::text, ''))::int as nodes_json_bytes
     from rooms where room_key = $1`,
    [key]
  )
  const room = roomRes.rows[0]
  if (!room) return null
  const counts = await db.query(
    `select
       count(*)::int as total,
       count(*) filter (where deleted_at is null)::int as live,
       count(*) filter (where deleted_at is not null)::int as deleted,
       count(*) filter (where is_root and deleted_at is null)::int as live_roots,
       coalesce(max(octet_length(data::text)), 0)::int as max_data_bytes
     from room_nodes
     where room_key = $1`,
    [key]
  )
  const orphans = await db.query(
    `select count(*)::int as n
     from room_nodes n
     where n.room_key = $1
       and n.deleted_at is null
       and n.is_root = false
       and (
         n.parent_uid is null
         or not exists (
           select 1 from room_nodes p
           where p.room_key = n.room_key
             and p.uid = n.parent_uid
             and p.deleted_at is null
         )
       )`,
    [key]
  )
  const ops = await db.query(
    `select version, operation_id, operation_type, created_at
     from room_operations
     where room_key = $1
     order by version desc
     limit 12`,
    [key]
  )
  const lastReplace = (ops.rows || []).find(
    row => row.operation_type === 'map.replace'
  )
  const countRow = counts.rows[0] || {}
  const live = Number(countRow.live || 0)
  const liveRoots = Number(countRow.live_roots || 0)
  const orphanCount = Number((orphans.rows[0] && orphans.rows[0].n) || 0)
  const errors = []
  const warnings = []
  if (liveRoots !== 1) errors.push('root_count:' + liveRoots)
  if (orphanCount > 0) errors.push('orphans:' + orphanCount)
  if (live > 20000) warnings.push('oversize_live:' + live)
  if (Number(countRow.max_data_bytes || 0) > 2 * 1024 * 1024) {
    warnings.push('huge_node_data')
  }
  let lastReplaceStatus = 'none'
  if (lastReplace) {
    lastReplaceStatus =
      live > 1 || liveRoots === 1 ? 'committed' : 'committed_but_sparse'
  }
  const report = {
    roomKey: key,
    title: room.title,
    version: Number(room.version || 0),
    updatedAt: room.updated_at,
    metadata: room.metadata || {},
    nodesJsonBytes: Number(room.nodes_json_bytes || 0),
    totalNodes: Number(countRow.total || 0),
    liveCount: live,
    deletedCount: Number(countRow.deleted || 0),
    liveRoots,
    orphanCount,
    maxDataBytes: Number(countRow.max_data_bytes || 0),
    lastOperations: ops.rows || [],
    lastMapReplace: lastReplace || null,
    lastMapReplaceStatus: lastReplaceStatus,
    errors,
    warnings,
    oversized: live >= 400,
    ok: errors.length === 0
  }
  publishRoomIntegrityReport(report)
  return report
}

const api = {
  inspectRoom,
  describeReplaceLock,
  publishServiceRecoveryTrace,
  publishRoomIntegrityReport,
  publishRoomLoadTrace,
  shouldQuarantineOutboxOp,
  estimateOpBytes,
  summarizeOutbox
}

module.exports = api
module.exports.default = api
