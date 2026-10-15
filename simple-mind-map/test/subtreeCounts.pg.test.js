const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { randomUUID } = require('node:crypto')
const { createHarness, request, isolatedInstance } = require('./performanceBackendHarness')
let app
before(async () => { app = await createHarness() })
after(async () => { if (app) await app.close() })

function planRowTotals (plan) {
  const rows = []
  const visit = node => {
    rows.push({ type: node['Node Type'], cte: node['CTE Name'], relation: node['Relation Name'],
      rows: (Number(node['Actual Rows']) || 0) * (Number(node['Actual Loops']) || 0) })
    for (const child of node.Plans || []) visit(child)
  }
  visit(plan.Plan)
  return rows
}

function chainGraph (N) {
  const graph = {}
  for (let i = 0; i < N; i++) graph[`chain-${i}`] = {
    isRoot: i === 0, data: { uid: `chain-${i}`, text: `chain ${i}` },
    children: i + 1 < N ? [`chain-${i + 1}`] : []
  }
  return graph
}

// Tracing db wrapper: EXPLAINs whichever count query the product actually runs
// (root single-pass or non-root recursive), never a hardcoded expected SQL.
function countingDb (app, executed) {
  return { query: async (sql, params) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    if (/^select uid, parent_uid from room_nodes/i.test(normalized) || /with recursive relevant/i.test(normalized)) {
      const explained = await app.pool.query('explain (analyze, buffers, format json) ' + sql, params)
      executed.push({ sql: normalized, plan: explained.rows[0]['QUERY PLAN'][0] })
    }
    return app.pool.query(sql, params)
  } }
}

test('R16 shallow pagination reports full child and descendant totals rather than loaded lengths', async () => {
  const { roomKey } = await app.seed()
  const result = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&offset=2&limit=2`)
  assert.equal(result.status, 200)
  assert.equal(result.body.total, 5)
  assert.equal(result.body.descendantCount, 15)
  assert.deepEqual(result.body.children.map(node => node.data.uid), ['child-2', 'child-3'])
  assert.equal(result.body.has_more, true)
  for (const child of result.body.children) {
    assert.equal(child.children.length, 0)
    assert.equal(child.data.childCount, 2)
    assert.equal(child.data.descendantCount, 2)
  }
  const last = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&offset=4&limit=2`)
  assert.equal(last.body.total, 5)
  assert.equal(last.body.children.length, 1)
  assert.equal(last.body.has_more, false)
  const unchanged = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&knownVersion=7`)
  assert.equal(unchanged.body.unchanged, true)
  assert.equal(unchanged.body.version, 7)
})

test('R16 clipped deep tree and safe preview retain full authority counts', async () => {
  const { roomKey } = await app.seed()
  const result = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&deep=1&max_nodes=3`)
  assert.equal(result.status, 200)
  assert.equal(result.body.tree.data.childCount, 5)
  assert.equal(result.body.tree.data.descendantCount, 15)
  const preview = await request(app.base, `/api/files/${roomKey}/preview?safe=1`)
  assert.equal(preview.status, 200)
  assert.equal(preview.body.tree.data.childCount, 2)
  assert.equal(preview.body.tree.data.descendantCount, 999)
})

test('R17 repeated same-revision local subtree read does not transfer the whole room edge set', async t => {
  const { roomKey } = await app.seed(1000)
  const route = `/api/files/${roomKey}/subtree?uid=target&offset=0&limit=2`
  const first = await request(app.base, route)
  assert.equal(first.status, 200)
  app.observer.reset()
  const second = await request(app.base, route)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body)
  const trace = app.observer.trace()
  const edgeReads = trace.sql.filter(row => /^select uid, parent_uid from room_nodes/i.test(row.sql))
  const countReads = trace.sql.filter(row => /with recursive relevant as/i.test(row.sql))
  t.diagnostic(JSON.stringify({ case: 'R17', N: 1000, M: 3, C: 5, S: 15, edgeReads, countReads }))
  assert.equal(edgeReads.reduce((sum, item) => sum + item.rows, 0), 0,
    'R17 warm local request re-enumerated unrelated room edges into Node')
  assert.equal(countReads.length, 0, 'R17 warm same-scope counts must reuse their revision/generation result')
})

test('R17 cold root-scope deep chain reads the live edge set once and keeps exact overlapping totals', async t => {
  const { roomKey } = await app.seed(20)
  const N = 500
  await app.storage.replaceRoomNodes(roomKey, chainGraph(N), 7)
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const executed = []
  const counts = await readSelectedNodeCounts(countingDb(app, executed), roomKey, ['chain-0', 'chain-1', 'chain-250'])
  assert.equal(counts.get('chain-0').descendantCount, 499)
  assert.equal(counts.get('chain-1').descendantCount, 498)
  assert.equal(counts.get('chain-250').descendantCount, 249)
  const edgeReads = executed.filter(item => /^select uid, parent_uid from room_nodes where room_key = \$1 and deleted_at is null$/i.test(item.sql))
  const recursiveReads = executed.filter(item => /with recursive relevant/i.test(item.sql))
  assert.equal(edgeReads.length, 1, 'a real-root scope must read the live edge set exactly once')
  assert.equal(recursiveReads.length, 0, 'a real-root scope must not use the per-node recursive read')
  const rows = planRowTotals(edgeReads[0].plan)
  t.diagnostic(JSON.stringify({ case: 'R17-chain-root', N, M: 3, S: N, largestIntermediateRows: Math.max(...rows.map(row => row.rows)), rows }))
  assert.ok(Math.max(...rows.map(row => row.rows)) <= N * 10,
    'cold root-scope count expanded overlapping ancestor paths quadratically in PostgreSQL')
})

test('R17 cold non-root overlapping deep chain keeps the targeted recursive read with a linear intermediate-row budget', async t => {
  const { roomKey } = await app.seed(20)
  const N = 500
  await app.storage.replaceRoomNodes(roomKey, chainGraph(N), 7)
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const executed = []
  const counts = await readSelectedNodeCounts(countingDb(app, executed), roomKey, ['chain-1', 'chain-2'])
  assert.equal(counts.get('chain-1').descendantCount, 498)
  assert.equal(counts.get('chain-2').descendantCount, 497)
  const edgeReads = executed.filter(item => /^select uid, parent_uid from room_nodes where room_key = \$1 and deleted_at is null$/i.test(item.sql))
  const recursiveReads = executed.filter(item => /with recursive relevant/i.test(item.sql))
  assert.equal(recursiveReads.length, 1, 'a non-root scope must use the targeted recursive read')
  assert.equal(edgeReads.length, 0, 'a non-root scope must not enumerate the whole room')
  const rows = planRowTotals(recursiveReads[0].plan)
  t.diagnostic(JSON.stringify({ case: 'R17-chain-nonroot', N, M: 2, S: N - 1, largestIntermediateRows: Math.max(...rows.map(row => row.rows)), rows }))
  assert.ok(Math.max(...rows.map(row => row.rows)) <= N * 10,
    'cold non-root chain count expanded overlapping ancestor paths quadratically in PostgreSQL')
})

test('R17 a literal child named root is not treated as the real root scope', async () => {
  const graph = {}
  const node = (uid, children, isRoot) => { graph[uid] = { isRoot: !!isRoot, data: { uid, text: uid }, children } }
  node('boss', ['root', 'other'], true)
  node('root', ['root-child'])
  node('root-child')
  node('other', ['other-child'])
  node('other-child')
  const { roomKey } = await app.seed(20, graph)
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const executed = []
  const counts = await readSelectedNodeCounts(countingDb(app, executed), roomKey, ['root'])
  assert.equal(counts.get('root').childCount, 1)
  assert.equal(counts.get('root').descendantCount, 1, 'counts must cover only that nodes subtree')
  assert.equal(executed.filter(item => /with recursive relevant/i.test(item.sql)).length, 1,
    'a child literally named root is not a root scope')
  assert.equal(executed.filter(item => /^select uid, parent_uid from room_nodes where room_key = \$1 and deleted_at is null$/i.test(item.sql)).length, 0,
    'a child literally named root must not enumerate the whole room')
})

test('R17 a live null-parent orphan is not treated as the real root scope', async () => {
  const graph = {}
  const node = (uid, children, isRoot) => { graph[uid] = { isRoot: !!isRoot, data: { uid, text: uid }, children } }
  node('real-root', ['branch', 'null-parent-orphan'], true)
  node('branch', ['branch-child'])
  node('branch-child')
  node('null-parent-orphan', ['orphan-child'])
  node('orphan-child')
  const { roomKey } = await app.seed(20, graph)
  // Detach the orphan: parent_uid null but is_root stays false, so the DB root
  // authority (is_root column) still identifies real-root as the only root.
  await app.pool.query(`update room_nodes set parent_uid = null, is_root = false where room_key = $1 and uid = 'null-parent-orphan'`, [roomKey])
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const executed = []
  const counts = await readSelectedNodeCounts(countingDb(app, executed), roomKey, ['null-parent-orphan'])
  assert.equal(counts.get('null-parent-orphan').childCount, 1)
  assert.equal(counts.get('null-parent-orphan').descendantCount, 1)
  assert.equal(executed.filter(item => /with recursive relevant/i.test(item.sql)).length, 1,
    'a null-parent orphan is not a root scope')
  assert.equal(executed.filter(item => /^select uid, parent_uid from room_nodes where room_key = \$1 and deleted_at is null$/i.test(item.sql)).length, 0,
    'a null-parent orphan must not enumerate the whole room')
})

test('R17 root scope excludes deleted leaves and live orphans from exact counts', async () => {
  const graph = {}
  const node = (uid, children, isRoot) => { graph[uid] = { isRoot: !!isRoot, data: { uid, text: uid }, children } }
  node('r', ['a', 'leaf-gone', 'orp'], true)
  node('a', ['a1'])
  node('a1')
  node('leaf-gone')
  node('orp', ['orp1'])
  node('orp1')
  const { roomKey } = await app.seed(20, graph)
  // A deleted leaf and a live orphan whose parent does not exist are not root descendants.
  await app.pool.query(`update room_nodes set deleted_at = now() where room_key = $1 and uid = 'leaf-gone'`, [roomKey])
  await app.pool.query(`update room_nodes set parent_uid = 'ghost-parent' where room_key = $1 and uid = 'orp'`, [roomKey])
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const counts = await readSelectedNodeCounts({ query: (sql, params) => app.pool.query(sql, params) }, roomKey, ['r', 'orp'])
  assert.equal(counts.get('r').childCount, 1, 'deleted leaf must not count as a direct child')
  assert.equal(counts.get('r').descendantCount, 2, 'only r -> a -> a1 are root descendants (never rows.length - 1)')
  assert.equal(counts.get('orp').descendantCount, 1, 'a live orphan subtree still resolves for its own scope')
})

test('R17 childCountQueryCount reports every count SQL statement actually executed and stays 0 on a cache hit', async () => {
  const { roomKey } = await app.seed()
  const { readSelectedNodeCounts } = require('../bin/roomNodes')
  const meta = { version: 1, node_counts_generation: 1 }
  let traced = 0
  const db = { query: async (sql, params) => { traced += 1; return app.pool.query(sql, params) } }
  const cold = await readSelectedNodeCounts(db, roomKey, ['target'], meta)
  assert.equal(traced, 2, 'a cold count issues the root probe plus the targeted read')
  assert.equal(cold.queryCount, traced, 'childCountQueryCount must report the real statement count')
  const warm = await readSelectedNodeCounts(db, roomKey, ['target'], meta)
  assert.equal(warm.queryCount, 0, 'a cache hit issues no count SQL')
  assert.equal(traced, 2, 'a cache hit must not issue SQL')
})

test('R17 root fastpath keeps one repeatable-read snapshot from root probe through the edge read', async t => {
  const { roomKey } = await app.seed()
  const rootUid = (await app.pool.query(`select uid from room_nodes where room_key = $1 and is_root and deleted_at is null`, [roomKey])).rows[0].uid
  const { withRoomReadSnapshot, readSelectedNodeCounts } = require('../bin/roomNodes')
  // meta {} keeps this warm-up out of the count cache so the gated read is cold.
  const before = (await readSelectedNodeCounts(app.pool, roomKey, [rootUid], {})).get(rootUid).descendantCount
  const beforeVersion = Number((await app.pool.query('select version from rooms where room_key = $1', [roomKey])).rows[0].version)
  const realClient = await app.pool.connect()
  let signalEntered, releaseGate
  const entered = new Promise(resolve => { signalEntered = resolve })
  const gate = new Promise(resolve => { releaseGate = resolve })
  let paused = false
  const wrapper = {
    query: async (sql, params) => {
      const result = await realClient.query(sql, params)
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (!paused && /^select uid from room_nodes .*is_root/i.test(normalized)) {
        paused = true
        signalEntered()
        await gate
      }
      return result
    },
    release: () => realClient.release()
  }
  let gatedMetaVersion = null
  const pending = withRoomReadSnapshot({ connect: async () => wrapper, totalCount: 1 }, roomKey, async (client, meta) => {
    gatedMetaVersion = Number(meta.version)
    return readSelectedNodeCounts(client, roomKey, [rootUid], meta)
  })
  // Never leave the real RR transaction paused if a later assertion throws.
  let released = false
  const releaseOnce = () => { if (!released) { released = true; releaseGate() } }
  try {
    let enteredTimer
    const enteredOutcome = await Promise.race([entered.then(() => 'entered'),
      new Promise(resolve => { enteredTimer = setTimeout(() => resolve('timeout'), 15000) })])
    clearTimeout(enteredTimer)
    assert.equal(enteredOutcome, 'entered', 'root probe gate was not reached')
    // A legal commit from another connection while the snapshot is paused.
    const written = await request(app.base, `/api/files/${roomKey}/nodes`, { method: 'POST',
      body: { operation_id: randomUUID(), client_id: 'rr-fastpath', parent: 'target', uid: 'rr-child', text: 'rr' } })
    assert.equal(written.status, 200)
    releaseOnce()
    const gated = await pending
    const afterVersion = Number((await app.pool.query('select version from rooms where room_key = $1', [roomKey])).rows[0].version)
    const after = (await readSelectedNodeCounts(app.pool, roomKey, [rootUid], {})).get(rootUid).descendantCount
    t.diagnostic(JSON.stringify({ case: 'R17-rr-fastpath', before, gated: gated.get(rootUid).descendantCount, gatedMetaVersion, beforeVersion, afterVersion, after }))
    assert.equal(gated.get(rootUid).descendantCount, before, 'the gated snapshot must read pre-insert counts')
    assert.equal(gatedMetaVersion, beforeVersion, 'meta and counts must come from the same snapshot')
    assert.equal(afterVersion, beforeVersion + 1, 'the committed insert must advance the room version')
    assert.equal(after, before + 1, 'a later snapshot must see the committed insert')
  } finally {
    releaseOnce()
    await pending.catch(() => {})
  }
})

test('R18 separate process without notifications reads the new revision instead of its old result', async () => {
  const { roomKey } = await app.seed()
  const remote = await isolatedInstance()
  try {
    const path = `/api/files/${roomKey}/subtree?uid=target&limit=2`
    const before = await request(remote.base, path)
    assert.equal(before.body.total, 5)
    const written = await request(app.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', body: { operation_id: randomUUID(), client_id: 'r18', parent: 'target', uid: 'new-r18', text: 'new' }
    })
    assert.equal(written.status, 200)
    const after = await request(remote.base, path)
    assert.equal(after.body.version, 8)
    assert.equal(after.body.total, 6)
    assert.equal(after.body.descendantCount, 16)
    const denied = await request(remote.base, path, { actor: 'performance-outsider' })
    assert.equal(denied.status, 403)
  } finally { await remote.close() }
})

test('R18 real same-revision maintenance writer advances shared generation and the other process sees counts', async t => {
  const fixture = await app.seed()
  const remote = await isolatedInstance()
  try {
    const route = `/api/files/${fixture.roomKey}/subtree?uid=target&limit=2`
    assert.equal((await request(remote.base, route)).body.total, 5)
    const before = await app.counters(fixture.roomKey)
    const changed = JSON.parse(JSON.stringify(fixture.graph))
    changed.target.children.push('maintenance-child')
    changed['maintenance-child'] = { isRoot: false, data: { uid: 'maintenance-child', text: 'maintained' }, children: [] }
    // Real exported maintenance writer, not direct SQL manipulation of counts/cache.
    await app.storage.replaceRoomNodes(fixture.roomKey, changed, 7)
    const after = await app.counters(fixture.roomKey)
    const read = await request(remote.base, route)
    assert.equal(read.body.total, 6)
    assert.equal(read.body.descendantCount, 16)
    assert.equal(Number(after.version), Number(before.version))
    t.diagnostic(JSON.stringify({ case: 'R18-generation', before: before.counts_generation, after: after.counts_generation }))
    assert.ok(Number(after.counts_generation) > Number(before.counts_generation),
      'R18 same-revision maintenance changed the authoritative tree without advancing a shared generation')
  } finally { await remote.close() }
})

test('R18 old in-flight count response cannot replace the next revision result', async () => {
  const { roomKey } = await app.seed()
  app.observer.arm(roomKey)
  let pending
  try {
    pending = request(app.base, `/api/files/${roomKey}/subtree?uid=target&limit=2`)
    await app.observer.entered()
    const written = await request(app.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', body: { operation_id: randomUUID(), client_id: 'r18-old', parent: 'target', uid: 'old-flight-child', text: 'new' }
    })
    assert.equal(written.status, 200)
    app.observer.release()
    await pending
    const current = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&limit=2`)
    assert.equal(current.body.version, 8)
    assert.equal(current.body.total, 6)
  } finally {
    app.observer.release()
    if (pending) await pending.catch(() => {})
  }
})

test('R18 cache stays bypassed without writer readiness, with default flag absence, and at revision zero', async () => {
  const { roomKey } = await app.seed()
  const route = `/api/files/${roomKey}/subtree?uid=target&limit=2`
  const saved = { cache: process.env.COLLAB_NODE_COUNT_CACHE, ready: process.env.COLLAB_NODE_COUNT_CACHE_WRITERS_READY }
  try {
    for (const gate of ['writers-not-ready', 'default-disabled', 'version-zero']) {
      process.env.COLLAB_NODE_COUNT_CACHE = '1'
      process.env.COLLAB_NODE_COUNT_CACHE_WRITERS_READY = '1'
      if (gate === 'writers-not-ready') delete process.env.COLLAB_NODE_COUNT_CACHE_WRITERS_READY
      if (gate === 'default-disabled') delete process.env.COLLAB_NODE_COUNT_CACHE
      if (gate === 'version-zero') await app.pool.query('update rooms set version=0 where room_key=$1', [roomKey])
      assert.equal((await request(app.base, route)).body.total, 5)
      app.observer.reset()
      assert.equal((await request(app.base, route)).body.descendantCount, 15)
      assert.equal(app.observer.trace().sql.filter(row => /with recursive relevant/i.test(row.sql)).length, 1,
        `${gate} must compute counts rather than reading a retained result`)
    }
  } finally {
    process.env.COLLAB_NODE_COUNT_CACHE = saved.cache
    process.env.COLLAB_NODE_COUNT_CACHE_WRITERS_READY = saved.ready
  }
})

test('R18 a failed real maintenance replacement restores graph and generation atomically', async () => {
  const { roomKey, graph } = await app.seed()
  const before = await app.counters(roomKey)
  const changed = JSON.parse(JSON.stringify(graph))
  changed.target.data.circular = changed.target.data
  await assert.rejects(app.storage.replaceRoomNodes(roomKey, changed, 7), /circular|cyclic/i)
  assert.deepEqual(await app.counters(roomKey), before)
  const root = await app.pool.query('select uid from room_nodes where room_key=$1 and is_root and deleted_at is null', [roomKey])
  assert.deepEqual(root.rows.map(row => row.uid), ['root'])
  const read = await request(app.base, `/api/files/${roomKey}/subtree?uid=target&limit=2`)
  assert.equal(read.body.total, 5)
  assert.equal(read.body.descendantCount, 15)
})
