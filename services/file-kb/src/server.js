'use strict'
const http = require('http')
const { loadConfig } = require('./config')
const { createAuthenticator, AuthError } = require('./auth')
const { createDoclingClient } = require('./docling/client')
const { ALLOWED } = require('./limits')

function send(res, status, body) {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(payload)
}

// Cookie mutations require a browser Origin that matches the Host header, or an
// explicit FILE_KB_TRUSTED_ORIGINS entry. X-Requested-With and X-Forwarded-Host
// are not substitutes: a page can set both, and the browser will not let it
// rewrite Origin or Host.
function mutationAllowed(req, trustedOrigins = []) {
  const origin = req.headers && req.headers.origin
  if (!origin || typeof origin !== 'string') return false
  let parsed
  try { parsed = new URL(origin) } catch (_) { return false }
  if (parsed.origin !== origin) return false
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false
  if (trustedOrigins.length) return trustedOrigins.includes(parsed.origin)
  const host = String((req.headers && req.headers.host) || '').split(',')[0].trim().toLowerCase()
  return host.length > 0 && parsed.host.toLowerCase() === host
}

function mediaKind(method, pathname, req) {
  if (method === 'POST' && pathname === '/api/kb/files') return 'multipart'
  if (method === 'DELETE') {
    const ct = String((req.headers && req.headers['content-type']) || '')
    return ct ? 'json' : 'none'
  }
  return 'json'
}

async function checkDocling(config, fetchImpl) {
  if (!config.doclingUrl) return { status: 'not_configured', ok: false }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.doclingHealthTimeoutMs)
  try {
    const r = await fetchImpl(`${config.doclingUrl}/health`, { signal: ctrl.signal })
    return { status: r.ok ? 'ok' : 'error', ok: r.ok === true, httpStatus: r.status }
  } catch (err) {
    return { status: 'unreachable', ok: false, error: err.name === 'AbortError' ? 'timeout' : 'connect_failed' }
  } finally {
    clearTimeout(timer)
  }
}

async function health(deps) {
  const out = { ok: true, enabled: true, db: { ok: false }, docling: null, queue: null }
  try {
    await deps.query('select 1')
    out.db.ok = true
    const q = await deps.query(
      `select state, count(*)::int as n from kb.jobs where state in ('queued','running','failed') group by state`)
    out.queue = { queued: 0, running: 0, failed: 0 }
    for (const r of q.rows) out.queue[r.state] = r.n
  } catch (err) {
    out.ok = false
    out.db.error = err.code === '42P01' ? 'schema_missing' : 'unavailable'
  }
  out.docling = await checkDocling(deps.config, deps.fetchImpl)
  const cfg = deps.config || {}
  out.limits = {
    maxFileBytes: cfg.maxFileBytes,
    maxBatchBytes: cfg.maxBatchBytes,
    maxFilesPerBatch: cfg.maxFilesPerBatch,
    uploadConcurrencyPerUser: cfg.uploadConcurrencyPerUser,
    uploadFilesPerMinute: cfg.uploadFilesPerMinute,
    maxQueuedPerUser: cfg.maxQueuedPerUser,
    allowedExtensions: Object.keys(ALLOWED)
  }
  return out
}

function createHandler(deps) {
  const { config } = deps
  const authenticator = deps.authenticator || createAuthenticator({
    query: deps.query, ttlMs: config.authCacheTtlMs, maxEntries: config.authCacheMax,
    superAdminIds: config.superAdminIds
  })
  return async function handle(req, res) {
    let pathname
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch (_) { return send(res, 400, { error: 'bad request' }) }
    if (pathname === '/healthz') return send(res, 200, { ok: true, enabled: config.enabled })
    if (pathname !== '/api/kb' && !pathname.startsWith('/api/kb/')) return send(res, 404, { error: 'not found', code: 'not_found' })
    if (!config.enabled) return send(res, 404, { error: 'not found', code: 'kb_disabled' })

    const method = String(req.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!mutationAllowed(req, config.trustedOrigins || [])) {
        return send(res, 403, { error: 'forbidden', code: 'origin_denied' })
      }
      const kind = mediaKind(method, pathname, req)
      const ct = String(req.headers['content-type'] || '').toLowerCase()
      if (kind === 'multipart' && !ct.includes('multipart/form-data')) {
        return send(res, 415, { error: 'unsupported media type', code: 'unsupported_media' })
      }
      if (kind === 'json' && !ct.includes('application/json')) {
        return send(res, 415, { error: 'unsupported media type', code: 'unsupported_media' })
      }
    }
    try {
      const fresh = config.authCacheTtlMs <= 0 || !['GET', 'HEAD', 'OPTIONS'].includes(method)
      req.kbUser = await authenticator.authenticate(req, { fresh })
    } catch (err) {
      if (err instanceof AuthError) return send(res, err.status, { error: err.message, code: err.code })
      console.error('[file-kb] auth error', err)
      return send(res, 503, { error: 'auth unavailable', code: 'auth_unavailable' })
    }
    if (req.kbUser.via === 'token') {
      const scopes = req.kbUser.scopes || []
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method)
      const admin = mutating && (pathname.startsWith('/api/kb/acl/') || pathname.startsWith('/api/kb/mcp/tokens'))
      const need = admin ? 'kb:admin' : mutating ? 'kb:write' : 'kb:read'
      if (!scopes.includes(need)) return send(res, 403, { error: 'forbidden', code: 'forbidden' })
    }
    try {
      if (pathname === '/api/kb/health' && method === 'GET') {
        const h = await health(deps)
        return send(res, h.ok ? 200 : 503, { ...h, user: { id: req.kbUser.id } })
      }
      if (deps.api && await deps.api(req, res, req.kbUser, pathname, method, new URL(req.url, 'http://localhost'))) return
      return send(res, 404, { error: 'not found', code: 'not_found' })
    } catch (err) {
      console.error('[file-kb] handler error', err)
      return send(res, 500, { error: 'internal error', code: 'internal' })
    }
  }
}

async function main() {
  const config = loadConfig()
  let pool = null
  let query = async () => { throw Object.assign(new Error('db disabled'), { code: 'KB_DISABLED' }) }
  if (config.enabled) {
    const { createPool } = require('./db')
    pool = createPool(config.db)
    query = (text, params) => pool.query(text, params)
    if (config.migrateOnStart) {
      try {
        await require('./migrate').migrate(pool)
      } catch (err) {
        console.error('[file-kb] migration failed (service stays up, health reports db error):', err.message)
      }
    }
  }
  let api = null
  if (config.enabled) {
    const { createStorage } = require('./storage')
    const { createQueue } = require('./queue')
    const { createApi } = require('./api')
    const { createLimiter } = require('./ratelimit')
    const storage = createStorage(config.storageRoot)
    await storage.init()
    const { createGeekcloud } = require('./geekcloud')
    const { adapter: geekcloud } = createGeekcloud({
      query,
      sdk: {
        Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
        StreamableHTTPClientTransport: require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
      }
    })
    api = createApi({
      pool, storage, config, geekcloud,
      queue: createQueue(pool, { leaseMs: config.leaseMs }),
      limiter: createLimiter({ maxConcurrent: config.uploadConcurrencyPerUser, perMinute: config.uploadFilesPerMinute })
    })
  }
  const handler = createHandler({ config, query, fetchImpl: globalThis.fetch, api })
  const server = http.createServer((req, res) => { handler(req, res) })
  server.requestTimeout = 15 * 60000 // large uploads
  server.headersTimeout = 15000
  server.listen(config.port, config.host, () => {
    console.log(`[file-kb] listening on ${config.host}:${config.port} enabled=${config.enabled}`)
  })
  const stop = () => { server.close(() => { if (pool) pool.end().finally(() => process.exit(0)); else process.exit(0) }) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

module.exports = { createHandler, health, mutationAllowed }

if (require.main === module) main()
