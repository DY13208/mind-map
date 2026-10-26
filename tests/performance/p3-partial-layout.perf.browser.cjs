// P3 perf: P1/P2 on + P3 off vs P1/P2 on + P3 on, isolated synthetic trees.
// node tests/performance/p3-partial-layout.perf.browser.cjs [--sizes=1000,3000,6000,10000] [--repeats=8]
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')
const { ENTRY_COMMON } = require('./p3-common.cjs')
const arg = name => (process.argv.find(i => i.startsWith(`--${name}=`)) || '').split('=')[1]
const SIZES = (arg('sizes') || '1000,3000,6000,10000').split(',').map(Number).filter(Boolean)
const REPEATS = Math.max(4, Number(arg('repeats') || 8))
const OUT = path.join(repo, 'output', 'p3-partial-layout')
const P1AB = { canvasTextMeasure: true, scopedRemoteLineRender: true, scopedRemoteGeometry: true, deferDraftCopy: true, analyticEdgeBounds: true, lazyOffscreenPaint: true }

const entry = ENTRY_COMMON + `
const pct = (list, p) => { const s = list.filter(Number.isFinite).slice().sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)].toFixed(2) : null }
const st = list => ({ p50: pct(list, 50), p95: pct(list, 95) })
const LONG = []
try { new PerformanceObserver(l => l.getEntries().forEach(e => LONG.push({ s: e.startTime, d: e.duration }))).observe({ type: 'longtask', buffered: true }) } catch (e) {}
const longTotal = (a, b) => LONG.filter(t => t.s >= a - 1 && t.s <= b).reduce((s, t) => s + t.d, 0)
const C = { layouts: 0, layoutMs: 0, passMs: 0 }
const od = LogicalStructure.prototype.doLayout
LogicalStructure.prototype.doLayout = function (cb) {
  C.layouts++
  const t = now()
  return od.call(this, root => { C.layoutMs += now() - t; return cb(root) })
}
for (const k of ['computedBaseValue', 'computedTopValue', 'adjustTopValue']) {
  const o = LogicalStructure.prototype[k]
  LogicalStructure.prototype[k] = function (...a) {
    const t = now(); const r = o.apply(this, a)
    if (r && r.then) return r.then(v => { C.passMs += now() - t; return v })
    C.passMs += now() - t; return r
  }
}
function geom(mm) { const m = new Map(); mm.renderer.nodeIndex.forEach((n, u) => m.set(u, n.left + ',' + n.top)); return m }
function movedCount(a, b) { let c = 0; b.forEach((v, k) => { if (a.get(k) !== v) c++ }); return c }
async function sample(mm, repeats, action) {
  const wall = [], layout = [], cpu = [], moved = [], plMs = []
  let partial = 0, full = 0, layouts = 0
  const reasons = {}
  for (let i = 0; i < repeats; i++) {
    const g0 = geom(mm)
    const s0 = plStats(mm)
    C.layouts = 0; C.layoutMs = 0; C.passMs = 0
    const t0 = now()
    await action(i)
    await settle(mm)
    const t1 = now()
    const s1 = plStats(mm)
    wall.push(t1 - t0); layout.push(C.layoutMs); cpu.push(longTotal(t0, t1)); moved.push(movedCount(g0, geom(mm)))
    layouts += C.layouts
    partial += s1.partial - s0.partial; full += s1.full - s0.full
    Object.keys(s1.fallback || {}).forEach(k => { const d = s1.fallback[k] - ((s0.fallback || {})[k] || 0); if (d) reasons[k] = (reasons[k] || 0) + d })
    if (s1.partial > s0.partial && s1.last && s1.last.elapsedMs != null) plMs.push(s1.last.elapsedMs)
  }
  const lays = partial + full
  return { wall: st(wall), layoutMs: st(layout), longTaskMs: st(cpu), moved: st(moved), layouts, partial, full,
    fallbackPct: lays ? +(100 * full / lays).toFixed(1) : null, reasons, partialCoreMs: st(plMs) }
}
function branchAt(mm, depth, k) {
  const list = Array.from(mm.renderer.nodeIndex.values()).filter(n => n.layerIndex === depth && (n.nodeData.children || []).length >= 2)
  return list[Math.min(list.length - 1, k)]
}
window.runPerf = async (n, flags, repeats) => {
  const mm = await create(makeExpandedTree(n), flags)
  const out = { n, p3: !!flags.partialLayoutLogicalStructure, nodes: mm.renderer.nodeIndex.size }
  const b = branchAt(mm, 2, 3), b2 = branchAt(mm, 2, 7)
  const bu = b.getData('uid'), b2u = b2.getData('uid')
  const mid = b.nodeData.children[1].data.uid
  const T0 = b.getData('text')
  out.textSame = await sample(mm, repeats, () => waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', byUid(mm, bu), T0)))
  out.textSize = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', byUid(mm, bu), i % 2 ? T0 : T0 + ' 变长文本触发换行与高度变化 变长文本触发换行与高度变化')))
  out.insert = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, [byUid(mm, bu)], { text: 'ins' + i, uid: 'ins-' + i })))
  out.remove = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand('REMOVE_NODE', [byUid(mm, 'ins-' + i)])))
  out.reorder = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand(i % 2 ? 'DOWN_NODE' : 'UP_NODE', byUid(mm, mid))))
  out.crossMove = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand('MOVE_NODE_TO', byUid(mm, mid), byUid(mm, i % 2 ? bu : b2u))))
  out.expandCollapse = await sample(mm, repeats, i => waitRender(mm, () => { const x = byUid(mm, bu); mm.renderer.setNodeExpand(x, x.getData('expand') === false) }))
  if (byUid(mm, bu).getData('expand') === false) { await waitRender(mm, () => mm.renderer.setNodeExpand(byUid(mm, bu), true)); await settle(mm) }
  out.remoteBurst = await sample(mm, Math.max(3, repeats >> 1), async i => {
    for (let k = 0; k < 20; k++) {
      const x = byUid(mm, bu); x.nodeData.data.text = (k % 2 ? '远端' : '远端修改的更长文本内容 ') + i + '-' + k
      mm.renderer.requestRemoteRender(bu)
      await sleep(16)
    }
  })
  await waitRender(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, [byUid(mm, bu)], { text: 'undo-me', uid: 'undo-me' })); await settle(mm)
  out.undoRedo = await sample(mm, repeats, i => waitRender(mm, () => mm.execCommand(i % 2 ? 'FORWARD' : 'BACK')))
  out.errors = (window.__errs || []).splice(0)
  destroyAll([mm])
  return out
}
window.ready = true
`
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { kind: 'isolated-browser', startedAt: new Date().toISOString(), browser: harness.browser.version(), node: process.version, repeats: REPEATS, sizes: SIZES, tree: 'fanout-8 fully expanded synthetic (root 12)', p1p2: P1AB, results: [], pageErrors: harness.errors }
  const save = () => fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(report, null, 2))
  try {
    for (const n of SIZES) {
      for (const p3 of [false, true]) {
        const page = await harness.newPage(); page.setDefaultTimeout(1800000)
        await page.waitForFunction(() => window.ready)
        const flags = { ...P1AB, partialLayoutLogicalStructure: p3 }
        const r = await page.evaluate(({ n, flags, repeats }) => window.runPerf(n, flags, repeats), { n, flags, repeats: REPEATS })
        report.results.push(r); save()
        const brief = ['textSame', 'textSize', 'insert', 'remove', 'reorder', 'crossMove', 'expandCollapse', 'remoteBurst', 'undoRedo'].map(k => `${k}:${r[k].wall.p50}/${r[k].wall.p95} L${r[k].layoutMs.p50} mv${r[k].moved.p50} fb${r[k].fallbackPct}`).join(' | ')
        console.log(`n=${n} p3=${p3} ${brief}`)
        await page.close()
      }
    }
  } finally { report.finishedAt = new Date().toISOString(); save(); await harness.close() }
}
main().catch(e => { console.error(e); process.exit(1) })
