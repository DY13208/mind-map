const assert = require('assert')
const {
  validateNodeGraph,
  encodeNodeRows,
  decodeNodeRows,
  graphsEqual,
  padPosition
} = require('../bin/roomNodes')

const node = (uid, text, children = [], extra = {}) => ({
  isRoot: uid === 'root',
  data: { uid, text, ...extra },
  children
})

function testRoundtripPreservesTree() {
  const obj = {
    root: node('root', 'Root', ['a', 'b']),
    a: node('a', 'A', ['c']),
    b: node('b', 'B'),
    c: node('c', 'C', [], { note: 'keep' })
  }
  const check = validateNodeGraph(obj)
  assert.strictEqual(check.ok, true, check.errors.join('; '))
  const rows = encodeNodeRows(obj)
  assert.strictEqual(rows.find(row => row.uid === 'root').is_root, true)
  assert.strictEqual(rows.find(row => row.uid === 'a').parent_uid, 'root')
  assert.strictEqual(rows.find(row => row.uid === 'b').position, padPosition(1))
  const restored = decodeNodeRows(rows)
  assert.ok(graphsEqual(obj, restored))
  assert.deepStrictEqual(restored.root.children, ['a', 'b'])
  assert.strictEqual(restored.c.data.note, 'keep')
}

function testValidateRejectsCyclesAndMissingRoot() {
  const cyclic = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A', ['root'])
  }
  cyclic.a.isRoot = false
  const cycle = validateNodeGraph(cyclic)
  assert.strictEqual(cycle.ok, false)
  assert.ok(cycle.errors.some(item => /cycle/.test(item)))

  const missing = {
    a: node('a', 'A')
  }
  missing.a.isRoot = false
  const noRoot = validateNodeGraph(missing)
  assert.strictEqual(noRoot.ok, false)
  assert.ok(noRoot.errors.some(item => /missing root/.test(item)))

  const twoRoots = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A')
  }
  twoRoots.a.isRoot = true
  const many = validateNodeGraph(twoRoots)
  assert.strictEqual(many.ok, false)
  assert.ok(many.errors.some(item => /multiple roots/.test(item)))
}

function testSoftDeletedRowsAreIgnored() {
  const obj = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A')
  }
  const rows = encodeNodeRows(obj)
  rows.push({
    uid: 'gone',
    parent_uid: 'root',
    position: padPosition(9),
    data: { uid: 'gone', text: 'Gone' },
    is_root: false,
    deleted_at: new Date().toISOString()
  })
  const restored = decodeNodeRows(rows)
  assert.ok(!restored.gone)
  assert.deepStrictEqual(restored.root.children, ['a'])
}

testRoundtripPreservesTree()
testValidateRejectsCyclesAndMissingRoot()
testSoftDeletedRowsAreIgnored()
console.log('room node tests passed')
