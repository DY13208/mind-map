const crypto = require('crypto')
const { issueMcpUserToken } = require('./mcpUserToken')

const BASE = '/api/mcp-config/device'
const TTL = 5 * 60 * 1000

function send(res, status, body, html = false) {
  res.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
  })
  res.end(html ? body : JSON.stringify(body))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString('utf8')
    if (Buffer.byteLength(raw) > 4096) throw new Error('invalid_body')
  }
  return String(req.headers['content-type'] || '').includes('application/json')
    ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw))
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Requests intentionally expire on restart. Run behind one collab instance (or sticky routing).
function createMcpDeviceConfigHandler({ authenticateRequest, now = Date.now, secret = () => process.env.MCP_TOKEN } = {}) {
  const requests = new Map()
  const rates = new Map()
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (![BASE, `${BASE}/authorize`, `${BASE}/poll`].includes(url.pathname)) return false
    const time = now()
    for (const [id, item] of requests) if (item.expires <= time) requests.delete(id)
    for (const [ip, item] of rates) if (item.until <= time) rates.delete(ip)
    const error = (status, code) => send(res, status, { error: code })
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim()
    const origin = new URL(`${proto}://${host}`).origin
    if (url.pathname === BASE && req.method === 'POST') {
      if (!String(secret() || '').trim()) { error(503, 'mcp_token_missing'); return true }
      const ip = req.socket.remoteAddress
      const rate = rates.get(ip) || { count: 0, until: time + 60000 }
      if (requests.size >= 1000 || rates.size >= 1000 || rate.count >= 20) {
        error(429, 'too_many_requests'); return true
      }
      rate.count += 1
      rates.set(ip, rate)
      const id = crypto.randomBytes(24).toString('base64url')
      const deviceCode = crypto.randomBytes(32).toString('base64url')
      const userCode = crypto.randomBytes(4).toString('hex').toUpperCase()
      requests.set(id, { deviceHash: crypto.createHash('sha256').update(deviceCode).digest('hex'), userCode, expires: time + TTL, origin, lastPoll: 0 })
      send(res, 201, {
        device_code: deviceCode, user_code: userCode,
        verification_uri: `${origin}${BASE}/authorize?request_id=${id}`,
        poll_uri: `${origin}${BASE}/poll`, expires_in: TTL / 1000, interval: 3
      })
      return true
    }
    if (url.pathname === `${BASE}/poll` && req.method === 'POST') {
      let data
      try { data = await body(req) } catch (_) { error(400, 'invalid_body'); return true }
      const hash = crypto.createHash('sha256').update(String(data.device_code || '')).digest('hex')
      const entry = [...requests].find(([, item]) => item.deviceHash === hash)
      if (!entry) { error(400, 'invalid_or_expired_code'); return true }
      const [id, item] = entry
      if (item.lastPoll && time - item.lastPoll < 3000) { error(429, 'slow_down'); return true }
      item.lastPoll = time
      if (!item.userId) { error(202, 'authorization_pending'); return true }
      if (!String(secret() || '').trim()) { error(503, 'mcp_token_missing'); return true }
      const token = issueMcpUserToken(item.userId, secret())
      requests.delete(id)
      send(res, 200, { mcpServers: { 'mind-map': {
        type: 'http', url: `${item.origin}/mcp`, disabled: false,
        headers: { Authorization: `Bearer ${token}` }
      } } })
      return true
    }
    if (url.pathname === `${BASE}/authorize` && ['GET', 'POST'].includes(req.method)) {
      const id = url.searchParams.get('request_id')
      const item = requests.get(id)
      if (!item) { error(400, 'invalid_or_expired_code'); return true }
      const user = await authenticateRequest(req)
      if (item.expires <= now() || requests.get(id) !== item) {
        error(400, 'invalid_or_expired_code'); return true
      }
      if (!user) {
        res.writeHead(302, { Location: `/api/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
        res.end(); return true
      }
      if (!user.id || user.service) { error(403, 'forbidden'); return true }
      if (req.method === 'POST') {
        let data
        try { data = await body(req) } catch (_) { error(400, 'invalid_body'); return true }
        if (item.userId || item.confirmUser !== String(user.id) || !item.nonce || data.nonce !== item.nonce) {
          error(403, 'invalid_confirmation'); return true
        }
        item.userId = String(user.id)
        delete item.nonce
        send(res, 200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权完成</title><h1>授权完成</h1><p>请返回 WorkBuddy，它将领取个人 MCP 配置。你可以关闭此页面。</p></html>', true)
        return true
      }
      if (item.userId) { error(409, 'already_authorized'); return true }
      item.nonce = crypto.randomBytes(24).toString('base64url')
      item.confirmUser = String(user.id)
      send(res, 200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 WorkBuddy</title><h1>授权 WorkBuddy 接入 mind-map</h1><p>当前账号：${escape(user.name || user.id)}</p><p>请核对 WorkBuddy 提供的确认码：<strong>${item.userCode}</strong></p><p>确认后，发起请求的客户端将获得你的个人 MCP 密钥，可按你的现有权限访问和编辑脑图。仅在你本人发起接入时确认。</p><form method="post" action="${BASE}/authorize?request_id=${id}"><input type="hidden" name="nonce" value="${item.nonce}"><button type="submit">确认授权</button></form></html>`, true)
      return true
    }
    error(405, 'method_not_allowed')
    return true
  }
}

module.exports = { createMcpDeviceConfigHandler }
