// Step 1 only: isolated baseline, no production endpoints or credentials.
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net')
const { execFileSync } = require('child_process')
const { randomUUID, createHash } = require('crypto')
const { performance } = require('perf_hooks')
const { summarize, correlate } = require('./metrics.cjs')
const root = path.resolve(__dirname, '../../..')
const out = 'D:/mind-map-collab-round1-results'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(out, runId)
const apiPort = 21314, mcpPort = 21315, webPort = 21313
const origin = `http://127.0.0.1:${webPort}`
const token = 'round1-diagnostic-only-mcp-token-32-chars'
const network = 'mindmap-round1-diag-net'
const names = ['mindmap-round1-diag-app', 'round1-pg', 'round1-redis']
const browserPath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const { chromium } = require(path.join(root, 'simple-mind-map/node_modules/playwright'))
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const raw = []
function record(row) { const full = { atMs: Date.now(), ...row }; raw.push(full); fs.appendFileSync(path.join(runDir, 'client.jsonl'), JSON.stringify(full) + '\n') }
function available(port) { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)) }) }
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await wait(200) }
  throw new Error('diagnostic wait timed out')
}
function tree(size, shape = 'mixed', collapsed = false) {
  const nodes = Array.from({ length: size }, (_, i) => ({ data: { uid: i ? `n${i}` : 'root', text: `Node ${i}`, expand: true }, children: [] }))
  for (let i = 1; i < size; i++) {
    const parent = shape === 'wide' ? 0 : shape === 'deep' ? i - 1 : Math.floor((i - 1) / 8)
    nodes[parent].children.push(nodes[i])
  }
  if (collapsed) for (const child of nodes[0].children) child.data.expand = false
  return nodes[0]
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) })
  const data = await response.json()
  if (!response.ok) throw new Error(`diagnostic HTTP ${response.status} ${data.code || ''}`)
  return data
}
let cookie
const api = (pathname, body) => request(origin + pathname, { method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined })
async function seed(size, shape, collapsed) {
  const roomKey = 'diag-round1-' + randomUUID()
  await api('/api/files', { room_key: roomKey, title: 'Round1 synthetic fixture' })
  await api(`/api/files/${roomKey}/replace`, { tree: tree(size, shape, collapsed), client_id: 'diag-seed', operation_id: randomUUID(), allowFullTree: true })
  return roomKey
}
function mindMap() {
  const seen = new Set()
  const walk = vm => {
    if (!vm || seen.has(vm)) return null
    seen.add(vm)
    if (vm.mindMap?.renderer) return vm.mindMap
    for (const child of vm.$children || []) { const hit = walk(child); if (hit) return hit }
    return null
  }
  return walk(document.querySelector('#app')?.__vue__)
}
function initBrowserDiagnostics() {
  window.__round1 = { events: [], dropped: 0 }
  window.__COLLAB_PERF_OBSERVER__ = event => {
    if (window.__round1.events.length >= 100000) { window.__round1.dropped++; return }
    window.__round1.events.push({ ...event, atMs: performance.timeOrigin + performance.now() })
  }
  try { new PerformanceObserver(list => list.getEntries().forEach(entry => window.__COLLAB_PERF_OBSERVER__({ kind: 'long_task', elapsedMs: entry.duration }))).observe({ type: 'longtask', buffered: true }) } catch (_) {}
}
async function ready(page) {
  await page.waitForSelector('.smm-node', { timeout: 60000 })
  await page.waitForFunction(() => {
    const state = window.__COLLAB_V2_STATE__
    return state && (state.status === 'live' || state.phase === 'LIVE')
  }, null, { timeout: 60000 })
  await page.waitForFunction(`(${mindMap.toString()})()?.renderer?.isRendering === false`, null, { timeout: 60000 })
}
async function attempt(metric, fn, details = {}) {
  record({ kind: 'attempt_started', metric, ...details })
  const started = performance.now()
  try { const result = await fn(); record({ kind: 'sample', metric, ...details, ok: true, elapsedMs: performance.now() - started, ...result }); return result }
  catch (error) { record({ kind: 'sample', metric, ...details, ok: false, elapsedMs: performance.now() - started, code: error.code || error.name }); return null }
}
let rpcId = 0, session
async function rpc(method, params) {
  const response = await fetch(origin + '/mcp', { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  session = response.headers.get('mcp-session-id') || session
  const text = await response.text()
  const data = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5))
  if (!response.ok || data.error || data.result?.isError) throw new Error('diagnostic MCP rejected')
  return data.result
}
function gateway() {
  const build = path.join(out, 'build')
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname
    if (pathname.endsWith('runtime-config.js')) { res.setHeader('Content-Type', 'application/javascript'); res.end('window.__MIND_MAP_RUNTIME__={gateway:true,publicPath:"/"}'); return }
    if (pathname.startsWith('/api') || pathname.startsWith('/collab-v2') || pathname === '/mcp' || pathname === '/__round1_clock') {
      const proxy = http.request({ host: '127.0.0.1', port: pathname === '/mcp' ? mcpPort : apiPort,
        path: req.url, method: req.method, headers: req.headers }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
      proxy.on('error', () => { res.statusCode = 502; res.end() }); req.pipe(proxy); return
    }
    const target = path.resolve(build, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!target.startsWith(build + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; res.end(); return }
    const ext = path.extname(target)
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream')
    fs.createReadStream(target).pipe(res)
  })
  server.on('upgrade', (req, socket, head) => {
    const backend = net.connect(apiPort, '127.0.0.1', () => {
      backend.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
      if (head.length) backend.write(head); socket.pipe(backend); backend.pipe(socket)
    }); backend.on('error', () => socket.destroy()); socket.on('error', () => backend.destroy())
  })
  return new Promise(resolve => server.listen(webPort, '127.0.0.1', () => resolve(server)))
}
async function main() {
  fs.mkdirSync(runDir, { recursive: true })
  if (!fs.existsSync(path.join(out, 'build/index.html'))) throw new Error('Build current checkout into diagnostic build directory first')
  for (const port of [21313, 21314, 21315, 25513, 26513]) await available(port)
  const existing = docker(['ps', '-a', '--format', '{{.Names}}']).split('\n')
  if (names.some(name => existing.includes(name))) throw new Error('Existing diagnostic container: refusing to replace it')
  const networks = docker(['network', 'ls', '--format', '{{.Name}}']).split('\n')
  if (networks.includes(network)) throw new Error('Existing diagnostic network: refusing to reuse unknown resources')
  const flags = { COLLAB_MCP_DIRECT: '0', COLLAB_V2_EVENT_BRIDGE: process.argv.includes('--bridge-control') ? '1' : '0', HISTORY_CHECKPOINT_EVERY: '200',
    KNOWLEDGE_COMPILER_ENABLED: 'true', WIKI_COMPILER_SYNC_ENABLED: 'true' }
  record({ kind: 'run_start', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDiffHash: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'), flags, runDir,
    measuredSourceHashes: Object.fromEntries(['simple-mind-map/bin/collabV2/adapter.js', 'simple-mind-map/bin/collabV2/performanceObserver.js', 'simple-mind-map/src/core/render/Render.js', 'simple-mind-map/scripts/collab-round1/preload.cjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    browserBuildHash: createHash('sha256').update(fs.readFileSync(path.join(out, 'build/js/app.js'))).digest('hex'),
    imageId: docker(['image', 'inspect', 'mind-map-app', '--format', '{{.Id}}']), checkpoint: 200 })
  let server, browser, context, createdNetwork = false
  const created = []
  try {
    docker(['network', 'create', network]); createdNetwork = true
    docker(['run', '-d', '--name', names[1], '--network', network, '-p', '127.0.0.1:25513:5432', '-e', 'POSTGRES_DB=diag_collab_round1', '-e', 'POSTGRES_USER=diag', '-e', 'POSTGRES_PASSWORD=round1-test-only', 'postgres:16-alpine']); created.push(names[1])
    docker(['run', '-d', '--name', names[2], '--network', network, '-p', '127.0.0.1:26513:6379', 'redis:7-alpine']); created.push(names[2])
    await until(() => { try { docker(['exec', names[1], 'pg_isready', '-U', 'diag']); return true } catch (_) { return false } })
    const env = { ...flags, MIND_MAP_SKIP_ROOT_ENV: '1', COLLAB_ROUND1_DIAG: '1', PGHOST: 'round1-pg', PGPORT: '5432',
      PGDATABASE: 'diag_collab_round1', PGUSER: 'diag', PGPASSWORD: 'round1-test-only', REDIS_URL: 'redis://round1-redis:6379',
      COLLAB_EVENT_BUS: 'redis', COLLAB_V2: '1', COLLAB_E2E: '1', WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef',
      COLLAB_V2_TRACE: '0', COLLAB_TRACE: '0',
      WECOM_AGENT_ID: '1000001', WECOM_SECRET: 'round1-test-only', AUTH_SESSION_SECRET: 'round1-isolated-session-secret-32-chars',
      WECOM_REDIRECT_URI: origin + '/api/auth/wecom/callback',
      AUTH_APP_ORIGIN: origin, AUTH_ALLOWED_ORIGINS: origin, AUTH_COOKIE_SECURE: 'false', MCP_TOKEN: token,
      HOST: '0.0.0.0', PORT: '1234', MCP_HOST: '0.0.0.0', MCP_PORT: '3847', MIND_MAP_API: 'http://127.0.0.1:1234',
      NODE_OPTIONS: '--require=/round1/preload.cjs', DOCMOST_SYNC_ENABLED: 'false', KNOWLEDGE_OUTPUT_DIR: '/tmp/round1-knowledge',
      WIKI_COMPILER_OUTPUT_DIR: '/tmp/round1-wiki', COLLAB_RATE_LIMIT_PER_ROOM: '800', COLLAB_RATE_LIMIT_GLOBAL: '8000' }
    const args = ['run', '-d', '--name', names[0], '--network', network, '-p', '127.0.0.1:21314:1234', '-p', '127.0.0.1:21315:3847',
      '-v', path.join(root, 'simple-mind-map/bin') + ':/app/simple-mind-map/bin:ro', '-v', path.join(root, 'simple-mind-map/src') + ':/app/simple-mind-map/src:ro',
      '-v', __dirname + ':/round1:ro', '-v', runDir + ':/round1-out']
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    args.push('--entrypoint', '/bin/sh', 'mind-map-app', '/round1/start.sh')
    docker(args); created.push(names[0]); server = await gateway()
    await until(async () => { try { await api('/api/health'); return true } catch (_) { return false } })
    const clocks = []
    for (let i = 0; i < 10; i++) {
      const before = performance.timeOrigin + performance.now()
      const remote = await request(origin + '/__round1_clock')
      const after = performance.timeOrigin + performance.now()
      clocks.push({ offsetMs: remote.atMs - (before + after) / 2, uncertaintyMs: (after - before) / 2 })
    }
    clocks.sort((a,b) => a.uncertaintyMs - b.uncertaintyMs)
    const clock = clocks[0]
    record({ kind: 'clock_calibration', ...clock, samples: clocks })
    const user = await api('/api/auth/e2e-identity', { userId: 'diag-round1-owner' }); cookie = 'mind_map_session=' + user.token
    browser = await chromium.launch({ headless: true, executablePath: browserPath })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addCookies([{ name: 'mind_map_session', value: user.token, url: origin }]); await context.addInitScript(initBrowserDiagnostics)
    const roomKey = await seed(1000, 'mixed', true), page = await context.newPage()
    const requests = new WeakMap()
    page.on('request', req => { if (/\/(subtree|locate)(?:\?|$)/.test(req.url())) { requests.set(req, performance.now()); record({ kind: 'lazy_request', endpoint: new URL(req.url()).pathname.split('/').pop() }) } })
    page.on('requestfinished', async req => { const start = requests.get(req); if (start != null) { const res = await req.response(); record({ kind: 'sample', metric: 'lazyRequest', elapsedMs: performance.now() - start, ok: !!res && res.status() < 400 }) } })
    page.on('requestfailed', req => { const start = requests.get(req); if (start != null) record({ kind: 'sample', metric: 'lazyRequest', elapsedMs: performance.now() - start, ok: false }) })
    async function collectBrowser(client = 'browser') {
      const data = await page.evaluate(() => ({ events: window.__round1?.events || [], dropped: window.__round1?.dropped || 0 }))
      for (const event of data.events) record({ ...event, client })
      record({ kind: 'observer_loss', client, dropped: data.dropped })
      await page.evaluate(() => { window.__round1.events = []; window.__round1.dropped = 0 })
    }
    for (let i = 0; i < 5; i++) {
      await attempt('firstOpen', async () => { await page.goto(origin + '/?room=' + roomKey); await ready(page); return { visibleNodes: await page.locator('.smm-node').count() } }, { iteration: i, mode: i ? 'cachedReload' : 'coldContext' })
      await collectBrowser(); await wait(250)
    }
    await page.evaluate(`window.__round1MindMap = (${mindMap.toString()})();`)
    for (let i = 0; i < 10; i++) for (const expand of [true, false]) {
      await attempt(expand ? 'expand' : 'collapse', () => page.evaluate(expand => new Promise((resolve, reject) => {
        const mm = window.__round1MindMap, node = mm.renderer.findNodeByUid('n1')
        if (!node) { reject(new Error('node missing')); return }
        const timer = setTimeout(() => { mm.off('node_tree_render_end', end); reject(new Error('render timeout')) }, 30000)
        const end = () => { clearTimeout(timer); mm.off('node_tree_render_end', end); requestAnimationFrame(() => resolve({ visibleNodes: Object.keys(mm.renderer.nodeCache).length })) }
        mm.on('node_tree_render_end', end); mm.execCommand('SET_NODE_EXPAND', node, expand)
      }), expand), { iteration: i })
      await wait(50)
    }
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'round1-diagnostic', version: '1' } })
    const expected = [], successfulOps = []
    for (let i = 0; i < 20; i++) {
      const opId = randomUUID(); expected.push({ client: 'browser', opId })
      const result = await attempt('mcpWrite', async () => { await rpc('tools/call', { name: 'add_node', arguments: { room_key: roomKey, parent: 'n1', text: `Diagnostic insert ${i}`, operation_id: opId } }); return { opId } }, { opId, iteration: i })
      if (result) successfulOps.push(opId)
    }
    await wait(3000)
    await collectBrowser()
    record({ kind: 'delivery_window', stage: 'beforeSocketTrigger', expectedOperations: successfulOps.length })
    // Real socket write exposes the baseline gap accumulated by legacy MCP.
    await attempt('socketTrigger', () => page.evaluate(async () => {
      const result = await window.__round1MindMap.cooperate.collabV2Adapter.submitOperation({ type: 'node.update', payload: { uid: 'root', text: 'Diagnostic trigger' } })
      if (!result || result.ok === false) throw new Error('SOCKET_TRIGGER_FAILED')
      return { serverRevision: result.serverRevision }
    }))
    await wait(5000); await collectBrowser()
    const status = await page.evaluate(() => window.__round1MindMap.cooperate.collabV2Adapter.getDebugState())
    record({ kind: 'client_status', client: 'browser', gapRecoveredOps: status.gapRecoveredOps, snapshotRecoveryCount: status.snapshotRecoveryCount, lastServerRevision: status.lastServerRevision })
    const db = docker(['exec', names[1], 'psql', '-U', 'diag', '-d', 'diag_collab_round1', '-tAc',
      `select json_build_object('operations',count(*),'distinctOperations',count(distinct operation_id),'maxVersion',max(version),'minVersion',min(version)) from room_operations where room_key='${roomKey}'`])
    record({ kind: 'database_consistency', ...JSON.parse(db) })
    const expectedIds = successfulOps.map(id => `'${id}'`).join(',') || "'00000000-0000-0000-0000-000000000000'"
    const ackedCount = Number(docker(['exec', names[1], 'psql', '-U', 'diag', '-d', 'diag_collab_round1', '-tAc',
      `select count(*) from room_operations where room_key='${roomKey}' and operation_id in (${expectedIds})`]))
    record({ kind: 'acked_persistence', expected: successfulOps.length, actual: ackedCount, ok: ackedCount === successfulOps.length })
    const roomVersion = Number(docker(['exec', names[1], 'psql', '-U', 'diag', '-d', 'diag_collab_round1', '-tAc', `select version from rooms where room_key='${roomKey}'`]))
    const dbState = JSON.parse(db)
    record({ kind: 'version_consistency', roomVersion, clientVersion: status.lastServerRevision,
      logContinuous: dbState.operations === dbState.maxVersion - dbState.minVersion + 1,
      noDuplicateOps: dbState.operations === dbState.distinctOperations,
      roomMatchesLog: roomVersion === dbState.maxVersion })
    await wait(1200)
    const commits = new Map()
    for (const file of fs.readdirSync(runDir).filter(x => /^server-.*\.jsonl$/.test(x))) {
      for (const line of fs.readFileSync(path.join(runDir, file), 'utf8').trim().split('\n').filter(Boolean)) {
        const row = JSON.parse(line); if (row.kind === 'commit') commits.set(row.opId, { ...row, atMs: row.atMs - clock.offsetMs })
      }
    }
    const linked = correlate(commits, raw.filter(x => x.client), expected.filter(x => successfulOps.includes(x.opId)), performance.timeOrigin + performance.now())
    for (const sample of linked.samples) record({ kind: 'sample', ...sample })
    for (const issue of linked.issues) record({ kind: 'delivery_issue', ...issue })
    record({ kind: 'run_complete', correctnessGate: 'baseline-only; no improvement claim' })
  } catch (error) {
    record({ kind: 'run_failure', code: error.code || error.name, message: error.message })
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) await new Promise(resolve => server.close(resolve))
    for (const name of created.reverse()) { try { if (name === names[0]) fs.writeFileSync(path.join(runDir, 'server.log'), docker(['logs', name])); docker(['rm', '-f', name]) } catch (_) {} }
    if (createdNetwork) try { docker(['network', 'rm', network]) } catch (_) {}
    const metrics = [...new Set(raw.filter(x => x.kind === 'sample').map(x => x.metric))]
    const summary = { runId, flags: raw.find(x => x.kind === 'run_start')?.flags,
      metrics: Object.fromEntries(metrics.map(metric => [metric, summarize(raw.filter(x => x.kind === 'sample' && x.metric === metric))])),
      navigationModes: Object.fromEntries(['coldContext','cachedReload'].map(mode => [mode, summarize(raw.filter(x => x.metric === 'firstOpen' && x.kind === 'sample' && x.mode === mode))])),
      gapSync: raw.filter(x => x.kind === 'gap_sync').length, resnapshotAttempts: raw.filter(x => x.kind === 'resnapshot_attempt').length,
      duplicateReceives: raw.filter(x => x.kind === 'event_duplicate').length, deliveryIssues: raw.filter(x => x.kind === 'delivery_issue'),
      complete: raw.some(x => x.kind === 'run_complete'), rawDirectory: runDir }
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
