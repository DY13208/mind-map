'use strict'
// Three real compiled-App browser contexts + native MCP/HTTP/Socket + an owned
// ephemeral PostgreSQL database. Does not change any running service or .env.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, fork } = require('node:child_process')
const { randomUUID, randomBytes } = require('node:crypto')
const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'simple-mind-map')
const { Pool } = require(path.join(APP, 'node_modules/pg'))
const proxyModule = require(path.join(ROOT, 'web/node_modules/http-proxy'))
const PLAYWRIGHT = [path.join(ROOT, 'output/performance-repair-20261013/dependencies/node_modules/playwright'),
  path.join(APP, 'node_modules/playwright'), process.env.MCP_GUARDS_PLAYWRIGHT].filter(Boolean)
const BUILD = path.resolve(process.env.MCP_GUARDS_BUILD_DIR || path.join(ROOT, 'output/mcp-write-guards/build'))
const id = randomUUID().replace(/-/g, '').slice(0, 12)
const database = 'mcp_guards_test_' + id
const roomKey = 'mcp-guards-' + id
const OUT = process.env.MCP_GUARDS_OUTPUT_DIR
  ? path.resolve(process.env.MCP_GUARDS_OUTPUT_DIR, id)
  : path.join(ROOT, 'output/mcp-write-guards', id)
const pg = { host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password' }
const report = { id, database, roomKey, startedAt: new Date().toISOString(), checks: [], scope: '3 real browsers, owned 10000-node room, native MCP and product backend; test-only identity endpoint; loopback traffic only' }
const children = []
const secrets = [pg.password]
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let admin, pool, browser, gateway, created = false
let activeClients = []
function redact(value) { let text = String(value); for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]'); return text }
async function check(name, fn) {
  const start = performance.now()
  let result
  try { result = await fn() } catch (error) {
    report.failedCheck = name
    for (const { page, actor } of activeClients) {
      const failure = await page.evaluate(() => ({ trace: window.__concurrentAddTrace,
        sessions: window.__guardMM?.cooperate?.editSessionManager?.list(),
        status: window.__guardMM?.cooperate?.collabV2Adapter?.getStatus() })).catch(() => null)
      fs.writeFileSync(path.join(OUT, 'failure-state-' + actor + '.json'), JSON.stringify(failure, null, 2))
      await page.screenshot({ path: path.join(OUT, 'failed-check-client-' + actor + '.png') }).catch(() => {})
    }
    throw error
  }
  report.checks.push({ name, ok: true, durationMs: Math.round(performance.now() - start), ...(result || {}) })
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2))
  console.log('PASS ' + name)
  return result
}
async function freePort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function child(file, args, env) {
  const processChild = spawn(process.execPath, ['--require', path.join(ROOT, 'scripts/mcp-guards-process-metrics.cjs'), file, ...args], {
    cwd: APP, env: { ...env, MCP_GUARDS_METRICS_FILE: path.join(OUT, path.basename(file) + '.metrics.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const tail = []
  for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', bytes => {
    const text = redact(bytes)
    tail.push(text); if (tail.length > 30) tail.shift()
    fs.appendFileSync(path.join(OUT, path.basename(file) + '.log'), text)
  })
  processChild.tail = () => tail.join('').slice(-2500)
  children.push(processChild)
  return processChild
}
async function ready(origin, processChild, endpoint) {
  for (let i = 0; i < 180; i++) {
    assert.equal(processChild.exitCode, null, processChild.tail())
    try { const response = await fetch(origin + endpoint); if (response.ok) return } catch (_) {}
    await pause(250)
  }
  throw new Error('Owned service startup timeout: ' + processChild.tail())
}
async function request(origin, pathname, token, body, method = 'POST') {
  const response = await fetch(origin + pathname, { method, headers: { 'Content-Type': 'application/json', Origin: origin,
    ...(token ? { Cookie: 'mind_map_session=' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error || data.code || String(response.status)), { code: data.code, data, status: response.status })
  return data
}
async function startGateway(apiPort, mcpPort) {
  const proxy = proxyModule.createProxyServer({ ws: true, xfwd: true })
  proxy.on('error', (_, req, res) => { if (res?.writeHead && !res.headersSent) res.writeHead(502); if (res?.end) res.end() })
  proxy.on('proxyReq', (proxyReq, req) => proxyReq.setHeader('X-Forwarded-Host', req.headers.host))
  proxy.on('proxyReqWs', (proxyReq, req) => proxyReq.setHeader('X-Forwarded-Host', req.headers.host))
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    let pathname = new URL(req.url, 'http://owned.invalid').pathname
    if (pathname === '/runtime-config.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end('window.__MIND_MAP_RUNTIME__={gateway:true,collabV2:true,publicPath:"/"};') }
    if (pathname.startsWith('/api/') || pathname.startsWith('/collab-v2')) return proxy.web(req, res, { target: 'http://127.0.0.1:' + apiPort })
    if (pathname === '/mcp') return proxy.web(req, res, { target: 'http://127.0.0.1:' + mcpPort })
    if (pathname.startsWith('/dist/')) pathname = pathname.slice(5)
    let file = path.resolve(BUILD, '.' + decodeURIComponent(pathname))
    if (!file.startsWith(BUILD + path.sep) && file !== BUILD) { res.writeHead(400); return res.end() }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(BUILD, 'index.html')
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head, { target: 'http://127.0.0.1:' + apiPort }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + server.address().port, async close() {
    proxy.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  } }
}
function mapInBrowser() {
  const stack = [document.querySelector('#app')?.__vue__], seen = new Set()
  while (stack.length) { const vm = stack.pop(); if (!vm || seen.has(vm)) continue; seen.add(vm)
    if (vm.mindMap?.cooperate?.collabV2Adapter) return vm.mindMap
    stack.push(...(vm.$children || [])) }
  return null
}
async function openClient(chromium, origin, identity, actor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.addCookies([{ name: 'mind_map_session', value: identity.token, url: origin }])
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  await context.addInitScript(() => localStorage.setItem('SIMPLE_MIND_MAP_LOCAL_CONFIG', JSON.stringify({ enableAi: false, showNavigator: false, showNavigatorToolbar: false })))
  const page = await context.newPage(), errors = [], consoleCounts = { v2Trace: 0 }
  page.setDefaultTimeout(20000)
  page.setDefaultNavigationTimeout(120000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    const value = redact(message.text())
    if (value.startsWith('[v2-trace]')) consoleCounts.v2Trace += 1
    if (/v2-trace|collab-trace|remote\.|failed|Error|error/i.test(value)) {
      fs.appendFileSync(path.join(OUT, 'browser-' + actor + '.log'), value.slice(0, 8000) + '\n')
    }
  })
  await page.goto(origin + '/?room=' + roomKey, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(`(() => { const mm = (${mapInBrowser.toString()})(); if(mm) window.__guardMM=mm; return mm && mm.renderer.root && !mm.renderer.isRendering && mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'; })()`, null, { timeout: 120000 })
  await page.evaluate(() => {
    window.__guardMetrics = { layouts: 0, remote: 0 }
    const originalSnapshot = __guardMM.cooperate.persistTraceSnapshot
    window.__traceSnapshotCalls = 0
    __guardMM.cooperate.persistTraceSnapshot = function (...args) {
      window.__traceSnapshotCalls++
      return originalSnapshot.apply(this, args)
    }
    __guardMM.cooperate.__guardTraceSnapshotWrapped = true
    __guardMM.on('node_tree_render_end', () => __guardMetrics.layouts++)
    const original = __guardMM.cooperate.applyV2RemoteOperation.bind(__guardMM.cooperate)
    __guardMM.cooperate.applyV2RemoteOperation = (...args) => { __guardMetrics.remote++; return original(...args) }
  })
  return { context, page, actor, errors, consoleCounts }
}
async function mcpClient(origin, token) {
  let session, sequence = 0
  async function rpc(method, params, notification = false) {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++sequence }), method, params }) })
    session = response.headers.get('mcp-session-id') || session
    const text = await response.text()
    assert.ok(response.ok, 'MCP transport ' + response.status + ': ' + text.slice(0, 300))
    if (notification) return
    const frames = text.startsWith('event:') || text.startsWith('data:') ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)]
    const frame = frames.find(frame => frame.id === sequence) || frames[frames.length - 1]
    if (frame.error) throw new Error(JSON.stringify(frame.error))
    return frame.result
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'owned-mcp-guards-acceptance', version: '1' } })
  await rpc('notifications/initialized', {}, true)
  return async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args })
    const value = result.structuredContent || (() => { try { return JSON.parse(result.content?.find(item => item.type === 'text')?.text) } catch (_) { return { error: result.content?.[0]?.text } } })()
    return { ...value, toolError: !!result.isError,
      ...(result.isError ? { toolErrorText: result.content?.find(item => item.type === 'text')?.text || '' } : {}) }
  }
}
async function main() {
  const setupOnly = process.argv.includes('--setup-check')
  const apiOnly = process.argv.includes('--api-check')
  const deleteTokenOnly = process.argv.includes('--delete-token-only')
  const interactionsOnly = process.argv.includes('--interactions-only')
  const concurrentAddOnly = process.argv.includes('--concurrent-add-only')
  const compatMode = process.argv.includes('--compat-mode')
  const traceQuietCheck = process.argv.includes('--trace-quiet-check')
  const draftDisplayCheck = process.argv.includes('--draft-display-check')
  report.writeMode = compatMode ? 'compatibility (Direct and event bridge disabled)' : 'Direct + event bridge'
  const expectConcurrentAddSuccess = process.argv.includes('--expect-concurrent-add-success')
  if (concurrentAddOnly) report.scope = 'Focused concurrent child-add repro: owned 10000-node PostgreSQL room + three native browsers; no full acceptance suite'
  if (apiOnly) report.scope = 'Owned 10000-node PostgreSQL room + native MCP/HTTP only; browser acceptance not run'
  if (!setupOnly && !apiOnly) assert.ok(fs.existsSync(path.join(BUILD, 'index.html')), 'Build the candidate App into ' + BUILD + ' first')
  fs.mkdirSync(OUT, { recursive: true })
  admin = new Pool({ ...pg, max: 1 })
  const identity = await admin.query('select current_database() as db,current_user as usr')
  assert.deepEqual(identity.rows[0], { db: pg.database, usr: pg.user })
  assert.match(database, /^mcp_guards_test_[a-f0-9]{12}$/)
  await admin.query('create database "' + database + '"'); created = true
  pool = new Pool({ ...pg, database, max: 3 })
  const apiPort = await freePort(), mcpPort = await freePort()
  gateway = await startGateway(apiPort, mcpPort)
  const origin = gateway.origin, secret = randomBytes(32).toString('hex'); secrets.push(secret)
  const env = { ...process.env, MIND_MAP_SKIP_ROOT_ENV: '1', PGHOST: pg.host, PGPORT: String(pg.port), PGDATABASE: database,
    NODE_PATH: [path.join(ROOT, 'output/performance-repair-20261013/dependencies/node_modules'), path.join(APP, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
    PGUSER: pg.user, PGPASSWORD: pg.password, HOST: '127.0.0.1', PORT: String(apiPort), COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: compatMode ? '0' : '1',
    COLLAB_HTTP_DIRECT: compatMode ? '0' : '1', COLLAB_MCP_DIRECT: compatMode ? '0' : '1', COLLAB_EVENT_BUS: 'postgres', COLLAB_OUTBOX_PUBLISHER: '0',
    COLLAB_RATE_LIMIT_PER_ROOM: '4000', COLLAB_RATE_LIMIT_GLOBAL: '8000', COLLAB_E2E: '1',
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef', WECOM_AGENT_ID: '1000001', WECOM_SECRET: 'isolated-only-secret',
    AUTH_SESSION_SECRET: randomBytes(32).toString('hex'), WECOM_REDIRECT_URI: origin + '/api/auth/wecom/callback',
    AUTH_APP_ORIGIN: origin, AUTH_ALLOWED_ORIGINS: origin, AUTH_COOKIE_SECURE: 'false',
    ONEID_AUTH_ENABLED: '0', WORKBUDDY_AUTH_ENABLED: '0', MCP_TOKEN: secret, MCP_HOST: '127.0.0.1', MCP_PORT: String(mcpPort),
    MIND_MAP_API: 'http://127.0.0.1:' + apiPort, MCP_CLIENT_ID: 'guards-' + id,
    KNOWLEDGE_COMPILER_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false',
    YIRAN_UPSTREAM: 'http://127.0.0.1:9', JOBHUB_UPSTREAM: 'http://127.0.0.1:9', BRIDGE_UPSTREAM: 'http://127.0.0.1:9', COGNEE_API: 'http://127.0.0.1:9' }
  secrets.push(env.AUTH_SESSION_SECRET)
  const api = child(path.join(APP, 'bin/collabServer.js'), [], env)
  await ready('http://127.0.0.1:' + apiPort, api, '/api/health')
  for (const filename of ['009_mcp_archive_operation_id_index.up.sql', '010_node_count_cache_generation.up.sql', '011_access_request_roles.up.sql', '012_mcp_terminal_receipts.up.sql']) {
    const file = path.join(APP, 'migrations', filename)
    if (!fs.existsSync(file)) continue
    const sql = fs.readFileSync(file, 'utf8')
    if (filename.startsWith('009')) { for (const statement of sql.split(';').filter(part => part.trim())) await pool.query(statement) }
    else await pool.query(sql)
  }
  const identities = []
  for (const actor of ['owner', 'editor-a', 'editor-b']) {
    const identity = await request(origin, '/api/auth/e2e-identity', null, { userId: 'guards-' + id + '-' + actor, name: actor })
    secrets.push(identity.token); identities.push(identity)
  }
  const seeder = fork(path.join(__dirname, 'mcp-guards-seed.cjs'), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  children.push(seeder)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Seed timeout')), 60000)
    seeder.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message) })
    seeder.once('error', reject)
    seeder.send({ roomKey, userIds: identities.map(item => item.userId) })
  })
  const mcp = child(path.join(APP, 'bin/mcpServer.mjs'), ['--http'], env)
  await ready('http://127.0.0.1:' + mcpPort, mcp, '/health')
  const config = await request(origin, '/api/mcp-config', identities[0].token, undefined, 'GET')
  secrets.push(config.token)
  const call = await mcpClient(origin, config.token)
  const query = (uid, subtree = false) => call('query_nodes', { room_key: roomKey, scope: 'self', selector: { type: 'uid', value: uid }, ...(subtree ? { include_subtree_token: true } : {}) })
  const serverChildren = async parentUid => (await pool.query(
    `select uid, parent_uid, position from room_nodes
     where room_key = $1 and parent_uid = $2 and deleted_at is null
     order by position, uid`, [roomKey, parentUid]
  )).rows
  const state = async () => (await pool.query('select version from rooms where room_key=$1', [roomKey])).rows[0].version
  const batch = (operations, operation_id = randomUUID()) => call('apply_nodes', { room_key: roomKey, operations, operation_id })
  if (setupOnly) {
    await check('owned database, native auth, native MCP readiness', async () => {
      const result = await query('root')
      assert.equal(result.toolError, false, JSON.stringify(result))
      assert.equal((await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and deleted_at is null', [roomKey])).rows[0].n, 10000)
      return { nodes: 10000, mode: 'setup-check only, not browser acceptance' }
    })
    report.passed = true
    return
  }
  const clients = []
  activeClients = clients
  if (!apiOnly) {
    let chromium
    for (const candidate of PLAYWRIGHT) { try { chromium = require(candidate).chromium; if (chromium) break } catch (_) {} }
    assert.ok(chromium, 'Playwright is required for real browser acceptance')
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (let i = 0; i < identities.length; i++) clients.push(await openClient(chromium, origin, identities[i], String(i)))
  }
  const converge = async revision => {
    try { await Promise.all(clients.map(({ page }) => page.waitForFunction(revision => {
      const c = __guardMM.cooperate, status = c.collabV2Adapter.getStatus()
      const r = __guardMM.renderer
      return Number(c.lastAppliedVersion) >= Number(revision) && !r.isRendering && !r.renderTimer && !r.hasWaitRendering &&
        !r._remoteRenderPending && !r._remoteRenderScheduler?.isPending() && status.pendingCount === 0
    }, revision, { timeout: 90000 }))) } catch (error) {
      report.browserStateAtFailure = await Promise.all(clients.map(async ({ page, actor }) => {
        await page.screenshot({ path: path.join(OUT, 'failure-client-' + actor + '.png') }).catch(() => {})
        return page.evaluate(() => {
          const c = __guardMM.cooperate, r = __guardMM.renderer
          return { applied: c.lastAppliedVersion, rendered: c.renderedVersion, deferred: c.viewDeferred,
            rendering: r.isRendering, timer: !!r.renderTimer, waiting: r.hasWaitRendering,
            remotePending: r._remoteRenderPending, scheduled: r._remoteRenderScheduler?.isPending(),
            status: c.collabV2Adapter.getStatus(), metrics: window.__guardMetrics }
        }).catch(() => ({ failed: true }))
      }))
      throw error
    }
  }
  await check('10000-node initial database' + (apiOnly ? ' (API only)' : ' and three native browsers'), async () => ({ nodes: (await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and deleted_at is null', [roomKey])).rows[0].n, clients: clients.length }))
  if (deleteTokenOnly || process.argv.includes('--delete-token-check')) {
    await require('./mcp-guards-delete-token.cjs')({ call, query, state, converge, roomKey, check, compatMode })
  }
  if (deleteTokenOnly) {
    report.passed = true
    return
  }
  if (concurrentAddOnly) {
    await require('./mcp-guards-concurrent-add.cjs')({ clients, call, batch, query, serverChildren, state, converge, roomKey, check, OUT,
      expectSuccess: expectConcurrentAddSuccess, compatMode, draftDisplayCheck })
    if (traceQuietCheck) {
      await check('日志默认关闭：真实协同事件不输出追踪、不生成快照或缓存', async () => {
        const rows = await Promise.all(clients.map(async client => ({ actor: client.actor,
          console: client.consoleCounts.v2Trace,
          ...await client.page.evaluate(() => ({ snapshots: window.__traceSnapshotCalls,
            ring: (window.__V2_TRACE_LOG__ || []).length, remote: window.__guardMetrics?.remote || 0 })) })))
        rows.forEach(row => { assert.equal(row.console, 0); assert.equal(row.snapshots, 0); assert.equal(row.ring, 0) })
        assert.ok(rows.some(row => row.remote > 0), 'The quiet check must include actual remote events')
        return { clients: rows }
      })
      await check('显式开启可诊断；显式关闭同时静默主入口和 adapter', async () => {
        const probe = clients[2]
        const insert = async () => {
          await probe.page.evaluate(uid => window.__guardMM.cooperate.submitV2('node.insert', {
            parent: 'root', uid, text: '日志开关隔离验证' }), randomUUID())
          await converge(await state())
        }
        await probe.page.evaluate(() => { window.__COLLAB_V2_TRACE__ = true })
        await insert()
        const enabled = await probe.page.evaluate(() => ({ snapshots: window.__traceSnapshotCalls,
          ring: (window.__V2_TRACE_LOG__ || []).length, stages: (window.__V2_TRACE_LOG__ || []).map(row => row.stage) }))
        assert.ok(enabled.snapshots > 0)
        assert.ok(enabled.stages.includes('2.adapter.submit') && enabled.stages.includes('4.socket.emit'))
        assert.ok(probe.consoleCounts.v2Trace > 0)
        const countBefore = probe.consoleCounts.v2Trace
        await probe.page.evaluate(() => { localStorage.setItem('COLLAB_V2_TRACE', '1'); window.__COLLAB_V2_TRACE__ = false })
        await insert()
        const disabled = await probe.page.evaluate(() => ({ snapshots: window.__traceSnapshotCalls,
          ring: (window.__V2_TRACE_LOG__ || []).length }))
        assert.equal(disabled.snapshots, enabled.snapshots)
        assert.equal(disabled.ring, enabled.ring)
        assert.equal(probe.consoleCounts.v2Trace, countBefore)
        return { enabled, disabled, consoleAfterDisable: probe.consoleCounts.v2Trace }
      })
    }
    report.passed = true
    return
  }
  if (interactionsOnly) {
    report.scope += '; focused interaction rerun only'
    const added = await batch(Array.from({ length: 13 }, (_, i) => ({ op: 'add', node: `add-80-${i}`, parent: 'root', text: `交互基线 ${i}` })))
    assert.equal(added.toolError, false, JSON.stringify(added))
    await converge(await state())
  } else {
  for (const size of [80, 100]) await check(size + '-item single batch is one revision', async () => {
    const before = Number(await state())
    const result = await batch(Array.from({ length: size }, (_, i) => ({ op: 'add', node: `add-${size}-${i}`, parent: 'root', text: `批量 ${size}/${i}` })))
    assert.equal(result.toolError, false, JSON.stringify(result)); assert.equal(Number(await state()), before + 1)
    await converge(before + 1)
    return { revision: before + 1, outcome: result.outcome }
  })
  await check('101-item limit is explicit; 100 plus 1 commits two revisions', async () => {
    const before = Number(await state())
    const ops = Array.from({ length: 101 }, (_, i) => ({ op: 'add', node: `boundary-${i}`, parent: 'root', text: `边界 ${i}` }))
    const tooMany = await batch(ops)
    assert.equal(tooMany.toolError, true); assert.equal(Number(await state()), before)
    for (const chunk of [ops.slice(0, 100), ops.slice(100)]) {
      const result = await batch(chunk); assert.equal(result.toolError, false, JSON.stringify(result))
      await converge(await state())
    }
    assert.equal(Number(await state()), before + 2)
    return { revisions: 2 }
  })
  await check(apiOnly ? '300 additions commit three revisions (API only)' : '300 additions in three batches automatically converge', async () => {
    const before = Number(await state())
    for (let b = 0; b < 3; b++) {
      const result = await batch(Array.from({ length: 100 }, (_, i) => ({ op: 'add', node: `three-${b}-${i}`, parent: 'root', text: `分批 ${b}/${i}` })))
      assert.equal(result.toolError, false, JSON.stringify(result)); await converge(before + b + 1)
    }
    for (const { page } of clients) assert.equal(await page.evaluate(() => __guardMM.renderer.findNodeByUid('three-2-99')?.getData('text')), '分批 2/99')
    return { revisions: Number(await state()) - before, metrics: await Promise.all(clients.map(c => c.page.evaluate(() => __guardMetrics))) }
  })
  await check('stale field rejected, unrelated field accepted, missing guard rejected', async () => {
    const read = await query('add-80-0')
    const item = read.items?.[0] || read.nodes?.[0]
    assert.ok(item, JSON.stringify(read))
    const expected = { uid: item.uid, '__fv.text': item.data.__fv?.text || 0 }
    const first = await call('update_node', { room_key: roomKey, node: item.uid, text: '远端已保存', expected })
    assert.equal(first.toolError, false, JSON.stringify(first))
    const stale = await call('update_node', { room_key: roomKey, node: item.uid, text: '过期内容', expected })
    assert.equal(stale.toolError, true); assert.ok(JSON.stringify(stale).includes('REPLACE_CONFLICT'), JSON.stringify(stale))
    const note = await call('update_node', { room_key: roomKey, node: item.uid, note: '独立备注', expected: { uid: item.uid, '__fv.note': item.data.__fv?.note || 0 } })
    assert.equal(note.toolError, false, JSON.stringify(note))
    const missing = await call('update_node', { room_key: roomKey, node: item.uid, text: '无条件旧请求' })
    assert.equal(missing.toolError, true); assert.ok(JSON.stringify(missing).includes('PRECONDITION_REQUIRED'), JSON.stringify(missing))
    await converge(await state())
    return { staleCode: stale.code, missingCode: missing.code }
  })
  await check('partial batch, failed dependency and receipt replay are stable', async () => {
    const before = Number(await state()), operationId = randomUUID()
    const operations = [
      { op: 'update', node: 'add-80-1', text: '缺少条件应失败' },
      { op: 'update', node: 'add-80-2', text: '依赖失败不应执行', depends_on: [0] },
      { op: 'add', node: 'partial-success', parent: 'root', text: '独立成功' }
    ]
    const first = await batch(operations, operationId)
    assert.equal(first.outcome, 'partial', JSON.stringify(first))
    assert.deepEqual(first.items.map(item => item.status), ['failed', 'dependency_failed', 'applied'])
    assert.equal(Number(await state()), before + 1)
    const replay = await batch(operations, operationId)
    assert.deepEqual(replay.items, first.items); assert.equal(Number(await state()), before + 1)
    const allFailedId = randomUUID(), failedOps = operations.slice(0, 1)
    const failed = await batch(failedOps, allFailedId)
    assert.equal(failed.outcome, 'all_failed', JSON.stringify(failed))
    assert.deepEqual((await batch(failedOps, allFailedId)).items, failed.items)
    assert.equal(Number(await state()), before + 1)
    await converge(before + 1)
    return { outcome: first.outcome, allFailed: failed.outcome, revisions: 1 }
  })
  await check('same UID repeated mutations and newly inserted UID use batch-entry baseline', async () => {
    const read = await query('add-80-3'), item = read.items[0]
    const expected = { uid: item.uid, '__fv.text': item.data.__fv?.text || 0 }
    const first = await batch([
      { op: 'update', node: item.uid, text: '批内第一次', expected },
      { op: 'update', node: item.uid, text: '批内第二次', expected },
      { op: 'add', node: 'new-then-update', parent: 'root', text: '初始' },
      { op: 'update', node: 'new-then-update', text: '本批新建后修改', depends_on: [2] }
    ])
    assert.equal(first.outcome, 'applied', JSON.stringify(first))
    assert.equal((await query(item.uid)).items[0].data.text, '批内第二次')
    assert.equal((await query('new-then-update')).items[0].data.text, '本批新建后修改')
    await converge(await state())
    return { outcome: first.outcome }
  })
  await check('native HTTP also rejects unguarded protected writes', async () => {
    const response = await fetch(origin + `/api/files/${roomKey}/nodes/add-80-4`, {
      method: 'PATCH', headers: { Origin: origin, Cookie: 'mind_map_session=' + identities[0].token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '旧 HTTP 写入', operation_id: randomUUID(), client_id: 'owned-guard-http' })
    })
    const value = await response.json()
    assert.equal(response.status, 428, JSON.stringify(value)); assert.equal(value.code, 'PRECONDITION_REQUIRED')
    return { code: value.code }
  })
  await check('move checks source, empty destination and relative anchor inside transaction', async () => {
    const source = (await query('add-80-4')).items[0], parent = (await query('partial-success')).items[0]
    const original = { uid: source.uid, parent_uid: source.parent_uid, position: source.position,
      target_uid: parent.uid, target_parent_uid: parent.parent_uid, target_position: parent.position, target_empty: true }
    const moved = await call('move_node', { room_key: roomKey, uid: source.uid, parent_uid: parent.uid, index: 0, expected: original })
    assert.equal(moved.toolError, false, JSON.stringify(moved))
    assert.equal((await query(source.uid)).items[0].parent_uid, parent.uid)
    const stale = await call('move_node', { room_key: roomKey, uid: source.uid, parent_uid: 'root',
      expected: { uid: source.uid, parent_uid: source.parent_uid, position: source.position } })
    assert.equal(stale.toolError, true); assert.ok(JSON.stringify(stale).includes('REPLACE_CONFLICT'), JSON.stringify(stale))
    const next = (await query('add-80-5')).items[0], anchor = (await query('add-80-6')).items[0]
    const expected = { uid: next.uid, parent_uid: next.parent_uid, position: next.position,
      anchor_uid: anchor.uid, anchor_parent_uid: anchor.parent_uid, anchor_position: anchor.position, anchor_side: 'before' }
    const inserted = await batch([{ op: 'add', node: 'anchor-offset', parent: 'root', index: 0, text: '插入使旧 index 偏移' }])
    assert.equal(inserted.toolError, false, JSON.stringify(inserted))
    const reordered = await call('move_node', { room_key: roomKey, uid: next.uid, parent_uid: 'root', index: 0, expected })
    assert.equal(reordered.toolError, false, JSON.stringify(reordered))
    const rows = (await pool.query('select uid from room_nodes where room_key=$1 and parent_uid=\'root\' and deleted_at is null order by position,uid', [roomKey])).rows.map(row => row.uid)
    assert.equal(rows.indexOf(next.uid) + 1, rows.indexOf(anchor.uid), 'relative placement must not reuse stale index=0')
    await converge(await state())
    return { moved: true, staleRejected: true, relativeAnchor: true }
  })
  await check('subtree token detects descendant edits', async () => {
    const startedAt = Date.now(), started = performance.now(), read = await query('root', true)
    const root = read.items?.[0] || read.nodes?.[0]
    const token = root?.subtree_token || read.subtree_token
    assert.ok(token, JSON.stringify(read).slice(0, 800))
    const tokenMs = performance.now() - started
    const samples = fs.readFileSync(path.join(OUT, 'collabServer.js.metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const beforeSample = samples.filter(row => row.time <= startedAt).at(-1), afterSample = samples.at(-1)
    const tokenResource = { serverCpuMs: beforeSample && afterSample ? Math.round((afterSample.cpuUs - beforeSample.cpuUs) / 1000) : null,
      serverPeakRssMiB: Math.round(Math.max(...samples.filter(row => row.time >= startedAt - 250).map(row => row.rss)) / 1048576),
      resourceSampleIntervalMs: 250 }
    const leaf = (await query('branch-0-leaf-0')).items?.[0]
    const changed = await call('update_node', { room_key: roomKey, node: leaf.uid, note: '后代变化', expected: { uid: leaf.uid, '__fv.note': leaf.data.__fv?.note || 0 } })
    assert.equal(changed.toolError, false, JSON.stringify(changed))
    const branchRead = await query('branch-0', true), branch = branchRead.items?.[0] || branchRead.nodes?.[0]
    const old = branch?.subtree_token || branchRead.subtree_token
    const again = await query('branch-0-leaf-1'), target = again.items?.[0] || again.nodes?.[0]
    await call('update_node', { room_key: roomKey, node: target.uid, note: '后代再次变化', expected: { uid: target.uid, '__fv.note': target.data.__fv?.note || 0 } })
    const deleted = await call('delete_node', { room_key: roomKey, node: branch.uid, expected: { uid: branch.uid, subtree_token: old } })
    assert.equal(deleted.toolError, true); assert.ok(JSON.stringify(deleted).includes('REPLACE_CONFLICT'), JSON.stringify(deleted))
    return { nodes: (await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and deleted_at is null', [roomKey])).rows[0].n, tokenMs: Math.round(tokenMs), tokenBytes: Buffer.byteLength(token), ...tokenResource }
  })
  await check('guarded leaf delete succeeds and converges', async () => {
    const read = await query('anchor-offset', true), item = read.items[0]
    const result = await call('delete_node', { room_key: roomKey, node: item.uid,
      expected: { uid: item.uid, subtree_token: item.subtree_token || read.subtree_token } })
    assert.equal(result.toolError, false, JSON.stringify(result))
    assert.equal((await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and uid=$2 and deleted_at is null', [roomKey, item.uid])).rows[0].n, 0)
    await converge(await state())
  })
  }
  await converge(await state())
  if (clients.length) {
    const context = { clients, call, query, batch, state, converge, roomKey, check, origin, OUT }
    await require('./mcp-guards-drag.cjs')(context)
    await require('./mcp-guards-interactions.cjs')(context)
    await require('./mcp-guards-note-link.cjs')(context)
    await require('./mcp-guards-offline.cjs')(context)
    await check('history keeps room aggregation; redraw adds neither operations nor versions', async () => {
      const revision = Number(await state())
      const list = await request(origin, `/api/files/${roomKey}/versions?limit=100`, identities[0].token, undefined, 'GET')
      assert.ok(Array.isArray(list.versions), JSON.stringify(list).slice(0, 400))
      const count = async () => Number((await pool.query('select count(*)::int as n from room_versions where room_key=$1 and not hidden', [roomKey])).rows[0].n)
      const before = await count()
      await Promise.all(clients.map(({ page }) => page.evaluate(() => new Promise(resolve => __guardMM.render(resolve)))))
      await converge(revision)
      await request(origin, `/api/files/${roomKey}/versions?limit=100`, identities[0].token, undefined, 'GET')
      assert.equal(Number(await state()), revision); assert.equal(await count(), before)
      const rows = (await pool.query('select revision,count(*)::int as n from room_versions where room_key=$1 and type=\'AUTO\' and not hidden group by revision', [roomKey])).rows
      assert.ok(rows.every(row => row.n === 1), 'AUTO versions remain unique for the captured room revision')
      const operations = (await pool.query('select count(distinct version)::int as n from room_operations where room_key=$1 and version>0', [roomKey])).rows[0].n
      assert.equal(operations, revision)
      return { revision, visibleHistoryVersions: before, operationRevisions: operations, repaintAddedHistory: false }
    })
  }
  for (const { page, actor, errors } of clients) {
    await page.screenshot({ path: path.join(OUT, 'client-' + actor + '.png'), fullPage: false })
    assert.deepEqual(errors, [], 'Unexpected browser errors for ' + actor)
  }
  report.passed = true
}
main().catch(error => { report.passed = false; report.error = redact(error.stack || error); console.error(report.error); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close().catch(() => {})
  if (gateway) await gateway.close().catch(() => {})
  for (const proc of children.reverse()) if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise(resolve => { const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000); proc.once('exit', () => { clearTimeout(timer); resolve() }); proc.kill('SIGTERM') })
  }
  if (pool) await pool.end().catch(() => {})
  if (admin) {
    if (created) await admin.query('drop database "' + database + '" with (force)').then(() => { report.databaseRemoved = true }).catch(error => { report.cleanupError = error.message; process.exitCode = 1 })
    await admin.end().catch(() => {})
  }
  report.finishedAt = new Date().toISOString()
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + path.join(OUT, 'summary.json'))
})
