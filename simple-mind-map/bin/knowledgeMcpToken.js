const crypto = require('crypto')

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Issue a Knowledge MCP (Wiki) JWT for the logged-in mind-map user.
 * Deterministic static token (v2): no exp; invalidated only by rotating
 * KNOWLEDGE_MCP_JWT_SECRET. Same verify path as knowledge-mcp auth.
 */
function issueKnowledgeMcpToken(userId, env = process.env) {
  const secret = String(env.KNOWLEDGE_MCP_JWT_SECRET || '').trim()
  const uid = String(userId || '').trim().slice(0, 160)
  if (!secret || !uid) return ''

  const iss = String(env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce').trim()
  const aud = String(env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp').trim()
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    v: 2,
    sub: uid,
    actorType: 'user',
    iss,
    aud,
    tokenUse: 'static'
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
