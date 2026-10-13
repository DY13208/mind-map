const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const buildDir = path.join(
  repoRoot,
  'output',
  'readonlySelectionBrowserCheck',
  'lib'
)
const libraryFile = fs.existsSync(buildDir)
  ? fs
      .readdirSync(buildDir)
      .find(name => /^simpleMindMap\.umd(?:\.min)?\.js$/.test(name))
  : null

assert.ok(
  libraryFile,
  `找不到浏览器构建文件。请先将 simple-mind-map/full.js 构建到 ${buildDir}`
)

let playwright
try {
  playwright = require('playwright')
} catch (error) {
  try {
    playwright = require('@playwright/test')
  } catch {
    throw new Error(
      '需要通过 NODE_PATH 提供 Playwright；本脚本不会安装或新增项目依赖。',
      { cause: error }
    )
  }
}

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      html, body, #map { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      #map { position: relative; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script src="/mind-map.js"></script>
    <script>
      const exported = window.simpleMindMap
      const MindMap = exported && (exported.default || exported)
      if (typeof MindMap !== 'function') throw new Error('无法读取思维导图库导出')
      window.mm = new MindMap({
        el: document.querySelector('#map'),
        readonly: true,
        allowReadonlySelection: new URLSearchParams(location.search).get('selection') === 'true',
        enableCtrlKeyNodeSelection: true,
        data: {
          data: { uid: 'readonly-root', text: 'Root' },
          children: [
            { data: { uid: 'readonly-a', text: 'Branch A' }, children: [] },
            { data: { uid: 'readonly-b', text: 'Branch B' }, children: [] }
          ]
        }
      })
      window.textEditCount = 0
      window.mm.on('before_show_text_edit', () => { window.textEditCount += 1 })
    </script>
  </body>
</html>`

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (pathname === '/mind-map.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      fs.createReadStream(path.join(buildDir, libraryFile)).pipe(response)
      return
    }
    response.writeHead(404)
    response.end()
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

async function selectedUids(page) {
  return page.evaluate(() =>
    window.mm.renderer.activeNodeList.map(node => node.getData('uid'))
  )
}

async function loadMap(page, allowSelection) {
  await page.goto(`http://127.0.0.1:${page.testPort}/?selection=${allowSelection}`)
  await page.waitForFunction(
    () =>
      window.mm &&
      window.mm.renderer &&
      window.mm.renderer.findNodeByUid('readonly-a') &&
      window.mm.renderer.findNodeByUid('readonly-b'),
    { timeout: 15000 }
  )
}

async function dragAroundBranches(page) {
  const bounds = await page.evaluate(() => {
    const rects = ['readonly-a', 'readonly-b'].map(uid => {
      const node = document.querySelector(`[data-node-uid="${uid}"]`)
      if (!node) throw new Error(`缺少节点 DOM: ${uid}`)
      const { x, y, width, height } = node.getBoundingClientRect()
      return { left: x, top: y, right: x + width, bottom: y + height }
    })
    return {
      x1: Math.max(2, Math.min(...rects.map(rect => rect.left)) - 20),
      y1: Math.max(2, Math.min(...rects.map(rect => rect.top)) - 20),
      x2: Math.min(
        innerWidth - 2,
        Math.max(...rects.map(rect => rect.right)) + 20
      ),
      y2: Math.min(
        innerHeight - 2,
        Math.max(...rects.map(rect => rect.bottom)) + 20
      )
    }
  })

  await page.mouse.move(bounds.x1, bounds.y1)
  await page.mouse.down()
  await page.mouse.move(bounds.x2, bounds.y2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(50)
}

async function run() {
  const { chromium } = playwright
  const { server, port } = await startServer()
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.testPort = port
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await loadMap(page, false)
    await page.locator('[data-node-uid="readonly-a"]').click()
    assert.deepEqual(await selectedUids(page), ['readonly-a'])
    await page.locator('[data-node-uid="readonly-b"]').click({
      modifiers: ['Control']
    })
    assert.deepEqual(await selectedUids(page), ['readonly-b'])

    await page.evaluate(() => {
      window.mm.renderer.clearActiveNodeList()
      window.mm.renderer.emitNodeActiveEvent()
    })
    await dragAroundBranches(page)
    assert.deepEqual(await selectedUids(page), [])

    await loadMap(page, true)
    await page.locator('[data-node-uid="readonly-a"]').click()
    await page.locator('[data-node-uid="readonly-b"]').click({
      modifiers: ['Control']
    })
    assert.deepEqual(
      (await selectedUids(page)).sort(),
      ['readonly-a', 'readonly-b']
    )

    const beforeWriteAttempt = await page.evaluate(() => ({
      nodeCount: ['readonly-root', 'readonly-a', 'readonly-b'].filter(uid =>
        window.mm.renderer.findNodeByUid(uid)
      ).length,
      aPosition: [
        window.mm.renderer.findNodeByUid('readonly-a').left,
        window.mm.renderer.findNodeByUid('readonly-a').top
      ],
      aText: window.mm.renderer.findNodeByUid('readonly-a').getData('text')
    }))
    assert.equal(beforeWriteAttempt.nodeCount, 3)
    await page.keyboard.press('Delete')
    const branchA = page.locator('[data-node-uid="readonly-a"]')
    await branchA.dblclick()
    const box = await branchA.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, {
      steps: 6
    })
    await page.mouse.up()

    const afterWriteAttempt = await page.evaluate(() => ({
      nodeCount: ['readonly-root', 'readonly-a', 'readonly-b'].filter(uid =>
        window.mm.renderer.findNodeByUid(uid)
      ).length,
      aPosition: [
        window.mm.renderer.findNodeByUid('readonly-a').left,
        window.mm.renderer.findNodeByUid('readonly-a').top
      ],
      aText: window.mm.renderer.findNodeByUid('readonly-a').getData('text'),
      textEditCount: window.textEditCount
    }))
    assert.deepEqual(afterWriteAttempt, {
      ...beforeWriteAttempt,
      textEditCount: 0
    })

    await page.evaluate(() => {
      window.mm.renderer.clearActiveNodeList()
      window.mm.renderer.emitNodeActiveEvent()
    })
    await dragAroundBranches(page)
    const boxSelection = await selectedUids(page)
    assert.ok(boxSelection.includes('readonly-a'))
    assert.ok(boxSelection.includes('readonly-b'))
    assert.deepEqual(pageErrors, [])

    console.log(
      'Playwright 鼠标验证通过：默认只读单选可用、Ctrl 多选与框选关闭；启用后多选和框选生效，删除、拖动和双击编辑仍被拒绝。'
    )
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
