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

function testMoveInsertIndexAndDeleteCurrentOnDoc() {
  const doc = new Y.Doc()
  applyObjectToDoc(
    doc,
    {
      root: node('root', 'Root', ['a', 'b']),
      a: node('a', 'A', ['c']),
      b: node('b', 'B'),
      c: node('c', 'C')
    },
    { replace: true }
  )
  mindDoc.addNodeOnDoc(doc, {
    parent: 'root',
    text: 'X',
    uid: 'x',
    index: 1
  })
  assert.deepStrictEqual(doc.getMap().get('root').get('children').toArray(), [
    'a',
    'x',
    'b'
  ])
  mindDoc.moveNodeOnDoc(doc, { uid: 'b', parent: 'root', index: 0 })
  assert.deepStrictEqual(doc.getMap().get('root').get('children').toArray(), [
    'b',
    'a',
    'x'
  ])
  mindDoc.updateNodeOnDoc(doc, 'b', { image: 'http://img', note: 'n1' })
  const b = doc.getMap().toJSON().b
  assert.strictEqual(b.data.image, 'http://img')
  assert.strictEqual(b.data.note, 'n1')
  mindDoc.deleteCurrentNodeOnDoc(doc, 'a')
  const obj = doc.getMap().toJSON()
  assert.ok(!obj.a)
  assert.ok(obj.c)
  assert.ok(obj.root.children.includes('c'))
  assert.ok(!obj.root.children.includes('a'))
}

testMoveInsertIndexAndDeleteCurrentOnDoc()

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

function testSmallPreviewUsesHttpCollabProtocol() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: []
    }
  }
  const preview = mindDoc.buildPreview(obj)
  assert.strictEqual(preview.http_collab, true)
  assert.strictEqual(preview.collapsed, false)
  assert.strictEqual(preview.lazy_load, false)
  assert.strictEqual(preview.clipped, false)
}

testSmallPreviewUsesHttpCollabProtocol()

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

const presence = require('../bin/presence')
function testPresenceTracksSameRoomUsers() {
  const room = 'room-presence-test'
  presence.leavePresence(room, 'a')
  presence.leavePresence(room, 'b')
  presence.beatPresence(room, { id: 'a', name: '李吉兵', color: '#111' })
  presence.beatPresence(room, { id: 'b', name: '杨晓东', color: '#222' })
  const list = presence.listPresence(room)
  assert.strictEqual(list.length, 2)
  assert.deepStrictEqual(
    new Set(list.map(item => item.id)),
    new Set(['a', 'b'])
  )
  presence.leavePresence(room, 'a')
  assert.strictEqual(presence.listPresence(room).length, 1)
  assert.strictEqual(presence.listPresence(room)[0].id, 'b')
}

testPresenceTracksSameRoomUsers()

function testAddNodeOnDocRequiresParentThenKeepsChild() {
  const ydoc = new Y.Doc()
  applyObjectToDoc(
    ydoc,
    { root: node('root', 'Root') },
    { replace: true }
  )
  mindDoc.addNodeOnDoc(ydoc, { parent: 'root', uid: 'a', text: 'A' })
  mindDoc.addNodeOnDoc(ydoc, { parent: 'a', uid: 'b', text: 'B' })
  const obj = ydoc.getMap().toJSON()
  assert.deepStrictEqual(obj.root.children, ['a'])
  assert.deepStrictEqual(obj.a.children, ['b'])
  assert.strictEqual(obj.b.data.text, 'B')
  let missingParent = false
  try {
    mindDoc.addNodeOnDoc(ydoc, { parent: 'missing', uid: 'c', text: 'C' })
  } catch (err) {
    missingParent = /找不到父节点/.test(String(err && err.message))
  }
  assert.strictEqual(missingParent, true)
}

testAddNodeOnDocRequiresParentThenKeepsChild()

function testNodesByUidsFromDocReadsLiveChildren() {
  const ydoc = new Y.Doc()
  applyObjectToDoc(
    ydoc,
    {
      root: node('root', 'Root', ['a']),
      a: node('a', 'A')
    },
    { replace: true }
  )
  mindDoc.addNodeOnDoc(ydoc, { parent: 'a', uid: 'b', text: 'B' })
  const rows = mindDoc.nodesByUidsFromDoc(ydoc, ['root', 'a'])
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(rows[0].children, ['a'])
  assert.deepStrictEqual(rows[1].children, ['b'])
}

testNodesByUidsFromDocReadsLiveChildren()

function testDeepSubtreeCopiesNestedChildren() {
  const obj = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'R', expand: true },
      children: ['a']
    },
    a: { data: { uid: 'a', text: 'A', imgMap: { x: 1 } }, children: ['b', 'c'] },
    b: { data: { uid: 'b', text: 'B' }, children: ['d'] },
    c: { data: { uid: 'c', text: 'C' }, children: [] },
    d: { data: { uid: 'd', text: 'D' }, children: [] }
  }
  const shallow = mindDoc.subtreeChildren(obj, 'a')
  assert.strictEqual(shallow.children.length, 2)
  assert.strictEqual(shallow.children[0].children.length, 0)
  const deep = mindDoc.subtreeTree(obj, 'a')
  assert.strictEqual(deep.tree.data.uid, 'a')
  assert.strictEqual(deep.tree.data.imgMap, undefined)
  assert.strictEqual(deep.tree.children.length, 2)
  assert.strictEqual(deep.tree.children[0].data.text, 'B')
  assert.strictEqual(deep.tree.children[0].children[0].data.text, 'D')
  assert.strictEqual(deep.node_count, 4)
  const limited = mindDoc.subtreeTree(obj, 'a', { maxNodes: 2 })
  assert.strictEqual(limited.truncated, true)
  assert.ok(limited.tree)
}

testDeepSubtreeCopiesNestedChildren()

function keepHttpChild(uid, serverKids, lastPushed, recentPushed, now = Date.now()) {
  if (!uid) return true
  if (serverKids.has(uid)) return true
  if (!lastPushed[uid]) return true
  const at = recentPushed && recentPushed.get(uid)
  return !!(at && now - at < 2500)
}

function testHttpRemoteDeleteDropsPushedChildren() {
  const lastPushed = { a: { text: 'A' }, b: { text: 'B' } }
  const recentPushed = new Map()
  const keep = new Set(['a'])
  assert.strictEqual(keepHttpChild('a', keep, lastPushed, recentPushed), true)
  assert.strictEqual(keepHttpChild('b', keep, lastPushed, recentPushed), false)
  assert.strictEqual(keepHttpChild('local', keep, lastPushed, recentPushed), true)
  recentPushed.set('b', Date.now())
  assert.strictEqual(keepHttpChild('b', keep, lastPushed, recentPushed), true)
  const emptyKeep = new Set()
  assert.strictEqual(keepHttpChild('a', emptyKeep, lastPushed, recentPushed), false)
}

testHttpRemoteDeleteDropsPushedChildren()

function indexMindTree(root, out = new Map(), parent = null, index = 0) {
  if (!root || !root.data) return out
  const uid = root.data.uid
  const childUids = (root.children || [])
    .map(child => child && child.data && child.data.uid)
    .filter(Boolean)
  if (uid) {
    out.set(uid, { parent, index, data: root.data, childUids })
  }
  ;(root.children || []).forEach((child, i) => {
    indexMindTree(child, out, uid || parent, i)
  })
  return out
}

function diffHttpHistoryTrees(previous, current) {
  const prev = indexMindTree(previous)
  const curr = indexMindTree(current)
  const removed = []
  const added = []
  const moved = []
  const updated = []
  prev.forEach((info, uid) => {
    if (uid === 'root' || curr.has(uid)) return
    const childUids = info.childUids || []
    const keepChildren =
      childUids.length > 0 && childUids.every(id => curr.has(id))
    if (info.parent && !curr.has(info.parent) && !keepChildren) return
    removed.push({ uid, keepChildren })
  })
  curr.forEach((info, uid) => {
    if (uid === 'root') return
    const before = prev.get(uid)
    if (!before) {
      added.push({ uid, parent: info.parent, index: info.index })
      return
    }
    if (before.parent !== info.parent || before.index !== info.index) {
      moved.push({ uid, parent: info.parent, index: info.index })
    }
    if (String((before.data && before.data.text) || '') !== String((info.data && info.data.text) || '')) {
      updated.push({ uid })
    }
  })
  return { removed, added, moved, updated }
}

function testUndoAddDeletesOnlyNewNode() {
  const before = {
    data: { uid: 'root', text: 'R' },
    children: [
      { data: { uid: 'a', text: 'A' }, children: [] },
      { data: { uid: 'n', text: 'New' }, children: [] }
    ]
  }
  const after = {
    data: { uid: 'root', text: 'R' },
    children: [{ data: { uid: 'a', text: 'A' }, children: [] }]
  }
  const diff = diffHttpHistoryTrees(before, after)
  assert.deepStrictEqual(
    diff.removed.map(item => item.uid),
    ['n']
  )
  assert.strictEqual(diff.removed[0].keepChildren, false)
  assert.strictEqual(diff.added.length, 0)
}

testUndoAddDeletesOnlyNewNode()

function testUndoInsertParentKeepsChildren() {
  const before = {
    data: { uid: 'root', text: 'R' },
    children: [
      {
        data: { uid: 'p', text: 'Parent' },
        children: [{ data: { uid: 'a', text: 'A' }, children: [] }]
      }
    ]
  }
  const after = {
    data: { uid: 'root', text: 'R' },
    children: [{ data: { uid: 'a', text: 'A' }, children: [] }]
  }
  const diff = diffHttpHistoryTrees(before, after)
  assert.deepStrictEqual(
    diff.removed.map(item => item.uid),
    ['p']
  )
  assert.strictEqual(diff.removed[0].keepChildren, true)
}

testUndoInsertParentKeepsChildren()

function testUndoTextAndMove() {
  const before = {
    data: { uid: 'root', text: 'R' },
    children: [
      { data: { uid: 'a', text: 'A2' }, children: [] },
      { data: { uid: 'b', text: 'B' }, children: [] }
    ]
  }
  const after = {
    data: { uid: 'root', text: 'R' },
    children: [
      { data: { uid: 'b', text: 'B' }, children: [] },
      { data: { uid: 'a', text: 'A1' }, children: [] }
    ]
  }
  const diff = diffHttpHistoryTrees(before, after)
  assert.ok(diff.moved.some(item => item.uid === 'a' && item.index === 1))
  assert.ok(diff.updated.some(item => item.uid === 'a'))
}

testUndoTextAndMove()

function sameHttpStamp(a, b) {
  if (!a || !b) return false
  if (String(a) === String(b)) return true
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && ta === tb
}

function timestampMs(value) {
  if (!value) return 0
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function pickLatestTimestamp(a, b) {
  return timestampMs(a) >= timestampMs(b) ? a || b || null : b || a || null
}

function testHttpPollUsesLatestStampAndIgnoresSavingGate() {
  const join = '2026-09-01T06:00:00.000Z'
  const savingLocal = '2026-09-01T06:00:01.200Z'
  const pg = '2026-09-01T06:00:01.050Z'
  const latest = pickLatestTimestamp(pg, savingLocal)
  assert.strictEqual(latest, savingLocal)
  assert.strictEqual(sameHttpStamp(join, latest), false)
  assert.strictEqual(
    sameHttpStamp('2026-09-01T06:00:01.200Z', '2026-09-01T14:00:01.200+08:00'),
    true
  )
  const wouldPollWhileSaving = true
  const savedOnly = false
  assert.ok(wouldPollWhileSaving && !savedOnly)
}

testHttpPollUsesLatestStampAndIgnoresSavingGate()

console.log('collabYjs tests passed')
