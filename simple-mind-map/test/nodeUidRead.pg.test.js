const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { randomUUID } = require('node:crypto')
const { createHarness, request, isolatedInstance } = require('./performanceBackendHarness')
let app
before(async () => { app = await createHarness() })
after(async () => { if (app) await app.close() })

test('R13 real HTTP UID DTO preserves order, full children, tombstones and image/attachment data', async () => {
  const fixture = await app.seed()
  await app.pool.query(
    `insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version,deleted_at)
     values ($1,'deleted-synthetic','target','z0','{"uid":"deleted-synthetic","text":"gone"}',false,7,now())`,
    [fixture.roomKey]
  )
  const result = await request(app.base, `/api/files/${fixture.roomKey}/nodes?uids=child-3,missing,target,deleted-synthetic,child-0`)
  assert.equal(result.status, 200)
  assert.equal(result.body.version, 7)
  assert.deepEqual(result.body.nodes.map(node => node.uid), ['child-3', 'target', 'child-0'])
  const target = result.body.nodes[1]
  assert.deepEqual(target.children, fixture.graph.target.children)
  assert.equal(target.data.childCount, 5)
  assert.equal(target.data.descendantCount, 15)
  assert.equal(target.data.attachmentId, 'synthetic-attachment')
  assert.equal(target.data.image, 'https://example.invalid/image.png')
  assert.deepEqual(target.data.imageSize, { width: 20, height: 10 })
  assert.equal(Object.hasOwn(target.data, 'imgMap'), false)
})

test('R14 leaf UID request never loads/hashes the whole initialized V2 graph', async t => {
  const { roomKey } = await app.seed(1000)
  app.observer.reset()
  const result = await request(app.base, `/api/files/${roomKey}/nodes?uids=grand-0-0`)
  assert.equal(result.status, 200)
  assert.equal(result.body.nodes[0].uid, 'grand-0-0')
  const trace = app.observer.trace()
  t.diagnostic(JSON.stringify({ case: 'R14', N: 1000, M: 1, C: 0, S: 0, trace }))
  assert.equal(trace.snapshotCalls, 0, 'R14 UID self read called the real full-tree snapshot path')
  assert.equal(trace.fullTreeHashes, 0, 'R14 UID self read hashed a complete graph')
  const graphRows = trace.sql.filter(item => /from room_nodes/i.test(item.sql) && /\bdata\b/i.test(item.sql))
  assert.ok(graphRows.every(item => item.rows <= 1), 'R14 unrelated node rows were transferred to Node')
})

test('R14 warm UID scope reuses complete DTO without node SQL, preserving reordered duplicates and write invalidation', async t => {
  const { roomKey } = await app.seed()
  const first = await request(app.base, `/api/files/${roomKey}/nodes?uids=target,grand-0-0`)
  assert.equal(first.status, 200)
  app.observer.reset()
  const warm = await request(app.base, `/api/files/${roomKey}/nodes?uids=grand-0-0,target,target`)
  assert.equal(warm.status, 200)
  assert.deepEqual(warm.body.nodes, [first.body.nodes[1], first.body.nodes[0], first.body.nodes[0]])
  const reads = app.observer.trace().sql.filter(row => /from room_nodes\b/i.test(row.sql))
  t.diagnostic(JSON.stringify({ case: 'R14-warm-dto', reads }))
  assert.equal(reads.length, 0, 'warm UID DTO must not refetch target, root or complete child IDs')
  const updated = await request(app.base, `/api/files/${roomKey}/nodes/target`, {
    method: 'PATCH', body: { operation_id: randomUUID(), client_id: 'warm-writer', text: 'new title', note: 'new note' }
  })
  assert.equal(updated.status, 200)
  const next = await request(app.base, `/api/files/${roomKey}/nodes?uids=target,grand-0-0`)
  assert.equal(next.body.version, 8)
  assert.equal(next.body.nodes[0].data.text, 'new title')
  assert.equal(next.body.nodes[0].data.note, 'new note')
  assert.deepEqual(next.body.nodes[0].children, first.body.nodes[0].children)
  assert.equal(next.body.nodes[0].data.childCount, 5)
  assert.equal(next.body.nodes[0].data.descendantCount, 15)
})

test('R18 complete UID DTO in another process observes same-revision data repair without notifications', async () => {
  const { roomKey, graph } = await app.seed()
  const remote = await isolatedInstance()
  try {
    const route = `/api/files/${roomKey}/nodes?uids=target`
    assert.equal((await request(remote.base, route)).body.nodes[0].data.text, graph.target.data.text)
    const changed = JSON.parse(JSON.stringify(graph))
    changed.target.data.text = 'same revision repaired text'
    changed.target.children.push('dto-repair-child')
    changed['dto-repair-child'] = { data: { uid: 'dto-repair-child', text: 'repaired child' }, children: [] }
    await app.storage.replaceRoomNodes(roomKey, changed, 7)
    const next = await request(remote.base, route)
    assert.equal(next.body.version, 7)
    assert.equal(next.body.nodes[0].data.text, 'same revision repaired text')
    assert.equal(next.body.nodes[0].data.childCount, 6)
    assert.equal(next.body.nodes[0].data.descendantCount, 16)
  } finally { await remote.close() }
})

test('R18 reused room key cannot reuse an earlier room lifecycle cache stamp', async t => {
  const { roomKey, graph } = await app.seed()
  const remote = await isolatedInstance()
  try {
    const route = `/api/files/${roomKey}/nodes?uids=target`
    assert.equal((await request(remote.base, route)).body.nodes[0].data.text, graph.target.data.text)
    const before = await app.counters(roomKey)
    // Fixture deletion exercises real PG cascade DML; recreation uses the
    // production upsert writer, without calling COS or any external service.
    await app.pool.query('delete from rooms where room_key=$1', [roomKey])
    const replacement = JSON.parse(JSON.stringify(graph))
    replacement.target.data.text = 'different room lifecycle'
    await app.storage.upsertRoom(roomKey, 'Recreated synthetic fixture', { nodes: replacement })
    await app.pool.query('update rooms set version=7 where room_key=$1', [roomKey])
    await app.pool.query(`insert into room_members(room_key,user_id,role,direct_role,source)
      values($1,'performance-owner','owner','owner','direct_share')
      on conflict(room_key,user_id) do update set role='owner',direct_role='owner'`, [roomKey])
    const after = await app.counters(roomKey)
    t.diagnostic(JSON.stringify({ case: 'R18-room-lifecycle', before: before.counts_generation, after: after.counts_generation }))
    const result = await request(remote.base, route)
    assert.equal(result.status, 200)
    assert.equal(result.body.nodes[0].data.text, 'different room lifecycle')
    assert.ok(Number(after.counts_generation) > Number(before.counts_generation))
  } finally { await remote.close() }
})

test('R15 response revision, children and counts share one real PG snapshot across a concurrent commit', async t => {
  const { roomKey } = await app.seed()
  app.observer.arm(roomKey)
  let pending
  try {
    pending = request(app.base, `/api/files/${roomKey}/nodes?uids=target`)
    await app.observer.entered()
    const written = await request(app.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', body: { operation_id: randomUUID(), client_id: 'race-writer', parent: 'target', uid: 'race-child', text: 'concurrent' }
    })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    assert.equal(Number(written.body.version), 8)
    app.observer.release()
    const result = await pending
    assert.equal(result.status, 200)
    t.diagnostic(JSON.stringify({ case: 'R15', responseRevision: result.body.version,
      children: result.body.nodes[0].children, childCount: result.body.nodes[0].data.childCount }))
    assert.equal(Number(result.body.version), 7)
    assert.equal(result.body.nodes[0].children.length, 5, 'R15 revision 7 leaked revision 8 children')
    assert.equal(result.body.nodes[0].data.childCount, 5)
    assert.equal(result.body.nodes[0].data.descendantCount, 15)
    const next = await request(app.base, `/api/files/${roomKey}/nodes?uids=target`)
    assert.equal(Number(next.body.version), 8)
    assert.equal(next.body.nodes[0].data.childCount, 6)
    assert.equal(next.body.nodes[0].data.descendantCount, 16)
  } finally {
    app.observer.release()
    if (pending) await pending.catch(() => {})
  }
})

test('R15 UID reads enforce real PG room ACL and revoke cached-room access', async () => {
  const { roomKey } = await app.seed()
  assert.equal((await request(app.base, `/api/files/${roomKey}/nodes?uids=target`, { actor: 'performance-viewer' })).status, 200)
  await app.pool.query('delete from room_members where room_key=$1 and user_id=$2', [roomKey, 'performance-viewer'])
  const denied = await request(app.base, `/api/files/${roomKey}/nodes?uids=target`, { actor: 'performance-viewer' })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'FORBIDDEN')
  const missing = await request(app.base, '/api/files/performance-backend-missing/nodes?uids=target')
  assert.equal(missing.status, 404)
})
