const assert = require('assert')
const mindDoc = require('../bin/mindDoc')
const { countObjectDescendants } = require('../bin/descendantCounts')
const { stampAuthoritativeChildCounts } = require('../bin/roomNodes')
const { getDescendantCount } = require('../src/utils/nodeDescendantCount')

function fixture() {
  const obj = {
    root: { isRoot: true, data: { uid: 'root' }, children: ['c1', 'other'] },
    other: { data: { uid: 'other' }, children: [] },
    c1: { data: { uid: 'c1' }, children: [] }
  }
  // Seven levels, including multiple branches and leaves at different depths.
  for (let branch = 0; branch < 9; branch++) {
    let parent = 'c1'
    for (let depth = 1; depth <= 7; depth++) {
      const uid = `b${branch}-d${depth}`
      obj[uid] = { data: { uid, descendantCount: 999 }, children: [] }
      obj[parent].children.push(uid)
      parent = uid
    }
  }
  return obj
}

async function run() {
  const obj = fixture()
  const assertCount = tree => {
    assert.strictEqual(tree.data.childCount, 9)
    assert.strictEqual(tree.data.descendantCount, 63)
    assert.strictEqual(getDescendantCount(tree), 63)
  }
  const preview = mindDoc.buildPreview(obj, {
    forceClip: true, keepDepth: 1, maxNodes: 2
  })
  assertCount(preview.tree.children[0])
  const deep = mindDoc.versionedSubtree(obj, 'c1', {
    deep: true, maxNodes: 3
  })
  assertCount(deep.tree)
  assert.strictEqual(deep.truncated, true)
  const page = mindDoc.versionedSubtree(obj, 'c1', { limit: 2, offset: 2 })
  assert.strictEqual(page.descendantCount, 63)
  assert.strictEqual(page.total, 9)
  assert.strictEqual(page.children.length, 2)
  page.children.forEach(child => {
    assert.strictEqual(child.data.descendantCount, 6)
    assert.strictEqual(getDescendantCount(child), 6)
  })
  const fetchCount = () => mindDoc.nodesByUids(obj, ['c1'])[0].data.descendantCount
  assert.strictEqual(fetchCount(), 63)
  delete obj['b0-d7']
  obj['b0-d6'].children = []
  assert.strictEqual(fetchCount(), 62, 'deleted descendants lower the total')
  obj.c1.children = obj.c1.children.filter(uid => uid !== 'b1-d1')
  obj.other.children.push('b1-d1')
  assert.strictEqual(fetchCount(), 55, 'moving a subtree updates both ancestors')
  assert.strictEqual(mindDoc.nodesByUids(obj, ['other'])[0].data.descendantCount, 7)

  const rows = Object.keys(obj).map(uid => ({ uid, parent_uid: null }))
  const byUid = new Map(rows.map(row => [row.uid, row]))
  Object.keys(obj).forEach(uid => obj[uid].children.forEach(child => {
    byUid.get(child).parent_uid = uid
  }))
  let queries = 0
  const db = { query: async (sql, params) => {
    queries++
    assert.ok(sql.includes('deleted_at is null'))
    assert.ok(!/limit|depth/i.test(sql), 'count query cannot clip depth or rows')
    assert.deepStrictEqual(params, ['test-room'])
    return { rows }
  } }
  await stampAuthoritativeChildCounts(db, 'test-room', deep.tree)
  assert.strictEqual(queries, 1, 'one edge query, not one query per node')
  assert.strictEqual(deep.tree.data.descendantCount, 55)
  assert.strictEqual(getDescendantCount(deep.tree), 55)

  const chain = {}
  for (let i = 0; i < 20000; i++) {
    chain[`n${i}`] = { children: i < 19999 ? [`n${i + 1}`] : [] }
  }
  assert.strictEqual(countObjectDescendants(chain).get('n0'), 19999,
    'deep counting has no display depth cap or JavaScript recursion limit')
  console.log('descendant counts: clipped preview, deep/page hydration, updates and 20k depth passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
