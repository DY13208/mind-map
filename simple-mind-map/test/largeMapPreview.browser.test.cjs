const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('@playwright/test')
const esbuild = require('../../web/node_modules/esbuild')
const compiler = require('../../web/node_modules/vue-template-compiler')
const JSZip = require('jszip')

async function main() {
  const repo = path.resolve(__dirname, '../..')
  const xmindPath = process.env.XMIND_FIXTURE || 'C:/Users/Sbs/Downloads/目的论项目.xmind'
  let xmindFixture = null
  if (fs.existsSync(xmindPath)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(xmindPath))
    const sheets = JSON.parse(await zip.file('content.json').async('string'))
    const root = sheets[0].rootTopic
    const convert = topic => ({ data: { uid: topic.id, text: topic.title || '',
      expand: topic.branch !== 'folded' }, children: [] })
    xmindFixture = convert(root)
    const queue = [{ source: root, target: xmindFixture }]
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      for (const child of Object.values(item.source.children || {}).flat()) {
        const target = convert(child)
        item.target.children.push(target)
        queue.push({ source: child, target })
      }
    }
  }
  const build = await esbuild.build({
    stdin: { resolveDir: repo, contents: `
      import Vue from './web/node_modules/vue/dist/vue.esm.js'
      import ElementUI from './web/node_modules/element-ui'
      import MindMap from './simple-mind-map/index.js'
      import Cooperate from './simple-mind-map/src/plugins/Cooperate.js'
      import { stubImportedTree } from './web/src/utils/importTree.js'
      import Preview from './web/src/pages/ProductShell/components/HistoryMapPreview.vue'
      import { treeTask } from './web/src/utils/treeWorker.js'
      Vue.use(ElementUI)
      window.Vue = Vue
      window.errors = []
      window.longTasks = []
      if (typeof PerformanceObserver !== 'undefined') new PerformanceObserver(list => {
        list.getEntries().forEach(entry => window.longTasks.push(entry.duration))
      }).observe({ type: 'longtask', buffered: true })
      window.fixture = (count, wide = false) => {
        const rows = Array.from({length: count}, (_, i) => ({data:{uid:'n'+i,text:'Node '+i,expand:true}, children:[]}))
        for (let i=1;i<count;i++) rows[wide ? 0 : Math.floor((i-1)/8)].children.push(rows[i])
        return rows[0]
      }
      window.treeTask = treeTask
      window.mountPreview = async (count, wide=false) => {
        if (window.host) window.host.$destroy()
        document.getElementById('preview').innerHTML = '<div id="mount"></div>'
        const started=performance.now()
        const sessionId='test-'+count+'-'+Date.now()
        const projection=await treeTask('prepare',{graph:fixture(count,wide),sessionId})
        window.host = new Vue({data:{tree:Object.freeze(projection.tree),projection,active:true},
          render(h){return h(Preview,{ref:'preview',props:{tree:this.tree,projection:this.projection,active:this.active}})}}).$mount('#mount')
        window.preview=host.$refs.preview
        preview.$on('failed', error=>console.error(error.stack))
        return {started,sessionId}
      }
      window.waitRender = mm => new Promise((resolve,reject) => {
        const done=()=>{mm.off('render_error',bad);resolve()}
        const bad=e=>{mm.off('render_error',bad);reject(e)}
        mm.on('render_error',bad);mm.render(done)
      })
      window.checkPaginatedHydration = async () => {
        const source = fixture(1000, true).children
        const offsets = []
        const fake = {
          httpFetchSubtree: async (uid, options) => {
            offsets.push(options.offset)
            return { children: source.slice(options.offset, options.offset + options.limit),
              total: source.length, has_more: options.offset + options.limit < source.length }
          }, dirtySubtrees: new Map(), hydratedUids: new Set(),
          markUidPushed() {}, isTombstonedUid() { return false },
          mergeHttpChildren: Cooperate.prototype.mergeHttpChildren
        }
        const node = { data: { uid:'root', childCount:source.length }, children:[] }
        while(node.children.length < source.length) await Cooperate.prototype.hydrateNodeData.call(fake,node,{paginated:true})
        return { count:node.children.length, offsets, last:node.children.at(-1).data.uid }
      }
      window.mountMap = async (count, cooperative=true) => {
        if(window.mm) window.mm.destroy()
        document.getElementById('map').innerHTML=''
        const started=performance.now()
        window.mm=new MindMap({el:document.getElementById('map'),data:fixture(count),openPerformance:true,cooperativeRendering:cooperative,fit:false})
        mm.on('render_error',error=>window.errors.push(error.message))
        await waitRender(mm)
        return performance.now()-started
      }
      window.mountInstantOverview = async count => {
        if(window.mm) window.mm.destroy()
        document.getElementById('map').innerHTML=''
        const source=fixture(count,true)
        const originalCount=count
        const started=performance.now()
        stubImportedTree(source,{keepDepth:1,maxNodes:280,maxChildren:24})
        source.data.expand=true
        window.mm=new MindMap({el:document.getElementById('map'),data:source,openPerformance:true,cooperativeRendering:true,fit:false})
        mm.renderer._forceOverviewPaintOnce=true
        await waitRender(mm)
        mm.view.fit()
        const elapsed=performance.now()-started
        await new Promise(resolve=>setTimeout(resolve,350))
        return { elapsed, originalCount,
          shown:Object.keys(mm.renderer.nodeCache).length,
          scale:mm.view.scale,
          simplified:Object.values(mm.renderer.nodeCache).filter(node=>node._overviewGroup && node._overviewGroup.node.isConnected && getComputedStyle(node._overviewGroup.node).display!=='none').length,
          connected:Array.from(mm.nodeDraw.node.querySelectorAll('.smm-node')).filter(el=>el.isConnected && getComputedStyle(el).visibility==='visible' && getComputedStyle(el).display!=='none').length,
          lineCount:mm.lineDraw.node.children.length,
          overlay:!!document.querySelector('.smm-progress-loading') }
      }
    ` }, bundle: true, write: false, platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { 'simple-mind-map': path.join(repo, 'simple-mind-map'), '@': path.join(repo, 'web/src') },
    nodePaths: [path.join(repo, 'web/node_modules')], loader: { '.css': 'empty' },
    plugins: [{ name: 'vue', setup(build) {
      build.onLoad({ filter: /\.vue$/ }, args => {
        const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
        return { contents: parsed.script.content.replace('export default', 'const component =') +
          '\ncomponent.template = ' + JSON.stringify(parsed.template.content) + '\nexport default component',
        resolveDir: path.dirname(args.path), loader: 'js' }
      })
    } }]
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(build.outputFiles[0].contents) }
    else if (req.url === '/fixture.json' && xmindFixture) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tree: xmindFixture })) }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><style>
      #map{width:1100px;height:700px}#preview{width:1100px;height:700px}
      .historyMapPreview{display:flex;flex-direction:column;height:700px}.previewCanvas{flex:1;min-height:500px;position:relative}.previewToolbar{display:flex;gap:8px;flex-wrap:wrap}
    </style><div id="preview"></div><div id="map"></div><script src="/test.js"></script>`) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  const results = {}
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(60000)
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR', error.message) })
    page.on('console', message => { if (message.type() === 'error') console.log(message.text()) })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => typeof window.checkPaginatedHydration === 'function')
    const hydration = await page.evaluate(() => checkPaginatedHydration())
    assert.equal(hydration.count, 999)
    assert.equal(hydration.last, 'n999')
    assert.deepEqual(hydration.offsets, Array.from({ length: 21 }, (_, i) => i * 48))
    results.paginatedHydration = true
    for (const count of [1000, 10000, 30000]) {
      const { started, sessionId } = await page.evaluate(count => mountPreview(count, true), count)
      await page.waitForFunction(() => preview._state.preview && !preview.preparing && !preview._state.preview.renderer.isRendering && Object.keys(preview._state.preview.renderer.nodeCache).length === 49 && preview.status.includes('共'))
      await page.waitForTimeout(150)
      const metrics = await page.evaluate(started => ({ elapsed: performance.now()-started, nodes:Object.keys(preview._state.preview.renderer.nodeCache).length, observed:!!preview._state.preview.__ob__ }), started)
      assert.equal(metrics.nodes, 49)
      assert.equal(metrics.observed, false)
      results['preview' + count] = metrics
      await page.evaluate(async () => {
        preview.selectNode(preview._state.preview.renderer.root)
        await preview.loadMore()
      })
      assert.equal(await page.evaluate(() => preview._state.preview.renderer.renderTree.children.length), 96)
      await page.evaluate(async count => { preview.query='Node '+(count-1); await preview.search() }, count)
      assert.equal(await page.evaluate(count => !!preview._state.preview.renderer.findNodeByUid('n'+(count-1)), count), true)
      await page.evaluate(() => { preview.expandAll(); setTimeout(()=>preview.cancelExpansion(), 20) })
      await page.waitForFunction(() => !preview.busy)
      await page.evaluate(async () => { host.active=false; await Vue.nextTick() })
      await page.evaluate(sessionId => treeTask('release',{sessionId}), sessionId)
      console.log('preview', count, metrics)
    }
    if (xmindFixture) {
      const actual = await page.evaluate(async () => {
        const raw = await (await fetch('/fixture.json')).text()
        const start = performance.now()
        const result = await treeTask('historyResponse', { raw, sessionId: 'real-xmind' })
        host.active = true
        host.tree = Object.freeze(result.tree)
        host.projection = result.projection
        return { nodeCount: result.projection.nodeCount, processingMs: performance.now() - start }
      })
      await page.waitForFunction(() => preview.status.includes('共 10401 个节点'))
      assert.equal(actual.nodeCount, 10401)
      assert.ok(await page.evaluate(() => Object.keys(preview._state.preview.renderer.nodeCache).length) <= 280)
      await page.evaluate(() => treeTask('release', { sessionId: 'real-xmind' }))
      results.realXmind = actual
      console.log('real XMind', actual)
    }
    const lifecycle = await page.evaluate(async () => {
      let maxDom = 0
      for (let i = 0; i < 20; i++) {
        const { sessionId } = await mountPreview(1000, false)
        while (!preview._state.preview || preview.preparing) await new Promise(r => setTimeout(r, 20))
        maxDom = Math.max(maxDom, document.querySelectorAll('.smm-node').length)
        host.active = false
        await Vue.nextTick()
        await treeTask('release', { sessionId })
      }
      return { maxDom, remainingDom: document.querySelectorAll('.smm-node').length }
    })
    assert.ok(lifecycle.maxDom <= 300, JSON.stringify(lifecycle))
    assert.equal(lifecycle.remainingDom, 0)
    results.lifecycle = lifecycle
    const fallbackPage = await browser.newPage()
    await fallbackPage.addInitScript(() => { window.Worker = undefined })
    await fallbackPage.goto('http://127.0.0.1:' + server.address().port)
    await fallbackPage.waitForFunction(() => typeof window.mountPreview === 'function')
    await fallbackPage.evaluate(() => mountPreview(1000, true))
    await fallbackPage.waitForFunction(() => window.preview && preview.status.includes('共 1000 个节点'))
    assert.equal(await fallbackPage.evaluate(() => preview._state.count), 1000)
    await fallbackPage.close()
    results.noWorkerFallback = true
    await page.evaluate(() => { window.longTasks = [] })
    results.legacy1000Ms = await page.evaluate(() => mountMap(1000, false))
    await page.waitForTimeout(50)
    results.legacyLongTasks = await page.evaluate(() => window.longTasks.slice())
    await page.evaluate(() => { window.longTasks = [] })
    results.cooperative1000Ms = await page.evaluate(() => mountMap(1000, true))
    await page.waitForTimeout(50)
    results.cooperativeLongTasks = await page.evaluate(() => window.longTasks.slice())
    const instantOverview = await page.evaluate(() => mountInstantOverview(10000))
    assert.ok(instantOverview.elapsed < 1000, JSON.stringify(instantOverview))
    assert.equal(instantOverview.shown, 25)
    assert.ok(instantOverview.connected >= 25, JSON.stringify(instantOverview))
    assert.equal(instantOverview.simplified, 0, JSON.stringify(instantOverview))
    assert.ok(instantOverview.lineCount > 1, JSON.stringify(instantOverview))
    assert.equal(instantOverview.overlay, false)
    results.instantOverview = instantOverview
    await page.evaluate(() => mountMap(1000, true))
    const cancelledLayout = await page.evaluate(async () => {
      mm.setLayout('organizationStructure')
      const pending = mm.renderer.waitForRender().then(() => 'completed', () => 'cancelled')
      mm.renderer._render()
      const duringVisibility = getComputedStyle(mm.nodeDraw.node).visibility
      mm.setLayout('mindMap')
      const oldResult = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('stuck'), 2000))])
      await waitRender(mm)
      return { oldResult, duringVisibility, nodeVisibility: getComputedStyle(mm.nodeDraw.node).visibility, lineVisibility: getComputedStyle(mm.lineDraw.node).visibility }
    })
    assert.equal(cancelledLayout.oldResult, 'cancelled', 'layout switch must settle pending render')
    assert.equal(cancelledLayout.duringVisibility, 'visible')
    assert.equal(cancelledLayout.nodeVisibility, 'visible')
    assert.equal(cancelledLayout.lineVisibility, 'visible')
    results.cancelledLayout = cancelledLayout
    for (const layout of ['logicalStructure','logicalStructureLeft','mindMap','catalogOrganization','organizationStructure','timeline','timeline2','verticalTimeline','verticalTimeline2','verticalTimeline3','fishbone','fishbone2']) {
      await page.evaluate(async layout => { mm.setLayout(layout); await waitRender(mm) }, layout)
      const state = await page.evaluate(() => ({ count:Object.keys(mm.renderer.nodeCache).length, rendering:mm.renderer.isRendering, errors:window.errors }))
      assert.equal(state.count, 1000, layout)
      assert.equal(state.rendering, false, layout)
      assert.deepEqual(state.errors, [], layout)
      assert.ok(await page.evaluate(() => Array.from(mm.nodeDraw.node.querySelectorAll('.smm-node')).some(el => getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).display !== 'none')), layout + ' must show node content')
      console.log('layout', layout, 'PASS')
    }
    await page.evaluate(async () => {
      mm.setLayout('mindMap'); await waitRender(mm)
      mm.view.setScale(0.1); await new Promise(r=>setTimeout(r,500))
    })
    const simplified = await page.evaluate(() => Object.values(mm.renderer.nodeCache).filter(node=>node._overviewGroup && node._overviewGroup.node.isConnected).length)
    assert.ok(simplified > 0, 'overview uses lightweight geometry')
    await page.evaluate(async () => { mm.view.setScale(1); await new Promise(r=>setTimeout(r,500)); await waitRender(mm) })
    await page.evaluate(async () => {
      mm.setData(fixture(5000)); mm.setData(fixture(80)); await waitRender(mm)
    })
    assert.equal(await page.evaluate(() => Object.keys(mm.renderer.nodeCache).length), 80)
    await page.evaluate(async () => {
      await mountMap(1000)
      await mm.renderer.unexpandAllNode(false)
      await waitRender(mm)
      await mm.renderer.expandAllNode()
    })
    assert.equal(await page.evaluate(() => Object.keys(mm.renderer.nodeCache).length), 1000, 'all expansion must exceed old 200-node cap')
    await page.evaluate(() => { window.longTasks = [] })
    results.cooperative10000Ms = await page.evaluate(() => mountMap(10000, true))
    await page.waitForTimeout(50)
    results.cooperative10000LongTasks = await page.evaluate(() => window.longTasks.slice())
    assert.ok(Math.max(0, ...results.cooperative10000LongTasks) < 200,
      '10k cooperative render should not block the main thread for 200ms')
    assert.deepEqual(errors, [])
    const output = path.join(repo, 'output/large-map')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2))
    console.log('PASS large-map browser scenarios', JSON.stringify(results))
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
