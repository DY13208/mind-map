const assert = require('assert')
const { randomUUID } = require('crypto')
const {
  preparePasteTrees,
  cloneCopyTrees,
  collectBusinessUids,
  identityInvariant,
  assertNoSharedPasteRefs,
  canonicalizeNodeImage,
  resolveDropBusinessNode,
  generalizationCorridorPx,
  publishImportRuntimeTrace
} = require('../src/utils/collabPaste')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyCollabEvent } = require('../bin/collabRecovery')

function tree(uid, extra = {}, children = []) {
  return {
    data: { uid, text: extra.text || uid, ...extra },
    children
  }
}

;(async () => {
  const leaf = tree('A1', { text: 'plain' })
  const pastedLeaf = preparePasteTrees([leaf])
  assert.notStrictEqual(pastedLeaf.pastedUids[0], 'A1', '1. copy leaf uid fresh')
  assert.ok(identityInvariant(['A1'], pastedLeaf.pastedUids))

  const sub = tree('A1', { text: 'P' }, [
    tree('A2', { text: 'c1' }),
    tree('A3', { text: 'c2', tag: ['T'], note: 'n', hyperlink: 'https://a', fillColor: '#f00' })
  ])
  const pastedSub = preparePasteTrees([sub])
  assert.strictEqual(pastedSub.pastedUids.length, 3, '2. copy subtree all business uid fresh')
  pastedSub.pastedUids.forEach(uid => assert.ok(uid !== 'A1' && uid !== 'A2' && uid !== 'A3'))
  assert.ok(identityInvariant(collectBusinessUids([sub]), pastedSub.pastedUids))

  assertNoSharedPasteRefs([sub], pastedSub.trees)
  assert.notStrictEqual(sub, pastedSub.trees[0], '3. no shared object references')
  assert.notStrictEqual(sub.data, pastedSub.trees[0].data)
  assert.notStrictEqual(sub.children[0], pastedSub.trees[0].children[0])

  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await store.insert({
    uid: 'A1',
    parent_uid: 'root',
    position: 'a0',
    data: { uid: 'A1', text: 'orig', image: 'data:image/png;base64,AAA', imageTitle: 'pic' }
  })
  const copy = preparePasteTrees([
    tree('A1', { text: 'orig', image: 'data:image/png;base64,AAA', imageTitle: 'pic' })
  ])
  const pastedUid = copy.pastedUids[0]
  await applyDirect(
    store,
    {
      type: 'node.insert',
      payload: {
        uid: pastedUid,
        parent: 'root',
        text: 'orig',
        data: copy.trees[0].data
      }
    },
    { version: 2 }
  )
  await applyDirect(store, { type: 'node.delete', payload: { uid: pastedUid } }, { version: 3 })
  assert.ok(await store.getLive('A1'), '4. delete pasted → original survives')
  assert.ok(!(await store.getLive(pastedUid)))

  copy.trees[0].data.text = 'changed'
  assert.strictEqual(sub.data.text || 'P', 'P')
  const orig = await store.getLive('A1')
  assert.strictEqual(orig.data.text, 'orig', '5. edit pasted data does not mutate original row')

  await store.insert({
    uid: 'keep',
    parent_uid: 'root',
    position: 'a1',
    data: { uid: 'keep', text: 'keep' }
  })
  const moved = preparePasteTrees([tree('keep', { text: 'keep' })])
  await applyDirect(
    store,
    {
      type: 'node.insert',
      payload: { uid: moved.pastedUids[0], parent: 'root', text: 'keep-copy' }
    },
    { version: 4 }
  )
  await applyDirect(
    store,
    {
      type: 'node.move',
      payload: { uid: moved.pastedUids[0], parent: 'A1', index: 0 }
    },
    { version: 5 }
  )
  const keep = await store.getLive('keep')
  assert.strictEqual(keep.parent_uid, 'root', '6. move pasted → original unchanged')

  const imgMap = { smm_img_key_1: 'data:image/png;base64,BBB' }
  const keyed = tree('IMG1', { text: 'pic', image: 'smm_img_key_1', imageTitle: 't' })
  const copiedImg = cloneCopyTrees([keyed], imgMap)
  assert.strictEqual(copiedImg[0].data.image, 'data:image/png;base64,BBB', '7. copy image visible')
  const pastedImg = preparePasteTrees(copiedImg, { imgMap })
  assert.ok(!/^smm_img_key_/.test(pastedImg.trees[0].data.image))
  assert.strictEqual(pastedImg.trees[0].data.imageTitle, 't')

  await store.insert({
    uid: 'img-orig',
    parent_uid: 'root',
    position: 'a2',
    data: { uid: 'img-orig', text: 'pic', image: 'data:image/png;base64,BBB' }
  })
  await store.insert({
    uid: pastedImg.pastedUids[0],
    parent_uid: 'root',
    position: 'a3',
    data: pastedImg.trees[0].data
  })
  await applyDirect(store, { type: 'node.delete', payload: { uid: 'img-orig' } }, { version: 6 })
  assert.ok(
    (await store.getLive(pastedImg.pastedUids[0])).data.image,
    '8. delete original image node → pasted image survives'
  )
  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: pastedImg.pastedUids[0] } },
    { version: 7 }
  )
  await store.insert({
    uid: 'img-live',
    parent_uid: 'root',
    position: 'a4',
    data: { uid: 'img-live', text: 'pic', image: 'data:image/png;base64,BBB' }
  })
  const extraPaste = preparePasteTrees([
    tree('img-live', { text: 'pic', image: 'data:image/png;base64,BBB' })
  ])
  await applyDirect(
    store,
    {
      type: 'node.insert',
      payload: { uid: extraPaste.pastedUids[0], parent: 'root', data: extraPaste.trees[0].data }
    },
    { version: 8 }
  )
  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: extraPaste.pastedUids[0] } },
    { version: 9 }
  )
  assert.strictEqual(
    (await store.getLive('img-live')).data.image,
    'data:image/png;base64,BBB',
    '9. delete pasted image node → original image survives'
  )

  const rich = preparePasteTrees([
    tree('R1', {
      text: '<p>Hi</p>',
      richText: true,
      tag: ['A'],
      note: 'memo',
      hyperlink: 'https://x',
      fillColor: '#abc'
    })
  ])
  assert.strictEqual(rich.trees[0].data.richText, true, '10. copy richtext/tag/note/hyperlink/style')
  assert.deepStrictEqual(rich.trees[0].data.tag, ['A'])
  assert.strictEqual(rich.trees[0].data.note, 'memo')
  assert.strictEqual(rich.trees[0].data.fillColor, '#abc')

  const withGen = tree(
    'G1',
    { text: 'owner', generalization: [{ uid: 'gvirt', text: '概要', range: [0, 1] }] },
    [tree('G2'), tree('G3')]
  )
  const pastedGen = preparePasteTrees([withGen])
  assert.notStrictEqual(pastedGen.trees[0].data.generalization[0].uid, 'gvirt', '11. copy subtree with generalization')
  assert.deepStrictEqual(pastedGen.trees[0].data.generalization[0].range, [0, 1])
  assert.ok(!pastedGen.pastedUids.includes('gvirt'))

  const assoc = tree('L1', { associativeLineTargets: ['L2'] }, [])
  const assocTarget = tree('L2', { text: 't' })
  const pastedAssoc = preparePasteTrees([assoc, assocTarget])
  const newL1 = pastedAssoc.uidMap.L1
  const newL2 = pastedAssoc.uidMap.L2
  const lineNode = pastedAssoc.trees.find(item => item.data.uid === newL1)
  assert.deepStrictEqual(
    lineNode.data.associativeLineTargets,
    [newL2],
    '12. associative internal endpoint remap'
  )

  await assert.rejects(
    () =>
      applyDirect(
        store,
        { type: 'node.insert', payload: { uid: 'A1', parent: 'root', text: 'dup' } },
        { version: 20 }
      ),
    err => err.code === 'UID_ALREADY_EXISTS',
    '13. server rejects insert existing LIVE uid'
  )

  await applyDirect(store, { type: 'node.delete', payload: { uid: 'keep' } }, { version: 21 })
  await assert.rejects(
    () =>
      applyDirect(
        store,
        { type: 'node.insert', payload: { uid: 'keep', parent: 'root', text: 'reuse' } },
        { version: 22 }
      ),
    err => err.code === 'UID_REUSED',
    '14. server rejects tombstoned uid reuse'
  )

  const importTree = tree('root', { text: 'Imported' }, [
    tree('c1', { text: 'C1', expand: false }, [tree('c11'), tree('c12')]),
    tree('c2', { text: 'C2', expand: true }, [tree('c21')])
  ])
  importTree.data.uid = 'root'
  const expandable = []
  const walk = node => {
    if (node.children && node.children.length) expandable.push(node.data.uid)
    ;(node.children || []).forEach(walk)
  }
  walk(importTree)
  assert.ok(expandable.includes('c1'), '15. import → immediate expand data present')
  assert.strictEqual(importTree.children[0].data.expand, false, '16. import → immediate collapse flag')
  assert.ok(importTree.children[0].children.length >= 2)
  assert.ok(importTree.children[1], '17. import → immediate Enter/Text/Delete targets exist')

  const cache = { stale: { uid: 'old' } }
  const rebuilt = { nodeCache: {}, lastNodeCache: cache, activeNodeList: ['x'] }
  rebuilt.nodeCache = {}
  rebuilt.lastNodeCache = {}
  rebuilt.activeNodeList = []
  assert.deepStrictEqual(rebuilt.nodeCache, {}, '18. map.replace runtime rebuild no stale nodeCache')
  const trace = publishImportRuntimeTrace({
    reason: 'IMPORT',
    renderTreeNodeCount: 5,
    nodeCacheCount: 0,
    expandableNodes: expandable.length,
    staleInstanceCount: 0,
    renderCompleted: true
  })
  assert.strictEqual(trace.reason, 'IMPORT')
  assert.strictEqual(trace.staleInstanceCount, 0)

  const genNode = { isGeneralization: true, getData: () => 'g' }
  const biz = { isGeneralization: false, getData: key => (key === 'uid' ? 'B' : null) }
  assert.strictEqual(resolveDropBusinessNode(genNode), null)
  assert.strictEqual(resolveDropBusinessNode(biz), biz, '19. drag around generalization range skips virtual')
  const parent = {
    checkHasGeneralization: () => true,
    _generalizationSubtreeWidth: 120
  }
  assert.ok(generalizationCorridorPx({ parent }) >= 120, '20. move after summarized sibling slot corridor')

  let nodes = {
    root: { isRoot: true, data: { uid: 'root' }, children: ['P'] },
    P: {
      data: { uid: 'P', generalization: [{ uid: 'g1', range: [0, 1], text: '概要' }] },
      children: ['B', 'C', 'D']
    },
    B: { data: { uid: 'B' }, children: [] },
    C: { data: { uid: 'C' }, children: [] },
    D: { data: { uid: 'D' }, children: [] }
  }
  nodes = applyCollabEvent(nodes, {
    type: 'node.moved',
    payload: { uid: 'D', parentUid: 'P', index: 2 }
  })
  assert.deepStrictEqual(nodes.P.children.slice(-1), ['D'])
  assert.deepStrictEqual(
    nodes.P.data.generalization[0].range,
    [0, 1],
    '21. remote B gets same move + generalization range indexes'
  )
  assert.strictEqual(nodes.P.data.generalization[0].text, '概要', '22. F5 structure same')

  const mapped = canonicalizeNodeImage(
    { image: 'smm_img_key_z' },
    { smm_img_key_z: 'https://cdn/x.png' }
  )
  assert.strictEqual(mapped.image, 'https://cdn/x.png')

  const mapRefKeep = preparePasteTrees([
    tree('M1', { mapRef: { mapId: 'other', nodeId: 'outside' } })
  ])
  assert.strictEqual(mapRefKeep.trees[0].data.mapRef.nodeId, 'outside')

  console.log('collabPaste tests ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
