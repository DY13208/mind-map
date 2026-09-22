const path = require('path')
const { KnowledgeCompiler } = require('./compiler')
const { startScheduler } = require('./scheduler')
const { affectedUids } = require('./changeTracker')
const docmostMappingStore = require('./docmostMappingStore')
const docmostSyncCoordinator = require('./docmostSyncCoordinator')
const wikiMindmapSyncCoordinator = require('./wikiMindmapSyncCoordinator')

let compiler = null
let scheduler = null
let sourceClient = null
let knowledgePool = null

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

/**
 * After Wiki→Mindmap, human mapping records last_sync_source=wiki + hashes.
 * Docmost standard sync is unchanged (mindmap remains authority for standard).
 * Reverse-sync idempotency + manual API (no webhook) prevent Wiki↔Mindmap loops.
 * Optional short suppress is available for tests / future auto-webhook.
 */
const suppressDocmostUntil = new Map()

function noteWikiDrivenMindmapSync(roomId, ttlMs = 0) {
  const key = String(roomId || '')
  if (!key || !ttlMs) return
  suppressDocmostUntil.set(key, Date.now() + ttlMs)
}

function shouldSuppressDocmost(roomId) {
  const key = String(roomId || '')
  const until = suppressDocmostUntil.get(key)
  if (!until) return false
  if (Date.now() > until) {
    suppressDocmostUntil.delete(key)
    return false
  }
  return true
}

function wikiMindmapAutoSyncEnabled(env = process.env) {
  const raw = String(env.WIKI_MINDMAP_AUTO_SYNC || 'true').trim()
  return /^(true|1|yes|on)$/i.test(raw)
}

function wikiMindmapHookSecret(env = process.env) {
  return String(
    env.WIKI_MINDMAP_HOOK_SECRET ||
      env.DOCMOST_SSO_SECRET ||
      env.AUTH_SESSION_SECRET ||
      ''
  ).trim()
}

function createDefaultWikiMindmapService(pool) {
  const storage = require('../storage')
  const mindApi = require('../mindApi')
  const { createWikiMindmapSyncService } = require('./wikiMindmapSyncService')
  return createWikiMindmapSyncService({
    pool: pool || storage.getPool(),
    env: process.env,
    loadRoomNodes: async id => {
      const snap = await storage.getRoomSnapshot(id)
      if (!snap) return { nodes: {} }
      return {
        nodes: snap.nodes || {},
        version: snap.version
      }
    },
    executeCommand: (id, command) =>
      mindApi.executeTrustedOperation(id, command)
  })
}

/**
 * Fire-and-forget enqueue after Wiki page save.
 * Auto path is conservative: allowMove=false (heading-depth MOVE is unsafe).
 */
/** @type {Map<string, { slot: string, expiresAt: number }>} */
const mappingSlotCache = new Map()
const MAPPING_SLOT_CACHE_MS = 60000
/** Rate-limit noisy standard/skip logs (Mindmap→Wiki PAGE_UPDATED storms). */
const noisyLogAt = new Map()

function logEnqueueNoisy(key, message) {
  const now = Date.now()
  const last = noisyLogAt.get(key) || 0
  if (now - last < 15000) return
  noisyLogAt.set(key, now)
  console.log(message)
}

async function enqueueWikiMindmapSync(pageId, opts = {}) {
  const id = String(pageId || '').trim()
  if (!id) {
    return { success: false, error: 'MISSING_PAGE_ID', accepted: false }
  }
  if (!wikiMindmapAutoSyncEnabled(opts.env || process.env)) {
    return {
      success: true,
      accepted: false,
      skipped: 1,
      reason: 'AUTO_SYNC_DISABLED',
      page_id: id
    }
  }

  const cached = mappingSlotCache.get(id)
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.slot === 'standard') {
      return {
        success: false,
        accepted: false,
        skipped: 1,
        error: 'STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP',
        page_id: id,
        slot: 'standard',
        cached: true
      }
    }
    if (cached.slot === 'none') {
      return {
        success: true,
        accepted: false,
        skipped: 1,
        error: 'MAPPING_NOT_FOUND',
        page_id: id,
        cached: true
      }
    }
    if (cached.slot && cached.slot !== 'human') {
      return {
        success: true,
        accepted: false,
        skipped: 1,
        error: 'SLOT_NOT_SUPPORTED',
        page_id: id,
        slot: cached.slot,
        cached: true
      }
    }
  }

  const pool = opts.pool || knowledgePool || require('../storage').getPool()
  await docmostMappingStore.ensureSchema(pool)
  const mapping = await docmostMappingStore.getMappingByPageId(pool, id)
  if (!mapping) {
    mappingSlotCache.set(id, {
      slot: 'none',
      expiresAt: Date.now() + MAPPING_SLOT_CACHE_MS
    })
    logEnqueueNoisy(
      'none:' + id,
      '[WikiMindmapSync] page_id=' +
        id +
        ' action=enqueue status=SKIPPED reason=MAPPING_NOT_FOUND'
    )
    return {
      success: true,
      accepted: false,
      skipped: 1,
      error: 'MAPPING_NOT_FOUND',
      page_id: id
    }
  }
  mappingSlotCache.set(id, {
    slot: mapping.slot,
    expiresAt: Date.now() + MAPPING_SLOT_CACHE_MS
  })
  if (mapping.slot === 'standard') {
    logEnqueueNoisy(
      'std:' + id,
      '[WikiMindmapSync] page_id=' +
        id +
        ' slot=standard action=enqueue status=REJECTED error=STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP'
    )
    return {
      success: false,
      accepted: false,
      skipped: 1,
      error: 'STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP',
      page_id: id,
      slot: 'standard'
    }
  }
  if (mapping.slot !== 'human') {
    return {
      success: true,
      accepted: false,
      skipped: 1,
      error: 'SLOT_NOT_SUPPORTED',
      page_id: id,
      slot: mapping.slot
    }
  }

  const service =
    opts.service || createDefaultWikiMindmapService(pool)
  const allowMove = opts.allowMove === true
  const allowDelete = opts.allowDelete !== false

  return wikiMindmapSyncCoordinator.requestSync(id, {
    debounceMs: opts.debounceMs,
    wait: opts.wait === true,
    allowMove,
    allowDelete,
    actorId: opts.actorId || 'wiki-autosave',
    syncFn: async page_id => {
      const started = Date.now()
      try {
        const result = await service.syncPageToMindmap({
          pageId: page_id,
          actorId: opts.actorId || 'wiki-autosave',
          allowMove,
          allowDelete
        })
        if (!result || result.success === false) {
          console.error(
            '[WikiMindmapSync] page_id=' +
              page_id +
              ' room_id=' +
              (result && result.room_id) +
              ' slot=' +
              (result && result.slot) +
              ' source=wiki status=failed error=' +
              ((result && result.error) || 'UNKNOWN') +
              ' duration=' +
              (Date.now() - started) +
              'ms'
          )
        }
        return result
      } catch (err) {
        console.error(
          '[WikiMindmapSync] page_id=' +
            page_id +
            ' source=wiki status=failed error=' +
            ((err && err.code) || (err && err.message) || err) +
            ' duration=' +
            (Date.now() - started) +
            'ms'
        )
        return {
          success: false,
          error: (err && err.code) || 'WIKI_MINDMAP_SYNC_ERROR',
          message: (err && err.message) || String(err),
          page_id
        }
      }
    }
  })
}

async function start(options) {
  
  if (!enabled()) {
    await options.pool.query(
      'drop trigger if exists knowledge_attachment_change on node_attachments'
    )
    console.log('[KnowledgeCompiler] disabled')
    return
  }
  knowledgePool = options.pool
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
  if (wikiMindmapAutoSyncEnabled()) {
    console.log(
      '[WikiMindmapSync] auto-sync enabled (Docmost PAGE_UPDATED → human slot)'
    )
  } else {
    console.log('[WikiMindmapSync] auto-sync disabled (WIKI_MINDMAP_AUTO_SYNC=false)')
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
      if (!shouldSuppressDocmost(roomId)) {
        maybeSyncAfterCompile(result, options.pool)
      } else {
        console.log(
          '[WikiMindmapSync] suppress Docmost sync room=' + roomId
        )
      }
    } catch (_) {
      /* sync is best-effort */
    }
    return result
  }
  scheduler = startScheduler(compiler, { interval })
}

async function handleApi(req, res, pathname) {
  // POST /api/knowledge/wiki-page-saved  { page_id }  — Docmost hook (async enqueue)
  if (pathname === '/api/knowledge/wiki-page-saved') {
    const storage = require('../storage')
    const enqueueStarted = Date.now()
    if (req.method !== 'POST') {
      storage.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' })
      return true
    }
    try {
      const secret = wikiMindmapHookSecret()
      const got = String(
        req.headers['x-wiki-mindmap-hook-secret'] ||
          req.headers['x-hook-secret'] ||
          ''
      ).trim()
      if (!secret || !got || got !== secret) {
        storage.sendJson(res, 401, {
          success: false,
          error: 'UNAUTHORIZED_HOOK'
        })
        return true
      }
      const body = await storage.readBody(req, { maxBytes: 8192 })
      const pageId = body.page_id || body.pageId
      const pageIds = Array.isArray(body.page_ids)
        ? body.page_ids
        : Array.isArray(body.pageIds)
          ? body.pageIds
          : pageId
            ? [pageId]
            : []
      if (!pageIds.length) {
        storage.sendJson(res, 400, {
          success: false,
          error: 'MISSING_PAGE_ID'
        })
        return true
      }
      const results = []
      for (const id of pageIds) {
        results.push(
          await enqueueWikiMindmapSync(id, {
            pool: storage.getPool(),
            actorId: 'wiki-autosave'
          })
        )
      }
      storage.sendJson(res, 202, {
        success: true,
        accepted: true,
        enqueue_ms: Date.now() - enqueueStarted,
        results
      })
      return true
    } catch (err) {
      // Never fail Docmost save path because of our errors — still return 202-ish
      console.error(
        '[WikiMindmapSync] wiki-page-saved hook error: ' +
          ((err && err.message) || err)
      )
      storage.sendJson(res, 202, {
        success: true,
        accepted: false,
        error: err.code || 'HOOK_ERROR',
        message: err.message
      })
      return true
    }
  }

  // POST /api/knowledge/sync-to-mindmap  { page_id }
  if (pathname === '/api/knowledge/sync-to-mindmap') {
    const storage = require('../storage')
    if (req.method !== 'POST') {
      storage.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' })
      return true
    }
    try {
      const body = await storage.readBody(req, { maxBytes: 8192 })
      const pageId = body.page_id || body.pageId
      if (!pageId) {
        storage.sendJson(res, 400, {
          success: false,
          error: 'MISSING_PAGE_ID'
        })
        return true
      }
      await docmostMappingStore.ensureSchema(storage.getPool())
      const mapping = await docmostMappingStore.getMappingByPageId(
        storage.getPool(),
        pageId
      )
      if (!mapping) {
        storage.sendJson(res, 404, {
          success: false,
          error: 'MAPPING_NOT_FOUND'
        })
        return true
      }
      const roomId = storage.safeRoomKey(mapping.room_id)
      await require('../roomAcl').assertRoomAccess(
        storage.getPool(),
        req,
        roomId,
        'edit'
      )
      const mindApi = require('../mindApi')
      const { createWikiMindmapSyncService } = require('./wikiMindmapSyncService')
      const service = createWikiMindmapSyncService({
        pool: storage.getPool(),
        env: process.env,
        loadRoomNodes: async id => {
          const snap = await storage.getRoomSnapshot(id)
          if (!snap) return { nodes: {} }
          return {
            nodes: snap.nodes || snap.obj || {},
            version: snap.row && snap.row.version
          }
        },
        executeCommand: (id, command) =>
          mindApi.executeTrustedOperation(id, command)
      })
      const actorId =
        (req.user && (req.user.userId || req.user.id || req.user.userid)) ||
        'wiki-sync'
      const result = await service.syncPageToMindmap({
        pageId,
        actorId
      })
      if (result.success) {
        // Default ttlMs=0: do not suppress standard Docmost push.
        noteWikiDrivenMindmapSync(roomId, 0)
      }
      storage.sendJson(res, result.success ? 200 : 409, result)
      return true
    } catch (err) {
      storage.sendJson(res, err.statusCode || 500, {
        success: false,
        error: err.code || 'WIKI_MINDMAP_SYNC_ERROR',
        message: err.message
      })
      return true
    }
  }

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

module.exports = {
  start,
  enabled,
  handleApi,
  getCompiler: () => compiler,
  getScheduler: () => scheduler,
  enqueueDocmostSync,
  enqueueWikiMindmapSync,
  syncDocmostViaCoordinator,
  docmostSyncCoordinator,
  wikiMindmapSyncCoordinator,
  noteWikiDrivenMindmapSync,
  shouldSuppressDocmost,
  wikiMindmapAutoSyncEnabled,
  wikiMindmapHookSecret
}
