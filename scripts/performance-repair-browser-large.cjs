#!/usr/bin/env node
'use strict'

// One-shot browser acceptance for lazy expansion of a 6,000-node fixture.
// The script and all artifacts stay under ignored output/; it starts only a
// local test API process and uses the existing isolated PG/Redis services.
const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const { fork } = require('child_process')
const { randomUUID } = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'simple-mind-map')
const API_SERVER = path.join(APP, 'bin', 'collabServer.js')
const BUILD = path.join(ROOT, 'output', 'performance-repair-20261013', 'build')
const DEPS = path.join(ROOT, 'output', 'performance-repair-20261013', 'dependencies', 'node_modules')
const PG = { host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password' }
const REDIS_URL = 'redis://127.0.0.1:16389'
const API_PORT = 19094
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
const ROOM_KEY = 'perf-repair-browser-large-' + randomUUID().slice(0, 12)
const OWNER_ID = 'perf-repair-browser-large-' + randomUUID()
const RUN_DIR = path.join(ROOT, 'output', 'performance-repair-20261013', 'browser-large', RUN_ID)
const SUMMARY_PATH = path.join(RUN_DIR, 'summary.json')

function assert(ok, message) { if (!ok) throw new Error(message) }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function append(summary, event) {
  summary.events.push({ at: new Date().toISOString(), ...event })
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n')
}
function available(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(new Error('端口 ' + port + ' 不可用：' + (error.code || error.message))))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}
function makeTree() {
  const node = (uid, text, children, expand) => ({
    data: { uid, text, expand: expand !== false }, children: children || []
  })
  const branches = []
  let leafNumber = 0
  for (let branch = 1; branch <= 8; branch += 1) {
    const leafCount = branch <= 7 ? 749 : 748
    const leaves = []
    for (let index = 1; index <= leafCount; index += 1) {
      leafNumber += 1
      leaves.push(node('large-leaf-' + String(leafNumber).padStart(4, '0'), 'Leaf ' + leafNumber, [], false))
    }
    branches.push(node('n' + branch, 'Branch ' + branch, leaves, false))
  }
  assert(leafNumber === 5991, 'fixture leaf count must be 5,991')
  return node('root', 'Performance repair large browser fixture', branches, true)
}
function envForApi(appOrigin) {
  return {
    ...process.env,
    MIND_MAP_SKIP_ROOT_ENV: '1', HOST: '127.0.0.1', PORT: String(API_PORT),
    PGHOST: PG.host, PGPORT: String(PG.port), PGDATABASE: PG.database, PGUSER: PG.user, PGPASSWORD: PG.password,
    REDIS_URL, COLLAB_EVENT_BUS: 'redis', COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: '1', COLLAB_E2E: '1',
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef', WECOM_AGENT_ID: '1000001',
    WECOM_SECRET: 'performance-repair-test-only-secret',
    AUTH_SESSION_SECRET: 'performance-repair-isolated-session-secret-32-chars',
    WECOM_REDIRECT_URI: appOrigin + '/api/auth/wecom/callback', AUTH_APP_ORIGIN: appOrigin,
    AUTH_ALLOWED_ORIGINS: appOrigin, AUTH_COOKIE_SECURE: 'false',
    MCP_TOKEN: 'perf-repair-large-mcp-token-' + OWNER_ID, MCP_HOST: '127.0.0.1', MCP_PORT: '19095',
    COLLAB_OUTBOX_PUBLISHER: '0', COLLAB_TRACE: '0', COLLAB_V2_TRACE: '0',
    KNOWLEDGE_COMPILER_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false',
    COLLAB_RATE_LIMIT_PER_ROOM: '800', COLLAB_RATE_LIMIT_GLOBAL: '8000',
    NODE_PATH: [DEPS, path.join(APP, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter)
  }
}
function startApi(appOrigin) {
  const child = fork(API_SERVER, [], { cwd: APP, env: envForApi(appOrigin), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout.on('data', data => fs.appendFileSync(path.join(RUN_DIR, 'api-stdout.log'), data))
  child.stderr.on('data', data => fs.appendFileSync(path.join(RUN_DIR, 'api-stderr.log'), data))
  return child
}
async function waitHttp(url, child, label) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(label + ' 进程提前退出，exit=' + child.exitCode)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return response
    } catch (_) {}
    await sleep(250)
  }
  throw new Error(label + ' 就绪超时：' + url)
}
async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(120000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) {}
  return { response, text, data }
}
function proxyHttp(req, res, port) {
  const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode || 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', error => {
    if (!res.headersSent) { res.writeHead(502); res.end(error.message) }
    else res.destroy(error)
  })
  req.pipe(upstream)
}
async function gateway() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1')).pathname
    if (pathname === '/runtime-config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('window.__MIND_MAP_RUNTIME__={gateway:true,publicPath:"/"};')
      return
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/collab-v2') || pathname === '/collab') return proxyHttp(req, res, API_PORT)
    const relative = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
    const target = path.resolve(BUILD, '.' + relative)
    if (!target.startsWith(BUILD + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404); res.end('not found'); return
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
    res.writeHead(200, { 'Content-Type': types[path.extname(target).toLowerCase()] || 'application/octet-stream' })
    fs.createReadStream(target).pipe(res)
  })
  server.on('upgrade', (req, socket, head) => {
    const backend = net.connect(API_PORT, '127.0.0.1', () => {
      backend.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n' +
        Object.entries(req.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n')
      if (head && head.length) backend.write(head)
      socket.pipe(backend); backend.pipe(socket)
    })
    backend.on('error', () => socket.destroy())
    socket.on('error', () => backend.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, origin: 'http://127.0.0.1:' + address.port }
}
function authHeaders(cookie, origin) { return { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' } }
async function createIdentity(origin) {
  const result = await requestJson(origin + '/api/auth/e2e-identity', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: OWNER_ID })
  })
  assert(result.response.ok && result.data && result.data.token, 'E2E 测试身份建立失败：' + result.response.status + ' ' + result.text.slice(0, 300))
  return { token: result.data.token, cookie: 'mind_map_session=' + result.data.token }
}
async function createRoom(origin, cookie) {
  let result = await requestJson(origin + '/api/files', {
    method: 'POST', headers: authHeaders(cookie, origin),
    body: JSON.stringify({ room_key: ROOM_KEY, title: 'perf-repair 6000-node browser fixture' })
  })
  assert(result.response.ok, '测试房间创建失败：' + result.response.status + ' ' + result.text.slice(0, 300))
  result = await requestJson(origin + '/api/files/' + encodeURIComponent(ROOM_KEY) + '/replace', {
    method: 'POST', headers: authHeaders(cookie, origin),
    body: JSON.stringify({ tree: makeTree(), client_id: 'perf-repair-browser-large-seed', operation_id: randomUUID(), allowFullTree: true })
  })
  assert(result.response.ok, '6000 节点测试房间初始化失败：' + result.response.status + ' ' + result.text.slice(0, 600))
  return {
    room_key: result.data && result.data.room_key,
    version: result.data && result.data.version,
    title: result.data && result.data.title,
    updated_at: result.data && result.data.updated_at
  }
}
async function cleanupRoom(roomKey) {
  assert(roomKey === ROOM_KEY && roomKey.startsWith('perf-repair-browser-large-'), 'cleanup 只允许本次生成的大图 room key')
  const { Pool } = require(path.join(APP, 'node_modules', 'pg'))
  const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
  const client = await pool.connect()
  const deleted = []
  try {
    await client.query('begin')
    const ident = await client.query('select current_database() as database, current_user as username')
    assert(ident.rows[0].database === PG.database && ident.rows[0].username === PG.user, '拒绝清理非隔离测试数据库')
    const tables = await client.query(`select table_name from information_schema.columns where table_schema='public' and column_name='room_key' order by case when table_name='rooms' then 1 else 0 end, table_name`)
    assert(tables.rows.some(row => row.table_name === 'rooms'), '找不到 rooms 表')
    for (const row of tables.rows) {
      const table = 'public."' + String(row.table_name).replace(/"/g, '""') + '"'
      const result = await client.query('delete from ' + table + ' where room_key = $1', [roomKey])
      if (result.rowCount) deleted.push({ table: row.table_name, count: result.rowCount })
    }
    const residual = []
    for (const row of tables.rows) {
      const table = 'public."' + String(row.table_name).replace(/"/g, '""') + '"'
      const result = await client.query('select count(*)::int as count from ' + table + ' where room_key = $1', [roomKey])
      if (result.rows[0].count) residual.push({ table: row.table_name, count: result.rows[0].count })
    }
    assert(!residual.length, '清理后仍存在本次 room 数据：' + JSON.stringify(residual))
    await client.query('commit')
    return { verified: true, database: ident.rows[0], deleted, residual }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release(); await pool.end().catch(() => {})
  }
}
function getMindMap() {
  const root = document.querySelector('#app')
  const seen = new Set()
  const visit = vm => {
    if (!vm || seen.has(vm)) return null
    seen.add(vm)
    if (vm.mindMap && vm.mindMap.renderer) return vm.mindMap
    for (const child of vm.$children || []) { const found = visit(child); if (found) return found }
    return null
  }
  return visit(root && root.__vue__)
}
async function stop(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => child.kill(), 12000).unref() })
}
async function waitForStableBranch(page, expand) {
  await page.waitForFunction(expectedExpand => {
    const mm = window.__perfRepairMindMap
    const branch = mm && mm.renderer && mm.renderer.findNodeByUid('n1')
    if (!branch || branch.getData('expand') !== expectedExpand ||
        Number(branch.nodeData.children && branch.nodeData.children.length) !== 749 ||
        mm.renderer.isRendering !== false) {
      window.__perfRepairStableBranch = null
      return false
    }
    const signature = [branch.getData('expand'), branch.nodeData.children.length,
      branch.getData('childCount'), branch.getData('descendantCount')].join('|')
    const previous = window.__perfRepairStableBranch
    if (!previous || previous.signature !== signature) {
      window.__perfRepairStableBranch = { signature, since: performance.now() }
      return false
    }
    return performance.now() - previous.since >= 250
  }, expand, { timeout: 90000 })
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({
      mode: 'plan-only', command: 'node scripts/performance-repair-browser-large.cjs --run',
      build: BUILD, apiPort: API_PORT,
      database: PG.host + ':' + PG.port + '/' + PG.database + ' (' + PG.user + ')',
      redis: REDIS_URL, roomPrefix: 'perf-repair-browser-large-', nodeCount: 6000
    }, null, 2))
    return
  }
  assert(fs.existsSync(path.join(BUILD, 'index.html')), '前端 build 不存在：' + BUILD)
  assert(fs.existsSync(API_SERVER), 'collabServer.js 不存在')
  fs.mkdirSync(RUN_DIR, { recursive: true })
  const summary = {
    runId: RUN_ID, startedAt: new Date().toISOString(), roomKey: ROOM_KEY,
    database: null, fixture: { expectedNodes: 6000, rootChildren: 8, branchLeaves: 5991, leafDistribution: [749, 749, 749, 749, 749, 749, 749, 748] },
    checks: {}, subtreeRequests: [], browserErrors: [], screenshots: {}, cleanup: { api: null, db: null }, events: []
  }
  let api = null, web = null, browser = null, cookie = null, created = false, page = null
  try {
    await available(API_PORT)
    const { Pool } = require(path.join(APP, 'node_modules', 'pg'))
    const { createClient } = require(path.join(APP, 'node_modules', 'redis'))
    const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: 4000 })
    const redis = createClient({ url: REDIS_URL, socket: { connectTimeout: 4000 } }); redis.on('error', () => {})
    try {
      const identity = await pool.query('select current_database() as database, current_user as username')
      assert(identity.rows[0].database === PG.database && identity.rows[0].username === PG.user, '隔离 PG identity 不匹配')
      await redis.connect(); assert(await redis.ping() === 'PONG', '隔离 Redis PING 失败')
      summary.database = { ...identity.rows[0], redis: REDIS_URL }
    } finally { await redis.quit().catch(() => {}); await pool.end().catch(() => {}) }

    web = await gateway()
    api = startApi(web.origin)
    await waitHttp('http://127.0.0.1:' + API_PORT + '/api/health', api, 'collab API')
    const identity = await createIdentity(web.origin); cookie = identity.cookie
    summary.seed = await createRoom(web.origin, cookie); created = true

    const pwPath = process.env.PERF_REPAIR_CHROME || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
    ].find(file => fs.existsSync(file))
    const playwrightPath = path.join(DEPS, 'playwright')
    const { chromium } = require(playwrightPath)
    browser = await chromium.launch({ headless: true, ...(pwPath ? { executablePath: pwPath } : {}) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addCookies([{ name: 'mind_map_session', value: identity.token, url: web.origin }])
    page = await context.newPage()
    page.on('pageerror', error => summary.browserErrors.push({ type: 'pageerror', message: error.message }))
    page.on('console', message => { if (message.type() === 'error') summary.browserErrors.push({ type: 'console', message: message.text() }) })
    page.on('request', request => {
      try {
        const url = new URL(request.url())
        if (url.pathname.includes('/subtree')) {
          const item = { method: request.method(), path: url.pathname, uid: url.searchParams.get('uid'), startedAt: new Date().toISOString(), status: null }
          summary.subtreeRequests.push(item); request.__perfRepairRecord = item
        }
      } catch (_) {}
    })
    page.on('response', response => {
      const req = response.request()
      if (req.__perfRepairRecord) req.__perfRepairRecord.status = response.status()
    })
    await page.goto(web.origin + '/?room=' + encodeURIComponent(ROOM_KEY), { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.smm-node', { timeout: 90000 })
    await page.waitForFunction(() => {
      const state = window.__COLLAB_V2_STATE__
      return state && (state.status === 'live' || state.phase === 'LIVE')
    }, null, { timeout: 90000 })
    await page.waitForFunction('(() => { const mm = (' + getMindMap.toString() + ')(); return !!(mm && mm.renderer && mm.renderer.isRendering === false); })()', null, { timeout: 90000 })
    await page.evaluate('window.__perfRepairMindMap = (' + getMindMap.toString() + ')()')
    const rootHydrationBefore = await page.evaluate(async () => {
      const mm = window.__perfRepairMindMap
      const root = mm && mm.renderer && mm.renderer.findNodeByUid('root')
      if (!root) throw new Error('根节点首屏未就绪')
      const before = root.nodeData.children.length
      if (before < Number(root.getData('childCount')) && mm.cooperate && mm.cooperate.hydrateLazyChildren) {
        await mm.cooperate.hydrateLazyChildren(root)
      }
      return before
    })
    await page.waitForFunction(() => {
      const mm = window.__perfRepairMindMap
      const root = mm && mm.renderer && mm.renderer.findNodeByUid('root')
      return !!(root && root.nodeData.children.length >= Number(root.getData('childCount')) && mm.renderer.isRendering === false)
    }, null, { timeout: 45000 })
    await page.waitForFunction(() => {
      const mm = window.__perfRepairMindMap
      const branch = mm && mm.renderer && mm.renderer.findNodeByUid('n1')
      return !!(branch && Number(branch.getData('childCount')) >= 700)
    }, null, { timeout: 30000 })
    const initial = await page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const branch = mm.renderer.findNodeByUid('n1')
      const root = mm.renderer.findNodeByUid('root')
      return {
        state: window.__COLLAB_V2_STATE__ || null,
        renderNodeCount: document.querySelectorAll('.smm-node').length,
        root: { childCount: root && root.getData('childCount'), descendantCount: root && root.getData('descendantCount'), liveChildren: root && root.nodeData.children.length },
        branch: { uid: 'n1', expand: branch.getData('expand'), childCount: branch.getData('childCount'), descendantCount: branch.getData('descendantCount'), liveChildren: branch.nodeData.children.length, hasMore: branch.getData('hasMore') }
      }
    })
    summary.checks.rootHydration = {
      mountedChildrenBefore: rootHydrationBefore,
      mountedChildrenAfter: initial.root.liveChildren,
      rootSubtreeRequests: summary.subtreeRequests.filter(item => item.uid === 'root')
    }
    summary.checks.initialReady = initial
    assert(Number(initial.root.childCount) === 8 && Number(initial.root.descendantCount) === 5999, '首屏根节点权威数量不符：' + JSON.stringify(initial.root))
    assert(Number(initial.branch.childCount) === 749 && Number(initial.branch.descendantCount) === 749, 'n1 子树权威数量不符：' + JSON.stringify(initial.branch))
    assert(initial.branch.expand === false, 'n1 初始未处于收起状态')
    summary.screenshots.initial = path.join(RUN_DIR, 'initial.png'); await page.screenshot({ path: summary.screenshots.initial })

    const beforeFirst = summary.subtreeRequests.filter(item => item.uid === 'n1').length
    await page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const node = mm && mm.renderer.findNodeByUid('n1')
      if (!node) throw new Error('n1 missing before first expand')
      mm.execCommand('SET_NODE_EXPAND', node, true)
    })
    await waitForStableBranch(page, true)
    const afterExpand = await page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const branch = mm.renderer.findNodeByUid('n1')
      const leaf = mm.renderer.findNodeByUid('large-leaf-0749')
      return {
        expand: branch.getData('expand'), childCount: branch.getData('childCount'), descendantCount: branch.getData('descendantCount'),
        mountedDirectChildren: branch.nodeData.children.length, mountedLeaf: !!leaf,
        renderNodeCount: document.querySelectorAll('.smm-node').length,
        rendererRendering: mm.renderer.isRendering
      }
    })
    const firstRequests = summary.subtreeRequests.filter(item => item.uid === 'n1').slice(beforeFirst)
    summary.checks.firstExpand = { result: afterExpand, subtreeRequests: firstRequests }
    assert(firstRequests.some(item => item.status === 200), 'n1 展开未触发成功的真实 HTTP /subtree 请求：' + JSON.stringify(firstRequests))
    assert(afterExpand.mountedDirectChildren === 749 && afterExpand.mountedLeaf, 'n1 展开后 749 个子节点或末叶未完整挂载：' + JSON.stringify(afterExpand))
    summary.screenshots.expanded = path.join(RUN_DIR, 'expanded.png'); await page.screenshot({ path: summary.screenshots.expanded })

    const beforeCollapse = summary.subtreeRequests.filter(item => item.uid === 'n1').length
    await page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const node = mm && mm.renderer.findNodeByUid('n1')
      if (!node) throw new Error('n1 missing before collapse')
      mm.execCommand('SET_NODE_EXPAND', node, false)
    })
    await waitForStableBranch(page, false)
    const collapsed = await page.evaluate(() => {
      const mm = window.__perfRepairMindMap, branch = mm.renderer.findNodeByUid('n1')
      return { expand: branch.getData('expand'), childCount: branch.getData('childCount'), descendantCount: branch.getData('descendantCount'), mountedDirectChildren: branch.nodeData.children.length, renderNodeCount: document.querySelectorAll('.smm-node').length }
    })
    summary.screenshots.collapsed = path.join(RUN_DIR, 'collapsed.png'); await page.screenshot({ path: summary.screenshots.collapsed })
    await page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const node = mm && mm.renderer.findNodeByUid('n1')
      if (!node) throw new Error('n1 missing before re-expand')
      mm.execCommand('SET_NODE_EXPAND', node, true)
    })
    await waitForStableBranch(page, true)
    const afterReexpand = await page.evaluate(() => {
      const mm = window.__perfRepairMindMap, branch = mm.renderer.findNodeByUid('n1')
      return { expand: branch.getData('expand'), childCount: branch.getData('childCount'), descendantCount: branch.getData('descendantCount'), mountedDirectChildren: branch.nodeData.children.length, renderNodeCount: document.querySelectorAll('.smm-node').length, rendererRendering: mm.renderer.isRendering }
    })
    const afterRequests = summary.subtreeRequests.filter(item => item.uid === 'n1').length
    summary.checks.collapseReexpand = { collapsed, reexpanded: afterReexpand, subtreeRequestCountBeforeCollapse: beforeCollapse, subtreeRequestCountAfterReexpand: afterRequests, additionalRequests: afterRequests - beforeCollapse }
    assert(collapsed.expand === false && Number(collapsed.childCount) === 749 && Number(collapsed.descendantCount) === 749, '收起后权威子树数量丢失：' + JSON.stringify(collapsed))
    assert(afterReexpand.expand === true && afterReexpand.mountedDirectChildren === 749, '再次展开后子树不完整：' + JSON.stringify(afterReexpand))
    assert(afterRequests - beforeCollapse <= 2, '再次展开产生异常 HTTP 请求风暴：' + JSON.stringify(summary.checks.collapseReexpand))
    summary.screenshots.reexpanded = path.join(RUN_DIR, 'reexpanded.png'); await page.screenshot({ path: summary.screenshots.reexpanded })
    summary.checks.browserErrors = summary.browserErrors
    summary.checks.subtreeRequestSummary = {
      total: summary.subtreeRequests.length,
      byUid: summary.subtreeRequests.reduce((counts, item) => {
        const key = item.uid || '(missing uid)'
        counts[key] = (counts[key] || 0) + 1
        return counts
      }, {})
    }
    summary.completed = true
  } catch (error) {
    summary.failure = { message: error.message, stack: error.stack }
    if (browser) {
      try { summary.screenshots.failure = path.join(RUN_DIR, 'failure.png'); await page.screenshot({ path: summary.screenshots.failure }) } catch (_) {}
    }
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (api && cookie && created) {
      try {
        const result = await requestJson('http://127.0.0.1:' + API_PORT + '/api/files/' + encodeURIComponent(ROOM_KEY), { method: 'DELETE', headers: authHeaders(cookie, web.origin) })
        summary.cleanup.api = { status: result.response.status, body: result.text.slice(0, 300) }
      } catch (error) { summary.cleanup.api = { error: error.message } }
    }
    await stop(api).catch(error => { summary.cleanup.apiStopError = error.message })
    if (created) {
      try { summary.cleanup.db = await cleanupRoom(ROOM_KEY) }
      catch (error) { summary.cleanup.db = { verified: false, error: error.message } }
    }
    if (web) {
      if (web.server.closeAllConnections) web.server.closeAllConnections()
      await new Promise(resolve => web.server.close(resolve))
    }
    summary.finishedAt = new Date().toISOString()
    summary.acceptancePassed = Boolean(summary.completed && summary.cleanup.db && summary.cleanup.db.verified && summary.browserErrors.length === 0 && summary.checks.firstExpand && summary.checks.collapseReexpand)
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n')
  }
  console.log(JSON.stringify({ runDir: RUN_DIR, completed: summary.completed, acceptancePassed: summary.acceptancePassed, checks: summary.checks, cleanup: summary.cleanup }, null, 2))
  if (!summary.acceptancePassed) process.exitCode = 1
}

main().catch(error => { console.error(error.stack || error.message); console.error('summary: ' + SUMMARY_PATH); process.exitCode = 1 })
