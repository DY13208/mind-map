const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const http = require('http')
const { handleMcpOAuth, __test } = require('../bin/mcpOAuth')

test('WorkBuddy deep links and loopback callbacks are accepted', () => {
  assert.equal(__test.allowedRedirectUri('workbuddy://workbuddy/mcp/custom-mcp%3Awiki/oauth/callback'), true)
  assert.equal(__test.allowedRedirectUri('http://127.0.0.1:43210/callback'), true)
  assert.equal(__test.allowedRedirectUri('https://evil.example/callback'), false)
})

test('signed OAuth values reject rotation and PKCE uses S256', () => {
  const value = __test.signed('mcpc_v1', { redirect_uris: ['workbuddy://callback'] }, 'secret-a')
  assert.deepEqual(__test.verified(value, 'mcpc_v1', 'secret-a').redirect_uris, ['workbuddy://callback'])
  assert.equal(__test.verified(value, 'mcpc_v1', 'secret-b'), null)
  const verifier = 'a-secure-pkce-verifier-with-enough-entropy-1234567890'
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  assert.equal(__test.pkceMatches(verifier, challenge), true)
  assert.equal(__test.pkceMatches('wrong', challenge), false)
})

test('dynamic registration, authorization callback and token exchange form a complete flow', async t => {
  const previous = {
    MCP_OAUTH_SECRET: process.env.MCP_OAUTH_SECRET,
    KNOWLEDGE_MCP_JWT_SECRET: process.env.KNOWLEDGE_MCP_JWT_SECRET
  }
  process.env.MCP_OAUTH_SECRET = 'oauth-test-secret-that-is-at-least-32-characters'
  process.env.KNOWLEDGE_MCP_JWT_SECRET = 'wiki-test-secret-that-is-at-least-32-characters'
  t.after(() => Object.assign(process.env, previous))

  const server = http.createServer((req, res) => {
    handleMcpOAuth(req, res, {
      authenticateRequest: async () => ({ id: 'user-1' })
    }).then(handled => {
      if (!handled) { res.writeHead(404); res.end() }
    }).catch(error => {
      res.writeHead(500); res.end(error.message)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const redirectUri = 'workbuddy://workbuddy/mcp/custom-mcp%3Awiki/oauth/callback'
  const registration = await fetch(`${origin}/api/mcp-oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'WorkBuddy' })
  }).then(response => response.json())
  assert.match(registration.client_id, /^mcpc_v1\./)

  const verifier = 'a-secure-pkce-verifier-with-enough-entropy-1234567890'
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL(`${origin}/api/mcp-oauth/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: registration.client_id,
    redirect_uri: redirectUri, state: 'state-1',
    code_challenge: challenge, code_challenge_method: 'S256'
  })
  const authResponse = await fetch(authorize, { redirect: 'manual' })
  const callback = new URL(authResponse.headers.get('location'))
  assert.equal(callback.protocol, 'workbuddy:')
  assert.equal(callback.searchParams.get('state'), 'state-1')

  const tokenResponse = await fetch(`${origin}/api/mcp-oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: callback.searchParams.get('code'),
      client_id: registration.client_id, redirect_uri: redirectUri,
      code_verifier: verifier
    })
  })
  const tokens = await tokenResponse.json()
  assert.equal(tokenResponse.status, 200)
  assert.equal(tokens.token_type, 'Bearer')
  const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(payload.sub, 'user-1')
  assert.equal(payload.exp, undefined)
})
