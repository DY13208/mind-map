/**
 * OpenClaw Liangce trusted identity handoff (Phase 2B-1).
 * Proves "this turn is from this logged-in Mind Map user".
 * Does NOT carry ACL/roles/room scopes.
 */
const crypto = require('crypto')

const ISS = 'mind-map'
const AUD = 'openclaw-liangce'
const TYP = 'openclaw_identity_handoff'
const DEFAULT_TTL_SEC = 180

function readConfig(env = process.env) {
  const secret = String(
    env.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
      env.AUTH_SESSION_SECRET ||
      ''
  ).trim()
  const ttlSec = Math.max(
    60,
    Math.min(300, Number(env.OPENCLAW_LIANGCE_HANDOFF_TTL_SEC || DEFAULT_TTL_SEC) || DEFAULT_TTL_SEC)
  )
  return {
    secret,
    ttlSec,
    configured: secret.length >= 32
  }
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signHs256(secret, data) {
  return b64url(crypto.createHmac('sha256', secret).update(data).digest())
}

/**
 * @param {object} user - authenticated Mind Map user
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {string} [opts.sessionId]
 * @param {NodeJS.ProcessEnv} [env]
 */
function issueOpenclawHandoff(user, opts = {}, env = process.env) {
  const cfg = readConfig(env)
  if (!cfg.configured) {
    const err = new Error('OpenClaw 身份交接未配置（缺少 OPENCLAW_LIANGCE_HANDOFF_SECRET）')
    err.code = 'openclaw_handoff_unavailable'
    err.status = 503
    throw err
  }
  const userId = String((user && (user.id || user.userId)) || '').trim()
  const wecomUserId = String(
    (user && (user.wecomUserId || user.wecom_userid || user.id)) || ''
  ).trim()
  const conversationId = String(opts.conversationId || '').trim()
  if (!userId) {
    const err = new Error('当前账号缺少稳定用户 ID')
    err.code = 'openclaw_identity_missing'
    err.status = 403
    throw err
  }
  if (!conversationId) {
    const err = new Error('缺少 conversationId')
    err.code = 'openclaw_conversation_missing'
    err.status = 400
    throw err
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    v: 1,
    typ: TYP,
    iss: ISS,
    aud: AUD,
    sub: userId,
    wecomUserId,
    sessionId: String(opts.sessionId || user.sessionId || '').trim() || undefined,
    conversationId,
    iat: now,
    exp: now + cfg.ttlSec,
    jti: crypto.randomBytes(16).toString('hex')
  }
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const body = b64urlJson(payload)
  const sig = signHs256(cfg.secret, `${header}.${body}`)
  return {
    token: `${header}.${body}.${sig}`,
    expiresAt: payload.exp,
    requesterSenderId: `liangce:${userId}`,
    userId,
    conversationId
  }
}

/**
 * Verify handoff JWT. Used by OpenClaw Liangce ingress (Node crypto).
 * @returns {object} payload
 */
function verifyOpenclawHandoff(token, opts = {}, env = process.env) {
  const cfg = readConfig(env)
  if (!cfg.configured) {
    const err = new Error('handoff secret not configured')
    err.code = 'openclaw_handoff_unavailable'
    throw err
  }
  const raw = String(token || '').trim()
  const parts = raw.split('.')
  if (parts.length !== 3) {
    const err = new Error('invalid handoff token')
    err.code = 'openclaw_handoff_invalid'
    throw err
  }
  const [header, body, sig] = parts
  const expected = signHs256(cfg.secret, `${header}.${body}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('handoff signature invalid')
    err.code = 'openclaw_handoff_bad_sig'
    throw err
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch (_) {
    const err = new Error('handoff payload invalid')
    err.code = 'openclaw_handoff_invalid'
    throw err
  }
  if (payload.typ !== TYP || payload.iss !== ISS || payload.aud !== AUD) {
    const err = new Error('handoff iss/aud/typ mismatch')
    err.code = 'openclaw_handoff_aud'
    throw err
  }
  const now = Math.floor(Date.now() / 1000)
  if (!payload.exp || now > Number(payload.exp)) {
    const err = new Error('handoff expired')
    err.code = 'openclaw_handoff_expired'
    throw err
  }
  if (!payload.iat || Number(payload.iat) > now + 60) {
    const err = new Error('handoff iat invalid')
    err.code = 'openclaw_handoff_iat'
    throw err
  }
  const sub = String(payload.sub || '').trim()
  if (!sub) {
    const err = new Error('handoff missing sub')
    err.code = 'openclaw_handoff_sub'
    throw err
  }
  if (opts.conversationId) {
    const expectedConv = String(opts.conversationId).trim()
    if (expectedConv && expectedConv !== String(payload.conversationId || '').trim()) {
      const err = new Error('handoff conversationId mismatch')
      err.code = 'openclaw_handoff_conversation'
      throw err
    }
  }
  // Replay: caller may pass seenJti Set
  if (opts.seenJti && typeof opts.seenJti.has === 'function') {
    const jti = String(payload.jti || '')
    if (!jti) {
      const err = new Error('handoff missing jti')
      err.code = 'openclaw_handoff_jti'
      throw err
    }
    if (opts.seenJti.has(jti)) {
      const err = new Error('handoff replay detected')
      err.code = 'openclaw_handoff_replay'
      throw err
    }
    opts.seenJti.add(jti)
  }
  return {
    ...payload,
    requesterSenderId: `liangce:${sub}`
  }
}

module.exports = {
  ISS,
  AUD,
  TYP,
  readConfig,
  issueOpenclawHandoff,
  verifyOpenclawHandoff
}
