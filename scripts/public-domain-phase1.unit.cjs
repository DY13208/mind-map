const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const { publicAppOrigin } = require('../simple-mind-map/bin/publicAppOrigin')
const { createMcpDeviceConfigHandler } = require('../simple-mind-map/bin/mcpDeviceConfig')
const { verifyMcpUserToken } = require('../simple-mind-map/bin/mcpUserToken')

const origin = 'https://ai.stillgroup.net:8989'

test('public links preserve configured HTTPS origin and ignore internal/legacy ports', () => {
  assert.equal(publicAppOrigin({ AUTH_APP_ORIGIN: origin, PUBLIC_HOST: 'xx.stillgroup.net', WEB_PORT: '8990' }), origin)
  assert.equal(publicAppOrigin({ AUTH_APP_ORIGIN: 'https://ai.stillgroup.net/' }), 'https://ai.stillgroup.net')
  assert.equal(publicAppOrigin({}, 'https://other.example:8443'), 'https://other.example:8443')
  assert.equal(publicAppOrigin({ PUBLIC_HOST: '192.168.1.20', WEB_PORT: '8989' }), 'http://192.168.1.20:8989')
  assert.equal(publicAppOrigin({}), 'http://127.0.0.1:8989')
  for (const invalid of ['javascript:alert(1)', 'https://user:password@example.com', `${origin}/files`, `${origin}?a=1`, `${origin}#x`, 'ai.stillgroup.net']) {
    assert.throws(() => publicAppOrigin({ AUTH_APP_ORIGIN: invalid }))
  }
})

test('actual storage share URL uses the public origin and preserves room identifiers', () => {
  const before = { ...process.env }
  try {
    process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
    process.env.AUTH_APP_ORIGIN = origin
    process.env.PUBLIC_HOST = 'xx.stillgroup.net'
    process.env.WEB_PORT = '8990'
    const { shareUrl } = require('../simple-mind-map/bin/storage')
    const url = new URL(shareUrl('room-测试 &?/#'))
    assert.equal(url.origin, origin)
    assert.equal(url.searchParams.get('room'), 'room-测试 &?/#')
    assert.equal(url.hash, '')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
    Object.assign(process.env, before)
  }
})

test('device flow issued through the old host returns new authorization, poll and personal MCP URLs', async t => {
  const saved = process.env.AUTH_APP_ORIGIN
  process.env.AUTH_APP_ORIGIN = origin
  t.after(() => { if (saved === undefined) delete process.env.AUTH_APP_ORIGIN; else process.env.AUTH_APP_ORIGIN = saved })
  let time = 100000
  const handler = createMcpDeviceConfigHandler({ now: () => time, secret: () => 'synthetic-phase1-test-secret', authenticateRequest: async () => ({ id: 'phase1-user' }) })
  const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (url, options = {}) => {
    const target = new URL(url, base)
    return fetch(`${base}${target.pathname}${target.search}`, {
      ...options, headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'xx.stillgroup.net:8989', ...options.headers }
    })
  }
  const created = await request('/api/mcp-config/device', { method: 'POST' })
  assert.equal(created.status, 201)
  const device = await created.json()
  assert.equal(new URL(device.verification_uri).origin, origin)
  assert.equal(new URL(device.poll_uri).origin, origin)
  const html = await (await request(device.verification_uri)).text()
  const nonce = html.match(/name="nonce" value="([^"]+)"/)[1]
  assert.equal((await request(device.verification_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce }) })).status, 200)
  time += 3000
  const polled = await request(device.poll_uri, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: device.device_code }) })
  assert.equal(polled.status, 200)
  const entry = (await polled.json()).mcpServers['mind-map']
  assert.equal(entry.url, `${origin}/mcp`)
  assert.deepEqual(verifyMcpUserToken(entry.headers.Authorization.slice(7), 'synthetic-phase1-test-secret'), { userId: 'phase1-user' })
})

test('frontend MCP details, JSON, WorkBuddy instructions and share links follow the new page origin', () => {
  const saved = global.window
  global.window = { location: new URL(`${origin}/mcp-access`), __MIND_MAP_RUNTIME__: { gateway: true, host: 'xx.stillgroup.net' } }
  const root = path.resolve(__dirname, '../web')
  const webRequire = createRequire(path.join(root, 'package.json'))
  const babel = webRequire('@babel/core')
  const modules = new Map()
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    let source = fs.readFileSync(file, 'utf8')
    if (file.endsWith('.vue')) source = source.match(/<script>([\s\S]*?)<\/script>/)[1]
    const { code } = babel.transformSync(source, { filename: file, babelrc: false, configFile: false, plugins: [webRequire.resolve('@babel/plugin-transform-modules-commonjs')] })
    new Function('require', 'module', 'exports', code)(name => {
      // These transports are not called by the computed configuration preview.
      if (name.includes('/services/') || name === '@/services/apiError') return {}
      if (name.startsWith('@/')) return load(path.join(root, 'src', name.slice(2) + '.js'))
      return webRequire(name)
    }, module, module.exports)
    return module.exports
  }
  try {
    const config = load(path.join(root, 'src/utils/runtimeConfig.js')).getRuntimeConfig()
    assert.equal(config.appUrl, origin)
    assert.equal(config.collabApi, origin)
    assert.equal(config.mcpUrl, `${origin}/mcp`)
    assert.equal(config.collabUrl, 'wss://ai.stillgroup.net:8989/collab')
    const component = load(path.join(root, 'src/pages/ProductShell/McpAccessPage.vue')).default
    const data = { ...component.data(), token: 'synthetic-personal-token', wikiToken: 'synthetic-wiki-token', wikiConfigured: true }
    data.wikiMcpUrl = component.computed.wikiMcpUrl.call(data)
    data.kbIncluded = false
    const json = JSON.parse(component.computed.configText.call(data))
    assert.equal(json['mind-map'].url, `${origin}/mcp`)
    assert.equal(json['mind-map-wiki'].url, `${origin}/knowledge-mcp/mcp`)
    const instructions = component.computed.workbuddySetupText.call(data)
    assert.ok(instructions.includes(`${origin}/api/mcp-config/device`))
    assert.ok(!instructions.includes('xx.stillgroup.net'))
    const { buildInviteUrl } = load(path.join(root, 'src/utils/roomLocation.js'))
    assert.equal(new URL(buildInviteUrl('room-phase1', config.appUrl)).origin, origin)
    const sfc = fs.readFileSync(path.join(root, 'src/pages/Edit/components/NodeShareDialog.vue'), 'utf8')
    const source = sfc.match(/function shareLink\(id, token\) \{[\s\S]*?\n\}/)[0]
    const shareLink = new Function(`${source}; return shareLink`)()
    const link = new URL(shareLink('share-1', 'synthetic/token?'))
    assert.equal(link.origin, origin)
    assert.equal(link.pathname, '/node-share/share-1')
    assert.equal(link.searchParams.get('token'), 'synthetic/token?')
  } finally {
    if (saved === undefined) delete global.window; else global.window = saved
  }
})

test('WeCom configuration accepts the new exact callback origin', () => {
  const { readConfig } = require('../simple-mind-map/bin/auth').__test
  const config = readConfig({
    WECOM_AUTH_ENABLED: 'true', WECOM_CORP_ID: 'ww-phase1', WECOM_AGENT_ID: '1000002',
    WECOM_SECRET: 'synthetic-wecom-secret', WECOM_REDIRECT_URI: `${origin}/api/auth/wecom/callback`,
    AUTH_APP_ORIGIN: origin, AUTH_ALLOWED_ORIGINS: `${origin},https://xx.stillgroup.net:8989`,
    AUTH_SESSION_SECRET: 'synthetic-phase1-session-secret-at-least-32',
    MCP_TOKEN: 'synthetic-phase1-mcp-token-at-least-32', AUTH_COOKIE_SECURE: 'true'
  })
  assert.equal(config.appOrigin, origin)
  assert.equal(config.redirectUri, `${origin}/api/auth/wecom/callback`)
  assert.ok(config.allowedOrigins.includes('https://xx.stillgroup.net:8989'))
})
