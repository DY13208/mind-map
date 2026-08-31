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

testConcurrentChildrenArePreserved()
testDifferentNodeFieldsAreMerged()
testConcurrentTextEditsAreMerged()
testReplaceDeletesStaleNodes()
testLegacyPlainObjectsAreMigrated()
console.log('collabYjs tests passed')
