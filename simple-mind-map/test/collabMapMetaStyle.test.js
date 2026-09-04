const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const {
  mergeMapMetadata,
  pickMetaPatch,
  hydrateRoomMetadata,
  canonicalStructureFromGraph,
  structureSignature,
  STYLE_COMMAND_MATRIX
} = require('../bin/mapMetadata')
const { pickAuthoritativeNodes } = require('../bin/roomNodes')

function access() {
  return { userId: 'A', role: 'editor', canEdit: true }
}

async function submit(engine, roomKey, type, payload, clientId = 'c1') {
  return engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId,
      type,
      payload
    },
    access()
  )
}

async function seedTree(store) {
  await store.insert({
    uid: 'root',
    parent_uid: null,
    position: '',
    is_root: true,
    data: { uid: 'root', text: 'Root' }
  })
  await store.insert({
    uid: 'a',
    parent_uid: 'root',
    position: 'a0',
    data: { uid: 'a', text: 'A' }
  })
  await store.insert({
    uid: 'b',
    parent_uid: 'root',
    position: 'a1',
    data: { uid: 'b', text: 'B' }
  })
  await store.insert({
    uid: 'c',
    parent_uid: 'root',
    position: 'a2',
    data: { uid: 'c', text: 'C' }
  })
}

function graphOf(engine, roomKey) {
  return engine.getRoom(roomKey).store.graph
}

function liveMetaEvent(result) {
  return result && result.operation && result.operation.event
}

;(async () => {
  assert.strictEqual(STYLE_COMMAND_MATRIX.length >= 6, true)

  const merged = mergeMapMetadata(
    { theme: 'T1', layout: 'L1', zoom: 2 },
    { theme: 'T2' }
  )
  assert.strictEqual(merged.theme, 'T2')
  assert.strictEqual(merged.layout, 'L1')
  assert.strictEqual(merged.zoom, undefined)

  const both = mergeMapMetadata(merged, { layout: 'L2' })
  assert.strictEqual(both.theme, 'T2')
  assert.strictEqual(both.layout, 'L2')

  const combo = mergeMapMetadata(
    mergeMapMetadata({ theme: 'T2', layout: 'L2' }, { theme: 'T3' }),
    { layout: 'L3' }
  )
  assert.strictEqual(combo.theme, 'T3')
  assert.strictEqual(combo.layout, 'L3')

  const livePatch = pickMetaPatch({ theme: 'classic', themeConfig: {} })
  assert.strictEqual(livePatch.theme, 'classic')
  assert.strictEqual(livePatch.layout, undefined)

  const eventPatch = (function pickLive(payload) {
    if (payload.patch) {
      const out = {}
      ;['theme', 'themeConfig', 'layout'].forEach(key => {
        if (payload.patch[key] !== undefined) out[key] = payload.patch[key]
      })
      return out
    }
    return pickMetaPatch(payload)
  })({
    metadata: { theme: 'dark', layout: 'mindMap' },
    patch: { theme: 'classic' },
    theme: 'classic'
  })
  assert.strictEqual(eventPatch.theme, 'classic')
  assert.strictEqual(eventPatch.layout, undefined)

  const hydrated = hydrateRoomMetadata({
    metadata: { theme: 'classic2', layout: 'organizationStructure' }
  })
  assert.strictEqual(hydrated.source, 'server metadata')
  assert.strictEqual(hydrated.theme, 'classic2')
  assert.strictEqual(hydrated.layout, 'organizationStructure')

  const store = createMemoryStore()
  await seedTree(store)
  const h1 = structureSignature(canonicalStructureFromGraph(store.graph))

  const themeOp = await applyDirect(
    store,
    { type: 'map.meta.update', payload: { theme: 'classic2' } },
    { version: 2 }
  )
  assert.strictEqual(store.getMeta().theme, 'classic2')
  assert.strictEqual(themeOp.event.payload.patch.theme, 'classic2')
  assert.strictEqual(themeOp.event.payload.patch.layout, undefined)
  assert.strictEqual(themeOp.event.payload.layout, undefined)
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(store.graph)),
    h1
  )

  const layoutOp = await applyDirect(
    store,
    { type: 'map.meta.update', payload: { layout: 'mindMap' } },
    { version: 3 }
  )
  assert.strictEqual(store.getMeta().theme, 'classic2')
  assert.strictEqual(store.getMeta().layout, 'mindMap')
  assert.strictEqual(layoutOp.event.payload.patch.layout, 'mindMap')
  assert.strictEqual(layoutOp.event.payload.patch.theme, undefined)
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(store.graph)),
    h1
  )

  await applyDirect(
    store,
    { type: 'map.meta.update', payload: { theme: 'dark' } },
    { version: 4 }
  )
  await applyDirect(
    store,
    { type: 'map.meta.update', payload: { layout: 'logicalStructure' } },
    { version: 5 }
  )
  assert.deepStrictEqual(
    { theme: store.getMeta().theme, layout: store.getMeta().layout },
    { theme: 'dark', layout: 'logicalStructure' }
  )

  const saved = store.getMeta()
  store.setMeta({})
  store.setMeta(saved)
  assert.strictEqual(store.getMeta().theme, 'dark')
  assert.strictEqual(store.getMeta().layout, 'logicalStructure')

  const styleOp = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'a', patch: { fillColor: '#ff0000', fontSize: 22, color: '#111' } }
    },
    { version: 6 }
  )
  const nodeA = await store.getLive('a')
  assert.strictEqual(nodeA.data.fillColor, '#ff0000')
  assert.strictEqual(nodeA.data.fontSize, 22)
  assert.strictEqual(nodeA.data.color, '#111')
  assert.strictEqual(nodeA.parent_uid, 'root')
  assert.strictEqual(nodeA.position, 'a0')
  assert.strictEqual(styleOp.event.type, 'node.updated')
  assert.strictEqual(styleOp.event.payload.patch.fillColor, '#ff0000')

  await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'b', patch: { shape: 'diamond' } } },
    { version: 7 }
  )
  assert.strictEqual((await store.getLive('b')).data.shape, 'diamond')

  await applyDirect(
    store,
    {
      type: 'node.batch',
      payload: {
        ops: [
          { type: 'node.update', payload: { uid: 'a', patch: { fillColor: '#00ff00' } } },
          { type: 'node.update', payload: { uid: 'c', patch: { fillColor: '#00ff00' } } }
        ]
      }
    },
    { version: 8 }
  )
  assert.strictEqual((await store.getLive('a')).data.fillColor, '#00ff00')
  assert.strictEqual((await store.getLive('c')).data.fillColor, '#00ff00')

  const painter = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: {
        uid: 'c',
        patch: { fillColor: '#ff0000', fontSize: 22, color: '#111', shape: 'rectangle' }
      }
    },
    { version: 9 }
  )
  assert.strictEqual(painter.event.payload.patch.fillColor, '#ff0000')
  assert.strictEqual((await store.getLive('c')).parent_uid, 'root')

  const undo = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: styleOp.inversePayload.payload
    },
    { version: 10 }
  )
  void undo
  const afterUndo = await store.getLive('a')
  assert.notStrictEqual(afterUndo.data.fillColor, '#00ff00')
  assert.strictEqual(afterUndo.parent_uid, 'root')
  assert.strictEqual(afterUndo.position, 'a0')

  await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'a', patch: { fillColor: '#00ff00' } }
    },
    { version: 11 }
  )
  assert.strictEqual((await store.getLive('a')).data.fillColor, '#00ff00')

  const persistStyle = (await store.getLive('a')).data
  assert.strictEqual(persistStyle.fillColor, '#00ff00')
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(store.graph)),
    h1
  )

  const engine = createEngine()
  const roomKey = 'meta-style-' + Date.now()
  engine.getRoom(roomKey)
  await submit(engine, roomKey, 'node.insert', {
    uid: 'n1',
    parent: 'root',
    text: 'A'
  })
  await submit(engine, roomKey, 'node.insert', {
    uid: 'n2',
    parent: 'root',
    text: 'B'
  })
  const beforeTheme = structureSignature(
    canonicalStructureFromGraph(graphOf(engine, roomKey))
  )
  const themeLive = await submit(engine, roomKey, 'map.meta.update', {
    theme: 'classic2'
  })
  const themeEvent = liveMetaEvent(themeLive)
  assert.strictEqual(themeEvent.payload.patch.theme, 'classic2')
  assert.strictEqual(themeEvent.payload.layout, undefined)
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().theme, 'classic2')
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(graphOf(engine, roomKey))),
    beforeTheme
  )

  const layoutLive = await submit(engine, roomKey, 'map.meta.update', {
    layout: 'mindMap'
  })
  assert.strictEqual(liveMetaEvent(layoutLive).payload.patch.layout, 'mindMap')
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().theme, 'classic2')
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().layout, 'mindMap')

  await submit(engine, roomKey, 'map.meta.update', { theme: 'dark' })
  await submit(engine, roomKey, 'map.meta.update', { layout: 'logicalStructure' })
  const finalMeta = engine.getRoom(roomKey).store.getMeta()
  assert.strictEqual(finalMeta.theme, 'dark')
  assert.strictEqual(finalMeta.layout, 'logicalStructure')

  await submit(engine, roomKey, 'node.insert', {
    uid: 'n3',
    parent: 'root',
    text: 'C'
  })
  const afterInsert = structureSignature(
    canonicalStructureFromGraph(graphOf(engine, roomKey))
  )
  await submit(engine, roomKey, 'map.meta.update', { theme: 'classicGreen' })
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().layout, 'logicalStructure')
  const table = {
    nodes: graphOf(engine, roomKey),
    count: Object.keys(graphOf(engine, roomKey)).length,
    version: 1
  }
  const picked = pickAuthoritativeNodes({}, table, 99, {
    caller: 'meta-style-refresh',
    collabV2: true
  })
  assert.ok(picked.nodes.n3)
  assert.strictEqual(picked.source, 'table')
  assert.strictEqual(
    structureSignature(canonicalStructureFromGraph(picked.nodes)),
    afterInsert
  )

  await submit(engine, roomKey, 'node.update', {
    uid: 'n1',
    patch: { fillColor: '#abcdef', fontFamily: 'Georgia' }
  })
  const styled = await engine.getRoom(roomKey).store.getLive('n1')
  assert.strictEqual(styled.data.fillColor, '#abcdef')
  assert.strictEqual(styled.parent_uid, 'root')

  console.log('collabMapMetaStyle.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
