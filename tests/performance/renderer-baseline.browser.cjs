const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

;(async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const sourceRoot = process.env.PERF_TDD_SOURCE_ROOT || repo
  if (!path.isAbsolute(sourceRoot)) throw new Error('Source root must be absolute')
  const destination = path.join(repo, 'work/performance-tdd', phase, 'renderer')
  fs.mkdirSync(destination, { recursive: true })
  const reportPath = path.join(destination, 'performance.json')
  if (fs.existsSync(reportPath)) throw new Error('REFUSE_OVERWRITE: preserve previous renderer raw samples')
  const harness = await createHarness({ entry: path.join(__dirname, 'renderer-browser-entry.js'), sourceRoot })
  const report = { phase, browser: harness.browser.version(), runtime: process.version,
    sourceRoot: harness.sourceRoot, bundleHash: harness.bundleHash,
    protocol: 'actual-engine-native-render-end-v1',
    viewport: { width: 1280, height: 900 }, samplesPerGroup: 200,
    percentile: 'sorted[floor(length * 0.95)]', groups: [], startedAt: new Date().toISOString() }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' })
  try {
    for (const n of [1000, 5000, 10000]) {
      const page = await harness.newPage()
      const group = await page.evaluate(async n => {
        const f = rendererFixture, data = f.sparseViewportTree(n)
        const fixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))))
          .map(value => value.toString(16).padStart(2, '0')).join('')
        const mm = await f.create(data)
        let loadedNodes = 0, pending = [mm.renderer.renderTree]
        while (pending.length) { const node = pending.pop(); loadedNodes++; pending.push(...(node.children || [])) }
        const actual = { cacheModels: Object.keys(mm.renderer.nodeCache).length,
          loadedNodes, layout: mm.opt.layout, compactLayout: mm.opt.compactLayout,
          openPerformance: mm.opt.openPerformance, width: mm.width, height: mm.height,
          viewThrottleMs: mm.opt.performanceConfig.time,
          predicateCandidates: Object.values(mm.renderer.nodeCache).filter(node => node.isRoot || node.checkIsInClient(mm.opt.performanceConfig.padding)).length }
        for (let i = 0; i < 10; i++) await f.waitRender(mm, () => mm.view.translateXY(i % 2 ? -1 : 1, 0))
        const samples = [], c = f.counters()
        for (let i = 0; i < 200; i++) {
          const start = performance.now()
          await f.waitRender(mm, () => mm.view.translateXY(i % 2 ? -1 : 1, 0))
          samples.push(performance.now() - start)
        }
        const counters = { renders: c.values.renders, lines: c.values.lines }
        c.restore(); mm.destroy()
        return { operation: 'pan-to-render-end', n, fixtureHash, warmups: 10, actual, samples, counters }
      }, n)
      report.groups.push(group)
      await page.close()
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ phase, operation: group.operation, n, samples: group.samples.length }))
    }
    for (const layout of ['logicalStructure', 'mindMap']) {
      const page = await harness.newPage()
      const group = await page.evaluate(async layout => {
        const f = rendererFixture, data = f.wideLayered(80)
        const fixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))))
          .map(value => value.toString(16).padStart(2, '0')).join('')
        const mm = await f.create(data, { layout, compactLayout: false, openPerformance: false })
        const actual = { cacheModels: Object.keys(mm.renderer.nodeCache).length,
          layout: mm.opt.layout, compactLayout: mm.opt.compactLayout,
          openPerformance: mm.opt.openPerformance, width: mm.width, height: mm.height }
        const samples = [], c = f.counters()
        for (let i = 0; i < 200; i++) {
          const start = performance.now()
          await f.waitRender(mm, () => mm.render())
          samples.push(performance.now() - start)
        }
        const writes = c.values.writes
        c.restore(); mm.destroy()
        return { operation: 'wide-layout-to-render-end', layout, n: 241, fixtureHash, warmups: 0, actual, samples, writes }
      }, layout)
      report.groups.push(group); await page.close()
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ phase, operation: group.operation, layout, samples: group.samples.length }))
    }
    if (phase === 'red') {
      const page = await harness.newPage()
      const golden = await page.evaluate(async () => {
        const f = rendererFixture, rows = []
        for (const layout of ['logicalStructure', 'logicalStructureLeft', 'mindMap']) {
          for (const compactLayout of [false, true]) {
            const data = f.wideLayered(4)
            data.children[1].data.customLeft = 880; data.children[1].data.customTop = 180
            const mm = await f.create(data, { layout, compactLayout, openPerformance: false })
            rows.push({ layout, compactLayout, coords: f.coordinates(mm) }); mm.destroy()
          }
        }
        return rows
      })
      fs.writeFileSync(path.join(repo, 'tests/performance/layout-golden.json'), JSON.stringify(golden, null, 2))
      await page.close()
    }
    if (harness.errors.length) throw new Error('Browser page errors: ' + harness.errors.join('; '))
    report.status = 'SAMPLED'
  } catch (error) {
    report.status = 'INCOMPLETE'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    report.pageErrors = harness.errors.slice()
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await harness.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
