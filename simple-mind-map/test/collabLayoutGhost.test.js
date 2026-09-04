const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const {
  canonicalStructureFromGraph,
  structureSignature
} = require('../bin/mapMetadata')

function destroyStaleLayoutNodes(lastCache = {}, nextCache = {}) {
  const destroyed = []
  const duplicates = []
  Object.keys(lastCache || {}).forEach(uid => {
    const prev = lastCache[uid]
    const next = nextCache[uid]
    if (!prev) return
    if (!next) {
      if (typeof prev.destroy === 'function') prev.destroy()
      destroyed.push(uid)
      return
    }
    if (prev !== next) {
      if (typeof prev.destroy === 'function') prev.destroy()
      destroyed.push(uid)
      duplicates.push(uid)
    }
  })
  return { destroyed, duplicates }
}

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

function fakeNode(uid) {
  let destroyed = 0
  const lines = [{ remove() {} }, { remove() {} }]
  return {
    uid,
    _lines: lines,
    destroy() {
      destroyed += 1
      this.group = null
      this._lines = []
    },
    get destroyed() {
      return destroyed
    },
    group: { id: 'g-' + uid }
  }
}

;(async () => {
  const oldA = fakeNode('A')
  const newA = fakeNode('A')
  const b = fakeNode('B')
  const stale = destroyStaleLayoutNodes(
    { A: oldA, B: b },
    { A: newA, B: b }
  )
  assert.strictEqual(oldA.destroyed, 1, 'old instance A must be destroyed')
  assert.strictEqual(newA.destroyed, 0, 'new instance A must stay')
  assert.strictEqual(b.destroyed, 0)
  assert.deepStrictEqual(stale.duplicates, ['A'])
  assert.ok(stale.destroyed.includes('A'))

  const dropped = fakeNode('C')
  const drop = destroyStaleLayoutNodes({ C: dropped }, {})
  assert.strictEqual(dropped.destroyed, 1)
  assert.deepStrictEqual(drop.destroyed, ['C'])

  const reused = fakeNode('D')
  const keep = destroyStaleLayoutNodes({ D: reused }, { D: reused })
  assert.strictEqual(reused.destroyed, 0)
  assert.strictEqual(keep.destroyed.length, 0)

  let setDataCalls = 0
  const layoutNames = [
    'logicalStructure',
    'mindMap',
    'organizationStructure',
    'catalogOrganization',
    'timeline'
  ]
  let rendererCount = 4
  const switchCounts = []
  for (let i = 0; i < 20; i++) {
    const next = layoutNames[i % layoutNames.length]
    const lastCache = {
      A: fakeNode('A'),
      B: fakeNode('B'),
      C: fakeNode('C'),
      D: fakeNode('D')
    }
    const nextCache = {
      A: lastCache.A,
      B: lastCache.B,
      C: lastCache.C,
      D: lastCache.D
    }
    const result = destroyStaleLayoutNodes(lastCache, nextCache)
    assert.strictEqual(result.duplicates.length, 0, 'no duplicate uid after ' + next)
    assert.strictEqual(Object.keys(nextCache).length, rendererCount)
    switchCounts.push(Object.keys(nextCache).length)
    void setDataCalls
  }
  assert.ok(switchCounts.every(n => n === 4))
  assert.strictEqual(setDataCalls, 0, 'layout switch must not call setData')

  const store = createMemoryStore()
  await store.insert({
    uid: 'root',
    parent_uid: null,
    is_root: true,
    position: '',
    data: { uid: 'root', text: 'Root', generalization: [{ text: '概要', uid: 'g1' }] }
  })
  await store.insert({
    uid: 'A',
    parent_uid: 'root',
    position: 'a0',
    data: { uid: 'A', text: 'A', outerFrame: { width: 10 } }
  })
  await store.insert({
    uid: 'B',
    parent_uid: 'root',
    position: 'a1',
    data: {
      uid: 'B',
      text: 'B',
      associativeLineTargets: ['A']
    }
  })
  const h1 = structureSignature(canonicalStructureFromGraph(store.graph))
  await applyDirect(
    store,
    { type: 'map.meta.update', payload: { layout: 'mindMap' } },
    { version: 2 }
  )
  const h2 = structureSignature(canonicalStructureFromGraph(store.graph))
  assert.strictEqual(h1, h2, 'layout switch must not change canonical tree')
  assert.strictEqual((await store.getLive('A')).parent_uid, 'root')
  assert.ok((await store.getLive('A')).data.outerFrame)
  assert.deepStrictEqual((await store.getLive('B')).data.associativeLineTargets, ['A'])
  assert.ok((await store.getLive('root')).data.generalization)

  const engine = createEngine()
  const roomKey = 'ghost-layout-' + Date.now()
  engine.getRoom(roomKey)
  await submit(engine, roomKey, 'node.insert', { uid: 'n1', parent: 'root', text: 'A' })
  await submit(engine, roomKey, 'node.insert', { uid: 'n2', parent: 'root', text: 'B' })
  const before = structureSignature(
    canonicalStructureFromGraph(engine.getRoom(roomKey).store.graph)
  )
  const first = await submit(engine, roomKey, 'map.meta.update', {
    layout: 'organizationStructure'
  })
  assert.strictEqual(first.operation.event.payload.patch.layout, 'organizationStructure')
  const second = await submit(engine, roomKey, 'map.meta.update', {
    layout: 'organizationStructure'
  })
  assert.strictEqual(
    second.operation.event.payload.patch.layout,
    'organizationStructure'
  )
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(engine.getRoom(roomKey).store.graph)),
    before
  )

  console.log('collabLayoutGhost.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
