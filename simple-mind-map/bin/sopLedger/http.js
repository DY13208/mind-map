const { safeRoomKey, sendJson, readBody, getPool } = require('../storage')
const store = require('./store')

async function handleApi(req, res, options = {}) {
  const pathname =
    options.pathname || String((req.url || '').split('?')[0] || '')
  if (!pathname.startsWith('/api/sop-ledger')) return false

  const db = options.db || getPool()
  const url =
    options.url ||
    new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  try {
    if (pathname === '/api/sop-ledger' && req.method === 'GET') {
      const roomKey = String(url.searchParams.get('roomKey') || '').trim()
      const q = String(url.searchParams.get('q') || '').trim()
      const limit = url.searchParams.get('limit')
      const list = await store.listDefinitions(db, { roomKey, q, limit })
      sendJson(res, 200, { ok: true, list })
      return true
    }

    const detailMatch = pathname.match(
      /^\/api\/sop-ledger\/([^/]+)\/nodes\/([^/]+)$/
    )
    if (detailMatch && req.method === 'GET') {
      const roomKey = safeRoomKey(decodeURIComponent(detailMatch[1]))
      const nodeUid = decodeURIComponent(detailMatch[2])
      const detail = await store.getDefinitionDetail(db, roomKey, nodeUid)
      if (!detail) {
        sendJson(res, 404, { ok: false, error: 'SOP 台账不存在', code: 'NOT_FOUND' })
        return true
      }
      sendJson(res, 200, { ok: true, sop: detail })
      return true
    }

    if (pathname === '/api/sop-ledger/backfill' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      const roomKey = safeRoomKey(
        body.roomKey || url.searchParams.get('roomKey') || ''
      )
      const storage = require('../storage')
      const table = await storage.readRoomNodes(roomKey)
      const nodes =
        (table && table.nodes) ||
        (table && table.graph) ||
        (table && typeof table === 'object' && !table.version ? table : null)
      let graph = nodes
      if (!graph || !Object.keys(graph).length) {
        const snap = await storage.getRoomSnapshot(roomKey)
        graph = snap && snap.nodes
      }
      if (!graph || !Object.keys(graph).length) {
        sendJson(res, 404, { ok: false, error: '房间不存在或无节点', code: 'NOT_FOUND' })
        return true
      }
      const result = await store.backfillRoom(db, roomKey, graph)
      sendJson(res, 200, { ok: true, ...result })
      return true
    }
  } catch (err) {
    sendJson(res, err.statusCode || 400, {
      ok: false,
      error: err.message || 'sop ledger error',
      code: err.code || 'SOP_LEDGER_ERROR'
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
