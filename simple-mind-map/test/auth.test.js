const assert = require('assert')

Object.assign(process.env, {
  WECOM_AUTH_ENABLED: 'true',
  WECOM_CORP_ID: 'wwcorp123456',
  WECOM_AGENT_ID: '1000002',
  WECOM_SECRET: 'test-secret-not-used-by-this-unit-test',
  WECOM_REDIRECT_URI: 'https://mindmap.example.com/api/auth/wecom/callback',
  WECOM_QR_STYLE_URL: 'https://static.example.com/wecom-login.css',
  AUTH_APP_ORIGIN: 'https://mindmap.example.com',
  AUTH_SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
  MCP_TOKEN: 'test-mcp-token-with-more-than-32-characters'
})

const { __test } = require('../bin/auth')

assert.strictEqual(
  __test.safeReturnTo('/?room=demo#/edit'),
  '/?room=demo#/edit'
)
assert.strictEqual(__test.safeReturnTo('https://evil.example/steal'), '/')
assert.strictEqual(__test.safeReturnTo('//evil.example/steal'), '/')

const signed = __test.signValue('oauth-state', 'nonce-value')
assert.strictEqual(
  __test.verifySignedValue('oauth-state', signed),
  'nonce-value'
)
assert.strictEqual(
  __test.verifySignedValue('oauth-state', `${signed.slice(0, -1)}x`),
  null
)
assert.strictEqual(__test.verifySignedValue('other-purpose', signed), null)

const loginUrl = new URL(__test.buildWecomLoginUrl(signed))
assert.strictEqual(loginUrl.origin, 'https://open.work.weixin.qq.com')
assert.strictEqual(loginUrl.pathname, '/wwopen/sso/qrConnect')
assert.strictEqual(loginUrl.searchParams.get('appid'), 'wwcorp123456')
assert.strictEqual(loginUrl.searchParams.get('agentid'), '1000002')
assert.strictEqual(
  loginUrl.searchParams.get('redirect_uri'),
  'https://mindmap.example.com/api/auth/wecom/callback'
)
assert.strictEqual(loginUrl.searchParams.get('state'), signed)
assert.strictEqual(
  loginUrl.searchParams.get('href'),
  'https://static.example.com/wecom-login.css'
)

const embeddedLoginUrl = new URL(
  __test.buildWecomLoginUrl(signed, { embedded: true })
)
assert.strictEqual(embeddedLoginUrl.searchParams.get('login_type'), 'jssdk')

assert.deepStrictEqual(__test.readConfig({ WECOM_AUTH_ENABLED: 'false' }), {
  enabled: false
})
assert.throws(
  () =>
    __test.readConfig({
      WECOM_AUTH_ENABLED: 'true',
      WECOM_CORP_ID: 'wwcorp123456'
    }),
  /WECOM_AGENT_ID/
)
assert.throws(
  () =>
    __test.readConfig({
      ...process.env,
      AUTH_SESSION_TTL_HOURS: '48',
      AUTH_SESSION_MAX_HOURS: '24'
    }),
  /不能小于/
)
assert.throws(
  () =>
    __test.readConfig({
      ...process.env,
      WECOM_QR_STYLE_URL: 'http://static.example.com/wecom-login.css'
    }),
  /HTTPS/
)

console.log('auth unit tests passed')
