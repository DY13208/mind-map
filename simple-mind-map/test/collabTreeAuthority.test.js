const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const {
  pickAuthoritativeNodes,
  describeTreeAuthority,
  canonicalTreeHash,
  isTableInitialized,
  getTreeAuthorityFallbackHits,
  resetTreeAuthorityFallbackHits
} = require('../bin/roomNodes')

function access() {
  return { userId: 'A', role: 'editor', canEdit: true }
}

async function submit(engine, roomKey, type, payload) {
  return engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type,
      payload
    },
    access()
  )
}

async function tableFromEngine(engine, roomKey) {
  const room = engine.getRoom(roomKey)
  const graph = room.store.graph
  let version = 0
  const uids = Object.keys(graph)
  for (const uid of uids) {
    const live = await room.store.getLive(uid)
    if (live) version = Math.max(version, Number(live.node_version || 0))
  }
  return {
    nodes: graph,
    version,
    count: uids.filter(uid => graph[uid] && !graph[uid].deleted).length
  }
}

function refreshRead(staleJson, table, roomsVersion) {
  const picked = pickAuthoritativeNodes(staleJson, table, roomsVersion, {
    caller: 'refresh-invariance',
    collabV2: true
  })
  const desc = describeTreeAuthority(staleJson, table, roomsVersion, {
    caller: 'refresh-invariance',
    collabV2: true
  })
  return { picked, desc }
}

function oldBuggyPick(json, table, roomVersion) {
  if (table && table.count && Number(table.version || 0) >= Number(roomVersion || 0)) {
    return 'table'
  }
  return 'json'
}

function texts(graph) {
  const out = {}
  Object.keys(graph || {}).forEach(uid => {
    const node = graph[uid]
    if (!node || node.deleted) return
    out[uid] = node.data && node.data.text
  })
  return out
}

;(async () => {
  resetTreeAuthorityFallbackHits()

  const engine = createEngine()
  const roomKey = 'authority-theme-p0'
  engine.getRoom(roomKey)
  await submit(engine, roomKey, 'node.insert', { uid: 'A', parent: 'root', text: 'A' })
  await submit(engine, roomKey, 'node.insert', { uid: 'B', parent: 'root', text: 'B' })
  const staleJson = JSON.parse(JSON.stringify(engine.getRoom(roomKey).store.graph))

  await submit(engine, roomKey, 'node.update', { uid: 'A', text: 'A-NEW' })
  await submit(engine, roomKey, 'node.insert', { uid: 'C', parent: 'root', text: 'C' })
  await submit(engine, roomKey, 'node.insert', { uid: 'C1', parent: 'C', text: 'C1' })
  await submit(engine, roomKey, 'node.delete', { uid: 'B' })

  const beforeTheme = await tableFromEngine(engine, roomKey)
  assert.ok(await engine.getRoom(roomKey).store.getLive('C'), 'Q1 C in room_nodes')
  assert.ok(await engine.getRoom(roomKey).store.getLive('C1'), 'Q1 C1 in room_nodes')
  assert.ok(!(await engine.getRoom(roomKey).store.getLive('B')), 'Q1 B tombstoned')
  const aBefore = await engine.getRoom(roomKey).store.getLive('A')
  assert.strictEqual(aBefore.data.text, 'A-NEW')

  const theme = await submit(engine, roomKey, 'map.meta.update', { theme: 'dark' })
  assert.notStrictEqual(theme.operation.event.type, 'map.replaced')
  assert.strictEqual(theme.operation.event.payload.resnapshot, false)
  const afterTheme = await tableFromEngine(engine, roomKey)
  assert.ok(await engine.getRoom(roomKey).store.getLive('C'), 'theme must not drop C')
  assert.ok(afterTheme.version < engine.getRoom(roomKey).revision, 'theme bumps rooms.version only')

  const themeRefresh = refreshRead(staleJson, afterTheme, engine.getRoom(roomKey).revision)
  assert.strictEqual(
    oldBuggyPick(staleJson, afterTheme, engine.getRoom(roomKey).revision),
    'json',
    'old picker would fall back to rooms.nodes after Theme'
  )
  assert.strictEqual(themeRefresh.picked.source, 'table')
  assert.strictEqual(themeRefresh.desc.treeSource, 'room_nodes')
  assert.ok(themeRefresh.picked.nodes.C)
  assert.ok(!themeRefresh.picked.nodes.B || themeRefresh.picked.nodes.B.deleted)

  await submit(engine, roomKey, 'node.insert', { uid: 'D', parent: 'root', text: 'D' })
  await submit(engine, roomKey, 'node.insert', { uid: 'D1', parent: 'D', text: 'D1' })
  await submit(engine, roomKey, 'node.update', { uid: 'D', text: 'D-NEW' })
  const afterInsert = await tableFromEngine(engine, roomKey)
  assert.ok(await engine.getRoom(roomKey).store.getLive('D'), 'Q2 D in room_nodes')
  assert.ok(await engine.getRoom(roomKey).store.getLive('D1'), 'Q2 D1 in room_nodes')
  const dLive = await engine.getRoom(roomKey).store.getLive('D')
  assert.strictEqual(dLive.data.text, 'D-NEW')

  const finalRefresh = refreshRead(
    staleJson,
    afterInsert,
    engine.getRoom(roomKey).revision
  )
  assert.strictEqual(finalRefresh.desc.treeSource, 'room_nodes')
  assert.strictEqual(finalRefresh.picked.source, 'table')
  const reloaded = texts(finalRefresh.picked.nodes)
  assert.strictEqual(reloaded.A, 'A-NEW')
  assert.strictEqual(reloaded.C, 'C')
  assert.strictEqual(reloaded.C1, 'C1')
  assert.strictEqual(reloaded.D, 'D-NEW')
  assert.strictEqual(reloaded.D1, 'D1')
  assert.ok(!reloaded.B)
  assert.notStrictEqual(
    canonicalTreeHash(staleJson),
    canonicalTreeHash(finalRefresh.picked.nodes),
    'reload must not equal the initial rooms.nodes snapshot'
  )
  const h1 = canonicalTreeHash(afterInsert.nodes)

  const cases = [
    ['node.insert', { uid: 'E', parent: 'root', text: 'E' }],
    ['node.update', { uid: 'E', text: 'E-NEW' }],
    ['node.delete', { uid: 'E' }],
    ['node.move', { uid: 'D1', parent: 'root', index: 0 }],
    ['map.meta.update', { theme: 'classic' }],
    ['map.meta.update', { layout: 'logicalStructure' }]
  ]
  for (const [type, payload] of cases) {
    await submit(engine, roomKey, type, payload)
    const table = await tableFromEngine(engine, roomKey)
    const read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
    assert.strictEqual(read.desc.treeSource, 'room_nodes', type + ' refresh')
    assert.ok(read.picked.nodes.C, type + ' must keep C')
    assert.ok(read.picked.nodes.D, type + ' must keep D')
  }

  await submit(engine, roomKey, 'node.update', {
    uid: 'C',
    generalization: { text: 'G1' }
  })
  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark2' })
  let table = await tableFromEngine(engine, roomKey)
  let read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
  assert.ok(read.picked.nodes.C)
  assert.strictEqual(read.picked.nodes.C.data.generalization.text, 'G1')

  await submit(engine, roomKey, 'node.update', {
    uid: 'C',
    outerFrame: { strokeColor: '#f00' }
  })
  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark3' })
  table = await tableFromEngine(engine, roomKey)
  read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
  assert.strictEqual(read.picked.nodes.C.data.outerFrame.strokeColor, '#f00')

  await submit(engine, roomKey, 'node.update', {
    uid: 'C',
    associativeLine: [{ id: 'al1', to: 'A' }]
  })
  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark4' })
  table = await tableFromEngine(engine, roomKey)
  read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
  assert.ok(Array.isArray(read.picked.nodes.C.data.associativeLine))

  await submit(engine, roomKey, 'node.update', { uid: 'A', text: 'A-REPLACED' })
  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark5' })
  table = await tableFromEngine(engine, roomKey)
  read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
  assert.strictEqual(read.picked.nodes.A.data.text, 'A-REPLACED')

  await submit(engine, roomKey, 'node.move', { uid: 'C', parent: 'D', index: 0 })
  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark6' })
  table = await tableFromEngine(engine, roomKey)
  read = refreshRead(staleJson, table, engine.getRoom(roomKey).revision)
  const cLive = await engine.getRoom(roomKey).store.getLive('C')
  assert.strictEqual(cLive.parent_uid, 'D')
  assert.strictEqual(
    (await engine.getRoom(roomKey).store.getLive('C')).parent_uid,
    'D'
  )

  assert.ok(isTableInitialized(table))
  assert.strictEqual(getTreeAuthorityFallbackHits(), 0)

  const legacy = pickAuthoritativeNodes(
    { root: { isRoot: true, data: { uid: 'root', text: 'legacy' }, children: [] } },
    { nodes: null, version: 0, count: 0 },
    5,
    { collabV2: true }
  )
  assert.strictEqual(legacy.source, 'json')
  assert.strictEqual(legacy.migrate, true)
  const afterMigrate = pickAuthoritativeNodes(
    { root: { isRoot: true, data: { uid: 'root', text: 'legacy' }, children: [] } },
    {
      nodes: {
        root: { isRoot: true, data: { uid: 'root', text: 'legacy' }, children: [] }
      },
      version: 1,
      count: 1
    },
    5,
    { collabV2: true }
  )
  assert.strictEqual(afterMigrate.source, 'table')
  assert.strictEqual(afterMigrate.migrate, false)

  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['x'] },
    x: { data: { uid: 'x', text: 'X' }, children: [] }
  })
  await applyDirect(
    store,
    { type: 'map.meta.update', payload: { theme: 'dark' } },
    { version: 9 }
  )
  assert.ok(await store.getLive('x'))
  assert.strictEqual((await store.getLive('x')).data.text, 'X')

  void h1
  console.log('collabTreeAuthority.test.js ok', {
    q1: 'YES',
    q2: 'YES',
    q3: 'room_nodes',
    q4: 'blocked',
    roomsVersion: engine.getRoom(roomKey).revision,
    tableVersion: table.version,
    treeSource: read.desc.treeSource
  })
})().catch(err => {
  console.error(err)
  process.exit(1)
})
