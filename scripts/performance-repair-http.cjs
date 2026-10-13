#!/usr/bin/env node
'use strict'

// Focused, serial before/after HTTP benchmark for /api/files/:room/subtree.
// It connects only to the isolated test PostgreSQL/Redis services and creates
// or deletes rooms whose keys this process generated with a run-specific
// perf-repair-http- prefix. --linux uses the existing mind-map-app image and
// creates only two run-labeled disposable app containers; it never changes
// existing containers or shared test services.

const fs = require('fs')
const path = require('path')
const net = require('net')
const { fork, execFileSync } = require('child_process')
const { randomUUID, createHash } = require('crypto')
const { performance } = require('perf_hooks')

const ROOT = path.resolve(__dirname, '..')
const APP_DIR = path.join(ROOT, 'simple-mind-map')
const CURRENT_SERVER = path.join(APP_DIR, 'bin', 'collabServer.js')
const TASK_DEPENDENCIES = path.join(ROOT, 'output', 'performance-repair-20261013', 'dependencies', 'node_modules')
const BASELINE_COMMIT = '8c9c3d16'
const OUTPUT_BASE = path.join(ROOT, 'output', 'performance-repair-20261013', 'http')
const PERF_IMAGE = 'mind-map-app'
const DOCKER_NETWORK = 'mcp-incremental-test_default'
const DOCKER_POSTGRES = 'mcp-incremental-test-postgres-1'
const DOCKER_REDIS = 'mcp-incremental-test-redis-1'
const DATABASE = Object.freeze({
  host: '127.0.0.1',
  port: 25492,
  database: 'mcp_incremental_test',
  user: 'mcp_test',
  password: 'mcp-incremental-test-db-password'
})
const REDIS_URL = 'redis://127.0.0.1:16389'
const PORTS = Object.freeze({ baseline: 19094, fixed: 19095 })
const SAMPLE_COUNT = 120
const ROUND_COUNT = 3
const LINUX_ROUND_COUNT = 1
const WARMUP_COUNT = 30
const SIZES = [100, 6000]
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const linuxContainerToken = randomUUID().replace(/-/g, '').slice(0, 12)
const runDir = path.join(OUTPUT_BASE, runId)
const sourceRoot = path.join(runDir, 'baseline', 'simple-mind-map')
const rawPath = path.join(runDir, 'samples.jsonl')
const eventsPath = path.join(runDir, 'server-events.jsonl')
const summaryPath = path.join(runDir, 'summary.json')
const preloadPath = path.join(runDir, 'event-loop-preload.cjs')
const dockerOwnedNames = new Set()

function percentile(values, p) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function summarize(values) {
  if (!values.length) return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null }
  return {
    count: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  }
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeEventLoopPreload() {
  fs.writeFileSync(preloadPath, `
'use strict'
const { monitorEventLoopDelay } = require('node:perf_hooks')
const histogram = monitorEventLoopDelay({ resolution: 10 })
const diagnosticsToken = process.env.PERF_REPAIR_HTTP_DIAGNOSTICS_TOKEN || ''
let active = false
function finishMeasurement() {
  histogram.disable()
  active = false
  const nsToMs = value => Number.isFinite(value) ? value / 1e6 : null
  return {
    perfRepair: 'event-loop',
    resolutionMs: 10,
    meanMs: nsToMs(histogram.mean),
    maxMs: nsToMs(histogram.max),
    p50Ms: nsToMs(histogram.percentile(50)),
    p95Ms: nsToMs(histogram.percentile(95)),
    p99Ms: nsToMs(histogram.percentile(99))
  }
}
process.on('message', message => {
  if (!message || !message.perfRepair) return
  if (message.perfRepair === 'begin') {
    histogram.reset()
    histogram.enable()
    active = true
    if (process.send) process.send({ perfRepair: 'began' })
    return
  }
  if (message.perfRepair === 'finish' && active) {
    if (process.send) process.send(finishMeasurement())
  }
})

// Linux test containers have no IPC parent. Add two token-protected diagnostic
// routes to this test-only preload, before the application's HTTP handler.
// The test container publishes its port on host loopback only; production code
// and deployed HTTP routes are untouched.
if (diagnosticsToken) {
  const http = require('node:http')
  const originalCreateServer = http.createServer
  http.createServer = function (requestListener, ...args) {
    if (typeof requestListener !== 'function') return originalCreateServer.call(this, requestListener, ...args)
    const wrappedListener = async (request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method !== 'POST' || (pathname !== '/__perf-loop/begin' && pathname !== '/__perf-loop/end')) {
        return requestListener(request, response)
      }
      if (request.headers['x-perf-repair-token'] !== diagnosticsToken) {
        response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      if (pathname === '/__perf-loop/begin') {
        if (active) {
          response.writeHead(409)
          response.end(JSON.stringify({ error: 'measurement already active' }))
          return
        }
        histogram.reset()
        histogram.enable()
        active = true
        response.writeHead(200)
        response.end(JSON.stringify({ perfRepair: 'began', resolutionMs: 10 }))
        return
      }
      if (!active) {
        response.writeHead(409)
        response.end(JSON.stringify({ error: 'measurement is not active' }))
        return
      }
      const result = finishMeasurement()
      response.writeHead(200)
      response.end(JSON.stringify(result))
    }
    return originalCreateServer.call(this, wrappedListener, ...args)
  }
}
`)
}

function checkPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', error => reject(new Error(`端口 ${port} 已被占用：${error.code || error.message}`)))
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
  })
}

async function verifyTestServices() {
  const { Pool } = require(path.join(APP_DIR, 'node_modules', 'pg'))
  const { createClient } = require(path.join(APP_DIR, 'node_modules', 'redis'))
  const pool = new Pool({ ...DATABASE, connectionTimeoutMillis: 4000, max: 1 })
  const redis = createClient({ url: REDIS_URL, socket: { connectTimeout: 4000 } })
  redis.on('error', () => {})
  try {
    const result = await pool.query('select current_database() as database, current_user as username')
    assert(result.rows[0].database === DATABASE.database, 'PostgreSQL 目标数据库不匹配，拒绝继续')
    assert(result.rows[0].username === DATABASE.user, 'PostgreSQL 目标用户不匹配，拒绝继续')
    await redis.connect()
    assert((await redis.ping()) === 'PONG', '隔离 Redis 未通过 PING 检查')
    return { database: result.rows[0].database, username: result.rows[0].username, redis: REDIS_URL }
  } finally {
    await redis.quit().catch(() => {})
    await pool.end().catch(() => {})
  }
}

function dockerExec(args) {
  try {
    return execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new Error(`docker ${args[0]} 失败${stderr ? `：${stderr.slice(-1500)}` : `：${error.message}`}`)
  }
}

function linuxContainerNames() {
  const prefix = `perf-repair-linux-${linuxContainerToken}`
  return { baseline: `${prefix}-baseline`, fixed: `${prefix}-fixed` }
}

async function verifyLinuxDockerPreflight() {
  const names = linuxContainerNames()
  const existingNames = new Set(dockerExec(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean))
  for (const name of Object.values(names)) assert(!existingNames.has(name), `Linux 测试容器名称已存在，拒绝替换：${name}`)

  const networkRows = JSON.parse(dockerExec(['network', 'inspect', DOCKER_NETWORK]))
  assert(Array.isArray(networkRows) && networkRows.length === 1, `隔离网络不可用：${DOCKER_NETWORK}`)
  const network = networkRows[0]
  const members = new Set(Object.values(network.Containers || {}).map(container => container.Name))
  assert(members.has(DOCKER_POSTGRES), `隔离 PostgreSQL 不在网络 ${DOCKER_NETWORK}`)
  assert(members.has(DOCKER_REDIS), `隔离 Redis 不在网络 ${DOCKER_NETWORK}`)

  const services = {}
  for (const name of [DOCKER_POSTGRES, DOCKER_REDIS]) {
    const status = dockerExec(['inspect', '--format', '{{.State.Running}}', name])
    assert(status === 'true', `隔离服务未运行：${name}`)
    const attachments = JSON.parse(dockerExec(['inspect', '--format', '{{json .NetworkSettings.Networks}}', name]))
    const aliases = attachments[DOCKER_NETWORK] && attachments[DOCKER_NETWORK].Aliases || []
    assert(aliases.includes(name), `容器 ${name} 未在测试网络注册自身 DNS alias`)
    assert(aliases.includes(name === DOCKER_POSTGRES ? 'postgres' : 'redis'), `容器 ${name} 缺少测试服务 DNS alias`)
    services[name] = { running: true, aliases }
  }
  const imageId = dockerExec(['image', 'inspect', '--format', '{{.Id}}', PERF_IMAGE])
  assert(/^sha256:[0-9a-f]{64}$/i.test(imageId), `测试应用镜像不存在或 ID 异常：${PERF_IMAGE}`)
  assert(fs.existsSync(path.join(TASK_DEPENDENCIES, 'turndown')), `测试专用 turndown 依赖缺失：${TASK_DEPENDENCIES}`)
  return {
    image: PERF_IMAGE,
    imageId,
    network: DOCKER_NETWORK,
    networkMembers: [...members],
    services,
    containerNames: names,
    hostPorts: PORTS,
    nodeVersion: '要求容器启动后核验 v20'
  }
}

function dockerMountSource(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/')
}

function archiveBaseline() {
  const archivePath = path.join(runDir, 'baseline-source.tar')
  execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, BASELINE_COMMIT,
    'simple-mind-map/bin', 'simple-mind-map/src'], { cwd: ROOT, stdio: 'pipe' })
  fs.mkdirSync(path.join(runDir, 'baseline'), { recursive: true })
  execFileSync('tar', ['-xf', archivePath, '-C', path.join(runDir, 'baseline')], { cwd: ROOT, stdio: 'pipe' })
  assert(fs.existsSync(path.join(sourceRoot, 'bin', 'collabServer.js')), '基线归档中缺少 collabServer.js')
  return { archivePath, sha256: sha256File(archivePath) }
}

function serverEnv(port, origin, identityId, options = {}) {
  const linux = options.linux === true
  const databaseHost = linux ? DOCKER_POSTGRES : DATABASE.host
  const databasePort = linux ? 5432 : DATABASE.port
  const redisUrl = linux ? `redis://${DOCKER_REDIS}:6379` : REDIS_URL
  return {
    ...(linux ? {} : process.env),
    MIND_MAP_SKIP_ROOT_ENV: '1',
    HOST: linux ? '0.0.0.0' : '127.0.0.1',
    PORT: String(linux ? 1234 : port),
    PGHOST: databaseHost,
    PGPORT: String(databasePort),
    PGDATABASE: DATABASE.database,
    PGUSER: DATABASE.user,
    PGPASSWORD: DATABASE.password,
    REDIS_URL: redisUrl,
    COLLAB_EVENT_BUS: 'redis',
    COLLAB_V2: '1',
    COLLAB_V2_EVENT_BRIDGE: '1',
    COLLAB_E2E: '1',
    WECOM_AUTH_ENABLED: '1',
    WECOM_CORP_ID: 'ww1234567890abcdef',
    WECOM_AGENT_ID: '1000001',
    WECOM_SECRET: 'performance-repair-test-only-secret',
    AUTH_SESSION_SECRET: 'performance-repair-isolated-session-secret-32-chars',
    WECOM_REDIRECT_URI: `${origin}/api/auth/wecom/callback`,
    AUTH_APP_ORIGIN: origin,
    AUTH_ALLOWED_ORIGINS: origin,
    AUTH_COOKIE_SECURE: 'false',
    MCP_TOKEN: `performance-repair-mcp-token-${identityId}`,
    COLLAB_OUTBOX_PUBLISHER: '0',
    COLLAB_TRACE: '0',
    COLLAB_V2_TRACE: '0',
    KNOWLEDGE_COMPILER_ENABLED: 'false',
    DOCMOST_SYNC_ENABLED: 'false',
    WIKI_COMPILER_SYNC_ENABLED: 'false',
    COLLAB_RATE_LIMIT_PER_ROOM: '800',
    COLLAB_RATE_LIMIT_GLOBAL: '8000',
    NODE_PATH: linux
      ? '/perf-deps:/app/node_modules:/app/simple-mind-map/node_modules'
      : [TASK_DEPENDENCIES, path.join(APP_DIR, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
    ...(linux ? { PERF_REPAIR_HTTP_DIAGNOSTICS_TOKEN: options.diagnosticsToken } : {})
  }
}

function startServer({ serverPath, port, label, identityId }) {
  const origin = `http://127.0.0.1:${port}`
  const child = fork(serverPath, [], {
    cwd: path.dirname(serverPath),
    env: serverEnv(port, origin, identityId),
    execArgv: ['--require', preloadPath],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const stdoutPath = path.join(runDir, `${label}-stdout.log`)
  const stderrPath = path.join(runDir, `${label}-stderr.log`)
  child.stdout.on('data', chunk => fs.appendFileSync(stdoutPath, chunk))
  child.stderr.on('data', chunk => fs.appendFileSync(stderrPath, chunk))
  return { child, origin, port, label, stdoutPath, stderrPath }
}

function dockerOwnedRunLabel(name) {
  try {
    return dockerExec(['inspect', '--format', '{{index .Config.Labels "codex.perf-repair-run"}}', name])
  } catch (_) {
    return null
  }
}

async function stopDockerServer(server) {
  if (!server || !dockerOwnedNames.has(server.name)) return
  assert(server.name.startsWith(`perf-repair-linux-${linuxContainerToken}-`), '拒绝清理非本次 run 创建的容器')
  assert(dockerOwnedRunLabel(server.name) === runId, `容器 ownership label 不匹配，拒绝清理：${server.name}`)
  try {
    const logs = dockerExec(['logs', server.name])
    fs.writeFileSync(path.join(runDir, `${server.label}-docker.log`), logs + '\n')
  } catch (error) {
    appendJsonl(eventsPath, { event: 'docker_logs_warning', container: server.name, message: error.message })
  }
  const running = dockerExec(['inspect', '--format', '{{.State.Running}}', server.name]) === 'true'
  if (running) dockerExec(['stop', '--time', '10', server.name])
  dockerExec(['rm', server.name])
  dockerOwnedNames.delete(server.name)
  appendJsonl(eventsPath, { event: 'owned_container_removed', container: server.name })
}

async function startDockerServer({ sourceName, identityId, diagnosticsToken }) {
  const names = linuxContainerNames()
  const name = names[sourceName]
  assert(name, `未知 Linux benchmark source: ${sourceName}`)
  assert(!dockerOwnedNames.has(name), `脚本已创建同名容器：${name}`)
  assert(!dockerExec(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).includes(name), `Linux 测试容器名称已存在，拒绝替换：${name}`)

  const sourceDir = sourceName === 'baseline' ? sourceRoot : APP_DIR
  const hostPort = PORTS[sourceName]
  const origin = `http://127.0.0.1:${hostPort}`
  const label = `${sourceName}-linux-server`
  const env = serverEnv(hostPort, origin, identityId, { linux: true, diagnosticsToken })
  const args = [
    'run', '--detach', '--name', name,
    '--label', `codex.perf-repair-run=${runId}`,
    '--label', `codex.perf-repair-source=${sourceName}`,
    '--network', DOCKER_NETWORK,
    '--publish', `127.0.0.1:${hostPort}:1234`,
    '--workdir', '/app/simple-mind-map',
    '--mount', `type=bind,source=${dockerMountSource(path.join(sourceDir, 'bin'))},target=/app/simple-mind-map/bin,readonly`,
    '--mount', `type=bind,source=${dockerMountSource(path.join(sourceDir, 'src'))},target=/app/simple-mind-map/src,readonly`,
    '--mount', `type=bind,source=${dockerMountSource(TASK_DEPENDENCIES)},target=/perf-deps,readonly`,
    '--mount', `type=bind,source=${dockerMountSource(preloadPath)},target=/perf/event-loop-preload.cjs,readonly`
  ]
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push('--entrypoint', 'node', PERF_IMAGE, '--require', '/perf/event-loop-preload.cjs', '/app/simple-mind-map/bin/collabServer.js')

  const server = { docker: true, name, origin, port: hostPort, label, diagnosticsToken, nodeVersion: null }
  dockerOwnedNames.add(name)
  try {
    dockerExec(args)
    server.nodeVersion = dockerExec(['exec', name, 'node', '--version'])
    assert(/^v20\./.test(server.nodeVersion), `容器 Node 版本不是 v20：${server.nodeVersion}`)
    appendJsonl(eventsPath, { event: 'owned_container_started', container: name, source: sourceName, image: PERF_IMAGE, nodeVersion: server.nodeVersion, port: hostPort })
    await waitForHealth(server)
    return server
  } catch (error) {
    await stopDockerServer(server).catch(cleanupError => {
      appendJsonl(eventsPath, { event: 'container_cleanup_failure', container: name, message: cleanupError.message })
    })
    throw error
  }
}

async function waitForHealth(server, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.child && server.child.exitCode != null) {
      const tail = fs.existsSync(server.stderrPath) ? fs.readFileSync(server.stderrPath, 'utf8').slice(-2500) : ''
      throw new Error(`${server.label} 服务进程提前退出 (${server.child.exitCode})：${tail}`)
    }
    try {
      const response = await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${server.label} /api/health 等待超时`)
}

async function stopServer(server) {
  if (!server || server.child.exitCode != null || server.child.signalCode != null) return
  const exited = new Promise(resolve => server.child.once('exit', resolve))
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    // Only force-stop the child process spawned by this script.
    if (server.child.exitCode == null) server.child.kill()
  }, 15000)
  server.child.kill('SIGTERM')
  await exited
  clearTimeout(timeout)
  if (timedOut) throw new Error(`${server.label} 子进程停止超时，已结束脚本启动的子进程`)
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(60000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) {}
  return { response, text, data }
}

function authHeaders(cookie, origin) {
  return { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
}

async function getIdentity(server, identityId) {
  const { response, text, data } = await requestJson(`${server.origin}/api/auth/e2e-identity`, {
    method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: identityId })
  })
  assert(response.ok && data && data.token, `E2E identity 建立失败 (${response.status})：${text.slice(0, 500)}`)
  return { cookie: `mind_map_session=${data.token}`, token: data.token }
}

function buildTree(size) {
  const root = { data: { uid: 'root', text: `perf-repair ${size} root`, expand: true }, children: [] }
  for (let i = 1; i < size; i++) {
    root.children.push({ data: { uid: `n${i}`, text: `Node ${i}`, expand: true }, children: [] })
  }
  return root
}

async function seedRoom(server, cookie, roomKey, size, runToken, onCreated) {
  let result = await requestJson(`${server.origin}/api/files`, {
    method: 'POST', headers: authHeaders(cookie, server.origin),
    body: JSON.stringify({ room_key: roomKey, title: `perf-repair HTTP ${size}` })
  })
  assert(result.response.ok, `创建 ${roomKey} 失败 (${result.response.status})：${result.text.slice(0, 500)}`)
  onCreated()
  appendJsonl(eventsPath, { event: 'room_created', roomKey, size })
  result = await requestJson(`${server.origin}/api/files/${encodeURIComponent(roomKey)}/replace`, {
    method: 'POST', headers: authHeaders(cookie, server.origin),
    body: JSON.stringify({ tree: buildTree(size), client_id: `perf-repair-${runToken}`, operation_id: randomUUID(), allowFullTree: true })
  })
  assert(result.response.ok, `写入 ${roomKey} fixture 失败 (${result.response.status})：${result.text.slice(0, 500)}`)
  return result.data
}

async function deleteOwnedRooms(server, cookie, rooms) {
  const failures = []
  for (const roomKey of [...rooms].reverse()) {
    if (!roomKey.startsWith('perf-repair-')) continue
    try {
      const { response, text } = await requestJson(`${server.origin}/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE', headers: authHeaders(cookie, server.origin)
      })
      if (!response.ok && response.status !== 404) failures.push({ roomKey, status: response.status, body: text.slice(0, 300) })
      else appendJsonl(eventsPath, { event: 'owned_room_deleted', roomKey, status: response.status })
    } catch (error) {
      failures.push({ roomKey, error: error.message })
    }
  }
  return failures
}

async function cleanupExactRoomRows(roomKeys, allowedPrefix) {
  if (!roomKeys.length) return { verified: true, roomKeys: [], deletedByTable: [], residualRows: [] }
  assert(roomKeys.every(key => typeof key === 'string' && key.startsWith(allowedPrefix)),
    'DB cleanup 拒绝处理不属于本次 run prefix 的 room key')
  assert(new Set(roomKeys).size === roomKeys.length, 'DB cleanup 收到重复 room key')
  const { Pool } = require(path.join(APP_DIR, 'node_modules', 'pg'))
  const pool = new Pool({ ...DATABASE, connectionTimeoutMillis: 4000, max: 1 })
  const client = await pool.connect()
  const deletedByTable = []
  try {
    await client.query('begin')
    const identity = await client.query('select current_database() as database, current_user as username')
    assert(identity.rows[0].database === DATABASE.database && identity.rows[0].username === DATABASE.user,
      'DB cleanup 目标身份不匹配，拒绝删除')
    const tables = await client.query(`
      select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'room_key'
      order by case when table_name = 'rooms' then 1 else 0 end, table_name
    `)
    assert(tables.rows.some(row => row.table_name === 'rooms'), 'DB cleanup 未发现 public.rooms.room_key')
    for (const { table_name: tableName } of tables.rows) {
      const quotedTable = `public."${String(tableName).replace(/"/g, '""')}"`
      const result = await client.query(`delete from ${quotedTable} where room_key = any($1::text[])`, [roomKeys])
      if (result.rowCount) deletedByTable.push({ table: tableName, count: result.rowCount })
    }
    const residualRows = []
    for (const { table_name: tableName } of tables.rows) {
      const quotedTable = `public."${String(tableName).replace(/"/g, '""')}"`
      const result = await client.query(`select count(*)::int as count from ${quotedTable} where room_key = any($1::text[])`, [roomKeys])
      if (result.rows[0].count) residualRows.push({ table: tableName, count: result.rows[0].count })
    }
    assert(residualRows.length === 0, `DB cleanup 后仍有本次房间数据：${JSON.stringify(residualRows)}`)
    await client.query('commit')
    return {
      verified: true,
      database: identity.rows[0],
      roomKeys: roomKeys.slice(),
      deletedByTable,
      residualRows
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end().catch(() => {})
  }
}

async function readSubtree(server, cookie, roomKey) {
  const url = `${server.origin}/api/files/${encodeURIComponent(roomKey)}/subtree?uid=root&limit=1`
  const started = performance.now()
  const { response, data, text } = await requestJson(url, { headers: authHeaders(cookie, server.origin) })
  return { elapsedMs: performance.now() - started, status: response.status, data, body: text, pathname: new URL(url).pathname }
}

function awaitChildMessage(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error(`等待子进程事件 ${expected} 超时`))
    }, timeoutMs)
    function onMessage(message) {
      if (message && message.perfRepair === expected) {
        clearTimeout(timeout)
        child.off('message', onMessage)
        resolve(message)
      }
    }
    child.on('message', onMessage)
  })
}

async function beginEventLoopMeasurement(server) {
  if (server.docker) {
    const { response, text, data } = await requestJson(`${server.origin}/__perf-loop/begin`, {
      method: 'POST', headers: { 'x-perf-repair-token': server.diagnosticsToken }
    })
    assert(response.ok && data && data.perfRepair === 'began', `event-loop begin 失败 (${response.status})：${text}`)
    return
  }
  server.child.send({ perfRepair: 'begin' })
  await awaitChildMessage(server.child, 'began')
}

async function finishEventLoopMeasurement(server) {
  if (server.docker) {
    const { response, text, data } = await requestJson(`${server.origin}/__perf-loop/end`, {
      method: 'POST', headers: { 'x-perf-repair-token': server.diagnosticsToken }
    })
    assert(response.ok && data && data.perfRepair === 'event-loop', `event-loop end 失败 (${response.status})：${text}`)
    return data
  }
  server.child.send({ perfRepair: 'finish' })
  return awaitChildMessage(server.child, 'event-loop')
}

async function runSourceMeasurement({ serverPath, port, sourceName, room, round, cookie, identityId, existingServer = null }) {
  const { roomKey, size } = room
  const ownsServer = !existingServer
  const server = existingServer || startServer({ serverPath, port, label: `${sourceName}-r${round}-s${size}-server`, identityId })
  try {
    await waitForHealth(server)
    for (let i = 0; i < WARMUP_COUNT; i++) {
      const sample = await readSubtree(server, cookie, roomKey)
      assert(sample.status === 200, `${sourceName}/${size} 第 ${round} 轮预热返回 HTTP ${sample.status}: ${sample.body.slice(0, 300)}`)
      assert(Number(sample.data && sample.data.total) === size - 1, `${sourceName}/${size} 第 ${round} 轮子树总数不符，期望 ${size - 1}`)
    }
    await beginEventLoopMeasurement(server)
    const samples = []
    const statusCounts = {}
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const sample = await readSubtree(server, cookie, roomKey)
      samples.push(sample.elapsedMs)
      statusCounts[sample.status] = (statusCounts[sample.status] || 0) + 1
      appendJsonl(rawPath, {
        source: sourceName, round, size, iteration: i + 1, elapsedMs: sample.elapsedMs,
        status: sample.status, pathname: sample.pathname
      })
      if (sample.status !== 200) {
        appendJsonl(eventsPath, { event: 'http_failure', source: sourceName, round, size, iteration: i + 1, status: sample.status, pathname: sample.pathname, body: sample.body.slice(0, 500) })
      } else {
        assert(Number(sample.data && sample.data.total) === size - 1, `${sourceName}/${size} 第 ${round} 轮第 ${i + 1} 次子树总数不符`)
      }
    }
    const eventLoop = await finishEventLoopMeasurement(server)
    const result = { source: sourceName, round, size, http: summarize(samples), statusCounts, eventLoop }
    appendJsonl(eventsPath, { event: 'source_size_complete', source: sourceName, round, size, summary: result })
    return result
  } finally {
    if (ownsServer) {
      if (server.docker) await stopDockerServer(server)
      else await stopServer(server)
    }
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function p95Rollup(rounds, selector) {
  const samplesMs = rounds.map(selector).filter(Number.isFinite)
  const p95Ms = median(samplesMs)
  const minMs = samplesMs.length ? Math.min(...samplesMs) : null
  const maxMs = samplesMs.length ? Math.max(...samplesMs) : null
  const repeatabilityAssessed = samplesMs.length > 1
  const spreadPercent = repeatabilityAssessed && p95Ms > 0
    ? Number(((maxMs - minMs) / p95Ms * 100).toFixed(2)) : null
  return {
    p95Ms, samplesMs, minMs, maxMs, spreadPercent,
    noisy: repeatabilityAssessed ? spreadPercent > 10 : null,
    repeatabilityAssessed
  }
}

function aggregateSourceRounds(rounds) {
  const statusCounts = {}
  for (const round of rounds) {
    for (const [status, count] of Object.entries(round.statusCounts)) {
      statusCounts[status] = (statusCounts[status] || 0) + count
    }
  }
  return {
    rounds,
    http: {
      ...p95Rollup(rounds, round => round.http.p95Ms),
      rounds: rounds.map(round => ({ count: round.http.count, minMs: round.http.minMs, p50Ms: round.http.p50Ms, p95Ms: round.http.p95Ms, maxMs: round.http.maxMs })),
      statusCounts
    },
    eventLoop: {
      ...p95Rollup(rounds, round => round.eventLoop && round.eventLoop.p95Ms),
      rounds: rounds.map(round => round.eventLoop)
    },
    requestCount: rounds.reduce((sum, round) => sum + Object.values(round.statusCounts).reduce((inner, count) => inner + count, 0), 0),
    failedRequestCount: rounds.reduce((sum, round) => sum + Object.entries(round.statusCounts)
      .filter(([status]) => status !== '200').reduce((inner, [, count]) => inner + count, 0), 0)
  }
}

function buildGates(summary) {
  const gates = []
  const expectedRequestCount = summary.rounds * SAMPLE_COUNT
  for (const size of SIZES) {
    const before = summary.sources.baseline.rooms[String(size)]
    const after = summary.sources.fixed.rooms[String(size)]
    const httpChangePercent = before && after && before.http.p95Ms > 0
      ? Number(((after.http.p95Ms - before.http.p95Ms) / before.http.p95Ms * 100).toFixed(2)) : null
    const eventLoopChangePercent = before && after && before.eventLoop.p95Ms > 0
      ? Number(((after.eventLoop.p95Ms - before.eventLoop.p95Ms) / before.eventLoop.p95Ms * 100).toFixed(2)) : null
    gates.push({
      name: `http-p95-${size}`,
      passed: httpChangePercent != null && httpChangePercent <= 10,
      limit: 'fixed regression <= 10%', observedRegressionPercent: httpChangePercent,
      baseline: before && before.http.p95Ms, fixed: after && after.http.p95Ms,
      baselineSpreadPercent: before && before.http.spreadPercent,
      fixedSpreadPercent: after && after.http.spreadPercent
    })
    gates.push({
      name: `event-loop-p95-${size}`,
      passed: eventLoopChangePercent != null && eventLoopChangePercent <= 10,
      limit: 'fixed regression <= 10%', observedRegressionPercent: eventLoopChangePercent,
      baseline: before && before.eventLoop.p95Ms, fixed: after && after.eventLoop.p95Ms,
      baselineSpreadPercent: before && before.eventLoop.spreadPercent,
      fixedSpreadPercent: after && after.eventLoop.spreadPercent
    })
    for (const sourceName of ['baseline', 'fixed']) {
      const source = summary.sources[sourceName].rooms[String(size)]
      gates.push({
        name: `http-failures-${sourceName}-${size}`,
        passed: Boolean(source && source.failedRequestCount === 0 && source.requestCount === expectedRequestCount),
        limit: `0 failed requests of ${expectedRequestCount}`,
        failedRequestCount: source && source.failedRequestCount,
        requestCount: source && source.requestCount
      })
    }
  }
  gates.push({
    name: 'owned-room-cleanup',
    passed: Boolean(summary.safety.cleanupVerified && summary.safety.cleanupFailures.length === 0),
    limit: 'all exact run-owned room rows absent',
    cleanupVerified: Boolean(summary.safety.cleanupVerified),
    cleanupFailures: summary.safety.cleanupFailures.length,
    roomKeys: summary.generatedRoomKeys
  })
  gates.push({
    name: 'owned-container-cleanup',
    passed: summary.runtime !== 'Linux Node 20 in existing mind-map-app image' || (
      summary.safety.containersCleanupFailures.length === 0 &&
      summary.safety.containersCreated.length === summary.safety.containersRemoved.length &&
      summary.safety.containersCreated.every(name => summary.safety.containersRemoved.includes(name))
    ),
    limit: 'all run-labeled temporary app containers removed',
    containersCreated: summary.safety.containersCreated,
    containersRemoved: summary.safety.containersRemoved,
    cleanupFailures: summary.safety.containersCleanupFailures.length
  })
  return gates
}

async function cleanupWithCurrentServer(identityId, rooms) {
  if (!rooms.length) return []
  const server = startServer({ serverPath: CURRENT_SERVER, port: PORTS.fixed, label: 'cleanup-server', identityId })
  try {
    await waitForHealth(server)
    const identity = await getIdentity(server, identityId)
    return await deleteOwnedRooms(server, identity.cookie, rooms.map(room => room.roomKey))
  } finally {
    await stopServer(server)
  }
}

async function main() {
  const linuxMode = process.argv.includes('--linux')
  const runRequested = process.argv.includes('--run')
  const roundCount = linuxMode ? LINUX_ROUND_COUNT : ROUND_COUNT
  let dockerPreflight = null
  if (linuxMode && !runRequested) {
    for (const port of Object.values(PORTS)) await checkPortFree(port)
    dockerPreflight = await verifyLinuxDockerPreflight()
  }
  if (!runRequested) {
    console.log(JSON.stringify({
      mode: 'plan-only',
      command: linuxMode
        ? 'node scripts/performance-repair-http.cjs --linux --run'
        : 'node scripts/performance-repair-http.cjs --run',
      runtime: linuxMode ? 'Linux Node 20 in existing mind-map-app image' : 'local Node runtime',
      database: linuxMode
        ? `${DOCKER_POSTGRES}:5432/${DATABASE.database} (${DATABASE.user}); host verification ${DATABASE.host}:${DATABASE.port}`
        : `${DATABASE.host}:${DATABASE.port}/${DATABASE.database} (${DATABASE.user})`,
      redis: linuxMode ? `redis://${DOCKER_REDIS}:6379` : REDIS_URL,
      ports: PORTS,
      baselineCommit: BASELINE_COMMIT,
      sizes: SIZES,
      rounds: roundCount,
      samplesPerSourceAndSize: SAMPLE_COUNT,
      warmupsPerSourceAndSize: WARMUP_COUNT,
      roomPrefix: 'perf-repair-http-',
      dockerPreflight
    }, null, 2))
    return
  }

  assert(fs.existsSync(CURRENT_SERVER), '当前 collabServer.js 不存在')
  assert(fs.existsSync(path.join(TASK_DEPENDENCIES, 'turndown')), `测试专用 turndown 依赖缺失：${TASK_DEPENDENCIES}`)
  assert(!fs.existsSync(runDir), `输出目录已存在，拒绝覆盖：${runDir}`)
  fs.mkdirSync(runDir, { recursive: true })
  writeEventLoopPreload()
  const rooms = SIZES.map(size => ({ roomKey: `perf-repair-http-${runId.slice(0, 18)}-${size}`, size }))
  const roomPrefix = `perf-repair-http-${runId.slice(0, 18)}-`
  const summary = {
    runId, startedAt: new Date().toISOString(), baselineCommit: BASELINE_COMMIT,
    currentCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    sources: { baseline: { rooms: {} }, fixed: { rooms: {} } }, fixtureSizes: SIZES,
    requestPath: '/api/files/:room/subtree?uid=root&limit=1',
    generatedRoomKeys: rooms.map(room => room.roomKey),
    runtime: linuxMode ? 'Linux Node 20 in existing mind-map-app image' : 'local Node runtime',
    rounds: roundCount, samplesPerSourceAndSize: SAMPLE_COUNT, warmupPerSourceAndSize: WARMUP_COUNT,
    safety: {
      database: null, roomsCreated: [], roomsDeleted: [], cleanupFailures: [], cleanupApiWarnings: [], cleanupVerified: false,
      containersCreated: [], containersRemoved: [], containersCleanupFailures: []
    }
  }
  const identityId = `perf-repair-http-${randomUUID()}`
  const roomsCreated = []
  let activeServer = null
  let cookie = ''
  let runError = null
  let linuxServers = {}

  try {
    for (const port of Object.values(PORTS)) await checkPortFree(port)
    summary.safety.database = await verifyTestServices()
    if (linuxMode) {
      dockerPreflight = await verifyLinuxDockerPreflight()
      summary.docker = dockerPreflight
    }
    const archive = archiveBaseline()
    summary.baselineArchive = { path: archive.archivePath, sha256: archive.sha256 }
    summary.sourceHashes = {
      baselineCollabServer: sha256File(path.join(sourceRoot, 'bin', 'collabServer.js')),
      currentCollabServer: sha256File(CURRENT_SERVER),
      currentRoomNodes: sha256File(path.join(APP_DIR, 'bin', 'roomNodes.js'))
    }
    const roundsBySource = { baseline: Object.fromEntries(SIZES.map(size => [String(size), []])), fixed: Object.fromEntries(SIZES.map(size => [String(size), []])) }
    if (linuxMode) {
      const diagnosticsToken = randomUUID()
      const fixedServer = await startDockerServer({ sourceName: 'fixed', identityId, diagnosticsToken })
      linuxServers.fixed = fixedServer
      summary.safety.containersCreated.push(fixedServer.name)
      summary.docker.nodeVersions = { fixed: fixedServer.nodeVersion }
      activeServer = fixedServer
      const identity = await getIdentity(fixedServer, identityId)
      cookie = identity.cookie
      for (const room of rooms) {
        await seedRoom(fixedServer, cookie, room.roomKey, room.size, runId, () => {
          if (!roomsCreated.includes(room)) roomsCreated.push(room)
          if (!summary.safety.roomsCreated.some(item => item.roomKey === room.roomKey)) {
            summary.safety.roomsCreated.push({ roomKey: room.roomKey, size: room.size })
          }
        })
      }

      const baselineServer = await startDockerServer({ sourceName: 'baseline', identityId, diagnosticsToken })
      linuxServers.baseline = baselineServer
      summary.safety.containersCreated.push(baselineServer.name)
      summary.docker.nodeVersions.baseline = baselineServer.nodeVersion
      for (const room of rooms) {
        const baselineResult = await runSourceMeasurement({
          sourceName: 'baseline', room, round: 1, cookie, identityId, existingServer: baselineServer
        })
        roundsBySource.baseline[String(room.size)].push(baselineResult)
      }
      await stopDockerServer(baselineServer)
      summary.safety.containersRemoved.push(baselineServer.name)
      delete linuxServers.baseline

      for (const room of rooms) {
        const fixedResult = await runSourceMeasurement({
          sourceName: 'fixed', room, round: 1, cookie, identityId, existingServer: fixedServer
        })
        roundsBySource.fixed[String(room.size)].push(fixedResult)
      }
    } else {
      const seedServer = startServer({ serverPath: CURRENT_SERVER, port: PORTS.fixed, label: 'seed-server', identityId })
      activeServer = seedServer
      await waitForHealth(seedServer)
      const identity = await getIdentity(seedServer, identityId)
      cookie = identity.cookie
      for (const room of rooms) {
        await seedRoom(seedServer, cookie, room.roomKey, room.size, runId, () => {
          if (!roomsCreated.includes(room)) roomsCreated.push(room)
          if (!summary.safety.roomsCreated.some(item => item.roomKey === room.roomKey)) {
            summary.safety.roomsCreated.push({ roomKey: room.roomKey, size: room.size })
          }
        })
      }
      await stopServer(seedServer)
      activeServer = null

      for (let round = 1; round <= roundCount; round++) {
        for (const room of rooms) {
          const order = round % 2 === 1 ? ['baseline', 'fixed'] : ['fixed', 'baseline']
          for (const sourceName of order) {
            const result = await runSourceMeasurement({
              serverPath: sourceName === 'baseline' ? path.join(sourceRoot, 'bin', 'collabServer.js') : CURRENT_SERVER,
              port: PORTS[sourceName], sourceName, room, round, cookie, identityId
            })
            roundsBySource[sourceName][String(room.size)].push(result)
          }
        }
      }
    }
    for (const sourceName of ['baseline', 'fixed']) {
      for (const size of SIZES) {
        summary.sources[sourceName].rooms[String(size)] = aggregateSourceRounds(roundsBySource[sourceName][String(size)])
      }
    }
    summary.measurementsCompleted = true
  } catch (error) {
    summary.failure = { message: error.message, stack: error.stack }
    runError = error
  } finally {
    if (activeServer && !linuxMode) await stopServer(activeServer)
    try {
      let apiWarnings
      if (linuxMode) {
        apiWarnings = linuxServers.fixed && cookie
          ? await deleteOwnedRooms(linuxServers.fixed, cookie, roomsCreated.map(room => room.roomKey))
          : (roomsCreated.length ? [{ warning: 'no owned fixed Linux server available for API cleanup' }] : [])
      } else {
        apiWarnings = await cleanupWithCurrentServer(identityId, roomsCreated)
      }
      summary.safety.cleanupApiWarnings = apiWarnings
      const exactCleanup = await cleanupExactRoomRows(rooms.map(room => room.roomKey), roomPrefix)
      summary.safety.cleanup = exactCleanup
      summary.safety.cleanupVerified = exactCleanup.verified
      summary.safety.roomsDeleted = exactCleanup.verified ? rooms.map(room => room.roomKey) : []
    } catch (error) {
      summary.safety.cleanupFailures.push({ error: error.message })
    }
    if (linuxMode) {
      for (const name of [...dockerOwnedNames]) {
        const source = name.endsWith('-baseline') ? 'baseline' : 'fixed'
        try {
          await stopDockerServer({ name, label: `${source}-linux-server` })
          summary.safety.containersRemoved.push(name)
        } catch (error) {
          summary.safety.containersCleanupFailures.push({ name, error: error.message })
        }
      }
    }
    summary.completed = Boolean(summary.measurementsCompleted)
    summary.gates = buildGates(summary)
    summary.acceptancePassed = Boolean(summary.completed && summary.gates.every(gate => gate.passed))
    summary.completedAt = new Date().toISOString()
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
    appendJsonl(eventsPath, { event: 'run_finished', completed: summary.completed, acceptancePassed: summary.acceptancePassed, cleanupFailures: summary.safety.cleanupFailures.length })
  }
  if (runError) throw runError
  if (!summary.acceptancePassed) process.exitCode = 1
}

main().catch(error => {
  console.error(error.stack || error.message)
  console.error(`结果文件（若已创建）：${summaryPath}`)
  process.exitCode = 1
})
