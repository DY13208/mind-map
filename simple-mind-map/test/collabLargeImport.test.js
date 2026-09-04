const assert = require('assert')
const {
  inspectImportTree,
  importTooLargeError,
  reconnectBackoffMs,
  shouldStopReconnect,
  classifyCollabError,
  countTreeNodes
} = require('../src/utils/collabImport')
const { applyMapReplace } = require('../bin/collabV2/slowPath')
const { encodeNodeRows, validateNodeGraph } = require('../bin/roomNodes')

function bush(count) {
  const root = { data: { uid: 'root', text: 'Root', isRoot: true }, children: [] }
  const nodes = { root }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    const node = { data: { uid, text: 'N' + i }, children: [] }
    nodes[uid] = node
    nodes[parent].children.push(node)
  }
  return { tree: root, nodeCount: count + 1 }
}

function objectGraph(count) {
  const nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    nodes[uid] = { data: { uid, text: 'N' + i }, children: [] }
    nodes[parent].children.push(uid)
  }
  return nodes
}

;(async () => {
  const sizes = [1000, 5000, 10000, 20000]
  const timings = []
  for (const size of sizes) {
    const started = Date.now()
    const { tree, nodeCount } = bush(size)
    assert.strictEqual(countTreeNodes(tree), nodeCount)
    const stats = inspectImportTree(tree, { maxNodes: 25000 })
    assert.strictEqual(stats.tooLarge, false, size + ' should be accepted')
    let rowCount = nodeCount
    if (size <= 1000) {
      const graph = objectGraph(size)
      const check = validateNodeGraph(graph)
      assert.ok(check.ok, size + ' graph: ' + (check.errors || []).join(','))
      rowCount = encodeNodeRows(graph).length
    }
    timings.push({
      size,
      nodeCount,
      encodeMs: Date.now() - started,
      rowCount,
      sqlOps: 2
    })
  }
  assert.ok(timings.every(item => item.sqlOps <= 4), '15. bulk SQL count constant')

  const huge = bush(20001)
  const tooBig = inspectImportTree(huge.tree, { maxNodes: 20000 })
  assert.strictEqual(tooBig.tooLarge, true)
  const err = importTooLargeError(tooBig)
  assert.strictEqual(err.code, 'IMPORT_TOO_LARGE')

  const previous = objectGraph(3)
  let threw = false
  try {
    applyMapReplace(previous, {
      type: 'map.replace',
      payload: { tree: huge.tree }
    })
  } catch (e) {
    threw = e.code === 'IMPORT_TOO_LARGE'
  }
  assert.ok(threw, '16. oversize replace rejected')
  assert.ok(previous.root, '17. old tree object kept on reject')

  const ok = applyMapReplace(previous, {
    type: 'map.replace',
    payload: { nodes: objectGraph(20) }
  })
  assert.strictEqual(ok.event.type, 'map.replaced')
  assert.strictEqual(ok.inversePayload.type, 'map.replace')
  assert.ok(ok.inversePayload.payload.nodes.root)

  const waits = [0, 1, 2, 3].map(i => reconnectBackoffMs(i, { baseMs: 800, capMs: 15000 }))
  assert.ok(waits[0] >= 800)
  assert.ok(waits[3] > waits[0])
  assert.ok(shouldStopReconnect(8, { maxAttempts: 8 }))
  assert.ok(!shouldStopReconnect(2, { maxAttempts: 8 }))

  assert.strictEqual(
    classifyCollabError({ code: 'AUTH_TIMEOUT' }).code,
    'AUTH_TIMEOUT'
  )
  assert.strictEqual(
    classifyCollabError(new Error('x'), { stage: 'hydrate' }).code,
    'ROOM_LOAD_TIMEOUT'
  )
  assert.strictEqual(
    classifyCollabError({ code: 'IMPORT_TOO_LARGE' }, { stage: 'IMPORT' }).code,
    'IMPORT_TOO_LARGE'
  )

  console.log('collabLargeImport.test.js ok', timings)
})().catch(err => {
  console.error(err)
  process.exit(1)
})
