/* global require */

const assert = require('assert')
const {
  excludeCommonAncestorsOfEntireSelection,
  parseAddGeneralizationNodeList
} = require('../src/utils/parseAddGeneralizationNodeList')

function createNode(uid, parent = null) {
  const node = {
    uid,
    parent,
    children: [],
    getIndexInBrothers() {
      if (!this.parent || !this.parent.children) return -1
      return this.parent.children.findIndex(item => item.uid === this.uid)
    },
    isAncestor(other) {
      let current = other && other.parent
      while (current) {
        if (current.uid === this.uid) return true
        current = current.parent
      }
      return false
    }
  }
  if (parent) parent.children.push(node)
  return node
}

function createFamily() {
  const root = createNode('root')
  const parent = createNode('parent', root)
  const a = createNode('a', parent)
  const b = createNode('b', parent)
  const c = createNode('c', parent)
  const d = createNode('d', parent)
  return { root, parent, a, b, c, d }
}

function testExcludeCommonAncestors() {
  const { root, parent, a, b } = createFamily()
  const kept = excludeCommonAncestorsOfEntireSelection([root, parent, a, b])
  assert.deepStrictEqual(
    kept.map(node => node.uid).sort(),
    ['a', 'b']
  )
}

function testSingleNodeKeepsSelfSummary() {
  const { a } = createFamily()
  const list = parseAddGeneralizationNodeList([a])
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].node.uid, 'a')
  assert.strictEqual(list[0].range, undefined)
}

function testSelectedSiblingsCreateRangeOnParent() {
  const { parent, a, b, c } = createFamily()
  const list = parseAddGeneralizationNodeList([a, b, c])
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].node.uid, parent.uid)
  assert.deepStrictEqual(list[0].range, [0, 2])
}

function testBoxSelectParentAndChildrenUsesChildren() {
  const { parent, a, b, c } = createFamily()
  const list = parseAddGeneralizationNodeList([parent, a, b, c])
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].node.uid, parent.uid)
  assert.deepStrictEqual(list[0].range, [0, 2])
}

function testBoxSelectTwoBranchesMakesOneSummary() {
  const root = createNode('root')
  const parent = createNode('parent', root)
  const a = createNode('a', parent)
  const b = createNode('b', parent)
  const a1 = createNode('a1', a)
  const a2 = createNode('a2', a)
  const b1 = createNode('b1', b)
  const b2 = createNode('b2', b)
  const list = parseAddGeneralizationNodeList([a, a1, a2, b, b1, b2])
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].node.uid, parent.uid)
  assert.deepStrictEqual(list[0].range, [0, 1])
}

function testNonContiguousSiblingsStaySpecified() {
  const { a, c } = createFamily()
  const list = parseAddGeneralizationNodeList([a, c])
  assert.strictEqual(list.length, 2)
  const uids = list.map(item => item.node.uid).sort()
  assert.deepStrictEqual(uids, ['a', 'c'])
  list.forEach(item => {
    assert.strictEqual(item.range, undefined)
  })
}

function testSplitContiguousGroups() {
  const { parent, a, b, d } = createFamily()
  const list = parseAddGeneralizationNodeList([a, b, d])
  assert.strictEqual(list.length, 2)
  const rangeItem = list.find(item => item.range)
  const selfItem = list.find(item => !item.range)
  assert.strictEqual(rangeItem.node.uid, parent.uid)
  assert.deepStrictEqual(rangeItem.range, [0, 1])
  assert.strictEqual(selfItem.node.uid, 'd')
}

function testCousinsStayOnSpecifiedNodes() {
  const root = createNode('root')
  const p1 = createNode('p1', root)
  const p2 = createNode('p2', root)
  const a = createNode('a', p1)
  const b = createNode('b', p2)
  const list = parseAddGeneralizationNodeList([root, a, b])
  assert.strictEqual(list.length, 2)
  assert.deepStrictEqual(list.map(item => item.node.uid).sort(), ['a', 'b'])
}

testExcludeCommonAncestors()
testSingleNodeKeepsSelfSummary()
testSelectedSiblingsCreateRangeOnParent()
testBoxSelectParentAndChildrenUsesChildren()
testBoxSelectTwoBranchesMakesOneSummary()
testNonContiguousSiblingsStaySpecified()
testSplitContiguousGroups()
testCousinsStayOnSpecifiedNodes()
console.log('parseAddGeneralizationNodeList tests passed')
