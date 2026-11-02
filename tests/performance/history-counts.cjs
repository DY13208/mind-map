const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { normalizeHistoryGraph, normalizeHistoryTree } = require('../../simple-mind-map/src/utils/historyTreeCounts')

function graphFor(shape, size) {
  const graph = Object.create(null)
  for (let index = 0; index < size; index++) {
    graph['n' + index] = { isRoot: index === 0, data: { uid: 'n' + index, text: '历史节点 ' + index, childCount: 999, descendantCount: 999, hasMore: true }, children: [] }
    if (index > 0) graph[shape === 'wide' ? 'n0' : 'n' + (index - 1)].children.push('n' + index)
  }
  return graph
}
function sample(fn) {
  const runs = []
  for (let index = 0; index < 5; index++) {
    if (global.gc) global.gc()
    const beforeHeap = process.memoryUsage().heapUsed
    const start = performance.now()
    const output = fn()
    runs.push({ ms: performance.now() - start, sampledHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap })
    assert.ok(output)
  }
  return { medianMs: runs.map(run => run.ms).sort((a, b) => a - b)[2], runs }
}
const results = []
for (const shape of ['wide', 'deep']) {
  const graph = graphFor(shape, 10000)
  const before = JSON.stringify(graph)
  const cloneBaseline = sample(() => JSON.parse(JSON.stringify(graph)))
  const copyAndNormalize = sample(() => normalizeHistoryGraph(graph))
  const normalized = normalizeHistoryGraph(graph)
  assert.equal(normalized.n0.data.descendantCount, 9999)
  assert.equal(normalized.n0.data.childCount, shape === 'wide' ? 9999 : 1)
  assert.equal(JSON.stringify(graph), before)
  results.push({ shape, nodes: 10000, cloneBaseline, copyAndNormalize })
}
let root = { data: { uid: 't9999' }, children: [] }
for (let index = 9998; index >= 0; index--) root = { data: { uid: 't' + index }, children: [root] }
const nested = sample(() => normalizeHistoryTree(root))
assert.equal(normalizeHistoryTree(root).data.descendantCount, 9999)
const result = {
  node: process.version,
  note: 'Five-run local sample; baseline is isolated JSON graph cloning, not the whole historical API. Heap delta is sampled allocation, not peak memory. No database or network is accessed.',
  results, deepNestedTree: { nodes: 10000, copyAndNormalize: nested }
}
const dir = path.resolve(__dirname, '../../output/history-counts-fix')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'performance.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ graph: results.map(item => ({ shape: item.shape, cloneMedianMs: item.cloneBaseline.medianMs, normalizeMedianMs: item.copyAndNormalize.medianMs })), nestedMedianMs: nested.medianMs }, null, 2))
