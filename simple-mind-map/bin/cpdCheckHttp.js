function fail(code, message, statusCode = 400) {
  throw Object.assign(new Error(message), { code, statusCode })
}
function createCheckHttp(options) {
  const { getPool, loadSnapshot, readBody, sendJson, roomAcl } = options
  const service = () => options.service || require('./checkRuns')
  const providers = () => options.providers || require('./checkRuns/providers')
  function actor(req) { return req.authUser || { id: 'anonymous', name: 'anonymous' } }
  function deps(req, signal) {
    const db = getPool()
    const user = actor(req)
    const providerModule = providers()
    const providerApi = typeof providerModule.createCheckProviders === 'function'
      ? providerModule.createCheckProviders({ db, signal }) : providerModule
    const readSource = async args => {
        const ref = args.sourceRef
        if (ref && (ref.type === 'attachment' || ref.kind === 'attachment')) {
          const roomKey = args.roomKey
          if (ref.roomKey && ref.roomKey !== roomKey) fail('SOURCE_ROOM_MISMATCH', '材料不属于当前脑图', 403)
          const result = await db.query(
            `select id, node_uid, file_name, content_hash, status, updated_at,
                    char_length(extracted_text) as total_chars,
                    substr(extracted_text, 1, 200001) as content,
                    least(char_length(extracted_text), 200001) as read_chars
             from node_attachments where room_key = $1 and id = $2`, [roomKey, ref.id]
          )
          const row = result.rows[0]
          if (!row) return { status: 'not_found', sourceRef: ref, complete: false }
          return attachmentSource(row, roomKey, ref.nodeUid || row.node_uid)
        }
        return providerApi.readSource({ ...args, db, actor: user })
    }
    return {
      db,
      loadSnapshot,
      searchSources: args => providerApi.searchSources({ ...args, db, actor: user }),
      readSource
    }
  }
  return async function handleCheckHttp(req, res, context = {}) {
    const url = context.url || new URL(req.url, 'http://127.0.0.1')
    const pathname = context.pathname || url.pathname
    const match = pathname.match(/^\/api\/files\/([^/]+)\/cpd-checks(?:\/([^/]+)(?:\/(confirm|reviews|sources)(?:\/([^/]+)(?:\/(retry))?)?)?)?$/)
    if (!match) return false
    try {
      const roomKey = decodeURIComponent(match[1])
      await roomAcl.assertRoomAccess(getPool(), req, roomKey, req.method === 'GET' ? 'view' : 'edit')
      const api = service()
      const controller = new AbortController()
      if (typeof req.once === 'function') req.once('aborted', () => controller.abort())
      if (typeof res.once === 'function') res.once('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      const dependencies = deps(req, controller.signal)
      if (!match[2] && req.method === 'POST') {
        if (options.assertRateLimit) options.assertRateLimit(roomKey)
        const body = await readBody(req)
        const run = await api.createCheck({ roomKey, nodeUid: body.nodeUid, requestId: body.requestId, mode: body.mode, actor: actor(req) }, dependencies)
        sendJson(res, 200, { ok: true, run })
      } else if (!match[2] && req.method === 'GET') {
        const runs = await api.listChecks({ roomKey, nodeUid: url.searchParams.get('nodeUid') || '', limit: 30 }, dependencies)
        sendJson(res, 200, { ok: true, runs })
      } else if (match[3] === 'confirm' && !match[4] && req.method === 'POST') {
        if (options.assertRateLimit) options.assertRateLimit(roomKey)
        const body = await readBody(req)
        const run = await api.confirmCheck({ roomKey, runId: decodeURIComponent(match[2]), candidateId: body.candidateId, actor: actor(req) }, dependencies)
        sendJson(res, 200, { ok: true, run })
      } else if (match[3] === 'reviews' && !match[4] && req.method === 'POST') {
        if (options.assertRateLimit) options.assertRateLimit(roomKey)
        const body = await readBody(req)
        const run = await api.reviewCheck({ roomKey, runId: decodeURIComponent(match[2]), actor: actor(req), requestId: body.requestId, expectedRevision: body.expectedRevision, findingKey: body.findingKey, decision: body.decision, reason: body.reason, evidenceIds: body.evidenceIds }, dependencies)
        sendJson(res, 200, { ok: true, run })
      } else if (match[3] === 'sources' && match[4] && !match[5] && req.method === 'GET') {
        const source = await api.getCheckSource({ roomKey, runId: decodeURIComponent(match[2]), sourceId: decodeURIComponent(match[4]), actor: actor(req) }, dependencies)
        sendJson(res, 200, { ok: true, source })
      } else if (match[3] === 'sources' && match[4] && match[5] === 'retry' && req.method === 'POST') {
        if (options.assertRateLimit) options.assertRateLimit(roomKey)
        const body = await readBody(req)
        const run = await api.retryCheckSource({ roomKey, runId: decodeURIComponent(match[2]), sourceId: decodeURIComponent(match[4]), actor: actor(req), requestId: body.requestId, expectedRevision: body.expectedRevision }, dependencies)
        sendJson(res, 200, { ok: true, run })
      } else if (match[2] && !match[3] && req.method === 'GET') {
        const run = await api.getCheck({ roomKey, runId: decodeURIComponent(match[2]), actor: actor(req) }, dependencies)
        if (!run) fail('CHECK_NOT_FOUND', '检查记录不存在', 404)
        sendJson(res, 200, { ok: true, run })
      } else fail('METHOD_NOT_ALLOWED', '不支持此请求方式', 405)
    } catch (err) {
      sendJson(res, err.statusCode || err.status || 400, { ok: false, code: err.code || 'CPD_CHECK_ERROR', error: err.message || '检查失败' })
    }
    return true
  }
}
function attachmentSource(row, roomKey, bindingNodeUid = row.node_uid) {
  const updated = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
  const content = String(row.content || '')
  const readChars = row.read_chars == null ? Array.from(content).length : Number(row.read_chars)
  const truncated = Number(row.total_chars || 0) > 200000 || content.length > 200000 || readChars < Number(row.total_chars || 0)
  return {
    nodeUid: bindingNodeUid || '',
    sourceRef: { type: 'attachment', roomKey, id: row.id, nodeUid: bindingNodeUid },
    title: row.file_name || row.id, source: 'attachment',
    content: content.slice(0, 200000),
    status: row.status === 'ready' ? 'ok' : row.status,
    version: `${row.content_hash || ''}:${updated}:${row.status}:${row.total_chars || 0}`,
    complete: row.status === 'ready' && !truncated,
    truncated
  }
}
module.exports = { createCheckHttp, attachmentSource }
