'use strict'
// Genuine regression coverage for the 10k RichText full-render cost.
//
// Scope: source-bundled real Edit.vue component integration (esbuild harness),
// real MindMap renderer, real RichText/Formula/AssociativeLine/OuterFrame/Search
// plugins, native local history (no V2), openPerformance=false, exactly 10000
// ordinary model nodes (+1 summary from the shared fixture). It is NOT compiled
// served-app E2E and NOT an online/persistence test.
//
// Test 1 (deterministic work proxy): full paint of ordinary->rich nodes must not
// read SVG geometry (getBBox) while the progressively attached tree grows. The
// proxy is the weighted getBBox *call count* sum(getBBox renderSeq); it is a
// deterministic complexity proxy only and does not measure total reflow or
// algorithm cost. A linear bound is required.
//
// Test 1 also proxies rerender membership work: every existing node re-checks
// nodeDraw.has(group), and svg.js has()->index() slices+indexOf childNodes. The
// proxy is the weighted *call count* sum(has over current sibling count); it is
// deterministic only and not a total-cost measurement.
//
// Test 2 (real timed completion + semantics): the shared mixed C2 correctness
// scenario (simple-mind-map/test/c2RendererCorrectness.browser.test.js) must
// finish inside a fixed 90s Node guard with openPerformance=false, the initial
// full paint must fit a fixed justified budget, and every semantic check must
// hold (no plain-text substitution, real per-UID foreignObjects, formula/image/
// summary/frame/associative/edit/undo/redo/move).
//
// Outputs are unique per runId and refuse to overwrite. Harness/fixture errors
// are reported as BLOCKED_ENV, not RED.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')
const { runRendererCorrectness, prepareRendererCorrectnessFixture } = require('../../simple-mind-map/test/c2RendererCorrectness.browser.test.js')

const SCENARIO_GUARD_MS = 90000
const PAINT_BUDGET_MS = 10000   // justified: linear paint of N=1000 is ~0.32s => ~3.2s at 10k, ~3x headroom
const WORK_LINEAR_FACTOR = 8    // weighted getBBox work allowed per node
const WORK_SCALE_FACTOR = 6     // 4x nodes must stay within 6x work
const EXTERNAL_GUARD_MS = 150000

function newRunId () {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
}
function evidencePath (phase, name, id) {
  const dir = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}-${id}.json`)
  if (fs.existsSync(file)) throw new Error('refusing to overwrite existing evidence: ' + file)
  return file
}
function withExternalGuard (promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(label + ' exceeded external Node guard ' + ms + 'ms (browser thread blocked)')
        error.code = 'EXTERNAL_GUARD'
        reject(error)
      }, ms)
    })
  ])
}
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
function ordinaryTree (total) {
  return { data: { uid: 'root', text: 'Root', expand: true },
    children: Array.from({ length: total - 1 }, (_, i) => ({ data: { uid: 'n' + i, text: 'Node ' + i, expand: true }, children: [] })) }
}

test('full RichText paint work is proportional to node count, not to its square', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const id = newRunId()
  const output = evidencePath(phase, 'richtext-fullrender-work', id)
  const harness = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
    handleRequest: createMemoryTransport(), sourceRoot: repo, viewport: { width: 1280, height: 900 } })
  const report = { scope: 'source-bundled real Edit.vue + real RichText plugin; ordinary nodes converted to richText; openPerformance=false; full paint; weighted SVGGraphicsElement.getBBox work during paint',
    runId: id, phase, node: process.version, browser: harness.browser.version(), bundleHash: harness.bundleHash,
    sourceRoot: repo, startedAt: new Date().toISOString(), rows: [] }
  try {
    for (const size of [1000, 4000]) {
      const page = await harness.newPage()
      await page.waitForFunction(() => !!window.perfFrontend)
      const row = await withExternalGuard(page.evaluate(async (N) => {
        const f = window.perfFrontend
        const mounted = await f.mountEditor()
        const mm = mounted.component.mindMap
        mounted.component.addRichTextPlugin()
        mm.updateConfig({ compactLayout: false, openPerformance: false, addHistoryTime: 0, maxHistoryCount: 100 })
        mm.setLayout('logicalStructure', true)
        const settle = () => new Promise(resolve => {
          const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
          const timer = setTimeout(() => { mm.off('node_tree_render_end', done); resolve() }, 3000)
          mm.on('node_tree_render_end', done)
        })
        await settle() // let the plugin's own small initial render finish
        const proto = Object.getPrototypeOf(mm.renderer.root)
        const metrics = { renderSeq: 0, gbboxCalls: 0, gbboxWeighted: 0, gbboxMs: 0 }
        const now = () => performance.now()
        const origRender = proto.render
        proto.render = function (...args) { metrics.renderSeq++; return origRender.apply(this, args) }
        const svgProto = window.SVGGraphicsElement && window.SVGGraphicsElement.prototype
        if (!svgProto || typeof svgProto.getBBox !== 'function') throw new Error('SVGGraphicsElement.getBBox unavailable')
        const origGetBBox = svgProto.getBBox
        svgProto.getBBox = function (...args) {
          metrics.gbboxCalls++; metrics.gbboxWeighted += metrics.renderSeq
          const t = now(); try { return origGetBBox.apply(this, args) } finally { metrics.gbboxMs += now() - t }
        }
        // Instrumentation sanity probe, then reset before measuring.
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        mm.svg.node.appendChild(probe); probe.getBBox(); mm.svg.node.removeChild(probe)
        const hookSanity = metrics.gbboxCalls
        metrics.gbboxCalls = 0; metrics.gbboxWeighted = 0; metrics.gbboxMs = 0
        const tree = { data: { uid: 'root', text: 'Root', expand: true },
          children: Array.from({ length: N - 1 }, (_, i) => ({ data: { uid: 'n' + i, text: 'Node ' + i, expand: true }, children: [] })) }
        let start = null, end = null
        const onStart = () => { start = now() }; const onEnd = () => { end = now() }
        mm.on('node_tree_render_start', onStart); mm.on('node_tree_render_end', onEnd)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('paint did not finish for N=' + N)) }, 60000)
          const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
          mm.on('node_tree_render_end', done)
          mm.setData(tree)
        })
        mm.off('node_tree_render_start', onStart); mm.off('node_tree_render_end', onEnd)
        const model = (() => { let total = 0, rich = 0; const walk = n => { total++; if (n.data && n.data.richText) rich++; for (const c of n.children || []) walk(c) }; walk(mm.renderer.renderTree); return { total, rich } })()
        // Rerender phase: existing groups re-check nodeDraw.has(group).
        // Drain any queued follow-up renders so the rerender is a clean,
        // freshly observed pass rather than a leftover from setData.
        await new Promise(resolve => {
          const check = () => { if (!mm.renderer.isRendering && !mm.renderer.renderTimer && !mm.renderer.hasWaitRendering) resolve(); else setTimeout(check, 10) }
          check()
        })
        const member = { calls: 0, weighted: 0, ms: 0 }
        const nodeDraw = mm.nodeDraw
        const origHas = nodeDraw.has
        const waitRenderPass = action => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('rerender did not finish for N=' + N)) }, 60000)
          const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
          mm.on('node_tree_render_end', done)
          action()
        })
        const idle = () => new Promise(resolve => {
          const check = () => { if (!mm.renderer.isRendering && !mm.renderer.renderTimer && !mm.renderer.hasWaitRendering) resolve(); else setTimeout(check, 10) }
          check()
        })
        nodeDraw.has = function (el) { member.calls++; member.weighted += this.node.childNodes.length; const t = now(); try { return origHas.call(this, el) } finally { member.ms += now() - t } }
        const seqBefore = metrics.renderSeq
        let rerenderPaintMs = 0
        try {
          const r0 = now()
          // A real user edit. If it takes the local fast path (equal-height
          // leaf), force an explicit full render so membership work is
          // genuinely exercised.
          await waitRenderPass(() => mm.renderer.root.setText('<p>Edited root text</p>', true))
          await idle()
          if (metrics.renderSeq - seqBefore < N) {
            member.calls = 0; member.weighted = 0; member.ms = 0
            await waitRenderPass(() => mm.render())
            await idle()
          }
          rerenderPaintMs = now() - r0
        } finally { nodeDraw.has = origHas }
        const renderTraversalDelta = metrics.renderSeq - seqBefore
        return { paintMs: end != null && start != null ? end - start : null, hookSanity, ...metrics, model,
          rerenderPaintMs, member, renderTraversalDelta,
          foreignObjects: mm.svg.node.querySelectorAll('foreignObject').length,
          smmNodes: mm.svg.node.querySelectorAll('.smm-node').length,
          openPerformance: mm.opt.openPerformance, usePlainTextFastPath: mm.renderer.usePlainTextFastPath === true,
          hasRichText: !!mm.richText, isV2: typeof mm.command.usesV2History === 'function' ? mm.command.usesV2History() : null,
          layout: mm.getLayout() }
      }, size), EXTERNAL_GUARD_MS, 'work test N=' + size)
      report.rows.push({ size, ...row })
      await page.close()
    }
    if (harness.errors.length) { const e = new Error('browser errors: ' + harness.errors.join('; ')); e.code = 'HARNESS_ERROR'; throw e }
    const violations = []
    for (const row of report.rows) {
      if (!(row.hookSanity >= 1)) violations.push('N=' + row.size + ': getBBox instrumentation sanity probe did not fire')
      if (row.hasRichText !== true) violations.push('N=' + row.size + ': real RichText plugin must be attached')
      if (row.isV2 !== false) violations.push('N=' + row.size + ': native local history (not V2) is required')
      if (row.openPerformance !== false) violations.push('N=' + row.size + ': openPerformance must stay false')
      if (row.model.rich !== row.size) violations.push('N=' + row.size + ': all model nodes must be richText')
      if (row.foreignObjects !== row.size) violations.push('N=' + row.size + ': every node must attach a real foreignObject (' + row.foreignObjects + ')')
      if (!(row.gbboxWeighted <= WORK_LINEAR_FACTOR * row.size)) {
        violations.push(`N=${row.size}: full paint weighted getBBox proxy ${row.gbboxWeighted} (calls=${row.gbboxCalls}, ${row.gbboxMs.toFixed(1)}ms); linear bound is ${WORK_LINEAR_FACTOR * row.size}`)
      }
      if (!(row.renderTraversalDelta >= row.size)) {
        violations.push('N=' + row.size + ': rerender membership precondition failed: render traversal delta ' + row.renderTraversalDelta + ' < ' + row.size)
      }
      if (!(row.member.weighted <= WORK_LINEAR_FACTOR * row.size)) {
        violations.push(`N=${row.size}: rerender membership proxy ${row.member.weighted} (has calls=${row.member.calls}, ${row.member.ms.toFixed(1)}ms); linear bound is ${WORK_LINEAR_FACTOR * row.size}`)
      }
    }
    if (report.rows.length === 2) {
      const [small, large] = report.rows
      if (!(large.gbboxWeighted <= WORK_SCALE_FACTOR * small.gbboxWeighted)) {
        violations.push('weighted getBBox work scaled ' + (large.gbboxWeighted / small.gbboxWeighted).toFixed(2) + 'x from N=1000 to N=4000')
      }
    }
    report.violations = violations
    if (violations.length) assert.fail('richtext full-render RED violations:\n- ' + violations.join('\n- '))
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error.code === 'HARNESS_ERROR' ? 'BLOCKED_ENV'
      : (error instanceof assert.AssertionError || error.code === 'EXTERNAL_GUARD') ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('RICHTEXT_FULLRENDER_WORK ' + output + ' status=' + report.status)
    for (const row of report.rows) console.log(`  N=${row.size} paintMs=${row.paintMs} gbboxCalls=${row.gbboxCalls} gbboxWeighted=${row.gbboxWeighted} gbboxMs=${row.gbboxMs && row.gbboxMs.toFixed(1)} foreign=${row.foreignObjects}`)
    if (report.rows.length === 2) console.log('  workScale=' + (report.rows[1].gbboxWeighted / report.rows[0].gbboxWeighted).toFixed(2) + 'x')
    for (const row of report.rows) console.log(`  N=${row.size} rerenderPaintMs=${row.rerenderPaintMs} memberCalls=${row.member.calls} memberWeighted=${row.member.weighted} memberMs=${row.member.ms && row.member.ms.toFixed(1)}`)
    await boundedClose(harness)
  }
})

test('exactly 10000 mixed C2 RichText nodes fully render and pass native-history correctness within fixed guards', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const id = newRunId()
  const output = evidencePath(phase, 'richtext-fullrender-c2-10k', id)
  // Fixture is built and validated before the browser launches so a fixture
  // precondition error cannot leak a Chrome process.
  const total = 10000
  const tree = ordinaryTree(total)
  const fixture = prepareRendererCorrectnessFixture(tree)
  const harness = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
    handleRequest: createMemoryTransport(), sourceRoot: repo, viewport: { width: 1280, height: 900 } })
  const report = { scope: 'source-bundled real Edit.vue + real RichText plugin + shared mixed C2 fixture; openPerformance=false; native local history; full shared correctness scenario under fixed Node guards',
    runId: id, phase, node: process.version, browser: harness.browser.version(), bundleHash: harness.bundleHash,
    sourceRoot: repo, totalNodes: total, scenarioGuardMs: SCENARIO_GUARD_MS, paintBudgetMs: PAINT_BUDGET_MS,
    startedAt: new Date().toISOString(), stageLog: [] }
  try {
    const page = await harness.newPage()
    page.on('console', message => {
      const text = message.text()
      if (text.startsWith('[RT-STAGE]') || text.startsWith('[c2-correctness-stage]')) { report.stageLog.push({ at: Date.now(), text }); console.log(text) }
    })
    await page.waitForFunction(() => !!window.perfFrontend)
    report.instrumentation = await withExternalGuard(page.evaluate(async () => {
      const f = window.perfFrontend
      const mounted = await f.mountEditor()
      const mm = mounted.component.mindMap
      mounted.component.addRichTextPlugin()
      mm.updateConfig({ compactLayout: false, openPerformance: false, addHistoryTime: 0, maxHistoryCount: 100 })
      mm.setLayout('logicalStructure', true)
      window.__C2_STABLE_MM__ = mm
      // Let the plugin's own small initial render finish before measuring the
      // 10k paint, so paints[0] is the setData full paint.
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
        const timer = setTimeout(() => { mm.off('node_tree_render_end', done); resolve() }, 3000)
        mm.on('node_tree_render_end', done)
      })
      const proto = Object.getPrototypeOf(mm.renderer.root)
      const metrics = { renderSeq: 0, gbboxCalls: 0, gbboxWeighted: 0, gbboxMs: 0, layoutCalls: 0, layoutMs: 0, normalizeCalls: 0, normalizeMs: 0, paints: [] }
      const now = () => performance.now()
      const origRender = proto.render
      proto.render = function (...args) { metrics.renderSeq++; return origRender.apply(this, args) }
      const svgProto = window.SVGGraphicsElement.prototype
      const origGetBBox = svgProto.getBBox
      svgProto.getBBox = function (...args) { metrics.gbboxCalls++; metrics.gbboxWeighted += metrics.renderSeq; const t = now(); try { return origGetBBox.apply(this, args) } finally { metrics.gbboxMs += now() - t } }
      const layout = mm.renderer.layout
      const layoutProto = Object.getPrototypeOf(layout)
      const origDoLayout = layoutProto.doLayout
      layoutProto.doLayout = function (...args) { metrics.layoutCalls++; const t = now(); try { return origDoLayout.apply(this, args) } finally { metrics.layoutMs += now() - t } }
      const rt = mm.richText
      const origHandleSetData = rt.handleSetData
      const wrapped = function (data) { const t = now(); try { return origHandleSetData.call(rt, data) } finally { metrics.normalizeMs += now() - t; metrics.normalizeCalls++ } }
      mm.off('before_set_data', rt.handleSetData); mm.on('before_set_data', wrapped)
      mm.off('before_update_data', rt.handleSetData); mm.on('before_update_data', wrapped)
      let paintStart = null
      mm.on('node_tree_render_start', () => { paintStart = now(); console.log('[RT-STAGE] render:start') })
      mm.on('node_tree_render_end', () => { const ms = paintStart != null ? now() - paintStart : null; metrics.paints.push(ms); console.log('[RT-STAGE] render:end ' + JSON.stringify({ paintMs: ms })) })
      window.__RT_METRICS__ = metrics
      return { layoutName: layout.constructor.name, openPerformance: mm.opt.openPerformance, compactLayout: mm.opt.compactLayout, hasRichText: !!mm.richText }
    }), EXTERNAL_GUARD_MS, 'C2 instrumentation mount')
    report.checks = await withExternalGuard(
      runRendererCorrectness(page, tree, { fixture }), SCENARIO_GUARD_MS, 'full 10k mixed C2 RichText scenario')
    report.post = await withExternalGuard(page.evaluate(({ summaryOwnerUid, summaryUid }) => {
      const mm = window.__C2_STABLE_MM__
      const ordinary = []
      const walk = node => { ordinary.push(node); for (const child of node.children || []) walk(child) }
      walk(mm.renderer.renderTree)
      let connected = 0, withForeign = 0
      const missing = []
      for (const data of ordinary) {
        const node = mm.renderer.findNodeByUid(data.data.uid)
        const group = node && node.group && node.group.node
        if (group && group.isConnected) connected++
        if (group && group.isConnected && group.querySelector('foreignObject')) withForeign++
        else missing.push(data.data.uid)
      }
      let rich = 0
      for (const data of ordinary) if (data.data && data.data.richText) rich++
      // Locate the true summary instance (not derivable by subtraction).
      const summaryOwner = mm.renderer.findNodeByUid(summaryOwnerUid)
      const summaryEntry = summaryOwner && summaryOwner._generalizationList &&
        summaryOwner._generalizationList.find(item => item.generalizationNode && item.generalizationNode.getData('uid') === summaryUid)
      const summaryNode = summaryEntry && summaryEntry.generalizationNode
      const summaryGroup = summaryNode && summaryNode.group && summaryNode.group.node
      const summaryConnected = !!(summaryGroup && summaryGroup.isConnected)
      const summaryWithForeign = !!(summaryGroup && summaryGroup.isConnected && summaryGroup.querySelector('foreignObject'))
      return { ordinaryTotal: ordinary.length, ordinaryConnected: connected, ordinaryWithForeign: withForeign, ordinaryRich: rich,
        missing: missing.slice(0, 10), summaryUid, summaryConnected, summaryWithForeign,
        foreignObjects: mm.svg.node.querySelectorAll('foreignObject').length,
        smmNodes: mm.svg.node.querySelectorAll('.smm-node').length,
        openPerformance: mm.opt.openPerformance,
        historyLength: mm.command.history.length,
        isV2: typeof mm.command.usesV2History === 'function' ? mm.command.usesV2History() : null,
        metrics: window.__RT_METRICS__ }
    }, { summaryOwnerUid: fixture.summaryOwnerUid, summaryUid: fixture.summaryUid }), EXTERNAL_GUARD_MS, 'C2 post-check')
    assert.deepEqual(harness.errors, [], 'browser exceptions are infrastructure failures, not correctness RED')
    assert.ok(report.instrumentation.hasRichText, 'real RichText plugin must be attached')
    assert.deepEqual(report.checks, Object.fromEntries(Object.keys(report.checks).map(key => [key, true])), 'shared C2 correctness checks must all pass')
    assert.equal(report.post.isV2, false, 'native local history (not V2) is required')
    assert.equal(report.post.openPerformance, false, 'openPerformance must stay false for the full scenario')
    assert.equal(report.post.ordinaryTotal, total, 'ordinary model cardinality must stay exactly 10000')
    assert.equal(report.post.ordinaryRich, total, 'every ordinary node must remain richText')
    assert.equal(report.post.ordinaryWithForeign, total, 'every ordinary node must attach a real foreignObject: missing ' + JSON.stringify(report.post.missing))
    assert.equal(report.post.summaryConnected, true, 'the true summary instance must have a connected group')
    assert.equal(report.post.summaryWithForeign, true, 'the true summary instance must attach its own foreignObject')
    assert.equal(report.post.foreignObjects, report.post.ordinaryWithForeign + 1, 'exactly 10000 ordinary + 1 summary foreignObjects are required')
    assert.equal(report.post.smmNodes, total + 1, 'exactly 10001 attached node groups are required')
    const paints = report.post.metrics.paints.filter(Number.isFinite)
    assert.ok(paints.length >= 1, 'full 10k paint must be observed')
    const initialPaint = paints[0]
    assert.ok(initialPaint <= PAINT_BUDGET_MS,
      `initial full 10k mixed RichText paint took ${Math.round(initialPaint)}ms; the justified linear budget is ${PAINT_BUDGET_MS}ms`)
    report.initialPaintMs = initialPaint
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = (error instanceof assert.AssertionError || error.code === 'EXTERNAL_GUARD') ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('RICHTEXT_FULLRENDER_C2 ' + output + ' status=' + report.status)
    if (report.checks) console.log('  checks=' + JSON.stringify(report.checks))
    if (report.post) console.log('  post=' + JSON.stringify(report.post))
    console.log('  initialPaintMs=' + report.initialPaintMs)
    await boundedClose(harness)
  }
})
