'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHarness } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')
const { runRendererCorrectness } = require('../../simple-mind-map/test/c2RendererCorrectness.browser.test.js')
async function main() {
  const h = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'), handleRequest: createMemoryTransport() })
  const report = { scope: 'real renderer C2 correctness; native local mode; isolated real Edit SFC, external UI boundaries only',
    browser: h.browser.version(), bundleHash: h.bundleHash, sourceRoot: h.sourceRoot, startedAt: new Date().toISOString() }
  let profiler, guard
  try {
    const page = await h.newPage()
    page.on('console', message => { if (message.text().startsWith('[c2-correctness-stage]')) console.log(message.text()) })
    await page.waitForFunction(() => !!window.perfFrontend)
    const tree = await page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
      editor.component.addRichTextPlugin()
      mm.updateConfig({ compactLayout: false, openPerformance: true, addHistoryTime: 0 })
      mm.setLayout('logicalStructure', true)
      window.__C2_STABLE_MM__ = mm
      return f.tree(10000)
    })
    profiler = await h.context.newCDPSession(page)
    await profiler.send('Profiler.enable'); await profiler.send('Profiler.start')
    report.checks = await Promise.race([runRendererCorrectness(page, tree), new Promise((resolve, reject) => {
      guard = setTimeout(() => { const error = new Error('Node guard: real C2 scenario did not finish in 90 seconds'); error.code = 'C2_TIME_BUDGET'; reject(error) }, 90000)
    })])
    Object.entries(report.checks).forEach(([key, value]) => assert.equal(value, true, key))
    report.status = 'PASS'
    console.log(JSON.stringify(report))
  } catch (error) { report.status = error.code === 'C2_TIME_BUDGET' ? 'BLOCKED_TIME_BUDGET' : 'FAILED'; report.error = error.stack; process.exitCode = 1; console.error(error) }
  finally {
    clearTimeout(guard)
    if (profiler) {
      try {
        const result = await Promise.race([profiler.send('Profiler.stop'), new Promise((resolve, reject) => setTimeout(() => reject(new Error('profiler stop timeout')), 5000))])
        fs.writeFileSync(path.resolve(__dirname, '../../work/performance-tdd/green/frontend/c2-isolated-native-profile.json'), JSON.stringify(result.profile))
      } catch (error) { report.profileError = error.message }
    }
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.resolve(__dirname, '../../work/performance-tdd/green/frontend/c2-isolated-native.json'), JSON.stringify(report, null, 2))
    const owned = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(row => row && Number(row[2]) === process.pid && row[3].endsWith('/Google Chrome')).map(row => Number(row[1]))
    const cleanupGuard = setTimeout(() => owned.forEach(pid => { try { process.kill(pid, 'SIGTERM') } catch {} }), 5000)
    await h.close()
    clearTimeout(cleanupGuard)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
