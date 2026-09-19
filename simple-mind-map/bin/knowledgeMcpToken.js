const crypto = require('crypto')

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Issue a Knowledge MCP (Wiki) JWT for the logged-in mind-map user.
 * Same shape as scripts/wiki-mcp-token.js / knowledge-mcp auth.
 */
function issueKnowledgeMcpToken(userId, env = process.env) {
  const secret = String(env.KNOWLEDGE_MCP_JWT_SECRET || '').trim()
  const uid = String(userId || '').trim().slice(0, 160)
  if (!secret || !uid) return ''

  const ttlSec = Number(env.KNOWLEDGE_MCP_JWT_TTL_SEC || 7776000)
  const iss = String(env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce').trim()
  const aud = String(env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp').trim()
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: uid,
    actorType: 'user',
    iss,
    aud,
    iat: now,
    exp: now + (Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 7776000),
    jti: crypto.randomUUID()
  }
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}

function knowledgeMcpConfigured(env = process.env) {
  return Boolean(String(env.KNOWLEDGE_MCP_JWT_SECRET || '').trim())
}

module.exports = {
  issueKnowledgeMcpToken,
  knowledgeMcpConfigured
}
