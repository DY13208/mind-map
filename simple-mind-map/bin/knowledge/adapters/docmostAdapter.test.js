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
        content_hash: row.contentHash, title: row.title,
        last_synced_version: row.lastSyncedVersion || ''
      }
      mappings.set(row.topicKey + ':' + row.slot, saved)
      return saved
    },
    bumpLastSyncedVersion: async (_db, row) => {
      const key = row.topicKey + ':' + (row.slot || 'standard')
      const cur = mappings.get(key)
      if (!cur) return null
      if (String(cur.last_synced_version || '') === String(row.lastSyncedVersion || '')) {
        return null
      }
      cur.last_synced_version = String(row.lastSyncedVersion || '')
      mappings.set(key, cur)
      return cur
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

test('Case3: unchanged content bumps last_synced_version without Docmost page API', async () => {
  const mappings = new Map()
  const requests = []
  const slugs = new Map([['page-readme', 's0'], ['page-topic', 's1']])
  let manifest = {
    lastCompiledVersion: 'V1',
    downstream: { docmost: { spaceId: 'space', pages: {} } }
  }
  const docs = [
    { file: 'README.md', fileHash: 'root-hash', text: '# Root\n' },
    { file: 'branches/topic.md', fileHash: 'topic-hash', text: '# Topic\nBody' }
  ]
  mappings.set('README:standard', {
    topic_key: 'README', slot: 'standard', owner: 'mindmap',
    docmost_page_id: 'page-readme', docmost_space_id: 'space',
    content_hash: 'root-hash', title: mappingStore.standardTitle('Root'),
    last_synced_version: 'V1'
  })
  mappings.set('branches/topic.md:standard', {
    topic_key: 'branches/topic.md', slot: 'standard', owner: 'mindmap',
    docmost_page_id: 'page-topic', docmost_space_id: 'space',
    content_hash: 'topic-hash', title: mappingStore.standardTitle('Topic'),
    last_synced_version: 'V1'
  })

  let branchUpserts = 0
  const fakeMapping = {
    ...mappingStore,
    ensureSchema: async () => {},
    getMapping: async (_db, row) => mappings.get(row.topicKey + ':' + row.slot),
    upsertMapping: async (_db, row) => {
      // README second-pass link rewrite may upsert; branch must stay bump-only.
      if (row.topicKey !== 'README') {
        branchUpserts += 1
        throw new Error('branch upsert should not run on content-unchanged path')
      }
      const saved = {
        topic_key: row.topicKey, slot: row.slot, owner: row.owner,
        docmost_page_id: row.docmostPageId, docmost_space_id: row.docmostSpaceId,
        content_hash: row.contentHash, title: row.title,
        last_synced_version: row.lastSyncedVersion || ''
      }
      mappings.set(row.topicKey + ':' + row.slot, saved)
      return saved
    },
    bumpLastSyncedVersion: async (_db, row) => {
      const key = row.topicKey + ':' + (row.slot || 'standard')
      const cur = mappings.get(key)
      if (!cur) return null
      if (String(cur.last_synced_version) === String(row.lastSyncedVersion)) return null
      cur.last_synced_version = String(row.lastSyncedVersion)
      return cur
    },
    listRoomMappings: async () => [...mappings.values()]
  }
  const client = {
    cfg: () => ({ enabled: true }),
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    ensureSyncAuth: async () => ({ userId: 'actor', workspaceId: 'workspace' }),
    sanitizeSlug: () => 'personal',
    findSpaceBySlug: async () => ({ id: 'space', slug: 'personal' }),
    findPageSlugId: async (_db, id) => slugs.get(id),
    request: async (url, { body }) => {
      requests.push({ url, body })
      if (url === '/api/pages/update') {
        // Only README second-pass rewrite is allowed to hit Docmost.
        assert.equal(body.pageId, 'page-readme')
        return {}
      }
      throw new Error('unexpected Docmost API: ' + url)
    }
  }
  const mocks = {
    '../docmostMappingStore': fakeMapping,
    './docmostClient': client,
    '../../roomAcl': { listMembers: async () => [] },
    './canonicalInput': {
      readCanonical: async () => ({
        manifest: { ...manifest, lastCompiledVersion: 'V2' },
        documents: docs
      })
    },
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
  const pool = {
    query: async () => ({
      rows: [{ room_key: 'room', title: 'Root', owner_id: 'owner' }]
    })
  }

  await adapter.sync('room', { pool, env: {}, outputDir: '/unused' })
  assert.equal(branchUpserts, 0)
  assert.equal(requests.filter(r => r.url === '/api/pages/create').length, 0)
  assert.equal(
    requests.filter(r => r.url === '/api/pages/update' && r.body.pageId === 'page-topic').length,
    0,
    'branch page must not be rewritten'
  )
  assert.equal(mappings.get('README:standard').last_synced_version, 'V2')
  assert.equal(mappings.get('branches/topic.md:standard').last_synced_version, 'V2')
})
