const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { handleApi } = require('./api')
const { issueIdentity, verifyIdentity } = require('./access')

test('attachment proxy preserves personal identity, POST body and bounded upstream response', async t => {
  const previousSecret = process.env.WIKI_COMPILER_INTERNAL_SECRET
  const previousUrl = process.env.WIKI_COMPILER_INTERNAL_URL
  process.env.WIKI_COMPILER_INTERNAL_SECRET = 'attachment-proxy-test-secret-32-bytes'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WIKI_COMPILER_INTERNAL_SECRET
    else process.env.WIKI_COMPILER_INTERNAL_SECRET = previousSecret
    if (previousUrl === undefined) delete process.env.WIKI_COMPILER_INTERNAL_URL
    else process.env.WIKI_COMPILER_INTERNAL_URL = previousUrl
  })
  const received = []
  const upstream = http.createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    received.push({ path: req.url, user: verifyIdentity(req.headers['x-wiki-compiler-identity']), body: JSON.parse(body) })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', items: [], complete: false }))
  })
  const proxy = http.createServer(async (req, res) => {
    if (!await handleApi(req, res, req.url)) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => { proxy.closeAllConnections(); upstream.closeAllConnections(); proxy.close(); upstream.close() })
  process.env.WIKI_COMPILER_INTERNAL_URL = `http://127.0.0.1:${upstream.address().port}/`
  const url = `http://127.0.0.1:${proxy.address().port}/api/wiki-compiler/api/attachments/`
  const headers = { 'X-Wiki-Compiler-Identity': issueIdentity('alice'), 'Content-Type': 'application/json' }
  for (const operation of ['search', 'read']) {
    const body = { room_key: 'room-a', node_uid: 'n', attachment_id: 'a', query: '验收' }
    const response = await fetch(url + operation, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok', items: [], complete: false })
    assert.deepEqual(received.at(-1), { path: '/api/attachments/' + operation, user: 'alice', body })
  }
  assert.equal((await fetch(url + 'read', { headers })).status, 405)
  assert.equal((await fetch(url + 'delete', { method: 'POST', headers, body: '{}' })).status, 404)
  assert.equal((await fetch(url + 'read', { method: 'POST', headers: { ...headers, 'X-Wiki-Compiler-Identity': 'forged' }, body: '{}' })).status, 401)
  assert.equal(received.length, 2)
})
