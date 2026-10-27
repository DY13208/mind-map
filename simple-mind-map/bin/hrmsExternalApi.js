/**
 * 人事系统（Frappe）程序调用。
 * 用当前登录人的企业微信 userid 向人事系统换本人的 hrms_ext_ 令牌。
 * 换票只带 X-API-Exchange-Key 和 hr_wecom_id，不转发 Cookie / Authorization。
 * 明文令牌只留在进程缓存里；落库只存 SHA-256。缓存丢失就重新换票。
 */
const crypto = require('crypto')

const ISSUE_PATH =
  '/api/method/employee_roster.integrations.external_api.issue_token'
const ROUTE = '/api/integrations/hrms/token'
const TOKEN_PREFIX = 'hrms_ext_'
const WECOM_ACCOUNT_DOMAIN = 'wecom.local'
const inflight = new Map()
const tokenCache = new Map()

function fail(statusCode, code, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

function readConfig(env = process.env) {
  const baseUrl = parseBase(env.HRMS_API_BASE)
  const exchangeKey = String(
    env.EXTERNAL_API_EXCHANGE_KEY || env.HRMS_EXCHANGE_KEY || ''
  ).trim()
  const apiKey = String(env.HRMS_API_KEY || '').trim()
  const apiSecret = String(env.HRMS_API_SECRET || '').trim()
  const apiUser = String(env.HRMS_API_USER || '').trim()
  const secret = String(env.HRMS_TOKEN_SECRET || env.AUTH_SESSION_SECRET || '').trim()
  let clientName = String(env.HRMS_CLIENT_NAME || 'WCPD').trim()
  if (!clientName) clientName = 'WCPD'
  const exchangeKeyOk = exchangeKey.length >= 32 && exchangeKey.length <= 512 && !/[\r\n]/.test(exchangeKey)
  const apiCredentialOk =
    /^[A-Za-z0-9]{8,128}$/.test(apiKey) && /^[A-Za-z0-9]{8,128}$/.test(apiSecret)
  let clientNameOk = true
  try {
    assertClientName(clientName)
  } catch (err) {
    clientNameOk = false
  }
  const problems = []
  if (!baseUrl) problems.push('HRMS_API_BASE')
  if (!exchangeKeyOk) problems.push('EXTERNAL_API_EXCHANGE_KEY')
  if ((apiKey || apiSecret) && !apiCredentialOk) problems.push('HRMS_API_KEY')
  if (!clientNameOk) problems.push('HRMS_CLIENT_NAME')
  return {
    baseUrl,
    exchangeKey,
    apiKey: apiCredentialOk ? apiKey : '',
    apiSecret: apiCredentialOk ? apiSecret : '',
    apiUser,
    secret,
    clientName: clientNameOk ? clientName : 'WCPD',
    tlsInsecure: /^(1|true|yes)$/i.test(String(env.HRMS_TLS_INSECURE || '')),
    configured: problems.length === 0,
    problems
  }
}

function parseBase(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    return url.origin
  } catch (err) {
    return ''
  }
}

function isSid(value) {
  return /^[A-Za-z0-9_-]{16,256}$/.test(String(value || ''))
}

function assertClientName(name) {
  const value = String(name || '').trim()
  if (value.length < 1 || value.length > 140) {
    throw fail(400, 'hrms_client_name_invalid', 'client_name 需要 1–140 个字符')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw fail(400, 'hrms_client_name_invalid', 'client_name 含有无效字符')
  }
  return value
}

function resolveClientName(requested, cfg) {
  const clientName = assertClientName(requested || cfg.clientName)
  if (clientName !== cfg.clientName) {
    throw fail(
      400,
      'hrms_client_name_rejected',
      'client_name 使用服务器配置的 HRMS_CLIENT_NAME，请求里不能改成别的名称'
    )
  }
  return clientName
}

function expectedHrmsUser(user) {
  const wecom = String((user && user.wecomUserId) || '').trim()
  const id = String((user && user.id) || '').trim()
  const raw = wecom || (id.startsWith('wecom:') ? '' : id)
  if (!raw) {
    throw fail(409, 'hrms_identity_missing', '当前登录没有企业微信账号')
  }
  const domain = `@${WECOM_ACCOUNT_DOMAIN}`
  const account = raw.toLowerCase().endsWith(domain) ? raw.slice(0, -domain.length) : raw
  if (account.includes('@') || !/^[A-Za-z0-9._+-]{1,64}$/.test(account)) {
    throw fail(409, 'hrms_identity_unmapped', '当前企业微信账号无法对应人事系统用户')
  }
  return `${account}@${WECOM_ACCOUNT_DOMAIN}`
}

function parseCookies(header) {
  const cookies = {}
  String(header || '')
    .split(';')
    .forEach(part => {
      const separator = part.indexOf('=')
      if (separator <= 0) return
      const key = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      if (!(key in cookies)) cookies[key] = value
    })
  return cookies
}

function sessionSid(req) {
  const sid = parseCookies(req && req.headers && req.headers.cookie).sid || ''
  return isSid(sid) ? sid : ''
}

function resolveSid(req) {
  const sid = sessionSid(req)
  return sid ? { sid } : null
}

function keyBytes(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest()
}

function encryptToken(plain, secret) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(secret), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`
}

function decryptToken(packed, secret) {
  const parts = String(packed || '').split(':')
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw fail(500, 'hrms_token_corrupt', '已保存的人事令牌无法读取')
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBytes(secret),
    Buffer.from(parts[2], 'base64url')
  )
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64url')),
    decipher.final()
  ]).toString('utf8')
}

function createMemoryStore() {
  const rows = []
  return {
    rows,
    async findActive({ ownerUserId, clientName, hrmsUser }) {
      const now = Date.now()
      return (
        rows.find(
          row =>
            row.enabled &&
            row.ownerUserId === ownerUserId &&
            row.clientName === clientName &&
            row.hrmsUser === hrmsUser &&
            (!row.expiresAt || Date.parse(row.expiresAt) > now)
        ) || null
      )
    },
    async save(row) {
      rows.forEach(item => {
        if (
          item.enabled &&
          item.ownerUserId === row.ownerUserId &&
          item.clientName === row.clientName &&
          item.hrmsUser === row.hrmsUser
        ) {
          item.enabled = false
        }
      })
      const stored = {
        ...row,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      }
      rows.push(stored)
      return stored
    },
    async disable(tokenId) {
      const row = rows.find(item => item.tokenId === tokenId)
      if (row) row.enabled = false
    },
    async touch(tokenId) {
      const row = rows.find(item => item.tokenId === tokenId && item.enabled)
      if (row) row.lastUsedAt = new Date().toISOString()
    }
  }
}

function createPgStore(pool) {
  let ready = null
  function init() {
    if (!ready) {
      ready = pool
        .query(
          `create table if not exists hrms_api_tokens (
             token_id text primary key,
             owner_user_id text not null,
             hrms_user text not null,
             client_name text not null,
             access_token text not null,
             token_type text not null default 'Bearer',
             scope text not null default 'user',
             expires_at timestamptz,
             enabled boolean not null default true,
             created_at timestamptz not null default now(),
             last_used_at timestamptz
           )`
        )
        .then(() =>
          pool.query(
            `create index if not exists hrms_api_tokens_lookup_idx
             on hrms_api_tokens (owner_user_id, client_name, hrms_user)
             where enabled`
          )
        )
        .catch(err => {
          ready = null
          throw err
        })
    }
    return ready
  }
  function mapRow(row) {
    if (!row) return null
    return {
      tokenId: row.token_id,
      ownerUserId: row.owner_user_id,
      hrmsUser: row.hrms_user,
      clientName: row.client_name,
      accessTokenCipher: row.access_token,
      tokenType: row.token_type,
      scope: row.scope,
      expiresAt: row.expires_at,
      enabled: row.enabled,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at
    }
  }
  return {
    async findActive({ ownerUserId, clientName, hrmsUser }) {
      await init()
      const result = await pool.query(
        `select * from hrms_api_tokens
         where owner_user_id = $1 and client_name = $2 and hrms_user = $3
           and enabled and (expires_at is null or expires_at > now())
         order by created_at desc
         limit 1`,
        [ownerUserId, clientName, hrmsUser]
      )
      return mapRow(result.rows[0])
    },
    async save(row) {
      await init()
      await pool.query(
        `update hrms_api_tokens set enabled = false
         where owner_user_id = $1 and client_name = $2 and hrms_user = $3 and enabled`,
        [row.ownerUserId, row.clientName, row.hrmsUser]
      )
      const result = await pool.query(
        `insert into hrms_api_tokens
           (token_id, owner_user_id, hrms_user, client_name, access_token, token_type, scope, expires_at, enabled)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true)
         on conflict (token_id) do update set
           owner_user_id = excluded.owner_user_id,
           hrms_user = excluded.hrms_user,
           client_name = excluded.client_name,
           access_token = excluded.access_token,
           token_type = excluded.token_type,
           scope = excluded.scope,
           expires_at = excluded.expires_at,
           enabled = true,
           created_at = now(),
           last_used_at = null
         returning *`,
        [
          row.tokenId,
          row.ownerUserId,
          row.hrmsUser,
          row.clientName,
          row.accessTokenCipher,
          row.tokenType,
          row.scope,
          row.expiresAt
        ]
      )
      return mapRow(result.rows[0])
    },
    async disable(tokenId) {
      await init()
      await pool.query(
        'update hrms_api_tokens set enabled = false where token_id = $1',
        [tokenId]
      )
    },
    async touch(tokenId) {
      await init()
      await pool.query(
        'update hrms_api_tokens set last_used_at = now() where token_id = $1 and enabled',
        [tokenId]
      )
    }
  }
}

let defaultStore
function storeFor(explicit) {
  if (explicit) return explicit
  if (!defaultStore) {
    defaultStore = createPgStore(require('./storage').getPool())
  }
  return defaultStore
}

function singleFlight(key, fn) {
  if (inflight.has(key)) return inflight.get(key)
  const pending = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}

function redact(text, secrets) {
  let out = String(text || '')
  secrets.filter(Boolean).forEach(secret => {
    out = out.split(secret).join('[redacted]')
  })
  return out.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function upstreamMessage(payload, secrets) {
  if (!payload || typeof payload !== 'object') return ''
  let text = ''
  if (typeof payload.message === 'string') text = payload.message
  else if (payload.exception) text = String(payload.exception).split('\n').pop()
  else if (payload.exc_type) text = String(payload.exc_type)
  return redact(text, secrets)
}

function unwrapIssued(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.access_token) return payload
  if (payload.message && typeof payload.message === 'object') return payload.message
  return null
}

function assertIssued(data) {
  const accessToken = String((data && data.access_token) || '')
  if (
    !accessToken.startsWith(TOKEN_PREFIX) ||
    accessToken.length < TOKEN_PREFIX.length + 8 ||
    accessToken.length > 512 ||
    !/^hrms_ext_[A-Za-z0-9_-]+$/.test(accessToken)
  ) {
    throw fail(502, 'hrms_bad_response', '人事系统返回的令牌格式无效')
  }
  if (data.token_type && data.token_type !== 'Bearer') {
    throw fail(502, 'hrms_bad_response', '人事系统返回的令牌类型无效')
  }
  const tokenId = String(data.token_id || '').trim()
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(tokenId)) {
    throw fail(502, 'hrms_bad_response', '人事系统返回的 token_id 无效')
  }
  const user = String(data.user || '').trim()
  if (!user || user.length > 140 || /[\r\n]/.test(user)) {
    throw fail(502, 'hrms_bad_response', '人事系统返回的用户无效')
  }
  const scope = String(data.scope || 'user').trim() || 'user'
  if (scope.length > 64) throw fail(502, 'hrms_bad_response', '人事系统返回的 scope 无效')
  let expiresAt = null
  if (data.expires_at != null && data.expires_at !== '') {
    const parsed = Date.parse(data.expires_at)
    if (Number.isNaN(parsed)) {
      throw fail(502, 'hrms_bad_response', '人事系统返回的过期时间无效')
    }
    expiresAt = new Date(parsed).toISOString()
  }
  return {
    accessToken,
    tokenType: 'Bearer',
    tokenId,
    user,
    scope,
    expiresAt
  }
}

let insecureDispatcher
function fetchImplFor(cfg, explicit) {
  if (explicit) return explicit
  if (typeof fetch !== 'function') {
    throw fail(500, 'hrms_fetch_unavailable', '当前运行时没有 fetch')
  }
  if (!cfg.tlsInsecure) return fetch
  if (!insecureDispatcher) {
    const { Agent } = require('undici')
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  }
  const { fetch: undiciFetch } = require('undici')
  return (url, options) =>
    undiciFetch(url, { ...options, dispatcher: insecureDispatcher })
}

async function readResponse(response) {
  const text = await response.text()
  if (!text) return { text: '', payload: null }
  try {
    return { text, payload: JSON.parse(text) }
  } catch (err) {
    return { text, payload: null }
  }
}

function wecomIdFrom(user) {
  const raw = String((user && (user.wecomUserId || user.wecom_userid)) || '').trim()
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(raw)) {
    throw fail(409, 'hrms_identity_missing', '当前登录没有企业微信账号')
  }
  return raw
}

function cacheKey(clientName, wecomId) {
  return `${clientName}\0${wecomId}`
}

function tokenHash(accessToken) {
  return `sha256:${crypto.createHash('sha256').update(String(accessToken)).digest('hex')}`
}

async function issueToken({ cfg, clientName, hrWecomId, fetchImpl }) {
  const body = new URLSearchParams()
  body.set('client_name', clientName)
  body.set('hr_wecom_id', hrWecomId)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  let response
  try {
    response = await fetchImplFor(cfg, fetchImpl)(`${cfg.baseUrl}${ISSUE_PATH}`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'X-API-Exchange-Key': cfg.exchangeKey,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    })
  } catch (err) {
    throw fail(502, 'hrms_unreachable', '无法连接人事系统换取令牌')
  } finally {
    clearTimeout(timer)
  }
  const { payload } = await readResponse(response)
  const detail = upstreamMessage(payload, [cfg.exchangeKey])
  if (response.status === 429) {
    throw fail(429, 'hrms_rate_limited', '人事系统换票过于频繁，请稍后重试')
  }
  if (response.status === 400 && /csrf/i.test(`${detail} ${JSON.stringify(payload && payload.exc_type || '')}`)) {
    throw fail(400, 'hrms_csrf', '换票请求不能携带 Cookie')
  }
  if (response.status === 401) {
    throw fail(
      401,
      'hrms_exchange_rejected',
      '人事系统拒绝签发令牌。交换密钥错误，或这个企业微信账号没有唯一可用的在职员工'
    )
  }
  const rejected =
    !response.ok ||
    !payload ||
    payload.exc ||
    payload.exception ||
    payload.exc_type ||
    typeof payload.message === 'string'
  if (rejected) {
    throw fail(
      response.status === 403 ? 403 : 502,
      'hrms_exchange_rejected',
      detail ? `人事系统拒绝签发令牌：${detail}` : '人事系统拒绝签发令牌'
    )
  }
  return assertIssued(unwrapIssued(payload))
}

function assertConfigured(cfg) {
  if (cfg.configured) return
  throw fail(
    503,
    'hrms_not_configured',
    `人事系统换票未配置：${cfg.problems.join('、')}`
  )
}

function ownerFrom(options) {
  const user = options.user || (options.req && options.req.authUser) || {}
  const ownerUserId = String(options.ownerUserId || user.id || '').trim()
  if (!ownerUserId || user.service || user.mcp) {
    throw fail(403, 'hrms_user_required', '只有已登录的脑图用户可以换取人事令牌')
  }
  return { user, ownerUserId }
}

async function openToken(row, cfg, store) {
  try {
    return {
      ...row,
      accessToken: decryptToken(row.accessTokenCipher, cfg.secret)
    }
  } catch (err) {
    await store.disable(row.tokenId)
    return null
  }
}

async function ensureAccessToken(options = {}) {
  const cfg = readConfig(options.env)
  assertConfigured(cfg)
  const { user, ownerUserId } = ownerFrom(options)
  const hrWecomId = wecomIdFrom({
    wecomUserId: options.wecomUserId || user.wecomUserId || user.wecom_userid
  })
  const clientName = resolveClientName(options.clientName, cfg)
  const store = options.store ? options.store : null
  const key = cacheKey(clientName, hrWecomId)
  const hit = tokenCache.get(key)
  if (hit) return { ...hit, reused: true }
  return singleFlight(key, async () => {
    const again = tokenCache.get(key)
    if (again) return { ...again, reused: true }
    const issued = await issueToken({
      cfg,
      clientName,
      hrWecomId,
      fetchImpl: options.fetchImpl
    })
    const record = {
      tokenId: issued.tokenId,
      ownerUserId,
      hrmsUser: issued.user,
      wecomUserId: hrWecomId,
      clientName,
      accessToken: issued.accessToken,
      tokenType: issued.tokenType,
      scope: issued.scope,
      expiresAt: issued.expiresAt,
      reused: false
    }
    tokenCache.set(key, record)
    if (store) {
      await store.save({
        tokenId: issued.tokenId,
        ownerUserId,
        hrmsUser: issued.user,
        clientName,
        accessTokenCipher: tokenHash(issued.accessToken),
        tokenType: issued.tokenType,
        scope: issued.scope,
        expiresAt: issued.expiresAt
      })
    }
    return record
  })
}

function assertApiPath(pathname) {
  const pathOnly = String(pathname || '').split('?')[0]
  if (
    !pathOnly.startsWith('/api/') ||
    pathOnly.includes('..') ||
    pathOnly.includes('\\') ||
    /[\s\u0000]/.test(pathOnly)
  ) {
    throw fail(400, 'hrms_path_invalid', '只允许调用人事系统的 /api/ 路径')
  }
  return pathOnly
}

function serviceAuthorization(cfg) {
  if (!cfg.apiKey) {
    throw fail(503, 'hrms_directory_unconfigured', '没有配置员工档案对照用的 HRMS_API_KEY')
  }
  return `token ${cfg.apiKey}:${cfg.apiSecret}`
}

async function resolveEmployee(options = {}) {
  const cfg = readConfig(options.env)
  const wecomUserId = String(
    options.wecomUserId ||
      (options.user && (options.user.wecomUserId || options.user.wecom_userid)) ||
      ''
  ).trim()
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(wecomUserId)) {
    throw fail(409, 'hrms_identity_missing', '当前登录没有企业微信账号')
  }
  const url = new URL('/api/resource/Employee', cfg.baseUrl)
  url.searchParams.set('filters', JSON.stringify([['hr_wecom_id', '=', wecomUserId]]))
  url.searchParams.set(
    'fields',
    JSON.stringify(['name', 'employee_name', 'employee_number', 'user_id', 'hr_wecom_id', 'status'])
  )
  url.searchParams.set('limit_page_length', '2')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  let response
  try {
    response = await fetchImplFor(cfg, options.fetchImpl)(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: serviceAuthorization(cfg)
      }
    })
  } catch (err) {
    throw fail(502, 'hrms_unreachable', '无法连接人事系统')
  } finally {
    clearTimeout(timer)
  }
  const { payload } = await readResponse(response)
  if (!response.ok) {
    const detail = upstreamMessage(payload, [cfg.apiKey, cfg.apiSecret])
    throw fail(502, 'hrms_directory_failed', detail ? `员工档案对照失败：${detail}` : '员工档案对照失败')
  }
  const rows = payload && Array.isArray(payload.data) ? payload.data : []
  if (rows.length !== 1) {
    throw fail(404, 'hrms_employee_missing', '人事系统里没有这个企业微信账号对应的唯一员工')
  }
  const row = rows[0]
  return {
    employee: row.name,
    employeeName: row.employee_name || '',
    employeeNumber: row.employee_number || '',
    userId: row.user_id || '',
    wecomUserId: row.hr_wecom_id || wecomUserId,
    status: row.status || ''
  }
}

async function callApi(pathname, options = {}) {
  const cfg = readConfig(options.env)
  assertConfigured(cfg)
  const pathOnly = assertApiPath(pathname)
  const token = await ensureAccessToken(options)
  const url = new URL(pathOnly, cfg.baseUrl)
  const search = options.searchParams || {}
  Object.keys(search).forEach(key => {
    if (search[key] != null) url.searchParams.set(key, String(search[key]))
  })
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw fail(400, 'hrms_method_invalid', '不支持的人事系统请求方法')
  }
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token.accessToken}`
  }
  let body
  if (options.json !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let response
  try {
    response = await fetchImplFor(cfg, options.fetchImpl)(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers,
      body
    })
  } catch (err) {
    throw fail(502, 'hrms_unreachable', '无法连接人事系统')
  } finally {
    clearTimeout(timer)
  }
  const { payload, text } = await readResponse(response)
  if (response.status === 401) {
    tokenCache.delete(cacheKey(token.clientName, token.wecomUserId))
    if (options.store) await options.store.disable(token.tokenId)
    throw fail(401, 'hrms_token_rejected', '人事系统拒绝了当前用户的令牌，请重新换取')
  }
  if (!response.ok) {
    const detail = upstreamMessage(payload, [
      cfg.exchangeKey,
      cfg.apiKey,
      cfg.apiSecret,
      token && token.accessToken
    ])
    throw fail(
      response.status >= 500 ? 502 : response.status,
      'hrms_api_error',
      detail ? `人事系统调用失败：${detail}` : '人事系统调用失败'
    )
  }
  try {
    if (options.store) await options.store.touch(token.tokenId)
  } catch (err) {
    /* 调用已成功，回写时间失败不影响结果 */
  }
  return {
    status: response.status,
    data: payload,
    raw: payload ? undefined : String(text || '').slice(0, 2000)
  }
}

function publicView(row) {
  return {
    token_id: row.tokenId,
    token_type: row.tokenType || 'Bearer',
    expires_at: row.expiresAt || null,
    scope: row.scope || 'user',
    user: row.hrmsUser,
    client_name: row.clientName,
    last_used_at: row.lastUsedAt || null
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 8192) {
        reject(fail(413, 'body_too_large', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const body = JSON.parse(raw)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          reject(fail(400, 'bad_json', '请求体必须是 JSON 对象'))
          return
        }
        resolve(body)
      } catch (err) {
        reject(fail(400, 'bad_json', '请求体必须是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  require('./storage').sendJson(res, status, payload)
}

async function tokenStatus(req, deps) {
  const cfg = readConfig(deps.env)
  const user = req.authUser || {}
  let hrWecomId = ''
  let identityError = ''
  try {
    if (user.id && !user.service && !user.mcp) hrWecomId = wecomIdFrom(user)
  } catch (err) {
    identityError = err.message
  }
  const clientName = resolveClientName(
    req.url && new URL(req.url, 'http://127.0.0.1').searchParams.get('client_name'),
    cfg
  )
  const cached = hrWecomId ? tokenCache.get(cacheKey(clientName, hrWecomId)) : null
  return {
    configured: cfg.configured,
    problems: cfg.configured ? undefined : cfg.problems,
    client_name: clientName,
    hr_wecom_id: hrWecomId || null,
    user: cached ? cached.hrmsUser : null,
    identity_ready: Boolean(hrWecomId),
    identity_error: identityError || undefined,
    connected: Boolean(cached),
    directory_ready: Boolean(cfg.apiKey),
    ...(cached ? publicView(cached) : {})
  }
}

async function handleApi(req, res, pathname, deps = {}) {
  if (pathname !== ROUTE) return false
  require('./auth').applyCorsHeaders(req, res)
  try {
    const user = req.authUser
    if (!user || user.service || user.mcp) {
      throw fail(403, 'hrms_user_required', '只有已登录的脑图用户可以换取人事令牌')
    }
    if (req.method === 'GET') {
      sendJson(res, 200, await tokenStatus(req, deps))
      return true
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '只支持 GET 和 POST', code: 'method_not_allowed' })
      return true
    }
    const body = await readJson(req)
    const clientName = body.client_name || body.clientName
    const issued = await ensureAccessToken({
      req,
      env: deps.env,
      store: deps.store,
      fetchImpl: deps.fetchImpl,
      clientName
    })
    sendJson(res, 200, {
      ok: true,
      reused: issued.reused,
      ...publicView(issued)
    })
  } catch (err) {
    const status = err.statusCode || 500
    if (!err.statusCode) console.error('[hrms] token exchange failed')
    sendJson(res, status, {
      error: err.statusCode ? err.message : '换取人事系统令牌失败',
      code: err.code || 'hrms_token_failed'
    })
  }
  return true
}

module.exports = {
  ROUTE,
  readConfig,
  ensureAccessToken,
  resolveEmployee,
  callApi,
  handleApi,
  createMemoryStore,
  createPgStore,
  __test: {
    encryptToken,
    decryptToken,
    expectedHrmsUser,
    assertIssued,
    unwrapIssued,
    sessionSid,
    assertClientName,
    clearTokenCache() {
      tokenCache.clear()
    }
  }
}
