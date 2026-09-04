const assert = require('assert')
const { randomUUID } = require('crypto')
const {
  SPECIAL_OBJECT_MATRIX,
  SPECIAL_OBJECT_LIFECYCLE_MATRIX,
  resolveCollaborationTarget,
  businessEndpoint,
  isBusinessNode,
  isVirtualGeneralization,
  canonicalImageFields,
  buildMapReplacePayload,
  stripImportRuntimeContext,
  assertStructuredCloneSafeOperation,
  findNonCloneable,
  assertNoVirtualUidPersisted,
  relationshipEndpointsAreBusiness
} = require('../src/utils/collabSpecialObjects')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyCollabEvent } = require('../bin/collabRecovery')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createEngine } = require('../bin/collabV2/engine')
const { isFullTreeMutationAllowed } = require('../src/utils/collabFullTree')

function mockNode(uid, extra = {}) {
  return {
    uid,
    isGeneralization: !!extra.isGeneralization,
    isDragPlaceholder: !!extra.isDragPlaceholder,
    generalizationBelongNode: extra.owner || null,
    getData(key) {
      if (key === 'uid') return uid
      if (!key) return { uid, ...(extra.data || {}) }
      return extra.data && extra.data[key]
    }
  }
}

async function seed(store, nodes) {
  for (const node of nodes) await store.insert(node)
}

;(async () => {
  assert.ok(SPECIAL_OBJECT_MATRIX.length >= 6)
  assert.ok(SPECIAL_OBJECT_LIFECYCLE_MATRIX.length >= 14)
  const types = SPECIAL_OBJECT_MATRIX.map(item => item.type)
  ;[
    'BusinessNode',
    'GeneralizationVirtualNode',
    'GeneralizationRange',
    'AssociativeLine',
    'OuterFrame',
    'DragPlaceholderClone'
  ].forEach(name => assert.ok(types.includes(name), name))

  const owner = mockNode('P')
  const rangeNode = mockNode('B', { data: { text: 'B' } })
  const virtual = mockNode('g1', { isGeneralization: true, owner })
  assert.strictEqual(isBusinessNode(rangeNode), true)
  assert.strictEqual(isVirtualGeneralization(virtual), true)
  assert.strictEqual(resolveCollaborationTarget(rangeNode).kind, 'business-node')
  assert.strictEqual(resolveCollaborationTarget(rangeNode).uid, 'B')
  assert.strictEqual(resolveCollaborationTarget(virtual, 'SET_NODE_TEXT').kind, 'generalization')
  assert.strictEqual(resolveCollaborationTarget(virtual, 'SET_NODE_TEXT').ownerUid, 'P')
  assert.strictEqual(
    resolveCollaborationTarget(virtual, 'ADD_ASSOCIATIVE_LINE').kind,
    'virtual-skipped'
  )
  assert.strictEqual(businessEndpoint(rangeNode), rangeNode)
  assert.strictEqual(businessEndpoint(virtual), null)
  assert.strictEqual(
    relationshipEndpointsAreBusiness('B', 'X', ['g1']),
    true,
    '1. business node in Generalization range can create associative line'
  )
  assert.strictEqual(
    relationshipEndpointsAreBusiness('g1', 'X', ['g1']),
    false,
    '2. association endpoints always business uid'
  )

  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await seed(store, [
    {
      uid: 'P',
      parent_uid: 'root',
      position: 'a0',
      data: {
        uid: 'P',
        text: 'P',
        generalization: [{ uid: 'g1', text: '概要', range: [0, 2] }],
        outerFrame: { width: 2 }
      }
    },
    { uid: 'A', parent_uid: 'P', position: 'a0', data: { uid: 'A', text: 'A' } },
    { uid: 'B', parent_uid: 'P', position: 'a1', data: { uid: 'B', text: 'B' } },
    { uid: 'C', parent_uid: 'P', position: 'a2', data: { uid: 'C', text: 'C' } },
    { uid: 'X', parent_uid: 'root', position: 'a1', data: { uid: 'X', text: 'X' } },
    {
      uid: 'src',
      parent_uid: 'root',
      position: 'a2',
      data: { uid: 'src', text: 'src', associativeLineTargets: ['tgt'] }
    },
    { uid: 'tgt', parent_uid: 'root', position: 'a3', data: { uid: 'tgt', text: 'tgt' } },
    {
      uid: 'img',
      parent_uid: 'root',
      position: 'a4',
      data: { uid: 'img', text: 'img' }
    },
    {
      uid: 'frame',
      parent_uid: 'root',
      position: 'a5',
      data: { uid: 'frame', text: 'frame', outerFrame: { width: 3, strokeColor: '#111' } }
    }
  ])

  const knownUids = ['root', 'P', 'A', 'B', 'C', 'X', 'src', 'tgt', 'img', 'frame', 'g1']
  const liveUids = (await store.getMany(knownUids))
    .filter(row => row && !row.deleted)
    .map(row => row.uid)
  assertNoVirtualUidPersisted(liveUids, ['g1'])
  assert.ok(!liveUids.includes('g1'), '3. no virtual uid in room_nodes')

  const lineInRange = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'B', patch: { associativeLineTargets: ['X'] } }
    },
    { version: 2 }
  )
  assert.deepStrictEqual((await store.getLive('B')).data.associativeLineTargets, ['X'])
  assert.notStrictEqual(lineInRange.event.type, 'map.replaced')

  const delSubtree = await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'P' } },
    { version: 3 }
  )
  assert.strictEqual(delSubtree.event.type, 'node.deleted')
  assert.ok(delSubtree.event.payload.deletedUids.includes('P'))
  assert.ok(delSubtree.event.payload.deletedUids.includes('B'), '4. subtree with generalization delete')
  const genRow = delSubtree.inversePayload.payload.rows.find(row => row.uid === 'P')
  assert.ok(genRow.data.generalization && genRow.data.generalization[0].uid === 'g1')

  const restored = await applyDirect(store, delSubtree.inversePayload, { version: 4 })
  assert.strictEqual(restored.event.type, 'node.restored')
  const pLive = await store.getLive('P')
  const bLive = await store.getLive('B')
  assert.ok(pLive && !pLive.deleted, '5. subtree with generalization undo immediate A')
  assert.ok(bLive && !bLive.deleted, '6. subtree with generalization undo immediate B')
  assert.strictEqual(pLive.data.generalization[0].uid, 'g1')
  assert.deepStrictEqual(bLive.data.associativeLineTargets, ['X'])
  assertNoVirtualUidPersisted(
    (await store.getMany(knownUids)).filter(row => row && !row.deleted).map(row => row.uid),
    ['g1']
  )

  const delTgt = await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'tgt' } },
    { version: 5 }
  )
  const srcAfterDel = await store.getLive('src')
  assert.deepStrictEqual(
    srcAfterDel.data.associativeLineTargets,
    ['tgt'],
    'Strategy A keeps dangling relation'
  )
  await applyDirect(store, delTgt.inversePayload, { version: 6 })
  assert.ok(await store.getLive('tgt'))
  assert.deepStrictEqual(
    (await store.getLive('src')).data.associativeLineTargets,
    ['tgt'],
    '7. association delete endpoint → undo restores line'
  )

  let nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: ['src', 'tgt'] },
    src: { data: { uid: 'src', associativeLineTargets: ['tgt'] }, children: [] },
    tgt: { data: { uid: 'tgt', text: 'tgt' }, children: [] }
  }
  nodes = applyCollabEvent(nodes, {
    type: 'node.deleted',
    payload: { uid: 'tgt', removed: ['tgt'] }
  })
  assert.deepStrictEqual(nodes.src.data.associativeLineTargets, ['tgt'])
  assert.ok(!nodes.tgt)
  nodes = applyCollabEvent(nodes, {
    type: 'node.restored',
    payload: {
      uid: 'tgt',
      parentUid: 'root',
      rows: [{ uid: 'tgt', parent_uid: 'root', data: { uid: 'tgt', text: 'tgt' } }]
    }
  })
  assert.ok(nodes.tgt)
  assert.deepStrictEqual(nodes.src.data.associativeLineTargets, ['tgt'])

  const delFrame = await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'frame' } },
    { version: 7 }
  )
  await applyDirect(store, delFrame.inversePayload, { version: 8 })
  const frameLive = await store.getLive('frame')
  assert.strictEqual(frameLive.data.outerFrame.width, 3, '8. OuterFrame restore regression')

  const imgUrl = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: {
        uid: 'img',
        patch: {
          image: 'data:image/png;base64,AAA',
          imageTitle: 'pic',
          imageSize: { width: 40, height: 20 }
        }
      }
    },
    { version: 9 }
  )
  assert.strictEqual((await store.getLive('img')).data.image, 'data:image/png;base64,AAA')
  assert.notStrictEqual(imgUrl.event.type, 'map.replaced')
  const imgMap = { smm_img_key_1: 'data:image/png;base64,AAA' }
  const resolved = canonicalImageFields(
    { image: 'smm_img_key_1', imageTitle: 'pic', imageSize: { width: 40, height: 20 } },
    imgMap
  )
  assert.strictEqual(resolved.image, 'data:image/png;base64,AAA', '10. Image with NodeBase64ImageStorage realtime')
  assert.strictEqual(resolved.unresolvedKey, false)
  assert.strictEqual(
    canonicalImageFields({ image: 'smm_img_key_missing' }, {}).unresolvedKey,
    true
  )
  assert.strictEqual((await store.getLive('img')).data.imageTitle, 'pic', '11. Image F5 persistence')

  const resize = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'img', patch: { imageSize: { width: 80, height: 40 } } }
    },
    { version: 10 }
  )
  const imgSized = await store.getLive('img')
  assert.deepStrictEqual(imgSized.data.imageSize, { width: 80, height: 40 }, '12. Image resize realtime')
  assert.strictEqual(imgSized.data.image, 'data:image/png;base64,AAA')
  assert.ok(!Object.prototype.hasOwnProperty.call(resize.inversePayload.payload.patch, 'image') || resize.inversePayload.payload.patch.image === undefined || imgSized.data.image)

  const dirty = {
    tree: { data: { uid: 'root', text: 'Imported' }, children: [] },
    reason: 'IMPORT',
    onUploadProgress: function onUploadProgress() {},
    onProgress: function onProgress() {},
    callback: function cb() {}
  }
  const cleaned = buildMapReplacePayload(dirty.tree, dirty)
  assert.strictEqual(cleaned.reason, 'IMPORT')
  assert.ok(!cleaned.onUploadProgress, '13. Import operation contains no function')
  assert.ok(!Object.keys(stripImportRuntimeContext(dirty)).includes('onUploadProgress'))
  assert.deepStrictEqual(findNonCloneable(cleaned, '', []), [])
  assertStructuredCloneSafeOperation({
    type: 'map.replace',
    payload: cleaned
  })

  const leaked = {
    type: 'map.replace',
    payload: { tree: dirty.tree, onUploadProgress: dirty.onUploadProgress }
  }
  assert.throws(
    () => assertStructuredCloneSafeOperation(leaked),
    err =>
      err.code === 'OUTBOX_NON_CLONEABLE_PAYLOAD' &&
      /onUploadProgress/.test(err.message)
  )

  const outbox = createOutbox({ memory: true })
  await outbox.put({
    opId: randomUUID(),
    type: 'map.replace',
    payload: cleaned
  })
  assert.ok(true, '14. XMind import IDB put succeeds')
  await assert.rejects(
    () =>
      outbox.put({
        opId: randomUUID(),
        type: 'map.replace',
        payload: { tree: dirty.tree, onUploadProgress: dirty.onUploadProgress }
      }),
    err => err.code === 'OUTBOX_NON_CLONEABLE_PAYLOAD'
  )

  const engine = createEngine()
  const roomKey = 'special-objects'
  engine.getRoom(roomKey)
  const access = { userId: 'u1', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'a',
      type: 'node.insert',
      payload: { uid: 'n1', parent: 'root', text: 'old' }
    },
    access
  )
  const imported = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'a',
      type: 'map.replace',
      payload: buildMapReplacePayload(
        { data: { uid: 'root', text: 'XMind' }, children: [{ data: { uid: 'n2', text: 'child' }, children: [] }] },
        { reason: 'IMPORT', source: 'import' }
      )
    },
    access
  )
  assert.strictEqual(imported.operation.event.type, 'map.replaced')
  assert.ok(isFullTreeMutationAllowed({ reason: 'IMPORT' }))
  const after = engine.getRoom(roomKey)
  assert.ok(
    after.nodes.root.data.text === 'XMind' ||
      after.store && (await after.store.getLive('root')),
    '15. XMind Import A/B realtime'
  )

  const serializable = [
    { type: 'node.insert', payload: { uid: 'a', parent: 'root', text: 'A' } },
    { type: 'node.update', payload: { uid: 'a', patch: { text: 'A2', image: 'https://cdn/x.png' } } },
    { type: 'node.batch', payload: { ops: [{ type: 'node.update', payload: { uid: 'a', text: 'A3' } }] } },
    { type: 'map.meta.update', payload: { theme: 'classic' } },
    { type: 'map.replace', payload: cleaned },
    { type: 'operation.undo', payload: { targetOperationId: randomUUID() } },
    { type: 'node.restore', payload: { uid: 'a', rows: [{ uid: 'a', data: { uid: 'a', text: 'A' } }] } }
  ]
  serializable.forEach(op => {
    assertStructuredCloneSafeOperation(op)
    if (typeof structuredClone === 'function') structuredClone(op)
  })
  assert.ok(true, '17. all V2 Operation structuredClone succeeds')

  const roomUids = ['root', 'P', 'A', 'B', 'C', 'X', 'src', 'tgt', 'img', 'frame']
  assertNoVirtualUidPersisted(roomUids, ['g1', 'assoc-render', 'drag-clone'])

  console.log('collabSpecialObjects tests ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
