'use strict'
// Smoke guard: exactly 10000 nodes, every node carrying UNIQUE formatted rich
// HTML, must fully render under openPerformance=false through the real
// Edit.vue + RichText plugin path. Complements the mixed C2 scenario, which has
// mostly plain labels plus a small feature fixture.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')

const INITIAL_BUDGET_MS = 20000

function ownedChromePids () {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(row => row && Number(row[2]) === process.pid && row[3].endsWith('/Google Chrome'))
      .map(row => Number(row[1]))
  } catch { return [] }
}
async function boundedClose (harness) {
  const owned = ownedChromePids()
  await Promise.race([harness.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))])
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL') } catch {} }
}
function uniqueRichTree (total) {
  return { data: { uid: 'root', text: 'Root', expand: true }, children:
    Array.from({ length: total - 1 }, (_, i) => ({ data: { uid: 'n' + i,
      text: `<p><strong>Node ${i}</strong> <em>unique-${i}</em></p>`, richText: true, expand: true }, children: [] })) }
}

test('exactly 10000 nodes with unique formatted rich HTML fully render under openPerformance=false', { timeout: 120000 }, async () => {
  const phase = process.env.PERF_TDD_PHASE || 'green'
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const destination = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(destination, { recursive: true })
  const output = path.join(destination, 'richtext-unique-rich-smoke-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  const total = 10000
  const tree = uniqueRichTree(total)
  const harness = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
    handleRequest: createMemoryTransport(), sourceRoot: repo, viewport: { width: 1280, height: 900 } })
  const report = { scope: 'source-bundled real Edit.vue + real RichText plugin; 10000 unique formatted richText nodes; openPerformance=false; full paint',
    runId, phase, node: process.version, browser: harness.browser.version(), bundleHash: harness.bundleHash,
    sourceRoot: repo, totalNodes: total, initialBudgetMs: INITIAL_BUDGET_MS, startedAt: new Date().toISOString() }
  try {
    const page = await harness.newPage()
    await page.waitForFunction(() => !!window.perfFrontend)
    const result = await page.evaluate(async ({ tree, total }) => {
      const f = window.perfFrontend
      const mounted = await f.mountEditor()
      const mm = mounted.component.mindMap
      mounted.component.addRichTextPlugin()
      mm.updateConfig({ compactLayout: false, openPerformance: false, addHistoryTime: 0, maxHistoryCount: 100 })
      mm.setLayout('logicalStructure', true)
      let start = null, end = null
      mm.on('node_tree_render_start', () => { start = performance.now() })
      mm.on('node_tree_render_end', () => { end = performance.now() })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('unique rich paint timeout')) }, 60000)
        const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
        mm.on('node_tree_render_end', done)
        mm.setData(tree)
      })
      let total_ = 0, rich = 0
      const walk = node => { total_++; if (node.data && node.data.richText) rich++; for (const child of node.children || []) walk(child) }
      walk(mm.renderer.renderTree)
      const sample = mm.renderer.findNodeByUid('n7777')
      const sampleText = sample && sample._textData && sample._textData.node && sample._textData.node.node
      return { paintMs: end != null && start != null ? end - start : null, modelTotal: total_, modelRich: rich,
        foreignObjects: mm.svg.node.querySelectorAll('foreignObject').length,
        sampleRendered: !!(sampleText && sampleText.isConnected && sampleText.textContent.includes('unique-7777')),
        openPerformance: mm.opt.openPerformance,
        hasRichText: !!mm.richText,
        isV2: typeof mm.command.usesV2History === 'function' ? mm.command.usesV2History() : null }
    }, { tree, total })
    Object.assign(report, result)
    assert.deepEqual(harness.errors, [], 'browser errors: ' + harness.errors.join('; '))
    assert.equal(result.hasRichText, true, 'real RichText plugin must be attached')
    assert.equal(result.isV2, false, 'native local history (not V2) is required')
    assert.equal(result.openPerformance, false, 'openPerformance must stay false')
    assert.equal(result.modelTotal, total, 'model cardinality must be exactly 10000')
    assert.equal(result.modelRich, total, 'every node must stay richText')
    assert.equal(result.foreignObjects, total, 'every node must attach a foreignObject')
    assert.equal(result.sampleRendered, true, 'unique formatted content must reach the DOM')
    assert.ok(result.paintMs <= INITIAL_BUDGET_MS, `initial unique rich 10k paint ${Math.round(result.paintMs)}ms exceeded ${INITIAL_BUDGET_MS}ms`)
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('RICHTEXT_UNIQUE_RICH_SMOKE ' + output + ' status=' + report.status)
    console.log('  paintMs=' + report.paintMs + ' foreign=' + report.foreignObjects + ' modelRich=' + report.modelRich + ' sampleRendered=' + report.sampleRendered)
    await boundedClose(harness)
  }
})
