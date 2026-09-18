/**
 * POST /api/openclaw/handoff
 * Authenticated Mind Map user → short-lived Signed Handoff for OpenClaw Liangce ingress.
 */
const { issueOpenclawHandoff, readConfig } = require('./openclawHandoff')
const { applyCorsHeaders } = require('./auth')

function sendJson(req, res, status, body) {
  applyCorsHeaders(req, res)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {object|null} user - from requireAuthenticatedRequest
 */
async function handleOpenclawHandoffApi(req, res, pathname, user) {
  if (pathname === '/api/openclaw/handoff/status' && req.method === 'GET') {
    const cfg = readConfig()
    sendJson(req, res, 200, {
      configured: cfg.configured,
      ttlSec: cfg.ttlSec
    })
    return true
  }
  if (pathname !== '/api/openclaw/handoff' || req.method !== 'POST') return false
  if (!user) {
    sendJson(req, res, 401, { error: '未登录', code: 'unauthorized' })
    return true
  }
  let body = {}
  try {
    body = await readJsonBody(req)
  } catch (_) {
    sendJson(req, res, 400, { error: '请求体格式错误', code: 'invalid_body' })
    return true
  }
  try {
    const issued = issueOpenclawHandoff(user, {
      conversationId: body.conversationId,
      sessionId: body.sessionId || user.sessionId
    })
    sendJson(req, res, 200, {
      handoff: issued.token,
      expiresAt: issued.expiresAt,
      requesterSenderId: issued.requesterSenderId,
      userId: issued.userId,
      conversationId: issued.conversationId
    })
  } catch (err) {
    sendJson(req, res, err.status || 500, {
      error: err.message || 'handoff failed',
      code: err.code || 'openclaw_handoff_error'
    })
  }
  return true
}

module.exports = { handleOpenclawHandoffApi }
