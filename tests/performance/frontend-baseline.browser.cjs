'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')

function configFromEnv(env = process.env) {
  const phase = env.PERF_TDD_PHASE || 'before'
  assert.ok(['red', 'green', 'before', 'after'].includes(phase), 'invalid phase')
  const samples = Number(env.PERF_TDD_SAMPLES || 200), warmups = Number(env.PERF_TDD_WARMUPS || 0)
  assert.ok(Number.isInteger(samples) && samples >= 200, 'formal groups require >=200 samples')
  assert.ok(Number.isInteger(warmups) && warmups >= 0, 'invalid warmup count')
  const sourceRoot = env.PERF_TDD_SOURCE_ROOT || repo
  assert.ok(path.isAbsolute(sourceRoot), 'sourceRoot must be absolute')
  assert.ok(fs.existsSync(path.join(sourceRoot, 'simple-mind-map/index.js')), 'production sourceRoot missing')
  const operations = env.PERF_TDD_OPERATION ? [env.PERF_TDD_OPERATION] : ['edit', 'selection', 'minimap']
  assert.ok(operations.every(op => ['edit', 'selection', 'minimap'].includes(op)), 'invalid operation')
  const runId = env.PERF_TDD_RUN_ID || env.PERF_TDD_LABEL || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  assert.match(runId, /^[A-Za-z0-9_-]+$/, 'invalid unique run ID')
  return { phase, samples, warmups, sourceRoot, operations, runId, sizes: [1000, 5000, 10000],
    declaredSourceRevision: env.PERF_TDD_SOURCE_REVISION || null,
    viewport: { width: 1280, height: 900 }, protocol: 'native-content-and-matching-render-v2',
    // Preserve the historical zero-explicit-warmup default. New paired edit
    // groups must use equal warmups. The interaction runner requires >=10.
    options: { layout: 'logicalStructure', compactLayout: true, openPerformance: true,
      openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, maxHistoryCount: 100,
      createNewNodeBehavior: 'NOT_ACTIVE' }, sampleTimeoutMs: 30000 }
}
function percentile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}
async function setup(page, size, options) {
  return page.evaluate(async ({ size, options }) => {
    const f = window.perfFrontend, data = f.tree(size - 1)
    const fixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const mm = await f.createEngine(data, options), count = f.mount(f.Count, { mindMap: mm })
    const forward = (data, change) => f.bus.$emit('data_change', data, change)
    mm.on('data_change', forward)
    await f.pause(325) // Exclude constructor render/content/view timers.
    const proto = Object.getPrototypeOf(mm.renderer.root), work = {}, restores = []
    const instrument = (object, name, metric, only) => {
      const original = object[name]
      if (typeof original !== 'function') throw new Error('missing actual instrumented method: ' + name)
      object[name] = function (...args) {
        if (!only || only(args)) work[metric] = (work[metric] || 0) + 1
        return original.apply(this, args)
      }
      restores.push(() => { object[name] = original })
    }
    instrument(proto, 'render', 'nodeRenders'); instrument(proto, 'renderLine', 'lineRenders')
    instrument(proto, 'getSize', 'measures'); instrument(proto, 'getData', 'uidReads', args => args[0] === 'uid')
    instrument(mm.renderer.layout, 'doLayout', 'layouts'); instrument(mm.command, 'getCopyData', 'copies')
    instrument(count.component, 'walk', 'countVisits')
    const stringify = JSON.stringify
    JSON.stringify = function (value, ...args) {
      const text = stringify.call(this, value, ...args)
      if (value && value.data && value.data.uid === 'root' && Array.isArray(value.children)) {
        work.fullTreeSerializations = (work.fullTreeSerializations || 0) + 1
        work.serializedCodeUnits = (work.serializedCodeUnits || 0) + text.length
      }
      return text
    }
    restores.push(() => { JSON.stringify = stringify })
    const countLoaded = tree => {
      let n = 0, pending = [tree]
      while (pending.length) { const item = pending.pop(); n++; pending.push(...(item.children || [])) }
      return n
    }
    const diagnostics = () => ({ loadedDataNodes: countLoaded(mm.renderer.renderTree),
      currentCacheModels: Object.keys(mm.renderer.nodeCache || {}).length,
      indexedModels: mm.renderer.nodeIndex ? mm.renderer.nodeIndex.size : null,
      visiblePredicateCandidates: Object.values(mm.renderer.nodeCache || {}).filter(node => node.isRoot || node.checkIsInClient(mm.opt.performanceConfig.padding)).length,
      connectedGroups: mm.nodeDraw.node.querySelectorAll('.smm-node').length,
      countNodes: count.component.num, countWords: count.component.words,
      nativeHistoryEntries: mm.command.history.length, nativeHistoryBytes: mm.command.historyBytes ?? null })
    window.__perfBench = { mm, count, work, f, diagnostics,
      resetWork() { for (const key of Object.keys(work)) delete work[key] },
      restore() { for (const restore of restores.reverse()) restore(); mm.off('data_change', forward) } }
    const initial = diagnostics()
    if (initial.loadedDataNodes !== size || initial.currentCacheModels !== size || initial.countNodes !== size) {
      throw new Error('actual setup cardinality differs from declared N: ' + stringify(initial))
    }
    if (mm.cooperate && mm.cooperate.collabV2Adapter) throw new Error('native fixture unexpectedly uses V2 history')
    return { fixtureHash, initial, actualCanvas: { width: mm.width, height: mm.height },
      actualOptions: { layout: mm.getLayout(), compactLayout: mm.opt.compactLayout,
        openPerformance: mm.opt.openPerformance, addHistoryTime: mm.opt.addHistoryTime,
        maxHistoryCount: mm.opt.maxHistoryCount, maxHistoryBytes: mm.opt.maxHistoryBytes ?? null } }
  }, { size, options })
}
async function sampleChunk(page, operation, offset, length, warmup, timeoutMs) {
  return page.evaluate(async ({ operation, offset, length, warmup, timeoutMs }) => {
    const state = window.__perfBench, { mm } = state, rows = []
    const ids = Array.from({ length: 20 }, (_, i) => 'n' + i * 37)
    // Match historical cache preparation, outside the timed get-cache call.
    mm.select.lastMultiSelectUids = ids
    mm.select.lastMultiSelectList = ids.map(uid => mm.renderer.findNodeByUid(uid))
    for (let i = 0; i < length; i++) {
      const index = offset + i, target = 'Edited ' + String(index).padStart(4, '0')
      state.resetWork()
      const events = [], started = performance.now()
      let nativeRenderEndMs = null, matchingContentNotificationMs = null
      if (operation === 'edit') {
        let finish, fail, renderStarted = false, renderDone = false, dataDone = false
        const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject })
        const maybeFinish = () => { if (renderDone && dataDone) finish() }
        const onStart = () => { renderStarted = true; events.push({ name: 'node_tree_render_start', elapsedMs: performance.now() - started }) }
        const onData = data => {
          const elapsedMs = performance.now() - started
          events.push({ name: 'data_change', elapsedMs })
          const node = data && data.children && data.children[0]
          if (!node || node.data.uid !== 'n0' || node.data.text !== target) return
          matchingContentNotificationMs = elapsedMs; dataDone = true; maybeFinish()
        }
        const onEnd = metadata => {
          const elapsedMs = performance.now() - started, reason = metadata && metadata.reason || 'legacy-unspecified'
          events.push({ name: 'node_tree_render_end', elapsedMs, reason })
          // Equal-size edits legitimately emit render_end without render_start.
          // Still require the actual current model/visible text and the matching
          // data_change below; neither an unrelated view end nor model-only state
          // can complete this sample.
          if (reason !== 'legacy-unspecified' && reason !== 'layout') return
          const node = mm.renderer.nodeCache.n0
          if (mm.renderer.isRendering || !node || node.getData('text') !== target) return
          // Preserve the historical flat fixture and its viewport. An offscreen
          // edit must finish the actual layout/model work without requiring
          // deliberately culled SVG; visible targets must match attached text.
          if (node.checkIsInClient(mm.opt.performanceConfig.padding) &&
            (!node._textData || !node._textData.node || !node._textData.node.node.isConnected || node._textData.node.node.textContent !== target)) return
          nativeRenderEndMs = elapsedMs; renderDone = true; maybeFinish()
        }
        mm.on('node_tree_render_start', onStart); mm.on('data_change', onData); mm.on('node_tree_render_end', onEnd)
        const timer = setTimeout(() => {
          const node = mm.renderer.nodeCache.n0
          const textNode = node && node._textData && node._textData.node && node._textData.node.node
          // Capture only failure diagnostics; never add tree scans to timed samples.
          const diagnostic = { index, target, renderStarted, renderDone, dataDone, events,
            isRendering: mm.renderer.isRendering, modelText: node && node.getData('text'),
            viewportVisible: node && node.checkIsInClient(mm.opt.performanceConfig.padding),
            textConnected: !!(textNode && textNode.isConnected), textContent: textNode && textNode.textContent,
            work: { ...state.work } }
          fail(new Error('matching native content/render events timed out: ' + JSON.stringify(diagnostic)))
        }, timeoutMs)
        try {
          mm.renderer.findNodeByUid('n0').setText(target, false)
          await completion
        } finally {
          clearTimeout(timer); mm.off('node_tree_render_start', onStart); mm.off('data_change', onData); mm.off('node_tree_render_end', onEnd)
        }
      } else if (operation === 'selection') {
        const live = mm.select.getMultiSelectCache()
        if (live.length !== 20 || live.some((node, i) => node !== mm.select.lastMultiSelectList[i])) {
          throw new Error('selection fixture lost current ordered instances')
        }
      } else {
        const mini = mm.miniMap.calculationMiniMap(370, 220)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('actual MiniMap Blob conversion timeout')), timeoutMs)
          mini.getImgUrl(value => { clearTimeout(timer); if (!value) reject(new Error('empty actual MiniMap image')); else resolve() })
        })
      }
      rows.push({ index, warmup, ms: performance.now() - started, nativeRenderEndMs,
        matchingContentNotificationMs, events, work: { ...state.work },
        targetViewportVisible: mm.renderer.nodeCache.n0.checkIsInClient(mm.opt.performanceConfig.padding),
        targetDomConnected: !!(mm.renderer.nodeCache.n0._textData && mm.renderer.nodeCache.n0._textData.node && mm.renderer.nodeCache.n0._textData.node.node.isConnected),
        countNodes: state.count.component.num, countWords: state.count.component.words })
    }
    return rows
  }, { operation, offset, length, warmup, timeoutMs })
}
function compareNativeEdit(before, after) {
  assert.equal(before.status, 'MEASURED', 'before report is incomplete')
  assert.equal(after.status, 'MEASURED', 'after report is incomplete')
  assert.equal(before.protocol, 'native-content-and-matching-render-v2')
  assert.equal(after.protocol, before.protocol, 'completion protocols differ')
  assert.equal(after.node, before.node, 'driver runtimes differ'); assert.equal(after.browser, before.browser, 'browser versions differ')
  assert.deepEqual(after.config.viewport, before.config.viewport); assert.deepEqual(after.config.options, before.config.options)
  assert.equal(after.config.samples, before.config.samples); assert.equal(after.config.warmups, before.config.warmups)
  const comparisons = []
  for (const size of [1000, 5000, 10000]) {
    const find = report => report.groups.find(group => group.size === size && group.operation === 'edit')
    const a = find(before), b = find(after)
    assert.ok(a && b && a.rowsMs.length === before.config.samples && b.rowsMs.length === after.config.samples, 'missing full paired edit group')
    assert.equal(b.setup.fixtureHash, a.setup.fixtureHash, 'fixtures differ'); assert.deepEqual(b.setup.actualCanvas, a.setup.actualCanvas)
    for (const group of [a, b]) {
      assert.equal(group.rows.length, group.rowsMs.length)
      assert.equal(group.final.loadedDataNodes, size); assert.equal(group.final.countNodes, size)
      assert.ok(Number.isFinite(group.p95) && group.p95 > 0)
      assert.ok(group.rows.every(row => row.nativeRenderEndMs != null && row.matchingContentNotificationMs != null))
    }
    comparisons.push({ size, beforeP95Ms: a.p95, afterP95Ms: b.p95, ratio: b.p95 / a.p95,
      status: b.p95 <= a.p95 * .6 ? 'P95_40_PERCENT_GATE_PASS' : 'P95_40_PERCENT_GATE_FAILED' })
  }
  return comparisons
}
async function main() {
  const config = configFromEnv(), parent = path.join(repo, 'work/performance-tdd', config.phase, 'frontend-performance')
  fs.mkdirSync(parent, { recursive: true })
  const output = path.join(parent, config.runId)
  fs.mkdirSync(output) // Reject reused run IDs before creating any browser.
  const report = { phase: config.phase, protocol: config.protocol, config, node: process.version,
    startedAt: new Date().toISOString(), status: 'RUNNING', sizes: config.sizes,
    samplesPerGroup: config.samples, warmupsPerGroup: config.warmups, viewport: config.viewport,
    scope: 'actual engine/Count/native history; matching native edit content+render; fixed 20-UID cache; actual MiniMap SVG/Blob',
    sourceDiffAtBuild: execFileSync('git', ['diff', '--stat', '--', 'simple-mind-map/index.js', 'simple-mind-map/src', 'web/src'], { cwd: repo, encoding: 'utf8' }), groups: [] }
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  write('manifest-start.json', report)
  let h
  try {
    h = await createHarness({ entry: path.join(__dirname, 'frontend-browser-entry.js'),
      handleRequest: createMemoryTransport(), sourceRoot: config.sourceRoot, viewport: config.viewport })
    Object.assign(report, { browser: h.browser.version(), bundleHash: h.bundleHash, sourceRoot: h.sourceRoot })
    write('frozen-bundle.json', { browser: report.browser, node: report.node, bundleHash: h.bundleHash,
      sourceRoot: h.sourceRoot, sourceDiffAtBuild: report.sourceDiffAtBuild })
    for (const size of config.sizes) {
      const page = await h.newPage(), pageErrors = []
      page.on('pageerror', error => pageErrors.push(error.message))
      try {
        await page.waitForFunction(() => !!window.perfFrontend)
        const prepared = await setup(page, size, config.options)
        for (const operation of config.operations) {
          const rawFile = path.join(output, size + '-' + operation + '.jsonl'), rows = [], warmupRows = []
          fs.writeFileSync(rawFile, '', { flag: 'wx' })
          for (const [warmup, count] of [[true, config.warmups], [false, config.samples]]) {
            for (let chunk = 0; chunk < count; chunk += 20) {
              const offset = warmup ? chunk : config.warmups + chunk
              const next = await sampleChunk(page, operation, offset, Math.min(20, count - chunk), warmup, config.sampleTimeoutMs)
              ;(warmup ? warmupRows : rows).push(...next)
              fs.appendFileSync(rawFile, next.map(row => JSON.stringify(row)).join('\n') + '\n')
              console.log(JSON.stringify({ runId: config.runId, size, operation, warmup, completed: chunk + next.length, samples: count }))
            }
          }
          const final = await page.evaluate(() => window.__perfBench.diagnostics())
          assert.equal(final.loadedDataNodes, size, 'loaded cardinality drift'); assert.equal(final.countNodes, size, 'Count cardinality drift')
          assert.deepEqual(pageErrors, [], 'unexpected browser errors')
          const ms = rows.map(row => row.ms), group = { size, operation, setup: prepared, final,
            warmupRows, warmupsMs: warmupRows.map(row => row.ms), rows, rowsMs: ms,
            p50: percentile(ms, .5), p95: percentile(ms, .95), p99: percentile(ms, .99), pageErrors }
          report.groups.push(group); write(size + '-' + operation + '.json', group)
        }
      } finally {
        if (!page.isClosed()) {
          await page.evaluate(() => { const state = window.__perfBench; if (state) { state.restore(); state.f.unmount(state.count); state.mm.destroy() } }).catch(() => {})
          await page.close()
        }
      }
    }
    report.status = 'MEASURED'
  } catch (error) {
    report.status = 'INCOMPLETE'; report.error = error.stack || String(error); process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString(); write('manifest-final.json', report)
    console.log('FRONTEND_PERFORMANCE_REPORT ' + path.join(output, 'manifest-final.json'))
    if (h) await h.close()
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { configFromEnv, compareNativeEdit, setup, sampleChunk }
