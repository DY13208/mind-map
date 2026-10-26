// Isolated P3 necessity: phase split + moved-set ceiling. Does not change layout.
// node tests/performance/p3-layout-necessity.browser.cjs
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

const arg = name => (process.argv.find(item => item.startsWith(`--${name}=`)) || '').split('=')[1]
const SIZES = (arg('sizes') || '1000,3000,6000,10000').split(',').map(Number).filter(Boolean)
const REPEATS = Math.max(4, Number(arg('repeats') || 8))
const OUT = path.join(repo, 'output', 'p3-layout-necessity')

const P1AB = {
  canvasTextMeasure: true,
  scopedRemoteLineRender: true,
  scopedRemoteGeometry: true,
  deferDraftCopy: true,
  analyticEdgeBounds: true,
  lazyOffscreenPaint: true
}

const entry = `
import MindMap from './simple-mind-map/index.js'
import MindMapNode from './simple-mind-map/src/core/render/node/MindMapNode.js'
import LogicalStructure from './simple-mind-map/src/layouts/LogicalStructure.js'
import Base from './simple-mind-map/src/layouts/Base.js'

const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (list, p) => {
  const s = list.filter(n => Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (!s.length) return null
  return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2)
}
const stats = list => ({
  n: list.length,
  p50: pct(list, 50),
  p95: pct(list, 95),
  max: list.length ? +Math.max(...list).toFixed(2) : null
})

const LONG = []
try {
  new PerformanceObserver(list => list.getEntries().forEach(e => LONG.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: true })
} catch (e) {}
const longIn = (a, b) => {
  const hit = LONG.filter(t => t.start >= a - 1 && t.start <= b)
  return { count: hit.length, max: hit.length ? +Math.max(...hit.map(t => t.dur)).toFixed(1) : 0, total: +hit.reduce((s, t) => s + t.dur, 0).toFixed(1) }
}

function text(i) {
  if (i % 7 === 0) return '这是一个较长的需求节点标题，用于覆盖自动换行与文本测量 #' + i
  if (i % 3 === 0) return '任务 ' + i + ' 评审与排期'
  return '节点 ' + i
}

function makeExpandedTree(n) {
  let id = 0
  const mk = () => {
    const i = id++
    return { data: { uid: 'n' + i, text: text(i), expand: true }, children: [] }
  }
  const root = mk()
  root.data.text = '根节点'
  const q = [root]
  while (id < n) {
    const cur = q.shift()
    const fan = cur === root ? 12 : 8
    for (let i = 0; i < fan && id < n; i++) {
      const child = mk()
      cur.children.push(child)
      q.push(child)
    }
  }
  return root
}

function makeCollapsedWideTree(n) {
  let id = 0
  const mk = expand => {
    const i = id++
    return { data: { uid: 'n' + i, text: text(i), expand: expand !== false }, children: [] }
  }
  const root = mk(true)
  root.data.text = 'Root'
  const heads = []
  for (let i = 0; i < 12 && id < n; i++) {
    const head = mk(false)
    root.children.push(head)
    heads.push(head)
    for (let k = 0; k < 8 && id < n; k++) {
      head.children.push(mk(false))
    }
  }
  let h = 0
  const pack = heads.slice()
  while (id < n) {
    const parent = pack[h % pack.length]
    const child = mk(false)
    parent.children.push(child)
    pack.push(child)
    h++
  }
  return root
}

const counters = {
  getSize: 0, getSizeMs: 0, layouts: 0, baseMs: 0, topMs: 0, adjustMs: 0,
  createNode: 0, indexMs: 0, rebuildIndexMs: 0, paintTreeMs: 0, nodeRender: 0,
  nodeRenderMs: 0, viewportMs: 0, minimapMs: 0, bbox: 0
}
const origGetSize = MindMapNode.prototype.getSize
MindMapNode.prototype.getSize = function (...a) {
  counters.getSize++
  const t = now()
  try { return origGetSize.apply(this, a) }
  finally { counters.getSizeMs += now() - t }
}
const origCreate = Base.prototype.createNode
Base.prototype.createNode = function (...a) {
  counters.createNode++
  return origCreate.apply(this, a)
}
function wrapTimed(orig, key) {
  return function (...a) {
    const t = now()
    const res = orig.apply(this, a)
    const mark = () => { counters[key] += now() - t }
    if (res && typeof res.then === 'function') return res.then(v => { mark(); return v })
    mark()
    return res
  }
}
LogicalStructure.prototype.computedBaseValue = wrapTimed(LogicalStructure.prototype.computedBaseValue, 'baseMs')
LogicalStructure.prototype.computedTopValue = wrapTimed(LogicalStructure.prototype.computedTopValue, 'topMs')
LogicalStructure.prototype.adjustTopValue = wrapTimed(LogicalStructure.prototype.adjustTopValue, 'adjustMs')
const origDo = LogicalStructure.prototype.doLayout
LogicalStructure.prototype.doLayout = function (...a) {
  counters.layouts++
  return origDo.apply(this, a)
}
const origBBox = SVGGraphicsElement.prototype.getBBox
SVGGraphicsElement.prototype.getBBox = function (...a) {
  counters.bbox++
  return origBBox.apply(this, a)
}

function reset() {
  Object.keys(counters).forEach(k => { counters[k] = 0 })
}

function instrument(mm) {
  const r = mm.renderer
  const origRebuild = r.rebuildNodeIndex.bind(r)
  r.rebuildNodeIndex = function (...a) {
    const t = now()
    try { return origRebuild(...a) }
    finally { counters.rebuildIndexMs += now() - t }
  }
  const origBvi = r.buildViewportIndex.bind(r)
  r.buildViewportIndex = function (...a) {
    const t = now()
    const res = origBvi(...a)
    const mark = () => { counters.indexMs += now() - t }
    if (res && res.then) return res.then(v => { mark(); return v })
    mark()
    return res
  }
  const origPaintTree = r.paintLayoutTree.bind(r)
  r.paintLayoutTree = function (...a) {
    const t = now()
    const res = origPaintTree(...a)
    const mark = () => { counters.paintTreeMs += now() - t }
    if (res && typeof res.then === 'function') return res.then(v => { mark(); return v })
    mark()
    return res
  }
  const origPv = r.paintViewport.bind(r)
  r.paintViewport = function (...a) {
    const t = now()
    return origPv(...a).then(v => { counters.viewportMs += now() - t; return v })
  }
  const origRender = MindMapNode.prototype.render
  if (!MindMapNode.prototype.__p3Wrapped) {
    MindMapNode.prototype.render = function (...a) {
      counters.nodeRender++
      const t = now()
      try { return origRender.apply(this, a) }
      finally { counters.nodeRenderMs += now() - t }
    }
    MindMapNode.prototype.__p3Wrapped = true
  }
}

function counts(mm) {
  const renderTree = mm.renderer.renderTree
  let loaded = 0
  let expanded = 0
  const walk = node => {
    if (!node || !node.data) return
    loaded++
    if (node.data.expand !== false) expanded++
    ;(node.children || []).forEach(walk)
  }
  walk(renderTree)
  const layoutNodes = mm.renderer.nodeIndex ? mm.renderer.nodeIndex.size : Object.keys(mm.renderer.nodeCache || {}).length
  const viewport = (mm.renderer._visibleViewportNodes && mm.renderer._visibleViewportNodes.size) || 0
  const attached = mm.nodeDraw.node.querySelectorAll(':scope > g.smm-node').length
  return {
    serverTotal: loaded,
    loaded,
    layoutExpanded: expanded,
    layoutModelNodes: layoutNodes,
    viewportPainted: viewport,
    attachedGroups: attached
  }
}

function geom(mm) {
  const out = {}
  ;(mm.renderer.nodeIndex || new Map()).forEach((node, uid) => {
    out[uid] = { l: node.left, t: node.top, w: node.width, h: node.height }
  })
  return out
}

function geomDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  let pos = 0, size = 0, same = 0, added = 0, removed = 0
  keys.forEach(uid => {
    const a = before[uid]
    const b = after[uid]
    if (!a) { added++; return }
    if (!b) { removed++; return }
    const sizeCh = a.w !== b.w || a.h !== b.h
    const posCh = a.l !== b.l || a.t !== b.t
    if (sizeCh) size++
    if (posCh) pos++
    if (!sizeCh && !posCh) same++
  })
  return { posChanged: pos, sizeChanged: size, unchanged: same, added, removed, after: Object.keys(after).length }
}

function pickLeaf(mm) {
  return Array.from(mm.renderer.nodeIndex.values()).find(n => !n.isRoot && !(n.nodeData.children || []).length)
}

function pickBranch(mm) {
  return Array.from(mm.renderer.nodeIndex.values()).find(n => !n.isRoot && (n.nodeData.children || []).length >= 3)
}

let host = null
async function create(data, flags) {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host)
  reset()
  const mm = new MindMap({
    el: host,
    data,
    layout: 'logicalStructure',
    fit: false,
    openPerformance: true,
    openRealtimeRenderOnNodeTextEdit: false,
    addHistoryTime: 0,
    createNewNodeBehavior: 'NOT_ACTIVE',
    errorHandler: () => {},
    performanceFlags: flags || {}
  })
  instrument(mm)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('init timeout')), 300000)
    mm.on('render_complete', function f() {
      clearTimeout(t)
      mm.off('render_complete', f)
      resolve()
    })
  })
  return mm
}

async function waitRender(mm, action) {
  await new Promise((resolve, reject) => {
    let settled = false
    const t = setTimeout(() => {
      if (!settled) reject(new Error('render timeout'))
    }, 180000)
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      mm.off('render_complete', done)
      resolve()
    }
    mm.on('render_complete', done)
    action()
    setTimeout(() => {
      if (!settled && !mm.renderer.isRendering && !mm.renderer.renderTimer) done()
    }, 80)
  })
}

async function settle(mm) {
  for (let i = 0; i < 80 && (mm.renderer.isRendering || mm.renderer.renderTimer); i++) await sleep(20)
  await sleep(40)
}

async function sampleOp(mm, repeats, action) {
  const walls = [], cpu = [], phases = []
  let lastDiff = null
  let lastScale = null
  for (let i = 0; i < repeats; i++) {
    const beforeG = i === 0 || i === repeats - 1 ? geom(mm) : null
    const beforeC = counts(mm)
    reset()
    const t0 = now()
    await action(i)
    await settle(mm)
    const t1 = now()
    const afterC = counts(mm)
    walls.push(t1 - t0)
    cpu.push(longIn(t0, t1))
    phases.push({
      wallMs: +(t1 - t0).toFixed(2),
      measureMs: +counters.getSizeMs.toFixed(2),
      measureCalls: counters.getSize,
      layoutBaseMs: +counters.baseMs.toFixed(2),
      layoutTopMs: +counters.topMs.toFixed(2),
      layoutAdjustMs: +counters.adjustMs.toFixed(2),
      layoutMs: +(counters.baseMs + counters.topMs + counters.adjustMs).toFixed(2),
      layouts: counters.layouts,
      rebuildIndexMs: +counters.rebuildIndexMs.toFixed(2),
      viewportIndexMs: +counters.indexMs.toFixed(2),
      paintTreeMs: +counters.paintTreeMs.toFixed(2),
      viewportPaintMs: +counters.viewportMs.toFixed(2),
      nodeRender: counters.nodeRender,
      nodeRenderMs: +counters.nodeRenderMs.toFixed(2),
      createNode: counters.createNode,
      minimapMs: +counters.minimapMs.toFixed(2),
      bbox: counters.bbox,
      otherMs: +Math.max(0, (t1 - t0) - counters.getSizeMs - counters.baseMs - counters.topMs - counters.adjustMs - counters.rebuildIndexMs - counters.indexMs - counters.paintTreeMs - counters.viewportMs - counters.minimapMs).toFixed(2)
    })
    if (beforeG) lastDiff = geomDiff(beforeG, geom(mm))
    lastScale = {
      before: beforeC,
      after: afterC,
      newNodes: afterC.loaded - beforeC.loaded
    }
  }
  const pick = key => phases.map(p => p[key])
  return {
    wall: stats(walls),
    longMax: stats(cpu.map(c => c.max)),
    longTotal: stats(cpu.map(c => c.total)),
    measureMs: stats(pick('measureMs')),
    layoutMs: stats(pick('layoutMs')),
    layoutBaseMs: stats(pick('layoutBaseMs')),
    rebuildIndexMs: stats(pick('rebuildIndexMs')),
    viewportIndexMs: stats(pick('viewportIndexMs')),
    paintTreeMs: stats(pick('paintTreeMs')),
    viewportPaintMs: stats(pick('viewportPaintMs')),
    nodeRender: stats(pick('nodeRender')),
    nodeRenderMs: stats(pick('nodeRenderMs')),
    createNode: stats(pick('createNode')),
    bbox: stats(pick('bbox')),
    otherMs: stats(pick('otherMs')),
    lastDiff,
    lastScale,
    lastPhase: phases[phases.length - 1]
  }
}

window.runExpanded = async (n, flags, repeats) => {
  const t0 = now()
  const mm = await create(makeExpandedTree(n), flags)
  const initMs = now() - t0
  await settle(mm)
  const scale = counts(mm)
  const leaf = pickLeaf(mm)
  const branch = pickBranch(mm)
  const idle = await sampleOp(mm, repeats, () => waitRender(mm, () => mm.render()))
  const edit = await sampleOp(mm, repeats, i => waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', leaf, '修改后的文本稍长一些 ' + i)))
  const insert = await sampleOp(mm, repeats, i => waitRender(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, [leaf], { text: 'ins' + i, uid: 'ins-' + i })))
  const remove = await sampleOp(mm, repeats, () => {
    const extra = Array.from(mm.renderer.nodeIndex.values()).find(n => String(n.getData('uid') || '').startsWith('ins-'))
    const target = extra || pickLeaf(mm)
    return waitRender(mm, () => mm.execCommand('REMOVE_NODE', [target]))
  })
  const expand = await sampleOp(mm, repeats, async () => {
    const node = branch || pickBranch(mm)
    const next = node.getData('expand') === false
    await waitRender(mm, () => mm.renderer.setNodeExpand(node, next))
  })
  reset()
  const burstT0 = now()
  for (let i = 0; i < 20; i++) {
    leaf.nodeData.data.text = '远端 ' + i
    leaf.reRender(['text'])
    mm.renderer.requestRemoteRender && mm.renderer.requestRemoteRender(leaf.getData('uid'))
    await sleep(16)
  }
  await settle(mm)
  const burst = {
    wallMs: +(now() - burstT0).toFixed(1),
    layouts: counters.layouts,
    long: longIn(burstT0, now()),
    scale: counts(mm)
  }
  mm.destroy()
  host.remove()
  host = null
  return { n, flags: flags && flags.lazyOffscreenPaint ? 'p1ab' : 'off', initMs: +initMs.toFixed(1), scale, idle, edit, insert, remove, expand, remoteBurst: burst }
}

window.runExpandMystery = async (n, flags, repeats) => {
  const mm = await create(makeCollapsedWideTree(n), flags)
  await settle(mm)
  const before = counts(mm)
  const node = mm.renderer.findNodeByUid('n1') || mm.renderer.root.children[0]
  const samples = []
  for (let i = 0; i < repeats; i++) {
    if (node.getData('expand') !== false) {
      await waitRender(mm, () => mm.renderer.setNodeExpand(node, false))
      await settle(mm)
    }
    reset()
    const t0 = now()
    const kidsBefore = (node.nodeData.children || []).length
    await waitRender(mm, () => mm.renderer.setNodeExpand(node, true))
    await settle(mm)
    samples.push({
      wallMs: now() - t0,
      measureMs: counters.getSizeMs,
      layoutMs: counters.baseMs + counters.topMs + counters.adjustMs,
      paintTreeMs: counters.paintTreeMs,
      viewportIndexMs: counters.indexMs,
      nodeRender: counters.nodeRender,
      nodeRenderMs: counters.nodeRenderMs,
      createNode: counters.createNode,
      kidsBefore,
      kidsAfter: (node.nodeData.children || []).length,
      scale: counts(mm)
    })
  }
  const out = {
    n,
    flags: flags && flags.lazyOffscreenPaint ? 'p1ab' : 'off',
    before,
    afterLast: counts(mm),
    wall: stats(samples.map(s => s.wallMs)),
    layoutMs: stats(samples.map(s => s.layoutMs)),
    paintTreeMs: stats(samples.map(s => s.paintTreeMs)),
    nodeRender: stats(samples.map(s => s.nodeRender)),
    createNode: stats(samples.map(s => s.createNode)),
    kidsAfter: samples.map(s => s.kidsAfter),
    samples
  }
  mm.destroy()
  host.remove()
  host = null
  return out
}

window.ready = true
`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = {
    kind: 'isolated-browser',
    purpose: 'P3 partial-layout necessity, no layout code change',
    startedAt: new Date().toISOString(),
    browser: harness.browser.version(),
    node: process.version,
    viewport: '1280x900',
    layout: 'logicalStructure',
    tree: 'same fanout-8 fully expanded synthetic tree',
    repeats: REPEATS,
    sizes: SIZES,
    expanded: [],
    expandMystery: [],
    pageErrors: harness.errors
  }
  const save = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2))
  try {
    for (const flags of [{}, P1AB]) {
      for (const n of SIZES) {
        const page = await harness.newPage()
        page.setDefaultTimeout(900000)
        await page.waitForFunction(() => window.ready)
        const t = Date.now()
        page.on('pageerror', err => console.log('pageerror', err.message))
        const r = await page.evaluate(({ n, flags, repeats }) => window.runExpanded(n, flags, repeats), { n, flags, repeats: REPEATS })
        report.expanded.push(r)
        save()
        console.log(JSON.stringify({
          mode: 'expanded',
          n,
          flags: r.flags,
          init: r.initMs,
          scale: r.scale,
          idle: r.idle.wall,
          edit: r.edit.wall,
          editMoved: r.edit.lastDiff,
          sec: +((Date.now() - t) / 1000).toFixed(1)
        }))
        await page.close()
      }
    }
    for (const flags of [{}, P1AB]) {
      const page = await harness.newPage()
      page.setDefaultTimeout(900000)
      await page.waitForFunction(() => window.ready)
      const r = await page.evaluate(({ n, flags, repeats }) => window.runExpandMystery(n, flags, repeats), { n: 10000, flags, repeats: REPEATS })
      report.expandMystery.push(r)
      save()
      console.log(JSON.stringify({ mode: 'mystery', flags: r.flags, before: r.before, wall: r.wall, kidsAfter: r.kidsAfter }))
      await page.close()
    }
  } finally {
    report.finishedAt = new Date().toISOString()
    save()
    await harness.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
