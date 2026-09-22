const { sendJson, readBody, getPool } = require('../storage')
const store = require('./store')

async function handleApi(req, res, options = {}) {
  const pathname =
    options.pathname || String((req.url || '').split('?')[0] || '')
  if (!pathname.startsWith('/api/chat')) return false

  const db = options.db || getPool()

  try {
    const actor = store.actorFromReq(req)

    if (
      (pathname === '/api/chat/conversations' ||
        pathname === '/api/chat/state') &&
      req.method === 'GET'
    ) {
      const state = await store.listConversations(db, actor)
      sendJson(res, 200, { ok: true, ...state })
      return true
    }

    if (
      (pathname === '/api/chat/conversations' ||
        pathname === '/api/chat/state') &&
      req.method === 'PUT'
    ) {
      const body = await readBody(req).catch(() => ({}))
      const state = await store.replaceConversations(db, actor, body || {})
      sendJson(res, 200, { ok: true, ...state })
      return true
    }
  } catch (err) {
    sendJson(res, err.statusCode || 400, {
      ok: false,
      error: err.message || 'chat error',
      code: err.code || 'CHAT_ERROR'
    })
    return true
  }

  sendJson(res, 405, {
    ok: false,
    error: 'method not allowed',
    code: 'METHOD_NOT_ALLOWED'
  })
  return true
}

module.exports = {
  handleApi
}
