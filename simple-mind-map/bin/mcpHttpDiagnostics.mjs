import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOM_KEY_RE = /^[a-zA-Z0-9_.:/-]{1,100}$/
const METHODS = new Set(['GET', 'POST', 'DELETE', 'OPTIONS'])

function requestIdentity(body) {
  const messages = Array.isArray(body) ? body : [body]
  const operationIds = new Set()
  const roomKeys = new Set()
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const args = message.params?.arguments
    const operationId = args?.operation_id
    if (typeof operationId === 'string' && UUID_RE.test(operationId)) {
      operationIds.add(operationId)
    }
    if (typeof args?.room_key === 'string' && ROOM_KEY_RE.test(args.room_key)) {
      roomKeys.add(args.room_key)
    }
  }

  const identity = {}
  if (operationIds.size === 1) identity.operationId = [...operationIds][0]
  if (roomKeys.size === 1) identity.roomKey = [...roomKeys][0]

  if (messages.length === 1 && messages[0] && typeof messages[0] === 'object') {
    const id = messages[0].id
    if (Number.isSafeInteger(id) || (typeof id === 'string' && UUID_RE.test(id))) {
      identity.rpcId = id
    } else if (typeof id === 'string') {
      const boundedValue = id.slice(0, 256)
      identity.rpcIdHash = createHash('sha256')
        .update(`string:${boundedValue}:length:${id.length}`)
        .digest('hex')
        .slice(0, 16)
    }
  }
  return identity
}

export function createMcpHttpLifecycle(req, res, diagnostics) {
  if (!diagnostics || typeof diagnostics.enabled !== 'function' || !diagnostics.enabled()) {
    return null
  }

  const startedAt = performance.now()
  const suppliedRequestId = req.headers && req.headers['x-mcp-request-id']
  const clientRequestId = typeof suppliedRequestId === 'string' && UUID_RE.test(suppliedRequestId)
    ? suppliedRequestId
    : undefined
  const requestId = randomUUID()
  const method = METHODS.has(req.method) ? req.method : 'other'
  const sessionPresent = Boolean(req.headers && req.headers['mcp-session-id'])
  let bodyComplete = false
  let bodyParsed = false
  let responseFinished = false
  let operationId
  let roomKey
  let rpcId
  let rpcIdHash

  const record = stage => {
    if (req.complete === true) bodyComplete = true
    const headersSent = Boolean(res.headersSent)
    const event = {
      kind: 'mcp-http',
      route: '/mcp',
      source: 'mcp-http',
      method,
      stage,
      requestId,
      durationMs: Math.max(0, performance.now() - startedAt),
      headersSent,
      sessionPresent,
      bodyComplete,
      bodyParsed,
      responseFinished
    }
    if (clientRequestId) event.clientRequestId = clientRequestId
    if (roomKey) event.roomKey = roomKey
    if (headersSent || responseFinished) {
      event.status = Number(res.statusCode)
    }
    if (operationId) event.operationId = operationId
    if (rpcId !== undefined) event.rpcId = rpcId
    if (rpcIdHash) event.rpcIdHash = rpcIdHash
    diagnostics.record(event)
  }

  record('request-received')
  req.once('end', () => {
    bodyComplete = true
    record('body-complete')
  })
  req.once('aborted', () => record('request-aborted'))
  res.once('finish', () => {
    responseFinished = true
    record('response-finish')
  })
  res.once('close', () => record('response-close'))

  return {
    requestId,
    markBodyParsed(body) {
      bodyParsed = true
      const identity = requestIdentity(body)
      operationId = identity.operationId
      roomKey = identity.roomKey
      rpcId = identity.rpcId
      rpcIdHash = identity.rpcIdHash
      record('body-parsed')
    },
    markTransportDispatched() {
      record('transport-dispatched')
    }
  }
}
