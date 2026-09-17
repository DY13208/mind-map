/**
 * Mind-map → Docmost (wiki) SSO.
 *
 * Flow:
 *  1) Authenticated browser POSTs /api/auth/wiki-token → short-lived HMAC assertion
 *  2) Browser navigates to DOCMOST_APP_URL/api/auth/mind-map/exchange?token=...
 *  3) wiki-gateway proxies that path back to /api/auth/wiki-exchange
 *  4) We upsert a Docmost user, create a session row, sign authToken with APP_SECRET,
 *     Set-Cookie on the Docmost origin, redirect to /
 */
const crypto = require('crypto')
const { Pool } = require('pg')

const ASSERTION_TTL_SEC = 90
const JWT_TTL_SEC = 90 * 24 * 60 * 60
const EMAIL_DOMAIN = 'users.mind-map.local'

let docmostPool = null

function readWikiConfig(env = process.env) {
  const databaseUrl = String(
    env.DOCMOST_DATABASE_URL || env.DATABASE_URL || ''
  ).trim()
  const appSecret = String(
    env.DOCMOST_APP_SECRET || env.APP_SECRET || ''
  ).trim()
  const appUrl = String(
    env.DOCMOST_APP_URL || 'http://localhost:3040'
  )
    .trim()
    .replace(/\/$/, '')
  const ssoSecret = String(
    env.DOCMOST_SSO_SECRET || appSecret || ''
  ).trim()
  return {
    databaseUrl,
    appSecret,
    appUrl,
    ssoSecret,
    configured: !!(databaseUrl && appSecret && ssoSecret.length >= 16)
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function sanitizeLocalPart(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned.slice(0, 64) || 'user'
}

function emailForMindMapUser(user) {
  const wecomId = String((user && (user.wecomUserId || user.id)) || '').trim()
  return `${sanitizeLocalPart(wecomId)}@${EMAIL_DOMAIN}`
}

function displayNameForUser(user) {
  const name = String((user && user.name) || '').trim()
  if (name) return name.slice(0, 120)
  return String((user && (user.wecomUserId || user.id)) || 'MindMap User').slice(
    0,
    120
  )
}

function issueWikiAssertion(user, env = process.env) {
  const cfg = readWikiConfig(env)
  if (!cfg.configured) {
    const err = new Error('Wiki 单点登录未配置（缺少 Docmost 数据库或密钥）')
    err.code = 'wiki_sso_unavailable'
    err.status = 503
    throw err
  }
  const wecomUserId = String(
    (user && (user.wecomUserId || user.id)) || ''
  ).trim()
  if (!wecomUserId) {
    const err = new Error('当前账号缺少可用身份')
    err.code = 'wiki_identity_missing'
    err.status = 403
    throw err
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    v: 1,
    typ: 'wiki_identity_assertion',
    iss: 'mind-map',
    aud: 'docmost',
    sub: wecomUserId,
    name: displayNameForUser(user),
    email: emailForMindMapUser(user),
    iat: now,
    exp: now + ASSERTION_TTL_SEC,
    jti: crypto.randomBytes(16).toString('hex')
  }
  const encoded = base64UrlJson(payload)
  const signature = crypto
    .createHmac('sha256', cfg.ssoSecret)
    .update(encoded, 'ascii')
    .digest('base64url')
  return { assertion: `${encoded}.${signature}`, expiresIn: ASSERTION_TTL_SEC, appUrl: cfg.appUrl }
}

function verifyWikiAssertion(token, env = process.env) {
  const cfg = readWikiConfig(env)
  if (!cfg.configured) {
    const err = new Error('Wiki SSO 未配置')
    err.code = 'wiki_sso_unavailable'
    err.status = 503
    throw err
  }
  const raw = String(token || '').trim()
  const parts = raw.split('.')
  if (parts.length !== 2) {
    const err = new Error('无效的登录票据')
    err.code = 'wiki_token_invalid'
    err.status = 401
    throw err
  }
  const [encoded, signature] = parts
  const expected = crypto
    .createHmac('sha256', cfg.ssoSecret)
    .update(encoded, 'ascii')
    .digest('base64url')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    const err = new Error('登录票据校验失败')
    err.code = 'wiki_token_invalid'
    err.status = 401
    throw err
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch (_) {
    const err = new Error('登录票据无法解析')
    err.code = 'wiki_token_invalid'
    err.status = 401
    throw err
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    !payload ||
    payload.typ !== 'wiki_identity_assertion' ||
    payload.aud !== 'docmost' ||
    payload.iss !== 'mind-map' ||
    !payload.sub ||
    !payload.email ||
    Number(payload.exp) < now
  ) {
    const err = new Error('登录票据已失效')
    err.code = 'wiki_token_expired'
    err.status = 401
    throw err
  }
  return payload
}

function signDocmostAccessToken({ userId, email, workspaceId, sessionId, appSecret }) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: userId,
    email,
    workspaceId,
    type: 'access',
    sessionId,
    iat: now,
    exp: now + JWT_TTL_SEC,
    iss: 'Docmost'
  }
  const data = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signature = crypto
    .createHmac('sha256', appSecret)
    .update(data, 'utf8')
    .digest()
  return `${data}.${base64Url(signature)}`
}

function getDocmostPool(env = process.env) {
  const cfg = readWikiConfig(env)
  if (!cfg.databaseUrl) return null
  if (!docmostPool) {
    docmostPool = new Pool({
      connectionString: cfg.databaseUrl,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000
    })
  }
  return docmostPool
}

async function ensureDocmostUser(client, assertion) {
  const workspace = (
    await client.query(
      `select id from workspaces where deleted_at is null order by created_at asc limit 1`
    )
  ).rows[0]
  if (!workspace) {
    const err = new Error('Docmost 尚未完成初始化，请先打开 Wiki 完成建站')
    err.code = 'wiki_not_setup'
    err.status = 503
    throw err
  }
  const workspaceId = workspace.id
  const email = String(assertion.email).trim().toLowerCase()
  const name = String(assertion.name || assertion.sub).trim().slice(0, 120)
  const externalId = `mind-map:${String(assertion.sub).trim()}`.slice(0, 200)

  let user = (
    await client.query(
      `select id, email, workspace_id, deactivated_at, deleted_at
         from users
        where workspace_id = $1
          and (lower(email) = $2 or scim_external_id = $3)
          and deleted_at is null
        limit 1`,
      [workspaceId, email, externalId]
    )
  ).rows[0]

  if (user && user.deactivated_at) {
    const err = new Error('该账号在 Wiki 中已停用')
    err.code = 'wiki_user_disabled'
    err.status = 403
    throw err
  }

  if (!user) {
    user = (
      await client.query(
        `insert into users (
           name, email, email_verified_at, role, workspace_id,
           locale, has_generated_password, scim_external_id, last_login_at
         ) values (
           $1, $2, now(), 'member', $3,
           'zh-CN', true, $4, now()
         )
         returning id, email, workspace_id`,
        [name, email, workspaceId, externalId]
      )
    ).rows[0]

    const everyone = (
      await client.query(
        `select id from groups
          where workspace_id = $1 and is_default = true and deleted_at is null
          limit 1`,
        [workspaceId]
      )
    ).rows[0]
    if (everyone) {
      await client.query(
        `insert into group_users (user_id, group_id)
         values ($1, $2)
         on conflict (group_id, user_id) do nothing`,
        [user.id, everyone.id]
      )
    }
  } else {
    await client.query(
      `update users
          set name = coalesce(nullif($2, ''), name),
              email_verified_at = coalesce(email_verified_at, now()),
              scim_external_id = coalesce(scim_external_id, $3),
              last_login_at = now(),
              updated_at = now()
        where id = $1`,
      [user.id, name, externalId]
    )
  }

  return { userId: user.id, email: user.email || email, workspaceId }
}

async function createDocmostSession(client, { userId, workspaceId, userAgent, ip }) {
  const expiresAt = new Date(Date.now() + JWT_TTL_SEC * 1000)
  const row = (
    await client.query(
      `insert into user_sessions (
         user_id, workspace_id, device_name, user_agent, ip_address, expires_at
       ) values ($1, $2, $3, $4, $5::inet, $6)
       returning id`,
      [
        userId,
        workspaceId,
        'Mind-map SSO',
        userAgent ? String(userAgent).slice(0, 1000) : null,
        ip && String(ip).includes(':') === false && /^\d+\.\d+\.\d+\.\d+$/.test(String(ip))
          ? String(ip)
          : null,
        expiresAt.toISOString()
      ]
    )
  ).rows[0]
  return row.id
}

async function exchangeAssertionForCookie(assertionToken, reqMeta = {}, env = process.env) {
  const cfg = readWikiConfig(env)
  const assertion = verifyWikiAssertion(assertionToken, env)
  const pool = getDocmostPool(env)
  if (!pool) {
    const err = new Error('无法连接 Docmost 数据库')
    err.code = 'wiki_db_unavailable'
    err.status = 503
    throw err
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const user = await ensureDocmostUser(client, assertion)
    const sessionId = await createDocmostSession(client, {
      userId: user.userId,
      workspaceId: user.workspaceId,
      userAgent: reqMeta.userAgent,
      ip: reqMeta.ip
    })
    await client.query('commit')
    const authToken = signDocmostAccessToken({
      userId: user.userId,
      email: user.email,
      workspaceId: user.workspaceId,
      sessionId,
      appSecret: cfg.appSecret
    })
    return { authToken, appUrl: cfg.appUrl, expiresAt: new Date(Date.now() + JWT_TTL_SEC * 1000) }
  } catch (err) {
    try {
      await client.query('rollback')
    } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

function buildAuthCookie(authToken, expiresAt) {
  const parts = [
    `authToken=${authToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ]
  if (expiresAt instanceof Date) {
    parts.push(`Expires=${expiresAt.toUTCString()}`)
  }
  return parts.join('; ')
}

function sendText(res, status, text, headers = {}) {
  const body = String(text || '')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  })
  res.end(body)
}

async function handleWikiSsoApi(req, res, { authenticateRequest, sendJson, isAllowedOrigin, applyCorsHeaders }) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname

  if (pathname === '/api/auth/wiki-token' && req.method === 'POST') {
    if (applyCorsHeaders) applyCorsHeaders(req, res)
    if (!isAllowedOrigin(req)) {
      sendJson(req, res, 403, { error: '请求来源未获授权', code: 'origin_denied' })
      return true
    }
    const user = await authenticateRequest(req)
    if (!user) {
      sendJson(req, res, 401, { error: '请先登录', code: 'unauthorized' })
      return true
    }
    try {
      const ticket = issueWikiAssertion(user)
      sendJson(req, res, 200, {
        assertion: ticket.assertion,
        expiresIn: ticket.expiresIn,
        appUrl: ticket.appUrl,
        exchangeUrl: `${ticket.appUrl}/api/auth/mind-map/exchange`
      })
    } catch (err) {
      sendJson(req, res, err.status || 500, {
        error: err.message || '无法签发 Wiki 登录票据',
        code: err.code || 'wiki_sso_failed'
      })
    }
    return true
  }

  if (pathname === '/api/auth/wiki-exchange' && req.method === 'GET') {
    const token = url.searchParams.get('token') || ''
    try {
      const result = await exchangeAssertionForCookie(token, {
        userAgent: req.headers['user-agent'],
        ip:
          (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          req.socket.remoteAddress
      })
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': buildAuthCookie(result.authToken, result.expiresAt),
        'Cache-Control': 'no-store'
      })
      res.end()
    } catch (err) {
      sendText(
        res,
        err.status || 500,
        err.message || 'Wiki 自动登录失败',
        { 'Cache-Control': 'no-store' }
      )
    }
    return true
  }

  return false
}

module.exports = {
  readWikiConfig,
  issueWikiAssertion,
  verifyWikiAssertion,
  handleWikiSsoApi,
  emailForMindMapUser,
  __test: {
    signDocmostAccessToken,
    buildAuthCookie,
    sanitizeLocalPart
  }
}
