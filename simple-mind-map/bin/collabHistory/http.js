const { sendJson, readBody, safeRoomKey } = require('../storage')
const { getHistoryEngine } = require('./index')

function publicVersion(row) {
  if (!row) return null
  return {
    versionId: row.id,
    revision: Number(row.revision),
    checkpointRevision: Number(row.checkpoint_revision || 0),
    name: row.name || '',
    type: row.type,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    description: row.description || '',
    source: row.source || '',
    readOnly: true
  }
}

function publicCoverage(engineResult) {
  if (!engineResult) return {}
  return {
    earliestAvailableRevision: Number(engineResult.earliestAvailableRevision),
    currentRevision: Number(engineResult.currentRevision),
    completeFromRevision: Number(engineResult.completeFromRevision),
    historyStartRevision: Number(
      engineResult.historyStartRevision != null
        ? engineResult.historyStartRevision
        : engineResult.earliestAvailableRevision
    )
  }
}

function matchHistory(pathname) {
  return String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/versions(?:\/([^/]+)(?:\/(tree|restore|hide))?)?$/
  )
}

async function handleHistoryApi(req, res, options = {}) {
  const url = options.url || new URL(req.url, 'http://127.0.0.1')
  const match = matchHistory(url.pathname)
  if (!match) return false
  const engine = options.engine || getHistoryEngine()
  if (!engine) {
    sendJson(res, 503, { ok: false, code: 'HISTORY_UNAVAILABLE', error: 'history engine not ready' })
    return true
  }
  const roomKey = safeRoomKey(decodeURIComponent(match[1]))
  const versionId = match[2] || ''
  const tail = match[3] || ''
  const method = String(req.method || 'GET').toUpperCase()
  const userId =
    (req.roomAccess && req.roomAccess.userId) ||
    (req.authUser && req.authUser.id) ||
    ''
  try {
    if (method === 'GET' && !versionId) {
      const listed = await engine.listVersions(roomKey, {
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor'),
        type: url.searchParams.get('type'),
        createdBy: url.searchParams.get('createdBy'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to')
      })
      sendJson(res, 200, {
        ok: true,
        viewingHistory: true,
        versions: (listed.versions || []).map(publicVersion),
        nextCursor: listed.nextCursor || null,
        ...publicCoverage(listed)
      })
      return true
    }
    if (method === 'POST' && !versionId) {
      const body = options.body || (await readBody(req))
      const row = await engine.createVersion(roomKey, {
        revision: body.revision,
        name: body.name,
        description: body.description,
        type: body.type || 'MANUAL',
        createdBy: userId,
        source: 'manual'
      })
      const coverage = await engine.getHistoryCoverage(roomKey)
      sendJson(res, 201, { ok: true, version: publicVersion(row), ...publicCoverage(coverage) })
      return true
    }
    if (method === 'GET' && versionId && !tail) {
      const row = await engine.getVersion(roomKey, versionId)
      if (!row) {
        sendJson(res, 404, { ok: false, code: 'VERSION_NOT_FOUND', error: 'version not found' })
        return true
      }
      await engine.ensureHistoryBaseline(roomKey)
      const coverage = await engine.getHistoryCoverage(roomKey)
      sendJson(res, 200, {
        ok: true,
        viewingHistory: true,
        readOnly: true,
        version: publicVersion(row),
        ...publicCoverage(coverage)
      })
      return true
    }
    if (method === 'GET' && tail === 'tree') {
      const row = await engine.getVersion(roomKey, versionId)
      if (!row) {
        sendJson(res, 404, { ok: false, code: 'VERSION_NOT_FOUND', error: 'version not found' })
        return true
      }
      const state = await engine.getRoomStateAtRevision(roomKey, row.revision)
      const summary = await engine.summarizeRange(roomKey, 0, row.revision)
      sendJson(res, 200, {
        ok: true,
        viewingHistory: true,
        readOnly: true,
        mutable: false,
        version: publicVersion(row),
        revision: state.revision,
        metadata: state.metadata,
        tree: state.tree,
        checksum: state.checksum,
        summary,
        ...publicCoverage(state)
      })
      return true
    }
    if (method === 'POST' && tail === 'restore') {
      const body = options.body || (await readBody(req).catch(() => ({})))
      const result = await engine.restoreVersion(roomKey, {
        versionId,
        targetRevision: body.targetRevision,
        expectedCurrentRevision: body.expectedCurrentRevision,
        userId,
        clientId: body.clientId,
        name: body.name,
        description: body.description
      })
      sendJson(res, 200, {
        ok: true,
        fromRevision: result.fromRevision,
        targetRevision: result.targetRevision,
        newRevision: result.newRevision,
        preRestoreVersionId: result.preRestoreVersionId,
        restoreVersionId: result.restoreVersionId,
        fullTreeReason: 'VERSION_RESTORE',
        ...publicCoverage(result)
      })
      return true
    }
    if (method === 'POST' && tail === 'hide') {
      const hidden = await engine.hideVersion(roomKey, versionId)
      sendJson(res, hidden ? 200 : 404, {
        ok: !!hidden,
        hidden: !!hidden,
        versionId
      })
      return true
    }
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
    return true
  } catch (error) {
    sendJson(res, error.statusCode || 400, {
      ok: false,
      code: error.code || 'HISTORY_ERROR',
      error: error.message
    })
    return true
  }
}

module.exports = { handleHistoryApi, matchHistory, publicVersion, publicCoverage }
