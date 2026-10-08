/** Mind-map is Cognee's WeCom identity provider; credentials stay in mind-map. */
const crypto = require('crypto')

const CODE_TTL_SECONDS = 90

class SsoError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

function readConfig(env = process.env) {
  const secret = String(env.MIND_MAP_COGNEE_SSO_SECRET || '').trim()
  let callback
  try {
    callback = new URL(String(env.COGNEE_SSO_REDIRECT_URI || ''))
  } catch (_) {
    throw new SsoError('cognee_sso_not_configured', 503)
  }
  if (
    secret.length < 32 || callback.protocol !== 'https:' ||
    callback.username || callback.password || callback.search || callback.hash ||
    callback.pathname !== '/sso/mind-map/callback'
  ) throw new SsoError('cognee_sso_not_configured', 503)
  return { secret, redirectUri: callback.href }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'ascii').digest('base64url')
}

function validAuthorization(url, config) {
  const state = url.searchParams.get('state') || ''
  const challenge = url.searchParams.get('code_challenge') || ''
  if (
    url.searchParams.get('redirect_uri') !== config.redirectUri ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    url.searchParams.get('code_challenge_method') !== 'S256'
  ) throw new SsoError('invalid_sso_request')
  return { state, challenge }
}

async function initStore(pool) {
  await pool.query(`create table if not exists auth_cognee_codes (
    code_hash text primary key,
    user_id text not null references wecom_users(user_id) on delete cascade,
    code_challenge text not null,
    redirect_uri text not null,
    expires_at timestamptz not null
  )`)
  await pool.query(`create index if not exists auth_cognee_codes_expiry_idx
    on auth_cognee_codes(expires_at)`)
}

async function issueCode(pool, user, challenge, redirectUri) {
  if (!user.corpId || !user.wecomUserId || user.service || user.mcp) {
    throw new SsoError('wecom_identity_required', 403)
  }
  const code = crypto.randomBytes(32).toString('base64url')
  await pool.query('delete from auth_cognee_codes where expires_at <= now()')
  await pool.query(
    `insert into auth_cognee_codes
      (code_hash, user_id, code_challenge, redirect_uri, expires_at)
     values ($1, $2, $3, $4, now() + $5::int * interval '1 second')`,
    [sha256(code), user.id, challenge, redirectUri, CODE_TTL_SECONDS]
  )
  return code
}

async function consumeCode(pool, payload, config) {
  const { code, code_verifier: verifier, redirect_uri: redirectUri } = payload
  if (
    typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code) ||
    typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    redirectUri !== config.redirectUri
  ) throw new SsoError('invalid_grant')
  // DELETE RETURNING is atomic: only one backend/process can redeem a code.
  const result = await pool.query(
    `with redeemed as (
      delete from auth_cognee_codes
      where code_hash = $1 and code_challenge = $2 and redirect_uri = $3
        and expires_at > now()
      returning user_id
    ) select u.corp_id, u.wecom_userid, u.name
      from redeemed r join wecom_users u on u.user_id = r.user_id`,
    [sha256(code), sha256(verifier), redirectUri]
  )
  const user = result.rows[0]
  if (!user || !user.corp_id || !user.wecom_userid) throw new SsoError('invalid_grant')
  return {
    sub: `wecom:${user.corp_id}:${user.wecom_userid}`,
    corp_id: user.corp_id,
    wecom_userid: user.wecom_userid,
    name: user.name
  }
}

function authorizedClient(header, secret) {
  const actual = Buffer.from(String(header || ''))
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

async function handleCogneeSsoApi(req, res, services) {
  const url = new URL(req.url, 'http://mind-map.local')
  if (!url.pathname.startsWith('/api/auth/cognee/')) return false
  const { getPool, authenticateRequest, sendJson, readJsonBody, authEnabled } = services
  try {
    const config = readConfig()
    if (!authEnabled) throw new SsoError('wecom_login_required', 503)
    if (url.pathname === '/api/auth/cognee/authorize' && req.method === 'GET') {
      const { state, challenge } = validAuthorization(url, config)
      // The existing WeCom callback adds auth_error to return_to on failure.
      // Return to Cognee once instead of immediately starting another QR login.
      if (url.searchParams.has('auth_error')) {
        const callback = new URL(config.redirectUri)
        callback.searchParams.set('error', 'wecom_login_failed')
        callback.searchParams.set('state', state)
        res.writeHead(303, {
          Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        })
        res.end()
        return true
      }
      const user = await authenticateRequest(req)
      if (!user) {
        const login = /MicroMessenger/i.test(String(req.headers['user-agent'] || ''))
          ? '/api/auth/wecom/client-login' : '/api/auth/login'
        res.writeHead(303, {
          Location: `${login}?return_to=${encodeURIComponent(url.pathname + url.search)}`,
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        })
        res.end()
        return true
      }
      const pool = await getPool()
      const code = await issueCode(pool, user, challenge, config.redirectUri)
      const callback = new URL(config.redirectUri)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', state)
      res.writeHead(303, {
        Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
      })
      res.end()
      return true
    }
    if (url.pathname === '/api/auth/cognee/exchange' && req.method === 'POST') {
      if (!authorizedClient(req.headers.authorization, config.secret)) {
        throw new SsoError('invalid_client', 401)
      }
      const payload = await readJsonBody(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new SsoError('invalid_grant')
      }
      const profile = await consumeCode(await getPool(), payload, config)
      sendJson(req, res, 200, profile)
      return true
    }
    throw new SsoError('not_found', 404)
  } catch (error) {
    const known = error instanceof SsoError
    sendJson(req, res, known ? error.status : 500, {
      code: known ? error.code : 'cognee_sso_failed',
      error: known ? error.code : '企业微信单点登录暂时不可用'
    })
    return true
  }
}

module.exports = {
  CODE_TTL_SECONDS, SsoError, readConfig, sha256, validAuthorization,
  initStore, issueCode, consumeCode, authorizedClient, handleCogneeSsoApi
}
