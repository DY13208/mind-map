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

testAddNodeOnDocDoesNotCloneWholeMap()
testFullTreeTruncates()
console.log('collabYjs tests passed')
