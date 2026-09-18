const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { chromium } = require('@playwright/test')
const esbuild = require('../../web/node_modules/esbuild')
const compiler = require('../../web/node_modules/vue-template-compiler')

// Exercise the real search panel, renderer, personal view restoration and HTTP
// reveal path in an isolated browser; no existing workspace data is changed.
async function main() {
  const repo = path.resolve(__dirname, '../..')
  const build = await esbuild.build({
    stdin: {
      resolveDir: repo,
      contents: `
        import Vue from './web/node_modules/vue/dist/vue.esm.js'
        import ElementUI from './web/node_modules/element-ui'
        import MindMap from './simple-mind-map/index.js'
        import Search from './simple-mind-map/src/plugins/Search.js'
        import Cooperate from './simple-mind-map/src/plugins/Cooperate.js'
        import SearchPanel from './web/src/pages/Edit/components/Search.vue'
        import { collectPersonalExpandState, applyPersonalExpandState } from './web/src/utils/personalExpandState.js'
        Vue.use(ElementUI)
        Vue.prototype.$bus = new Vue()
        Vue.prototype.$t = key => key
        Vue.prototype.$store = { state: { isReadonly: false, localConfig: { isDark: false } } }
        MindMap.usePlugin(Search)
        const leaf = { data: { uid: 'needle', text: 'Search needle' }, children: [] }
        const deep = { data: { uid: 'deep', text: 'Deep', expand: false, childCount: 1 }, children: [leaf] }
        const branch = { data: { uid: 'branch', text: 'Branch', expand: false, childCount: 1 }, children: [deep] }
        const other = { data: { uid: 'other', text: 'Other', expand: false }, children: [{ data: { uid: 'other-leaf', text: 'Other leaf' }, children: [] }] }
        const tree = { data: { uid: 'root', text: 'Root', expand: true }, children: [branch, other] }
        const clone = data => JSON.parse(JSON.stringify(data))
        const mm = new MindMap({ el: document.getElementById('map'), data: clone(tree), isOnlySearchCurrentRenderNodes: false })
        const panel = new Vue({ render: h => h(SearchPanel, { props: { mindMap: mm } }) }).$mount('#panel').$children[0]
        let saved = { root: true, branch: false, deep: false, other: false }
        mm.on('personal_expand_change', () => { saved = collectPersonalExpandState(mm, saved) })
        mm.on('node_tree_render_end', () => { if (applyPersonalExpandState(mm, saved)) mm.render() })
        const render = action => new Promise(resolve => {
          const done = () => { mm.off('node_tree_render_end', done); resolve() }
          mm.on('node_tree_render_end', done)
          action()
        })
        window.prepare = async (lazy, readonly = false, local = false) => {
          panel.close()
          saved = { root: true, branch: false, deep: false, other: false }
          const initial = clone(tree)
          if (lazy) initial.children[0].children = []
          mm.opt.readonly = readonly
          await render(() => mm.setData(initial))
          const cooperate = Object.create(Cooperate.prototype)
          Object.assign(cooperate, {
            mindMap: mm, httpCollabMode: true, httpRoomKey: 'search-fixture',
            hydratedUids: new Set(), dirtySubtrees: new Map(), lastPushed: {},
            isTombstonedUid: () => false, flushPendingHttpRefresh() {},
            fetches: [],
            async httpFetchLocate(uid) {
              this.fetches.push('locate:' + uid)
              await new Promise(resolve => setTimeout(resolve, 30))
              if (uid !== 'needle') return null
              const nodes = {}
              for (const node of [tree, branch, deep, leaf]) {
                nodes[node.data.uid] = { data: clone(node.data), children: [] }
              }
              return { ancestors: ['root', 'branch', 'deep', 'needle'], nodes }
            },
            async httpFetchSubtree(uid) {
              this.fetches.push('subtree:' + uid)
              await new Promise(resolve => setTimeout(resolve, 30))
              const source = [tree, branch, deep, leaf].find(node => node.data.uid === uid)
              return { children: (source.children || []).map(node => ({ data: clone(node.data), children: [] })), total: source.children.length }
            }
          })
          mm.cooperate = local ? null : cooperate
          panel.show = true
          if (local) {
            // Populate matches without auto-revealing so the actual result click is tested.
            mm.search.isSearching = true
            mm.search.searchText = 'needle'
            mm.search.doSearch()
          } else {
            panel.applySearchHits([{ uid: 'needle', text: 'Search needle' }], 'needle')
          }
          panel.showSearchResultList = true
          await Vue.nextTick()
          window.mm = mm
          window.cooperate = cooperate
        }
        window.inspectReveal = () => {
          const node = mm.renderer.findNodeByUid('needle')
          const rect = node && node.group.node.getBoundingClientRect()
          const mapRect = document.getElementById('map').getBoundingClientRect()
          // The group bounds also include the floating add-child button.
          const center = node && new DOMPoint(node.width / 2, node.height / 2).matrixTransform(node.group.node.getScreenCTM())
          return {
            visible: !!(node && node.group.node.isConnected && rect.width > 0),
            centered: !!center && Math.abs(center.x - (mapRect.x + mapRect.width / 2)) < 4 && Math.abs(center.y - (mapRect.y + mapRect.height / 2)) < 4,
            branch: saved.branch, deep: saved.deep, other: saved.other,
            active: !!node && node.getData('isActive'),
            fetches: window.cooperate.fetches
          }
        }
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { 'simple-mind-map': path.join(repo, 'simple-mind-map'), '@': path.join(repo, 'web/src') },
    nodePaths: [path.join(repo, 'web/node_modules')],
    loader: { '.css': 'empty' },
    plugins: [{
      name: 'search-panel',
      setup(build) {
        build.onLoad({ filter: /Search\.vue$/ }, args => {
          const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
          return {
            contents: parsed.script.content.replace('export default', 'const component =') +
              '\ncomponent.template = ' + JSON.stringify(parsed.template.content) + '\nexport default component',
            resolveDir: path.dirname(args.path), loader: 'js'
          }
        })
      }
    }]
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(build.outputFiles[0].contents)
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><style>body{margin:0}#map{width:1000px;height:800px}.searchContainer{position:absolute;left:1020px;top:20px;width:300px}.searchResultItem{padding:12px;cursor:pointer}</style><div id="map"></div><div id="panel"></div><script src="/test.js"></script>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', err => { errors.push(err.message); console.error(err.message) })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => typeof window.prepare === 'function')
    for (const scenario of [
      { name: 'loaded collapsed result', lazy: false },
      { name: 'lazy collapsed result', lazy: true },
      { name: 'readonly collapsed result', lazy: true, readonly: true },
      { name: 'local search result', lazy: false, local: true }
    ]) {
      await page.evaluate(async options => window.prepare(options.lazy, options.readonly, options.local), scenario)
      assert.strictEqual((await page.evaluate(() => window.inspectReveal())).visible, false)
      await page.locator('.searchResultItem').click()
      await page.waitForFunction(() => window.inspectReveal().visible && window.inspectReveal().centered, null, { timeout: 5000 }).catch(async err => {
        console.error(scenario.name, await page.evaluate(() => window.inspectReveal()))
        throw err
      })
      // A second render must not restore the old collapsed preference.
      await page.evaluate(() => new Promise(resolve => window.mm.render(resolve)))
      await page.waitForFunction(() => window.inspectReveal().visible && window.inspectReveal().centered)
      const result = await page.evaluate(() => window.inspectReveal())
      assert.strictEqual(result.branch, true)
      assert.strictEqual(result.deep, true)
      assert.strictEqual(result.other, false, 'unrelated branch stays collapsed')
      if (!scenario.readonly) assert.strictEqual(result.active, true)
      if (scenario.lazy) assert.ok(result.fetches.includes('locate:needle'))
      else assert.deepStrictEqual(result.fetches, [], 'loaded results need no HTTP hydration')
      await page.locator('.searchResultItem').click()
      await page.waitForFunction(() => window.inspectReveal().visible && window.inspectReveal().centered)
      console.log(scenario.name + ': visible, centered, expansion retained')
    }
    await page.evaluate(() => window.prepare(true))
    assert.strictEqual(await page.evaluate(async () => {
      const target = await window.cooperate.revealUid('needle')
      return !!target && window.inspectReveal().centered
    }), true, 'reveal promise resolves after layout and centering')
    assert.strictEqual(await page.evaluate(() => window.cooperate.revealUid('deleted')), null)
    assert.deepStrictEqual(errors, [])
    const output = path.join(repo, 'output/search-reveal')
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'search-reveal.png') })
    console.log('Search reveal browser regressions passed')
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => { console.error(err); process.exitCode = 1 })
