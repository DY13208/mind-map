const assert = require('assert')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyUndoOrRedo, createMemoryLookup } = require('../bin/collabV2/undoApply')
const { createEngine } = require('../bin/collabV2/engine')
const {
  preparePasteTrees
} = require('../src/utils/collabPaste')
const {
  pasteUndoInverse,
  forestRootsFromInserts,
  collectInsertedUids,
  isInsertLikeOperation,
  rewriteInsertInverse
} = require('../src/utils/collabPasteUndo')
const { checkTreeGraph } = require('../src/utils/collabTreeIntegrity')

function tree(uid, extra = {}, children = []) {
  return {
    data: { uid, text: extra.text || uid, ...extra },
    children
  }
}

async function seedBase(store) {
  await store.insert({
    uid: 'A',
    parent_uid: 'root',
    position: 'a0V',
    data: { uid: 'A', text: 'A' }
  })
  await store.insert({
    uid: 'B',
    parent_uid: 'root',
    position: 'a1V',
    data: { uid: 'B', text: 'B' }
  })
  await store.insert({
    uid: 'P',
    parent_uid: 'root',
    position: 'a2V',
    data: { uid: 'P', text: 'P' }
  })
  await store.insert({
    uid: 'C1',
    parent_uid: 'P',
    position: 'a0V',
    data: { uid: 'C1', text: 'C1' }
  })
  await store.insert({
    uid: 'C2',
    parent_uid: 'P',
    position: 'a1V',
    data: { uid: 'C2', text: 'C2' }
  })
}

async function liveUids(store) {
  const root = await store.resolveRoot()
  const all = ['A', 'B', 'P', 'C1', 'C2']
  const out = []
  if (await store.getLive(root)) out.push(root)
  for (const uid of all) {
    if (await store.getLive(uid)) out.push(uid)
  }
  return out
}

;(async () => {
  const leaf = preparePasteTrees([tree('leaf1', { text: 'leaf' })])
  assert.ok(!leaf.pastedUids.includes('leaf1'))
  const leafInverse = pasteUndoInverse([
    { type: 'node.insert', payload: { uid: leaf.pastedUids[0], parent: 'root' } }
  ])
  assert.strictEqual(leafInverse.type, 'node.delete')
  assert.strictEqual(leafInverse.payload.uid, leaf.pastedUids[0])

  const sub = preparePasteTrees([
    tree('P', { text: 'P' }, [tree('C1', { text: 'C1' }), tree('C2', { text: 'C2' })])
  ])
  assert.strictEqual(sub.pastedUids.length, 3)
  assert.ok(sub.originalUids.every(uid => !sub.pastedUids.includes(uid)))
  const pasteOps = [
    { type: 'node.insert', payload: { uid: sub.pastedUids[0], parent: 'root' } },
    {
      type: 'node.insert',
      payload: { uid: sub.pastedUids[1], parent: sub.pastedUids[0] }
    },
    {
      type: 'node.insert',
      payload: { uid: sub.pastedUids[2], parent: sub.pastedUids[0] }
    }
  ]
  const roots = forestRootsFromInserts(pasteOps)
  assert.deepStrictEqual(roots, [sub.pastedUids[0]])
  const inv = pasteUndoInverse(pasteOps)
  assert.strictEqual(inv.type, 'node.delete')
  assert.strictEqual(inv.payload.uid, sub.pastedUids[0])
  assert.notStrictEqual(inv.type, 'map.replace')

  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await seedBase(store)
  const inserted = await applyDirect(
    store,
    { type: 'node.batch', payload: { ops: pasteOps } },
    { version: 2 }
  )
  assert.ok(isInsertLikeOperation({ type: 'node.batch', payload: { ops: pasteOps } }))
  assert.strictEqual(inserted.inversePayload.type, 'node.delete')
  assert.strictEqual(inserted.inversePayload.payload.uid, sub.pastedUids[0])
  assert.ok(await store.getLive('P'))
  assert.ok(await store.getLive('C1'))
  assert.ok(await store.getLive(sub.pastedUids[0]))
  assert.ok(await store.getLive(sub.pastedUids[1]))

  const undone = await applyDirect(store, inserted.inversePayload, { version: 3 })
  assert.ok(await store.getLive('root'), '10. root survives paste undo')
  assert.ok(await store.getLive('A'))
  assert.ok(await store.getLive('B'))
  assert.ok(await store.getLive('P'))
  assert.ok(await store.getLive('C1'))
  assert.ok(await store.getLive('C2'))
  assert.ok(!(await store.getLive(sub.pastedUids[0])), '2. pasted subtree gone')
  assert.ok(!(await store.getLive(sub.pastedUids[1])))
  assert.ok(!(await store.getLive(sub.pastedUids[2])))
  assert.notStrictEqual((undone.event && undone.event.type) || '', 'map.replaced')

  const restored = await applyDirect(store, undone.inversePayload, { version: 4 })
  assert.ok(await store.getLive(sub.pastedUids[0]), '6. redo restores copy only')
  assert.ok(await store.getLive(sub.pastedUids[1]))
  assert.ok(await store.getLive('P'))
  assert.ok(await store.getLive('C1'))

  const imgCopy = preparePasteTrees([
    tree('img-orig', {
      text: 'pic',
      image: 'data:image/png;base64,AAA',
      imageTitle: 'pic'
    })
  ])
  const imgStore = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await imgStore.insert({
    uid: 'img-orig',
    parent_uid: 'root',
    position: 'a0',
    data: {
      uid: 'img-orig',
      text: 'pic',
      image: 'data:image/png;base64,AAA',
      imageTitle: 'pic'
    }
  })
  const imgInsert = await applyDirect(
    imgStore,
    {
      type: 'node.insert',
      payload: {
        uid: imgCopy.pastedUids[0],
        parent: 'root',
        text: 'pic',
        data: imgCopy.trees[0].data
      }
    },
    { version: 2 }
  )
  assert.strictEqual(imgInsert.inversePayload.type, 'node.delete')
  await applyDirect(imgStore, imgInsert.inversePayload, { version: 3 })
  const origImg = await imgStore.getLive('img-orig')
  assert.ok(origImg, '7. original image node lives')
  assert.strictEqual(origImg.data.image, 'data:image/png;base64,AAA')
  assert.ok(!(await imgStore.getLive(imgCopy.pastedUids[0])))

  const rewritten = rewriteInsertInverse(
    { type: 'node.batch', payload: { ops: pasteOps } },
    {
      type: 'node.batch',
      payload: {
        ops: pasteOps
          .slice()
          .reverse()
          .map(op => ({ type: 'node.delete', payload: { uid: op.payload.uid } }))
      }
    }
  )
  assert.strictEqual(rewritten.type, 'node.delete')
  assert.strictEqual(rewritten.payload.uid, sub.pastedUids[0])

  let fullTreeHit = false
  try {
    rewriteInsertInverse(
      { type: 'node.batch', payload: { ops: pasteOps } },
      { type: 'map.replace', payload: { nodes: { root: {} } } }
    )
  } catch (err) {
    fullTreeHit = err.code === 'PASTE_UNDO_FULL_TREE_FORBIDDEN'
  }
  assert.ok(fullTreeHit, '5. paste undo must not map.replace')

  const { randomUUID } = require('crypto')
  const engine = createEngine()
  const roomKey = 'paste-undo-room'
  const access = { userId: 'u1', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'paste-undo-client',
      type: 'node.insert',
      payload: { uid: 'P2', parent: 'root', text: 'P2' }
    },
    access
  )
  const pasted = await engine.submit(
    {
      type: 'node.batch',
      roomKey,
      opId: randomUUID(),
      userId: 'u1',
      clientId: 'paste-undo-client',
      payload: { ops: pasteOps }
    },
    access
  )
  assert.strictEqual(pasted.operation.inversePayload.type, 'node.delete')
  const lookupRoom = engine.getRoom(roomKey)
  const undoneOp = await applyUndoOrRedo(
    lookupRoom.store,
    {
      type: 'operation.undo',
      roomKey,
      userId: 'u1',
      payload: { targetOperationId: pasted.operation.opId }
    },
    {
      version: 99,
      lookup: createMemoryLookup(lookupRoom)
    }
  )
  assert.notStrictEqual(undoneOp.generatedType, 'map.replace')
  assert.ok(await lookupRoom.store.getLive('P2'))
  assert.ok(!(await lookupRoom.store.getLive(sub.pastedUids[0])))

  const graph = checkTreeGraph(
    [
      { uid: 'root', is_root: true, parent_uid: null },
      { uid: 'A', parent_uid: 'root' },
      { uid: 'B', parent_uid: 'root' },
      { uid: 'P', parent_uid: 'root' },
      { uid: 'C1', parent_uid: 'P' },
      { uid: 'C2', parent_uid: 'P' }
    ],
    { originalUids: ['P', 'C1', 'C2'], pastedUids: sub.pastedUids }
  )
  assert.ok(graph.ok, '9. tree graph invariant: ' + graph.errors.join(','))

  console.log('collabPasteUndo.test.js ok', await liveUids(store), collectInsertedUids({
    type: 'node.batch',
    payload: { ops: pasteOps }
  }))
})().catch(err => {
  console.error(err)
  process.exit(1)
})
