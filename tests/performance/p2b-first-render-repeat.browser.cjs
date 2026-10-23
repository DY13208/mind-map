// Interleaved 6000-node first-render repeats: P1 vs P1+A/B.
// Does not overwrite p1/p2 optimization scripts.
// node tests/performance/p2b-first-render-repeat.browser.cjs [--rounds=8]
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

const ROUNDS = Math.max(3, Number((process.argv.find(item => item.startsWith('--rounds=')) || '').split('=')[1]) || 8)
const SIZE = 6000
const P1 = {
  canvasTextMeasure: true,
  scopedRemoteLineRender: true,
  scopedRemoteGeometry: true,
  deferDraftCopy: true
}
const P1AB = { ...P1, analyticEdgeBounds: true, lazyOffscreenPaint: true }

const entry = `
import MindMap from './simple-mind-map/index.js'
import MindMapNode from './simple-mind-map/src/core/render/node/MindMapNode.js'
import LogicalStructure from './simple-mind-map/src/layouts/LogicalStructure.js'
import Render from './simple-mind-map/src/core/render/Render.js'
import Export from './simple-mind-map/src/plugins/Export.js'
MindMap.usePlugin(Export)

const now = () => performance.now()
const phases = { layout: 0, index: 0, paintViewport: 0, nodeRender: 0 }
const wrapTime = (proto, name, key) => {
  const orig = proto[name]
  proto[name] = function (...args) {
    const t0 = now()
    const result = orig.apply(this, args)
    const add = () => { phases[key] += now() - t0 }
    if (result && typeof result.then === 'function') return result.then(value => { add(); return value }, err => { add(); throw err })
    add()
    return result
  }
}
wrapTime(LogicalStructure.prototype, 'doLayout', 'layout')
wrapTime(Render.prototype, 'buildViewportIndex', 'index')
wrapTime(Render.prototype, 'paintViewport', 'paintViewport')
wrapTime(MindMapNode.prototype, 'render', 'nodeRender')

const counters = { bbox: 0, layouts: 0, nodeRender: 0 }
const origDoLayout = LogicalStructure.prototype.doLayout
LogicalStructure.prototype.doLayout = function (...a) {
  counters.layouts++
  return origDoLayout.apply(this, a)
}
const origRender = MindMapNode.prototype.render
MindMapNode.prototype.render = function (...a) {
  counters.nodeRender++
  return origRender.apply(this, a)
}
const origBBox = SVGGraphicsElement.prototype.getBBox
SVGGraphicsElement.prototype.getBBox = function (...a) {
  counters.bbox++
  return origBBox.apply(this, a)
}

function makeTree(n) {
  let id = 0
  const mk = () => {
    const i = id++
    const text = i % 7 === 0
      ? '这是一个较长的需求节点标题，用于覆盖自动换行 #' + i
      : i % 3 === 0 ? 'Task ' + i : '节点 ' + i
    return { data: { uid: 'n' + i, text, expand: true }, children: [] }
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
window.runFirst = async (n, flags, label) => {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host)
  counters.bbox = 0
  counters.layouts = 0
  counters.nodeRender = 0
  phases.layout = 0
  phases.index = 0
  phases.paintViewport = 0
  phases.nodeRender = 0
  let mutAdd = 0
  let mutRemove = 0
  const observer = new MutationObserver(records => {
    records.forEach(record => {
      mutAdd += record.addedNodes.length
      mutRemove += record.removedNodes.length
    })
  })
  observer.observe(host, { childList: true, subtree: true })
  const t0 = now()
  const mm = new MindMap({
    el: host,
    data: makeTree(n),
    layout: 'logicalStructure',
    fit: false,
    openPerformance: true,
    addHistoryTime: 0,
    createNewNodeBehavior: 'NOT_ACTIVE',
    performanceFlags: flags,
    errorHandler: (type, error) => {
      window.__renderErrors = window.__renderErrors || []
      window.__renderErrors.push(String(type) + ':' + String((error && error.message) || error))
    }
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('init timeout')), 180000)
    mm.on('render_complete', function f() {
      clearTimeout(t)
      mm.off('render_complete', f)
      resolve()
    })
  })
  observer.disconnect()
  const wall = now() - t0
  const dom = {
    groups: document.querySelectorAll('g.smm-node').length,
    paths: document.querySelectorAll('path').length,
    svg: document.querySelectorAll('svg *').length,
    model: mm.renderer.nodeIndex.size
  }
  mm.destroy()
  host.remove()
  host = null
  return {
    label,
    wall: +wall.toFixed(1),
    bbox: counters.bbox,
    layouts: counters.layouts,
    nodeRender: counters.nodeRender,
    mutAdd,
    mutRemove,
    phases: {
      layout: +phases.layout.toFixed(1),
      index: +phases.index.toFixed(1),
      paintViewport: +phases.paintViewport.toFixed(1),
      nodeRender: +phases.nodeRender.toFixed(1)
    },
    dom
  }
}
window.ready = true
`

function pct(list, p) {
  if (!list.length) return null
  const sorted = list.slice().sort((a, b) => a - b)
  return +sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))].toFixed(1)
}

function summarize(rows) {
  const walls = rows.map(row => row.wall)
  const bbox = rows.map(row => row.bbox)
  const nodeRender = rows.map(row => row.nodeRender)
  const mutAdd = rows.map(row => row.mutAdd)
  return {
    n: rows.length,
    wall: { p50: pct(walls, 0.5), p95: pct(walls, 0.95), min: Math.min(...walls), max: Math.max(...walls) },
    bbox: { p50: pct(bbox, 0.5), p95: pct(bbox, 0.95) },
    nodeRender: { p50: pct(nodeRender, 0.5), p95: pct(nodeRender, 0.95) },
    mutAdd: { p50: pct(mutAdd, 0.5), p95: pct(mutAdd, 0.95) },
    phases: {
      layout: pct(rows.map(row => row.phases.layout), 0.5),
      index: pct(rows.map(row => row.phases.index), 0.5),
      paintViewport: pct(rows.map(row => row.phases.paintViewport), 0.5),
      nodeRender: pct(rows.map(row => row.phases.nodeRender), 0.5)
    },
    lastDom: rows[rows.length - 1] && rows[rows.length - 1].dom
  }
}

async function main() {
  const outDir = path.join(repo, 'output', 'p2b-first-render-repeat')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { startedAt: new Date().toISOString(), size: SIZE, rounds: ROUNDS, runs: [], errors: [] }
  const save = () => fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2))
  try {
    const page = await harness.newPage()
    page.setDefaultTimeout(900000)
    await page.waitForFunction(() => window.ready)
    for (let i = 0; i < ROUNDS * 2; i++) {
      const useAb = i % 2 === 1
      const flags = useAb ? P1AB : P1
      const label = useAb ? 'p1ab' : 'p1'
      const row = await page.evaluate(([n, f, name]) => window.runFirst(n, f, name), [SIZE, flags, label])
      report.runs.push(row)
      console.log('run', JSON.stringify(row))
      save()
    }
    report.p1 = summarize(report.runs.filter(row => row.label === 'p1'))
    report.p1ab = summarize(report.runs.filter(row => row.label === 'p1ab'))
    const ratio = report.p1.wall.p50 && report.p1ab.wall.p50
      ? +(report.p1ab.wall.p50 / report.p1.wall.p50).toFixed(3)
      : null
    report.verdict = {
      p50Ratio: ratio,
      likelyRealRegression: ratio != null && ratio >= 1.15 && report.p1ab.wall.p50 - report.p1.wall.p50 >= 400,
      likelyNoise: ratio != null && Math.abs(ratio - 1) < 0.1
    }
    console.log('summary', JSON.stringify({ p1: report.p1, p1ab: report.p1ab, verdict: report.verdict }))
    save()
    await page.close()
  } catch (error) {
    report.errors.push(String((error && error.stack) || error))
    console.error(error)
    save()
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
