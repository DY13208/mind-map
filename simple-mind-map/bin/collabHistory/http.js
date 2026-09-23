const { sendJson, readBody, safeRoomKey } = require('../storage')
const { getHistoryEngine } = require('./index')
const { localizeGeneratedVersionName } = require('./versionTime')

function summaryText(summary, status) {
  if (status === 'pending' && (!summary || !summary.kind || summary.kind === 'edits')) {
    return '整理中'
  }
  const kind = summary && summary.kind
  if (kind === 'import') return '由导入生成'
  if (kind === 'restore') return '从历史版本恢复'
  if (kind === 'pre_restore') return '恢复前自动备份'
  if (kind === 'legacy') return '旧版快照'
  if (kind === 'initial') return '新建时的初始版本'
  if (!summary) return ''
  return `新增 ${summary.inserted || 0} · 修改 ${summary.updated || 0} · 删除 ${
    summary.deleted || 0
  } · 移动 ${summary.moved || 0}`
}

function publicVersion(row, access = {}) {
  if (!row) return null
  const revision = row.revision == null || row.revision === '' ? null : Number(row.revision)
  const editors = Array.isArray(row.editors)
    ? row.editors.map(item =>
        item && typeof item === 'object'
          ? { userId: item.userId || item.user_id || '', name: item.name || item.userId || '' }
          : { userId: String(item), name: String(item) }
      )
    : []
  const availability = row.availability || 'readable'
  const canManage = !!(access.canManage || access.role === 'owner')
  return {
    versionId: row.id || row.versionId,
    revision,
    checkpointRevision: Number(row.checkpoint_revision || 0),
    name: localizeGeneratedVersionName(row) || row.name || '',
    type: row.type,
    createdBy: row.created_by_name || row.created_by || '',
    createdById: row.created_by || '',
    createdAt: row.created_at,
    description: row.description || '',
    source: row.source || '',
    sourceKind: row.source_kind || row.sourceKind || '',
    editors,
    summary: row.summary || {},
    summaryStatus: row.summary_status || row.summaryStatus || 'pending',
    summaryText: summaryText(row.summary, row.summary_status || row.summaryStatus),
    availability,
    readOnly: true,
    capabilities: {
      canRestore: canManage && availability !== 'unreadable',
      canCreate: !!(access.canEdit || canManage)
    }
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

function accessOf(req) {
  return req.roomAccess || {}
}

function treeUnavailableMessage(error) {
  const code = error && error.code
  if (code === 'HISTORY_OPS_GAP' || code === 'HISTORY_REPLAY_FAILED') {
    return '该历史版本不完整，无法预览'
  }
  if (code === 'HISTORY_REVISION_UNAVAILABLE') {
    return '该历史版本的资源已不可用'
  }
  if (code === 'CHECKPOINT_CORRUPTED' || code === 'HISTORY_REPLAY_UNSUPPORTED') {
    return '该历史版本加载失败'
  }
  return error && error.message
}

async function handleHistoryApi(req, res, options = {}) {
  const url = options.url || new URL(req.url, 'http://127.0.0.1')
  const match = matchHistory(url.pathname)
  if (!match) return false
  const engine = options.engine || getHistoryEngine()
  if (!engine) {
    sendJson(res, 503, {
      ok: false,
      code: 'HISTORY_UNAVAILABLE',
      error: 'history engine not ready'
    })
    return true
  }
  const roomKey = safeRoomKey(decodeURIComponent(match[1]))
  const versionId = match[2] || ''
  const tail = match[3] || ''
  const method = String(req.method || 'GET').toUpperCase()
  const access = accessOf(req)
  const userId = access.userId || (req.authUser && req.authUser.id) || ''
  try {
    if (method === 'GET' && !versionId) {
      if (!url.searchParams.get('cursor') && engine.flushPendingAutoVersion) {
        try {
          await engine.flushPendingAutoVersion(roomKey, {
            userId,
            source: 'history_open'
          })
        } catch (err) {
          console.error('[history] flush', err && err.message)
        }
      }
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
        readOnly: true,
        versions: (listed.versions || []).map(row => publicVersion(row, access)),
        nextCursor: listed.nextCursor || null,
        ...publicCoverage(listed)
      })
      return true
    }
    if (method === 'POST' && !versionId) {
      const body = options.body || (await readBody(req))
      const row = await engine.createVersion(roomKey, {
        name: body.name,
        description: body.description,
        type: 'MANUAL',
        createdBy: userId,
        source: 'manual',
        source_kind: 'manual'
      })
      const coverage = await engine.getHistoryCoverage(roomKey)
      sendJson(res, 201, {
        ok: true,
        version: publicVersion(row, access),
        ...publicCoverage(coverage)
      })
      return true
    }
    if (method === 'POST' && versionId === 'auto-flush' && !tail) {
      const row = await engine.flushPendingAutoVersion(roomKey, { userId, source: 'pre_insert' })
      const coverage = await engine.getHistoryCoverage(roomKey)
      sendJson(res, 200, { ok: true, flushed: !!row, version: row ? publicVersion(row, access) : null, ...publicCoverage(coverage) })
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
      const presented = engine.presentVersions
        ? (await engine.presentVersions([row]))[0]
        : row
      sendJson(res, 200, {
        ok: true,
        viewingHistory: true,
        readOnly: true,
        version: publicVersion(presented || row, access),
        ...publicCoverage(coverage)
      })
      return true
    }
    if (method === 'GET' && tail === 'tree') {
      const state = await engine.getVersionTree(roomKey, versionId)
      sendJson(res, 200, {
        ok: true,
        viewingHistory: true,
        readOnly: true,
        mutable: false,
        version: publicVersion(state.version, access),
        revision: state.revision,
        metadata: state.metadata,
        tree: state.tree,
        checksum: state.checksum,
        summary: state.summary,
        ...publicCoverage(state)
      })
      return true
    }
    if (method === 'POST' && tail === 'restore') {
      const body = options.body || (await readBody(req).catch(() => ({})))
      const headerKey =
        req.headers &&
        (req.headers['idempotency-key'] || req.headers['Idempotency-Key'])
      const result = await engine.restoreVersion(roomKey, {
        versionId,
        expectedCurrentRevision: body.expectedCurrentRevision,
        userId,
        clientId: body.clientId,
        name: body.name,
        description: body.description,
        idempotencyKey: body.idempotencyKey || headerKey || ''
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
      const hidden = await engine.hideVersion(roomKey, versionId, userId)
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
      error: treeUnavailableMessage(error) || error.message
    })
    return true
  }
}

module.exports = {
  handleHistoryApi,
  matchHistory,
  publicVersion,
  publicCoverage,
  summaryText
}
