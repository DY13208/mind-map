const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('../node_modules/esbuild')

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

async function buildBundle(repo) {
  const result = await esbuild.build({
    stdin: {
      resolveDir: repo,
      contents: `
        import MindMap from './simple-mind-map/index.js'
        import { exportHistoryVersion, HISTORY_EXPORT_TYPES } from './web/src/services/historyExport.js'
        window.MindMap = MindMap
        window.exportHistoryVersion = exportHistoryVersion
        window.historyExportTypes = HISTORY_EXPORT_TYPES
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: {
      'simple-mind-map': path.join(repo, 'simple-mind-map'),
      '@': path.join(repo, 'web/src')
    },
    nodePaths: [
      path.join(repo, 'web/node_modules'),
      path.join(repo, 'simple-mind-map/node_modules')
    ],
    loader: { '.css': 'empty' }
  })
  return result.outputFiles[0].contents
}

async function readDownload(download) {
  const stream = await download.createReadStream()
  assert.ok(stream, `download stream unavailable: ${download.suggestedFilename()}`)
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function allNodeTexts(tree) {
  const texts = []
  const visit = node => {
    if (!node) return
    if (node.data && node.data.text) texts.push(node.data.text)
    ;(node.children || []).forEach(visit)
  }
  visit(tree)
  return texts
}

function hasNodeText(tree, expected) {
  return allNodeTexts(tree).some(text => text.includes(expected))
}

async function main() {
  const chromium = loadChromium()
  const repo = path.resolve(__dirname, '../..')
  const bundle = await buildBundle(repo)
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/history-export.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(bundle)
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><html><body><script src="/history-export.js"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  let browser
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' })
    } catch (error) {
      browser = await chromium.launch({ headless: true, channel: 'chrome' })
    }
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    const pageErrors = []
    const downloadNames = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('download', download => downloadNames.push(download.suggestedFilename()))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.historyExportTypes && window.MindMap)

    const snapshot = {
      data: {
        uid: 'history-root',
        text: '历史根节点',
        expand: true,
        imgMap: {},
        richText: true
      },
      children: [
        {
          data: {
            uid: 'expanded-branch',
            text: '展开分支',
            expand: true,
            note: '保留备注',
            richText: '<p>富文本内容</p>',
            image: ''
          },
          children: [
            {
              data: { uid: 'visible-leaf', text: '可见历史叶子', expand: true },
              children: []
            }
          ]
        },
        {
          data: { uid: 'collapsed-branch', text: '折叠分支', expand: false },
          children: [
            {
              data: { uid: 'collapsed-leaf', text: '折叠历史叶子', expand: true },
              children: []
            }
          ]
        }
      ]
    }
    const sourceJson = JSON.stringify(snapshot)
    await page.evaluate(({ tree }) => {
      window.snapshot = tree
      window.sourceJson = JSON.stringify(tree)
    }, { tree: snapshot })
    const metadata = {
      layout: 'logicalStructure',
      theme: { template: 'default', config: { backgroundColor: '#fef8e7' } },
      themeConfig: { backgroundColor: '#fef8e7' }
    }
    const registeredPluginCount = await page.evaluate(() => window.MindMap.pluginList.length)

    const formatChecks = [
      {
        type: 'smm',
        name: 'history-snapshot.smm',
        verify(bytes) {
          const file = JSON.parse(bytes.toString('utf8'))
          assert.equal(file.theme.template, 'default')
          assert.ok(hasNodeText(file.root, '折叠历史叶子'))
          assert.ok(hasNodeText(file.root, '可见历史叶子'))
        }
      },
      {
        type: 'png',
        name: 'history-snapshot.png',
        verify(bytes) {
          assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        }
      },
      {
        type: 'pdf',
        name: 'history-snapshot.pdf',
        verify(bytes) {
          assert.equal(bytes.subarray(0, 4).toString('ascii'), '%PDF')
        }
      },
      {
        type: 'svg',
        name: 'history-snapshot.svg',
        verify(bytes) {
          const svg = bytes.toString('utf8')
          assert.match(svg, /可见历史叶子/)
          assert.doesNotMatch(svg, /折叠历史叶子/)
        }
      },
      {
        type: 'md',
        name: 'history-snapshot.md',
        verify(bytes) {
          const text = bytes.toString('utf8')
          assert.match(text, /可见历史叶子/)
          assert.match(text, /折叠历史叶子/)
        }
      },
      {
        type: 'xmind',
        name: 'history-snapshot.xmind',
        verify(bytes) {
          assert.equal(bytes.subarray(0, 4).toString('ascii'), 'PK\u0003\u0004')
          assert.ok(bytes.length > 100)
        }
      },
      {
        type: 'txt',
        name: 'history-snapshot.txt',
        verify(bytes) {
          const text = bytes.toString('utf8')
          assert.match(text, /可见历史叶子/)
          assert.match(text, /折叠历史叶子/)
        }
      },
      {
        type: 'json',
        name: 'history-snapshot.json',
        verify(bytes) {
          const file = JSON.parse(bytes.toString('utf8'))
          assert.equal(file.layout, 'logicalStructure')
          assert.equal(file.theme.config.backgroundColor, '#fef8e7')
          assert.ok(hasNodeText(file.root, '折叠历史叶子'))
        }
      }
    ]

    assert.deepEqual(
      await page.evaluate(() => window.historyExportTypes),
      formatChecks.map(item => item.type)
    )
    for (const check of formatChecks) {
      const [download, result] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(
          async ({ type, tree, metadata, fileName }) => {
            return window.exportHistoryVersion({
              tree,
              metadata,
              request: {
                type,
                fileName,
                withConfig: true,
                paddingX: 14,
                paddingY: 18,
                extraText: '歷史版本匯出'
              }
            })
          },
          { type: check.type, tree: snapshot, metadata, fileName: 'history-snapshot' }
        )
      ])
      assert.equal(download.suggestedFilename(), check.name)
      const bytes = await readDownload(download)
      check.verify(bytes)
      if (check.type === 'smm' || check.type === 'json') {
        const imported = await page.evaluate(async file => {
          const host = document.createElement('div')
          host.style.cssText = 'width:900px;height:600px;position:fixed;left:-10000px'
          document.body.appendChild(host)
          let map
          try {
            map = new window.MindMap({
              el: host, initPlugins: false, data: file.root || file,
              layout: file.layout, theme: file.theme && file.theme.template,
              themeConfig: file.theme && file.theme.config, viewData: file.view
            })
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('reimport render timeout')), 10000)
              map.on('render_complete', () => { clearTimeout(timeout); resolve() })
            })
            return map.getData(true)
          } finally { if (map) map.destroy(); host.remove() }
        }, JSON.parse(bytes.toString('utf8')))
        assert.ok(hasNodeText(imported.root, '折叠历史叶子'))
        assert.equal(imported.layout, 'logicalStructure')
        assert.equal(imported.theme.config.backgroundColor, '#fef8e7')
      }
      assert.equal(result.type, check.type)
      const state = await page.evaluate(() => ({
        sourceUnchanged: JSON.stringify(window.snapshot) === window.sourceJson,
        liveInstances: window.MindMap.instanceCount,
        pluginCount: window.MindMap.pluginList.length,
        hosts: document.querySelectorAll('.smm-history-export-host').length
      }))
      assert.equal(state.sourceUnchanged, true, `${check.type} mutated source history`)
      assert.equal(state.liveInstances, 0, `${check.type} leaked a MindMap instance`)
      assert.equal(state.pluginCount, registeredPluginCount, `${check.type} registered a global plugin`)
      assert.equal(state.hosts, 0, `${check.type} leaked the temporary host`)
      console.log(`PASS ${check.type}: ${download.suggestedFilename()}`)
    }

    // The include-configuration checkbox also supports exporting without the
    // wrapper while retaining every node.
    const [plainSmmDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async ({ tree, metadata }) =>
        window.exportHistoryVersion({
          tree,
          metadata,
          request: { type: 'smm', fileName: 'history-plain', withConfig: false }
        }),
      { tree: snapshot, metadata })
    ])
    const plainSmm = JSON.parse((await readDownload(plainSmmDownload)).toString('utf8'))
    assert.ok(hasNodeText(plainSmm, '折叠历史叶子'))
    assert.equal(plainSmm.layout, undefined)

    // An image failure must reject the task and leave no partial download.
    await page.route('https://history-export.invalid/**', route => route.abort())
    const brokenTree = {
      data: { uid: 'broken-root', text: '含有失效图片的历史版本' },
      children: [
        {
          data: {
            uid: 'broken-image',
            text: '图片节点',
            image: 'https://history-export.invalid/unavailable.png',
            imageSize: { width: 50, height: 50 }
          },
          children: []
        }
      ]
    }
    const broken = await page.evaluate(async ({ tree, metadata }) => {
      try {
        await window.exportHistoryVersion({
          tree,
          metadata,
          request: { type: 'svg', fileName: 'history-broken-image' }
        })
        return { message: '' }
      } catch (error) {
        return { message: error.message }
      }
    }, { tree: brokenTree, metadata })
    assert.match(broken.message, /图片资源加载失败/)
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('.smm-history-export-host').length),
      0
    )

    // Historical theme backgrounds must fail explicitly too. The upstream
    // SVG export method leaves a pending Promise when its image conversion
    // rejects; history export surfaces that rejection and cleans up locally.
    const brokenBackgroundMetadata = {
      ...metadata,
      theme: {
        template: 'default',
        config: {
          backgroundColor: '#fff',
          backgroundImage: 'https://history-export.invalid/background.png'
        }
      },
      themeConfig: {
        backgroundColor: '#fff',
        backgroundImage: 'https://history-export.invalid/background.png'
      }
    }
    for (const type of ['svg', 'png', 'pdf']) {
      const downloadsBeforeBackgroundFailure = downloadNames.length
      const brokenBackground = await page.evaluate(
        async ({ tree, metadata, type }) => {
          try {
            await window.exportHistoryVersion({
              tree,
              metadata,
              request: {
                type,
                fileName: `history-broken-background-${type}`,
                isFitBg: true,
                isTransparent: false
              }
            })
            return { message: '' }
          } catch (error) {
            return { message: error.message }
          }
        },
        { tree: snapshot, metadata: brokenBackgroundMetadata, type }
      )
      assert.match(brokenBackground.message, /背景图片资源加载失败/)
      assert.equal(downloadNames.length, downloadsBeforeBackgroundFailure)
      assert.equal(await page.evaluate(() => window.MindMap.instanceCount), 0)
      assert.equal(await page.evaluate(() => document.querySelectorAll('.smm-history-export-host').length), 0)
    }

    // Abort after the export has started but before its Promise settles. The
    // temporary canvas must be destroyed immediately and the late result must
    // never be downloaded.
    const instancesBeforeCancel = await page.evaluate(() => window.MindMap.instanceCount)
    const downloadsBeforeCancel = downloadNames.length
    const cancel = await page.evaluate(async ({ tree, metadata }) => {
      const controller = new AbortController()
      let signalExportStarted
      const exportStarted = new Promise(resolve => {
        signalExportStarted = resolve
      })
      const originalInitPlugin = window.MindMap.prototype.initPlugin
      window.MindMap.prototype.initPlugin = function (plugin) {
        originalInitPlugin.call(this, plugin)
        if (plugin.instanceName === 'doExport') {
          this.doExport.export = () => {
            signalExportStarted()
            return new Promise(resolve => {
              setTimeout(() => resolve('data:text/plain;base64,bGF0ZSByZXN1bHQ='), 150)
            })
          }
        }
      }
      const task = window.exportHistoryVersion({
        tree,
        metadata,
        request: { type: 'json', fileName: 'history-cancelled' },
        signal: controller.signal
      })
      try {
        await exportStarted
        controller.abort()
        await task
        return { name: '' }
      } catch (error) {
        return { name: error.name }
      } finally {
        window.MindMap.prototype.initPlugin = originalInitPlugin
      }
    }, { tree: snapshot, metadata })
    assert.equal(cancel.name, 'AbortError')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(downloadNames.length, downloadsBeforeCancel)
    assert.equal(await page.evaluate(() => window.MindMap.instanceCount), instancesBeforeCancel)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.smm-history-export-host').length), 0)
    assert.deepEqual(pageErrors, [])
    console.log('PASS: image/background failure, cancellation, source immutability, plugin isolation and temporary-instance cleanup')
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
