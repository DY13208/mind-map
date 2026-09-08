const { safeRoomKey, sendJson, readBody, getPool } = require('../storage')
const { bodyLimitForPath } = require('../rateLimit')
const store = require('./store')
const { MAX_BYTES } = require('./limits')

function matchAttachments(pathname) {
  const m = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/attachments(?:\/([^/]+))?$/
  )
  if (!m) return null
  return {
    roomKey: decodeURIComponent(m[1]),
    id: m[2] ? decodeURIComponent(m[2]) : ''
  }
}

function matchEnsure(pathname) {
  const m = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/knowledge\/ensure$/
  )
  if (!m) return null
  return { roomKey: decodeURIComponent(m[1]) }
}

async function handleApi(req, res, options = {}) {
  const pathname =
    options.pathname ||
    String((req.url || '').split('?')[0] || '')
  const attachmentHit = matchAttachments(pathname)
  const ensureHit = matchEnsure(pathname)
  if (!attachmentHit && !ensureHit) return false

  const db = options.db || getPool()
  const actor = (req && req.authUser) || {}

  try {
    if (ensureHit && req.method === 'POST') {
      const roomKey = safeRoomKey(ensureHit.roomKey)
      const body = await readBody(req, {
        maxBytes: Math.max(bodyLimitForPath(pathname), MAX_BYTES + 512 * 1024)
      })
      const sources = Array.isArray(body.sources) ? body.sources.slice(0, 12) : []
      const results = await store.ensureSources(db, roomKey, sources, actor)
      sendJson(res, 200, { ok: true, sources: results })
      return true
    }

    if (attachmentHit && !attachmentHit.id && req.method === 'POST') {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      const body = await readBody(req, {
        maxBytes: Math.max(bodyLimitForPath(pathname), MAX_BYTES + 512 * 1024)
      })
      const saved = await store.ingestUpload(db, roomKey, body || {}, actor)
      sendJson(res, saved.deduped ? 200 : 201, { ok: true, attachment: saved })
      return true
    }

    if (attachmentHit && attachmentHit.id && req.method === 'GET') {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      const row = await store.getById(db, roomKey, attachmentHit.id)
      if (!row) {
        sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
        return true
      }
      sendJson(res, 200, { ok: true, attachment: row })
      return true
    }

    if (attachmentHit && attachmentHit.id && req.method === 'POST') {
      // Re-fetch metadata only; re-extract requires content upload again.
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      const row = await store.getById(db, roomKey, attachmentHit.id)
      if (!row) {
        sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
        return true
      }
      sendJson(res, 200, { ok: true, attachment: row })
      return true
    }
  } catch (err) {
    sendJson(res, err.statusCode || 400, {
      ok: false,
      error: err.message || 'node knowledge error',
      code: err.code || 'NODE_KNOWLEDGE_ERROR'
    })
    return true
  }

  sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' })
  return true
}

module.exports = {
  handleApi,
  matchAttachments,
  matchEnsure
}
