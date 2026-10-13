const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')
const compiler = require('../node_modules/vue-template-compiler')
const less = require('../node_modules/less')

function loadChromium() {
  const candidates = [
    'playwright',
    path.join(
      'C:',
      'Users',
      'yiran',
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      'playwright'
    ),
    path.join(__dirname, '../../simple-mind-map/node_modules/@playwright/test')
  ]
  let lastError
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Playwright Chromium is unavailable')
}

function makeTree(version, uniqueText) {
  const imageKey = `smm_img_key_${version}_resource`
  const imageData =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p2sAAAAASUVORK5CYII='
  return {
    data: {
      uid: `${version}-root-uid`,
      text: `历史根节点 ${version}`,
      expand: true,
      imgMap: { [imageKey]: imageData }
    },
    children: [
      {
        data: {
          uid: `${version}-branch-uid`,
          text: uniqueText,
          expand: false,
          note: `历史备注 ${version}`,
          richText: `<p>历史富文本 ${version}</p>`,
          image: imageKey,
          imageSize: { width: 32, height: 32 },
          attachmentId: `historical-attachment-${version}`,
          attachmentName: `历史附件-${version}.pdf`
        },
        children: [
          {
            data: {
              uid: `${version}-folded-leaf-uid`,
              text: `折叠后代 ${version}`,
              expand: true,
              note: `后代备注 ${version}`
            },
            children: []
          }
        ]
      }
    ]
  }
}

function makeFixture() {
  const trees = {
    'version-A': makeTree('A', '预览内容只属于版本 A'),
    'version-B': makeTree('B', '导出内容只属于版本 B')
  }
  const metadata = {
    layout: 'logicalStructure',
    theme: { template: 'default', config: { backgroundColor: '#fef8e7' } },
    themeConfig: { backgroundColor: '#fef8e7' },
    view: {
      transform: { x: 0, y: 0, k: 1 },
      state: { scale: 1, x: 0, y: 0, sx: 1, sy: 1 }
    }
  }
  return {
    versions: [
      {
        versionId: 'version-A',
        createdAt: '2026-10-12T10:00:00.000Z',
        type: 'AUTO',
        name: '浏览器验收版本 A',
        summaryText: '预览 A；导出目标应单独绑定到 B',
        editors: [{ userId: 'fixture-user', name: '验收用户' }],
        availability: 'available',
        capabilities: { canRestore: false }
      },
      {
        versionId: 'version-B',
        createdAt: '2026-10-11T09:30:00.000Z',
        type: 'MANUAL',
        name: '浏览器验收版本 B',
        summaryText: '导出必须来自这个版本',
        editors: [{ userId: 'fixture-user', name: '验收用户' }],
        availability: 'available',
        capabilities: { canRestore: false }
      }
    ],
    trees,
    metadata
  }
}

async function buildBundle(repo, fixture) {
  const serializedFixture = JSON.stringify(fixture)
  const result = await esbuild.build({
    stdin: {
      resolveDir: repo,
      contents: `
        import Vue from './web/node_modules/vue/dist/vue.esm.js'
        import Vuex from './web/node_modules/vuex'
        import ElementUI from './web/node_modules/element-ui'
        import HistoryPanel from './web/src/pages/ProductShell/components/HistoryPanel.vue'
        import Export from './web/src/pages/Edit/components/Export.vue'

        Vue.use(Vuex)
        Vue.use(ElementUI)

        const messages = []
        const translations = {
          'export.title': '导出',
          'export.defaultFileName': '思维导图',
          'export.filename': '文件名',
          'export.format': '格式',
          'export.desc': '描述',
          'export.options': '选项',
          'export.include': '包含配置',
          'export.paddingX': '水平边距',
          'export.paddingY': '垂直边距',
          'export.addFooterText': '页脚文字',
          'export.addFooterTextPlaceholder': '请输入页脚文字',
          'export.isTransparent': '透明背景',
          'export.isFitBg': '适配背景',
          'export.confirm': '确认导出',
          'export.notifyTitle': '导出',
          'export.notifyMessage': '导出成功',
          'dialog.cancel': '取消',
          'edit.exportError': '导出失败'
        }
        const store = new Vuex.Store({
          state: { localConfig: { openNodeRichText: true, isDark: false }, collabPendingCount: 0 },
          mutations: { setExtraTextOnExport() {} }
        })
        const bus = new Vue()
        Vue.prototype.$bus = bus
        Vue.prototype.$i18n = { locale: 'zh' }
        Vue.prototype.$t = key => translations[key] || key
        Vue.prototype.$message = {
          success: text => messages.push({ type: 'success', text }),
          warning: text => messages.push({ type: 'warning', text }),
          error: text => messages.push({ type: 'error', text })
        }
        Vue.prototype.$notify = {
          info: value => messages.push({ type: 'info', text: value.message })
        }
        Vue.prototype.$confirm = () => Promise.reject(new Error('not used'))
        Vue.prototype.$prompt = () => Promise.reject(new Error('not used'))

        window.fixture = ${serializedFixture}
        window.fixtureSource = JSON.stringify(window.fixture)
        window.historyServiceCalls = []
        window.historyExportCalls = []
        window.historyExportError = ''
        window.historyService = {
          async listVersions(roomKey, query, options) {
            window.historyServiceCalls.push({ method: 'listVersions', roomKey })
            return {
              list: JSON.parse(JSON.stringify(window.fixture.versions)),
              nextCursor: null,
              currentRevision: 500
            }
          },
          async getVersionTree(roomKey, versionId, options) {
            window.historyServiceCalls.push({ method: 'getVersionTree', roomKey, versionId })
            const tree = window.fixture.trees[versionId]
            if (!tree) throw new Error('missing read-only fixture: ' + versionId)
            return {
              tree: JSON.parse(JSON.stringify(tree)),
              metadata: JSON.parse(JSON.stringify(window.fixture.metadata))
            }
          },
          async getVersion() { throw new Error('unexpected fixture call: getVersion') },
          async createVersion() { throw new Error('unexpected fixture call: createVersion') },
          async restoreVersion() { throw new Error('unexpected fixture call: restoreVersion') }
        }
        window.messages = messages
        window.bus = bus
        window.store = store
        window.app = new Vue({
          store,
          data: () => ({ visible: false }),
          render(h) {
            return h('div', { attrs: { id: 'harness' } }, [
              h(HistoryPanel, {
                ref: 'historyPanel',
                props: {
                  visible: this.visible,
                  room: {
                    id: 'readonly-fixture-room',
                    roomKey: 'readonly-fixture-room',
                    title: '历史导出验收脑图',
                    revision: 500,
                    canManage: false,
                    capabilities: { canCreate: false }
                  },
                  waitForCommit: false
                }
              }),
              h(Export, { ref: 'ordinaryExport' })
            ])
          }
        }).$mount('#app')
        window.ready = true
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: {
      'simple-mind-map': path.join(repo, 'simple-mind-map'),
      '@': path.join(repo, 'web/src'),
      vue: path.join(repo, 'web/node_modules/vue/dist/vue.esm.js')
    },
    nodePaths: [
      path.join(repo, 'web/node_modules'),
      path.join(repo, 'simple-mind-map/node_modules')
    ],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'history-panel-browser-fixture',
        setup(build) {
          build.onResolve({ filter: /^@\/services\/historyService$/ }, () => ({
            path: 'historyService',
            namespace: 'readonly-history-fixture'
          }))
          build.onLoad(
            { filter: /.*/, namespace: 'readonly-history-fixture' },
            () => ({
              contents: `
                export default {
                  listVersions(...args) { return window.historyService.listVersions(...args) },
                  getVersionTree(...args) { return window.historyService.getVersionTree(...args) },
                  getVersion(...args) { return window.historyService.getVersion(...args) },
                  createVersion(...args) { return window.historyService.createVersion(...args) },
                  restoreVersion(...args) { return window.historyService.restoreVersion(...args) }
                }
              `,
              loader: 'js'
            })
          )
          build.onResolve({ filter: /^@\/services\/historyExport$/ }, () => ({
            path: 'historyExport',
            namespace: 'history-export-instrumentation'
          }))
          build.onLoad(
            { filter: /.*/, namespace: 'history-export-instrumentation' },
            () => ({
              contents: `
                import { exportHistoryVersion as realExportHistoryVersion } from './web/src/services/historyExport.js'
                export async function exportHistoryVersion(options) {
                  window.historyExportCalls.push({
                    uid: options.tree && options.tree.data && options.tree.data.uid,
                    request: options.request
                  })
                  try {
                    return await realExportHistoryVersion(options)
                  } catch (error) {
                    window.historyExportError = error && error.stack || String(error)
                    throw error
                  }
                }
              `,
              resolveDir: repo,
              loader: 'js'
            })
          )
          build.onLoad({ filter: /\.vue$/ }, async args => {
            const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
            const cssParts = []
            for (const style of parsed.styles || []) {
              const source = style.content.replace(/\/deep\//g, ' ')
              const compiled = await less.render(source, { filename: args.path })
              cssParts.push(compiled.css)
            }
            const script = (parsed.script && parsed.script.content) || 'export default {}'
            return {
              contents:
                script.replace('export default', 'const component =') +
                '\ncomponent.template = ' + JSON.stringify(parsed.template.content) +
                '\nconst style=document.createElement("style");style.textContent=' +
                JSON.stringify(cssParts.join('\n')) +
                ';document.head.appendChild(style);\nexport default component',
              resolveDir: path.dirname(args.path),
              loader: 'js'
            }
          })
        }
      }
    ]
  })
  return result.outputFiles[0].contents
}

function readDownload(download) {
  return new Promise(async (resolve, reject) => {
    try {
      const filePath = await download.path()
      if (!filePath) throw new Error('download path unavailable')
      resolve(fs.readFileSync(filePath))
    } catch (error) {
      reject(error)
    }
  })
}

async function clickExportFor(page, versionId) {
  const row = page.locator('.versionItem').filter({ hasText: `版本 ${versionId.slice(-1)}` })
  assert.equal(await row.count(), 1, `expected one row for ${versionId}`)
  await row.getByRole('button', { name: '导出此版本' }).click()
  await page.waitForFunction(
    () => window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible
  )
}

async function main() {
  const chromium = loadChromium()
  const repo = path.resolve(__dirname, '../..')
  const fixture = makeFixture()
  const bundle = await buildBundle(repo, fixture)
  const elementCss = fs.readFileSync(
    path.join(repo, 'web/node_modules/element-ui/lib/theme-chalk/index.css'),
    'utf8'
  )
  const server = http.createServer((req, res) => {
    if (req.url === '/history-panel.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      res.end(bundle)
      return
    }
    if (req.url.startsWith('/fonts/')) {
      const fontPath = path.join(
        repo,
        'web/node_modules/element-ui/lib/theme-chalk/fonts',
        path.basename(req.url.split('?')[0])
      )
      res.setHeader('Content-Type', 'font/woff')
      res.end(fs.existsSync(fontPath) ? fs.readFileSync(fontPath) : '')
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>${elementCss}</style><style>
      *{box-sizing:border-box}html,body,#app{width:100%;height:100%;margin:0}
      body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#eef2f0}
      .historyMapPreview{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}
      .previewCanvas{flex:1;min-height:0;width:100%;height:100%}
      .previewToolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px}
      .previewState{padding:16px;color:#5b6c64}
      .el-dialog__wrapper{z-index:2000}.nodeExportDialog{z-index:3000}
      .nodeExportDialog .el-dialog{height:auto;max-height:90vh}
    </style></head><body><div id="app"></div><script src="/history-panel.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  let browser
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge'
      })
    } catch (error) {
      browser = await chromium.launch({ headless: true })
    }
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1050 }
    })
    const page = await context.newPage()
    const pageErrors = []
    const downloadEvents = []
    const externalRequests = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('download', download => downloadEvents.push(download.suggestedFilename()))
    const origin = `http://127.0.0.1:${server.address().port}`
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
        route.continue()
      } else {
        externalRequests.push(url)
        route.abort()
      }
    })
    await page.goto(origin)
    await page.waitForFunction(() => window.ready && window.app)
    await page.waitForTimeout(150)
    assert.deepEqual(
      await page.evaluate(() => window.historyServiceCalls),
      [],
      'mounting with visible=false must not read history'
    )

    await page.evaluate(() => { window.app.visible = true })
    await page.waitForFunction(() => {
      const panel = window.app.$refs.historyPanel
      return panel.versions.length === 2 && !panel.loading && panel.selected && panel.selected.versionId === 'version-A'
    })
    await page.waitForFunction(() => {
      const preview = window.app.$refs.historyPanel.$refs.mapPreview
      return preview && preview._preview && preview._preview.renderer && preview._preview.renderer.renderTree
    }, undefined, { timeout: 20000 })
    const initialState = await page.evaluate(() => {
      const panel = window.app.$refs.historyPanel
      const preview = panel.$refs.mapPreview
      return {
        selectedVersionId: panel.selected.versionId,
        previewRootUid: preview._preview.renderer.renderTree.data.uid,
        previewRootText: preview._preview.renderer.renderTree.data.text,
        calls: window.historyServiceCalls
      }
    })
    assert.equal(initialState.selectedVersionId, 'version-A')
    assert.equal(initialState.previewRootUid, 'A-root-uid')
    assert.equal(initialState.previewRootText, '历史根节点 A')

    await clickExportFor(page, 'version-B')
    const openState = await page.evaluate(() => ({
      selectedVersionId: window.app.$refs.historyPanel.selected.versionId,
      managedOpen: window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible,
      ordinaryOpen: window.app.$refs.ordinaryExport.dialogVisible,
      fileName: window.app.$refs.historyPanel.$refs.exportDialog.fileName,
      registeredShowExport: !!window.bus._events.showExport
    }))
    assert.equal(openState.selectedVersionId, 'version-A', 'export click must not change preview selection')
    assert.equal(openState.managedOpen, true)
    assert.equal(openState.ordinaryOpen, false, 'history export must not open the ordinary export dialog')
    assert.ok(openState.fileName.includes('version-B'))
    assert.equal(openState.registeredShowExport, true, 'ordinary export listener should be mounted for conflict detection')

    const screenshotDir = path.join(repo, 'output/playwright/history-phase1')
    fs.mkdirSync(screenshotDir, { recursive: true })
    await page.waitForTimeout(350)
    await page.screenshot({
      path: path.join(screenshotDir, 'history-panel.png'),
      fullPage: true
    })

    const visibleExportDialog = page.locator('.nodeExportDialog:visible')
    const jsonType = visibleExportDialog.locator('.downloadTypeItem').filter({ hasText: 'JSON' })
    assert.equal(await jsonType.count(), 1, 'the real export format list must show JSON')
    await jsonType.click()
    const jsonDownloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
    await visibleExportDialog.getByRole('button', { name: '确认导出' }).click()
    const jsonDownload = await jsonDownloadPromise
    if (!jsonDownload) {
      const diagnostic = await page.evaluate(() => ({
        panel: { exporting: window.app.$refs.historyPanel.exporting, target: window.app.$refs.historyPanel._exportTarget },
        modal: { visible: window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible, loading: window.app.$refs.historyPanel.$refs.exportDialog.loading },
        messages: window.messages,
        calls: window.historyServiceCalls,
        exportCalls: window.historyExportCalls,
        exportError: window.historyExportError
      }))
      throw new Error('JSON export did not download: ' + JSON.stringify(diagnostic))
    }
    assert.match(jsonDownload.suggestedFilename(), /version-B.*\.json$/)
    const jsonText = (await readDownload(jsonDownload)).toString('utf8')
    assert.ok(jsonText.includes('导出内容只属于版本 B'), 'JSON download must contain version B')
    assert.ok(jsonText.includes('折叠后代 B'), 'JSON download must include the folded historical subtree')
    assert.ok(!jsonText.includes('预览内容只属于版本 A'), 'JSON download must not contain preview version A')
    await page.waitForFunction(() => !window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible)

    await clickExportFor(page, 'version-B')
    const smmDialog = page.locator('.nodeExportDialog:visible')
    const smmType = smmDialog.locator('.downloadTypeItem').filter({ hasText: '思绪文件' })
    assert.equal(await smmType.count(), 1, 'the real export format list must show SMM')
    await smmType.click()
    const [smmDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      smmDialog.getByRole('button', { name: '确认导出' }).click()
    ])
    assert.match(smmDownload.suggestedFilename(), /version-B.*\.smm$/)
    const smmText = (await readDownload(smmDownload)).toString('utf8')
    assert.ok(smmText.includes('导出内容只属于版本 B'), 'SMM download must contain version B')
    assert.ok(smmText.includes('折叠后代 B'), 'SMM download must include the folded historical subtree')
    assert.ok(!smmText.includes('预览内容只属于版本 A'), 'SMM download must not contain preview version A')
    await page.waitForFunction(() => !window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible)

    for (const closeAction of ['cancel', 'close']) {
      const before = downloadEvents.length
      await clickExportFor(page, 'version-B')
      const dialog = page.locator('.nodeExportDialog:visible')
      if (closeAction === 'cancel') {
        await dialog.getByRole('button', { name: '取消' }).click()
      } else {
        await dialog.locator('.closeBtn').click()
      }
      await page.waitForFunction(() => !window.app.$refs.historyPanel.$refs.exportDialog.dialogVisible)
      await page.waitForTimeout(300)
      assert.equal(downloadEvents.length, before, `${closeAction} must not download a file`)
    }

    const finalState = await page.evaluate(() => ({
      selectedVersionId: window.app.$refs.historyPanel.selected.versionId,
      ordinaryOpen: window.app.$refs.ordinaryExport.dialogVisible,
      exports: window.historyServiceCalls.filter(call => call.method === 'getVersionTree').map(call => call.versionId),
      exportUids: window.historyExportCalls.map(call => call.uid),
      exportTypes: window.historyExportCalls.map(call => call.request.type),
      fixtureUnchanged: JSON.stringify(window.fixture) === window.fixtureSource,
      errors: window.messages.filter(message => message.type === 'error')
    }))
    assert.equal(finalState.selectedVersionId, 'version-A')
    assert.equal(finalState.ordinaryOpen, false)
    assert.deepEqual(finalState.exports, ['version-A', 'version-B', 'version-B'])
    assert.deepEqual(finalState.exportUids, ['B-root-uid', 'B-root-uid'])
    assert.deepEqual(finalState.exportTypes, ['json', 'smm'])
    assert.equal(finalState.fixtureUnchanged, true, 'history fixture must remain read-only')
    assert.deepEqual(finalState.errors, [])
    assert.deepEqual(externalRequests, [], 'the fixture-only browser check must make no external requests')
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`)
    console.log('PASS: HistoryPanel opens only after visible=true; B export remains bound to B while preview stays on A; JSON/SMM downloads contain complete B data; managed export does not open the ordinary export dialog; cancel and close produce no download.')
    console.log(`Screenshot: ${path.join(screenshotDir, 'history-panel.png')}`)
    console.log(`Downloads: ${downloadEvents.join(', ')}`)
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
