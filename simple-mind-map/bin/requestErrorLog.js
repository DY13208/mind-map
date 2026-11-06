const { randomUUID } = require('crypto')

function safeId(value) {
  return typeof value === 'string' && /^[\w.@:-]{1,160}$/.test(value) ? value : ''
}

function identity(req) {
  const user = req && req.authUser
  const source = req && req.verifiedMcpSource
  return safeId(user && user.id) || safeId(source && source.principalId) ||
    safeId(req && req.logAuthenticatedUserId) || 'anonymous'
}

function writeErrorLog(fields, req, emit = console.error) {
  // Explicit allowlist: never serialize request bodies, headers, tokens or error messages.
  const row = { event: 'request_error', userId: identity(req) }
  for (const key of ['source', 'requestId', 'method', 'roomKey', 'tool', 'code', 'socketId']) {
    const value = safeId(fields[key])
    if (value) row[key] = value
  }
  if (typeof fields.path === 'string') row.path = fields.path.split('?')[0].slice(0, 240)
  if (Number.isInteger(fields.status)) row.status = fields.status
  if (Number.isFinite(fields.durationMs)) row.durationMs = Math.round(fields.durationMs)
  emit(JSON.stringify(row))
}

function observeRequestErrors(req, res, source = 'http', emit = console.error) {
  const started = Date.now()
  const requestId = randomUUID()
  let finished = false
  const done = aborted => {
    if (finished) return
    finished = true
    if (!aborted && res.statusCode < 400) return
    let url
    try { url = new URL(req.url || '/', 'http://localhost') } catch { url = new URL('http://localhost/invalid-url') }
    const pathRoom = url.pathname.match(/^\/api\/files\/([^/]+)/)
    writeErrorLog({ source, requestId, method: req.method,
      path: url.pathname.replace(/^\/mcp-upload\/[^/]+/, '/mcp-upload/:id'),
      roomKey: req.logRoomKey || (pathRoom && pathRoom[1]) ||
        url.searchParams.get('room_key') || url.searchParams.get('roomKey') || url.searchParams.get('room'),
      tool: req.logMcpTool, status: aborted ? 499 : res.statusCode,
      durationMs: Date.now() - started
    }, req, emit)
  }
  res.once('finish', () => done(false))
  res.once('close', () => done(!res.writableFinished))
}

module.exports = { safeId, writeErrorLog, observeRequestErrors }
