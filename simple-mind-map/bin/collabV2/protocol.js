const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const TYPE_ALIAS = {
  'node.create': 'node.insert',
  create: 'node.insert',
  update: 'node.update',
  delete: 'node.delete',
  move: 'node.move',
  paste: 'node.batch',
  'batch.create': 'node.batch',
  'batch.delete': 'node.batch',
  'batch.move': 'node.batch',
  'map.update': 'map.meta.update',
  'map.meta': 'map.meta.update'
}

const WRITE_TYPES = new Set([
  'node.insert',
  'node.update',
  'node.move',
  'node.reorder',
  'node.delete',
  'node.restore',
  'node.batch',
  'map.replace',
  'map.update',
  'map.meta.update',
  'operation.undo',
  'operation.redo'
])

const BATCH_RECOMMENDED = 100
const BATCH_CHUNK = 250
const BATCH_MAX = 1000

function createOpId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try {
      return crypto.randomUUID()
    } catch (err) {
      // ignore
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const n = (Math.random() * 16) | 0
    const v = ch === 'x' ? n : (n & 0x3) | 0x8
    return v.toString(16)
  })
}

function isOpId(value) {
  return UUID_RE.test(String(value || '').trim())
}

function isValidClientId(value) {
  const id = String(value || '').trim()
  return id.length > 0 && id.length <= 160
}

function requireClientId(value) {
  if (isValidClientId(value)) return String(value).trim()
  const err = new Error('clientId 不能为空')
  err.code = 'INVALID_CLIENT_ID'
  err.statusCode = 400
  throw err
}

function normalizeType(type) {
  const raw = String(type || '').trim()
  return TYPE_ALIAS[raw] || raw
}

function targetIdFrom(type, payload = {}) {
  if (payload.targetId || payload.target_id) {
    return String(payload.targetId || payload.target_id)
  }
  if (payload.uid) return String(payload.uid)
  if (payload.parentUid || payload.parent_uid || payload.parent) {
    return String(payload.parentUid || payload.parent_uid || payload.parent)
  }
  return ''
}

function normalizeOperation(input = {}, defaults = {}) {
  const payload =
    input.payload && typeof input.payload === 'object' ? input.payload : {}
  const type = normalizeType(input.type || payload.type)
  const opId = String(input.opId || input.operationId || input.operation_id || '').trim()
  return {
    opId,
    roomKey: String(input.roomKey || input.room_key || defaults.roomKey || ''),
    userId: String(input.userId || input.user_id || defaults.userId || ''),
    clientId: String(
      input.clientId || input.client_id || defaults.clientId || ''
    ).trim(),
    clientSeq: Math.max(0, Number(input.clientSeq || input.client_seq) || 0),
    baseRevision: Number(
      input.baseRevision != null
        ? input.baseRevision
        : input.baseVersion != null
          ? input.baseVersion
          : input.base_version
    ),
    type,
    targetId: targetIdFrom(type, { ...payload, ...input }),
    payload,
    createdAt: Number(input.createdAt || input.created_at) || Date.now(),
    traceId: String(input.traceId || payload.traceId || '')
  }
}

function toCommand(op) {
  const payload = { ...(op.payload || {}) }
  if (op.targetId && !payload.uid && op.type !== 'node.batch' && op.type !== 'map.replace') {
    payload.uid = op.targetId
  }
  return {
    operationId: op.opId,
    mapId: op.roomKey,
    actorId: op.userId,
    clientId: op.clientId,
    baseVersion: Number.isFinite(op.baseRevision) ? op.baseRevision : null,
    type: op.type,
    payload
  }
}

function fromCommitted(operation, extra = {}) {
  const event = operation.event || {}
  const rawPayload = operation.payload || {}
  const eventPayload = event.payload || {}
  const undoControl =
    !rawPayload.uid &&
    (rawPayload.targetOperationId ||
      rawPayload.target_operation_id ||
      rawPayload.targetOpId)
  const payload =
    undoControl && eventPayload && typeof eventPayload === 'object'
      ? eventPayload
      : rawPayload.uid || rawPayload.patch
        ? rawPayload
        : rawPayload && Object.keys(rawPayload).length
          ? rawPayload
          : eventPayload
  return {
    opId: operation.operationId || operation.operation_id,
    roomKey: operation.roomKey || operation.room_key || extra.roomKey,
    userId: operation.actorId || operation.actor_id,
    clientId: operation.clientId || operation.client_id || '',
    clientSeq: Number(
      operation.client_seq != null
        ? operation.client_seq
        : (payload && payload.clientSeq) || extra.clientSeq || 0
    ),
    baseRevision: Number(
      extra.baseRevision != null ? extra.baseRevision : payload.baseRevision
    ),
    type: event.type || operation.operationType || operation.operation_type,
    targetId:
      extra.targetId ||
      operation.target_id ||
      targetIdFrom(event.type, payload),
    payload,
    event,
    createdAt: operation.createdAt || operation.created_at,
    serverRevision: Number(operation.version || event.version || 0),
    duplicate: !!extra.duplicate
  }
}

function isWriteType(type) {
  return WRITE_TYPES.has(normalizeType(type))
}

module.exports = {
  TYPE_ALIAS,
  WRITE_TYPES,
  BATCH_RECOMMENDED,
  BATCH_CHUNK,
  BATCH_MAX,
  createOpId,
  isOpId,
  isValidClientId,
  requireClientId,
  normalizeType,
  normalizeOperation,
  toCommand,
  fromCommitted,
  isWriteType,
  targetIdFrom
}
