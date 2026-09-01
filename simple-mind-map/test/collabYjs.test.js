const assert = require('assert')
const Y = require('yjs')
const { applyObjectToDoc } = require('../bin/collabYjs')

const node = (uid, text, children = [], extra = {}) => ({
  isRoot: uid === 'root',
  data: { uid, text, ...extra },
  children
})

function cloneDoc(update) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  return doc
}

function testConcurrentChildrenArePreserved() {
  const base = new Y.Doc()
  const initial = { root: node('root', 'Root') }
  applyObjectToDoc(base, initial, { replace: true })
  const snapshot = Y.encodeStateAsUpdate(base)
  const a = cloneDoc(snapshot)
  const b = cloneDoc(snapshot)

  applyObjectToDoc(
    a,
    { root: node('root', 'Root', ['a']), a: node('a', 'A') },
    { previousObject: initial }
  )
  applyObjectToDoc(
    b,
    { root: node('root', 'Root', ['b']), b: node('b', 'B') },
    { previousObject: initial }
  )

  const merged = cloneDoc(snapshot)
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(b))
  const result = merged.getMap().toJSON()
  assert.deepStrictEqual(new Set(result.root.children), new Set(['a', 'b']))
  assert(result.a)
  assert(result.b)
}

function testDifferentNodeFieldsAreMerged() {
  const base = new Y.Doc()
  const initial = { root: node('root', 'Root', [], { note: 'old' }) }
  applyObjectToDoc(base, initial, { replace: true })
  const snapshot = Y.encodeStateAsUpdate(base)
  const a = cloneDoc(snapshot)
  const b = cloneDoc(snapshot)

  applyObjectToDoc(
    a,
    { root: node('root', 'Renamed', [], { note: 'old' }) },
    { previousObject: initial }
  )
  applyObjectToDoc(
    b,
    { root: node('root', 'Root', [], { note: 'new' }) },
    { previousObject: initial }
  )

  const merged = cloneDoc(snapshot)
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(b))
  const data = merged.getMap().toJSON().root.data
  assert.strictEqual(data.text, 'Renamed')
  assert.strictEqual(data.note, 'new')
}

function testConcurrentTextEditsAreMerged() {
  const base = new Y.Doc()
  const initial = { root: node('root', 'Root') }
  applyObjectToDoc(base, initial, { replace: true })
  const snapshot = Y.encodeStateAsUpdate(base)
  const a = cloneDoc(snapshot)
  const b = cloneDoc(snapshot)

  applyObjectToDoc(a, { root: node('root', 'ARoot') }, { previousObject: initial })
  applyObjectToDoc(b, { root: node('root', 'RootB') }, { previousObject: initial })

  const merged = cloneDoc(snapshot)
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(b))
  assert.strictEqual(merged.getMap().toJSON().root.data.text, 'ARootB')
}

function testReplaceDeletesStaleNodes() {
  const doc = new Y.Doc()
  const initial = {
    root: node('root', 'Root', ['old']),
    old: node('old', 'Old')
  }
  applyObjectToDoc(doc, initial, { replace: true })
  applyObjectToDoc(doc, { root: node('root', 'Fresh') }, { replace: true })
  assert.deepStrictEqual(doc.getMap().toJSON(), { root: node('root', 'Fresh') })
}

function testLegacyPlainObjectsAreMigrated() {
  const doc = new Y.Doc()
  const initial = { root: node('root', 'Root') }
  doc.getMap().set('root', initial.root)
  applyObjectToDoc(
    doc,
    { root: node('root', 'Root', ['a']), a: node('a', 'A') },
    { previousObject: initial }
  )
  assert(doc.getMap().get('root') instanceof Y.Map)
  assert.deepStrictEqual(doc.getMap().toJSON().root.children, ['a'])
}

function testLargeUnchangedMapDoesNotProduceUpdates() {
  const doc = new Y.Doc()
  const children = []
  const initial = { root: node('root', 'Root', children) }
  for (let i = 0; i < 5000; i++) {
    const uid = `node-${i}`
    children.push(uid)
    initial[uid] = node(uid, `Node ${i}`)
  }
  applyObjectToDoc(doc, initial, { replace: true })

  let updateCount = 0
  let updateBytes = 0
  doc.on('update', update => {
    updateCount += 1
    updateBytes += update.length
  })
  applyObjectToDoc(doc, initial, { previousObject: initial })
  assert.strictEqual(updateCount, 0, 'unchanged large maps must not emit Yjs updates')

  const changed = {
    ...initial,
    'node-2500': node('node-2500', 'Changed')
  }
  applyObjectToDoc(doc, changed, { previousObject: initial })
  assert.strictEqual(updateCount, 1)
  assert(updateBytes < 1024, `single-node edit emitted ${updateBytes} bytes`)
}

function testSingleEditDoesNotRewriteIsRoot() {
  const doc = new Y.Doc()
  const children = []
  const initial = { root: node('root', 'Root', children) }
  for (let i = 0; i < 2000; i++) {
    const uid = `node-${i}`
    children.push(uid)
    initial[uid] = node(uid, `Node ${i}`)
  }
  applyObjectToDoc(doc, initial, { replace: true })

  let isRootWrites = 0
  doc.getMap().observeDeep(events => {
    events.forEach(event => {
      const keys = event.changes && event.changes.keys
      if (keys && keys.has('isRoot')) isRootWrites += 1
    })
  })

  const changed = {
    ...initial,
    'node-7': node('node-7', 'Only this node')
  }
  applyObjectToDoc(doc, changed, { previousObject: initial })
  assert.strictEqual(
    isRootWrites,
    0,
    'editing one node must not rewrite isRoot on other nodes'
  )
}

testConcurrentChildrenArePreserved()
testDifferentNodeFieldsAreMerged()
testConcurrentTextEditsAreMerged()
testReplaceDeletesStaleNodes()
testLegacyPlainObjectsAreMigrated()
testLargeUnchangedMapDoesNotProduceUpdates()
testSingleEditDoesNotRewriteIsRoot()

function textOf(doc, uid = 'root') {
  const value = doc.getMap().get(uid).get('data').get('text')
  return value && value.toString ? value.toString() : value
}

function testStalePreviousDoesNotConcatDefaultText() {
  const doc = new Y.Doc()
  applyObjectToDoc(doc, { root: node('root', '分支主题') }, { replace: true })
  applyObjectToDoc(
    doc,
    { root: node('root', 'D') },
    { previousObject: { root: node('root', '') } }
  )
  assert.strictEqual(textOf(doc), 'D')
}

function testHtmlSpanDoesNotLeaveTagResidue() {
  const doc = new Y.Doc()
  applyObjectToDoc(
    doc,
    { root: node('root', '<span>分支主题</span>') },
    { replace: true }
  )
  applyObjectToDoc(
    doc,
    { root: node('root', 'D') },
    { previousObject: { root: node('root', '分支主题') } }
  )
  assert.strictEqual(textOf(doc), 'D')
}

testStalePreviousDoesNotConcatDefaultText()
testHtmlSpanDoesNotLeaveTagResidue()

const mindDoc = require('../bin/mindDoc')
function testOutlineTruncates() {
  const obj = {
    root: { data: { uid: 'root', text: 'Root' }, children: [], isRoot: true }
  }
  for (let i = 0; i < 20; i++) {
    const uid = `n${i}`
    obj.root.children.push(uid)
    obj[uid] = { data: { uid, text: `Node ${i}` }, children: [] }
  }
  const full = mindDoc.toOutline(obj)
  const clipped = mindDoc.toOutline(obj, { maxNodes: 5 })
  assert.ok(full.includes('Node 19'))
  assert.ok(!clipped.includes('Node 19'))
  assert.ok(clipped.includes('truncated at 5 nodes'))
}
testOutlineTruncates()

function testAddNodeOnDocDoesNotCloneWholeMap() {
  const doc = new Y.Doc()
  applyObjectToDoc(doc, { root: node('root', 'Root') }, { replace: true })
  const result = mindDoc.addNodeOnDoc(doc, { parent: 'root', text: 'Child' })
  assert.ok(result.uid)
  assert.strictEqual(result.parent_uid, 'root')
  assert.ok(doc.getMap().has(result.uid))
  const children = doc.getMap().get('root').get('children').toArray()
  assert.ok(children.includes(result.uid))
}

function testFullTreeTruncates() {
  const obj = {
    root: { data: { uid: 'root', text: 'Root' }, children: [], isRoot: true }
  }
  for (let i = 0; i < 20; i++) {
    const uid = `n${i}`
    obj.root.children.push(uid)
    obj[uid] = { data: { uid, text: `Node ${i}` }, children: [] }
  }
  const stats = {}
  const tree = mindDoc.objectToTree(obj, { maxNodes: 5, stats })
  assert.ok(tree)
  assert.strictEqual(stats.truncated, true)
  assert.ok(stats.count <= 5)
}

function testPgSnapshotHydratesCompactDoc() {
  const bloated = new Y.Doc()
  const snapshot = {
    root: node('root', 'Root', ['a', 'b']),
    a: node('a', 'A'),
    b: node('b', 'B', ['c']),
    c: node('c', 'C')
  }
  applyObjectToDoc(bloated, snapshot, { replace: true })
  applyObjectToDoc(
    bloated,
    { ...snapshot, a: node('a', 'A1') },
    { previousObject: snapshot }
  )
  applyObjectToDoc(
    bloated,
    { ...snapshot, a: node('a', 'A2') },
    { previousObject: { ...snapshot, a: node('a', 'A1') } }
  )
  const nodes = bloated.getMap().toJSON()
  const live = new Y.Doc()
  applyObjectToDoc(live, nodes, { replace: true, previousObject: {} })
  assert.strictEqual(live.getMap().toJSON().a.data.text, 'A2')
  assert.deepStrictEqual(live.getMap().toJSON().root.children, ['a', 'b'])
  assert.strictEqual(live.getMap().size, 4)
}

testAddNodeOnDocDoesNotCloneWholeMap()
testFullTreeTruncates()
testPgSnapshotHydratesCompactDoc()

function testPreviewKeepsCollapsedChildren() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: ['a']
    },
    a: { data: { uid: 'a', text: 'A', expand: true }, children: ['b'] },
    b: { data: { uid: 'b', text: 'B', expand: true }, children: ['c'] },
    c: { data: { uid: 'c', text: 'C', expand: true }, children: [] }
  }
  const preview = mindDoc.buildPreview(obj, {
    keepDepth: 1,
    largeAt: 3,
    clipAt: 3
  })
  assert.strictEqual(preview.collapsed, true)
  assert.strictEqual(preview.node_count, 4)
  assert.ok(preview.tree)
  assert.notStrictEqual(preview.tree.data.expand, false)
  assert.strictEqual(preview.tree.children.length, 1)
  assert.strictEqual(preview.tree.children[0].data.text, 'A')
  assert.strictEqual(preview.tree.children[0].data.expand, false)
  assert.strictEqual(preview.tree.children[0].children.length, 0)
}

testPreviewKeepsCollapsedChildren()

function testMediumPreviewKeepsCollapsedDescendants() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: ['a']
    },
    a: { data: { uid: 'a', text: 'A', expand: true }, children: ['b'] },
    b: { data: { uid: 'b', text: 'B', expand: true }, children: ['c'] },
    c: { data: { uid: 'c', text: 'C', expand: true }, children: [] }
  }
  for (let i = 0; i < 250; i++) {
    const uid = 'n' + i
    obj.root.children.push(uid)
    obj[uid] = { data: { uid, text: 'N' + i }, children: [] }
  }
  const preview = mindDoc.buildPreview(obj, { keepDepth: 2 })
  assert.strictEqual(preview.http_collab, true)
  assert.strictEqual(preview.clipped, false)
  const branch = preview.tree.children.find(item => item.data.uid === 'a')
  assert.ok(branch)
  assert.strictEqual(branch.children.length, 1)
  assert.strictEqual(branch.children[0].data.text, 'B')
  assert.strictEqual(branch.children[0].data.expand, false)
  assert.strictEqual(branch.children[0].children.length, 1)
}

testMediumPreviewKeepsCollapsedDescendants()

function testTenThousandPreviewAndSubtree() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: []
    }
  }
  for (let i = 0; i < 10000; i++) {
    const uid = 'n' + i
    obj.root.children.push(uid)
    obj[uid] = { data: { uid, text: 'N' + i }, children: [] }
  }
  const preview = mindDoc.buildPreview(obj, { keepDepth: 2, maxChildren: 8 })
  assert.strictEqual(preview.node_count, 10001)
  assert.strictEqual(preview.http_collab, true)
  assert.strictEqual(preview.collapsed, true)
  assert.strictEqual(preview.clipped, true)
  assert.strictEqual(preview.tree.children.length, 8)
  assert.strictEqual(preview.tree.data.hasMore, true)
  const subtree = mindDoc.subtreeChildren(obj, 'root', { limit: 3, offset: 10 })
  assert.strictEqual(subtree.total, 10000)
  assert.strictEqual(subtree.children.length, 3)
  assert.strictEqual(subtree.children[0].data.uid, 'n10')
  assert.strictEqual(subtree.children[0].children.length, 0)
  const one = mindDoc.subtreeChildren(obj, 'n5000')
  assert.strictEqual(one.uid, 'n5000')
  assert.strictEqual(one.total, 0)
  const located = mindDoc.locateNode(obj, 'n5000')
  assert.strictEqual(located.uid, 'n5000')
  assert.deepStrictEqual(located.ancestors, ['root', 'n5000'])
  const hits = mindDoc.searchNodes(obj, 'N9999', { limit: 5 })
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].uid, 'n9999')
}

testTenThousandPreviewAndSubtree()

function applyExpandToLevel(root, level) {
  const walk = (node, layerIndex, isRoot) => {
    if (!node || !node.data) return
    if (layerIndex < level) node.data.expand = true
    else if (!isRoot && ((node.children && node.children.length) || node.data.childCount)) {
      node.data.expand = false
    }
    ;(node.children || []).forEach(child => walk(child, layerIndex + 1, false))
  }
  walk(root, 0, true)
}

function testExpandToLevelThreeHydratesClippedBranch() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: ['a']
    },
    a: { data: { uid: 'a', text: 'A', expand: true }, children: ['b'] },
    b: { data: { uid: 'b', text: 'B', expand: false }, children: ['c'] },
    c: { data: { uid: 'c', text: 'C', expand: false }, children: [] }
  }
  for (let i = 0; i < 1500; i++) {
    const uid = 'n' + i
    obj.root.children.push(uid)
    obj[uid] = { data: { uid, text: 'N' + i }, children: [] }
  }
  const preview = mindDoc.buildPreview(obj, { keepDepth: 2 })
  assert.strictEqual(preview.clipped, true)
  const branch = preview.tree.children.find(item => item.data.uid === 'a')
  const second = branch.children.find(item => item.data.uid === 'b')
  assert.ok(second)
  assert.strictEqual(second.children.length, 0)
  assert.strictEqual(second.data.childCount, 1)
  const subtree = mindDoc.subtreeChildren(obj, 'b')
  second.children = subtree.children
  applyExpandToLevel(preview.tree, 3)
  assert.strictEqual(preview.tree.data.expand, true)
  assert.strictEqual(branch.data.expand, true)
  assert.strictEqual(second.data.expand, true)
  assert.strictEqual(second.children[0].data.uid, 'c')
  assert.notStrictEqual(second.children[0].data.expand, true)
}

testExpandToLevelThreeHydratesClippedBranch()
console.log('collabYjs tests passed')
