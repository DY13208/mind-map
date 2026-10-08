const assert = require('assert')
const { handleCogneeSsoApi, readConfig, validAuthorization, authorizedClient } = require('../bin/cogneeSso')

const env = {
  MIND_MAP_COGNEE_SSO_SECRET: 'test-secret-'.repeat(4),
  COGNEE_SSO_REDIRECT_URI: 'https://xx.stillgroup.net:3030/sso/mind-map/callback'
}

async function run() {
  const config = readConfig(env)
  for (const uri of [
    'http://xx.stillgroup.net:3030/sso/mind-map/callback',
    'https://evil.invalid/oauth/callback',
    config.redirectUri + '?next=evil',
    config.redirectUri + '#evil'
  ]) {
    assert.throws(() => readConfig({ ...env, COGNEE_SSO_REDIRECT_URI: uri }))
  }
  assert.throws(() => readConfig({ ...env, MIND_MAP_COGNEE_SSO_SECRET: 'short' }))
  assert(authorizedClient('Bearer ' + env.MIND_MAP_COGNEE_SSO_SECRET, config.secret))
  assert(!authorizedClient('Bearer wrong', config.secret))
  const url = new URL('https://mind-map.invalid/api/auth/cognee/authorize')
  const params = {
    redirect_uri: config.redirectUri, state: 'a'.repeat(43),
    code_challenge: 'b'.repeat(43), code_challenge_method: 'S256'
  }
  url.search = new URLSearchParams(params)
  assert.equal(validAuthorization(url, config).state, params.state)
  for (const change of [
    { redirect_uri: 'https://evil.invalid/sso/mind-map/callback' },
    { state: 'short' }, { code_challenge_method: 'plain' }
  ]) {
    url.search = new URLSearchParams({ ...params, ...change })
    assert.throws(() => validAuthorization(url, config))
  }
  url.search = new URLSearchParams(params)
  Object.assign(process.env, env)
  const makeResponse = () => ({
    writeHead(status, headers) { this.status = status; this.headers = headers }, end() {}
  })
  const services = {
    authEnabled: true,
    authenticateRequest: async () => null,
    getPool: async () => { throw new Error('Unexpected database access') },
    sendJson(req, res, status, body) { res.status = status; res.body = body },
    readJsonBody: async () => { throw new Error('Unauthorized requests must not be read') }
  }
  const req = { url: url.pathname + url.search, method: 'GET', headers: {} }
  const res = makeResponse()
  assert(await handleCogneeSsoApi(req, res, services))
  assert.equal(res.status, 303)
  const location = new URL(res.headers.Location, url.origin)
  assert.equal(location.pathname, '/api/auth/login')
  assert.equal(location.searchParams.get('return_to'), req.url)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer')
  const denied = makeResponse()
  await handleCogneeSsoApi({ url: '/api/auth/cognee/exchange', method: 'POST', headers: {} }, denied, services)
  assert.equal(denied.status, 401)
  const disabled = makeResponse()
  await handleCogneeSsoApi(req, disabled, { ...services, authEnabled: false })
  assert.equal(disabled.status, 503)
  console.log('cognee SSO unit tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
