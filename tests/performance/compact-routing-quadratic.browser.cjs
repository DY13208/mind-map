const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createHarness, repo } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')

// Real benchmark fixture and real CompactStructure connector routing. A local
// text edit on the wide flat tree must touch routing work proportional to the
// number of nodes, not proportional to the square of it.
const options = { layout: 'logicalStructure', compactLayout: true, openPerformance: true,
  openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, maxHistoryCount: 100,
  createNewNodeBehavior: 'NOT_ACTIVE' }

async function measureRouting (page, size) {
  return page.evaluate(async ({ size, options }) => {
    const f = window.perfFrontend
    const mm = await f.createEngine(f.tree(size - 1), options)
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!mm.renderer.isRendering) { clearInterval(timer); resolve() }
      }, 10)
    })
    const proto = Object.getPrototypeOf(mm.renderer.root)
    const state = { active: null, calls: [] }
    const restorers = []
    for (const name of ['left', 'top']) {
      let owner = proto
      while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner)
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (!descriptor || typeof descriptor.get !== 'function') throw new Error('live node position getter unavailable: ' + name)
      Object.defineProperty(owner, name, { ...descriptor, get () {
        if (state.active) state.active.positionReads++
        return descriptor.get.call(this)
      } })
      restorers.push(() => Object.defineProperty(owner, name, descriptor))
    }
    const layout = mm.renderer.layout
    const originalAssign = layout.assignConnectorLanes
    layout.assignConnectorLanes = function (...args) {
      const call = { depth: args[0] === undefined ? null : args[0], positionReads: 0, routes: 0 }
      state.active = call
      const started = performance.now()
      try {
        return originalAssign.apply(this, args)
      } finally {
        call.ms = performance.now() - started
        state.active = null
        state.calls.push(call)
      }
    }
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('compact layout did not run for N=' + size)) }, 120000)
        const poll = setInterval(() => {
          if (state.calls.length && !mm.renderer.isRendering) { cleanup(); resolve() }
        }, 5)
        const cleanup = () => { clearTimeout(timer); clearInterval(poll) }
        mm.renderer.findNodeByUid('n0').setText('Quadratic ' + size, false)
      })
    } finally {
      layout.assignConnectorLanes = originalAssign
      restorers.reverse().forEach(restore => restore())
    }
    const calls = state.calls.map(call => ({ depth: call.depth, positionReads: call.positionReads, ms: call.ms }))
    return { size, calls, positionReads: calls.reduce((sum, call) => sum + call.positionReads, 0) }
  }, { size, options })
}

test('real compact connector routing work grows with node count, not with its square', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const runId = process.env.PERF_TDD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const destination = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(destination, { recursive: true })
  const output = path.join(destination, 'compact-routing-quadratic-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  const harness = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
    handleRequest: createMemoryTransport(), sourceRoot: repo })
  const report = { scope: 'actual CompactStructure.assignConnectorLanes on the real wide flat compact fixture; counts live MindMapNode left/top coordinate reads while routing one local edit',
    runId, sourceRoot: repo, browser: harness.browser.version(), bundleHash: harness.bundleHash,
    startedAt: new Date().toISOString(), rows: [] }
  try {
    for (const size of [1000, 4000]) {
      const page = await harness.newPage()
      await page.waitForFunction(() => !!window.perfFrontend)
      report.rows.push(await measureRouting(page, size))
      await page.close()
    }
    assert.deepEqual(harness.errors, [], 'browser exceptions are infrastructure failures, not performance RED')
    const bySize = Object.fromEntries(report.rows.map(row => [row.size, row]))
    for (const row of report.rows) {
      assert.ok(row.calls.length, 'compact routing must actually run')
      for (const call of row.calls) {
        assert.ok(Number.isFinite(call.positionReads) && call.positionReads > 0, 'routing must read live coordinates')
      }
      assert.ok(row.positionReads <= 64 * row.size,
        `N=${row.size}: compact routing read ${row.positionReads} live coordinates; a node-count-proportional router must stay <= ${64 * row.size}`)
    }
    assert.ok(bySize[4000].positionReads <= 6 * bySize[1000].positionReads,
      `compact routing scaled ${(bySize[4000].positionReads / bySize[1000].positionReads).toFixed(2)}x from N=1000 to N=4000`)
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log('COMPACT_ROUTING_QUADRATIC ' + output + ' status=' + report.status)
    for (const row of report.rows) console.log('  N=' + row.size + ' positionReads=' + row.positionReads + ' calls=' + JSON.stringify(row.calls.map(call => call.positionReads)))
    if (report.rows.length === 2) console.log('  scale=' + (report.rows[1].positionReads / report.rows[0].positionReads).toFixed(2) + 'x')
    await harness.close()
  }
})
