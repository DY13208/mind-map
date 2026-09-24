const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const load = relative => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.resolve(__dirname, relative), 'utf8')).toString('base64'))

async function main() {
  const { runSteps, walkSteps } = await load('../src/utils/renderScheduler.js')
  const { createTreeRuntime } = await load('../../web/src/utils/treeWorker.js')
  const { historyGraphToMindMap, withExpandMode } = await load('../../web/src/utils/historyTree.js')
  const runtime = createTreeRuntime()
  const order = []
  const tree = { id: 'a', children: [{ id: 'b', children: [{ id: 'skip' }] }, { id: 'c' }] }
  await runSteps(walkSteps(tree, null, node => { order.push('+' + node.id); return node.id === 'b' }, node => order.push('-' + node.id), true))
  assert.deepEqual(order, ['+a', '+b', '-b', '+c', '-c', '-a'])
  let visits = 0, valid = true
  const cancelled = runSteps(() => { visits++; return true }, { budget: 1, valid: () => valid })
  setTimeout(() => { valid = false }, 4)
  assert.equal(await cancelled, false)
  const stoppedAt = visits
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(visits, stoppedAt)

  for (const value of [null, true, 12.25, '\\"汉字\n', [1, { a: [false, null] }], { '__proto__': null, nested: {} }]) {
    assert.deepEqual(await runtime('parse', JSON.stringify(value)), JSON.parse(JSON.stringify(value)))
  }
  const proto = await runtime('parse', '{"__proto__":{"polluted":true}}')
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.hasOwn(proto, '__proto__'), true)
  for (const raw of ['[1,]', '{"a":1,}', '{}{}', '{"a" 1}', '[01]', '"unterminated', '{', '[,]', '{1:2}', '[true false]']) {
    await assert.rejects(runtime('parse', raw), SyntaxError, raw)
  }
  for (const count of [1000, 10000, 30000]) {
    const graph = { root: { isRoot: true, data: { text: 'Root' }, children: [] } }
    for (let i = 1; i < count; i++) {
      const uid = 'n' + i
      graph[uid] = { data: { text: 'Node ' + i }, children: [] }
      graph.root.children.push(uid)
    }
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const raw = JSON.stringify({ tree: graph, metadata: { layout: 'mindMap' } })
    const result = await runtime('historyResponse', { raw, sessionId: 's' + count })
    clearInterval(timer)
    assert.equal(result.projection.nodeCount, count)
    assert.equal(result.tree.children.length, 48)
    assert.equal(result.tree.data.descendantCount, count - 1)
    assert.equal(result.tree.children[0].data.expand, false)
    if (count >= 10000) assert.ok(ticks > 0, 'large parse/index must yield')
    const page = await runtime('branch', { sessionId: 's' + count, uid: 'root', offset: 48 })
    assert.equal(page.children[0].data.uid, 'n49')
    const hits = await runtime('search', { sessionId: 's' + count, query: 'Node ' + (count - 1) })
    assert.deepEqual(hits[0].path, ['root', 'n' + (count - 1)])
    assert.equal(graph.root.children.length, count - 1, 'projection must not prune authoritative source')
    await runtime('release', { sessionId: 's' + count })
    await assert.rejects(runtime('branch', { sessionId: 's' + count, uid: 'root' }))
  }
  const chain = { data: { uid: 'root', expand: false }, children: [] }
  let tail = chain
  for (let i = 0; i < 10000; i++) { const next = { data: { uid: 'd' + i }, children: [] }; tail.children.push(next); tail = next }
  const copy = historyGraphToMindMap(chain)
  assert.equal(copy.data.expand, false)
  withExpandMode(chain, 'expanded')
  assert.equal(chain.data.expand, false, 'view flags must not mutate source')
  const cycle = { root: { isRoot: true, data: {}, children: ['root'] } }
  const safe = await runtime('prepare', { graph: cycle, sessionId: 'cycle' })
  assert.equal(safe.nodeCount, 1)
  const { mapPayload, sendExportJson } = require('../bin/mindApi')
  const exportObj = { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } }
  for (let i = 0; i < 10400; i++) {
    const uid = 'e' + i
    exportObj[uid] = { data: { uid, text: 'Export ' + i }, children: [] }
    exportObj.root.children.push(uid)
  }
  assert.equal(mapPayload('test', exportObj, {}, { format: 'full', max_nodes: 10000 }).truncated, true)
  const exported = mapPayload('test', exportObj, {}, { format: 'export' })
  assert.equal(exported.truncated, undefined)
  assert.equal(exported.tree.children.length, 10400)
  assert.equal(exported.tree.children.at(-1).data.text, 'Export 10399')
  const deepExport = { root: { isRoot: true, data: { uid: 'root' }, children: ['deep0'] } }
  for (let i = 0; i < 20000; i++) {
    deepExport['deep' + i] = { data: { uid: 'deep' + i }, children: i < 19999 ? ['deep' + (i + 1)] : [] }
  }
  const deepResult = mapPayload('test', deepExport, {}, { format: 'export' })
  let last = deepResult.tree, exportedDepth = 0
  while (last.children.length) { exportedDepth++; last = last.children[0] }
  assert.equal(exportedDepth, 20000)
  const chunks = []
  await sendExportJson({ setHeader() {}, write(chunk) { chunks.push(chunk); return true }, end() {} }, deepResult)
  const streamed = JSON.parse(chunks.join(''))
  let streamedDepth = 0, cursor = streamed.tree
  while (cursor.children.length) { streamedDepth++; cursor = cursor.children[0] }
  assert.equal(streamedDepth, 20000)
  console.log('PASS: scheduler cancellation, traversal order, JSON grammar, 1k/10k/30k projection, paging, complete search, deep tree and source integrity')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
