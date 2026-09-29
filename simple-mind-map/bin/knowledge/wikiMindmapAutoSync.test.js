const assert = require('node:assert/strict')
const test = require('node:test')
const coordinator = require('./wikiMindmapSyncCoordinator')
const knowledge = require('./index')

test('coordinator debounce resolves immediately (does not await timer)', async () => {
  coordinator._resetForTests()
  let ran = false
  const syncFn = async () => {
    ran = true
    return { success: true, skipped: 1 }
  }
  const t0 = Date.now()
  const r = await coordinator.requestSync('p-debounce', {
    syncFn,
    debounceMs: 250
  })
  const elapsed = Date.now() - t0
  assert.equal(r.accepted, true)
  assert.equal(r.debounced_ms, 250)
  assert.ok(elapsed < 120, 'must not wait for debounce: ' + elapsed)
  assert.equal(ran, false)
  await new Promise(r => setTimeout(r, 320))
  assert.equal(ran, true)
  coordinator._resetForTests()
})

test('coordinator coalesces rapid enqueues into one sync', async () => {
  coordinator._resetForTests()
  let runs = 0
  const calls = []
  const syncFn = async pageId => {
    runs += 1
    calls.push(pageId)
    await new Promise(r => setTimeout(r, 40))
    return { success: true, page_id: pageId, updated: runs === 1 ? 1 : 0, skipped: runs === 1 ? 0 : 1 }
  }
  const a = coordinator.requestSync('p1', { syncFn, debounceMs: 0 })
  const b = coordinator.requestSync('p1', { syncFn, debounceMs: 0 })
  const c = coordinator.requestSync('p1', { syncFn, debounceMs: 0 })
  assert.equal((await a).accepted, true)
  assert.equal((await b).coalesced, true)
  assert.equal((await c).coalesced, true)
  const final = await coordinator.requestSyncAndWait('p1', { syncFn })
  assert.ok(runs >= 1)
  assert.ok(runs <= 2) // one run + optional dirty rerun
  assert.equal(final.success, true)
  coordinator._resetForTests()
})

test('enqueueWikiMindmapSync skips missing mapping', async () => {
  coordinator._resetForTests()
  const store = require('./docmostMappingStore')
  const orig = store.getMappingByPageId
  const origEnsure = store.ensureSchema
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => null
  try {
    const r = await knowledge.enqueueWikiMindmapSync('no-map', {
      pool: { query: async () => ({ rows: [] }) },
      debounceMs: 0,
      env: { WIKI_MINDMAP_AUTO_SYNC: 'true' }
    })
    assert.equal(r.accepted, false)
    assert.equal(r.error, 'MAPPING_NOT_FOUND')
  } finally {
    store.getMappingByPageId = orig
    store.ensureSchema = origEnsure
    coordinator._resetForTests()
  }
})

test('enqueueWikiMindmapSync rejects standard', async () => {
  coordinator._resetForTests()
  const store = require('./docmostMappingStore')
  const orig = store.getMappingByPageId
  const origEnsure = store.ensureSchema
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => ({
    slot: 'standard',
    owner: 'mindmap',
    docmost_page_id: 'p-std'
  })
  try {
    const r = await knowledge.enqueueWikiMindmapSync('p-std', {
      pool: { query: async () => ({ rows: [] }) },
      debounceMs: 0,
      env: { WIKI_MINDMAP_AUTO_SYNC: 'true' }
    })
    assert.equal(r.accepted, false)
    assert.equal(r.error, 'STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP')
  } finally {
    store.getMappingByPageId = orig
    store.ensureSchema = origEnsure
    coordinator._resetForTests()
  }
})

test('enqueueWikiMindmapSync human → syncFn with allowMove=false', async () => {
  coordinator._resetForTests()
  const store = require('./docmostMappingStore')
  const orig = store.getMappingByPageId
  const origEnsure = store.ensureSchema
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => ({
    slot: 'human',
    owner: 'human',
    docmost_page_id: 'p-h',
    room_id: 'room1',
    topic_key: 'branches/x.md'
  })
  let seen = null
  const service = {
    syncPageToMindmap: async opts => {
      seen = opts
      return {
        success: true,
        page_id: opts.pageId,
        updated: 1,
        created: 0,
        deleted: 0,
        moved: 0,
        skipped: 0
      }
    }
  }
  try {
    const enq = await knowledge.enqueueWikiMindmapSync('p-h', {
      pool: { query: async () => ({ rows: [] }) },
      service,
      debounceMs: 0,
      wait: true,
      env: { WIKI_MINDMAP_AUTO_SYNC: 'true' }
    })
    assert.equal(enq.success, true)
    assert.equal(seen.pageId, 'p-h')
    assert.equal(seen.allowMove, false)
    assert.equal(seen.allowDelete, true)
  } finally {
    store.getMappingByPageId = orig
    store.ensureSchema = origEnsure
    coordinator._resetForTests()
  }
})

test('enqueue failure does not throw to caller path', async () => {
  coordinator._resetForTests()
  const store = require('./docmostMappingStore')
  const orig = store.getMappingByPageId
  const origEnsure = store.ensureSchema
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => ({
    slot: 'human',
    owner: 'human',
    docmost_page_id: 'p-h'
  })
  const service = {
    syncPageToMindmap: async () => {
      throw new Error('db down')
    }
  }
  try {
    const enq = await knowledge.enqueueWikiMindmapSync('p-h', {
      pool: { query: async () => ({ rows: [] }) },
      service,
      debounceMs: 0,
      wait: true,
      env: { WIKI_MINDMAP_AUTO_SYNC: 'true' }
    })
    assert.equal(enq.success, false)
    assert.ok(enq.error)
  } finally {
    store.getMappingByPageId = orig
    store.ensureSchema = origEnsure
    coordinator._resetForTests()
  }
})

test('diffTrees allowMove=false skips MOVE ops', () => {
  const { diffTrees } = require('./wikiMindmapDiff')
  const current = {
    uid: 'root',
    text: 'R',
    note: '',
    children: [
      {
        uid: 'A',
        text: 'A',
        note: '',
        children: [{ uid: 'B', text: 'B', note: 'x', children: [] }]
      }
    ]
  }
  // Wiki flattens B under root (wrong parent) — would MOVE if allowed
  const desired = {
    text: 'R',
    nodeId: 'root',
    content: '',
    children: [
      { text: 'A', nodeId: 'A', content: '', children: [] },
      { text: 'B', nodeId: 'B', content: 'x', children: [] }
    ]
  }
  const withMove = diffTrees(desired, current, {
    branchRootUid: 'root',
    allowMove: true
  })
  assert.equal(withMove.ok, true)
  assert.ok(withMove.ops.move.length >= 1)

  const noMove = diffTrees(desired, current, {
    branchRootUid: 'root',
    allowMove: false
  })
  assert.equal(noMove.ok, true)
  assert.equal(noMove.ops.move.length, 0)
  assert.ok(noMove.skippedMoves.length >= 1)
})
