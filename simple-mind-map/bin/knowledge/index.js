const path = require('path')
const { KnowledgeCompiler } = require('./compiler')
const { startScheduler } = require('./scheduler')
const { affectedUids } = require('./changeTracker')
const docmostMappingStore = require('./docmostMappingStore')
const docmostSyncCoordinator = require('./docmostSyncCoordinator')

let compiler = null
let scheduler = null
let sourceClient = null

function enabled() {
  return /^(true|1|yes|on)$/i.test(
    String(process.env.KNOWLEDGE_COMPILER_ENABLED || 'false')
  )
}

function docmostSyncEnabled() {
  return require('./adapters/docmostAdapter').syncEnabled()
}

function enqueueDocmostSync(roomId, pool, reason) {
  if (!docmostSyncEnabled()) return
  const key = String(roomId || '')
  if (!key) return
  docmostSyncCoordinator
    .requestSync(key, {
      pool,
      outputDir: compiler && compiler.outputDir,
      reason: reason || 'compile'
    })
    .then(result => {
      if (!result || result.skipped) return
      if (result.accepted && result.coalesced) {
        console.log(
          '[DocmostSync][room=' + key + '] coalesced (rerun scheduled)'
        )
      }
    })
    .catch(err => {
      console.error(
        '[DocmostSync][room=' +
          key +
          '] enqueue failed: ' +
          ((err && err.message) || err)
      )
    })
}

// Awaited path for API / recovery — same coordinator, never bypass Adapter.sync
async function syncDocmostViaCoordinator(roomId, pool, reason) {
  if (!docmostSyncEnabled()) {
    const err = new Error('DOCMOST_SYNC_ENABLED off')
    err.code = 'DOCMOST_SYNC_DISABLED'
    err.statusCode = 503
    throw err
  }
  const result = await docmostSyncCoordinator.requestSyncAndWait(roomId, {
    pool,
    outputDir: compiler && compiler.outputDir,
    reason: reason || 'api'
  })
  if (result && !result.skipped) {
    console.log(
      '[DocmostSync][room=' +
        roomId +
        '] space=' +
        result.spaceId +
        ' kind=' +
        result.spaceKind +
        ' pages=' +
        result.pages +
        (result.warnings && result.warnings.length
          ? ' warnings=' + result.warnings.length
          : '')
    )
  } else if (result && result.skipped) {
    console.log(
      '[DocmostSync][room=' + roomId + '] skipped: ' + result.reason
    )
  }
  return result
}

function maybeSyncAfterCompile(result, pool) {
  if (!result || result.status !== 'idle') return
  enqueueDocmostSync(result.roomId, pool)
}

async function start(options) {
  
  if (!enabled()) {
    await options.pool.query(
      'drop trigger if exists knowledge_attachment_change on node_attachments'
    )
    console.log('[KnowledgeCompiler] disabled')
    return
  }
  await require('./sourceChanges').initSchema(options.pool)
  await docmostMappingStore.ensureSchema(options.pool)
  compiler = new KnowledgeCompiler({
    pool: options.pool,
    outputDir:
      process.env.KNOWLEDGE_OUTPUT_DIR ||
      path.resolve(__dirname, '../../../knowledge')
  })
  const interval = Math.max(1, Number(process.env.KNOWLEDGE_SYNC_INTERVAL) || 300)
  console.log(
    `[KnowledgeCompiler] enabled\n[KnowledgeCompiler] output: ${compiler.outputDir}\n[KnowledgeCompiler] interval: ${interval}s`
  )
  if (docmostSyncEnabled()) {
    console.log('[DocmostSync] enabled (compile → Docmost personal/team spaces)')
  } else {
    console.log('[DocmostSync] disabled (set DOCMOST_SYNC_ENABLED=true to push Wiki)')
  }
  const notify = event => {
    try {
      compiler.tracker.mark(
        event.roomKey || event.mapId,
        event.version,
        affectedUids(event.operation || event.event || event)
      )
    } catch (err) {
      console.error('[KnowledgeCompiler] notification failed:', err.message)
    }
  }
  options.operationEvents.on('committed', notify)
  options.operationEvents.on('roomDeleted', event => {
    Promise.resolve()
      .then(() => compiler.compile(event.roomKey))
      .catch(() => {})
      .then(() => compiler.compile(event.roomKey))
      .catch(() => {})
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
        } catch (_) {
          /* durable source log is the fallback */
        }
      })
      sourceClient.on('error', err =>
        console.error(
          '[KnowledgeCompiler] source notifications unavailable:',
          err.message
        )
      )
      await sourceClient.query('LISTEN knowledge_events')
    } catch (err) {
      if (sourceClient) sourceClient.release(true)
      sourceClient = null
      console.error(
        '[KnowledgeCompiler] source notifications unavailable; polling continues:',
        err.message
      )
    }
  }
  const originalCompile = compiler.compile.bind(compiler)
  compiler.compile = async (roomId, compileOptions = {}) => {
    const result = await originalCompile(roomId, compileOptions)
    try {
      maybeSyncAfterCompile(result, options.pool)
    } catch (_) {
      /* sync is best-effort */
    }
    return result
  }
  scheduler = startScheduler(compiler, { interval })
}

async function handleApi(req, res, pathname) {
  const hit = pathname.match(
    /^\/api\/knowledge\/(compile|status|sync)\/([^/]+)$/
  )
  if (!hit) return false
  const storage = require('../storage')
  try {
    const roomId = storage.safeRoomKey(decodeURIComponent(hit[2]))
    const action = hit[1]
    const expected =
      action === 'status' ? 'GET' : action === 'compile' || action === 'sync' ? 'POST' : null
    if (!expected || req.method !== expected) {
      storage.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' })
      return true
    }
    await require('../roomAcl').assertRoomAccess(
      storage.getPool(),
      req,
      roomId,
      action === 'status' ? 'view' : 'edit'
    )
    if (!compiler) {
      storage.sendJson(res, 503, { code: 'KNOWLEDGE_DISABLED' })
      return true
    }
    if (action === 'status') {
      const result = await compiler.status(roomId)
      storage.sendJson(res, 200, result)
      return true
    }
    if (action === 'compile') {
      const body = await storage.readBody(req, { maxBytes: 4096 })
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        storage.sendJson(res, 400, { code: 'INVALID_FORCE' })
        return true
      }
      const result = await compiler.compile(roomId, {
        force: body.force === true
      })
      storage.sendJson(
        res,
        result.status === 'busy' ? 409 : result.status === 'archived' ? 404 : 200,
        result
      )
      return true
    }
    if (action === 'sync') {
      if (!docmostSyncEnabled()) {
        storage.sendJson(res, 503, {
          code: 'DOCMOST_SYNC_DISABLED',
          error: 'DOCMOST_SYNC_ENABLED 未开启'
        })
        return true
      }
      // Ensure canonical is fresh, then push
      await compiler.compile(roomId, { force: false })
      const result = await syncDocmostViaCoordinator(
        roomId,
        storage.getPool(),
        'api'
      )
      storage.sendJson(res, 200, result)
      return true
    }
  } catch (err) {
    storage.sendJson(res, err.statusCode || 500, {
      error: err.message,
      code: err.code || 'KNOWLEDGE_ERROR'
    })
  }
  return true
}

module.exports = {start,
  enabled,
  handleApi,
  getCompiler: () => compiler,
  getScheduler: () => scheduler,
  enqueueDocmostSync,
  syncDocmostViaCoordinator,
  docmostSyncCoordinator
}
