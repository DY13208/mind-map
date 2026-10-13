const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
test('expanded branch hydration caps concurrency and processes every branch', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/plugins/Cooperate.js'), 'utf8')
  const start = source.indexOf('  async hydrateExpandedPartialParents(')
  const end = source.indexOf('\n  async ensurePlacementParent(', start)
  const method = vm.runInNewContext('(' + source.slice(start, end).trim().replace(/^async /, 'async function ') + ')', { console, Promise, Set, Array })
  const children = Array.from({ length: 17 }, (_, i) => ({ nodeData: { children: [] }, children: [], getData: key => key === 'uid' ? 'n' + i : true }))
  const root = { children, nodeData: { children }, getData: key => key === 'uid' ? 'root' : true }
  let active = 0, peak = 0, loaded = 0, renders = 0
  const context = {
    mindMap: { renderer: { root }, render: () => renders++ },
    httpFetchSubtree: () => {}, hydrateFailedUids: new Set(), dirtySubtrees: new Map(),
    nodeNeedsHydrate: node => node !== root,
    hydrateFromHttp: async () => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setImmediate(resolve))
      active--; loaded++; return true
    }
  }
  const result = await method.call(context)
  assert.equal(peak, 4)
  assert.equal(loaded, 17)
  assert.equal(result.hydrated, 17)
  assert.equal(renders, 1)
})
test('view-only renders skip restore; tree, server and local state changes restore', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/src/utils/expandRestoreGate.js'), 'utf8')
  const { createExpandRestoreGate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const gate = createExpandRestoreGate(), tree = {}, state = {}
  assert.equal(gate.shouldRestore(tree, 1, state, 0), true)
  for (let i = 0; i < 100; i++) assert.equal(gate.shouldRestore(tree, 1, state, 0), false)
  assert.equal(gate.shouldRestore(tree, 2, state, 0), true)
  assert.equal(gate.shouldRestore(tree, 2, state, 1), true)
  assert.equal(gate.shouldRestore(tree, 2, {}, 1), true)
  assert.equal(gate.shouldRestore({}, 2, state, 1), true)
  gate.invalidate()
  assert.equal(gate.shouldRestore(tree, 2, state, 1), true)
})
