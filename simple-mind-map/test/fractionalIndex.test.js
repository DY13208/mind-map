const assert = require('assert')
const {
  generateKeyBetween,
  generateNKeysBetween,
  comparePositions,
  insertPositionAt,
  applyPositionsToTree,
  encodeRank,
  STEP,
  WIDTH
} = require('../bin/fractionalIndex')

function testMidpointStaysBetweenBounds() {
  const first = generateKeyBetween(null, null)
  const after = generateKeyBetween(first, null)
  const before = generateKeyBetween(null, first)
  assert.ok(before < first)
  assert.ok(first < after)
  let left = first
  for (let i = 0; i < 25; i++) {
    const next = generateKeyBetween(left, after)
    assert.ok(next, `gap exhausted at ${i}`)
    assert.ok(left < next)
    assert.ok(next < after)
    left = next
  }
}

function testEvenKeysAreStrictlyIncreasing() {
  const keys = generateNKeysBetween(null, null, 20)
  assert.strictEqual(keys.length, 20)
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1] < keys[i])
    assert.strictEqual(keys[i].length, WIDTH)
  }
}

function testInsertPositionKeepsUnmovedSiblings() {
  const first = encodeRank(STEP)
  const second = encodeRank(STEP * 2n)
  const obj = {
    root: { isRoot: true, data: { uid: 'root' }, children: ['a', 'n', 'b'] },
    a: { data: { uid: 'a' }, children: [], position: first },
    b: { data: { uid: 'b' }, children: [], position: second },
    n: { data: { uid: 'n' }, children: [] }
  }
  const assigned = insertPositionAt(obj, 'root', 'n')
  assert.strictEqual(assigned.reindexed, false)
  assert.ok(obj.n.position)
  assert.ok(first < obj.n.position)
  assert.ok(obj.n.position < second)
  assert.strictEqual(obj.a.position, first)
  assert.strictEqual(obj.b.position, second)
}

function testTieBreakUsesUid() {
  assert.ok(comparePositions('A', 'B', 'z', 'a') < 0)
  assert.ok(comparePositions('A', 'A', 'a', 'b') < 0)
}

function testTreeAssignsPositionsFromChildOrder() {
  const obj = {
    root: { isRoot: true, data: { uid: 'root' }, children: ['b', 'a'] },
    a: { data: { uid: 'a' }, children: [] },
    b: { data: { uid: 'b' }, children: [] }
  }
  applyPositionsToTree(obj)
  assert.ok(obj.b.position < obj.a.position)
}

testMidpointStaysBetweenBounds()
testEvenKeysAreStrictlyIncreasing()
testInsertPositionKeepsUnmovedSiblings()
testTieBreakUsesUid()
testTreeAssignsPositionsFromChildOrder()
console.log('fractional index tests passed')
