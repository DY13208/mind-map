// Bounded, structured performance evidence. Never capture payloads, headers,
// arbitrary console output, SQL text or node content.
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const MAX_EVENTS = 3000
const WINDOW_MS = 15 * 60 * 1000
const KINDS = new Set(['http', 'pool', 'lock-query', 'transaction', 'acl', 'render', 'longtask', 'ack', 'ack-failed', 'remote', 'local', 'resource', 'canvas-ready', 'cancel-render', 'api-queue', 'client-state'])
const events = []
let sequence = 0
let overwritten = 0
let loop
const reporters = new Map()
const enabled = () => /^(1|true|on)$/i.test(String(process.env.PERFORMANCE_DIAGNOSTICS || '0').trim())
const now = () => performance.now()
function start() {
  if (!enabled() || loop) return
  loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
}
function record(input = {}) {
  if (!enabled() || !KINDS.has(input.kind)) return
  const row = { seq: ++sequence, at: Date.now(), kind: input.kind }
  // Restrict labels as well as values; no arbitrary event detail survives.
  for (const key of ['roomKey', 'sessionId', 'route', 'source', 'path', 'type', 'method']) {
    if (typeof input[key] === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(input[key])) row[key] = input[key]
  }
  for (const key of ['durationMs', 'count', 'status', 'queries', 'writes', 'version']) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) row[key] = Math.min(input[key], 1e9)
  }
  if (typeof input.ok === 'boolean') row.ok = input.ok
  events.push(row)
  if (events.length > MAX_EVENTS) { events.shift(); overwritten += 1 }
}
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const p = n => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * n) - 1)] : null
  return { samples: sorted.length, p50: p(.5), p95: p(.95), max: p(1) }
}
function snapshot({ roomKey = '', since = 0, after = 0, pool } = {}) {
  const cutoff = Math.max(Date.now() - WINDOW_MS, Number(since) || 0)
  const rows = events.filter(e => e.at >= cutoff && (!roomKey || e.roomKey === roomKey))
  const groups = new Map()
  for (const e of rows) {
    const key = [e.kind, e.source || '', e.path || '', e.route || '', e.type || ''].join('|')
    if (!groups.has(key)) groups.set(key, { kind: e.kind, source: e.source, path: e.path, route: e.route, type: e.type, count: 0, durations: [], lastCount: null })
    const g = groups.get(key); g.count += 1
    if (Number.isFinite(e.durationMs)) g.durations.push(e.durationMs)
    if (Number.isFinite(e.count)) g.lastCount = e.count
  }
  const memory = process.memoryUsage()
  return {
    enabled: enabled(), processId: process.pid, uptimeSeconds: process.uptime(), serverTime: Date.now(),
    windowMs: WINDOW_MS, capacity: MAX_EVENTS, overwritten, cursor: sequence,
    scope: roomKey || 'all',
    runtime: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      cpuUsageMicros: process.cpuUsage(),
      eventLoopDelayMs: loop && loop.count ? { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6, scope: 'process-lifetime' } : null,
      pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null },
    summary: [...groups.values()].map(({ durations, ...g }) => ({ ...g, latencyMs: stats(durations) })),
    events: rows.filter(e => e.seq > (Number(after) || 0)),
    notes: ['In-memory; cleared on process restart. Per-process, not a cluster aggregate.', 'lock-query includes PostgreSQL execution, row-lock wait, network and row decoding; it is not pure lock wait.', 'Browser reports are opt-in and untrusted measurements; absence is not zero.', 'Client duration is monotonic; event time is server receipt time.']
  }
}
function observeHttp(req, res) {
  if (!enabled()) return
  let url
  try { url = new URL(req.url, 'http://localhost') } catch (_) { return }
  const match = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/(preview|subtree|locate|nodes|info|operations|version|export))?/)
  if (!match) return
  const route = match[2] || (url.searchParams.get('format') === 'meta' ? 'meta' : 'snapshot')
  const started = now()
  res.once('finish', () => record({ kind: 'http', roomKey: match[1],
    route: '/api/files/:room/' + route, method: req.method,
    source: req.verifiedMcpSource || req.authUser?.mcp || req.authUser?.service ? 'mcp' : 'browser-http',
    status: res.statusCode, durationMs: now() - started }))
}
async function handleApi(req, res, pathname, deps) {
  if (pathname !== '/api/diagnostics/performance') return false
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true }
  if (!enabled()) return send(404, { code: 'DIAGNOSTICS_DISABLED' })
  const user = req.authUser
  if (!user?.id || user.service) return send(403, { code: 'FORBIDDEN' })
  if (req.method === 'GET') {
    if (!deps.isSuperAdminUser(user)) return send(403, { code: 'FORBIDDEN' })
    const url = new URL(req.url, 'http://localhost')
    const roomKey = url.searchParams.get('room') || ''
    if (roomKey && !/^[a-zA-Z0-9_-]{1,100}$/.test(roomKey)) return send(400, { code: 'BAD_DIAGNOSTICS_ROOM' })
    return send(200, { ...snapshot({ roomKey, since: url.searchParams.get('since'), after: url.searchParams.get('after'), pool: deps.pool }), collaboration: deps.runtime ? deps.runtime(roomKey) : null })
  }
  if (req.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED' })
  // Browser ingestion is session-only; MCP can be observed server-side.
  if (user.mcp) return send(403, { code: 'FORBIDDEN' })
  const origin = req.headers.origin
  if (!origin || !deps.isAllowedOrigin(req)) return send(403, { code: 'ORIGIN_REQUIRED' })
  const time = Date.now()
  for (const [id, row] of reporters) if (row.until < time) reporters.delete(id)
  const key = String(user.id)
  const rate = reporters.get(key) || { until: time + 60000, count: 0 }
  if (rate.count >= 12 || (!reporters.has(key) && reporters.size >= 500)) return send(429, { code: 'DIAGNOSTICS_RATE_LIMIT' })
  rate.count += 1; reporters.set(key, rate)
  let body
  try { body = await deps.readBody(req, { maxBytes: 32768 }) }
  catch (error) { return send(error.statusCode === 413 ? 413 : 400, { code: 'BAD_DIAGNOSTICS_REPORT' }) }
  if (!body || typeof body.roomKey !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.roomKey) ||
      typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.sessionId) ||
      !Array.isArray(body.events) || body.events.length > 100) return send(400, { code: 'BAD_DIAGNOSTICS_REPORT' })
  try { await deps.assertRoomAccess(deps.pool, req, body.roomKey, 'view') }
  catch (error) { return send(error.statusCode || 403, { code: 'ROOM_ACCESS_DENIED' }) }
  const clientKinds = new Set(['render', 'longtask', 'ack', 'ack-failed', 'remote', 'local', 'resource', 'canvas-ready', 'cancel-render', 'api-queue', 'client-state'])
  for (const e of body.events) if (e && clientKinds.has(e.kind)) {
    record({ kind: e.kind, durationMs: e.durationMs, count: e.count, type: e.type, route: e.route,
      roomKey: body.roomKey, sessionId: body.sessionId, source: 'browser' })
  }
  return send(202, { accepted: true })
}
module.exports = { enabled, now, start, record, snapshot, observeHttp, handleApi }
