const path = require('path')
const { KnowledgeCompiler } = require('./compiler')
const { startScheduler } = require('./scheduler')
const { affectedUids } = require('./changeTracker')
let compiler = null
let scheduler = null
let sourceClient = null
function enabled() { return /^(true|1|yes|on)$/i.test(String(process.env.KNOWLEDGE_COMPILER_ENABLED || 'false')) }
async function start(options) {
  if (!enabled()) {
    await options.pool.query('drop trigger if exists knowledge_attachment_change on node_attachments')
    console.log('[KnowledgeCompiler] disabled'); return
  }
  // Failure here is isolated by caller; no compiler work runs in the save path.
  await require('./sourceChanges').initSchema(options.pool)
  compiler = new KnowledgeCompiler({ pool: options.pool,
    outputDir: process.env.KNOWLEDGE_OUTPUT_DIR || path.resolve(__dirname, '../../../knowledge') })
  const interval = Math.max(1, Number(process.env.KNOWLEDGE_SYNC_INTERVAL) || 300)
  console.log(`[KnowledgeCompiler] enabled\n[KnowledgeCompiler] output: ${compiler.outputDir}\n[KnowledgeCompiler] interval: ${interval}s`)
  const notify = event => {
    try { compiler.tracker.mark(event.roomKey || event.mapId, event.version, affectedUids(event.operation || event.event || event)) }
    catch (err) { console.error('[KnowledgeCompiler] notification failed:', err.message) }
  }
  options.operationEvents.on('committed', notify)
  options.operationEvents.on('roomDeleted', event => {
    // Deletion may race a running compile; reconcile again after it finishes.
    Promise.resolve().then(() => compiler.compile(event.roomKey)).catch(() => {})
      .then(() => compiler.compile(event.roomKey)).catch(() => {})
  })
  if (options.bus?.subscribe) options.bus.subscribe(notify)
  if (options.sourceNotifications !== false) {
    try {
      sourceClient = await options.pool.connect()
      sourceClient.on('notification', message => {
        try {
          if (message.channel !== 'knowledge_events') return
          const event = JSON.parse(message.payload)
          compiler.tracker.markSource(event.roomId, event.revision)
        } catch (_) { /* durable source log is the fallback */ }
      })
      sourceClient.on('error', err => console.error('[KnowledgeCompiler] source notifications unavailable:', err.message))
      await sourceClient.query('LISTEN knowledge_events')
    } catch (err) {
      if (sourceClient) sourceClient.release(true)
      sourceClient = null
      console.error('[KnowledgeCompiler] source notifications unavailable; polling continues:', err.message)
    }
  }
  scheduler = startScheduler(compiler, { interval })
}
async function handleApi(req, res, pathname) {
  const hit = pathname.match(/^\/api\/knowledge\/(compile|status)\/([^/]+)$/)
  if (!hit) return false
  const storage = require('../storage')
  try {
    const roomId = storage.safeRoomKey(decodeURIComponent(hit[2]))
    const expected = hit[1] === 'compile' ? 'POST' : 'GET'
    if (req.method !== expected) { storage.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' }); return true }
    await require('../roomAcl').assertRoomAccess(storage.getPool(), req, roomId, hit[1] === 'compile' ? 'edit' : 'view')
    if (!compiler) { storage.sendJson(res, 503, { code: 'KNOWLEDGE_DISABLED' }); return true }
    const body = hit[1] === 'compile' ? await storage.readBody(req, { maxBytes: 4096 }) : {}
    if (body.force !== undefined && typeof body.force !== 'boolean') { storage.sendJson(res, 400, { code: 'INVALID_FORCE' }); return true }
    const result = hit[1] === 'compile' ? await compiler.compile(roomId, { force: body.force === true }) : await compiler.status(roomId)
    storage.sendJson(res, result.status === 'busy' ? 409 : result.status === 'archived' ? 404 : 200, result)
  } catch (err) { storage.sendJson(res, err.statusCode || 500, { error: err.message, code: err.code || 'KNOWLEDGE_ERROR' }) }
  return true
}
module.exports = { start, enabled, handleApi, getCompiler: () => compiler, getScheduler: () => scheduler }
