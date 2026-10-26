// P3 correctness: partial layout (flag on) vs full layout (flag off) on identical op sequences.
// node tests/performance/p3-partial-layout.correctness.browser.cjs [--seeds=6]
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')
const { ENTRY_COMMON } = require('./p3-common.cjs')
const arg = name => (process.argv.find(i => i.startsWith(`--${name}=`)) || '').split('=')[1]
const SEEDS = Number(arg('seeds') || 6)
const OUT = path.join(repo, 'output', 'p3-partial-layout')

const entry = ENTRY_COMMON + `
function snapshot(mm) {
  const nodes = {}
  ;(mm.renderer.nodeIndex || new Map()).forEach((n, uid) => {
    if (n.isGeneralization) uid = 'gen-of-' + (n.generalizationBelongNode ? n.generalizationBelongNode.uid : '?')
    const lines = (n._lines || []).map(l => { try { return l.attr('d') } catch (e) { return null } })
    nodes[uid] = { l: n.left, t: n.top, w: n.width, h: n.height, e: n.getData('expand') !== false, s: n.sortIndex, lines: lines.join('|'), p: n.parent ? n.parent.uid : null }
  })
  let box = null
  try { const r = mm.getSvgData ? mm.getSvgData() : null; if (r && r.rect) box = { w: Math.round(r.rect.width * 100) / 100, h: Math.round(r.rect.height * 100) / 100 } } catch (e) { box = 'err:' + e.message }
  return { nodes, box }
}
function diff(a, b) {
  const bad = []
  const keys = new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])
  keys.forEach(k => {
    const x = a.nodes[k], y = b.nodes[k]
    if (!x || !y) { bad.push(k + ':missing'); return }
    for (const f of ['l', 't', 'w', 'h']) if (Math.abs(x[f] - y[f]) > 1e-6) { bad.push(k + ':' + f + ' ' + x[f] + '!=' + y[f]); return }
    if (x.e !== y.e) bad.push(k + ':expand')
    else if (x.p !== y.p) bad.push(k + ':parent')
    else if (x.s !== y.s) bad.push(k + ':sortIndex')
    else if (x.lines !== y.lines) bad.push(k + ':lines')
  })
  if (JSON.stringify(a.box) !== JSON.stringify(b.box)) bad.push('exportBox ' + JSON.stringify(a.box) + '!=' + JSON.stringify(b.box))
  return bad
}
// op(mm, ctx) applied identically to both maps; uses uids only
const OPS = {
  textGrow: (mm, c) => { const n = byUid(mm, c.uid); return n && mm.execCommand('SET_NODE_TEXT', n, '变长的文本内容用于触发尺寸变化与换行测量 ' + c.k + ' ' + c.k) },
  textSame: (mm, c) => { const n = byUid(mm, c.uid); return n && mm.execCommand('SET_NODE_TEXT', n, n.getData('text')) },
  textShrink: (mm, c) => { const n = byUid(mm, c.uid); return n && mm.execCommand('SET_NODE_TEXT', n, 'x' + c.k) },
  insertChild: (mm, c) => { const n = byUid(mm, c.uid); return n && mm.execCommand('INSERT_CHILD_NODE', false, [n], { text: 'ins ' + c.k, uid: 'ic' + c.k }) },
  insertSibling: (mm, c) => { const n = byUid(mm, c.uid); return n && !n.isRoot && mm.execCommand('INSERT_NODE', false, [n], { text: 'sib ' + c.k, uid: 'is' + c.k }) },
  remove: (mm, c) => { const n = byUid(mm, c.uid); return n && !n.isRoot && mm.execCommand('REMOVE_NODE', [n]) },
  up: (mm, c) => { const n = byUid(mm, c.uid); return n && !n.isRoot && mm.execCommand('UP_NODE', n) },
  down: (mm, c) => { const n = byUid(mm, c.uid); return n && !n.isRoot && mm.execCommand('DOWN_NODE', n) },
  moveTo: (mm, c) => { const n = byUid(mm, c.uid), t = byUid(mm, c.uid2); return n && t && !n.isRoot && mm.execCommand('MOVE_NODE_TO', n, t) },
  toggle: (mm, c) => { const n = byUid(mm, c.uid); return n && (n.nodeData.children || []).length && mm.renderer.setNodeExpand(n, n.getData('expand') === false) },
  remote: (mm, c) => { const n = byUid(mm, c.uid); if (!n) return; n.nodeData.data.text = '远端修改 ' + c.k + (c.k % 2 ? ' 更长一些的文本' : ''); mm.renderer.requestRemoteRender(n.getData('uid')) },
  remoteMulti: (mm, c) => { const uids = c.uids.filter(u => byUid(mm, u)); uids.forEach(u => { byUid(mm, u).nodeData.data.text = 'multi ' + c.k + u }); mm.renderer.requestRemoteRender(uids) },
  lazyLoad: (mm, c) => { const n = byUid(mm, c.uid); if (!n) return; n.nodeData.children = (n.nodeData.children || []).concat([0, 1, 2].map(i => ({ data: { uid: 'lz' + c.k + '_' + i, text: 'lazy ' + i, expand: true }, children: [] }))); mm.renderer.requestRemoteRender([n.getData('uid')]) },
  undo: mm => mm.execCommand('BACK'),
  redo: mm => mm.execCommand('FORWARD'),
  generalization: (mm, c) => { const n = byUid(mm, c.uid); if (!n || n.isRoot) return; mm.execCommand('ADD_GENERALIZATION', { text: '概要' }, false, [n]) }
}
async function apply(maps, name, ctx) {
  for (const mm of maps) { await waitRender(mm, () => OPS[name](mm, ctx)); await settle(mm) }
}
function pickUids(mm, r, filter) {
  const list = Array.from(mm.renderer.nodeIndex.values()).filter(filter || (() => true))
  return list.length ? list[Math.floor(r() * list.length)].getData('uid') : null
}
async function runSequence(label, data, steps, flagsBase, extra) {
  const flagsOn = { ...flagsBase, partialLayoutLogicalStructure: true }
  const flagsShadow = { ...flagsOn, partialLayoutShadowValidate: true }
  const full = await create(data, flagsBase, extra)
  const part = await create(data, flagsOn, extra)
  const shadow = await create(data, flagsShadow, extra)
  const maps = [full, part, shadow]
  const failures = []
  let k = 0
  for (const step of steps) {
    const ctx = typeof step.ctx === 'function' ? step.ctx(full) : step.ctx || {}
    ctx.k = k++
    const before = plStats(part)
    await apply(maps, step.op, ctx)
    const after = plStats(part)
    const ref = snapshot(full)
    const d1 = diff(ref, snapshot(part)), d2 = diff(ref, snapshot(shadow))
    const mode = after.partial > before.partial ? 'partial' : after.full > before.full ? 'full:' + (after.last && after.last.reason) : 'none'
    if (d1.length || d2.length) failures.push({ step: ctx.k, op: step.op, mode, partial: d1.slice(0, 5), shadow: d2.slice(0, 5) })
    if (step.expect && !String(mode).startsWith(step.expect)) failures.push({ step: ctx.k, op: step.op, expectMode: step.expect, mode })
  }
  const res = { label, steps: steps.length, nodes: full.renderer.nodeIndex.size, stats: plStats(part), shadowStats: plStats(shadow), failures, errors: (window.__errs || []).splice(0) }
  destroyAll(maps)
  return res
}
window.runRandom = async (seed, n, flagsBase) => {
  const r = rng(seed)
  const data = makeRandomTree(n, r)
  const names = ['textGrow', 'textSame', 'textShrink', 'insertChild', 'insertSibling', 'remove', 'up', 'down', 'moveTo', 'toggle', 'remote', 'remoteMulti', 'lazyLoad']
  const steps = []
  for (let i = 0; i < 30; i++) {
    const op = names[Math.floor(r() * names.length)]
    const s1 = Math.floor(r() * 1e9), s2 = Math.floor(r() * 1e9)
    steps.push({ op, ctx: mm => {
      const rr = rng(s1 + s2)
      const uid = pickUids(mm, rr, op === 'remove' || op === 'up' || op === 'down' || op === 'moveTo' || op === 'insertSibling' ? n => !n.isRoot : null)
      const uid2 = pickUids(mm, rr, x => x.getData('uid') !== uid && !(function anc(a) { while (a) { if (a.getData('uid') === uid) return true; a = a.parent } return false })(x))
      return { uid, uid2, uids: [uid, uid2, pickUids(mm, rr)] }
    } })
  }
  return runSequence('random seed=' + seed + ' n=' + n, data, steps, flagsBase)
}
window.runEdges = async flagsBase => {
  const out = []
  const tree = makeExpandedTree(300)
  out.push(await runSequence('root changes', tree, [
    { op: 'textGrow', ctx: { uid: 'n0' }, expect: 'partial' }, { op: 'textShrink', ctx: { uid: 'n0' }, expect: 'partial' },
    { op: 'insertChild', ctx: { uid: 'n0' }, expect: 'partial' }], flagsBase))
  out.push(await runSequence('first/last child', tree, [
    { op: 'textGrow', ctx: { uid: 'n1' }, expect: 'partial' }, { op: 'textGrow', ctx: { uid: 'n12' }, expect: 'partial' },
    { op: 'up', ctx: { uid: 'n2' }, expect: 'partial' }, { op: 'down', ctx: { uid: 'n11' }, expect: 'partial' },
    { op: 'remove', ctx: { uid: 'n1' }, expect: 'partial' }, { op: 'remove', ctx: { uid: 'n12' }, expect: 'partial' }], flagsBase))
  out.push(await runSequence('deep chain 400', makeChain(400), [
    { op: 'textGrow', ctx: { uid: 'n399' } }, { op: 'insertChild', ctx: { uid: 'n200' }, expect: 'partial' },
    { op: 'toggle', ctx: { uid: 'n100' } }, { op: 'toggle', ctx: { uid: 'n100' } }, { op: 'moveTo', ctx: { uid: 'n350', uid2: 'n1' } }], flagsBase))
  out.push(await runSequence('collapsed ancestors', tree, [
    { op: 'toggle', ctx: { uid: 'n1' } }, { op: 'textGrow', ctx: { uid: 'n2' }, expect: 'partial' },
    { op: 'remote', ctx: { uid: 'n3' }, expect: 'partial' }, { op: 'toggle', ctx: { uid: 'n1' } }, { op: 'textGrow', ctx: { uid: 'n13' } }], flagsBase))
  out.push(await runSequence('lazy branch', tree, [
    { op: 'lazyLoad', ctx: { uid: 'n5' }, expect: 'partial' }, { op: 'lazyLoad', ctx: { uid: 'n40' }, expect: 'partial' }], flagsBase))
  out.push(await runSequence('generalization -> fallback', tree, [
    { op: 'generalization', ctx: { uid: 'n3' }, expect: 'full' }, { op: 'textGrow', ctx: { uid: 'n4' }, expect: 'full:special_dependency' }], flagsBase))
  out.push(await runSequence('multiple dirty', tree, [
    { op: 'remoteMulti', ctx: { uids: ['n1', 'n50', 'n120', 'n299'] }, expect: 'partial' }], flagsBase))
  out.push(await runSequence('undo/redo', tree, [
    { op: 'insertChild', ctx: { uid: 'n7' }, expect: 'partial' }, { op: 'textGrow', ctx: { uid: 'n8' } },
    { op: 'undo', ctx: {}, expect: 'full' }, { op: 'undo', ctx: {} }, { op: 'redo', ctx: {} }, { op: 'textGrow', ctx: { uid: 'n9' }, expect: 'partial' }], flagsBase))
  out.push(await runSequence('compactLayout=true degrade 300', tree, [
    { op: 'textGrow', ctx: { uid: 'n2' } }, { op: 'toggle', ctx: { uid: 'n1' } }, { op: 'textGrow', ctx: { uid: 'n3' } },
    { op: 'toggle', ctx: { uid: 'n1' } }, { op: 'insertChild', ctx: { uid: 'n4' } }, { op: 'textGrow', ctx: { uid: 'n5' } }], flagsBase, { compactLayout: true }))
  return out
}
window.ready = true
`
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { kind: 'isolated-browser', startedAt: new Date().toISOString(), browser: harness.browser.version(), runs: [], pageErrors: harness.errors }
  const P1AB = { canvasTextMeasure: true, scopedRemoteLineRender: true, scopedRemoteGeometry: true, deferDraftCopy: true, analyticEdgeBounds: false, lazyOffscreenPaint: false }
  try {
    for (const [fname, flags] of [['p1p2-off', {}], ['p1p2-on', P1AB]]) {
      const page = await harness.newPage(); page.setDefaultTimeout(900000)
      await page.waitForFunction(() => window.ready)
      const edges = await page.evaluate(f => window.runEdges(f), flags)
      edges.forEach(e => report.runs.push({ flags: fname, ...e }))
      for (let s = 1; s <= SEEDS; s++) {
        const r = await page.evaluate(({ s, f }) => window.runRandom(s, s % 2 ? 150 : 600, f), { s, f: flags })
        report.runs.push({ flags: fname, ...r })
      }
      await page.close()
    }
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(OUT, 'correctness.json'), JSON.stringify(report, null, 2))
    await harness.close()
  }
  let fail = 0
  report.runs.forEach(r => {
    fail += r.failures.length
    console.log(`${r.failures.length ? 'FAIL' : 'ok  '} [${r.flags}] ${r.label} nodes=${r.nodes} partial=${r.stats.partial} full=${r.stats.full} fb=${JSON.stringify(r.stats.fallback)} shadow=${r.shadowStats.shadowChecks}/${r.shadowStats.shadowMismatch}` + (r.shadowStats.lastMismatch ? ' mm=' + JSON.stringify(r.shadowStats.lastMismatch).slice(0, 200) : '') + (r.failures.length ? ' ' + JSON.stringify(r.failures.slice(0, 3)) : '') + (r.errors.length ? ' errs=' + r.errors.slice(0, 2) : ''))
  })
  if (report.pageErrors.length) console.log('pageErrors', report.pageErrors.slice(0, 5))
  process.exit(fail || report.pageErrors.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
