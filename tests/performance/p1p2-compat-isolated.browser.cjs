// Isolated P1+P2-A/B compatibility. Synthetic data only. No production rooms.
// node tests/performance/p1p2-compat-isolated.browser.cjs
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, repo } = require('./engine-harness.cjs')

const P1AB = {
  canvasTextMeasure: true,
  scopedRemoteLineRender: true,
  scopedRemoteGeometry: true,
  deferDraftCopy: true,
  analyticEdgeBounds: true,
  lazyOffscreenPaint: true
}

const LAYOUTS = [
  'logicalStructure',
  'logicalStructureLeft',
  'mindMap',
  'organizationStructure',
  'catalogOrganization',
  'timeline',
  'timeline2',
  'verticalTimeline',
  'fishbone'
]

const entry = `
import MindMap from './simple-mind-map/index.js'
import Export from './simple-mind-map/src/plugins/Export.js'
import ExportPDF from './simple-mind-map/src/plugins/ExportPDF.js'
import ExportXMind from './simple-mind-map/src/plugins/ExportXMind.js'
import MiniMap from './simple-mind-map/src/plugins/MiniMap.js'
import Search from './simple-mind-map/src/plugins/Search.js'
import AssociativeLine from './simple-mind-map/src/plugins/AssociativeLine.js'
MindMap.usePlugin(Export).usePlugin(ExportPDF).usePlugin(ExportXMind)
  .usePlugin(MiniMap).usePlugin(Search).usePlugin(AssociativeLine)

function featuredTree() {
  return {
    data: { uid: 'root', text: '根节点', expand: true },
    children: [
      {
        data: {
          uid: 'feat',
          text: '特性节点',
          expand: true,
          note: '备注内容',
          comments: [{ id: 'c1', content: '一条评论', createdAt: 1 }],
          hyperlink: 'https://example.com/doc',
          hyperlinkTitle: '文档',
          attachmentUrl: 'https://example.com/a.pdf',
          attachmentName: '附件.pdf'
        },
        children: [
          { data: { uid: 'leaf-a', text: '可搜索叶子甲', expand: true }, children: [] },
          { data: { uid: 'leaf-b', text: '普通叶子乙', expand: true }, children: [] }
        ]
      },
      {
        data: { uid: 'collapsed', text: '折叠父', expand: false },
        children: [
          { data: { uid: 'hidden', text: '隐藏目标词', expand: true }, children: [] }
        ]
      }
    ]
  }
}

let host = null
async function create(data, options = {}) {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host)
  const mm = new MindMap({
    el: host,
    data: JSON.parse(JSON.stringify(data)),
    layout: options.layout || 'logicalStructure',
    fit: false,
    openPerformance: true,
    addHistoryTime: 0,
    createNewNodeBehavior: 'NOT_ACTIVE',
    performanceFlags: options.performanceFlags || {},
    errorHandler: (type, error) => {
      window.__compatErrors = window.__compatErrors || []
      window.__compatErrors.push(String(type) + ':' + String((error && error.message) || error))
    }
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('init timeout ' + (options.layout || ''))), 60000)
    mm.on('render_complete', function f() {
      clearTimeout(t)
      mm.off('render_complete', f)
      resolve()
    })
  })
  return mm
}

function expandMap(mm) {
  const out = {}
  const walk = node => {
    if (!node || !node.data) return
    if (node.data.uid) out[node.data.uid] = node.data.expand !== false
    ;(node.children || []).forEach(walk)
  }
  walk(mm.renderer.renderTree)
  return out
}

function geometry(mm) {
  return Array.from(mm.renderer.nodeIndex.values())
    .map(node => ({
      uid: node.getData('uid'),
      l: +Number(node.left).toFixed(1),
      t: +Number(node.top).toFixed(1),
      w: node.width,
      h: node.height
    }))
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
}

window.runLayouts = async flags => {
  const results = []
  for (const layout of ${JSON.stringify(LAYOUTS)}) {
    try {
      const mm = await create(featuredTree(), { layout, performanceFlags: flags })
      const feat = mm.renderer.findNodeByUid('feat')
      const data = feat ? feat.getData() : {}
      results.push({
        layout,
        ok: true,
        nodes: mm.renderer.nodeIndex.size,
        groups: document.querySelectorAll('g.smm-node').length,
        note: data.note || null,
        comments: Array.isArray(data.comments) ? data.comments.length : 0,
        hyperlink: data.hyperlink || null,
        attachment: data.attachmentName || null,
        expand: expandMap(mm)
      })
      mm.destroy()
    } catch (error) {
      results.push({ layout, ok: false, error: String((error && error.message) || error) })
    }
  }
  host && host.remove()
  host = null
  return results
}

window.runFeatures = async flags => {
  const mm = await create(featuredTree(), { performanceFlags: flags })
  const out = { flags: Object.keys(flags).length ? 'p1ab' : 'off', errors: [] }
  try {
    const outline = mm.miniMap.getOutline()
    out.minimap = { hasSvg: !!(outline && outline.svgStr), width: outline && outline.bounds && outline.bounds.width }
  } catch (error) {
    out.minimap = { ok: false, error: String(error) }
    out.errors.push('minimap')
  }
  try {
    const from = mm.renderer.findNodeByUid('leaf-a')
    const to = mm.renderer.findNodeByUid('leaf-b')
    mm.execCommand('ADD_ASSOCIATIVE_LINE', from, to)
    await new Promise(r => setTimeout(r, 50))
    const targets = from.getData('associativeLineTargets') || []
    out.associative = { ok: targets.includes('leaf-b'), targets }
  } catch (error) {
    out.associative = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('associative')
  }
  const beforeSearch = expandMap(mm)
  const expandEvents = []
  mm.on('personal_expand_change', () => expandEvents.push(Date.now()))
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('search timeout')), 15000)
      mm.search.search('隐藏目标词', () => {
        clearTimeout(t)
        resolve()
      })
    })
    const after = expandMap(mm)
    const found = mm.renderer.findNodeByUid('hidden')
    out.search = {
      ok: !!found,
      parentExpanded: after.collapsed === true,
      preferenceEvent: expandEvents.length > 0,
      expandChanged: JSON.stringify(beforeSearch) !== JSON.stringify(after)
    }
  } catch (error) {
    out.search = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('search')
  }
  try {
    const svg = await mm.doExport.svg('compat')
    out.svg = { ok: typeof svg === 'string' ? svg.length > 100 : !!(svg && (svg.length || svg.size)), bytes: (svg && svg.length) || (svg && svg.size) || 0 }
  } catch (error) {
    out.svg = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('svg')
  }
  try {
    const png = await mm.doExport.png()
    out.png = { ok: !!(png && (png.size || png.length || png.width)), detail: png && (png.size || png.length || Object.keys(png)) }
  } catch (error) {
    out.png = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('png')
  }
  try {
    const pdf = await mm.doExport.pdf('compat')
    out.pdf = { ok: !!(pdf && (pdf.size || pdf.length || pdf.byteLength)), bytes: (pdf && (pdf.size || pdf.length || pdf.byteLength)) || 0 }
  } catch (error) {
    out.pdf = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('pdf')
  }
  try {
    const xmind = await mm.doExport.xmind('compat')
    out.xmind = { ok: !!(xmind && (xmind.size || xmind.length || xmind.byteLength)), bytes: (xmind && (xmind.size || xmind.length || xmind.byteLength)) || 0 }
  } catch (error) {
    out.xmind = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('xmind')
  }
  try {
    const leaf = mm.renderer.findNodeByUid('leaf-a')
    const before = leaf.getData('text')
    mm.execCommand('SET_NODE_TEXT', leaf, '撤销重做探测')
    await new Promise(r => mm.once ? mm.once('render_complete', r) : setTimeout(r, 80))
    if (typeof mm.execCommand === 'function') mm.execCommand('BACK')
    await new Promise(r => setTimeout(r, 80))
    const afterBack = mm.renderer.findNodeByUid('leaf-a').getData('text')
    mm.execCommand('FORWARD')
    await new Promise(r => setTimeout(r, 80))
    const afterForward = mm.renderer.findNodeByUid('leaf-a').getData('text')
    out.undo = { before, afterBack, afterForward, backRestored: afterBack === before }
  } catch (error) {
    out.undo = { ok: false, error: String((error && error.message) || error) }
    out.errors.push('undo')
  }
  mm.destroy()
  host.remove()
  host = null
  return out
}

window.compareGeometry = async () => {
  const off = await create(featuredTree(), { performanceFlags: {} })
  const geoOff = geometry(off)
  const expOff = expandMap(off)
  off.destroy()
  const on = await create(featuredTree(), { performanceFlags: ${JSON.stringify(P1AB)} })
  const geoOn = geometry(on)
  const expOn = expandMap(on)
  on.destroy()
  host && host.remove()
  host = null
  const diffs = []
  geoOff.forEach((a, i) => {
    const b = geoOn[i]
    if (!b) return
    if (Math.abs(a.l - b.l) > 1 || Math.abs(a.t - b.t) > 1 || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1) {
      diffs.push({ uid: a.uid, a, b })
    }
  })
  return { diffs, expandEqual: JSON.stringify(expOff) === JSON.stringify(expOn), nodes: geoOff.length }
}

window.ready = true
`

async function main() {
  const outDir = path.join(repo, 'output', 'p1p2-compat-isolated')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { startedAt: new Date().toISOString(), errors: [] }
  const save = () => fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2))
  try {
    const page = await harness.newPage()
    page.setDefaultTimeout(900000)
    await page.waitForFunction(() => window.ready)
    report.geometry = await page.evaluate(() => window.compareGeometry())
    console.log('geometry', JSON.stringify(report.geometry))
    report.layoutsOff = await page.evaluate(() => window.runLayouts({}))
    report.layoutsOn = await page.evaluate(f => window.runLayouts(f), P1AB)
    console.log('layouts', JSON.stringify({
      off: report.layoutsOff.map(item => ({ layout: item.layout, ok: item.ok, nodes: item.nodes })),
      on: report.layoutsOn.map(item => ({ layout: item.layout, ok: item.ok, nodes: item.nodes }))
    }))
    report.featuresOff = await page.evaluate(() => window.runFeatures({}))
    report.featuresOn = await page.evaluate(f => window.runFeatures(f), P1AB)
    console.log('features-off', JSON.stringify(report.featuresOff))
    console.log('features-on', JSON.stringify(report.featuresOn))
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
