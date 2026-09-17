const { safeRoomKey, sendJson, readBody, getPool } = require('../storage')
const { bodyLimitForPath } = require('../rateLimit')
const store = require('./store')
const { MAX_BYTES, attachmentResponseHeaders } = require('./limits')
const binary = require('./binary')
const tus = require('./tus')
const roomAcl = require('../roomAcl')

// 旧版 JSON/base64 仍保留给知识补齐。二进制附件按原文件大小限制。
const MAX_JSON_UPLOAD_BODY_BYTES = Math.min(
  32 * 1024 * 1024,
  Math.ceil((MAX_BYTES * 4) / 3) + 512 * 1024
)

function matchAttachments(pathname) {
  const m = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/attachments(?:\/([^/]+))?(?:\/(content|text))?$/
  )
  if (!m) return null
  return {
    roomKey: decodeURIComponent(m[1]),
    id: m[2] ? decodeURIComponent(m[2]) : '',
    sub: m[3] || ''
  }
}

function searchParamsOf(req, options) {
  if (options && options.url && options.url.searchParams) {
    return options.url.searchParams
  }
  const query = String((req && req.url) || '').split('?')[1] || ''
  return new URLSearchParams(query)
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
  if (tus.isTusPath(pathname)) {
    try {
      return await tus.handleTus(req, res, {
        pathname,
        db: options.db || getPool(),
        hit: tus.matchTus(pathname)
      })
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, err.statusCode || err.status_code || 400, {
          ok: false,
          error: err.message || 'node knowledge error',
          code: err.code || 'NODE_KNOWLEDGE_ERROR'
        })
      }
      return true
    }
  }
  const attachmentHit = matchAttachments(pathname)
  const ensureHit = matchEnsure(pathname)
  if (!attachmentHit && !ensureHit) return false

  const db = options.db || getPool()
  const actor = (req && req.authUser) || {}

  try {
    if (ensureHit && req.method === 'POST') {
      const roomKey = safeRoomKey(ensureHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'edit')
      const body = await readBody(req, {
        maxBytes: Math.max(bodyLimitForPath(pathname), MAX_JSON_UPLOAD_BODY_BYTES)
      })
      const sources = Array.isArray(body.sources) ? body.sources.slice(0, 12) : []
      const results = await store.ensureSources(db, roomKey, sources, actor)
      sendJson(res, 200, { ok: true, sources: results })
      return true
    }

    if (attachmentHit && !attachmentHit.id && req.method === 'POST') {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'edit')
      const saved = binary.isBinaryAttachmentUpload(req)
        ? await store.ingestBinaryRequest(db, roomKey, req, actor)
        : await store.ingestUpload(
            db,
            roomKey,
            (await readBody(req, {
              maxBytes: Math.max(
                bodyLimitForPath(pathname),
                MAX_JSON_UPLOAD_BODY_BYTES
              )
            })) || {},
            actor
          )
      sendJson(res, saved.deduped ? 200 : 201, { ok: true, attachment: saved })
      return true
    }

    if (attachmentHit && !attachmentHit.id && req.method === 'GET') {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'view')
      const params = searchParamsOf(req, options)
      const list = await store.listMeta(db, roomKey, {
        nodeUid: params.get('node_uid') || params.get('nodeUid') || '',
        ids: String(params.get('ids') || '')
          .split(',')
          .map(id => id.trim())
          .filter(Boolean),
        limit: params.get('limit')
      })
      sendJson(res, 200, {
        ok: true,
        room_key: roomKey,
        attachments: list,
        total: list.length
      })
      return true
    }

    if (
      attachmentHit &&
      attachmentHit.id &&
      attachmentHit.sub === 'text' &&
      req.method === 'GET'
    ) {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'view')
      const params = searchParamsOf(req, options)
      const slice = await store.getTextSlice(db, roomKey, attachmentHit.id, {
        offset: params.get('offset'),
        limit: params.get('limit')
      })
      if (!slice) {
        sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
        return true
      }
      sendJson(res, 200, { ok: true, room_key: roomKey, ...slice })
      return true
    }

    if (
      attachmentHit &&
      attachmentHit.id &&
      attachmentHit.sub === 'content' &&
      req.method === 'GET'
    ) {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'view')
      const content = await store.getContentById(db, roomKey, attachmentHit.id)
      if (!content) {
        sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
        return true
      }
      const item = content.attachment
      res.writeHead(200, {
        ...attachmentResponseHeaders(item.fileName || 'attachment'),
        'Content-Length': content.buffer.length,
      })
      res.end(content.buffer)
      return true
    }

    if (
      attachmentHit &&
      attachmentHit.id &&
      !attachmentHit.sub &&
      req.method === 'GET'
    ) {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'view')
      const row = await store.getById(db, roomKey, attachmentHit.id)
      if (!row) {
        sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
        return true
      }
      sendJson(res, 200, { ok: true, attachment: row })
      return true
    }

    if (
      attachmentHit &&
      attachmentHit.id &&
      !attachmentHit.sub &&
      req.method === 'POST'
    ) {
      const roomKey = safeRoomKey(attachmentHit.roomKey)
      await roomAcl.assertRoomAccess(db, req, roomKey, 'edit')
      const row = await store.reextractStored(db, roomKey, attachmentHit.id)
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
  matchEnsure,
  isBinaryAttachmentUpload: binary.isBinaryAttachmentUpload,
  isTusPath: tus.isTusPath,
  matchTus: tus.matchTus
}
