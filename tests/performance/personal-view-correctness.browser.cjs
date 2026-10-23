// Isolated personal-view correctness. No production rooms.
// node tests/performance/personal-view-correctness.browser.cjs
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

const entry = `
import MindMap from './simple-mind-map/index.js'
import Search from './simple-mind-map/src/plugins/Search.js'
import Cooperate from './simple-mind-map/src/plugins/Cooperate.js'
MindMap.usePlugin(Search)

function tree() {
  return {
    data: { uid: 'root', text: '根', expand: true },
    children: [{
      data: { uid: 'collapsed', text: '折叠父', expand: false },
      children: [{ data: { uid: 'hidden', text: '隐藏目标词', expand: true }, children: [] }]
    }, {
      data: { uid: 'open', text: '展开父', expand: true },
      children: [{ data: { uid: 'leaf', text: '叶子', expand: true }, children: [] }]
    }]
  }
}

let host = null
async function create(flags) {
  if (host) host.remove()
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px'
  document.body.appendChild(host)
  const mm = new MindMap({
    el: host,
    data: tree(),
    layout: 'logicalStructure',
    fit: false,
    openPerformance: true,
    addHistoryTime: 0,
    performanceFlags: flags || {},
    errorHandler: () => {}
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('init timeout')), 30000)
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

window.probe = async flags => {
  const mm = await create(flags)
  const preference = { root: true, collapsed: false, hidden: true, open: true, leaf: true }
  const persistEvents = []
  const userCommands = []
  mm.on('personal_expand_change', meta => persistEvents.push(meta || {}))
  mm.on('afterExecCommand', (name, node, patch) => {
    if (name === 'SET_NODE_EXPAND') userCommands.push(name)
    if (name === 'SET_NODE_DATA' && patch && Object.prototype.hasOwnProperty.call(patch, 'expand')) {
      userCommands.push(name)
    }
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('search timeout')), 15000)
    mm.search.search('隐藏目标词', () => { clearTimeout(t); resolve() })
  })
  const afterSearch = expandMap(mm)
  const revealOnly = persistEvents.length > 0 && persistEvents.every(meta => meta.source === 'reveal')
  const searchUsedUserCommand = userCommands.length > 0
  mm.renderer.setNodeExpand(mm.renderer.findNodeByUid('open'), false)
  await new Promise(r => setTimeout(r, 50))
  const afterUser = expandMap(mm)
  const userEvent = userCommands.includes('SET_NODE_DATA') || userCommands.includes('SET_NODE_EXPAND')
  const coop = Object.create(Cooperate.prototype)
  coop.mindMap = mm
  coop.applyHttpRemoteNodeFields(mm.renderer.findNodeByUid('open'), {
    expand: true,
    fillColor: '#ffeeaa'
  })
  const afterRemote = mm.renderer.findNodeByUid('open').getData('expand')
  mm.destroy()
  host.remove()
  host = null
  return {
    flags: Object.keys(flags || {}).length ? 'p1ab' : 'off',
    afterSearchParent: afterSearch.collapsed,
    revealOnly,
    searchUsedUserCommand,
    afterUserOpen: afterUser.open,
    userEvent,
    remoteDidNotExpand: afterRemote === false,
    preferenceUnchanged: preference.collapsed === false
  }
}
window.ready = true
`

async function main() {
  const outDir = path.join(repo, 'output', 'personal-view-correctness')
  fs.mkdirSync(outDir, { recursive: true })
  const harness = await createHarness({ contents: entry })
  const report = { startedAt: new Date().toISOString(), errors: [] }
  try {
    const page = await harness.newPage()
    page.setDefaultTimeout(120000)
    await page.waitForFunction(() => window.ready)
    report.off = await page.evaluate(() => window.probe({}))
    report.p1ab = await page.evaluate(f => window.probe(f), P1AB)
    console.log(JSON.stringify({ off: report.off, p1ab: report.p1ab }))
    await page.close()
  } catch (error) {
    report.errors.push(String((error && error.stack) || error))
    console.error(error)
  } finally {
    report.harnessErrors = harness.errors.slice(0, 20)
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2))
    await harness.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
