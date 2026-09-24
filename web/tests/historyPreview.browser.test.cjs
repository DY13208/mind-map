const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')
const compiler = require('../node_modules/vue-template-compiler')
const { chromium } = require('../../simple-mind-map/node_modules/@playwright/test')
const JSZip = require('../../simple-mind-map/node_modules/jszip')

async function main() {
  const repo = path.resolve(__dirname, '../..')
  const bundle = await esbuild.build({
    stdin: { resolveDir: repo, contents: `
      import Vue from './web/node_modules/vue/dist/vue.esm.js'
      import ElementUI from './web/node_modules/element-ui'
      import Preview from './web/src/pages/ProductShell/components/HistoryMapPreview.vue'
      Vue.use(ElementUI)
      window.mountHistory = count => {
        if (window.host) window.host.$destroy()
        document.getElementById('root').innerHTML = '<div id="mount"></div>'
        const tree = { data: { uid: 'root', text: 'History root' }, children: [] }
        for (let i = 0; i < count; i++) tree.children.push({
          data: { uid: 'branch-' + i, text: 'Branch ' + i },
          children: [{ data: { uid: 'leaf-' + i, text: 'Leaf ' + i }, children: [] }]
        })
        window.host = new Vue({
          data: { tree: Object.freeze(tree) },
          render(h) { return h(Preview, { ref: 'preview', props: { tree: this.tree } }) }
        }).$mount('#mount')
        window.preview = host.$refs.preview
      }
    ` },
    bundle: true, write: false, platform: 'browser',
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
    if (req.url === '/test.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(bundle.outputFiles[0].contents)
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end('<style>.historyMapPreview{height:720px;display:flex;flex-direction:column}.previewCanvas{flex:1;min-height:600px}#root{width:1100px;height:720px}</style><div id="root"><div id="mount"></div></div><script src="/test.js"></script>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => typeof window.mountHistory === 'function')
    for (const count of [1000, 10000, 30000]) {
      await page.evaluate(count => window.mountHistory(count), count)
      await page.waitForFunction(() => window.preview && window.preview._preview &&
        !window.preview._preview.renderer.isRendering && document.querySelectorAll('.smm-node').length >= 49)
      const initial = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.smm-node').length,
      scale: window.preview._preview.view.scale,
      total: window.preview._sourceTree.children.length,
      pending: window.preview._pendingRootChildren.length,
      visibleText: [...document.querySelectorAll('.smm-node')].some(node => node.textContent.includes('Branch'))
      }))
      assert.equal(initial.nodes, 50)
      assert.equal(initial.total, count)
      assert.equal(initial.pending, count - 48)
      assert.ok(initial.scale >= 0.5)
      assert.ok(initial.visibleText)
      if (count === 1000) {
        await page.evaluate(() => {
          window.preview.expandAll()
          setTimeout(() => window.preview.cancelExpand(), 20)
        })
        await page.waitForFunction(() => !window.preview.expanding)
      }
      if (count === 10000) {
        await page.evaluate(() => window.preview.loadMoreBranches())
        await page.waitForFunction(() => document.querySelectorAll('.smm-node').length >= 98)
        assert.equal(await page.evaluate(() => window.preview._pendingRootChildren.length), 9904)
      }
    }
    await page.evaluate(() => window.mountHistory(100))
    await page.waitForFunction(() => window.preview && window.preview._preview && !window.preview._preview.renderer.isRendering)
    await page.evaluate(() => window.preview.expandAll())
    await page.waitForFunction(() => window.preview && !window.preview.expanding && window.preview.viewMode === 'expanded')
    assert.equal(await page.evaluate(() => window.preview._pendingRootChildren.length), 0)
    assert.equal(await page.evaluate(() => window.preview._preview.renderer.renderTree.children.length), 100)
    assert.equal(await page.evaluate(() => window.preview._preview.renderer.renderTree.children.filter(node => node.data.expand).length), 100)
    const xmindPath = process.env.XMIND_FIXTURE || 'C:/Users/Sbs/Downloads/目的论项目.xmind'
    if (fs.existsSync(xmindPath)) {
      const zip = await JSZip.loadAsync(fs.readFileSync(xmindPath))
      const sheets = JSON.parse(await zip.file('content.json').async('string'))
      const topic = sheets[0].rootTopic
      const convert = source => ({ data: { uid: source.id, text: source.title || '' }, children: [] })
      const root = convert(topic)
      const queue = [{ source: topic, target: root }]
      for (let i = 0; i < queue.length; i++) {
        const { source, target } = queue[i]
        for (const child of Object.values(source.children || {}).flat()) {
          const node = convert(child)
          target.children.push(node)
          queue.push({ source: child, target: node })
        }
      }
      await page.evaluate(tree => {
        window.host.tree = Object.freeze(tree)
      }, root)
      await page.waitForFunction(() => window.preview && window.preview._sourceTree &&
        window.preview._sourceTree.data.uid === window.host.tree.data.uid &&
        !window.preview._preview.renderer.isRendering)
      assert.equal(queue.length, 10401)
      assert.ok(await page.evaluate(() => document.querySelectorAll('.smm-node').length >= 2))
    }
    console.log('PASS: 1k, 10k, 30k history overviews and optional real XMind are readable')
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
