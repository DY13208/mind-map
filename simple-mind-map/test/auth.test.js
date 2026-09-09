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
assert.throws(
  () =>
    __test.readConfig({
      ...process.env,
      AUTH_DEV_BYPASS_KEY: 'too-short'
    }),
  /AUTH_DEV_BYPASS_KEY/
)
assert.throws(
  () =>
    __test.readConfig({
      ...process.env,
      AUTH_DEV_BYPASS_MOBILE: '12345'
    }),
  /AUTH_DEV_BYPASS_MOBILE/
)
assert.strictEqual(__test.normalizeMobileForWecom('13800138000'), '13800138000')
assert.strictEqual(__test.normalizeMobileForWecom('+8613800138000'), '13800138000')
assert.strictEqual(__test.normalizeMobileForWecom('8613800138000'), '13800138000')
assert.strictEqual(__test.normalizeMobileForWecom('138-0013-8000'), '13800138000')
assert.strictEqual(__test.normalizeMobileForWecom('not-a-phone'), '')
{
  const withMobile = __test.readConfig({
    ...process.env,
    AUTH_DEV_BYPASS_KEY: 'yiran-dev-local-bypass-key-2026-stillgroup',
    AUTH_DEV_BYPASS_MOBILE: '+86 138-0013-8000'
  })
  assert.strictEqual(withMobile.devBypassMobile, '13800138000')
}

assert.strictEqual(__test.isPrivateOrLocalHost('localhost'), true)
assert.strictEqual(__test.isPrivateOrLocalHost('127.0.0.1:1234'), true)
assert.strictEqual(__test.isPrivateOrLocalHost('192.168.1.20'), true)
assert.strictEqual(__test.isPrivateOrLocalHost('10.0.0.8'), true)
assert.strictEqual(__test.isPrivateOrLocalHost('mindmap.example.com'), false)

const ipDeniedError = __test.createWecomResponseError(
  {
    errcode: 60020,
    errmsg: 'not allow to access from your ip, from ip: 203.0.113.8'
  },
  'wecom_identity_failed',
  '企业微信身份校验失败'
)
assert.strictEqual(ipDeniedError.code, 'wecom_ip_not_allowed')
assert.strictEqual(ipDeniedError.status, 503)
assert.match(ipDeniedError.message, /60020/)
assert.match(ipDeniedError.message, /203\.0\.113\.8/)

const genericIdentityError = __test.createWecomResponseError(
  { errcode: 40029, errmsg: 'invalid code' },
  'wecom_identity_failed',
  '企业微信身份校验失败'
)
assert.strictEqual(genericIdentityError.code, 'wecom_identity_failed')
assert.match(genericIdentityError.message, /40029/)

const missingResponseError = __test.createWecomResponseError(
  null,
  'wecom_identity_failed',
  '企业微信身份校验失败'
)
assert.match(missingResponseError.message, /unknown/)

const cfg = __test.readConfig(process.env)
const reqWithForwardedHost = {
  headers: {
    origin: 'http://xx.stillgroup.net:8989',
    host: 'xx.stillgroup.net',
    'x-forwarded-host': 'xx.stillgroup.net:8989',
    'x-forwarded-proto': 'http'
  }
}
assert.strictEqual(
  __test.isAllowedOriginFor(
    reqWithForwardedHost,
    'http://xx.stillgroup.net:8989',
    cfg
  ),
  true
)
assert.strictEqual(
  __test.isAllowedOriginFor(
    reqWithForwardedHost,
    'http://xx.stillgroup.net:8989',
    { ...cfg, appOrigin: 'http://xx.stillgroup.net' }
  ),
  true
)
assert.strictEqual(
  __test.isAllowedOriginFor(
    { headers: { host: 'xx.stillgroup.net', 'x-forwarded-proto': 'http' } },
    'http://xx.stillgroup.net:8989',
    { ...cfg, appOrigin: 'http://192.168.0.204:8989' }
  ),
  true
)
assert.strictEqual(
  __test.isAllowedOriginFor(
    { headers: { host: 'xx.stillgroup.net:8989', 'x-forwarded-proto': 'http' } },
    'http://evil.example.com:8989',
    cfg
  ),
  false
)
assert.strictEqual(
  __test.isAllowedOriginFor(
    { headers: { host: 'xx.stillgroup.net:8989', 'x-forwarded-proto': 'http' } },
    'http://xx.stillgroup.net:8989',
    {
      enabled: true,
      appOrigin: 'http://192.168.0.204:8989',
      allowedOrigins: ['http://xx.stillgroup.net:8989']
    }
  ),
  true
)
assert.strictEqual(__test.originsEquivalent(
  'http://xx.stillgroup.net:8989',
  'http://xx.stillgroup.net'
), true)
assert.strictEqual(__test.originsEquivalent(
  'http://xx.stillgroup.net:8080',
  'http://xx.stillgroup.net:8989'
), false)

assert.strictEqual(
  __test.wecomAvatarUrl({
    avatar: 'https://wework.qpic.cn/photo.png',
    thumb_avatar: 'https://wework.qpic.cn/thumb.png'
  }),
  'https://wework.qpic.cn/photo.png'
)
assert.strictEqual(
  __test.wecomAvatarUrl({ thumb_avatar: 'https://wework.qpic.cn/thumb.png' }),
  'https://wework.qpic.cn/thumb.png'
)
assert.strictEqual(__test.wecomAvatarUrl({ avatar: '张' }), '')
assert.strictEqual(__test.wecomAvatarUrl(null), '')

const logoutReq = {
  headers: {
    origin: 'http://192.168.1.20:8081',
    'sec-fetch-site': 'same-origin',
    host: '192.168.1.20:1234'
  }
}
assert.strictEqual(__test.isLogoutRequestAllowed(logoutReq), true)
assert.strictEqual(
  __test.isLogoutRequestAllowed({
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }
  }),
  false
)
assert.strictEqual(
  __test.isTopLevelNavigation({ headers: { 'sec-fetch-dest': 'document' } }),
  true
)
assert.strictEqual(
  __test.isTopLevelNavigation({ headers: { 'sec-fetch-dest': 'image' } }),
  false
)
assert.strictEqual(
  __test.logoutRedirectUrl(
    {
      headers: {
        host: '127.0.0.1:1234',
        referer: 'http://127.0.0.1:8081/edit',
        'x-forwarded-proto': 'http'
      }
    },
    '/files'
  ),
  'http://127.0.0.1:8081/files'
)

assert.strictEqual(
  __test.logoutRedirectUrl(
    {
      headers: {
        host: '127.0.0.1:1234',
        referer: 'http://localhost:8081/edit',
        'x-forwarded-proto': 'http'
      }
    },
    '/files'
  ),
  'http://localhost:8081/files'
)
assert.strictEqual(__test.hostnamesEquivalent('localhost', '127.0.0.1'), true)

console.log('auth unit tests passed')
