const crypto = require('crypto')

const PREFIX = 'mmcp_v1'

function secret(value = process.env.MCP_TOKEN) {
  return String(value || '').trim()
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function sign(payload, value) {
  return crypto.createHmac('sha256', value).update(payload).digest('base64url')
}

function issueMcpUserToken(userId, value = process.env.MCP_TOKEN) {
  const key = secret(value)
  const uid = String(userId || '')
    .trim()
    .slice(0, 160)
  if (!key || !uid) throw new Error('MCP token secret and user id are required')
  const payload = encode(JSON.stringify({ v: 1, uid }))
  return `${PREFIX}.${payload}.${sign(payload, key)}`
}

function verifyMcpUserToken(token, value = process.env.MCP_TOKEN) {
  const key = secret(value)
  const parts = String(token || '').split('.')
  if (!key || parts.length !== 3 || parts[0] !== PREFIX) return null
  const expected = sign(parts[1], key)
  const actualBuffer = Buffer.from(parts[2])
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null
  }
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const uid = String((data && data.uid) || '')
      .trim()
      .slice(0, 160)
    return data && data.v === 1 && uid ? { userId: uid } : null
  } catch (error) {
    return null
  }
}

function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

module.exports = { issueMcpUserToken, verifyMcpUserToken, bearerToken }
