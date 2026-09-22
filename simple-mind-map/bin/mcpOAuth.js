const crypto = require('crypto')
const { issueKnowledgeMcpToken } = require('./knowledgeMcpToken')

const usedCodes = new Map()
const CODE_TTL_SECONDS = 5 * 60

function signingSecret(env = process.env) {
  return String(
    env.MCP_OAUTH_SECRET || env.AUTH_SESSION_SECRET || env.MCP_TOKEN || ''
  ).trim()
}

function b64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function signed(prefix, payload, secret) {
  const body = b64(payload)
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${prefix}.${body}.${signature}`
}

function verified(value, prefix, secret) {
  const parts = String(value || '').split('.')
  if (!secret || parts.length !== 3 || parts[0] !== prefix) return null
  const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest('base64url')
  const actualBuffer = Buffer.from(parts[2])
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (error) {
    return null
  }
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  return new URL(`${proto}://${host}`).origin
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function oauthError(res, status, error, description) {
  sendJson(res, status, { error, error_description: description })
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  })
  res.end()
}

function allowedRedirectUri(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'workbuddy:' ||
      ((url.protocol === 'http:' || url.protocol === 'https:') &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch (error) {
    return false
  }
}

function clientFromId(clientId, secret) {
  const client = verified(clientId, 'mcpc_v1', secret)
  if (!client || !Array.isArray(client.redirect_uris)) return null
  return client
}

function parseBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const contentType = String(req.headers['content-type'] || '')
      try {
        resolve(contentType.includes('application/json')
          ? JSON.parse(raw || '{}')
          : Object.fromEntries(new URLSearchParams(raw)))
      } catch (error) {
        reject(new Error('invalid_body'))
      }
    })
    req.on('error', reject)
  })
}

function pkceMatches(verifier, challenge) {
  if (!verifier || !challenge) return false
  const digest = crypto.createHash('sha256').update(String(verifier)).digest('base64url')
  return digest === String(challenge)
}

async function handleMcpOAuth(req, res, dependencies = {}) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname
  const origin = requestOrigin(req)
  const issuer = `${origin}`
  const secret = signingSecret()

  if (pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    sendJson(res, 200, {
      issuer,
      authorization_endpoint: `${origin}/api/mcp-oauth/authorize`,
      token_endpoint: `${origin}/api/mcp-oauth/token`,
      registration_endpoint: `${origin}/api/mcp-oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mind-map-wiki']
    })
    return true
  }

  if (pathname === '/api/mcp-oauth/register' && req.method === 'POST') {
    if (!secret) return oauthError(res, 503, 'server_error', 'OAuth signing secret is not configured')
    let body
    try { body = await parseBody(req) } catch (error) {
      return oauthError(res, 400, 'invalid_client_metadata', 'Invalid registration payload')
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
    if (!redirectUris.length || redirectUris.some(uri => !allowedRedirectUri(uri))) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'Unsupported redirect URI')
    }
    const metadata = {
      redirect_uris: redirectUris,
      client_name: String(body.client_name || 'MCP client').slice(0, 160),
      token_endpoint_auth_method: 'none'
    }
    sendJson(res, 201, { ...metadata, client_id: signed('mcpc_v1', metadata, secret) })
    return true
  }

  if (pathname === '/api/mcp-oauth/authorize' && req.method === 'GET') {
    if (!secret) return oauthError(res, 503, 'server_error', 'OAuth signing secret is not configured')
    const clientId = url.searchParams.get('client_id')
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state') || ''
    const challenge = url.searchParams.get('code_challenge')
    const client = clientFromId(clientId, secret)
    if (
      url.searchParams.get('response_type') !== 'code' ||
      url.searchParams.get('code_challenge_method') !== 'S256' ||
      !client || !client.redirect_uris.includes(redirectUri)
    ) return oauthError(res, 400, 'invalid_request', 'Invalid OAuth authorization request')

    const user = await dependencies.authenticateRequest(req)
    if (!user) {
      const returnTo = `${pathname}${url.search}`
      redirect(res, `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`)
      return true
    }
    const now = Math.floor(Date.now() / 1000)
    const code = signed('mcpa_v1', {
      uid: String(user.id), client_id: clientId, redirect_uri: redirectUri,
      code_challenge: challenge, iat: now, exp: now + CODE_TTL_SECONDS,
      jti: crypto.randomUUID()
    }, secret)
    const callback = new URL(redirectUri)
    callback.searchParams.set('code', code)
    if (state) callback.searchParams.set('state', state)
    redirect(res, callback.toString())
    return true
  }

  if (pathname === '/api/mcp-oauth/token' && req.method === 'POST') {
    if (!secret) return oauthError(res, 503, 'server_error', 'OAuth signing secret is not configured')
    let body
    try { body = await parseBody(req) } catch (error) {
      return oauthError(res, 400, 'invalid_request', 'Invalid token request')
    }
    if (body.grant_type !== 'authorization_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported')
    }
    const payload = verified(body.code, 'mcpa_v1', secret)
    const now = Math.floor(Date.now() / 1000)
    if (
      !payload || Number(payload.exp) < now || usedCodes.has(payload.jti) ||
      payload.client_id !== body.client_id || payload.redirect_uri !== body.redirect_uri ||
      !pkceMatches(body.code_verifier, payload.code_challenge)
    ) return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired')
    const accessToken = issueKnowledgeMcpToken(payload.uid)
    if (!accessToken) return oauthError(res, 503, 'server_error', 'Knowledge MCP is not configured')
    usedCodes.set(payload.jti, Number(payload.exp))
    for (const [id, exp] of usedCodes) if (exp < now) usedCodes.delete(id)
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'mind-map-wiki'
    })
    return true
  }

  return false
}

module.exports = { handleMcpOAuth, __test: { allowedRedirectUri, pkceMatches, signed, verified } }
