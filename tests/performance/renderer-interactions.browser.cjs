'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')

function configFromEnv(env = process.env) {
  const phase = env.PERF_TDD_PHASE || 'before'
  assert.ok(['before', 'after', 'red', 'green'].includes(phase), 'invalid phase')
  const debug = env.PERF_TDD_DEBUG === '1'
  const samples = debug ? Number(env.PERF_TDD_DEBUG_SAMPLES || 1) : Number(env.PERF_TDD_SAMPLES || 200)
  const warmups = debug ? Number(env.PERF_TDD_DEBUG_WARMUPS || 0) : Number(env.PERF_TDD_WARMUPS || 10)
  assert.ok(Number.isInteger(samples) && (debug || samples >= 200), 'formal groups require >=200 samples')
  assert.ok(Number.isInteger(warmups) && (debug || warmups >= 10), 'formal groups require >=10 warmups')
  const sourceRoot = env.PERF_TDD_SOURCE_ROOT || repo
  assert.ok(path.isAbsolute(sourceRoot), 'sourceRoot must be absolute')
  assert.ok(fs.existsSync(path.join(sourceRoot, 'simple-mind-map/index.js')), 'production sourceRoot missing')
  const operations = env.PERF_TDD_OPERATION ? [env.PERF_TDD_OPERATION] : ['collapse', 'expand', 'zoom']
  assert.ok(operations.every(operation => ['collapse', 'expand', 'zoom'].includes(operation)), 'invalid operation')
  const runId = env.PERF_TDD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  assert.ok(/^[a-zA-Z0-9_-]+$/.test(runId), 'invalid runId')
  assert.ok(!debug || !env.PERF_TDD_COMPARE_WITH, 'debug runs cannot satisfy performance gates')
  return { phase, debug, samples, warmups, sourceRoot, operations, runId, sizes: debug ? [Number(env.PERF_TDD_DEBUG_SIZE || 4)] : [1000, 5000, 10000],
    compareWith: env.PERF_TDD_COMPARE_WITH || null, declaredSourceRevision: env.PERF_TDD_SOURCE_REVISION || null,
    sampleTimeoutMs: 30000, viewport: { width: 1280, height: 900 },
    options: { layout: 'logicalStructure', compactLayout: false, openPerformance: true, fit: false,
      openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, addHistoryOnInit: true,
      maxHistoryCount: 100, maxHistoryBytes: 32 * 1024 * 1024, createNewNodeBehavior: 'NOT_ACTIVE',
      performanceConfig: { time: 250, padding: 100, removeNodeWhenOutCanvas: true } } }
}

function percentile(rows, q) {
  const sorted = rows.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

async function setup(page, n, operation, options, diagnostic) {
  return page.evaluate(async ({ n, operation, options, diagnostic }) => {
    const f = rendererFixture, data = f.sparseViewportTree(n)
    // Real production fixture, with exactly two existing root children grafted
    // below the visible n0. Cardinality stays N; all other positions stay fixed.
    const children = data.children.splice(-2)
    children.forEach((child, i) => {
      child.data.customLeft = 300 + i * 150
      child.data.customTop = 370 + i * 80
    })
    data.children[0].children = children
    data.children[0].data.childCount = 2
    const fixtureText = JSON.stringify(data)
    const fixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fixtureText))))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const mm = await f.create(data, options)
    const loadedCount = tree => {
      let count = 0, pending = [tree]
      while (pending.length) { const current = pending.pop(); count++; pending.push(...(current.children || [])) }
      return count
    }
    if (loadedCount(mm.renderer.renderTree) !== n) throw new Error('fixture did not preserve exact N')
    if (mm.cooperate && mm.cooperate.collabV2Adapter) throw new Error('this fixture must exercise native history')
    // Drain the constructor's possible initial view timer before any operation.
    // This is setup, excluded from warmup and formal latency.
    await f.delay(options.performanceConfig.time + 75)
    const state = { mm, f, n, operation, diagnostic, childUids: children.map(child => child.data.uid), loadedCount }
    state.ready = expanded => {
      const owner = mm.renderer.nodeCache.n0
      if (!owner || owner.getData('expand') !== expanded || owner.children.length !== (expanded ? 2 : 0)) return false
      return state.childUids.every(uid => {
        const child = mm.renderer.nodeCache[uid]
        const connected = mm.nodeDraw.node.querySelector('[data-node-uid="' + uid + '"]')
        return expanded ? !!(child && child.parent === owner && child.group && child.group.node.isConnected && connected === child.group.node)
          : !connected && (!child || !child.group || !child.group.node.isConnected)
      })
    }
    // Diagnostics run only after timing has stopped. These are actual model
    // counts and the production visibility predicate/index, not padded N.
    state.diagnostics = () => {
      const diagnosticStarted = performance.now()
      const models = Object.values(mm.renderer.nodeCache)
      const predicateCandidates = models.filter(node => node.isRoot || node.checkIsInClient(mm.opt.performanceConfig.padding)).length
      const transform = mm.view.getTransformData().transform
      const padding = mm.opt.performanceConfig.padding, sx = transform.scaleX || 1, sy = transform.scaleY || 1
      const viewport = { left: (-padding - transform.translateX) / sx, top: (-padding - transform.translateY) / sy,
        right: (mm.width + padding - transform.translateX) / sx, bottom: (mm.height + padding - transform.translateY) / sy }
      const indexed = mm.renderer._viewportIndex ? mm.renderer._viewportIndex.query(viewport) : null
      return { diagnosticMs: performance.now() - diagnosticStarted, cacheModels: models.length,
        indexModels: mm.renderer.nodeIndex ? mm.renderer.nodeIndex.size : null,
        visiblePredicateCandidatesIncludingForcedRoot: predicateCandidates,
        indexedNodeCandidates: indexed ? indexed.filter(item => item.node).length : null,
        indexedEdgeCandidates: indexed ? indexed.filter(item => item.element).length : null,
        connectedNodeGroups: mm.nodeDraw.node.querySelectorAll('.smm-node').length,
        connectedConnectorPaths: mm.lineDraw.node.querySelectorAll('path').length,
        connectedBranchChildUids: state.childUids.filter(uid => mm.nodeDraw.node.querySelector('[data-node-uid="' + uid + '"]')),
        ownerExpanded: mm.renderer.nodeCache.n0.getData('expand'), ownerModelChildren: mm.renderer.nodeCache.n0.children.length,
        ownerLoadedChildren: mm.renderer.nodeCache.n0.nodeData.children.length,
        nativeHistoryEntries: mm.command.history.length, nativeHistoryBytes: mm.command.historyBytes == null ? null : mm.command.historyBytes,
        transform: { scaleX: transform.scaleX, scaleY: transform.scaleY, translateX: transform.translateX, translateY: transform.translateY } }
    }
    state.transition = async ({ expanded, scale, measure }) => {
      const started = performance.now(), events = []
      const c = f.counters(), work = { layouts: 0, copies: 0, fullTreeSerializations: 0, serializedCodeUnits: 0 }
      const originalLayout = mm.renderer.layout.doLayout, originalCopy = mm.command.getCopyData, originalStringify = JSON.stringify
      const originalPredicate = f.MindMapNode.prototype.checkIsInClient
      work.viewPredicateCalls = 0
      f.MindMapNode.prototype.checkIsInClient = function (...args) { work.viewPredicateCalls++; return originalPredicate.apply(this, args) }
      let renderMs = null, dataMs = null, scaleMs = null, viewMs = null
      let renderDone = false, dataDone = scale !== undefined, scaleDone = scale === undefined
      let finish, fail, timeout
      const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject })
      const maybeFinish = () => { if (renderDone && dataDone && scaleDone) finish() }
      const onEnd = metadata => {
        const ms = performance.now() - started, reason = metadata && metadata.reason || 'legacy-unspecified'
        events.push({ name: 'node_tree_render_end', ms, reason })
        if (mm.renderer.isRendering) return
        if (scale !== undefined) {
          if (reason !== 'legacy-unspecified' && reason !== 'view') return
          if (ms < mm.opt.performanceConfig.time - 2) return
          if (Math.abs(mm.view.getTransformData().transform.scaleX - scale) > 1e-9) return
        } else {
          if (reason !== 'legacy-unspecified' && reason !== 'layout') return
          if (!state.ready(expanded)) return
        }
        renderMs = ms; renderDone = true; maybeFinish()
      }
      const onData = data => {
        const ms = performance.now() - started
        events.push({ name: 'data_change', ms })
        if (scale !== undefined) return
        const owner = data && data.children && data.children[0]
        if (!owner || owner.data.uid !== 'n0' || owner.data.expand !== expanded || owner.children.length !== 2) return
        dataMs = ms; dataDone = true; maybeFinish()
      }
      const onScale = actual => {
        const ms = performance.now() - started
        events.push({ name: 'scale', ms, actual })
        if (scale !== undefined && Math.abs(actual - scale) <= 1e-9) { scaleMs = ms; scaleDone = true; maybeFinish() }
      }
      const onView = () => { viewMs = performance.now() - started; events.push({ name: 'view_data_change', ms: viewMs }) }
      if (measure) {
        mm.renderer.layout.doLayout = function (...args) { work.layouts++; return originalLayout.apply(this, args) }
        mm.command.getCopyData = function (...args) { work.copies++; return originalCopy.apply(this, args) }
        // Extra phase instrumentation is diagnostic only: wrapping
        // performance.now/setTimeout/index methods would otherwise inflate the
        // formal measured interval and make the before/after pair unfair.
        if (state.diagnostic) {
          work.nowCalls = 0; work.timeoutCalls = 0; work.timeoutWaitMs = 0
          work.indexBuildMs = 0; work.indexBuilds = 0; work.refreshMs = 0; work.refreshCalls = 0; work.createMs = 0; work.createCalls = 0; work.paintViewportMs = 0; work.paintViewports = 0
          const origBuildViewport = mm.renderer.buildViewportIndex.bind(mm.renderer)
          mm.renderer.buildViewportIndex = function (...args) { const t0 = performance.now(); work.indexBuilds++; const r = origBuildViewport(...args); if (r && typeof r.then === 'function') return r.then(v => { work.indexBuildMs += performance.now() - t0; return v }); work.indexBuildMs += performance.now() - t0; return r }
          const origPaintViewport = mm.renderer.paintViewport.bind(mm.renderer)
          mm.renderer.paintViewport = function (...args) { const t0 = performance.now(); work.paintViewports++; const r = origPaintViewport(...args); if (r && typeof r.then === 'function') return r.then(v => { work.paintViewportMs += performance.now() - t0; return v }); work.paintViewportMs += performance.now() - t0; return r }
          const viewportIndexClass = mm.renderer._viewportIndex && mm.renderer._viewportIndex.constructor
          if (viewportIndexClass) {
            var origRefresh = mm.renderer._viewportIndex.refreshWork ? null : mm.renderer._viewportIndex.refresh
            if (origRefresh) {
              state.restoreRefresh = () => { if (mm.renderer._viewportIndex) mm.renderer._viewportIndex.refresh = origRefresh }
              mm.renderer._viewportIndex.refresh = function (...args) { const t0 = performance.now(); work.refreshCalls++; try { return origRefresh.apply(this, args) } finally { work.refreshMs += performance.now() - t0 } }
            }
          }
          if (viewportIndexClass && typeof viewportIndexClass.create === 'function') {
            var origCreate = viewportIndexClass.create
            viewportIndexClass.create = function (...args) { const t0 = performance.now(); work.createCalls++; return origCreate.apply(this, args).then(v => { work.createMs += performance.now() - t0; return v }) }
            state.restoreCreate = () => { viewportIndexClass.create = origCreate }
          }
          const realNow = performance.now.bind(performance)
          performance.now = function () { work.nowCalls++; return realNow() }
          state.restoreNow = () => { performance.now = realNow }
          const realSetTimeout = window.setTimeout.bind(window)
          window.setTimeout = function (fn, ms, ...a) { work.timeoutCalls++; const t0 = performance.now(); return realSetTimeout(function (...args) { work.timeoutWaitMs += performance.now() - t0; return fn(...args) }, ms, ...a) }
          state.restoreTimeout = () => { window.setTimeout = realSetTimeout }
          work.renderLineMs = 0; work.renderLineCalls = 0; work.plotCalls = 0; work.plotNoopCalls = 0; work.styleLineMs = 0; work.styleLineCalls = 0
          const origRenderLine = f.MindMapNode.prototype.renderLine
          f.MindMapNode.prototype.renderLine = function (...args) { const t0 = performance.now(); work.renderLineCalls++; const r = origRenderLine.apply(this, args); work.renderLineMs += performance.now() - t0; return r }
          state.restoreRenderLine = () => { f.MindMapNode.prototype.renderLine = origRenderLine }
          const origStyleLine = f.MindMapNode.prototype.styleLine
          f.MindMapNode.prototype.styleLine = function (...args) { const t0 = performance.now(); work.styleLineCalls++; const r = origStyleLine.apply(this, args); work.styleLineMs += performance.now() - t0; return r }
          state.restoreStyleLine = () => { f.MindMapNode.prototype.styleLine = origStyleLine }
          // Count redundant path writes: an unchanged transformPath result still
          // goes through line.plot(d).
          const svgProto = window.SVGElement && window.SVGElement.prototype
          const origSetAttribute = svgProto && svgProto.setAttribute
          if (origSetAttribute) svgProto.setAttribute = function (name, value) { if (name === 'd') { work.plotCalls++; if (this.getAttribute('d') === String(value)) work.plotNoopCalls++ } return origSetAttribute.call(this, name, value) }
          state.restoreSetAttribute = () => { if (origSetAttribute) svgProto.setAttribute = origSetAttribute }
        }
        JSON.stringify = function (value, ...args) {
          const text = originalStringify.call(this, value, ...args)
          if (value && value.data && value.data.uid === 'root' && Array.isArray(value.children)) {
            work.fullTreeSerializations++; work.serializedCodeUnits += text.length
          }
          return text
        }
      }
      mm.on('node_tree_render_end', onEnd); mm.on('data_change', onData); mm.on('scale', onScale); mm.on('view_data_change', onView)
      timeout = setTimeout(() => fail(new Error('actual interaction did not finish with matching native events')), 30000)
      try {
        // The timer includes the real API/command, native history notification
        // when applicable, and the native render end. Zoom includes view's 250ms.
        if (scale !== undefined) mm.view.setScale(scale)
        else mm.execCommand('SET_NODE_EXPAND', mm.renderer.nodeCache.n0, expanded)
        await completion
        const ms = performance.now() - started
        const values = c.values
        const affected = new Set(['n0', ...state.childUids])
        let affectedWrites = 0, unrelatedWrites = 0
        for (const [uid, count] of Object.entries(values.writesByUid)) {
          if (affected.has(uid)) affectedWrites += count
          else unrelatedWrites += count
        }
        const measuredWork = { ...work, renders: values.renders, lines: values.lines, measures: values.measures,
          coordinateWrites: values.writes, affectedCoordinateWrites: affectedWrites, unrelatedCoordinateWrites: unrelatedWrites }
        return { ms, nativeRenderEndMs: renderMs, matchingContentNotificationMs: dataMs, nativeScaleEventMs: scaleMs,
          nativeViewDataEventMs: viewMs, viewThrottleMs: scale === undefined ? null : mm.opt.performanceConfig.time,
          desired: scale === undefined ? { expanded } : { scale }, events, work: measuredWork }
      } finally {
        clearTimeout(timeout)
        mm.off('node_tree_render_end', onEnd); mm.off('data_change', onData); mm.off('scale', onScale); mm.off('view_data_change', onView)
        mm.renderer.layout.doLayout = originalLayout; mm.command.getCopyData = originalCopy; JSON.stringify = originalStringify
        if (state.restoreNow) state.restoreNow()
        if (state.restoreTimeout) state.restoreTimeout()
        if (state.restoreRenderLine) state.restoreRenderLine()
        if (state.restoreStyleLine) state.restoreStyleLine()
        if (state.restoreSetAttribute) state.restoreSetAttribute()
        if (state.restoreRefresh) state.restoreRefresh()
        if (state.restoreCreate) state.restoreCreate()
        f.MindMapNode.prototype.checkIsInClient = originalPredicate
        c.restore()
      }
    }
    window.__rendererInteractions = state
    return { n, childUids: state.childUids, fixtureHash, loadedDataCount: loadedCount(mm.renderer.renderTree),
      actualCanvas: { width: mm.width, height: mm.height }, actualOptions: { layout: mm.getLayout(),
        compactLayout: mm.opt.compactLayout, openPerformance: mm.opt.openPerformance, performanceConfig: mm.opt.performanceConfig },
      initial: state.diagnostics() }
  }, { n, operation, options, diagnostic })
}

async function sampleChunk(page, operation, first, length, warmup) {
  return page.evaluate(async ({ operation, first, length, warmup }) => {
    const state = window.__rendererInteractions, rows = []
    for (let i = 0; i < length; i++) {
      const index = first + i
      let measured
      if (operation === 'zoom') {
        const target = Math.abs(state.mm.view.scale - 1) <= 1e-9 ? 1.02 : 1
        measured = await state.transition({ scale: target, measure: true })
      } else {
        const target = operation === 'expand'
        if (state.mm.renderer.nodeCache.n0.getData('expand') === target) await state.transition({ expanded: !target, measure: false })
        measured = await state.transition({ expanded: target, measure: true })
      }
      rows.push({ index, warmup, ...measured, actual: state.diagnostics() })
    }
    return rows
  }, { operation, first, length, warmup })
}

function compareReports(before, after) {
  assert.equal(before.mode, 'formal'); assert.equal(after.mode, 'formal')
  assert.equal(before.browser, after.browser, 'browser versions differ')
  assert.equal(before.nodeVersion, after.nodeVersion, 'driver runtimes differ')
  assert.deepEqual(before.config.viewport, after.config.viewport, 'browser viewport differs')
  assert.deepEqual(before.config.options, after.config.options, 'engine options differ')
  assert.deepEqual(before.config.sizes, after.config.sizes, 'graph sizes differ')
  assert.deepEqual(before.config.operations, after.config.operations, 'operation sets differ')
  assert.equal(before.config.samples, after.config.samples, 'formal sample counts differ')
  assert.equal(before.config.warmups, after.config.warmups, 'warmup counts differ')
  const expectedGroups = after.config.sizes.length * after.config.operations.length
  assert.equal(before.groups.length, expectedGroups, 'baseline operation matrix incomplete')
  assert.equal(after.groups.length, expectedGroups, 'after operation matrix incomplete')
  const rows = after.groups.map(current => {
    const previous = before.groups.find(item => item.n === current.n && item.operation === current.operation)
    assert.ok(previous, 'matching baseline group missing')
    assert.equal(previous.fixture.fixtureHash, current.fixture.fixtureHash, 'exact graph fixture differs')
    assert.deepEqual(previous.fixture.actualCanvas, current.fixture.actualCanvas)
    assert.ok(previous.rowsMs.length >= 200 && current.rowsMs.length >= 200, 'incomplete samples cannot pass')
    assert.ok(previous.warmupRows.length >= 10 && current.warmupRows.length >= 10, 'warmup incomplete')
    const ratio = current.p95 / previous.p95
    return { n: current.n, operation: current.operation, beforeP95: previous.p95, afterP95: current.p95,
      ratio, regressionPercent: (ratio - 1) * 100, thresholdRatio: 1.1, pass: ratio <= 1.1 }
  })
  return { pass: rows.every(row => row.pass), rows }
}

async function main() {
  const config = configFromEnv(), base = path.join(repo, 'work/performance-tdd', config.phase, 'renderer-interactions')
  fs.mkdirSync(base, { recursive: true })
  const destination = path.join(base, config.runId)
  // Exclusive run directories and wx artifacts refuse to overwrite prior raw.
  fs.mkdirSync(destination)
  const report = { mode: config.debug ? 'functional-debug-only' : 'formal', startedAt: new Date().toISOString(), config,
    nodeVersion: process.version, repositoryHeadAtBuild: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    productionDiffAtBuild: execFileSync('git', ['diff', '--name-only', '--', 'simple-mind-map/index.js', 'simple-mind-map/src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    scope: 'real native engine; sparseViewportTree(N) plus a visible n0 branch of exactly S=2; actual expand/collapse and scale 1<->1.02; content snapshot plus native render-end for expand/collapse; native scale/view/end including 250ms throttle for zoom',
    percentileDefinition: 'sorted[min(n-1,floor(n*q))]; diagnostics and unmeasured inverse preparation excluded',
    groups: [] }
  const writeNew = (name, data) => fs.writeFileSync(path.join(destination, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
  writeNew('manifest-start.json', report)
  let h
  try {
    h = await createHarness({ entry: path.join(__dirname, 'renderer-browser-entry.js'), sourceRoot: config.sourceRoot, viewport: config.viewport })
    report.browser = h.browser.version(); report.bundleHash = h.bundleHash; report.sourceRoot = h.sourceRoot
    for (const n of config.sizes) for (const operation of config.operations) {
      const page = await h.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await page.waitForFunction(() => !!window.rendererFixture)
        const fixture = await setup(page, n, operation, config.options, config.debug && process.env.PERF_TDD_PHASE_TIMING === '1')
        const group = { n, operation, subtreeSize: 2, fixture, warmupRows: [], samples: [], rowsMs: [], pageErrors: errors }
        const raw = path.join(destination, operation + '-' + n + '.jsonl')
        fs.writeFileSync(raw, '', { flag: 'wx' })
        for (const warmup of [true, false]) {
          const count = warmup ? config.warmups : config.samples
          for (let first = 0; first < count; first += 10) {
            const rows = await sampleChunk(page, operation, first, Math.min(10, count - first), warmup)
            fs.appendFileSync(raw, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
            ;(warmup ? group.warmupRows : group.samples).push(...rows)
            console.log(JSON.stringify({ phase: config.phase, runId: config.runId, n, operation, warmup, completed: first + rows.length, total: count }))
          }
        }
        group.rowsMs = group.samples.map(row => row.ms)
        group.p50 = percentile(group.rowsMs, .5); group.p95 = percentile(group.rowsMs, .95); group.p99 = percentile(group.rowsMs, .99)
        group.finalLoadedDataCount = await page.evaluate(() => __rendererInteractions.loadedCount(__rendererInteractions.mm.renderer.renderTree))
        assert.equal(group.finalLoadedDataCount, n, 'interaction changed actual loaded cardinality')
        assert.equal(errors.length, 0, 'browser page errors')
        assert.ok(group.samples.every(row => row.actual.ownerLoadedChildren === 2), 'loaded branch must remain exactly S=2')
        if (operation === 'zoom') assert.ok(group.samples.every(row => row.ms >= 248 && row.nativeScaleEventMs != null && row.nativeViewDataEventMs != null))
        else assert.ok(group.samples.every(row => row.matchingContentNotificationMs != null && row.actual.ownerExpanded === (operation === 'expand') &&
          row.actual.ownerModelChildren === (operation === 'expand' ? 2 : 0) && row.actual.connectedBranchChildUids.length === (operation === 'expand' ? 2 : 0)), 'actual expand/collapse result missing')
        writeNew(operation + '-' + n + '.json', group)
        report.groups.push(group)
        await page.evaluate(() => __rendererInteractions.mm.destroy())
      } finally { await page.close() }
    }
    report.status = config.debug ? 'FUNCTIONAL_DEBUG_ONLY' : 'SAMPLED'
    if (config.compareWith) {
      const comparison = compareReports(JSON.parse(fs.readFileSync(config.compareWith, 'utf8')), report)
      writeNew('p95-comparison.json', comparison)
      report.comparison = comparison
      report.status = comparison.pass ? 'P95_GATE_PASS' : 'P95_GATE_FAILED'
      if (!comparison.pass) process.exitCode = 1
    }
  } catch (error) { report.status = 'INCOMPLETE'; report.error = error.stack || String(error); process.exitCode = 1 }
  finally {
    report.finishedAt = new Date().toISOString()
    writeNew('manifest-final.json', report)
    if (h) await h.close()
    console.log('RENDERER_INTERACTIONS_REPORT ' + path.join(destination, 'manifest-final.json'))
  }
}
module.exports = { configFromEnv, compareReports }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
