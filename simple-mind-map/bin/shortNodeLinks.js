const crypto = require('crypto')

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code })
}

// A short link is a stable locator, never an access grant. Both creation and
// resolution check the recipient's current room ACL and the live target node.
function createShortNodeLinks({ pool, assertAccess, resolveRef, randomCode = () => crypto.randomBytes(9).toString('base64url') }) {
  let ready
  function ensureSchema() {
    if (!ready) {
      ready = pool.query(`create table if not exists node_short_links (
        code varchar(12) primary key,
        room_key text not null,
        node_uid text not null,
        created_at timestamptz not null default now(),
        unique (room_key, node_uid)
      )`).catch(error => { ready = null; throw error })
    }
    return ready
  }
  async function checkTarget(req, roomKey, uid) {
    await assertAccess(req, roomKey)
    const target = await resolveRef(roomKey, uid)
    if (target && target.error) fail(503, 'UNAVAILABLE', '暂时无法读取节点，请稍后重试')
    if (!target || !target.exists || !target.nodeExists) fail(404, 'NOT_FOUND', '节点已删除或不存在')
    return { roomKey, uid, text: target.nodeText || '' }
  }
  return {
    async create(req, body = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'BAD_REQUEST', '请求格式无效')
      const roomKey = typeof body.roomKey === 'string' ? body.roomKey.trim() : ''
      const uid = typeof body.uid === 'string' ? body.uid.trim() : ''
      if (!roomKey || !uid || roomKey.length > 255 || uid.length > 255) fail(400, 'BAD_REQUEST', '缺少有效的脑图或节点 ID')
      await checkTarget(req, roomKey, uid)
      await ensureSchema()
      const existing = await pool.query('select code from node_short_links where room_key = $1 and node_uid = $2', [roomKey, uid])
      if (existing.rows.length) return { code: existing.rows[0].code }
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const result = await pool.query(`insert into node_short_links (code, room_key, node_uid)
            values ($1, $2, $3) on conflict (room_key, node_uid)
            do update set room_key = excluded.room_key returning code`, [randomCode(), roomKey, uid])
          return { code: result.rows[0].code }
        } catch (error) {
          if (error.code !== '23505') throw error
        }
      }
      fail(503, 'UNAVAILABLE', '暂时无法生成链接，请稍后重试')
    },
    async resolve(req, code) {
      if (!/^[A-Za-z0-9_-]{12}$/.test(code)) fail(404, 'NOT_FOUND', '链接不存在')
      await ensureSchema()
      const result = await pool.query('select room_key, node_uid from node_short_links where code = $1', [code])
      if (!result.rows.length) fail(404, 'NOT_FOUND', '链接不存在')
      const row = result.rows[0]
      return checkTarget(req, row.room_key, row.node_uid)
    }
  }
}

let service
async function handleShortNodeLinkApi(req, res, pathname) {
  const base = '/api/node-links'
  if (pathname !== base && !pathname.startsWith(base + '/')) return false
  const { getPool, getRoomRef, sendJson, readBody } = require('./storage')
  if (!service) {
    const { assertRoomAccess } = require('./roomAcl')
    service = createShortNodeLinks({ pool: getPool(), resolveRef: getRoomRef,
      assertAccess: (request, roomKey) => assertRoomAccess(getPool(), request, roomKey, 'view') })
  }
  try {
    let result
    if (pathname === base && req.method === 'POST') result = await service.create(req, await readBody(req))
    else if (req.method === 'GET' && pathname.startsWith(base + '/')) result = await service.resolve(req, pathname.slice(base.length + 1))
    else { sendJson(res, 405, { error: '不支持此操作' }); return true }
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : '链接服务暂时不可用', code: error.code || 'INTERNAL_ERROR' })
  }
  return true
}

module.exports = { createShortNodeLinks, handleShortNodeLinkApi }
