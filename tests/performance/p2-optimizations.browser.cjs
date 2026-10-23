// P2 flag acceptance: analytic edge bounds + lazy offscreen paint.
// Personal expand persist semantics are asserted, not changed.
// node tests/performance/p2-optimizations.browser.cjs [--sizes=150,1000,3000,6000,10000]
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

const arg = name => (process.argv.find(item => item.startsWith(`--${name}=`)) || '').split('=')[1]
const SIZES = (arg('sizes') || '150,1000,3000,6000,10000').split(',').map(Number).filter(Boolean)

const P1 = {
  canvasTextMeasure: true,
  scopedRemoteLineRender: true,
  scopedRemoteGeometry: true,
  deferDraftCopy: true
}
const P1A = { ...P1, analyticEdgeBounds: true }
const P1AB = { ...P1A, lazyOffscreenPaint: true }

const entry = `
import MindMap from './simple-mind-map/index.js'
import Export from './simple-mind-map/src/plugins/Export.js'
import Cooperate from './simple-mind-map/src/plugins/Cooperate.js'
import LogicalStructure from './simple-mind-map/src/layouts/LogicalStructure.js'
import edgeGeometryModule from './simple-mind-map/src/utils/edgeGeometry.js'
MindMap.usePlugin(Export)
const origDoLayout = LogicalStructure.prototype.doLayout
LogicalStructure.prototype.doLayout = function (...a) {
  counters.layouts++
  return origDoLayout.apply(this, a)
}
const edgeGeometry = edgeGeometryModule.boundsFromPath ? edgeGeometryModule : edgeGeometryModule.default

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

function expandMap(mm) {
  const out = {}
  const walk = node => {
    if (!node) return
    const data = node.data || (node.nodeData && node.nodeData.data)
    if (data && data.uid) out[data.uid] = data.expand !== false
    const kids = node.children || (node.nodeData && node.nodeData.children) || []
    kids.forEach(walk)
  }
  walk(mm.renderer.renderTree)
  return out
}

function sameExpand(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
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
    errorHandler: (type, error) => {
      window.__renderErrors = window.__renderErrors || []
      window.__renderErrors.push(String(type) + ': ' + String((error && error.stack) || error))
    },
    ...options
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('init timeout ' + JSON.stringify(window.__renderErrors || []))), 180000)
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

function flagName(flags) {
  if (flags.lazyOffscreenPaint) return 'p1ab'
  if (flags.analyticEdgeBounds) return 'p1a'
  if (flags.canvasTextMeasure) return 'p1'
  return 'off'
}

window.runSize = async (n, flags) => {
  counters.bbox = 0
  const t0 = now()
  const mm = await create(makeTree(n), { performanceFlags: flags })
  const initMs = now() - t0
  const initBBox = counters.bbox
  const afterInit = dom(mm)
  const leaf = Array.from(mm.renderer.nodeIndex.values()).find(node => !node.isRoot && !(node.nodeData.children || []).length)
  counters.bbox = 0
  const idle = await waitRender(mm, () => mm.render())
  counters.bbox = 0
  const edit = await waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', leaf, '修改后的文本稍长一些'))
  mm.destroy()
  host.remove()
  host = null
  return {
    n,
    flags: flagName(flags),
    initMs: +initMs.toFixed(1),
    initBBox,
    idleWall: +idle.wall.toFixed(1),
    idleBBox: counters.bbox,
    editWall: +edit.wall.toFixed(1),
    editLayouts: edit.layouts,
    dom: afterInit
  }
}

window.probePersonalExpand = async flags => {
  const mm = await create(makeTree(80), { performanceFlags: flags })
  const mid = mm.renderer.root.children[0]
  const leaf = mid.children[0]
  const midUid = mid.getData('uid')
  const leafUid = leaf.getData('uid')
  await waitRender(mm, () => mm.renderer.setNodeExpand(mid, false))
  const afterCollapse = expandMap(mm)
  const foundCollapsed = mm.renderer.findNodeByUid(midUid)
  const collapseKept = foundCollapsed && foundCollapsed.getData('expand') === false
  const leafExpandKept = afterCollapse[leafUid] === true

  mm.view.translateXY(-4000, -3000)
  await mm.renderer.paintViewport()
  const afterPan = expandMap(mm)
  const stillCollapsed = mm.renderer.findNodeByUid(midUid).getData('expand') === false
  const groupDetached = !mm.renderer.isNodeGroupAttached(foundCollapsed)

  mm.view.translateXY(4000, 3000)
  await mm.renderer.paintViewport()
  const afterReturn = expandMap(mm)
  const remountCollapsed = mm.renderer.findNodeByUid(midUid).getData('expand') === false

  const other = mm.renderer.root.children[1]
  const expandBefore = other.getData('expand')
  const coop = fakeCooperate(mm, [])
  coop.applyHttpRemoteNodeFields(other, { expand: false, fillColor: '#ffeeaa', text: other.getData('text') })
  const expandAfterRemote = other.getData('expand')

  mm.destroy()
  host.remove()
  host = null
  return {
    flags: flagName(flags),
    collapseKept,
    stillCollapsed,
    remountCollapsed,
    panDidNotChangeExpand: sameExpand(afterCollapse, afterPan),
    returnDidNotChangeExpand: sameExpand(afterCollapse, afterReturn),
    groupDetached,
    remoteDidNotResetExpand: expandBefore === expandAfterRemote && expandAfterRemote !== false,
    expandBefore,
    expandAfterRemote,
    leafExpandKept,
    renderErrors: window.__renderErrors || []
  }
}

window.compareEdgeBounds = async () => {
  const mm = await create(makeTree(40), { performanceFlags: {}, openPerformance: true })
  const rows = []
  for (const node of mm.renderer.nodeIndex.values()) {
    for (const line of node._lines || []) {
      const el = line.node
      if (!el || typeof el.getBBox !== 'function') continue
      const d = el.getAttribute('d')
      if (!d || d === 'M 0,0' || d === 'M0,0') continue
      const strokeWidth = parseFloat(el.getAttribute('stroke-width') || '0') || 0
      const markers = [el.getAttribute('marker-start'), el.getAttribute('marker-end')]
      const rect = el.getBBox()
      const padding = Math.max(strokeWidth / 2 * 4, markers.some(Boolean) ? 20 : 0)
      const bbox = {
        left: rect.x - padding,
        top: rect.y - padding,
        right: rect.x + rect.width + padding,
        bottom: rect.y + rect.height + padding
      }
      const analytic = edgeGeometry.boundsFromPathWithStroke(d, {
        strokeWidth,
        miterLimit: 4,
        hasMarker: markers.some(Boolean)
      })
      if (!analytic) {
        rows.push({ d, missing: true })
        continue
      }
      const diffs = [
        Math.abs(bbox.left - analytic.left),
        Math.abs(bbox.top - analytic.top),
        Math.abs(bbox.right - analytic.right),
        Math.abs(bbox.bottom - analytic.bottom)
      ]
      rows.push({
        d: d.slice(0, 80),
        max: Math.max(...diffs),
        bbox,
        analytic
      })
    }
  }
  mm.destroy()
  host.remove()
  host = null
  const valid = rows.filter(row => !row.missing)
  valid.sort((a, b) => b.max - a.max)
  const max = valid.length ? valid[0].max : 0
  return {
    compared: valid.length,
    missing: rows.filter(row => row.missing).length,
    maxAbsDiff: +max.toFixed(3),
    worst: valid[0] || null
  }
}

window.ready = true
`

async function main() {
  const outDir = path.join(repo, 'output', 'p2-optimizations')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { startedAt: new Date().toISOString(), sizes: [], probes: {}, errors: [] }
  const save = () => fs.writeFileSync(path.join(outDir, 'p2-results.json'), JSON.stringify(report, null, 2))
  const page = async () => {
    const p = await harness.newPage()
    p.setDefaultTimeout(900000)
    await p.waitForFunction(() => window.ready)
    return p
  }
  try {
    const boundsPage = await page()
    report.probes.edgeBounds = await boundsPage.evaluate(() => window.compareEdgeBounds())
    report.probes.pageErrors = harness.errors.slice(0, 20)
    console.log('edgeBounds', JSON.stringify(report.probes.edgeBounds))
    console.log('pageErrors', JSON.stringify(report.probes.pageErrors))
    await boundsPage.close()

    for (const flags of [{}, P1, P1AB]) {
      const p = await page()
      const r = await p.evaluate(f => window.probePersonalExpand(f), flags)
      report.probes['expand-' + r.flags] = r
      console.log('expand', JSON.stringify(r))
      await p.close()
    }

    const combos = [
      ['off', {}],
      ['p1', P1],
      ['p1a', P1A],
      ['p1ab', P1AB]
    ]
    for (const n of SIZES) {
      for (const [name, flags] of combos) {
        if (name === 'off' && n >= 6000) continue
        const p = await page()
        const r = await p.evaluate(([size, f]) => window.runSize(size, f), [n, flags])
        report.sizes.push(r)
        console.log('size', JSON.stringify({
          n,
          flags: name,
          init: r.initMs,
          bbox: r.initBBox,
          idle: r.idleWall,
          edit: r.editWall,
          groups: r.dom.nodeGroupsAttached,
          paths: r.dom.pathsAttached
        }))
        save()
        await p.close()
      }
    }
  } catch (error) {
    report.errors.push(String((error && error.stack) || error))
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
