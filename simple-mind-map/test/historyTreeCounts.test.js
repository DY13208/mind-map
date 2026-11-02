const assert = require('assert')
const {
  normalizeHistoryGraph,
  normalizeHistoryTree
} = require('../src/utils/historyTreeCounts')

function testEmptyAndLeafGraphs() {
  assert.deepStrictEqual(normalizeHistoryGraph({}), {})
  const leaf = {
    root: {
      isRoot: true,
      data: { uid: 'root', childCount: 3, descendantCount: 6, hasMore: true },
      children: []
    }
  }
  const normalized = normalizeHistoryGraph(leaf)
  assert.deepStrictEqual(normalized.root.children, [])
  assert.deepStrictEqual(
    {
      childCount: normalized.root.data.childCount,
      descendantCount: normalized.root.data.descendantCount,
      hasMore: normalized.root.data.hasMore
    },
    { childCount: 0, descendantCount: 0, hasMore: undefined }
  )
}

function testCountsAndImmutability() {
  const tree = {
    data: {
      uid: 'root',
      childCount: 99,
      descendantCount: 99,
      hasMore: true,
      expand: false,
      __fv: { childCount: 4 },
      imgMap: { image: 'data:image/png;base64,x' }
    },
    children: [
      {
        data: {
          uid: 'a',
          childCount: 88,
          descendantCount: 88,
          hasMore: true,
          note: 'keep'
        },
        children: [{ data: { uid: 'leaf' }, children: [] }]
      },
      { data: { uid: 'b', childCount: 5, descendantCount: 5 }, children: [] }
    ]
  }
  const before = JSON.parse(JSON.stringify(tree))
  const normalized = normalizeHistoryTree(tree)
  assert.deepStrictEqual(tree, before)
  assert.notStrictEqual(normalized, tree)
  assert.notStrictEqual(normalized.children[0], tree.children[0])
  assert.strictEqual(normalized.data.childCount, 2)
  assert.strictEqual(normalized.data.descendantCount, 3)
  assert.strictEqual(normalized.data.hasMore, undefined)
  assert.strictEqual(normalized.data.expand, false)
  assert.deepStrictEqual(normalized.data.__fv, { childCount: 4 })
  assert.deepStrictEqual(normalized.data.imgMap, tree.data.imgMap)
  assert.strictEqual(normalized.children[0].data.childCount, 1)
  assert.strictEqual(normalized.children[0].data.descendantCount, 1)
  assert.strictEqual(normalized.children[0].data.hasMore, undefined)
  assert.strictEqual(normalized.children[0].children[0].data.childCount, 0)
  assert.strictEqual(normalized.children[0].children[0].data.descendantCount, 0)
  assert.strictEqual(normalized.children[1].data.childCount, 0)
  assert.strictEqual(normalized.children[1].data.descendantCount, 0)
  assert.strictEqual(normalized.children[0].data.note, 'keep')
}

function testDangerousJsonKeysAreCopiedAsOwnProperties() {
  const tree = JSON.parse(
    '{"data":{"uid":"root","__proto__":{"polluted":true},"constructor":{"nested":"tree"},"prototype":{"safe":true},"nested":{"__proto__":{"safe":true}}},"children":[]}'
  )
  const normalizedTree = normalizeHistoryTree(tree)
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(normalizedTree.data, '__proto__'),
    true
  )
  assert.deepStrictEqual(normalizedTree.data.__proto__, { polluted: true })
  assert.deepStrictEqual(normalizedTree.data.constructor, { nested: 'tree' })
  assert.deepStrictEqual(normalizedTree.data.prototype, { safe: true })
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      normalizedTree.data.nested,
      '__proto__'
    ),
    true
  )
  assert.deepStrictEqual(normalizedTree.data.nested.__proto__, { safe: true })
  assert.strictEqual(
    Object.getPrototypeOf(normalizedTree.data),
    Object.prototype
  )
  assert.strictEqual(
    Object.getPrototypeOf(normalizedTree.data.nested),
    Object.prototype
  )
  assert.strictEqual(Object.prototype.polluted, undefined)
  assert.deepStrictEqual(tree.data.__proto__, { polluted: true })

  const graph = JSON.parse(
    '{"__proto__":{"isRoot":true,"data":{"uid":"__proto__","__proto__":{"polluted":true},"constructor":{"nested":"graph"},"prototype":{"safe":true}},"children":["constructor"]},"constructor":{"data":{"uid":"constructor","__proto__":{"child":true}},"children":[]}}'
  )
  const normalizedGraph = normalizeHistoryGraph(graph)
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(normalizedGraph, '__proto__'),
    true
  )
  assert.strictEqual(normalizedGraph.__proto__.data.uid, '__proto__')
  assert.deepStrictEqual(normalizedGraph.__proto__.data.__proto__, {
    polluted: true
  })
  assert.deepStrictEqual(normalizedGraph.__proto__.data.constructor, {
    nested: 'graph'
  })
  assert.deepStrictEqual(normalizedGraph.constructor.data.__proto__, {
    child: true
  })
  assert.strictEqual(Object.getPrototypeOf(normalizedGraph), Object.prototype)
  assert.strictEqual(Object.prototype.polluted, undefined)
  assert.deepStrictEqual(graph.__proto__.data.__proto__, { polluted: true })
}

function testGeneralizationsAreSeparateSubtrees() {
  const tree = {
    data: {
      uid: 'root',
      childCount: 1,
      descendantCount: 2,
      generalization: {
        uid: 'summary',
        text: 'Summary',
        childCount: 9,
        descendantCount: 9,
        children: [
          {
            data: {
              uid: 'summary-child',
              childCount: 9,
              descendantCount: 9,
              hasMore: true
            },
            children: [{ data: { uid: 'summary-leaf' }, children: [] }]
          }
        ]
      }
    },
    children: [{ data: { uid: 'actual-child' }, children: [] }]
  }
  const normalized = normalizeHistoryTree(tree)
  assert.strictEqual(normalized.data.childCount, 1)
  assert.strictEqual(normalized.data.descendantCount, 1)
  assert.strictEqual(normalized.data.generalization.childCount, 1)
  assert.strictEqual(normalized.data.generalization.descendantCount, 2)
  assert.strictEqual(
    normalized.data.generalization.children[0].data.childCount,
    1
  )
  assert.strictEqual(
    normalized.data.generalization.children[0].data.descendantCount,
    1
  )
  assert.strictEqual(
    normalized.data.generalization.children[0].data.hasMore,
    undefined
  )

  const ordinary = normalizeHistoryTree({
    data: {
      uid: 'ordinary-root',
      generalization: [{ uid: 'ordinary-summary', text: 'Summary' }]
    },
    children: []
  })
  assert.strictEqual(ordinary.data.generalization[0].childCount, 0)
  assert.strictEqual(ordinary.data.generalization[0].descendantCount, 0)
  assert.strictEqual(ordinary.data.generalization[0].hasMore, undefined)

  const graph = normalizeHistoryGraph({
    root: {
      isRoot: true,
      data: {
        uid: 'root',
        childCount: 1,
        descendantCount: 1,
        generalization: {
          uid: 'summary',
          text: 'Summary',
          childCount: 3,
          descendantCount: 3,
          children: [
            {
              data: {
                uid: 'summary-child',
                childCount: 8,
                descendantCount: 8,
                hasMore: true
              },
              children: [{ data: { uid: 'summary-leaf' }, children: [] }]
            }
          ]
        }
      },
      children: ['actual-child']
    },
    'actual-child': { data: { uid: 'actual-child' }, children: [] }
  })
  assert.strictEqual(graph.root.data.descendantCount, 1)
  assert.strictEqual(graph.root.data.generalization.descendantCount, 2)
  assert.strictEqual(
    graph.root.data.generalization.children[0].data.descendantCount,
    1
  )
  assert.strictEqual(
    graph.root.data.generalization.children[0].data.hasMore,
    undefined
  )

  const syntheticLikeUid = normalizeHistoryGraph({
    root: {
      isRoot: true,
      data: {
        uid: 'root',
        generalization: {
          uid: 'summary',
          text: 'Summary',
          children: [
            {
              data: {
                uid: '__history_counts_summary_0__',
                descendantCount: 4
              },
              children: []
            }
          ]
        }
      },
      children: []
    }
  })
  assert.strictEqual(
    syntheticLikeUid.root.data.generalization.children[0].data.descendantCount,
    0
  )

  assert.throws(
    () =>
      normalizeHistoryGraph({
        root: {
          isRoot: true,
          data: {
            uid: 'root',
            generalization: { uid: 'summary', children: 'bad' }
          },
          children: []
        }
      }),
    error => error.code === 'HISTORY_SNAPSHOT_INVALID'
  )
}

function testGraphShapeErrorsAreNotSilentlyCleaned() {
  const errors = [
    { root: { isRoot: true, data: { uid: 'root' }, children: ['missing'] } },
    {
      root: {
        isRoot: true,
        data: { uid: 'root' },
        children: ['left', 'right']
      },
      left: { data: { uid: 'left' }, children: ['leaf'] },
      right: { data: { uid: 'right' }, children: ['leaf'] },
      leaf: { data: { uid: 'leaf' }, children: [] }
    },
    {
      root: { isRoot: true, data: { uid: 'root' }, children: ['child'] },
      child: { data: { uid: 'wrong' }, children: [] }
    },
    {
      root: { isRoot: true, data: { uid: 'root' }, children: ['child'] },
      child: { data: { uid: 'child' }, children: ['root'] }
    }
  ]
  errors.forEach(graph => {
    assert.throws(
      () => normalizeHistoryGraph(graph),
      error => {
        assert.strictEqual(error.code, 'HISTORY_SNAPSHOT_INVALID')
        return true
      }
    )
  })

  const duplicateTree = {
    data: { uid: 'root' },
    children: [
      { data: { uid: 'same' }, children: [] },
      { data: { uid: 'same' }, children: [] }
    ]
  }
  assert.throws(
    () => normalizeHistoryTree(duplicateTree),
    error => {
      assert.strictEqual(error.code, 'HISTORY_DUPLICATE_NODE_UID')
      return true
    }
  )
}

function testTenThousandNodeDepthAndWidth() {
  const depth = 10000
  const nested = { data: { uid: 'deep-0' }, children: [] }
  let tail = nested
  for (let index = 1; index < depth; index++) {
    const child = {
      data: { uid: `deep-${index}`, descendantCount: -1 },
      children: []
    }
    tail.children.push(child)
    tail = child
  }
  const deepNormalized = normalizeHistoryTree(nested)
  assert.strictEqual(deepNormalized.data.childCount, 1)
  assert.strictEqual(deepNormalized.data.descendantCount, depth - 1)
  let normalizedTail = deepNormalized
  while (normalizedTail.children.length)
    normalizedTail = normalizedTail.children[0]
  assert.strictEqual(normalizedTail.data.descendantCount, 0)

  const graph = {
    root: {
      isRoot: true,
      data: { uid: 'root', childCount: -1, descendantCount: -1 },
      children: []
    }
  }
  for (let index = 0; index < depth - 1; index++) {
    const uid = `wide-${index}`
    graph.root.children.push(uid)
    graph[uid] = { data: { uid }, children: [] }
  }
  const wideNormalized = normalizeHistoryGraph(graph)
  assert.strictEqual(wideNormalized.root.data.childCount, depth - 1)
  assert.strictEqual(wideNormalized.root.data.descendantCount, depth - 1)
  assert.strictEqual(wideNormalized.root.children.length, depth - 1)
}

testEmptyAndLeafGraphs()
testCountsAndImmutability()
testDangerousJsonKeysAreCopiedAsOwnProperties()
testGeneralizationsAreSeparateSubtrees()
testGraphShapeErrorsAreNotSilentlyCleaned()
testTenThousandNodeDepthAndWidth()
console.log('historyTreeCounts.test.js ok')
