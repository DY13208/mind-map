require('./loadEnv')

const crypto = require('crypto')
const { Pool } = require('pg')

const SESSION_COOKIE = 'mind_map_session'
const OAUTH_BROWSER_COOKIE = 'mind_map_oauth_browser'
const OAUTH_STATE_TTL_SECONDS = 10 * 60
const TOKEN_REFRESH_MARGIN_SECONDS = 5 * 60
const WECOM_TOKEN_ERROR_CODES = new Set([40014, 42001])
const WECOM_IP_DENIED_ERROR_CODE = 60020

let authPool = null
let authInitialization = null
let accessTokenCache = null
let accessTokenRequest = null

class AuthError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

function enabledValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase())
}

function required(env, key) {
  const value = String(env[key] || '').trim()
  if (!value) throw new Error(`启用企业微信登录时必须配置 ${key}`)
  return value
}

function positiveNumber(value, fallback, key) {
  const number = Number(value || fallback)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${key} 必须是正数`)
  }
  return number
}

function parseOrigin(value, key) {
  let url
  try {
    url = new URL(value)
  } catch (err) {
    throw new Error(`${key} 必须是完整的 http(s) 地址`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${key} 仅支持 http 或 https`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${key} 只能包含协议、域名和端口`)
  }
  return url.origin
}

function optionalHttpsUrl(value, key) {
  const input = String(value || '').trim()
  if (!input) return ''
  let url
  try {
    url = new URL(input)
  } catch (err) {
    throw new Error(`${key} 必须是完整的 HTTPS 地址`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${key} 必须是不含账号、密码和锚点的 HTTPS 地址`)
  }
  if (url.toString().length > 2048) {
    throw new Error(`${key} 不能超过 2048 个字符`)
  }
  return url.toString()
}

function isPrivateOrLocalHost(value) {
  const hostname = String(value || '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(':')[0]
    .toLowerCase()
  if (!hostname || hostname === 'localhost') return true
  if (hostname === '127.0.0.1' || hostname === '::1') return true
  if (hostname.endsWith('.local')) return true

  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

function requestHost(req) {
  const forwarded = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim()
  return forwarded || String(req.headers.host || '').trim()
}

function isDevBypassAllowed(req) {
  if (!config.enabled || !config.devBypassKey) return false
  if (config.devBypassAllowPublic) return true
  return isPrivateOrLocalHost(requestHost(req))
}

function readConfig(env = process.env) {
  const enabled = enabledValue(env.WECOM_AUTH_ENABLED)
  if (!enabled) return { enabled: false }

  const corpId = required(env, 'WECOM_CORP_ID')
  const agentId = required(env, 'WECOM_AGENT_ID')
  const secret = required(env, 'WECOM_SECRET')
  const sessionSecret = required(env, 'AUTH_SESSION_SECRET')
  const mcpToken = required(env, 'MCP_TOKEN')
  const redirectUri = required(env, 'WECOM_REDIRECT_URI')

  if (!/^ww[a-zA-Z0-9_-]+$/.test(corpId)) {
    throw new Error('WECOM_CORP_ID 格式不正确，应为企业微信 CorpID')
  }
  if (!/^\d+$/.test(agentId)) {
    throw new Error('WECOM_AGENT_ID 必须是数字')
  }
  if (sessionSecret.length < 32) {
    throw new Error('AUTH_SESSION_SECRET 至少需要 32 个字符')
  }
  if (mcpToken.length < 32) {
    throw new Error('启用企业微信登录时 MCP_TOKEN 至少需要 32 个字符')
  }

  let callback
  try {
    callback = new URL(redirectUri)
  } catch (err) {
    throw new Error('WECOM_REDIRECT_URI 必须是完整的 http(s) 地址')
  }
  if (!['http:', 'https:'].includes(callback.protocol)) {
    throw new Error('WECOM_REDIRECT_URI 仅支持 http 或 https')
  }
  if (callback.pathname !== '/api/auth/wecom/callback') {
    throw new Error('WECOM_REDIRECT_URI 路径必须是 /api/auth/wecom/callback')
  }
  if (callback.search || callback.hash) {
    throw new Error('WECOM_REDIRECT_URI 不能包含查询参数或锚点')
  }

  const appOrigin = env.AUTH_APP_ORIGIN
    ? parseOrigin(env.AUTH_APP_ORIGIN, 'AUTH_APP_ORIGIN')
    : callback.origin
  const qrStyleUrl = optionalHttpsUrl(
    env.WECOM_QR_STYLE_URL,
    'WECOM_QR_STYLE_URL'
  )
  const sessionTtlHours = positiveNumber(
    env.AUTH_SESSION_TTL_HOURS,
    168,
    'AUTH_SESSION_TTL_HOURS'
  )
  const sessionMaxHours = positiveNumber(
    env.AUTH_SESSION_MAX_HOURS,
    720,
    'AUTH_SESSION_MAX_HOURS'
  )
  if (sessionMaxHours < sessionTtlHours) {
    throw new Error('AUTH_SESSION_MAX_HOURS 不能小于 AUTH_SESSION_TTL_HOURS')
  }

  const cookieSecure = String(env.AUTH_COOKIE_SECURE || 'auto').toLowerCase()
  if (!['auto', 'true', 'false'].includes(cookieSecure)) {
    throw new Error('AUTH_COOKIE_SECURE 只能是 auto、true 或 false')
  }

  const devBypassKey = String(env.AUTH_DEV_BYPASS_KEY || '').trim()
  const devBypassAllowPublic = enabledValue(env.AUTH_DEV_BYPASS_ALLOW_PUBLIC)
  const devBypassUserName =
    String(env.AUTH_DEV_BYPASS_USER_NAME || '本地开发者')
      .trim()
      .slice(0, 100) || '本地开发者'
  const devBypassUserId =
    String(env.AUTH_DEV_BYPASS_USER_ID || 'dev-local')
      .trim()
      .slice(0, 255) || 'dev-local'
  if (devBypassKey && devBypassKey.length < 32) {
    throw new Error('AUTH_DEV_BYPASS_KEY 至少需要 32 个字符')
  }

  return {
    enabled: true,
    corpId,
    agentId,
    secret,
    sessionSecret,
    mcpToken,
    redirectUri: callback.toString(),
    appOrigin,
    qrStyleUrl,
    sessionTtlSeconds: Math.round(sessionTtlHours * 60 * 60),
    sessionMaxSeconds: Math.round(sessionMaxHours * 60 * 60),
    cookieSecure,
    devBypassKey,
    devBypassAllowPublic,
    devBypassUserName,
    devBypassUserId,
    wecomApiBase: String(
      env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com'
    ).replace(/\/$/, ''),
    wecomSsoBase: String(
      env.WECOM_SSO_BASE || 'https://open.work.weixin.qq.com'
    ).replace(/\/$/, '')
  }
}

const config = readConfig()

function isAuthEnabled() {
  return config.enabled
}

function createPool() {
  return new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 5
  })
}

async function initAuth() {
  if (!config.enabled) return
  if (authInitialization) return authInitialization

  authPool = createPool()
  authInitialization = (async () => {
    await authPool.query(`
      create table if not exists wecom_users (
        user_id text primary key,
        name text not null,
        avatar text not null default '',
        departments jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_login_at timestamptz not null default now()
      )
    `)
    await authPool.query(`
      create table if not exists auth_sessions (
        token_hash text primary key,
        user_id text not null references wecom_users(user_id) on delete cascade,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        absolute_expires_at timestamptz not null
      )
    `)
    await authPool.query(`
      create index if not exists auth_sessions_user_id_idx
      on auth_sessions(user_id)
    `)
    await authPool.query(`
      create index if not exists auth_sessions_expires_at_idx
      on auth_sessions(expires_at)
    `)
    await authPool.query(`
      create table if not exists auth_oauth_states (
        nonce_hash text primary key,
        browser_hash text not null,
        return_to text not null default '/',
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      )
    `)
    await authPool.query(`
      create index if not exists auth_oauth_states_expires_at_idx
      on auth_oauth_states(expires_at)
    `)
    await authPool.query(
      `delete from auth_sessions
       where expires_at <= now() or absolute_expires_at <= now()`
    )
    await authPool.query(
      'delete from auth_oauth_states where expires_at <= now()'
    )
  })()

  try {
    await authInitialization
  } catch (err) {
    authInitialization = null
    if (authPool) await authPool.end().catch(() => {})
    authPool = null
    throw err
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''))
  const rightBuffer = Buffer.from(String(right || ''))
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function hmac(label, value) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${label}:${value}`)
    .digest('base64url')
}

function signValue(label, value) {
  return `${value}.${hmac(label, value)}`
}

function verifySignedValue(label, signed) {
  const value = String(signed || '')
  const separator = value.lastIndexOf('.')
  if (separator <= 0) return null
  const raw = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = hmac(label, raw)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return null
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer) ? raw : null
}

function parseCookies(req) {
  const cookies = {}
  String(req.headers.cookie || '')
    .split(';')
    .forEach(part => {
      const separator = part.indexOf('=')
      if (separator <= 0) return
      const key = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      try {
        cookies[key] = decodeURIComponent(value)
      } catch (err) {
        cookies[key] = value
      }
    })
  return cookies
}

function isSecureRequest(req) {
  if (config.cookieSecure === 'true') return true
  if (config.cookieSecure === 'false') return false
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  return forwarded === 'https' || !!(req.socket && req.socket.encrypted)
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie')
  if (!current) {
    res.setHeader('Set-Cookie', cookie)
    return
  }
  res.setHeader(
    'Set-Cookie',
    Array.isArray(current) ? [...current, cookie] : [current, cookie]
  )
}

function setCookie(res, req, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.round(maxAgeSeconds))}`
  ]
  if (isSecureRequest(req)) parts.push('Secure')
  appendCookie(res, parts.join('; '))
}

function clearCookie(res, req, name) {
  setCookie(res, req, name, '', 0)
}

function forwardedOrigin(req) {
  const protocol =
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() || (req.socket && req.socket.encrypted ? 'https' : 'http')
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
  return host ? `${protocol}://${host}` : ''
}

function normalizedRequestOrigin(value) {
  try {
    return new URL(value).origin
  } catch (err) {
    return ''
  }
}

function isAllowedOrigin(req, origin = req.headers.origin) {
  if (!origin) return true
  const normalized = normalizedRequestOrigin(origin)
  if (!normalized) return false
  if (!config.enabled) return true
  return normalized === config.appOrigin || normalized === forwardedOrigin(req)
}

function applyCorsHeaders(req, res) {
  const origin = String(req.headers.origin || '')
  if (origin && isAllowedOrigin(req, origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  } else if (!config.enabled) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id'
  )
}

function sendJson(req, res, status, payload) {
  applyCorsHeaders(req, res)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

function safeReturnTo(value) {
  const input = String(value || '/')
  if (!input.startsWith('/') || input.startsWith('//')) return '/'
  try {
    const url = new URL(input, 'http://mind-map.local')
    if (url.origin !== 'http://mind-map.local') return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch (err) {
    return '/'
  }
}

function appRedirectUrl(returnTo = '/', error = '') {
  const url = new URL(safeReturnTo(returnTo), config.appOrigin)
  if (error) url.searchParams.set('auth_error', error)
  return url.toString()
}

function buildWecomLoginUrl(state, options = {}) {
  const url = new URL('/wwopen/sso/qrConnect', config.wecomSsoBase)
  url.searchParams.set('appid', config.corpId)
  url.searchParams.set('agentid', config.agentId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('lang', 'zh')
  if (options.embedded) url.searchParams.set('login_type', 'jssdk')
  if (config.qrStyleUrl) url.searchParams.set('href', config.qrStyleUrl)
  return url.toString()
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function fetchJson(url, options = {}) {
  const retries = Number(options.retries || 0)
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      })
      if (!response.ok) {
        throw new AuthError(
          'wecom_http_error',
          `企业微信接口返回 HTTP ${response.status}`
        )
      }
      return await response.json()
    } catch (err) {
      lastError = err
      if (attempt >= retries) break
      await delay(200 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastError && lastError.name === 'AbortError') {
    throw new AuthError('wecom_timeout', '企业微信接口请求超时')
  }
  if (lastError instanceof AuthError) throw lastError
  throw new AuthError('wecom_unavailable', '企业微信接口暂不可用')
}

function wecomUrl(pathname, params) {
  const url = new URL(pathname, config.wecomApiBase)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url
}

function successfulWecomResponse(data) {
  return Number(data && data.errcode) === 0
}

function createWecomResponseError(data, fallbackCode, fallbackMessage) {
  const rawErrcode = data && data.errcode
  const errcode =
    rawErrcode === undefined || rawErrcode === null || rawErrcode === ''
      ? NaN
      : Number(rawErrcode)
  const normalizedErrcode = Number.isFinite(errcode) ? errcode : null
  if (normalizedErrcode === WECOM_IP_DENIED_ERROR_CODE) {
    const errmsg = String((data && data.errmsg) || '')
    const ipMatch = errmsg.match(/from ip:\s*([0-9a-f:.]+)/i)
    const ipHint = ipMatch ? `，当前出口 IP：${ipMatch[1]}` : ''
    return new AuthError(
      'wecom_ip_not_allowed',
      `企业微信拒绝当前服务器出口 IP（60020${ipHint}）`,
      503
    )
  }
  return new AuthError(
    fallbackCode,
    `${fallbackMessage}（${normalizedErrcode === null ? 'unknown' : normalizedErrcode}）`
  )
}

async function getAccessToken(forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && accessTokenCache && accessTokenCache.expiresAt > now) {
    return accessTokenCache.value
  }
  if (forceRefresh) accessTokenCache = null
  if (accessTokenRequest) return accessTokenRequest

  accessTokenRequest = (async () => {
    const data = await fetchJson(
      wecomUrl('/cgi-bin/gettoken', {
        corpid: config.corpId,
        corpsecret: config.secret
      }),
      { retries: 2 }
    )
    if (!successfulWecomResponse(data) || !data.access_token) {
      throw createWecomResponseError(
        data,
        'wecom_token_failed',
        '企业微信令牌获取失败'
      )
    }
    const expiresIn = Math.max(600, Number(data.expires_in || 7200))
    accessTokenCache = {
      value: data.access_token,
      expiresAt:
        Date.now() +
        Math.max(60, expiresIn - TOKEN_REFRESH_MARGIN_SECONDS) * 1000
    }
    return accessTokenCache.value
  })()

  try {
    return await accessTokenRequest
  } finally {
    accessTokenRequest = null
  }
}

async function getIdentityResponse(code, token) {
  return fetchJson(
    wecomUrl('/cgi-bin/auth/getuserinfo', {
      access_token: token,
      code
    })
  )
}

async function getProfileResponse(userId, token) {
  return fetchJson(
    wecomUrl('/cgi-bin/user/get', {
      access_token: token,
      userid: userId
    }),
    { retries: 1 }
  )
}

async function exchangeWecomCode(code) {
  const authCode = String(code || '')
  if (!authCode || authCode.length > 512) {
    throw new AuthError('missing_code', '企业微信未返回有效授权码', 400)
  }

  let token = await getAccessToken()
  let identity = await getIdentityResponse(authCode, token)
  if (WECOM_TOKEN_ERROR_CODES.has(Number(identity && identity.errcode))) {
    token = await getAccessToken(true)
    identity = await getIdentityResponse(authCode, token)
  }
  if (!successfulWecomResponse(identity)) {
    throw createWecomResponseError(
      identity,
      'wecom_identity_failed',
      '企业微信身份校验失败'
    )
  }

  const userId = String(identity.UserId || identity.userid || '').trim()
  if (!userId) {
    throw new AuthError(
      'not_enterprise_member',
      '当前扫码账号不是该企业应用的可见成员',
      403
    )
  }
  if (userId.length > 255) {
    throw new AuthError('invalid_user', '企业微信返回了无效成员身份')
  }

  let profile = null
  try {
    profile = await getProfileResponse(userId, token)
    if (WECOM_TOKEN_ERROR_CODES.has(Number(profile && profile.errcode))) {
      token = await getAccessToken(true)
      profile = await getProfileResponse(userId, token)
    }
    if (!successfulWecomResponse(profile)) {
      console.warn(
        `[auth] WeCom profile lookup failed: errcode=${
          Number(profile && profile.errcode) || 'unknown'
        }; using verified UserId`
      )
      profile = null
    }
  } catch (err) {
    console.warn('[auth] WeCom profile lookup failed; using verified UserId')
  }

  return {
    id: userId,
    name: String((profile && profile.name) || userId).slice(0, 100),
    avatar: String((profile && profile.avatar) || '').slice(0, 1000),
    departments: Array.isArray(profile && profile.department)
      ? profile.department.slice(0, 100)
      : []
  }
}

async function storeOAuthState(nonce, browserId, returnTo) {
  await initAuth()
  await authPool.query(
    'delete from auth_oauth_states where expires_at <= now()'
  )
  await authPool.query(
    `delete from auth_sessions
     where expires_at <= now() or absolute_expires_at <= now()`
  )
  await authPool.query(
    `insert into auth_oauth_states
       (nonce_hash, browser_hash, return_to, expires_at)
     values ($1, $2, $3, now() + ($4::double precision * interval '1 second'))`,
    [
      sha256(nonce),
      sha256(browserId),
      safeReturnTo(returnTo),
      OAUTH_STATE_TTL_SECONDS
    ]
  )
}

async function createOAuthChallenge(req, res, returnTo) {
  const cookies = parseCookies(req)
  let browserId = verifySignedValue(
    'oauth-browser',
    cookies[OAUTH_BROWSER_COOKIE]
  )
  if (!browserId) browserId = randomToken()
  setCookie(
    res,
    req,
    OAUTH_BROWSER_COOKIE,
    signValue('oauth-browser', browserId),
    OAUTH_STATE_TTL_SECONDS
  )

  const nonce = randomToken()
  await storeOAuthState(nonce, browserId, returnTo)
  return signValue('oauth-state', nonce)
}

async function consumeOAuthState(nonce, browserId) {
  await initAuth()
  const result = await authPool.query(
    `delete from auth_oauth_states
     where nonce_hash = $1 and browser_hash = $2 and expires_at > now()
     returning return_to`,
    [sha256(nonce), sha256(browserId)]
  )
  return result.rows[0] ? safeReturnTo(result.rows[0].return_to) : null
}

async function upsertUser(user) {
  await authPool.query(
    `insert into wecom_users
       (user_id, name, avatar, departments, last_login_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (user_id) do update set
       name = excluded.name,
       avatar = excluded.avatar,
       departments = excluded.departments,
       updated_at = now(),
       last_login_at = now()`,
    [user.id, user.name, user.avatar, JSON.stringify(user.departments)]
  )
}

async function createSession(userId) {
  const token = randomToken()
  await authPool.query(
    `insert into auth_sessions
       (token_hash, user_id, expires_at, absolute_expires_at)
     values (
       $1,
       $2,
       now() + ($3::double precision * interval '1 second'),
       now() + ($4::double precision * interval '1 second')
     )`,
    [sha256(token), userId, config.sessionTtlSeconds, config.sessionMaxSeconds]
  )
  return token
}

async function authenticateRequest(req) {
  if (!config.enabled) return null
  await initAuth()
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token || token.length > 256) return null

  const result = await authPool.query(
    `update auth_sessions session set
       last_seen_at = now(),
       expires_at = least(
         session.absolute_expires_at,
         now() + ($2::double precision * interval '1 second')
       )
     from wecom_users member
     where session.token_hash = $1
       and session.user_id = member.user_id
       and session.expires_at > now()
       and session.absolute_expires_at > now()
     returning
       member.user_id,
       member.name,
       member.avatar,
       member.departments,
       session.expires_at`,
    [sha256(token), config.sessionTtlSeconds]
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.user_id,
    name: row.name,
    avatar: row.avatar,
    departments: Array.isArray(row.departments) ? row.departments : [],
    expiresAt: row.expires_at
  }
}

async function deleteRequestSession(req) {
  if (!config.enabled || !authPool) return
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token || token.length > 256) return
  await authPool.query('delete from auth_sessions where token_hash = $1', [
    sha256(token)
  ])
}

async function authenticateWebsocketRequest(req) {
  if (!config.enabled) return { id: 'anonymous', name: 'anonymous' }
  await initAuth()
  const authorization = String(req.headers.authorization || '')
  if (safeEqualString(authorization, `Bearer ${config.mcpToken}`)) {
    return { id: 'mcp-service', name: 'MCP Service', service: true }
  }
  if (!isAllowedOrigin(req)) {
    const err = new Error('Forbidden')
    err.statusCode = 403
    throw err
  }
  const user = await authenticateRequest(req)
  if (!user) {
    const err = new Error('Unauthorized')
    err.statusCode = 401
    throw err
  }
  return user
}

async function requireAuthenticatedRequest(req, res) {
  if (!config.enabled) return true
  const authorization = String(req.headers.authorization || '')
  if (safeEqualString(authorization, `Bearer ${config.mcpToken}`)) {
    req.authUser = { id: 'mcp-service', name: 'MCP Service', service: true }
    return true
  }
  const method = String(req.method || 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !isAllowedOrigin(req)) {
    sendJson(req, res, 403, {
      error: '请求来源未获授权',
      code: 'origin_denied'
    })
    return false
  }
  const user = await authenticateRequest(req)
  if (!user) {
    sendJson(req, res, 401, {
      error: '请先使用企业微信扫码登录',
      code: 'unauthorized'
    })
    return false
  }
  req.authUser = user
  return true
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  })
  res.end()
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    departments: user.departments,
    expiresAt: user.expiresAt
  }
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

async function createDevBypassSession(req, res) {
  const user = {
    id: config.devBypassUserId,
    name: config.devBypassUserName,
    avatar: '',
    departments: []
  }
  await upsertUser(user)
  const session = await createSession(user.id)
  setCookie(res, req, SESSION_COOKIE, session, config.sessionMaxSeconds)
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    departments: user.departments
  }
}

async function handleAuthApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname
  if (!pathname.startsWith('/api/auth/')) return false

  applyCorsHeaders(req, res)
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) {
      res.writeHead(403)
    } else {
      res.writeHead(204)
    }
    res.end()
    return true
  }

  if (pathname === '/api/auth/config' && req.method === 'GET') {
    sendJson(req, res, 200, {
      enabled: config.enabled,
      loginPath: config.enabled ? '/api/auth/login' : null,
      devBypassAvailable: isDevBypassAllowed(req)
    })
    return true
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!config.enabled) {
      sendJson(req, res, 200, { enabled: false, authenticated: false })
      return true
    }
    const user = await authenticateRequest(req)
    sendJson(req, res, 200, {
      enabled: true,
      authenticated: !!user,
      user: user ? publicUser(user) : null,
      devBypassAvailable: isDevBypassAllowed(req)
    })
    return true
  }

  if (!config.enabled) {
    sendJson(req, res, 404, {
      error: '企业微信登录未启用',
      code: 'auth_disabled'
    })
    return true
  }

  if (pathname === '/api/auth/qr' && req.method === 'GET') {
    const state = await createOAuthChallenge(
      req,
      res,
      url.searchParams.get('return_to')
    )
    sendJson(req, res, 200, {
      loginUrl: buildWecomLoginUrl(state, { embedded: true }),
      expiresIn: OAUTH_STATE_TTL_SECONDS,
      corpId: config.corpId,
      agentId: config.agentId,
      redirectUri: config.redirectUri,
      state
    })
    return true
  }

  if (pathname === '/api/auth/login' && req.method === 'GET') {
    const state = await createOAuthChallenge(
      req,
      res,
      url.searchParams.get('return_to')
    )
    redirect(res, buildWecomLoginUrl(state))
    return true
  }

  if (pathname === '/api/auth/wecom/callback' && req.method === 'GET') {
    let returnTo = '/'
    try {
      const nonce = verifySignedValue(
        'oauth-state',
        url.searchParams.get('state')
      )
      const browserId = verifySignedValue(
        'oauth-browser',
        parseCookies(req)[OAUTH_BROWSER_COOKIE]
      )
      if (!nonce || !browserId) {
        throw new AuthError('invalid_state', '登录状态校验失败', 400)
      }
      const consumedReturnTo = await consumeOAuthState(nonce, browserId)
      if (!consumedReturnTo) {
        throw new AuthError(
          'expired_state',
          '登录二维码已过期，请重新扫码',
          400
        )
      }
      returnTo = consumedReturnTo
      const user = await exchangeWecomCode(url.searchParams.get('code'))
      await upsertUser(user)
      const session = await createSession(user.id)
      setCookie(res, req, SESSION_COOKIE, session, config.sessionMaxSeconds)
      redirect(res, appRedirectUrl(returnTo))
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'auth_unavailable'
      const message = err && err.message ? err.message : 'unknown error'
      console.error(`[auth] WeCom callback failed: code=${code}; ${message}`)
      redirect(res, appRedirectUrl(returnTo, code))
    }
    return true
  }

  if (pathname === '/api/auth/dev-login' && req.method === 'POST') {
    if (!isDevBypassAllowed(req)) {
      sendJson(req, res, 404, { error: 'not found' })
      return true
    }
    if (!isAllowedOrigin(req)) {
      sendJson(req, res, 403, {
        error: '请求来源未获授权',
        code: 'origin_denied'
      })
      return true
    }
    let body = {}
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(req, res, 400, {
        error: '请求体格式无效',
        code: 'invalid_body'
      })
      return true
    }
    const key = String(body.key || req.headers['x-dev-auth-key'] || '').trim()
    if (!key || !safeEqualString(key, config.devBypassKey)) {
      sendJson(req, res, 401, {
        error: '开发者密钥无效',
        code: 'invalid_dev_key'
      })
      return true
    }
    try {
      const user = await createDevBypassSession(req, res)
      sendJson(req, res, 200, {
        authenticated: true,
        user: publicUser(user)
      })
    } catch (err) {
      console.error('[auth] Dev bypass login failed:', err.message || err)
      sendJson(req, res, 502, {
        error: '开发者登录失败',
        code: 'auth_unavailable'
      })
    }
    return true
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    if (!isAllowedOrigin(req)) {
      sendJson(req, res, 403, {
        error: '请求来源未获授权',
        code: 'origin_denied'
      })
      return true
    }
    await deleteRequestSession(req)
    clearCookie(res, req, SESSION_COOKIE)
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
    return true
  }

  if (pathname === '/api/auth/check' && req.method === 'GET') {
    const user = await authenticateRequest(req)
    if (!user) {
      sendJson(req, res, 401, { error: 'unauthorized', code: 'unauthorized' })
    } else {
      sendJson(req, res, 200, { ok: true, user: publicUser(user) })
    }
    return true
  }

  sendJson(req, res, 404, { error: 'not found' })
  return true
}

module.exports = {
  initAuth,
  isAuthEnabled,
  handleAuthApi,
  authenticateRequest,
  authenticateWebsocketRequest,
  requireAuthenticatedRequest,
  applyCorsHeaders,
  isAllowedOrigin,
  __test: {
    readConfig,
    safeReturnTo,
    signValue,
    verifySignedValue,
    buildWecomLoginUrl,
    createWecomResponseError,
    isPrivateOrLocalHost,
    isDevBypassAllowed
  }
}
