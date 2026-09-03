const assert = require('assert')
const {
  snapshotNodeDataUids,
  collectNewNodeDataInserts,
  collectNodeDataUids,
  removeUidsFromNodeData
} = require('../src/utils/collabInsertCollect')

function node(uid, text, children = [], extra = {}) {
  return {
    data: { uid, text, ...extra },
    children
  }
}

function testSiblingInsertNotFoundByActiveWalk() {
  const parent = node('p', 'P', [node('a', 'A'), node('b', 'B')])
  const known = snapshotNodeDataUids([node('a', 'A')])
  const fromActiveOnly = collectNewNodeDataInserts([node('a', 'A')], {
    knownUids: known
  })
  assert.strictEqual(
    fromActiveOnly.length,
    0,
    'walking the old active node misses the new sibling'
  )
  const fromParent = collectNewNodeDataInserts([parent], {
    knownUids: snapshotNodeDataUids([node('p', 'P', [node('a', 'A')])])
  })
  assert.deepStrictEqual(
    fromParent.map(item => item.uid),
    ['b']
  )
  assert.strictEqual(fromParent[0].parent, 'p')
  assert.strictEqual(fromParent[0].index, 1)
}

function testInsertChild() {
  const before = node('p', 'P', [node('a', 'A')])
  const after = node('p', 'P', [node('a', 'A'), node('c', 'Child')])
  const rows = collectNewNodeDataInserts([after], {
    knownUids: snapshotNodeDataUids([before])
  })
  assert.deepStrictEqual(
    rows.map(item => item.uid),
    ['c']
  )
  assert.strictEqual(rows[0].parent, 'p')
}

function testSkipsKnownUnackedGhost() {
  const parent = node('p', 'P', [
    node('a', 'A'),
    node('ghost', 'Ghost'),
    node('b', 'B')
  ])
  const known = snapshotNodeDataUids([
    node('p', 'P', [node('a', 'A'), node('ghost', 'Ghost')])
  ])
  const rows = collectNewNodeDataInserts([parent], {
    knownUids: known,
    isAcked: uid => uid === 'a' || uid === 'p'
  })
  assert.deepStrictEqual(
    rows.map(item => item.uid),
    ['b']
  )
}

function testPasteSubtreeDepthOrder() {
  const before = node('p', 'P', [])
  const after = node('p', 'P', [
    node('x', 'X', [node('y', 'Y'), node('z', 'Z')])
  ])
  const rows = collectNewNodeDataInserts([after], {
    knownUids: snapshotNodeDataUids([before])
  })
  assert.deepStrictEqual(
    rows.map(item => item.uid),
    ['x', 'y', 'z']
  )
  assert.ok(rows[0].depth < rows[1].depth)
}

function testSkipsAckedAndTombstoned() {
  const parent = node('p', 'P', [
    node('a', 'A'),
    node('dead', 'Dead'),
    node('n', 'New')
  ])
  const rows = collectNewNodeDataInserts([parent], {
    knownUids: new Set(['p', 'a']),
    isAcked: uid => uid === 'a' || uid === 'p',
    isTombstoned: uid => uid === 'dead'
  })
  assert.deepStrictEqual(
    rows.map(item => item.uid),
    ['n']
  )
}

function testRemoveUidFromNodeDataBeforeInstanceExists() {
  const parent = node('p', 'P', [node('a', 'A'), node('ghost', '蔡徐坤123')])
  const uids = collectNodeDataUids(parent.children[1])
  assert.deepStrictEqual(uids, ['ghost'])
  const changed = removeUidsFromNodeData(parent, uids)
  assert.strictEqual(changed, true)
  assert.deepStrictEqual(
    parent.children.map(item => item.data.uid),
    ['a']
  )
}

function testTombstonedInsertNotCollected() {
  const parent = node('p', 'P', [node('a', 'A'), node('ghost', '蔡徐坤123')])
  const rows = collectNewNodeDataInserts([parent], {
    knownUids: new Set(['p', 'a']),
    isTombstoned: uid => uid === 'ghost'
  })
  assert.deepStrictEqual(
    rows.map(item => item.uid),
    []
  )
}

testSiblingInsertNotFoundByActiveWalk()
testInsertChild()
testSkipsKnownUnackedGhost()
testPasteSubtreeDepthOrder()
testSkipsAckedAndTombstoned()
testRemoveUidFromNodeDataBeforeInstanceExists()
testTombstonedInsertNotCollected()
console.log('collabInsertCollect.test.js ok')
