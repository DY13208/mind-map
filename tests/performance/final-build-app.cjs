// Owned fixture + real built-App browser harness for the final-build E2E.
//
// Uses work/performance-tdd/final-build-server-child.cjs (default or optimized
// flag profile) and the frozen compiled App in work/performance-tdd/after-web.
// The browser loads room data only through the real product paths
// (/api/auth/me, getFilePreview, getFileSubtree, V2 socket join/sync). No
// mm.setData / afterHttpReplace injection is used to create expected data.
const { fork } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { configureIsolatedEnvironment } = require('./isolation.cjs')
const repo = path.resolve(__dirname, '../..')
const proxyModule = require(path.join(repo, 'web/node_modules/http-proxy'))
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))

const fixtureBoundaries = {
  business: 'Real room ACL/PG, native business HTTP and Socket handlers, PostgresBus and complete webpack App/plugins',
  authentication: 'COLLAB_TEST_ACL transport identity shim only; distinct actors carry distinct userIds and authorization is the real room_members check (forceAcl path)',
  bootstrap: 'Owned Node20 child/control endpoint and loopback proxy; fixture /api/health readiness response and runtime-config.js gateway/V2 flags',
  flags: 'default profile leaves COLLAB_HTTP_DIRECT/MCP_DIRECT/NODE_COUNT_CACHE(_WRITERS_READY)/V2_EVENT_BRIDGE at code defaults (OFF); optimized profile forces them ON for the supplementary path',
  network: 'Owned loopback business HTTP/native WebSocket; external application HTTP/WS blocked.'
}

async function application(profile) {
  configureIsolatedEnvironment()
  const child = fork(path.join(__dirname, 'final-build-server-child.cjs'), [profile], {
    execPath: path.join(repo, 'work/performance-tdd/runtime/node_modules/node/bin/node'),
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const logs = [], pending = new Map()
  child.stdout.on('data', chunk => logs.push(String(chunk)))
  child.stderr.on('data', chunk => logs.push(String(chunk)))
  let sequence = 0, readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  child.on('message', message => {
    if (message.ready) readyResolve(message)
    if (pending.has(message.id)) { const resolve = pending.get(message.id); pending.delete(message.id); resolve(message) }
  })
  child.once('exit', code => readyResolve({ error: 'Final-build test app exited ' + code }))
  async function timed(promise, label) {
    let timer
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 30000) })])
      .finally(() => clearTimeout(timer))
  }
  let started
  try { started = await timed(ready, 'Owned application startup timeout') }
  catch (error) { child.kill(); throw error }
  if (started.error) throw new Error(started.error + '\n' + logs.join('').slice(-3000))
  const control = async (action, fields = {}) => {
    const id = ++sequence
    const response = new Promise(resolve => pending.set(id, resolve))
    child.send({ id, action, ...fields })
    const result = await timed(response, 'Owned application control timeout: ' + action)
    if (result.error) throw new Error(result.error)
    return result.value
  }
  return { ...started, pid: child.pid, control, logs,
    async close({ preserveRooms = false } = {}) {
      if (child.exitCode !== null) return
      const exited = new Promise(resolve => child.once('exit', resolve))
      try {
        const value = await control('stop', { preserveRooms })
        await timed(exited, 'Owned application cleanup timeout')
        return value
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM')
      }
    }
  }
}

async function webServer(app, artifact, served) {
  const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  const proxy = proxyModule.createProxyServer({ target: app.base, ws: true })
  proxy.on('error', (error, req, res) => {
    if (res && res.writeHead && !res.headersSent) res.writeHead(502)
    if (res && res.end) res.end('Owned fixture proxy error')
  })
  const record = (requestPath, file) => {
    try {
      const bytes = fs.readFileSync(file)
      served.set(requestPath, { file: path.relative(artifact, file), bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    } catch (_) { /* directory or stream source */ }
  }
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname)
    // The frozen final18 index.html references its assets under /dist/ (the real
    // deployment mount). Serve those exact bytes from the same frozen artifact
    // root; no artifact rewriting or path patching.
    if (pathname.startsWith('/dist/')) pathname = pathname.slice('/dist'.length)
    if (pathname.startsWith('/api/') || pathname.startsWith('/collab-v2')) return proxy.web(req, res)
    if (pathname === '/runtime-config.js') {
      res.setHeader('content-type', 'application/javascript')
      const body = 'window.__MIND_MAP_RUNTIME__={gateway:true,collabV2:true,publicPath:"/"};'
      res.end(body)
      served.set('/runtime-config.js', { file: 'fixture', bytes: Buffer.byteLength(body),
        sha256: crypto.createHash('sha256').update(body).digest('hex') })
      return
    }
    let file = path.resolve(artifact, '.' + pathname)
    if (!file.startsWith(artifact + path.sep) && file !== artifact) { res.statusCode = 400; res.end(); return }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(artifact, 'index.html')
    record(pathname, file)
    res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  const acceptedSockets = new Set()
  server.on('connection', socket => { acceptedSockets.add(socket); socket.once('close', () => acceptedSockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const closed = new Promise(resolve => server.close(resolve))
      proxy.close(); server.closeAllConnections()
      for (const socket of acceptedSockets) socket.destroy()
      await closed
    }
  }
}

async function startFinalFixture({ instances = 1, profile = 'default', artifact = process.env.PERF_TDD_E2E_ARTIFACT || 'after-web' } = {}) {
  const artifactDir = path.join(repo, 'work/performance-tdd', artifact)
  if (!fs.existsSync(path.join(artifactDir, 'index.html'))) throw new Error('BLOCKED_ENV: compiled web artifact missing for ' + artifact)
  const apps = [], fronts = [], servedAssets = new Map()
  try {
    for (let i = 0; i < instances; i++) { const app = await application(profile); apps.push(app); fronts.push(await webServer(app, artifactDir, servedAssets)) }
    const hashes = fs.readdirSync(path.join(artifactDir, 'js')).filter(name => name.endsWith('.js')).map(name => {
      const content = fs.readFileSync(path.join(artifactDir, 'js', name))
      return [name, crypto.createHash('sha256').update(content).digest('hex')]
    })
    return { profile, instances, apps, fronts, artifact: artifactDir, bundleHashes: hashes, fixtureBoundaries,
      servedAssets: () => Object.fromEntries([...servedAssets.entries()]),
      async close({ preserveRooms = false } = {}) {
        const stops = []
        for (const front of fronts) await front.close()
        for (const app of apps.reverse()) stops.push(await app.close({ preserveRooms }))
        return stops
      }
    }
  } catch (error) {
    for (const front of fronts) await front.close().catch(() => {})
    for (const app of apps.reverse()) await app.close().catch(() => {})
    throw error
  }
}

async function openActorEditor(browser, fixture, { actor = 'owner', roomKey, frontIndex = 0, openPerformance, compactLayout = false, setupTimeoutMs = 120000, liveTimeoutMs = 120000, onPage } = {}) {
  const origin = fixture.fronts[frontIndex % fixture.instances].base
  const allowed = new Set([...fixture.fronts.map(item => item.base), ...fixture.apps.map(item => item.base)])
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.addCookies([...allowed].map(url => ({ name: 'perf_fixture_actor', value: actor, url })))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return allowed.has(url.origin) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  await context.addInitScript(({ compactLayout, openPerformance }) => {
    localStorage.setItem('SIMPLE_MIND_MAP_LOCAL_CONFIG', JSON.stringify({ enableAi: false, showNavigator: false, isZenMode: false }))
    const config = { compactLayout }
    if (openPerformance !== null) config.openPerformance = openPerformance
    localStorage.setItem('SIMPLE_MIND_MAP_CONFIG', JSON.stringify(config))
  }, { compactLayout, openPerformance: openPerformance === undefined ? null : !!openPerformance })
  await context.addInitScript(origins => {
    const NativeWebSocket = window.WebSocket
    window.__nativeEvents = Object.create(null)
    window.WebSocket = new Proxy(NativeWebSocket, { construct(target, args, newTarget) {
      const url = new URL(String(args[0]), location.href)
      const origin = url.origin.replace(/^ws/, 'http')
      if (!origins.includes(origin)) throw new DOMException('Unowned fixture WebSocket blocked', 'SecurityError')
      const socket = Reflect.construct(target, args, newTarget)
      socket.addEventListener('message', event => {
        const raw = typeof event.data === 'string' ? event.data : ''
        const match = raw.match(/^4([23])\d*(\[.*)$/s)
        if (!match) return
        try {
          const value = JSON.parse(match[2])
          const body = match[1] === '2' ? value[1] : value[0]
          if (!body || !body.opId) return
          const receivedAt = performance.timeOrigin + performance.now()
          const record = __nativeEvents[body.opId] || (__nativeEvents[body.opId] = { opId: body.opId })
          if (match[1] === '3' && body.ok && !record.ackAt) record.ackAt = receivedAt
          if (match[1] === '2' && value[0] === 'op:event' && !record.eventAt) record.eventAt = receivedAt
        } catch (_) { /* ignore non-op frames */ }
      })
      return socket
    } })
  }, Array.from(allowed))
  const page = await context.newPage()
  const errors = []
  const network = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => { const u = req.url(); if (u.includes('/api/') || u.includes('/collab-v2')) network.push({ dir: 'req', method: req.method(), url: u.split('?')[0] }) })
  page.on('response', res => { const u = res.url(); if (u.includes('/api/') || u.includes('/collab-v2')) network.push({ dir: 'res', status: res.status(), url: u.split('?')[0] }) })
  if (onPage) await onPage(page, context)
  const startedAt = Date.now()
  let stage = 'navigation'
  try {
    await page.goto(origin + '/?room=' + encodeURIComponent(roomKey), { waitUntil: 'domcontentloaded', timeout: setupTimeoutMs })
    stage = 'editor-ready'
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
    }, null, { timeout: setupTimeoutMs })
    stage = 'collaboration-live'
    await page.waitForFunction(() => {
      const state = window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__()
      return state && state.phase === 'LIVE'
    }, null, { timeout: liveTimeoutMs })
  } catch (error) {
    const diagnostic = await Promise.race([page.evaluate(() => ({
      status: window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__(),
      bootState: window.__COLLAB_V2_STATE__ || null,
      bootError: window.__COLLAB_V2_BOOT_ERROR__ || null,
      apply: window.__COLLAB_V2_APPLY__ || null,
      roomLoadTrace: window.__ROOM_LOAD_TRACE__ || null,
      integrity: window.__ROOM_INTEGRITY_REPORT__ || null,
      runtimeConfig: window.__MIND_MAP_RUNTIME__ || null,
      href: location.href,
      hasMM: !!window.__onlineMM,
      modelCount: window.__onlineMM && window.__onlineMM.renderer && Object.keys(__onlineMM.renderer.nodeCache || {}).length,
      renderedText: document.body.innerText.slice(0, 1500)
    })), new Promise(resolve => setTimeout(() => resolve({ runtimeBlocked: true }), 2000))])
    const output = path.join(repo, 'work/performance-tdd/pi/final-build-e2e/diagnostics')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, `open-${actor}-${Date.now()}.json`), JSON.stringify({ stage, diagnostic, network, errors, error: error.message }, null, 2))
    throw new Error('SETUP_NOT_READY [' + actor + '] at ' + stage + ': ' + error.message + ' ' + JSON.stringify(diagnostic))
  }
  return { context, page, errors, actor, origin, readyMs: Date.now() - startedAt }
}

// Real product model snapshot: full model UID set + counts + rich-text/custom data.
async function modelSnapshot(client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    if (!mm) return null
    const uids = [], rich = [], custom = []
    const seen = new Set()
    const stack = [mm.renderer.renderTree]
    while (stack.length) {
      const node = stack.pop()
      if (!node || !node.data) continue
      const uid = node.data.uid
      uids.push(uid)
      if (node.data.richText) rich.push(uid)
      if (node.data.customMeta) custom.push({ uid, customMeta: node.data.customMeta })
      stack.push(...(node.children || []))
    }
    const state = mm.cooperate && mm.cooperate.collabV2Adapter ? mm.cooperate.collabV2Adapter.getStatus() : null
    let attached = 0
    const draw = mm.nodeDraw && mm.nodeDraw.node
    if (draw) attached = draw.querySelectorAll('g.smm-node').length
    return { unique: new Set(uids).size, total: uids.length, richCount: rich.length, custom,
      attached, openPerformance: mm.opt.openPerformance, layout: mm.getLayout(),
      nodeIndex: mm.renderer.nodeIndex ? mm.renderer.nodeIndex.size : null,
      status: state, uidSetSha256Note: 'uids collected in DFS order' }
  })
}

function uidSetSha256(uids) {
  return crypto.createHash('sha256').update([...uids].sort().join('\n')).digest('hex')
}
function graphUidSet(graph) { return Object.keys(graph || {}) }

module.exports = { startFinalFixture, openActorEditor, modelSnapshot, uidSetSha256, graphUidSet, repo, fixtureBoundaries, chromium }
