const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const test = require('node:test')
const mappingStore = require('../docmostMappingStore')

test('sync preserves human pages and rewrites standard links using slugs on repeated sync', async () => {
  const mappings = new Map()
  const requests = []
  const slugs = new Map()
  let manifest = {
    lastCompiledVersion: 'v1',
    downstream: { docmost: { spaceId: 'space', pages: {
      'branches/topic.md': { pageId: 'legacy-human', title: 'Human notes' }
    } } }
  }
  const docs = [
    { file: 'README.md', fileHash: 'root-hash', text: '# Root\n[Topic](branches/topic.md)' },
    { file: 'branches/topic.md', fileHash: 'topic-hash', text: '# Topic\nBody' }
  ]
  const fakeMapping = {
    ...mappingStore,
    ensureSchema: async () => {},
    getMapping: async (_db, row) => mappings.get(row.topicKey + ':' + row.slot),
    upsertMapping: async (_db, row) => {
      assert.equal(typeof row.docmostPageId, 'string')
      const saved = {
        topic_key: row.topicKey, slot: row.slot, owner: row.owner,
        docmost_page_id: row.docmostPageId, docmost_space_id: row.docmostSpaceId,
        content_hash: row.contentHash, title: row.title
      }
      mappings.set(row.topicKey + ':' + row.slot, saved)
      return saved
    },
    listRoomMappings: async () => [...mappings.values()]
  }
  const client = {
    cfg: () => ({ enabled: true }),
    getPool: () => ({ query: async () => ({ rows: [{ user_id: 'actor', role: 'admin' }] }) }),
    ensureSyncAuth: async () => ({ userId: 'actor', workspaceId: 'workspace' }),
    sanitizeSlug: () => 'personal',
    findSpaceBySlug: async () => ({ id: 'space', slug: 'personal' }),
    findPageSlugId: async (_db, id) => slugs.get(id),
    request: async (url, { body }) => {
      requests.push({ url, body })
      if (url === '/api/pages/create') {
        const id = 'page-' + slugs.size
        slugs.set(id, 'slug' + slugs.size)
        return { id, slugId: slugs.get(id) }
      }
      if (url === '/api/pages/update') {
        assert.notEqual(body.pageId, 'legacy-human')
        return {} // Exercise database slug lookup when the API omits it.
      }
      assert.notEqual(url, '/api/pages/delete')
      return {}
    }
  }
  const mocks = {
    '../docmostMappingStore': fakeMapping,
    './docmostClient': client,
    '../../roomAcl': { listMembers: async () => [] },
    './canonicalInput': { readCanonical: async () => ({ manifest, documents: docs }) },
    '../manifestStore': {
      recover: async () => {},
      readManifest: async () => manifest,
      atomicWrite: async (_file, data) => { manifest = JSON.parse(data) }
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(__dirname + '/docmostAdapter.js', 'utf8'), {
    module, require: id => mocks[id] || require(id),
    __dirname, process, console
  })
  const adapter = module.exports
  const pool = { query: async () => ({ rows: [{ room_key: 'room', title: 'Root', owner_id: 'owner' }] }) }
  for (let run = 0; run < 2; run++) {
    const start = requests.length
    await adapter.sync('room', { pool, env: {}, outputDir: '/unused' })
    const pages = manifest.downstream.docmost.pages
    const branch = pages['branches/topic.md']
    assert.equal(branch.slugId, slugs.get(branch.pageId))
    const update = requests.slice(start).filter(r => r.url === '/api/pages/update').at(-1)
    assert.equal(update.body.pageId, pages['README.md'].pageId)
    assert.ok(update.body.content.includes('/s/personal/p/'))
    assert.ok(update.body.content.includes('-' + branch.slugId + ')'))
    assert.ok(!update.body.content.includes('/p/' + branch.pageId))
    assert.ok([...mappings.values()].some(r => r.slot === 'human' && r.docmost_page_id === 'legacy-human'))
    if (run) assert.equal(requests.slice(start).filter(r => r.url === '/api/pages/create').length, 0)
  }
})
