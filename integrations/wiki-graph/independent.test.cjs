const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { publishRoom, removeRoom } = require('../../simple-mind-map/bin/wikiCompiler/compiler')
const { issueIdentity } = require('../../simple-mind-map/bin/wikiCompiler/access')

test('all graph APIs enforce live ACL before search ranking and deny direct unauthenticated access', async t => {
  const { createWikiServer } = require('./server.cjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-http-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const input = id => ({ roomId: id, title: id, version: 1, revision: 0, topics: [
    { nodeUid: 'root', title: '预算', markdown: '## 预算\n预算成本', parentUid: null }] })
  const one = await publishRoom(dir, input('alice-room'))
  const hidden = await publishRoom(dir, input('bob-room'))
  let revoked = false
  const pool = { query: async (_sql, [user]) => ({ rows: revoked ? [] : [{ room_key: user + '-room' }] }) }
  const env = { WIKI_COMPILER_INTERNAL_SECRET: 'z'.repeat(64) }
  const server = createWikiServer({ dir, pool, env })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  assert.equal((await fetch(base + '/api/graph')).status, 401)
  const headers = { 'X-Wiki-Compiler-Identity': issueIdentity('alice', env), 'Content-Type': 'application/json' }
  const graph = await (await fetch(base + '/api/graph', { headers })).json()
  assert.deepEqual(graph.topics.map(x => x.slug), one.slugs)
  const search = await (await fetch(base + '/api/search', { method: 'POST', headers, body: JSON.stringify({ query: '预算', top_k: 1 }) })).json()
  assert.equal(search.results[0].topic, one.slugs[0])
  assert.equal(search.results[0].provenance.roomId, 'alice-room')
  assert.equal((await fetch(base + '/api/topic/' + hidden.slugs[0], { headers })).status, 404)
  assert.equal((await fetch(base + '/api/topic/' + one.slugs[0], { headers })).status, 200)
  revoked = true
  assert.equal((await fetch(base + '/api/topic/' + one.slugs[0], { headers })).status, 404)
  await removeRoom(dir, 'alice-room')
  revoked = false
  assert.equal((await fetch(base + '/api/topic/' + one.slugs[0], { headers })).status, 404)
})
