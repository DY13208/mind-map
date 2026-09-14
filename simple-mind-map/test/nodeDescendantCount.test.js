const assert = require('assert')
const {
  getKnownChildCount,
  getDescendantCount,
  countDescendants
} = require('../src/utils/nodeDescendantCount')

function collapsedNode(uid, childCount) {
  return {
    data: { uid, childCount },
    children: []
  }
}

function run() {
  const c1Children = [
    collapsedNode('daily', 11),
    collapsedNode('p1', 3),
    collapsedNode('p2', 3),
    collapsedNode('p3', 4),
    collapsedNode('p4', 14),
    collapsedNode('p5', 5),
    collapsedNode('p6', 2),
    collapsedNode('branch-1', 4),
    collapsedNode('branch-2', 2)
  ]

  assert.strictEqual(
    countDescendants(c1Children),
    57,
    'C1 must include its 9 direct children and all 48 known descendants'
  )

  const renderedNode = {
    children: [],
    nodeData: {
      data: { childCount: 6 },
      children: []
    }
  }
  assert.strictEqual(getKnownChildCount(renderedNode), 6)
  assert.strictEqual(countDescendants([renderedNode]), 7)

  const fullyLoaded = {
    data: { childCount: 2 },
    children: [
      { data: {}, children: [{ data: {}, children: [] }] },
      { data: {}, children: [] }
    ]
  }
  assert.strictEqual(
    countDescendants([fullyLoaded]),
    4,
    'loaded descendants must not be double-counted with childCount'
  )

  const sparse = {
    data: { childCount: 9, descendantCount: 254 },
    children: c1Children
  }
  assert.strictEqual(getDescendantCount(sparse), 254,
    'unloaded third through seventh levels must use the authoritative total')
  sparse.data.descendantCount = 253
  assert.strictEqual(getDescendantCount(sparse), 253,
    'authoritative decreases must not be replaced with a stale maximum')
  const raw = {
    data: { childCount: 2 },
    children: [fullyLoaded, { data: {}, children: [] }]
  }
  assert.strictEqual(getDescendantCount({
    nodeData: raw,
    children: [{ data: {}, children: [] }]
  }), 5, 'mounted children must not hide the rest of the raw subtree')
  assert.strictEqual(getDescendantCount({
    data: { childCount: 2, _overflowChildren: [fullyLoaded] },
    children: [{ data: {}, children: [] }]
  }), 5, 'locally stashed branches must be included')
  fullyLoaded.data.descendantCount = 999
  assert.strictEqual(getDescendantCount(fullyLoaded), 3,
    'a completely loaded local tree must reflect edits, not stale metadata')

  console.log('nodeDescendantCount tests passed')
}

run()
