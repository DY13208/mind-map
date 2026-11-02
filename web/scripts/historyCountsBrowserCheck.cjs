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

function branchTree({ empty = false, stale = false, version }) {
  const leaf = (uid, text) => ({ data: { uid, text }, children: [] })
  const target = {
    data: {
      uid: `${version}-target`,
      text: '须确认',
      expand: false,
      childCount: stale ? 3 : empty ? 0 : 3,
      descendantCount: stale ? 3 : empty ? 0 : 3,
      hasMore: stale,
      note: 'historical note',
      attachmentId: 'historical-attachment',
      expandMarker: 'preserve'
    },
    children: empty
      ? []
      : Array.from({ length: 3 }, (_, index) =>
          leaf(`${version}-child-${index + 1}`, `历史子节点 ${index + 1}`)
        )
  }
  return {
    data: { uid: `${version}-root`, text: '历史根节点', expand: true },
    children: [
      {
        data: { uid: `${version}-branch`, text: '调岗', expand: true },
        children: [
          {
            data: { uid: `${version}-hrbp`, text: 'HRBP', expand: true },
            children: [target]
          }
        ]
      }
    ]
  }
}

function wideTree(version) {
  const children = Array.from({ length: 60 }, (_, index) => ({
    data: {
      uid: `${version}-branch-${index + 1}`,
      text: `根分支 ${index + 1}`,
      expand: false
    },
    children: [{
      data: {
        uid: `${version}-leaf-${index + 1}`,
        text: `叶节点 ${index + 1}`,
        expand: true
      },
      children: []
    }]
  }))
  return {
    data: {
      uid: `${version}-root`,
      text: '超过分页上限的历史根节点',
      expand: true,
      childCount: 999,
      descendantCount: 999,
      hasMore: true
    },
    children
  }
}

async function main() {
  const repo = path.resolve(__dirname, '../..')
  const outDir = path.join(repo, 'output/playwright/history-counts')
  fs.mkdirSync(outDir, { recursive: true })
  const chromium = loadChromium()
  const cases = {
    complete: branchTree({ version: 'complete' }),
    stale: branchTree({ empty: true, stale: true, version: 'stale' }),
    wide: wideTree('wide')
  }
  const errors = []
  const unexpectedRequests = []

  const bundle = await esbuild.build({
    stdin: {
      resolveDir: repo,
      contents: `
        import Vue from './web/node_modules/vue/dist/vue.esm.js'
        import ElementUI from './web/node_modules/element-ui'
        import Preview from './web/src/pages/ProductShell/components/HistoryMapPreview.vue'
        Vue.use(ElementUI)
        Vue.prototype.$message = { success:()=>{}, warning:()=>{}, error:()=>{} }
        window.fixtures = ${JSON.stringify(cases)}
        window.previews = {}
        window.app = new Vue({
          render(h) {
            return h('div', { attrs:{id:'cases'} }, Object.keys(fixtures).map(name =>
              h('section', { attrs:{id:name} }, [
                h('h2', { attrs:{'data-testid':'case-title'} }, name),
                h(Preview, { ref:name, props:{tree:fixtures[name], roomKey:'fixture-only'} })
              ])
            ))
          }
        }).$mount('#app')
        window.previews.complete = app.$refs.complete
        window.previews.stale = app.$refs.stale
        window.previews.wide = app.$refs.wide
        window.ready = true
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: {
      'simple-mind-map': path.join(repo, 'simple-mind-map'),
      '@': path.join(repo, 'web/src')
    },
    nodePaths: [path.join(repo, 'web/node_modules')],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'vue',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, async args => {
            const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
            const css = (
              await less.render(
                parsed.styles
                  .map(style => style.content.replace(/\/deep\//g, ' '))
                  .join('\n')
              )
            ).css
            return {
              contents:
                parsed.script.content.replace('export default', 'const component =') +
                '\ncomponent.template = ' +
                JSON.stringify(parsed.template.content) +
                '\nconst style=document.createElement("style");style.textContent=' +
                JSON.stringify(css) +
                ';document.head.appendChild(style);\nexport default component',
              resolveDir: path.dirname(args.path),
              loader: 'js'
            }
          })
        }
      }
    ]
  })

  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(bundle.outputFiles[0].contents)
      return
    }
    if (req.url.startsWith('/fonts/')) {
      const font = path.join(
        repo,
        'web/node_modules/element-ui/lib/theme-chalk/fonts',
        path.basename(req.url.split('?')[0])
      )
      res.end(fs.existsSync(font) ? fs.readFileSync(font) : '')
      return
    }
    res.end(
      '<style>' +
        fs.readFileSync(path.join(repo, 'web/node_modules/element-ui/lib/theme-chalk/index.css'), 'utf8') +
        '</style><style>body{font-family:Arial,sans-serif}#cases{display:grid;grid-template-columns:1fr 1fr;gap:12px}section{width:800px;height:620px;border:1px solid #ccc}h2{height:24px;margin:5px}.historyMapPreview{height:580px!important}</style><div id="app"></div><script src="/test.js"></script>'
    )
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge'
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1650, height: 900 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (
        url.origin === `http://127.0.0.1:${server.address().port}` &&
        !['/', '/test.js'].includes(url.pathname) &&
        !url.pathname.startsWith('/fonts/')
      ) {
        unexpectedRequests.push(url.pathname)
      }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(
      () =>
        window.ready &&
        Object.values(window.previews).every(
          preview =>
            preview &&
            preview._preview &&
            preview._preview.renderer.renderTree &&
            !preview._preview.renderer.isRendering
        ),
      { timeout: 30000 }
    )
    await page.evaluate(() => {
      ['complete', 'stale'].forEach(name => {
        const preview = window.previews[name]
        const target = preview._sourceTree.children[0].children[0].children[0]
        preview._preview.renderer.goTargetNode(target.data.uid)
      })
    })
    await page.waitForFunction(() =>
      ['complete', 'stale'].every(name => {
        const preview = window.previews[name]
        const pending = [preview._preview.renderer.renderTree]
        const uid = preview._sourceTree.children[0].children[0].children[0].data.uid
        while (pending.length) {
          const node = pending.pop()
          if (!node) continue
          if (node.data && node.data.uid === uid) return !!(node._node && node._node.group)
          ;(node.children || []).forEach(child => pending.push(child))
        }
        return false
      })
    )
    const before = await page.evaluate(() =>
      Object.fromEntries(
        ['complete', 'stale'].map(name => {
          const preview = window.previews[name]
          const target = preview._sourceTree.children[0].children[0].children[0]
          const pending = [preview._preview.renderer.renderTree]
          let rendered
          while (pending.length) {
            const node = pending.pop()
            if (!node) continue
            if (node.data && node.data.uid === target.data.uid) {
              rendered = node._node
              break
            }
            ;(node.children || []).forEach(child => pending.push(child))
          }
          if (!rendered) {
            const available = []
            const pending = [preview._preview.renderer.renderTree]
            while (pending.length) {
              const node = pending.pop()
              if (!node) continue
              available.push({
                uid: node.data && node.data.uid,
                text: node.data && node.data.text,
                keys: Object.keys(node),
                runtimeKeys: node._node ? Object.keys(node._node).slice(0, 14) : [],
                hasGetData: typeof node.getData === 'function',
                hasGroup: !!node.group,
                childCount: node.children && node.children.length
              })
              ;(node.children || []).forEach(child => pending.push(child))
            }
            throw new Error(`${name}: rendered UID ${target.data.uid} missing; tree=${JSON.stringify(available)}`)
          }
          const button = rendered.group.node.querySelector('.smm-expand-btn')
          const rect = button && button.getBoundingClientRect()
          return [
            name,
            {
              targetData: target.data,
              sourceChildren: target.children.length,
              buttonFound: !!button,
              buttonText: button && button.textContent,
              point: rect && {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2
              }
            }
          ]
        })
      )
    )
    assert.equal(before.complete.targetData.childCount, 3)
    assert.equal(before.complete.sourceChildren, 3)
    assert.equal(before.stale.targetData.childCount, 0)
    assert.equal(before.stale.targetData.descendantCount, 0)
    assert.equal(before.stale.targetData.hasMore, undefined)
    assert.equal(before.stale.sourceChildren, 0)
    assert.equal(before.complete.buttonFound, true)
    assert.equal(before.complete.buttonText, '3')
    assert.equal(before.stale.buttonFound, false)
    await page.screenshot({ path: path.join(outDir, 'before-expand.png'), fullPage: true })

    const point = before.complete.point
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(
      () => !window.previews.complete._preview.renderer.isRendering
    )
    const after = await page.evaluate(() => {
      const preview = window.previews.complete
      const target = preview._sourceTree.children[0].children[0].children[0]
      const pending = [preview._preview.renderer.renderTree]
      let rendered
      while (pending.length) {
        const node = pending.pop()
        if (!node) continue
        if (node.data && node.data.uid === target.data.uid) {
          rendered = node._node
          break
        }
        ;(node.children || []).forEach(child => pending.push(child))
      }
      if (!rendered) throw new Error(`expanded target ${target.data.uid} missing`)
      const staleTarget = window.previews.stale._sourceTree.children[0].children[0].children[0]
      const stalePending = [window.previews.stale._preview.renderer.renderTree]
      let staleRendered
      while (stalePending.length) {
        const node = stalePending.pop()
        if (!node) continue
        if (node.data && node.data.uid === staleTarget.data.uid) {
          staleRendered = node._node
          break
        }
        ;(node.children || []).forEach(child => stalePending.push(child))
      }
      if (!staleRendered) throw new Error(`stale target ${staleTarget.data.uid} missing`)
      return {
        expand: rendered.getData('expand'),
        directChildren: rendered.children.length,
        childTexts: rendered.children.map(child => child.getData('text')),
        staleButtonFound: !!staleRendered.group.node.querySelector('.smm-expand-btn')
      }
    })
    await page.screenshot({ path: path.join(outDir, 'after-expand.png'), fullPage: true })
    assert.equal(after.expand, true)
    assert.equal(after.directChildren, 3)
    assert.deepEqual(after.childTexts, ['历史子节点 1', '历史子节点 2', '历史子节点 3'])
    assert.equal(after.staleButtonFound, false)

    const wideInitial = await page.evaluate(() => {
      const preview = window.previews.wide
      const root = preview._preview.renderer.renderTree
      return {
        childCount: preview._sourceTree.data.childCount,
        descendantCount: preview._sourceTree.data.descendantCount,
        sourceRootChildren: preview._sourceTree.children.length,
        pendingRootChildren: preview._pendingRootChildren.length,
        renderedRootChildren: root.children.length,
        hasMorePlaceholder: root.children.some(node => node.data && node.data.uid === '__history_preview_more__')
      }
    })
    assert.equal(wideInitial.childCount, 60)
    assert.equal(wideInitial.descendantCount, 120)
    assert.equal(wideInitial.sourceRootChildren, 60)
    assert.equal(wideInitial.pendingRootChildren, 12)
    assert.equal(wideInitial.renderedRootChildren, 49)
    assert.equal(wideInitial.hasMorePlaceholder, true)

    const wideToolbar = page.locator('#wide .previewToolbar')
    await wideToolbar.getByRole('button', { name: '展开', exact: true }).click()
    await page.waitForFunction(
      () => {
        const preview = window.previews.wide
        const root = preview._preview.renderer.renderTree
        return (
          preview.viewMode === 'expanded' &&
          !preview.expanding &&
          !preview._pendingRootChildren.length &&
          root.children.length === 60 &&
          !root.children.some(node => node.data && node.data.uid === '__history_preview_more__') &&
          !preview._preview.renderer.isRendering
        )
      },
      { timeout: 30000 }
    )
    const wideExpanded = await page.evaluate(() => {
      const preview = window.previews.wide
      const root = preview._preview.renderer.renderTree
      const branches = root.children.filter(node => node.data && node.data.uid !== '__history_preview_more__')
      return {
        childCount: preview._sourceTree.data.childCount,
        descendantCount: preview._sourceTree.data.descendantCount,
        sourceRootChildren: preview._sourceTree.children.length,
        pendingRootChildren: preview._pendingRootChildren.length,
        renderedRootChildren: root.children.length,
        expandedBranchCount: branches.filter(node => node._node && node._node.getData('expand')).length,
        branchesWithChildren: branches.filter(node => node._node && node._node.children.length > 0).length,
        hasMorePlaceholder: root.children.some(node => node.data && node.data.uid === '__history_preview_more__')
      }
    })
    assert.equal(wideExpanded.childCount, 60)
    assert.equal(wideExpanded.descendantCount, 120)
    assert.equal(wideExpanded.sourceRootChildren, 60)
    assert.equal(wideExpanded.pendingRootChildren, 0)
    assert.equal(wideExpanded.renderedRootChildren, 60)
    assert.equal(wideExpanded.expandedBranchCount, 60)
    assert.equal(wideExpanded.branchesWithChildren, 60)
    assert.equal(wideExpanded.hasMorePlaceholder, false)
    await page.screenshot({ path: path.join(outDir, 'after-toolbar-expand.png'), fullPage: true })

    await wideToolbar.getByRole('button', { name: '折叠', exact: true }).click()
    await page.waitForFunction(
      () => {
        const preview = window.previews.wide
        const root = preview._preview.renderer.renderTree
        return (
          preview.viewMode === 'collapsed' &&
          !preview.mounting &&
          preview._pendingRootChildren.length === 12 &&
          root.children.length === 49 &&
          !preview._preview.renderer.isRendering
        )
      },
      { timeout: 30000 }
    )
    const wideCollapsed = await page.evaluate(() => {
      const preview = window.previews.wide
      const root = preview._preview.renderer.renderTree
      const firstBranch = root.children[0]
      return {
        childCount: preview._sourceTree.data.childCount,
        descendantCount: preview._sourceTree.data.descendantCount,
        sourceRootChildren: preview._sourceTree.children.length,
        pendingRootChildren: preview._pendingRootChildren.length,
        renderedRootChildren: root.children.length,
        firstBranchExpanded: firstBranch._node && firstBranch._node.getData('expand'),
        hasMorePlaceholder: root.children.some(node => node.data && node.data.uid === '__history_preview_more__')
      }
    })
    assert.equal(wideCollapsed.childCount, 60)
    assert.equal(wideCollapsed.descendantCount, 120)
    assert.equal(wideCollapsed.sourceRootChildren, 60)
    assert.equal(wideCollapsed.pendingRootChildren, 12)
    assert.equal(wideCollapsed.renderedRootChildren, 49)
    assert.equal(wideCollapsed.firstBranchExpanded, false)
    assert.equal(wideCollapsed.hasMorePlaceholder, true)
    await page.screenshot({ path: path.join(outDir, 'after-toolbar-collapse.png'), fullPage: true })
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpectedRequests, [])
    const result = { before, after, wideInitial, wideExpanded, wideCollapsed, consoleErrors: errors, unexpectedRequests }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
