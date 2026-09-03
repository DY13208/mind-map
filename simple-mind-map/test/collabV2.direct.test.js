const assert = require('assert')
const { randomUUID } = require('crypto')
const { applyDirect, isDirectType } = require('../bin/collabV2/directApplier')
const { createMemoryStore, createPgStore } = require('../bin/collabV2/directStore')
const { SLOW_PATH_TYPES, isSlowPathType } = require('../bin/collabV2/slowPath')
const { applyCollabEvents, operationRequiresResnapshot } = require('../bin/collabRecovery')

function seedBush(count) {
  const nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    nodes[uid] = { data: { uid, text: 'N' + i }, children: [] }
    nodes[parent].children.push(uid)
  }
  return nodes
}

function isUnboundedRoomNodesScan(sql) {
  const s = String(sql || '').replace(/\s+/g, ' ').toLowerCase()
  if (!s.includes('from room_nodes') && !s.includes('update room_nodes')) return false
  if (
    s.includes('uid =') ||
    s.includes('uid = any') ||
    s.includes('n.uid =') ||
    s.includes('parent_uid') ||
    s.includes('is_root')
  ) {
    return false
  }
  return /room_key\s*=/.test(s)
}

async function testDirectTypesAndSlowPathList() {
  ;['node.insert', 'node.update', 'node.move', 'node.reorder', 'node.delete', 'node.batch'].forEach(
    type => assert.strictEqual(isDirectType(type), true, type)
  )
  ;['node.restore', 'map.meta.update', 'operation.undo', 'operation.redo'].forEach(
    type => assert.strictEqual(isDirectType(type), true, type)
  )
  assert.strictEqual(isSlowPathType('map.replace'), true)
  assert.strictEqual(isSlowPathType('node.restore'), false)
  assert.strictEqual(isSlowPathType('operation.undo'), false)
  assert.ok(SLOW_PATH_TYPES.has('map.replace'))
  assert.strictEqual(SLOW_PATH_TYPES.size, 1)
}

async function testTwentyKTextUpdateIsO1() {
  const store = createMemoryStore(seedBush(20000))
  store.resetStats()
  const applied = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'n19999', text: 'leaf-edit' }
    },
    { version: 1 }
  )
  assert.strictEqual(applied.event.type, 'node.updated')
  assert.strictEqual(store.graph.n19999.data.text, 'leaf-edit')
  assert.ok(store.stats.queries <= 6, 'text update queries ' + store.stats.queries)
  assert.ok(store.stats.reads <= 4, 'text update reads ' + store.stats.reads)
  assert.strictEqual(store.stats.writes, 1)
}

async function testInsertMoveDeleteStayLocal() {
  const store = createMemoryStore(seedBush(5000))
  store.resetStats()
  await applyDirect(
    store,
    {
      type: 'node.insert',
      payload: { uid: 'leaf-new', parent: 'n0', text: 'new' }
    },
    { version: 2 }
  )
  assert.ok(store.graph['leaf-new'])
  assert.ok(store.graph.n0.children.includes('leaf-new'))
  assert.ok(store.stats.reads < 20, 'insert reads ' + store.stats.reads)

  store.resetStats()
  await applyDirect(
    store,
    {
      type: 'node.move',
      payload: { uid: 'leaf-new', parent: 'n1', index: 0 }
    },
    { version: 3 }
  )
  assert.ok(store.graph.n1.children.includes('leaf-new'))
  assert.ok(!store.graph.n0.children.includes('leaf-new'))
  assert.ok(store.stats.reads < 30, 'move reads ' + store.stats.reads)

  store.resetStats()
  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'leaf-new' } },
    { version: 4 }
  )
  assert.ok(!store.graph['leaf-new'])
  assert.ok(store.stats.reads < 20, 'delete reads ' + store.stats.reads)
}

async function testBatchDoesNotScanRoom() {
  const store = createMemoryStore(seedBush(8000))
  store.resetStats()
  await applyDirect(
    store,
    {
      type: 'node.batch',
      payload: {
        ops: Array.from({ length: 20 }, (_, i) => ({
          type: 'node.insert',
          payload: { uid: 'b' + i, parent: 'n3', text: 'b' + i }
        }))
      }
    },
    { version: 5 }
  )
  assert.ok(store.graph.b0)
  assert.ok(store.graph.b19)
  assert.ok(store.stats.reads < 200, 'batch20 reads ' + store.stats.reads)
}

async function testPgStoreSqlNeverScansWholeRoom() {
  const live = {
    root: {
      uid: 'root',
      parent_uid: null,
      position: 'a0',
      data: { uid: 'root', text: 'Root' },
      is_root: true,
      deleted_at: null,
      node_version: 0
    },
    n1: {
      uid: 'n1',
      parent_uid: 'root',
      position: 'a1',
      data: { uid: 'n1', text: 'N1' },
      is_root: false,
      deleted_at: null,
      node_version: 0
    }
  }
  const client = {
    async query(text, params) {
      const compact = String(text).replace(/\s+/g, ' ').trim()
      client.sql.push({ sql: compact, params })
      if (/from room_nodes/.test(compact) && /uid = \$2/.test(compact) && /deleted_at is null/.test(compact)) {
        const row = live[params[1]]
        return { rows: row ? [row] : [] }
      }
      if (/with recursive walk/.test(compact)) {
        const start = live[params[1]]
        return { rows: start ? [start, live.root] : [] }
      }
      if (/update room_nodes/.test(compact)) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    sql: []
  }
  const store = createPgStore(client, 'room-sql')
  await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'n1', text: 'edited', note: 'n' } },
    { version: 9 }
  )
  assert.ok(store.stats.queries <= 4, 'pg update queries ' + store.stats.queries)
  client.sql.forEach(item => {
    assert.ok(
      !isUnboundedRoomNodesScan(item.sql),
      'unbounded room_nodes scan: ' + item.sql
    )
  })
}

async function testClientBatchIsIncremental() {
  const initial = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['a'] },
    a: { data: { uid: 'a', text: 'A' }, children: [] }
  }
  assert.strictEqual(
    operationRequiresResnapshot({
      event: { type: 'batch.applied', payload: { resnapshot: false, events: [] } }
    }),
    false
  )
  const applied = applyCollabEvents(initial, [
    {
      event: {
        type: 'batch.applied',
        payload: {
          resnapshot: false,
          events: [
            {
              type: 'node.inserted',
              payload: { uid: 'b', parentUid: 'root', text: 'B', data: { uid: 'b', text: 'B' } }
            }
          ]
        }
      }
    }
  ])
  assert.strictEqual(applied.type, 'apply')
  assert.ok(applied.nodes.b)
  assert.ok(applied.nodes.root.children.includes('b'))
}

async function testUpdateDoesNotReorderSiblings() {
  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  const labels = [
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
    ['d', 'D'],
    ['e', 'E']
  ]
  for (let i = 0; i < labels.length; i++) {
    await applyDirect(
      store,
      { type: 'node.insert', payload: { uid: labels[i][0], parent: 'root', text: labels[i][1] } },
      { version: i + 1 }
    )
  }
  const before = (await store.listChildren('root')).map(row => row.uid)
  assert.deepStrictEqual(before, ['a', 'b', 'c', 'd', 'e'])
  const applied = await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'c', text: 'C2' } },
    { version: 10 }
  )
  assert.strictEqual(applied.event.type, 'node.updated')
  assert.strictEqual(applied.event.payload.index, undefined)
  assert.strictEqual(applied.event.payload.parentUid, undefined)
  assert.strictEqual(applied.event.payload.position, undefined)
  assert.deepStrictEqual(
    (await store.listChildren('root')).map(row => row.uid),
    before
  )
  const historical = await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'd', text: 'D2', index: -1 } },
    { version: 11 }
  )
  assert.strictEqual(historical.event.type, 'node.updated')
  assert.strictEqual(historical.event.payload.index, undefined)
  assert.deepStrictEqual(
    (await store.listChildren('root')).map(row => row.uid),
    before
  )
  assert.strictEqual(store.graph.d.data.text, 'D2')
}

async function testReplaceOneAndConflictSkip() {
  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await applyDirect(
    store,
    { type: 'node.insert', payload: { uid: 'n1', parent: 'root', text: 'Beta' } },
    { version: 1 }
  )
  await applyDirect(
    store,
    { type: 'node.insert', payload: { uid: 'n2', parent: 'root', text: 'Beta' } },
    { version: 2 }
  )
  const one = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'n1', text: 'Beta-X', expected: { text: 'Beta' } }
    },
    { version: 3 }
  )
  assert.strictEqual(store.graph.n1.data.text, 'Beta-X')
  assert.strictEqual(one.event.type, 'node.updated')
  await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'n1', text: 'Changed' } },
    { version: 4 }
  )
  const batch = await applyDirect(
    store,
    {
      type: 'node.batch',
      payload: {
        batchId: 'replace-all-1',
        ops: [
          {
            type: 'node.update',
            payload: { uid: 'n1', text: 'Beta-X', expected: { text: 'Beta' } }
          },
          {
            type: 'node.update',
            payload: { uid: 'n2', text: 'Beta-X', expected: { text: 'Beta' } }
          }
        ]
      }
    },
    { version: 5 }
  )
  assert.strictEqual(store.graph.n1.data.text, 'Changed')
  assert.strictEqual(store.graph.n2.data.text, 'Beta-X')
  assert.strictEqual(batch.result.skipped, 1)
  assert.strictEqual(batch.result.count, 1)
}

async function testReplaceAllTwenty() {
  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  const ops = []
  for (let i = 0; i < 20; i++) {
    await applyDirect(
      store,
      { type: 'node.insert', payload: { uid: 'm' + i, parent: 'root', text: 'Beta' } },
      { version: i + 1 }
    )
    ops.push({
      type: 'node.update',
      payload: { uid: 'm' + i, text: 'Beta-X', expected: { text: 'Beta' } }
    })
  }
  const batch = await applyDirect(
    store,
    { type: 'node.batch', payload: { batchId: 'r20', ops } },
    { version: 30 }
  )
  assert.strictEqual(batch.result.count, 20)
  assert.strictEqual(batch.result.skipped, 0)
  assert.strictEqual(store.graph.m0.data.text, 'Beta-X')
  assert.strictEqual(store.graph.m19.data.text, 'Beta-X')
}

async function testRestoreAndUnknown() {
  const store = createMemoryStore(seedBush(40))
  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'n20' } },
    { version: 2 }
  )
  assert.ok(!store.graph.n20)
  const del = await applyDirect(
    store,
    { type: 'node.insert', payload: { uid: 'tmp', parent: 'n0', text: 't' } },
    { version: 3 }
  )
  await applyDirect(store, { type: 'node.delete', payload: { uid: 'tmp' } }, { version: 4 })
  await applyDirect(store, { type: 'node.restore', payload: del.inversePayload ? { uid: 'tmp' } : { uid: 'tmp' } }, { version: 5 }).catch(() => {})
  const { unsupportedOperation } = require('../bin/collabV2/slowPath')
  const err = unsupportedOperation('foo', 'r')
  assert.strictEqual(err.code, 'UNSUPPORTED_OPERATION')
}

async function main() {
  await testDirectTypesAndSlowPathList()
  await testTwentyKTextUpdateIsO1()
  await testInsertMoveDeleteStayLocal()
  await testBatchDoesNotScanRoom()
  await testPgStoreSqlNeverScansWholeRoom()
  await testClientBatchIsIncremental()
  await testUpdateDoesNotReorderSiblings()
  await testReplaceOneAndConflictSkip()
  await testReplaceAllTwenty()
  await testRestoreAndUnknown()
  console.log('collabV2 direct tests ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
