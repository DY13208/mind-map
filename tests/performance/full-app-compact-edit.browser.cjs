const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createHarness, repo } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')

// Source-bundled real Edit.vue component integration (esbuild harness), NOT a
// compiled served-app E2E. It mounts the real Edit.vue shell with the real
// MindMap/Count/command history/plugins, configured compactLayout=true, and
// checks native history behavior. It does not exercise the built after-web
// bundle or any online/persistence stack.
test('source-bundled Edit.vue compact=true edit keeps native history, exact Undo text and Count words', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'green'
  const runId = process.env.PERF_TDD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const destination = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(destination, { recursive: true })
  const output = path.join(destination, 'full-app-compact-edit-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  const harness = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
    handleRequest: createMemoryTransport(), sourceRoot: repo, viewport: { width: 1280, height: 900 } })
  const report = { scope: 'source-bundled real Edit.vue component integration (esbuild harness) with real engine/Count/native history and compactLayout=true; NOT compiled served-app/online E2E',
    runId, browser: harness.browser.version(), node: process.version, bundleHash: harness.bundleHash,
    startedAt: new Date().toISOString(), checks: {} }
  try {
    const page = await harness.newPage()
    await page.waitForFunction(() => !!window.perfFrontend)
    const result = await page.evaluate(async () => {
      const f = window.perfFrontend
      localStorage.setItem('SIMPLE_MIND_MAP_CONFIG', JSON.stringify({ compactLayout: true,
        layout: 'logicalStructure', openRealtimeRenderOnNodeTextEdit: false }))
      const mounted = await f.mountEditor()
      const mm = mounted.component.mindMap
      const size = 800
      mm.setData(f.tree(size - 1))
      await f.waitRender(mm, () => mm.render())
      const count = f.mount(f.Count, { mindMap: mm })
      await f.pause(50)
      const checks = {}
      const node = mm.renderer.findNodeByUid('n0')
      const originalText = node.getData('text')
      const initialWords = count.component.words
      checks.compactLayout = mm.opt.compactLayout === true
      checks.layout = mm.getLayout() === 'logicalStructure'
      checks.compactStructure = mm.renderer.layout.constructor.name === 'CompactStructure'
      checks.initialCount = count.component.num === size
      checks.nativeHistoryNotV2 = typeof mm.command.usesV2History === 'function' &&
        mm.command.usesV2History() === false
      const target = 'Full app compact edited words here ' + Date.now()
      await f.waitRender(mm, () => mm.renderer.findNodeByUid('n0').setText(target, false))
      await f.pause(300)
      checks.editedText = mm.renderer.findNodeByUid('n0').getData('text') === target
      checks.countNumAfterEdit = count.component.num === size
      checks.countWordsChangedOnEdit = count.component.words !== initialWords
      const editedWords = count.component.words
      checks.domText = (() => {
        const live = mm.renderer.findNodeByUid('n0')
        const text = live && live._textData && live._textData.node && live._textData.node.node
        return !!(text && text.isConnected && text.textContent === target)
      })()
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      await f.pause(300)
      checks.undoExactOriginalText = mm.renderer.findNodeByUid('n0').getData('text') === originalText
      checks.countNumAfterUndo = count.component.num === size
      checks.countWordsRestoredOnUndo = count.component.words === initialWords
      await f.waitRender(mm, () => mm.execCommand('FORWARD'))
      await f.pause(300)
      checks.redoText = mm.renderer.findNodeByUid('n0').getData('text') === target
      checks.countNumAfterRedo = count.component.num === size
      checks.countWordsReappliedOnRedo = count.component.words === editedWords
      const snapshot = mm.command.getCopyData()
      let snapshotNodes = 0
      const walk = tree => { snapshotNodes++; (tree.children || []).forEach(walk) }
      walk(snapshot)
      // This counts nodes in the command's in-memory copy snapshot only; it is
      // NOT a persistence/durable-save assertion.
      checks.commandSnapshotCardinality = snapshotNodes === size
      const actualOptions = { layout: mm.getLayout(), compactLayout: mm.opt.compactLayout }
      f.unmount(count)
      f.unmount(mounted)
      return { checks, size, originalText, target, initialWords, editedWords, actualOptions }
    })
    Object.assign(report.checks, result.checks)
    report.actualOptions = result.actualOptions
    report.observed = { size: result.size, originalText: result.originalText, target: result.target,
      initialWords: result.initialWords, editedWords: result.editedWords }
    report.pageErrors = harness.errors
    assert.deepEqual(harness.errors, [], 'real Edit.vue shell raised browser errors')
    for (const [name, value] of Object.entries(result.checks)) assert.equal(value, true, name + ' failed in the real Edit.vue shell')
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    report.classification = 'Protection finding, not a product RED'
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log('FULL_APP_COMPACT ' + output + ' status=' + report.status)
    console.log('  checks=' + JSON.stringify(report.checks))
    await harness.close()
  }
})
