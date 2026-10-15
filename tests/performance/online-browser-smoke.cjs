const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))

function deadline(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })])
    .finally(() => clearTimeout(timer))
}

async function openEditor(browser, fixture, index, options = {}) {
  const origin = fixture.fronts[index % fixture.instances].base
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const allowed = new Set([...fixture.fronts.map(item => item.base), ...fixture.apps.map(item => item.base)])
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return allowed.has(url.origin) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  await context.addInitScript(compactLayout => {
    localStorage.setItem('SIMPLE_MIND_MAP_LOCAL_CONFIG', JSON.stringify({ enableAi: false, showNavigator: false, isZenMode: false }))
    // The same real saved preference is used by both frozen before and after App.
    // Default compact diagnostics are kept separately; no feature is stubbed.
    localStorage.setItem('SIMPLE_MIND_MAP_CONFIG', JSON.stringify({ compactLayout }))
  }, options.compactLayout === true)
  await context.addInitScript(origins => {
    const NativeWebSocket = window.WebSocket
    window.__onlineNativeEvents = Object.create(null)
    // Policy only: every allowed connection remains the native browser socket.
    window.WebSocket = new Proxy(NativeWebSocket, { construct(target, args, newTarget) {
      const url = new URL(String(args[0]), location.href)
      const origin = url.origin.replace(/^ws/, 'http')
      if (!origins.includes(origin)) throw new DOMException('Unowned fixture WebSocket blocked', 'SecurityError')
      const socket = Reflect.construct(target, args, newTarget)
      // Read-only listener is installed before Socket.IO binds its message
      // handler. Thus event→model times use one browser epoch clock.
      socket.addEventListener('message', event => {
        const raw = typeof event.data === 'string' ? event.data : ''
        const match = raw.match(/^4([23])\d*(\[.*)$/s)
        if (!match) return
        try {
          const value = JSON.parse(match[2])
          const body = match[1] === '2' ? value[1] : value[0]
          if (!body || !body.opId) return
          const receivedAt = performance.timeOrigin + performance.now()
          const record = __onlineNativeEvents[body.opId] || (__onlineNativeEvents[body.opId] = { opId: body.opId })
          if (match[1] === '3' && body.ok && !record.ackAt) record.ackAt = receivedAt
          if (match[1] === '2' && value[0] === 'op:event' && !record.eventAt) record.eventAt = receivedAt
        } catch (_) { /* Ignore non-operation protocol frames. */ }
      })
      return socket
    } })
  }, Array.from(allowed))
  const page = await context.newPage()
  const errors = []
  const network = { failures: [], sockets: [] }
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', req => network.failures.push({ path: new URL(req.url()).pathname, reason: req.failure().errorText }))
  page.on('websocket', socket => {
    const entry = { url: socket.url().split('?')[0], received: [], sent: [] }
    network.sockets.push(entry)
    socket.on('framereceived', frame => { if (entry.received.length < 12) entry.received.push(String(frame.payload).slice(0, 1500)) })
    socket.on('framesent', frame => { if (entry.sent.length < 12) entry.sent.push(String(frame.payload).slice(0, 1500)) })
  })
  if (options.onPage) await options.onPage(page, context)
  const startedAt = Date.now()
  let stage = 'navigation'
  try {
    await page.goto(origin + '/?room=' + encodeURIComponent(fixture.roomKey), { waitUntil: 'domcontentloaded', timeout: options.setupTimeoutMs || 120000 })
    stage = 'editor-ready'
    if (process.env.PERF_TDD_ONLINE_DIAGNOSTIC === '1') console.log(JSON.stringify({ stage, client: index }))
    await page.waitForFunction(() => {
    let element = document.querySelector('#mindMapContainer')
    while (element) {
      if (element.__vue__ && element.__vue__.mindMap) {
        window.__onlineMM = element.__vue__.mindMap
        return !!window.__onlineMM.renderer.root && !window.__onlineMM.renderer.isRendering
      }
      element = element.parentElement
    }
    return false
    }, null, { timeout: options.setupTimeoutMs || 120000 })
    stage = 'collaboration-live'
    if (process.env.PERF_TDD_ONLINE_DIAGNOSTIC === '1') console.log(JSON.stringify({ stage, client: index }))
    await page.waitForFunction(() => {
      const state = window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__()
      return state && state.phase === 'LIVE'
    }, null, { timeout: options.liveTimeoutMs || 120000 })
  } catch (error) {
    const diagnostic = await deadline(page.evaluate(() => ({
      status: window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__(),
      modelCount: window.__onlineMM && Object.keys(__onlineMM.renderer.nodeCache).length,
      adapter: !!(window.__onlineMM && __onlineMM.cooperate.collabV2Adapter),
      renderedText: document.body.innerText.slice(0, 2000)
    })), 2000, 'Main thread did not answer diagnostics').catch(error => ({ runtimeBlocked: true, reason: error.message }))
    const output = path.join(repo, 'work/performance-tdd', fixture.phase, 'online', options.compactLayout ? 'compact' : 'ordinary-logical')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, `environment-diagnostic-${index}.json`), JSON.stringify({ stage, elapsedMs: Date.now() - startedAt, diagnostic, network, errors }, null, 2))
    await deadline(page.screenshot({ path: path.join(output, `environment-diagnostic-${index}.png`) }), 3000, 'Screenshot blocked').catch(() => {})
    throw new Error('SETUP_NOT_READY: complete App did not reach LIVE at ' + stage + '; diagnostic=' + JSON.stringify(diagnostic))
  }
  const layout = await page.evaluate(() => {
    __onlineMM.updateConfig({ compactLayout: JSON.parse(localStorage.getItem('SIMPLE_MIND_MAP_CONFIG')).compactLayout })
    return { layout: __onlineMM.getLayout(), compactLayout: __onlineMM.opt.compactLayout,
      stored: JSON.parse(localStorage.getItem('SIMPLE_MIND_MAP_CONFIG')) }
  })
  assert.equal(layout.layout, 'logicalStructure')
  assert.equal(layout.compactLayout, options.compactLayout === true)
  return { context, page, errors, layout, readyMs: Date.now() - startedAt }
}

async function smoke() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'before'
  const fixture = await startFixture({ phase, instances: 2 })
  let browser, clients = []
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const observe = async page => {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
      const index = clients.length
      setTimeout(async () => {
        const profile = await cdp.send('Profiler.stop').catch(() => null)
        if (profile) {
          const output = path.join(repo, 'work/performance-tdd', phase, 'online', 'ordinary-logical')
          fs.mkdirSync(output, { recursive: true })
          fs.writeFileSync(path.join(output, `setup-cpu-profile-${index}.json`), JSON.stringify(profile))
        }
      }, 15000).unref()
    }
    clients.push(await openEditor(browser, fixture, 0, { setupTimeoutMs: 30000, liveTimeoutMs: 20000, onPage: observe }))
    clients.push(await openEditor(browser, fixture, 1, { setupTimeoutMs: 30000, liveTimeoutMs: 20000, onPage: observe }))
    const tree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    const persisted = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    const states = []
    for (const client of clients) {
      await client.page.evaluate(async ({ tree, persisted }) => {
        const mm = __onlineMM
        await new Promise(resolve => {
          const done = () => { mm.off('node_tree_render_end', done); resolve() }
          mm.on('node_tree_render_end', done); mm.setData(tree)
        })
        // The same real baseline capture used after authoritative history load.
        // This setup is reported separately from initial safe load and editing.
        mm.cooperate.afterHttpReplace({ version: persisted.revision, updated_at: persisted.updated_at }, tree)
      }, { tree, persisted })
      await client.page.waitForFunction(() => __onlineMM.cooperate.collabV2Adapter.getStatus().phase === 'LIVE', null, { timeout: 30000 })
      states.push(await client.page.evaluate(() => {
        let models = 0
        const stack = [__onlineMM.renderer.renderTree]
        while (stack.length) { const node = stack.pop(); if (!node) continue; models++; stack.push(...(node.children || [])) }
        return { nodes: Object.keys(__onlineMM.renderer.nodeCache).length, models,
          status: __COLLAB_V2_STATUS__(), adapter: !!__onlineMM.cooperate.collabV2Adapter,
          safeLoadMode: __onlineMM.cooperate.safeLoadMode, layout: __onlineMM.getLayout(), compactLayout: __onlineMM.opt.compactLayout }
      }))
    }
    const result = { phase, fixture: '6001 real persisted nodes; two complete built App clients, two PG/socket processes',
      runtime: fixture.apps.map(app => app.runtime), browser: browser.version(), states, persisted,
      errors: clients.flatMap(client => client.errors), bundleHashes: fixture.bundleHashes }
    const output = path.join(repo, 'work/performance-tdd', phase, 'online', 'ordinary-logical')
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'smoke.json'), JSON.stringify(result, null, 2))
    assert.ok(states.every(state => state.models === 6001 && state.status.phase === 'LIVE' && state.adapter))
    console.log(JSON.stringify({ phase, states, errors: result.errors }))
  } finally {
    for (const client of clients) await deadline(client.context.close(), 5000, 'Context cleanup timeout').catch(() => {})
    if (browser) await deadline(browser.close(), 10000, 'Browser cleanup timeout').catch(() => {})
    await fixture.close()
  }
}
module.exports = { openEditor, smoke }
if (require.main === module) smoke().catch(error => { console.error(error); process.exitCode = 1 })
