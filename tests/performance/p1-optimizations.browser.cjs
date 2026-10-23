// P1 flag acceptance: synthetic data only, no rooms/servers.
// node tests/performance/p1-optimizations.browser.cjs [--sizes=150,1000,3000,6000,10000]
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

const arg = name => (process.argv.find(item => item.startsWith(`--${name}=`)) || '').split('=')[1]
const SIZES = (arg('sizes') || '150,1000,3000,6000,10000').split(',').map(Number).filter(Boolean)
const SKIP_PROBES = process.argv.includes('--skip-probes')

const entry = `
import MindMap from './simple-mind-map/index.js'
import Export from './simple-mind-map/src/plugins/Export.js'
import Cooperate from './simple-mind-map/src/plugins/Cooperate.js'
import LogicalStructure from './simple-mind-map/src/layouts/LogicalStructure.js'
import p1PerfPlanModule from './simple-mind-map/src/utils/p1PerfPlan.js'
MindMap.usePlugin(Export)
const origDoLayout = LogicalStructure.prototype.doLayout
LogicalStructure.prototype.doLayout = function (...a) {
  counters.layouts++
  return origDoLayout.apply(this, a)
}
const p1PerfPlan = p1PerfPlanModule.planRemoteNodePaint ? p1PerfPlanModule : p1PerfPlanModule.default

const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const counters = { bbox: 0, layouts: 0 }
const origBBox = SVGGraphicsElement.prototype.getBBox
SVGGraphicsElement.prototype.getBBox = function (...a) {
  counters.bbox++
  return origBBox.apply(this, a)
}

function text(i) {
  if (i % 11 === 0) return 'Hello世界 emoji😀 #' + i
  if (i % 7 === 0) return '这是一个较长的需求节点标题，用于覆盖自动换行与文本测量 #' + i
  if (i % 3 === 0) return 'Task ' + i + ' review'
  return '节点 ' + i
}
function makeTree(n) {
  let id = 0
  const mk = () => {
    const i = id++
    return { data: { uid: 'n' + i, text: text(i), expand: true }, children: [] }
  }
  const root = mk()
  const q = [root]
  while (id < n) {
    const cur = q.shift()
    const fanout = cur === root ? 12 : 8
    for (let i = 0; i < fanout && id < n; i++) {
      const child = mk()
      cur.children.push(child)
      q.push(child)
    }
  }
  return root
}

let host = null
function dom(mm) {
  return {
    svgElements: document.querySelectorAll('svg *').length,
    nodeGroupsAttached: document.querySelectorAll('g.smm-node').length,
    pathsAttached: document.querySelectorAll('path').length,
    modelNodes: mm.renderer.nodeIndex.size
  }
}
function geometry(mm) {
  return Array.from(mm.renderer.nodeIndex.values())
    .map(n => ({
      uid: n.getData('uid'),
      l: +n.left.toFixed(2),
      t: +n.top.toFixed(2),
      w: n.width,
      h: n.height,
      text: n.getData('text')
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid))
}

async function create(data, options = {}) {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host)
  counters.bbox = 0
  counters.layouts = 0
  const mm = new MindMap({
    el: host,
    data,
    layout: 'logicalStructure',
    fit: false,
    openPerformance: true,
    openRealtimeRenderOnNodeTextEdit: false,
    addHistoryTime: 0,
    createNewNodeBehavior: 'NOT_ACTIVE',
    enableInheritAncestorLineStyle: true,
    ...options
  })
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

function fakeCooperate(mm, scheduled) {
  const coop = Object.create(Cooperate.prototype)
  coop.mindMap = mm
  coop.httpRefreshing = false
  coop.scheduleRemoteGeometryRender = uid => scheduled.push(uid)
  return coop
}

async function waitRender(mm, action) {
  const t0 = now()
  const layoutsBefore = counters.layouts
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('render timeout')), 120000)
    mm.on('render_complete', function f() {
      clearTimeout(t)
      mm.off('render_complete', f)
      resolve()
    })
    action()
  })
  return { wall: now() - t0, layouts: counters.layouts - layoutsBefore }
}

window.runSize = async (n, flags) => {
  counters.bbox = 0
  const t0 = now()
  const mm = await create(makeTree(n), { performanceFlags: flags })
  const initMs = now() - t0
  const initBBox = counters.bbox
  const initLayouts = counters.layouts
  const afterInit = dom(mm)
  const leaf = Array.from(mm.renderer.nodeIndex.values()).find(n => !n.isRoot && !(n.nodeData.children || []).length)
  counters.bbox = 0
  const idle = await waitRender(mm, () => mm.render())
  const idleBBox = counters.bbox
  counters.bbox = 0
  const edit = await waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', leaf, '修改后的文本稍长一些'))
  const editBBox = counters.bbox
  mm.destroy()
  host.remove()
  host = null
  return {
    n,
    flags,
    initMs: +initMs.toFixed(1),
    initBBox,
    initLayouts,
    idleWall: +idle.wall.toFixed(1),
    idleLayouts: idle.layouts,
    idleBBox,
    editWall: +edit.wall.toFixed(1),
    editLayouts: edit.layouts,
    editBBox,
    dom: afterInit
  }
}

window.probeRemoteStyle = async (n, flags) => {
  const mm = await create(makeTree(n), { performanceFlags: flags })
  const before = dom(mm)
  const scheduled = []
  const coop = fakeCooperate(mm, scheduled)
  const target = mm.renderer.root.children[1]
  const layoutsBefore = counters.layouts
  const t0 = now()
  coop.applyHttpRemoteNodeFields(target, { fillColor: '#ffeeaa' })
  const syncMs = now() - t0
  await sleep(80)
  const after = dom(mm)
  mm.destroy()
  host.remove()
  host = null
  return {
    n,
    flags,
    syncMs: +syncMs.toFixed(1),
    beforePaths: before.pathsAttached,
    afterPaths: after.pathsAttached,
    afterGroups: after.nodeGroupsAttached,
    scheduledLayouts: scheduled.length,
    extraLayouts: counters.layouts - layoutsBefore
  }
}

window.probeRemoteGeometry = async (n, flags) => {
  const mm = await create(makeTree(n), { performanceFlags: flags })
  const scheduled = []
  const coop = fakeCooperate(mm, scheduled)
  const leaf = Array.from(mm.renderer.nodeIndex.values()).find(n => !n.isRoot && !(n.nodeData.children || []).length)
  const same = { ...leaf.getData() }
  coop.applyHttpRemoteNodeFields(leaf, { comments: same.comments || [] })
  const sameSizeScheduled = scheduled.splice(0, scheduled.length)
  coop.applyHttpRemoteNodeFields(leaf, { text: '这行字明显更长，会改变节点宽度 ———— ' + Date.now() })
  const sizeScheduled = scheduled.splice(0, scheduled.length)
  mm.destroy()
  host.remove()
  host = null
  return { n, flags, sameSizeScheduled: sameSizeScheduled.length, sizeScheduled: sizeScheduled.length }
}

window.probeInheritLine = async flags => {
  const data = {
    data: { uid: 'root', text: '根', expand: true },
    children: [{
      data: { uid: 'a', text: '二级', expand: true },
      children: [
        { data: { uid: 'a1', text: '三级甲', expand: true }, children: [] },
        { data: { uid: 'a2', text: '三级乙', expand: true }, children: [] }
      ]
    }]
  }
  const mm = await create(data, { performanceFlags: flags, openPerformance: false })
  const parent = mm.renderer.findNodeByUid('a')
  const coop = fakeCooperate(mm, [])
  coop.applyHttpRemoteNodeFields(parent, { lineColor: '#cc2244' })
  await sleep(50)
  const colors = (parent._lines || []).map(line => line.node && line.node.getAttribute('stroke'))
  const child = mm.renderer.findNodeByUid('a1')
  const inherited = child.getSelfInhertStyle('lineColor')
  mm.destroy()
  host.remove()
  host = null
  return { flags, colors, inherited }
}

window.compareGeometry = async () => {
  const samples = [
    '短',
    'Hello世界',
    '这是一个较长的需求节点标题，用于覆盖自动换行与文本测量 #7',
    '😀中英文mix 123',
    'AVAVAVAV 字距',
    'bold-ish 粗体混排 ABC中文'
  ]
  const tree = {
    data: { uid: 'root', text: '根', expand: true },
    children: samples.map((text, i) => ({
      data: { uid: 's' + i, text, expand: true, fontWeight: i === 5 ? 'bold' : 'normal' },
      children: []
    }))
  }
  const off = await create(JSON.parse(JSON.stringify(tree)), { performanceFlags: {}, openPerformance: false })
  const geoOff = geometry(off)
  const exportOff = off.getSvgData({ paddingX: 10, paddingY: 10 }).svgHTML
  off.destroy()
  const on = await create(JSON.parse(JSON.stringify(tree)), {
    performanceFlags: { canvasTextMeasure: true },
    openPerformance: false
  })
  const geoOn = geometry(on)
  const exportOn = on.getSvgData({ paddingX: 10, paddingY: 10 }).svgHTML
  on.destroy()
  host.remove()
  host = null
  const diffs = []
  geoOff.forEach((a, i) => {
    const b = geoOn[i]
    const dw = Math.abs(a.w - b.w)
    const dh = Math.abs(a.h - b.h)
    const dl = Math.abs(a.l - b.l)
    const dt = Math.abs(a.t - b.t)
    if (dw > 1 || dh > 1 || dl > 1 || dt > 1) diffs.push({ uid: a.uid, a, b, dw, dh, dl, dt })
  })
  return {
    nodes: geoOff.length,
    diffs,
    exportLenOff: exportOff.length,
    exportLenOn: exportOn.length,
    exportEqual: exportOff === exportOn
  }
}

window.ready = true
`

async function main() {
  const outDir = path.join(repo, 'output', 'p1-optimizations')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { startedAt: new Date().toISOString(), sizes: [], probes: {}, visual: null, errors: [] }
  const save = () => fs.writeFileSync(path.join(outDir, 'p1-results.json'), JSON.stringify(report, null, 2))
  const page = async () => {
    const p = await harness.newPage()
    p.setDefaultTimeout(900000)
    await p.waitForFunction(() => window.ready)
    return p
  }
  try {
    if (!SKIP_PROBES) {
    const visualPage = await page()
    report.visual = await visualPage.evaluate(() => window.compareGeometry())
    console.log('visual', JSON.stringify(report.visual))
    await visualPage.close()

    for (const flags of [{}, { scopedRemoteLineRender: true }]) {
      const p = await page()
      const inherit = await p.evaluate(f => window.probeInheritLine(f), flags)
      report.probes['inherit-' + (flags.scopedRemoteLineRender ? 'on' : 'off')] = inherit
      console.log('inherit', JSON.stringify(inherit))
      await p.close()
    }

    for (const n of [6000]) {
      for (const flags of [{}, { scopedRemoteLineRender: true }]) {
        const p = await page()
        const r = await p.evaluate(([n, f]) => window.probeRemoteStyle(n, f), [n, flags])
        report.probes['style-' + n + '-' + (flags.scopedRemoteLineRender ? 'on' : 'off')] = r
        console.log('style', JSON.stringify(r))
        await p.close()
      }
    }

    for (const n of [1000]) {
      for (const flags of [{}, { scopedRemoteGeometry: true }]) {
        const p = await page()
        const r = await p.evaluate(([n, f]) => window.probeRemoteGeometry(n, f), [n, flags])
        report.probes['geom-' + n + '-' + (flags.scopedRemoteGeometry ? 'on' : 'off')] = r
        console.log('geom', JSON.stringify(r))
        await p.close()
      }
    }
    }

    for (const n of SIZES) {
      for (const flags of [
        {},
        { canvasTextMeasure: true, scopedRemoteLineRender: true, scopedRemoteGeometry: true }
      ]) {
        const p = await page()
        const r = await p.evaluate(([n, f]) => window.runSize(n, f), [n, flags])
        report.sizes.push(r)
        console.log('size', JSON.stringify({ n, flags, init: r.initMs, bbox: r.initBBox, initLayouts: r.initLayouts, idle: r.idleWall, idleLayouts: r.idleLayouts, edit: r.editWall, editLayouts: r.editLayouts }))
        save()
        await p.close()
      }
    }
  } catch (error) {
    report.errors.push(String(error && error.stack || error))
    console.error(error)
  } finally {
    report.harnessErrors = harness.errors.slice(0, 20)
    save()
    await harness.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
