// Read-only rendering architecture baseline. Uses the real simple-mind-map
// engine with synthetic data; it never touches rooms, servers or business data.
// Usage: node tests/performance/architecture-baseline.browser.cjs [--sizes=150,1000] [--skip=layouts,rich,memory,profile]
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')

const arg = name => (process.argv.find(item => item.startsWith(`--${name}=`)) || '').split('=')[1]
const SIZES = (arg('sizes') || '150,1000,3000,6000,10000').split(',').map(Number).filter(Boolean)
const SKIP = new Set((arg('skip') || '').split(',').filter(Boolean))

const entry = `
import MindMap from './simple-mind-map/index.js'
import MindMapNode from './simple-mind-map/src/core/render/node/MindMapNode.js'
import Base from './simple-mind-map/src/layouts/Base.js'
import Export from './simple-mind-map/src/plugins/Export.js'
import Select from './simple-mind-map/src/plugins/Select.js'
import Drag from './simple-mind-map/src/plugins/Drag.js'
import AssociativeLine from './simple-mind-map/src/plugins/AssociativeLine.js'
import RainbowLines from './simple-mind-map/src/plugins/RainbowLines.js'
import OuterFrame from './simple-mind-map/src/plugins/OuterFrame.js'
import MiniMap from './simple-mind-map/src/plugins/MiniMap.js'
import Search from './simple-mind-map/src/plugins/Search.js'
import KeyboardNavigation from './simple-mind-map/src/plugins/KeyboardNavigation.js'
import RichText from './simple-mind-map/src/plugins/RichText.js'
import Painter from './simple-mind-map/src/plugins/Painter.js'
MindMap.usePlugin(MiniMap).usePlugin(Drag).usePlugin(KeyboardNavigation).usePlugin(Export)
  .usePlugin(Select).usePlugin(AssociativeLine).usePlugin(Search).usePlugin(RainbowLines).usePlugin(OuterFrame)
window.enableRichText = () => MindMap.usePlugin(RichText)
window.enablePainter = () => MindMap.usePlugin(Painter)

const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (list, p) => { if (!list.length) return null; const s = list.slice().sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2) }
const stats = list => ({ n: list.length, p50: pct(list, 0.5), p95: pct(list, 0.95), max: list.length ? +Math.max(...list).toFixed(2) : null })

const LONG = []
try { new PerformanceObserver(l => l.getEntries().forEach(e => LONG.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: true }) } catch (e) {}
const longIn = (a, b) => { const hit = LONG.filter(t => t.start >= a - 1 && t.start <= b); return { count: hit.length, max: hit.length ? +Math.max(...hit.map(t => t.dur)).toFixed(1) : 0, total: +hit.reduce((s, t) => s + t.dur, 0).toFixed(1) } }

function text(i) {
  if (i % 7 === 0) return '这是一个较长的需求节点标题，用于覆盖自动换行与文本测量 #' + i
  if (i % 3 === 0) return '任务 ' + i + ' 评审与排期'
  return '节点 ' + i
}
function makeTree(n, features = true) {
  let id = 0
  const mk = () => {
    const i = id++
    const data = { uid: 'n' + i, text: text(i), expand: true }
    if (features && i) {
      if (i % 10 === 3) data.note = '备注内容 ' + i
      if (i % 20 === 5) { data.hyperlink = 'https://example.com/' + i; data.hyperlinkTitle = '链接' + i }
      if (i % 20 === 7) data.tag = ['标签A']
      if (i % 33 === 1) data.icon = ['priority_1']
      if (i % 25 === 9) { data.attachmentUrl = 'https://example.com/a' + i + '.pdf'; data.attachmentName = '附件' + i + '.pdf' }
      if (i % 30 === 11) data.comments = [{ id: 'c' + i, content: '评论', createdAt: 1 }]
    }
    return { data, children: [] }
  }
  const root = mk(); root.data.text = '根节点'
  const queue = [root]; let count = 1
  while (count < n) {
    const p = queue.shift()
    const fan = p === root ? 12 : 8
    for (let k = 0; k < fan && count < n; k++) { const c = mk(); p.children.push(c); queue.push(c); count++ }
  }
  const host = root.children[0]
  const branch = (uid, size) => ({ data: { uid, text: '折叠分支 ' + size, expand: false }, children:
    Array.from({ length: size }, (_, k) => ({ data: { uid: uid + '-' + k, text: '展开子节点 ' + k, expand: true }, children: [] })) })
  host.children.unshift(branch('exp60', 60), branch('exp400', 400))
  return root
}

const counters = { getSize: 0, render: 0, renderLine: 0, update: 0, createNode: 0, dataChange: 0, dataChangeMs: 0, bbox: 0, stringify: 0, renderStarted: 0 }
window.__counters = counters
const resetCounters = () => Object.keys(counters).forEach(k => { counters[k] = 0 })
const wrapProto = (proto, name, key, timeKey) => { const o = proto[name]; proto[name] = function (...a) { counters[key]++; if (!timeKey) return o.apply(this, a); const t = now(); try { return o.apply(this, a) } finally { counters[timeKey] += now() - t } } }
wrapProto(MindMapNode.prototype, 'getSize', 'getSize')
wrapProto(MindMapNode.prototype, 'render', 'render')
wrapProto(MindMapNode.prototype, 'renderLine', 'renderLine')
wrapProto(MindMapNode.prototype, 'update', 'update')
wrapProto(Base.prototype, 'createNode', 'createNode')
wrapProto(Base.prototype, 'checkIsNodeDataChange', 'dataChange', 'dataChangeMs')
const bb = SVGGraphicsElement.prototype.getBBox
SVGGraphicsElement.prototype.getBBox = function (...a) { counters.bbox++; return bb.apply(this, a) }
const js = JSON.stringify
JSON.stringify = function (...a) { counters.stringify++; return js.apply(this, a) }

function instrument(mm) {
  const r = mm.renderer
  const cur = { phases: [] }
  let p = null
  mm.on('render_started', () => { counters.renderStarted++; p = { start: now() } })
  const plt = r.paintLayoutTree.bind(r)
  r.paintLayoutTree = (...a) => { if (p) p.layoutEnd = now(); return plt(...a) }
  const bvi = r.buildViewportIndex.bind(r)
  r.buildViewportIndex = (o = {}) => { const t = now(); if (p && o.async) p.paintEnd = t; const res = bvi(o); if (res && res.then) return res.then(v => { if (p && o.async) p.indexEnd = now(); return v }); return res }
  const pv = r.paintViewport.bind(r)
  cur.view = []
  r.paintViewport = (...a) => { const t = now(); const before = counters.render; return pv(...a).then(v => { const d = { ms: now() - t, renders: counters.render - before }; if (p && p.indexEnd && !p.viewEnd) p.viewEnd = now(); else cur.view.push(d); return v }) }
  mm.on('render_complete', () => { if (!p) return; p.end = now(); cur.phases.push({
    totalMs: p.end - p.start,
    layoutMs: p.layoutEnd ? p.layoutEnd - p.start : null,
    paintTreeMs: p.paintEnd && p.layoutEnd ? p.paintEnd - p.layoutEnd : null,
    indexMs: p.indexEnd && p.paintEnd ? p.indexEnd - p.paintEnd : null,
    viewportMs: p.viewEnd && p.indexEnd ? p.viewEnd - p.indexEnd : null }); p = null })
  return cur
}
const waitComplete = (mm, action, timeout = 120000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { mm.off('render_complete', done); reject(new Error('render timeout')) }, timeout)
  const done = () => { clearTimeout(t); mm.off('render_complete', done); resolve() }
  mm.on('render_complete', done)
  action()
})
async function settle(mm) { for (let i = 0; i < 200 && (mm.renderer.isRendering || mm.renderer.renderTimer); i++) await sleep(20); await sleep(80) }
const dom = mm => ({
  svgElements: mm.svg.node.querySelectorAll('*').length,
  nodeGroupsAttached: mm.nodeDraw.node.querySelectorAll(':scope > g.smm-node').length,
  pathsAttached: mm.lineDraw.node.querySelectorAll('path').length,
  modelNodes: mm.renderer.nodeIndex ? mm.renderer.nodeIndex.size : Object.keys(mm.renderer.nodeCache).length,
  lruSize: mm.renderer.layout.lru && mm.renderer.layout.lru.size,
  totalDomElements: document.querySelectorAll('*').length
})
let host = null
async function create(data, options = {}) {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host)
  resetCounters()
  const t0 = now()
  const mm = new MindMap({ el: host, data, layout: 'logicalStructure', fit: false, openPerformance: true,
    openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, createNewNodeBehavior: 'NOT_ACTIVE',
    isShowExpandNum: true, ...options })
  const cur = instrument(mm)
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('init timeout')), 300000); mm.on('render_complete', function f() { clearTimeout(t); mm.off('render_complete', f); resolve() }) })
  const t1 = now()
  return { mm, cur, initMs: t1 - t0, initLong: longIn(t0, t1), initCounters: { ...counters } }
}
const plain = n => !n.isRoot && !n.isGeneralization && n.parent && !String(n.getData('uid')).startsWith('exp')
const isLeaf = n => !(n.nodeData.children || []).length
const visibleLeaves = mm => {
  const visible = Array.from(mm.renderer._visibleViewportNodes || []).filter(plain)
  const leaves = visible.filter(n => !n.parent.isRoot && isLeaf(n))
  if (leaves.length >= 10) return leaves
  if (visible.filter(n => !n.parent.isRoot).length >= 10) return visible.filter(n => !n.parent.isRoot)
  return Array.from(mm.renderer.nodeIndex.values()).filter(n => plain(n) && isLeaf(n)).slice(0, 60)
}

async function sample(mm, cur, label, count, act) {
  console.log('[step] ' + label)
  const out = []
  for (let i = 0; i < count; i++) {
    resetCounters(); cur.phases.length = 0
    const t0 = now()
    await act(i)
    await settle(mm)
    const t1 = now()
    out.push({ wallMs: t1 - t0, phase: cur.phases[cur.phases.length - 1] || null, fullRenders: counters.renderStarted, c: { ...counters }, long: longIn(t0, t1) })
  }
  const pick = f => out.map(f).filter(v => typeof v === 'number')
  return { label, n: out.length, wall: stats(pick(o => o.wallMs)), total: stats(pick(o => o.phase && o.phase.totalMs)),
    layout: stats(pick(o => o.phase && o.phase.layoutMs)), paintTree: stats(pick(o => o.phase && o.phase.paintTreeMs)),
    index: stats(pick(o => o.phase && o.phase.indexMs)), viewport: stats(pick(o => o.phase && o.phase.viewportMs)),
    fullRendersPerOp: stats(pick(o => o.fullRenders)), longMax: stats(pick(o => o.long.max)),
    countersLast: out[out.length - 1].c }
}

async function frameRun(mm, cur, steps, stepFn) {
  const deltas = []; cur.view.length = 0; resetCounters()
  const t0 = now(); let last = t0
  await new Promise(resolve => { let i = 0; const tick = () => { const t = now(); if (i) deltas.push(t - last); last = t; if (i++ >= steps) return resolve(); stepFn(i); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
  await sleep(600)
  const t1 = now()
  return { frames: stats(deltas), framesOver50ms: deltas.filter(d => d > 50).length, framesOver100ms: deltas.filter(d => d > 100).length,
    viewPaints: cur.view.length, viewPaintMs: stats(cur.view.map(v => v.ms)), nodeRendersPerViewPaint: stats(cur.view.map(v => v.renders)),
    bboxCalls: counters.bbox, long: longIn(t0, t1) }
}

window.runSize = async (n) => {
  const res = { n }
  const { mm, cur, initMs, initLong, initCounters } = await create(makeTree(n))
  window.mm = mm
  res.init = { ms: +initMs.toFixed(1), long: initLong, counters: initCounters, phase: cur.phases[0] }
  await settle(mm)
  res.domAfterInit = dom(mm)
  res.visibleInViewport = (mm.renderer._visibleViewportNodes || new Set()).size
  res.idleRender = await sample(mm, cur, 'mm.render() 无数据变化', 5, () => waitComplete(mm, () => mm.render()))
  const leaves = visibleLeaves(mm)
  res.editText = await sample(mm, cur, 'SET_NODE_TEXT 可见叶子', 5, i => waitComplete(mm, () => mm.execCommand('SET_NODE_TEXT', leaves[i % leaves.length], '修改后的文本 ' + i + ' 稍长一些')))
  res.editTextSameSize = await sample(mm, cur, 'SET_NODE_DATA 非尺寸字段 + render()', 5, i => waitComplete(mm, () => { mm.execCommand('SET_NODE_DATA', leaves[(i + 5) % leaves.length], { customBizField: 'v' + i }); mm.render() }))
  res.insertChild = await sample(mm, cur, 'INSERT_CHILD_NODE', 5, i => waitComplete(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, [leaves[(i + 9) % leaves.length]], { text: '新子节点' + i })))
  res.removeNode = await sample(mm, cur, 'REMOVE_NODE', 5, () => { const t = visibleLeaves(mm).find(x => x.getData('text').startsWith('新子节点')) || visibleLeaves(mm)[0]; return waitComplete(mm, () => mm.execCommand('REMOVE_NODE', [t])) })
  const find = uid => mm.renderer.findNodeByUid(uid)
  res.expand60 = await sample(mm, cur, '展开 60 子节点分支', 3, () => waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp60'), true)).then(() => settle(mm)).then(() => waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp60'), false))))
  res.expand400 = await sample(mm, cur, '展开 400 子节点分支', 2, () => waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp400'), true)))
  res.domAfterExpand400 = dom(mm)
  res.collapse400 = await sample(mm, cur, '收起 400 子节点分支', 2, i => i ? waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp400'), true)).then(() => waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp400'), false))) : waitComplete(mm, () => mm.renderer.setNodeExpand(find('exp400'), false)))
  // Remote text update emulation: same functions Cooperate.applyHttpRemoteNodeFields calls.
  const remoteOnce = node => { const t = now(); node.nodeData.data.text = '远端改字 ' + Math.random().toString(36).slice(2, 6); node.reRender(['text']); (node.parent || node).renderLine(true); const sync = now() - t; mm.renderer.requestRemoteRender(node.getData('uid')); return sync }
  console.log('[step] remote emulation')
  const syncLeaf = [], syncRootChild = []
  for (let i = 0; i < 5; i++) { syncLeaf.push(remoteOnce(visibleLeaves(mm)[i])); await settle(mm) }
  resetCounters()
  for (let i = 0; i < 5; i++) { syncRootChild.push(remoteOnce(mm.renderer.root.children[1 + i])); await settle(mm) }
  res.remoteUpdateSync = { leafParentRenderLineDeep: stats(syncLeaf), rootChildRenderLineDeep: stats(syncRootChild), renderLineCallsFor5RootChild: counters.renderLine }
  // MCP / remote burst: 40 updates, one every 15ms.
  resetCounters(); cur.phases.length = 0
  const bt0 = now(); const vl = visibleLeaves(mm)
  for (let i = 0; i < 40; i++) { remoteOnce(vl[i % vl.length]); await sleep(15) }
  await settle(mm); await sleep(300); const bt1 = now()
  res.remoteBurst40 = { wallMs: +(bt1 - bt0).toFixed(0), fullRenders: counters.renderStarted, renderMs: stats(cur.phases.map(p => p.totalMs)), long: longIn(bt0, bt1) }
  console.log('[step] pan/zoom')
  res.pan = await frameRun(mm, cur, 90, i => mm.view.translateXY(i % 30 < 15 ? -25 : 25, 6))
  await settle(mm)
  res.zoomOut = await frameRun(mm, cur, 60, i => mm.view.setScale(Math.max(0.15, 1 - i * 0.014)))
  await settle(mm); await sleep(400)
  res.domAtScale015 = dom(mm)
  res.zoomIn = await frameRun(mm, cur, 60, i => mm.view.setScale(Math.min(1, 0.15 + i * 0.014)))
  await settle(mm); await sleep(400)
  res.domAtScale1 = dom(mm)
  mm.destroy(); host.remove(); host = null
  return res
}

window.runLayout = async (n, layout, compactLayout = false) => {
  const { mm, cur, initMs, initLong } = await create(makeTree(n), { layout, compactLayout })
  await settle(mm)
  const idle = await sample(mm, cur, 'idle', 3, () => waitComplete(mm, () => mm.render()))
  const d = dom(mm)
  mm.destroy(); host.remove(); host = null
  return { n, layout, compactLayout, initMs: +initMs.toFixed(0), initLongMax: initLong.max, idle, modelNodes: d.modelNodes }
}

window.runRich = async n => {
  const data = makeTree(n, false)
  const walk = node => { node.data.text = '<p>' + node.data.text + '</p>'; node.data.richText = true; node.children.forEach(walk) }
  walk(data)
  const { mm, cur, initMs, initLong, initCounters } = await create(data, { openNodeRichText: true })
  await settle(mm)
  const idle = await sample(mm, cur, 'idle', 3, () => waitComplete(mm, () => mm.render()))
  const leaves = visibleLeaves(mm)
  const edit = await sample(mm, cur, 'edit', 3, i => waitComplete(mm, () => mm.execCommand('SET_NODE_TEXT', leaves[i], '<p>富文本修改 ' + i + '</p>', true)))
  const d = dom(mm)
  mm.destroy(); host.remove(); host = null
  return { n, initMs: +initMs.toFixed(0), initLong, initCounters, idle, edit, dom: d }
}

window.lifecycleOnce = async n => { const { mm } = await create(makeTree(n)); await settle(mm); mm.destroy(); host.remove(); host = null }
window.cycleExpand = async n => {
  const { mm } = await create(makeTree(n)); await settle(mm); window.mm = mm
  for (let i = 0; i < 10; i++) {
    await waitComplete(mm, () => mm.renderer.setNodeExpand(mm.renderer.findNodeByUid('exp400'), true)); await settle(mm)
    await waitComplete(mm, () => mm.renderer.setNodeExpand(mm.renderer.findNodeByUid('exp400'), false)); await settle(mm)
  }
  return dom(mm)
}
window.probeRemoteStyle = async n => {
  const { mm } = await create(makeTree(n)); await settle(mm)
  const out = { n, before: dom(mm) }
  const target = mm.renderer.root.children[1]
  const t = now()
  target.nodeData.data.fillColor = '#ffeeaa'
  target.reRender(['text']); (target.parent || target).renderLine(true)
  out.syncMs = now() - t
  await settle(mm); out.afterStyleOnly = dom(mm)
  mm.view.translateX(30); await new Promise(r => setTimeout(r, 400)); await settle(mm); out.afterPan = dom(mm)
  await waitComplete(mm, () => mm.render()); await settle(mm); out.afterFullRender = dom(mm)
  mm.destroy()
  return out
}
window.createForProfile = async n => { const { mm } = await create(makeTree(n)); await settle(mm); window.mm = mm; return true }
window.profileOps = async () => {
  const mm = window.mm
  for (let i = 0; i < 3; i++) { await waitComplete(mm, () => mm.render()); await settle(mm) }
  const leaves = visibleLeaves(mm)
  for (let i = 0; i < 3; i++) { await waitComplete(mm, () => mm.execCommand('SET_NODE_TEXT', leaves[i], 'profile ' + i)); await settle(mm) }
}
window.ready = true
`

async function main() {
  const outDir = path.join(repo, 'output', 'rendering-architecture-baseline')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry, launch: { args: ['--enable-precise-memory-info'] } })
  const report = {
    startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    browser: harness.browser.version(), node: process.version, sizes: SIZES, sizesResult: [], layouts: [], rich: [], memory: null, profile: null
  }
  const save = () => fs.writeFileSync(path.join(outDir, arg('out') || 'baseline.json'), JSON.stringify(report, null, 2))
  const topSelf = (profile, limit = 45) => {
    const byId = new Map(profile.nodes.map(n => [n.id, n]))
    const self = new Map()
    profile.samples.forEach((id, i) => { const f = byId.get(id).callFrame; const key = (f.functionName || '(anonymous)') + ' @' + (f.url ? f.url.split('/').pop() : '') + ':' + (f.lineNumber + 1); self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0)) })
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    return { totalMs: Math.round(total / 1000), topSelf: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => ({ fn: k, ms: Math.round(v / 1000), pct: +(v / total * 100).toFixed(1) })) }
  }
  const fresh = async () => { const page = await harness.newPage(); page.setDefaultTimeout(900000); page.on('console', m => { if (m.text().startsWith('[step]')) console.log('  ' + m.text()) }); await page.waitForFunction(() => window.ready); return page }
  try {
    for (const n of SIZES) {
      const page = await fresh()
      const t = Date.now()
      const r = await page.evaluate(n => window.runSize(n), n)
      report.sizesResult.push(r); save()
      console.log(JSON.stringify({ n, init: r.init.ms, idle: r.idleRender.total.p50, edit: r.editText.total.p50, expand60: r.expand60.wall.p50, pan: r.pan.frames, sec: (Date.now() - t) / 1000 }))
      await page.close()
    }
    if (!SKIP.has('layouts')) {
      for (const [n, layout, compact] of [[3000, 'logicalStructure'], [3000, 'mindMap'], [3000, 'organizationStructure'], [3000, 'catalogOrganization'], [3000, 'timeline'], [3000, 'verticalTimeline'], [3000, 'fishbone'], [240, 'logicalStructure'], [240, 'logicalStructure', true]]) {
        const page = await fresh()
        try { const r = await page.evaluate(([n, l, c]) => window.runLayout(n, l, c), [n, layout, !!compact]); report.layouts.push(r); console.log(JSON.stringify({ layout, compact: !!compact, n, init: r.initMs, idle: r.idle.total.p50 })) }
        catch (e) { report.layouts.push({ n, layout, compactLayout: !!compact, error: String(e.message || e) }); console.log('layout fail', layout, e.message) }
        save(); await page.close()
      }
    }
    if (!SKIP.has('rich')) {
      for (const n of [1000, 3000]) {
        const page = await fresh()
        try { const r = await page.evaluate(n => window.enableRichText() && window.runRich(n), n); report.rich.push(r); console.log(JSON.stringify({ rich: n, init: r.initMs, idle: r.idle.total.p50, edit: r.edit.total.p50 })) }
        catch (e) { report.rich.push({ n, error: String(e.message || e) }); console.log('rich fail', e.message) }
        save(); await page.close()
      }
    }
    if (!SKIP.has('memory')) {
      const page = await fresh()
      const cdp = await page.context().newCDPSession(page)
      const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300)); await cdp.send('HeapProfiler.collectGarbage'); return Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576 * 10) / 10 }
      const mem = { baselineMB: await heap(), createDestroy3000: [], expandCycles: null }
      for (let i = 0; i < 5; i++) { await page.evaluate(() => window.lifecycleOnce(3000)); mem.createDestroy3000.push(await heap()) }
      mem.beforeCycleMB = await heap()
      const domAfterCycles = await page.evaluate(() => window.cycleExpand(3000))
      mem.afterCreatePlus10ExpandCyclesMB = await heap()
      mem.domAfterCycles = domAfterCycles
      await page.evaluate(() => { window.mm.destroy(); window.mm = null })
      mem.afterDestroyMB = await heap()
      report.memory = mem; save(); console.log(JSON.stringify(mem))
      await page.close()
    }
    if (!SKIP.has('profile')) {
      const page = await fresh()
      const cdp = await page.context().newCDPSession(page)
      await page.evaluate(() => window.createForProfile(6000))
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start')
      await page.evaluate(() => window.profileOps())
      const { profile } = await cdp.send('Profiler.stop')
      const byId = new Map(profile.nodes.map(n => [n.id, n]))
      const self = new Map()
      const dt = profile.timeDeltas
      profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame; const key = (f.functionName || '(anonymous)') + ' @' + (f.url ? f.url.split('/').pop() : '') + ':' + (f.lineNumber + 1); self.set(key, (self.get(key) || 0) + (dt[i] || 0)) })
      const total = [...self.values()].reduce((a, b) => a + b, 0)
      report.profile = { scenario: '6000 节点：3 次 mm.render() + 3 次 SET_NODE_TEXT', totalMs: Math.round(total / 1000), topSelf: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => ({ fn: k, ms: Math.round(v / 1000), pct: +(v / total * 100).toFixed(1) })) }
      save(); console.log(JSON.stringify(report.profile.topSelf.slice(0, 15)))
      await page.close()
    }
    if (arg('painter')) {
      report.painter = []
      const n = Number(arg('painter'))
      for (const withPainter of [false, true, false, true]) {
        const page = await fresh()
        const r = await page.evaluate(([n, p]) => (p ? window.enablePainter() : 0, window.runLayout(n, 'logicalStructure')), [n, withPainter])
        report.painter.push({ withPainter, initMs: r.initMs, idle: r.idle.total, layout: r.idle.layout, paintTree: r.idle.paintTree }); save()
        console.log(JSON.stringify(report.painter.at(-1)))
        await page.close()
      }
    }
    if (arg('probe')) {
      report.probeRemoteStyle = []
      for (const n of arg('probe').split(',').map(Number).filter(Boolean)) {
        const page = await fresh()
        const r = await page.evaluate(n => window.probeRemoteStyle(n), n)
        report.probeRemoteStyle.push(r); save(); console.log(JSON.stringify(r))
        await page.close()
      }
    }
    if (SKIP.has('initprofile') === false && arg('initprofile')) {
      report.initProfile = []
      for (const n of arg('initprofile').split(',').map(Number).filter(Boolean)) {
        const page = await fresh()
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start')
        const t = Date.now()
        await page.evaluate(n => window.createForProfile(n), n)
        const wallMs = Date.now() - t
        const { profile } = await cdp.send('Profiler.stop')
        const counters = await page.evaluate(() => ({ ...window.__counters }))
        report.initProfile.push({ scenario: n + ' 节点首次 setData 到 render_complete', n, wallMs, counters, ...topSelf(profile, 40) })
        save(); console.log(JSON.stringify({ n, wallMs, top: report.initProfile.at(-1).topSelf.slice(0, 12) }))
        await page.close()
      }
    }
    report.pageErrors = harness.errors.slice(0, 20)
    report.finishedAt = new Date().toISOString(); save()
    console.log('wrote', path.join(outDir, 'baseline.json'))
  } finally { await harness.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
