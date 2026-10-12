const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { createMcpDeviceConfigHandler } = require('../bin/mcpDeviceConfig')
const { verifyMcpUserToken } = require('../bin/mcpUserToken')

test('device authorization requires login and confirmation, then returns personal config once', async t => {
  let clock = 100000
  const handler = createMcpDeviceConfigHandler({
    now: () => clock, secret: () => 'test-secret',
    authenticateRequest: async req => req.headers['x-test-user'] ? { id: req.headers['x-test-user'] } : null
  })
  const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const create = async () => {
    const r = await fetch(`${origin}/api/mcp-config/device`, { method: 'POST' })
    assert.equal(r.status, 201)
    return r.json()
  }
  const device = await create()
  assert.ok(!device.verification_uri.includes(device.device_code))
  const poll = code => fetch(device.poll_uri, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: code }) })
  assert.equal((await poll('wrong')).status, 400)
  assert.equal((await poll(device.device_code)).status, 202)
  assert.equal((await poll(device.device_code)).status, 429)
  const redirect = await fetch(device.verification_uri, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.ok(redirect.headers.get('location').startsWith('/api/auth/login?return_to='))
  const page = await fetch(device.verification_uri, { headers: { 'x-test-user': 'user-a' } })
  const html = await page.text()
  assert.ok(html.includes(device.user_code))
  assert.ok(!html.includes(device.device_code))
  const nonce = html.match(/name="nonce" value="([^"]+)"/)[1]
  const confirm = (user, value) => fetch(device.verification_uri, { method: 'POST', headers: { 'x-test-user': user, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce: value }) })
  assert.equal((await confirm('user-a', 'wrong')).status, 403)
  assert.equal((await confirm('user-b', nonce)).status, 403)
  clock += 3000
  assert.equal((await poll(device.device_code)).status, 202)
  assert.equal((await confirm('user-a', nonce)).status, 200)
  assert.equal((await confirm('user-a', nonce)).status, 403)
  clock += 3000
  const result = await poll(device.device_code)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const config = (await result.json()).mcpServers['mind-map']
  assert.equal(config.url, `${origin}/mcp`)
  assert.deepEqual(verifyMcpUserToken(config.headers.Authorization.slice(7), 'test-secret'), { userId: 'user-a' })
  assert.equal((await poll(device.device_code)).status, 400)
  const expired = await create()
  clock += 300001
  assert.equal((await poll(expired.device_code)).status, 400)
  assert.equal((await fetch(expired.verification_uri)).status, 400)
})
