const TERMINAL_ERROR_SET = {
  FORBIDDEN: true,
  INVALID_CLIENT_ID: true,
  UID_REUSED: true,
  UID_ALREADY_EXISTS: true,
  UID_EXISTS: true,
  IMPORT_TOO_LARGE: true,
  IMPORT_APPLY_FAILED: true,
  OUTBOX_NON_CLONEABLE_PAYLOAD: true,
  SOP_CONFIRM_REQUIRED: true,
  UNSUPPORTED_OPERATION: true,
  BAD_OP_ID: true,
  INVALID_PAYLOAD: true,
  ROOT_DELETE: true
}

const RETRYABLE_ERROR_SET = {
  ACK_TIMEOUT: true,
  TIMEOUT: true,
  SOCKET_CONNECT_FAILED: true,
  SOCKET_DISCONNECT: true,
  REVISION_GAP: true,
  STALE_BASE: true,
  VERSION_CONFLICT: true,
  VERSION_AHEAD: true,
  PG_UNAVAILABLE: true,
  PG_TEMPORARY: true,
  SYNC_FAILED: true
}

function isTerminalError(code) {
  return !!TERMINAL_ERROR_SET[String(code || '')]
}

function isRetryableError(code) {
  const raw = String(code || '')
  if (isTerminalError(raw)) return false
  return !!RETRYABLE_ERROR_SET[raw]
}

function collectOpUids(op) {
  const payload = (op && op.payload) || {}
  const uids = []
  if (payload.uid) uids.push(String(payload.uid))
  if (payload.parent) uids.push(String(payload.parent))
  if (payload.parentUid) uids.push(String(payload.parentUid))
  if (payload.parent_uid) uids.push(String(payload.parent_uid))
  ;(payload.ops || []).forEach(inner => {
    collectOpUids(inner).forEach(id => uids.push(id))
  })
  return Array.from(new Set(uids.filter(Boolean)))
}

function dependsOnBlockedOp(item, blocked) {
  if (!item || !blocked) return false
  const blockedUids = new Set(collectOpUids(blocked))
  const itemUids = collectOpUids(item)
  if (itemUids.some(id => blockedUids.has(id))) return true
  const blockedSeq = Number(blocked.clientSeq || 0)
  const itemSeq = Number(item.clientSeq || 0)
  return (
    blockedSeq > 0 &&
    itemSeq > blockedSeq &&
    itemUids.some(id => blockedUids.has(id))
  )
}

function shouldQuarantineError(code, op) {
  if (isTerminalError(code)) return true
  const type = String((op && op.type) || '')
  return type === 'map.replace' || type === 'map.replaced'
}

function heartbeatKey(clientId) {
  return 'mind-map-collab-v2-live:' + String(clientId || '')
}

function writeClientHeartbeat(storage, clientId, now = Date.now()) {
  if (!storage || !clientId) return
  try {
    storage.setItem(heartbeatKey(clientId), String(now))
  } catch (err) {}
}

function isClientHeartbeatFresh(storage, clientId, now = Date.now(), ttl = 8000) {
  if (!storage || !clientId) return false
  try {
    const raw = Number(storage.getItem(heartbeatKey(clientId)) || 0)
    return raw > 0 && now - raw < ttl
  } catch (err) {
    return false
  }
}

function canClaimOrphan(item, current, storage, now = Date.now()) {
  if (!item || !current) return false
  if (item.clientId === current.clientId) return false
  if (item.userId && current.userId && item.userId !== current.userId) return false
  if (item.roomKey && current.roomKey && item.roomKey !== current.roomKey) {
    return false
  }
  if (isClientHeartbeatFresh(storage, item.clientId, now)) return false
  const status = String(item.status || '')
  if (status === 'quarantined' || status === 'failed' || status === 'acked') {
    return false
  }
  return true
}

const api = {
  TERMINAL_ERROR_SET,
  RETRYABLE_ERROR_SET,
  isTerminalError,
  isRetryableError,
  collectOpUids,
  dependsOnBlockedOp,
  shouldQuarantineError,
  writeClientHeartbeat,
  isClientHeartbeatFresh,
  canClaimOrphan
}

module.exports = api
module.exports.default = api
