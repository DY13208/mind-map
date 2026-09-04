const assert = require('assert')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { expandInverseByGroups } = require('../bin/fieldMerge')
const {
  collectDeleteRoots,
  deleteOperationsFromRoots,
  buildSubtreeFromRows
} = require('../src/utils/collabDelete')
const {
  isFullTreeMutationAllowed,
  withAllowedFullTreeMutation,
  resolveFullTreeReason
} = require('../src/utils/collabFullTree')

function mockNode(uid, children = [], extra = {}) {
  return {
    isRoot: uid === 'root',
    isGeneralization: !!extra.isGeneralization,
    generalizationBelongNode: extra.owner || null,
    getData(key) {
      if (key === 'uid') return uid
      return extra.data && extra.data[key]
    },
    nodeData: {
      data: { uid, ...(extra.data || {}) },
      children: children.map(child => child.nodeData || child)
    },
    children
  }
}

async function seedTree(store, nodes) {
  for (const node of nodes) {
    await store.insert(node)
  }
}

async function liveUids(store, uids) {
  const rows = await store.getMany(uids)
  return rows.filter(row => row && !row.deleted).map(row => row.uid).sort()
}

;(async () => {
  const p = mockNode('P', [
    mockNode('C1'),
    mockNode('C2', [mockNode('C21')]),
    mockNode('C3')
  ])
  const selection = collectDeleteRoots([p], 'REMOVE_NODE')
  assert.deepStrictEqual(selection.rootUids, ['P'])
  assert.deepStrictEqual(selection.descendantUids.sort(), ['C1', 'C2', 'C21', 'C3'])
  const ops = deleteOperationsFromRoots(selection)
  assert.strictEqual(ops.length, 1)
  assert.strictEqual(ops[0].type, 'node.delete')
  assert.strictEqual(ops[0].payload.uid, 'P')

  const gen = mockNode('g1', [], { isGeneralization: true, owner: mockNode('owner') })
  const genSel = collectDeleteRoots([gen], 'REMOVE_NODE')
  assert.deepStrictEqual(genSel.rootUids, [])
  assert.strictEqual(genSel.owners.length, 1)

  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  })
  await seedTree(store, [
    { uid: 'P', parent_uid: 'root', position: 'a0', data: { uid: 'P', text: 'P', fillColor: '#f00', tag: ['A'], image: 'http://img', associativeLineTargets: ['nX'] } },
    { uid: 'C1', parent_uid: 'P', position: 'a0', data: { uid: 'C1', text: 'C1' } },
    { uid: 'C2', parent_uid: 'P', position: 'a1', data: { uid: 'C2', text: 'C2' } },
    { uid: 'C21', parent_uid: 'C2', position: 'a0', data: { uid: 'C21', text: 'C21' } },
    { uid: 'C3', parent_uid: 'P', position: 'a2', data: { uid: 'C3', text: 'C3' } },
    { uid: 'leaf', parent_uid: 'root', position: 'a1', data: { uid: 'leaf', text: 'leaf', tag: ['T'], hyperlink: 'https://a', mapRef: { roomKey: 'r2' }, note: 'n' } },
    { uid: 'img', parent_uid: 'root', position: 'a2', data: { uid: 'img', text: 'img', image: 'http://keep', imageTitle: 'pic', imageSize: { width: 12, height: 8 } } },
    { uid: 'nX', parent_uid: 'root', position: 'a3', data: { uid: 'nX', text: 'line-target' } }
  ])

  const cases = [
    { uid: 'leaf', label: 'plain/styled/tag/hyperlink/mapRef leaf' },
    { uid: 'P', label: 'parent subtree' }
  ]
  for (const item of cases) {
    const before = await store.getLive(item.uid)
    assert.ok(before, item.label + ' exists')
  }

  const delP = await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'P' } },
    { version: 2 }
  )
  assert.strictEqual(delP.event.type, 'node.deleted')
  assert.deepStrictEqual(delP.event.payload.deletedUids.sort(), ['C1', 'C2', 'C21', 'C3', 'P'])
  assert.deepStrictEqual(await liveUids(store, ['P', 'C1', 'C2', 'C21', 'C3']), [])
  assert.strictEqual(delP.inversePayload.type, 'node.restore')
  assert.ok(delP.inversePayload.payload.rows.some(row => row.uid === 'C21'))

  const restored = await applyDirect(store, delP.inversePayload, { version: 3 })
  assert.strictEqual(restored.event.type, 'node.restored')
  assert.deepStrictEqual(
    await liveUids(store, ['P', 'C1', 'C2', 'C21', 'C3']),
    ['C1', 'C2', 'C21', 'C3', 'P']
  )
  const c21 = await store.getLive('C21')
  assert.strictEqual(c21.parent_uid, 'C2')
  const pLive = await store.getLive('P')
  assert.strictEqual(pLive.data.fillColor, '#f00')
  assert.deepStrictEqual(pLive.data.tag, ['A'])
  assert.strictEqual(pLive.data.image, 'http://img')

  const redone = await applyDirect(store, restored.inversePayload, { version: 4 })
  assert.strictEqual(redone.event.type, 'node.deleted')
  assert.deepStrictEqual(await liveUids(store, ['P', 'C1', 'C2', 'C21', 'C3']), [])

  await applyDirect(store, redone.inversePayload, { version: 5 })

  const leftover = await applyDirect(
    store,
    {
      type: 'node.batch',
      payload: {
        ops: [
          { type: 'node.delete', payload: { uid: 'P' } },
          { type: 'node.delete', payload: { uid: 'C1' } },
          { type: 'node.delete', payload: { uid: 'C21' } }
        ]
      }
    },
    { version: 6 }
  )
  assert.ok(leftover.event.payload.count >= 1)
  assert.deepStrictEqual(await liveUids(store, ['P', 'C1', 'C2', 'C21', 'C3']), [])

  const complex = await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'leaf' } },
    { version: 7 }
  )
  assert.ok(!(await store.getLive('leaf')))
  assert.ok(await store.getLive('nX'))
  await applyDirect(store, complex.inversePayload, { version: 8 })
  assert.ok(await store.getLive('leaf'))

  const imgClear = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'img', patch: { image: null, imageTitle: null, imageSize: null } }
    },
    { version: 9 }
  )
  const imgGone = await store.getLive('img')
  assert.strictEqual(imgGone.data.image, undefined)
  assert.strictEqual(imgClear.inversePayload.payload.patch.image, 'http://keep')
  assert.strictEqual(imgClear.inversePayload.payload.patch.imageTitle, 'pic')
  await applyDirect(store, imgClear.inversePayload, { version: 10 })
  const imgBack = await store.getLive('img')
  assert.strictEqual(imgBack.data.image, 'http://keep')
  assert.strictEqual(imgBack.data.imageTitle, 'pic')

  const nullable = ['tag', 'hyperlink', 'mapRef', 'icon', 'note']
  for (let i = 0; i < nullable.length; i++) {
    const key = nullable[i]
    const value =
      key === 'tag' || key === 'icon' ? ['X'] : key === 'mapRef' ? { roomKey: 'z' } : 'v'
    await applyDirect(
      store,
      { type: 'node.update', payload: { uid: 'leaf', patch: { [key]: value } } },
      { version: 20 + i * 2 }
    )
    const cleared = await applyDirect(
      store,
      { type: 'node.update', payload: { uid: 'leaf', patch: { [key]: null } } },
      { version: 21 + i * 2 }
    )
    assert.deepStrictEqual(cleared.inversePayload.payload.patch[key], value, key + ' inverse')
    await applyDirect(store, cleared.inversePayload, { version: 40 + i })
    const row = await store.getLive('leaf')
    assert.deepStrictEqual(row.data[key], value, key + ' restored')
  }

  const tree = buildSubtreeFromRows(
    [
      { uid: 'P', parent_uid: 'root', position: 'a0', data: { text: 'P' } },
      { uid: 'C1', parent_uid: 'P', position: 'a0', data: { text: 'C1' } }
    ],
    'P'
  )
  assert.strictEqual(tree.data.uid, 'P')
  assert.strictEqual(tree.children[0].data.uid, 'C1')

  assert.strictEqual(isFullTreeMutationAllowed({ reason: 'IMPORT' }), true)
  assert.strictEqual(isFullTreeMutationAllowed({ source: 'import' }), true)
  assert.strictEqual(isFullTreeMutationAllowed({ reason: 'IMPORT_UNDO' }), true)
  assert.strictEqual(isFullTreeMutationAllowed({ feature: 'theme' }), false)
  assert.strictEqual(isFullTreeMutationAllowed({ feature: 'layout' }), false)
  assert.strictEqual(isFullTreeMutationAllowed({ allowFullTree: true }), false)
  assert.strictEqual(resolveFullTreeReason({ source: 'import' }), 'IMPORT')
  const ran = withAllowedFullTreeMutation('IMPORT', () => 'ok')
  assert.strictEqual(ran, 'ok')
  assert.throws(
    () => withAllowedFullTreeMutation('THEME', () => 'no'),
    /COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION/
  )

  const inverse = expandInverseByGroups(
    { image: 'http://keep', imageTitle: 'pic', imageSize: { width: 1 } },
    ['image']
  )
  assert.strictEqual(inverse.image, 'http://keep')
  assert.strictEqual(inverse.imageTitle, 'pic')

  console.log('collabDeleteMatrix tests ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
