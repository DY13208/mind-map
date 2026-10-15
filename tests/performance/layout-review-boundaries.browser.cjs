'use strict'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHarness } = require('./engine-harness.cjs')
const repo = path.resolve(__dirname, '../..')
const evaluate = async page => page.evaluate(async () => {
  const f = rendererFixture, rows = []
  const round = value => Math.round(value * 1000) / 1000
  for (const layout of ['logicalStructure', 'mindMap']) for (const openPerformance of [false, true]) {
    for (const position of ['none', 'left', 'top', 'both', 'floating']) {
      const node = (uid, children = [], extras = {}) => ({ data: { uid, text: uid, expand: true, fontFamily: 'Arial', ...extras }, children })
      const anchor = position === 'both' || position === 'floating' ? { customLeft: 550, customTop: 700 }
        : position === 'left' ? { customLeft: 550 } : position === 'top' ? { customTop: 700 } : {}
      const c = node('c', [node('d'), node('d2'), node('d3')], anchor)
      const b = node('b', [c, node('c2', [node('c2kid')])], { dir: 'right',
        ...(position === 'floating' ? { isFloating: true, customLeft: 800, customTop: 900 } : {}) })
      const tree = node('root', [node('a', Array.from({ length: 6 }, (_, i) => node('a' + i, [node('a' + i + 'kid')])), { dir: 'right' }), b,
        node('e', [node('ekid')], { dir: 'left' })])
      const mm = await f.create(tree, { layout, openPerformance, compactLayout: false })
      const initial = f.coordinates(mm), current = mm.renderer.findNodeByUid('c')
      const rawTop = round(current._top), custom = current.customTop
      current.customTop = undefined
      const fallback = round(current.top)
      current.customTop = custom
      mm.execCommand('SET_NODE_CUSTOM_POSITION', current, undefined, undefined)
      await f.waitRender(mm, () => mm.render())
      const cleared = f.coordinates(mm)
      rows.push({ layout, openPerformance, position, initial, cleared, rawTop, fallback })
      mm.destroy()
    }
  }
  return rows
})
async function main() {
  const report = { scope: 'real original and current production layout: nested custom position, directional and floating boundaries; full model geometry and actual public SET_NODE_CUSTOM_POSITION clear plus render', startedAt: new Date().toISOString(), sources: {} }
  const out = path.join(repo, 'work/performance-tdd/green/frontend/layout-review-boundaries.json')
  try {
    for (const [name, sourceRoot] of [['original', path.join(repo, 'work/performance-tdd/baseline-source')], ['current', repo]]) {
      const h = await createHarness({ entry: path.join(__dirname, 'renderer-browser-entry.js'), sourceRoot })
      try { await h.page.waitForFunction(() => !!window.rendererFixture); report.sources[name] = { sourceRoot, browser: h.browser.version(), bundleHash: h.bundleHash, rows: await evaluate(h.page) } }
      finally { await h.close() }
    }
    const before = report.sources.original.rows, after = report.sources.current.rows
    for (let i = 0; i < before.length; i++) {
      const id = [before[i].layout, before[i].openPerformance, before[i].position].join(':')
      assert.deepEqual(after[i].initial, before[i].initial, id + ' initial visible geometry')
      assert.deepEqual(after[i].cleared, before[i].cleared, id + ' public position-clear geometry')
    }
    report.hiddenTopDifferences = after.map((row, i) => row.rawTop === before[i].rawTop ? null : { layout: row.layout, openPerformance: row.openPerformance, position: row.position, original: before[i].rawTop, current: row.rawTop }).filter(Boolean)
    report.status = 'PROTECTION_PASS'
    console.log(JSON.stringify({ status: report.status, cases: before.length, hiddenTopDifferences: report.hiddenTopDifferences }))
  } catch (error) { report.status = error instanceof assert.AssertionError ? 'BEHAVIOR_DIFFERENCE' : 'BLOCKED_ENV'; report.error = error.stack; process.exitCode = 1; console.error(error) }
  finally { report.finishedAt = new Date().toISOString(); fs.writeFileSync(out, JSON.stringify(report, null, 2)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
