#!/usr/bin/env node
'use strict'

// Real HTTP/MCP acceptance for the MCP collaborative writer. Default execution
// is a read-only preflight; create/run isolated services only with --run.
const fs = require('fs')
const path = require('path')
const net = require('net')
const os = require('os')
const { execFileSync } = require('child_process')
const { randomUUID, createHash } = require('crypto')
const { pathToFileURL } = require('url')
const { isDeepStrictEqual } = require('node:util')

const ROOT = path.resolve(__dirname, '..', '..')
const APP = path.join(ROOT, 'simple-mind-map')
const OUTPUT_BASE = path.join(ROOT, 'output', 'playwright', 'mcp-collab-20261014', 'http-contract')
const OUTPUT_RUNS = path.join(OUTPUT_BASE, 'runs')
const DEPENDENCIES = path.join(ROOT, 'output', 'performance-repair-20261013', 'dependencies', 'node_modules')
const IMAGE = process.env.MCP_WRITER_IMAGE || 'mind-map-app:perf-repair-6e1f493b'
const NETWORK = 'mcp-incremental-test_default'
const POSTGRES = 'mcp-incremental-test-postgres-1'
const REDIS = 'mcp-incremental-test-redis-1'
const PG = Object.freeze({ host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password' })
const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16389
const REDIS_DB = 14
const API_PORT = 19423
const MCP_PORT = 19424
const PROXY_PORT = 19425
const NOW = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_TOKEN = randomUUID().replace(/-/g, '').slice(0, 12)
const RUN_ID = `${NOW}-${RUN_TOKEN}`
const DB_NAME = `mcp_cp_20261014_http_${RUN_TOKEN}`
const DB_MARKER = `mcp-writer-http:${RUN_ID}`
const MCP_TOKEN = `mcp-writer-http-${randomUUID()}-test-only-token`
const ROOM_KEY = `mcp-http-${RUN_TOKEN}`
const CONTAINER_PREFIX = `mcp-http-${RUN_TOKEN}`
const RUN_DIR = path.join(OUTPUT_RUNS, RUN_ID)
const SNAPSHOT_DIR = path.join(RUN_DIR, 'source-snapshot', 'simple-mind-map')
const SUMMARY_FILE = path.join(RUN_DIR, 'summary.json')
const API_LOG = path.join(RUN_DIR, 'api-container.log')
const MCP_LOG = path.join(RUN_DIR, 'mcp-container.log')
const PROXY_LOG = path.join(RUN_DIR, 'fault-proxy-container.log')
const REDIS_MARKER = `__codex_mcp_writer_http_run__:${RUN_TOKEN}`
const runFlag = process.argv.includes('--run')
const focusedFlag = process.argv.includes('--focused')
const dockerOwned = new Map()
const checks = []
let dbCreated = false
let redisClaimed = false
let apiContainer = null
let mcpContainer = null
let proxyContainer = null
let ownerIdentity = null
let viewerIdentity = null
let ownerClient = null
let viewerClient = null
let failure = null

function assert(condition, message, details) {
  if (condition) return
  const error = new Error(message)
  if (details !== undefined) error.details = details
  throw error
}

function check(name, condition, details = null) {
  const row = { name, status: condition ? 'pass' : 'fail', details }
  checks.push(row)
  if (!condition) {
    const error = new Error(`验收失败：${name}`)
    error.details = details
    throw error
  }
  return row
}

function parseArgs() {
  const unknown = process.argv.slice(2).filter(arg => !['--run', '--dry-run', '--focused'].includes(arg))
  assert(unknown.length === 0, `不支持的参数：${unknown.join(' ')}`)
  assert(!focusedFlag || runFlag, '--focused 必须与 --run 一起使用')
}

function exec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd || ROOT,
      encoding: options.encoding === undefined ? 'utf8' : options.encoding,
      input: options.input,
      maxBuffer: options.maxBuffer || 128 * 1024 * 1024,
      stdio: options.stdio || ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new Error(`${command} ${args.join(' ')} 失败${stderr ? `：${stderr.slice(-1800)}` : `：${error.message}`}`)
  }
}

function docker(args, options = {}) { return exec('docker', args, options) }
function pgModule() { return require(path.join(APP, 'node_modules', 'pg')) }
function redisModule() { return require(path.join(APP, 'node_modules', 'redis')) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function directoryHash(directory) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const rel = path.relative(directory, full).replace(/\\/g, '/')
        const content = fs.readFileSync(full)
        files += 1
        bytes += content.length
        hash.update(rel); hash.update('\0'); hash.update(content); hash.update('\0')
      }
    }
  }
  walk(directory)
  return { sha256: hash.digest('hex'), files, bytes }
}

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(new Error(`端口 ${port} 已占用：${error.code || error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve(true)))
  })
}

async function connectRedis(db = REDIS_DB) {
  const client = redisModule().createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}/${db}`, socket: { connectTimeout: 4000 } })
  client.on('error', () => {})
  await client.connect()
  return client
}

async function preflight() {
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).trim()
  const nodeVersion = docker(['run', '--rm', '--network', NETWORK, '--workdir', '/app/simple-mind-map', '--entrypoint', 'node', IMAGE, '-e', "console.log(process.version); for (const m of ['pg','redis','@modelcontextprotocol/sdk/client/index.js','@modelcontextprotocol/sdk/client/streamableHttp.js']) console.log(m+':'+require.resolve(m))"]).trim()
  const pgState = docker(['inspect', '--format', '{{.State.Running}}', POSTGRES]).trim() === 'true'
  const redisState = docker(['inspect', '--format', '{{.State.Running}}', REDIS]).trim() === 'true'
  const network = JSON.parse(docker(['network', 'inspect', NETWORK]))[0]
  const redisDbCount = Number(docker(['exec', REDIS, 'redis-cli', '-p', '6379', 'CONFIG', 'GET', 'databases']).split(/\s+/).filter(Boolean).pop())
  const redisSize = Number(docker(['exec', REDIS, 'redis-cli', '-n', String(REDIS_DB), 'DBSIZE']).trim())
  const pool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 4000 })
  let pgIdentity
  try {
    pgIdentity = (await pool.query('select current_database() as database, current_user as username')).rows[0]
  } finally { await pool.end() }
  const sdk = await import(pathToFileURL(path.join(APP, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')).href)
  const transport = await import(pathToFileURL(path.join(APP, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'streamableHttp.js')).href)
  const ports = []
  for (const port of [API_PORT, MCP_PORT, PROXY_PORT]) { await portAvailable(port); ports.push(port) }
  assert(pgState && redisState, '隔离 PG/Redis 测试容器未运行')
  assert(network && network.Name === NETWORK, '测试 Docker network 身份不匹配')
  assert(pgIdentity.database === PG.database && pgIdentity.username === PG.user, 'PG 测试源身份不匹配')
  assert(redisDbCount > REDIS_DB && redisSize === 0, `Redis DB ${REDIS_DB} 不可安全使用，DBSIZE=${redisSize}`)
  assert(/^v20\./.test(nodeVersion.split(/\r?\n/)[0]), `容器不是 Node20：${nodeVersion}`)
  assert(sdk.Client && transport.StreamableHTTPClientTransport, '宿主机 MCP SDK 类加载失败')
  assert(fs.existsSync(DEPENDENCIES), `Node20 共享依赖目录不存在：${DEPENDENCIES}`)
  return {
    mode: runFlag ? 'run' : 'dry-run', runId: RUN_ID,
    source: { kind: 'current-working-tree-snapshot', app: APP },
    services: { postgres: pgIdentity, redis: { host: REDIS_HOST, port: REDIS_PORT, db: REDIS_DB, size: redisSize }, network: NETWORK, containers: { postgres: pgState, redis: redisState } },
    docker: { image: IMAGE, imageId, nodeVersion: nodeVersion.split(/\r?\n/)[0], modules: nodeVersion.split(/\r?\n/).slice(1) },
    host: { node: process.version, platform: process.platform, cpus: os.cpus().length, ports },
    boundaries: { realHttp: true, realMcpSdk: true, isolatedDatabase: DB_NAME, isolatedRedisDb: REDIS_DB, businessRoom: false, existingContainersRestarted: false, remoteDeployment: false }
  }
}

function snapshotCurrentSource() {
  const sourceBin = path.join(APP, 'bin')
  const sourceSrc = path.join(APP, 'src')
  const sourceProxy = path.join(APP, 'scripts', 'mcp-writer-http-fault-proxy.cjs')
  assert(fs.existsSync(path.join(sourceBin, 'collabServer.js')) && fs.existsSync(path.join(sourceBin, 'mcpServer.mjs')), 'C source snapshot 缺少服务入口')
  const beforeBin = directoryHash(sourceBin)
  const beforeSrc = directoryHash(sourceSrc)
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  fs.cpSync(sourceBin, path.join(SNAPSHOT_DIR, 'bin'), { recursive: true })
  fs.cpSync(sourceSrc, path.join(SNAPSHOT_DIR, 'src'), { recursive: true })
  fs.mkdirSync(path.join(SNAPSHOT_DIR, 'scripts'), { recursive: true })
  fs.copyFileSync(sourceProxy, path.join(SNAPSHOT_DIR, 'scripts', 'mcp-writer-http-fault-proxy.cjs'))
  const afterBin = directoryHash(sourceBin)
  const afterSrc = directoryHash(sourceSrc)
  const copiedBin = directoryHash(path.join(SNAPSHOT_DIR, 'bin'))
  const copiedSrc = directoryHash(path.join(SNAPSHOT_DIR, 'src'))
  const copiedProxy = fs.readFileSync(path.join(SNAPSHOT_DIR, 'scripts', 'mcp-writer-http-fault-proxy.cjs'))
  const sourceProxyBytes = fs.readFileSync(sourceProxy)
  assert(beforeBin.sha256 === afterBin.sha256 && beforeSrc.sha256 === afterSrc.sha256, '源代码在快照过程中变化，拒绝继续')
  assert(afterBin.sha256 === copiedBin.sha256 && afterSrc.sha256 === copiedSrc.sha256, '代码快照与工作区散列不一致')
  assert(sha256(sourceProxyBytes) === sha256(copiedProxy), '故障代理脚本快照与工作区散列不一致')
  return { kind: 'current-working-tree-snapshot', app: APP, bin: copiedBin, src: copiedSrc, faultProxy: { sha256: sha256(copiedProxy), bytes: copiedProxy.length }, stableDuringCopy: true }
}

async function createDatabase() {
  assert(/^mcp_cp_20261014_http_[a-f0-9]{12}$/.test(DB_NAME), `拒绝非 run-owned DB 名：${DB_NAME}`)
  const pool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const source = (await pool.query('select current_database() as database,current_user as username')).rows[0]
    assert(source.database === PG.database && source.username === PG.user, '创建 DB 的 PG source identity 不匹配')
    const dump = docker(['exec', POSTGRES, 'pg_dump', '-U', PG.user, '--schema-only', '--no-owner', '--no-acl', PG.database])
    await pool.query(`CREATE DATABASE ${DB_NAME} OWNER ${PG.user}`)
    dbCreated = true
    docker(['exec', '-i', POSTGRES, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', DB_NAME], { input: dump })
    await pool.query(`COMMENT ON DATABASE ${DB_NAME} IS '${DB_MARKER}'`)
    const terminalReceiptMigration = path.join(APP, 'migrations', '012_mcp_terminal_receipts.up.sql')
    assert(fs.existsSync(terminalReceiptMigration), '隔离 HTTP 测试缺少明确迁移 010')
    docker(['exec', '-i', POSTGRES, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', DB_NAME], {
      input: fs.readFileSync(terminalReceiptMigration, 'utf8')
    })
    const marker = await pool.query(`select shobj_description(oid,'pg_database') as comment from pg_database where datname=$1`, [DB_NAME])
    assert(marker.rows[0] && marker.rows[0].comment === DB_MARKER, 'DB ownership marker 校验失败')
    const schema = new (pgModule().Pool)({ ...PG, database: DB_NAME, max: 1, connectionTimeoutMillis: 5000 })
    try {
      const tables = await schema.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name")
      const terminalReceipts = await schema.query("select to_regclass('public.mcp_terminal_receipts') as relation")
      assert(terminalReceipts.rows[0] && terminalReceipts.rows[0].relation === 'mcp_terminal_receipts', 'isolated DB did not apply migration 010')
      const indexes = await schema.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('room_operations','room_operations_archive','room_restore_idempotency','room_nodes') order by tablename,indexname")
      const indexNames = new Set(indexes.rows.map(row => row.indexname))
      assert(indexNames.has('room_operations_op_id_global_uidx') && indexNames.has('room_nodes_one_root_idx'), 'schema-only fixture 缺少幂等/单根索引')
      return { database: DB_NAME, ownershipMarker: DB_MARKER, schemaOnly: true, dataCopied: false, sourceSchemaSha256: sha256(dump), migrationsApplied: ['012_mcp_terminal_receipts.up.sql'], tableCount: tables.rowCount, indexes: indexes.rows }
    } finally { await schema.end() }
  } finally { await pool.end() }
}

function dockerPath(value) { return path.resolve(value).replace(/\\/g, '/') }

function buildServiceEnv(role, appOrigin) {
  const env = {
    MIND_MAP_SKIP_ROOT_ENV: '1', HOST: '0.0.0.0', PORT: role === 'api' ? '1234' : '3847',
    PGHOST: POSTGRES, PGPORT: '5432', PGDATABASE: DB_NAME, PGUSER: PG.user, PGPASSWORD: PG.password,
    REDIS_URL: `redis://${REDIS}:6379/${REDIS_DB}`, COLLAB_EVENT_BUS: 'redis', COLLAB_PRESENCE_BACKEND: 'redis',
    COLLAB_E2E: '1', COLLAB_OUTBOX_PUBLISHER: '0', COLLAB_TRACE: '0', COLLAB_V2_TRACE: '0',
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef', WECOM_AGENT_ID: '1000001', WECOM_SECRET: 'mcp-writer-http-test-only-secret',
    AUTH_SESSION_SECRET: `mcp-writer-http-${RUN_TOKEN}-session-secret-32-bytes`, AUTH_APP_ORIGIN: appOrigin, AUTH_ALLOWED_ORIGINS: appOrigin, AUTH_COOKIE_SECURE: 'false',
    WECOM_REDIRECT_URI: `${appOrigin}/api/auth/wecom/callback`, MCP_TOKEN,
    MIND_MAP_SUPER_ADMIN_IDS: `mcp-http-owner-${RUN_TOKEN}`,
    PERFORMANCE_DIAGNOSTICS: '1',
    MCP_HOST: '0.0.0.0', MCP_PORT: '3847',
    KNOWLEDGE_COMPILER_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false',
    COLLAB_RATE_LIMIT_PER_ROOM: '8000', COLLAB_RATE_LIMIT_GLOBAL: '80000',
    NODE_PATH: '/perf-deps:/app/node_modules:/app/simple-mind-map/node_modules',
    COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: '1', COLLAB_MCP_DIRECT: '1'
  }
  if (role === 'mcp') env.MIND_MAP_API = `http://${CONTAINER_PREFIX}-proxy:1235`
  return env
}

function startContainer(role, appOrigin) {
  const name = `${CONTAINER_PREFIX}-${role}`
  const existing = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
  assert(!existing.includes(name), `容器名已存在，拒绝替换：${name}`)
  const port = role === 'api' ? API_PORT : MCP_PORT
  const servicePort = role === 'api' ? 1234 : 3847
  const serverPath = role === 'api' ? '/app/simple-mind-map/bin/collabServer.js' : '/app/simple-mind-map/bin/mcpServer.mjs'
  const env = buildServiceEnv(role, appOrigin)
  const args = [
    'run', '--detach', '--name', name,
    '--label', `codex.mcp-writer-http-run=${RUN_ID}`,
    '--label', `codex.mcp-writer-http-role=${role}`,
    '--network', NETWORK, '--cpus', '1', '--memory', '1536m',
    '--publish', `127.0.0.1:${port}:${servicePort}`,
    '--workdir', '/app/simple-mind-map',
    '--mount', `type=bind,source=${dockerPath(path.join(SNAPSHOT_DIR, 'bin'))},target=/app/simple-mind-map/bin,readonly`,
    '--mount', `type=bind,source=${dockerPath(path.join(SNAPSHOT_DIR, 'src'))},target=/app/simple-mind-map/src,readonly`,
    '--mount', `type=bind,source=${dockerPath(DEPENDENCIES)},target=/perf-deps,readonly`
  ]
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push('--entrypoint', 'node', IMAGE, serverPath)
  if (role === 'mcp') args.push('--http')
  docker(args)
  dockerOwned.set(name, { role })
  const version = docker(['exec', name, 'node', '--version']).trim()
  assert(/^v20\./.test(version), `${role} 运行时非 Node20：${version}`)
  return { name, port, origin: `http://127.0.0.1:${port}`, nodeVersion: version }
}

function startFaultProxy() {
  const name = `${CONTAINER_PREFIX}-proxy`
  const existing = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
  assert(!existing.includes(name), `容器名已存在，拒绝替换：${name}`)
  docker([
    'run', '--detach', '--name', name,
    '--label', `codex.mcp-writer-http-run=${RUN_ID}`,
    '--label', 'codex.mcp-writer-http-role=proxy',
    '--network', NETWORK,
    '--publish', `127.0.0.1:${PROXY_PORT}:1235`,
    '--mount', `type=bind,source=${dockerPath(path.join(SNAPSHOT_DIR, 'scripts', 'mcp-writer-http-fault-proxy.cjs'))},target=/tmp/mcp-writer-http-fault-proxy.cjs,readonly`,
    '--env', `TARGET_API=http://${CONTAINER_PREFIX}-api:1234`,
    '--env', 'PORT=1235',
    '--entrypoint', 'node', IMAGE, '/tmp/mcp-writer-http-fault-proxy.cjs'
  ])
  dockerOwned.set(name, { role: 'proxy' })
  return { name, port: PROXY_PORT, origin: `http://127.0.0.1:${PROXY_PORT}`, target: `http://${CONTAINER_PREFIX}-api:1234` }
}

async function waitHttp(url, label, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < end) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return response
      last = `HTTP ${response.status}`
    } catch (error) { last = error.message }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`${label} readiness 超时：${last}`)
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) {}
  return { response, text, data }
}

async function faultProxyControl(route, body) {
  const res = await requestJson(`http://127.0.0.1:${PROXY_PORT}/__control/${route}`, {
    method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  })
  assert(res.response.ok, `fault proxy ${route} failed HTTP ${res.response.status}: ${res.text}`)
  return res.data
}

async function waitForProxyAttempts(operationId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await faultProxyControl('state')
    const rows = (latest.attempts || []).filter(row => row.operationId === operationId)
    if (predicate(rows)) return rows
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`fault proxy attempt wait timed out for ${operationId}: ${JSON.stringify(latest)}`)
}

async function restoreVersionDirect(origin, identity, roomKey, versionId, expectedCurrentRevision) {
  const url = `${origin}/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(versionId)}/restore`
  const res = await requestJson(url, {
    method: 'POST',
    headers: cookieHeaders(identity, origin),
    body: JSON.stringify({ expectedCurrentRevision })
  })
  assert(res.response.ok, `isolated direct restore failed HTTP ${res.response.status}: ${res.text.slice(0, 800)}`)
  return res.data
}

function cookieHeaders(identity, origin) {
  return { Cookie: `mind_map_session=${identity.token}`, Origin: origin, 'Content-Type': 'application/json' }
}

async function createIdentity(origin, userId) {
  const res = await requestJson(`${origin}/api/auth/e2e-identity`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  })
  assert(res.response.ok && res.data && res.data.token, `E2E identity 创建失败 ${userId}: HTTP ${res.response.status} ${res.text.slice(0, 500)}`)
  return { userId: res.data.userId || userId, token: res.data.token }
}

async function seedRoom(origin, identity) {
  const headers = cookieHeaders(identity, origin)
  let res = await requestJson(`${origin}/api/files`, {
    method: 'POST', headers, body: JSON.stringify({ room_key: ROOM_KEY, title: 'MCP Writer HTTP Contract' })
  })
  assert(res.response.ok, `run-owned room create failed HTTP ${res.response.status}: ${res.text.slice(0, 600)}`)
  const node = (uid, text, children = [], extra = {}) => ({ data: { uid, text, expand: true, ...extra }, children })
  const tree = node('root', 'MCP Writer Contract Root', [
    node('sop', 'SOP', [node('sop-child', 'SOP test item')]),
    node('parent-a', 'Parent A', [node('descendant-a', 'Descendant')]),
    node('parent-b', 'Parent B'),
    node('move-node', 'Move me', [], { hyperlink: 'https://example.test/original', hyperlinkTitle: 'Original link' }),
    node('delete-node', 'Delete me', [node('delete-child', 'Delete child')])
  ])
  res = await requestJson(`${origin}/api/files/${encodeURIComponent(ROOM_KEY)}/replace`, {
    method: 'POST', headers, body: JSON.stringify({ tree, client_id: `mcp-http-seed-${RUN_TOKEN}`, operation_id: randomUUID(), allowFullTree: true })
  })
  assert(res.response.ok, `seed tree failed HTTP ${res.response.status}: ${res.text.slice(0, 800)}`)
  return { roomKey: ROOM_KEY, seedRevision: Number(res.data && (res.data.version || res.data.currentRevision || 0)), nodeCount: 9 }
}

async function createMcpClient(identity, secret) {
  const { issueMcpUserToken } = require(path.join(APP, 'bin', 'mcpUserToken.js'))
  const { Client } = await import(pathToFileURL(path.join(APP, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')).href)
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(APP, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'streamableHttp.js')).href)
  const token = issueMcpUserToken(identity.userId, secret)
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'mcp-writer-http-contract', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  const listed = await client.listTools()
  const names = new Set((listed.tools || []).map(item => item.name))
  for (const name of ['add_node', 'update_node', 'move_node', 'delete_node', 'apply_nodes', 'create_version', 'get_version', 'list_versions', 'restore_version']) {
    assert(names.has(name), `MCP tool missing: ${name}`)
  }
  return { client, token, tools: names }
}

function parseMcpResult(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return { isError: !!result.isError, data: result.structuredContent, rawText: '' }
  }
  const blocks = (result && Array.isArray(result.content) ? result.content : []).filter(item => item && item.type === 'text')
  for (const block of blocks) {
    try { return { isError: !!result.isError, data: JSON.parse(block.text), rawText: block.text } } catch (_) {}
  }
  return { isError: !!(result && result.isError), data: null, rawText: blocks.map(item => item.text).join('\n') }
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 })
  return parseMcpResult(response)
}

function codeOf(result) { return result.data && result.data.code || '' }
function assertToolOk(name, result) {
  assert(!result.isError, `${name} returned isError: ${result.rawText || JSON.stringify(result.data)}`, result.data)
  assert(result.data && result.data.ok !== false, `${name} was not applied: ${result.rawText || JSON.stringify(result.data)}`, result.data)
  return result.data
}
function assertToolError(name, result, expectedCode) {
  assert(result.isError, `${name} unexpectedly succeeded`, result.data)
  if (expectedCode) assert(codeOf(result) === expectedCode, `${name} expected ${expectedCode}, got ${codeOf(result)} (${result.rawText})`, result.data)
  return result.data || { message: result.rawText }
}

async function roomNodes(origin, identity, uids = []) {
  const query = uids.length ? `?uids=${encodeURIComponent(uids.join(','))}` : ''
  const res = await requestJson(`http://127.0.0.1:${API_PORT}/api/files/${encodeURIComponent(ROOM_KEY)}/nodes${query}`, {
    headers: cookieHeaders(identity, origin)
  })
  assert(res.response.ok, `room nodes read failed HTTP ${res.response.status}: ${res.text.slice(0, 400)}`)
  return res.data
}

async function performanceDiagnostics(origin, identity, roomKey, after = 0) {
  const url = new URL('/api/diagnostics/performance', origin)
  url.searchParams.set('room', roomKey)
  url.searchParams.set('after', String(after))
  const res = await requestJson(url, { headers: cookieHeaders(identity, origin) })
  assert(res.response.ok, `performance diagnostics read failed HTTP ${res.response.status}: ${res.text.slice(0, 500)}`)
  assert(res.data && res.data.enabled === true, 'test diagnostics are not enabled', res.data)
  return res.data
}

function assertFailedDirectDiagnostic(snapshot, operationId, operationType, code) {
  const events = snapshot && snapshot.events || []
  const write = events.find(event => event.kind === 'mcp-write' && event.operationId === operationId)
  assert(write && write.stage === 'reject' && write.code === code, 'failed write diagnostic is missing or unexpected', { operationId, code, events })
  assert(!write.fallbackReason, 'failed Direct write unexpectedly recorded a fallback reason', write)
  const directTransaction = events.find(event =>
    event.kind === 'transaction' && event.source === 'mcp' && event.path === 'direct' &&
    event.type === operationType && event.ok === false
  )
  assert(directTransaction, 'failed operation did not reach the Direct transaction', { operationId, operationType, events })
  const fullPath = events.filter(event =>
    event.source === 'mcp' && event.path === 'full' &&
    ['pool', 'lock-query', 'transaction'].includes(event.kind)
  )
  assert(fullPath.length === 0, 'rejected Direct reference entered the full-tree path', fullPath)
  return { write, directTransaction, fullPathCount: fullPath.length }
}

function assertLegacyFallbackDiagnostic(snapshot, operationId, operationType) {
  const events = snapshot && snapshot.events || []
  const write = events.find(event => event.kind === 'mcp-write' && event.operationId === operationId)
  assert(write && write.stage === 'commit' && write.path === 'legacy' &&
    write.fallbackReason === 'direct_policy_unsupported', 'title/path write did not report its explicit legacy fallback', { operationId, events })
  const fullTransaction = events.find(event =>
    event.kind === 'transaction' && event.source === 'mcp' && event.path === 'full' &&
    event.type === operationType && event.ok === true
  )
  assert(fullTransaction, 'legacy compatibility write did not record the full transaction path', { operationId, operationType, events })
  return { write, fullTransaction }
}

async function roomNodeExistsByText(origin, identity, text) {
  const res = await requestJson(`http://127.0.0.1:${API_PORT}/api/files/${encodeURIComponent(ROOM_KEY)}/nodes/query`, {
    method: 'POST',
    headers: cookieHeaders(identity, origin),
    body: JSON.stringify({ scope: 'self', selector: { type: 'name', match: 'exact', value: text } })
  })
  if (res.response.status === 404 && res.data && res.data.code === 'NODE_NOT_FOUND') return false
  assert(res.response.ok, `room node text query failed HTTP ${res.response.status}: ${res.text.slice(0, 400)}`)
  return (res.data.items || []).some(item => item.data && item.data.text === text)
}

async function roomTree(origin, identity) {
  const nodes = new Map()
  const requested = new Set()
  let pending = ['root']
  let version = null
  while (pending.length) {
    const unrequested = pending.filter(uid => !requested.has(uid))
    const batch = unrequested.slice(0, 100)
    pending = unrequested.slice(batch.length)
    if (!batch.length) break
    batch.forEach(uid => requested.add(uid))
    const page = await roomNodes(origin, identity, batch)
    if (version == null) version = Number(page.version)
    assert(Number(page.version) === version, 'room revision changed while reading the test tree', { expected: version, actual: page.version })
    const byUid = new Map((page.nodes || []).map(node => [String(node.uid), node]))
    for (const uid of batch) assert(byUid.has(uid), `room tree referenced a missing node: ${uid}`, { version, batch, returned: [...byUid.keys()] })
    for (const node of page.nodes || []) {
      const uid = String(node.uid)
      if (nodes.has(uid)) continue
      nodes.set(uid, node)
      for (const childUid of Array.isArray(node.children) ? node.children : []) {
        const child = String(childUid || '')
        if (child && !requested.has(child) && !nodes.has(child) && !pending.includes(child)) pending.push(child)
      }
    }
  }
  assert(nodes.has('root'), 'room tree read did not return the root node')
  return { room_key: ROOM_KEY, version, nodes: [...nodes.values()] }
}

async function addMember(origin, owner, userId, role) {
  const res = await requestJson(`${origin}/api/files/${encodeURIComponent(ROOM_KEY)}/members`, {
    method: 'POST', headers: cookieHeaders(owner, origin), body: JSON.stringify({ user_id: userId, role })
  })
  assert(res.response.ok, `add ${role} member failed HTTP ${res.response.status}: ${res.text.slice(0, 500)}`)
  return res.data
}

function record(name, details) { checks.push({ name, status: 'pass', details: details || null }) }

async function runContract(origin) {
  ownerIdentity = await createIdentity(apiContainer.origin, `mcp-http-owner-${RUN_TOKEN}`)
  viewerIdentity = await createIdentity(apiContainer.origin, `mcp-http-viewer-${RUN_TOKEN}`)
  const seeded = await seedRoom(apiContainer.origin, ownerIdentity)
  ownerClient = await createMcpClient(ownerIdentity, MCP_TOKEN)
  viewerClient = await createMcpClient(viewerIdentity, MCP_TOKEN)
  const owner = ownerClient.client
  const roomKey = seeded.roomKey
  const addId = randomUUID()
  let result = await call(owner, 'add_node', { room_key: roomKey, text: 'Added via MCP', parent: 'parent-a', hyperlink: 'https://example.test/add', hyperlinkTitle: 'Added link', operation_id: addId })
  if (result.isError) {
    const diagnostic = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)
    const operationEvents = (diagnostic.events || []).filter(event => event.operationId === addId)
    const error = new Error(`initial add_node failed; matching diagnostics: ${JSON.stringify(operationEvents)}`)
    error.details = result.data
    throw error
  }
  let data = assertToolOk('add_node', result)
  assert(data.submissionPath === 'direct', 'eligible add_node did not use Direct path', data)
  const addedUid = data.uid || (data.event && data.event.payload && data.event.payload.uid)
  assert(addedUid, 'add_node result omitted uid', data)
  let row = await roomNodes(apiContainer.origin, ownerIdentity, [addedUid])
  assert(row.nodes.length === 1 && row.nodes[0].data.hyperlink === 'https://example.test/add' && row.nodes[0].data.hyperlinkTitle === 'Added link', 'add_node hyperlink fields were not persisted', row.nodes)
  record('single add_node + hyperlink persistence + MCP user JWT', { operationId: addId, uid: addedUid, submissionPath: data.submissionPath, revision: row.version })

  const updateId = randomUUID()
  result = await call(owner, 'update_node', { room_key: roomKey, node: addedUid, text: 'Updated via MCP', hyperlink: 'https://example.test/updated', hyperlinkTitle: 'Updated link', operation_id: updateId })
  data = assertToolOk('update_node', result)
  assert(data.submissionPath === 'direct', 'eligible update_node did not use Direct path', data)
  row = await roomNodes(apiContainer.origin, ownerIdentity, [addedUid])
  assert(row.nodes[0].data.text === 'Updated via MCP' && row.nodes[0].data.hyperlink === 'https://example.test/updated' && row.nodes[0].data.hyperlinkTitle === 'Updated link', 'update_node text/link persistence mismatch', row.nodes)
  record('single update_node + link field update', { operationId: updateId, uid: addedUid, submissionPath: data.submissionPath, revision: row.version })

  const moveId = randomUUID()
  result = await call(owner, 'move_node', { room_key: roomKey, node: 'move-node', parent: 'parent-b', index: 0, operation_id: moveId })
  data = assertToolOk('move_node', result)
  assert(data.submissionPath === 'direct', 'eligible move_node did not use Direct path', data)
  row = await roomNodes(apiContainer.origin, ownerIdentity, ['parent-b', 'move-node'])
  const parentB = row.nodes.find(item => item.uid === 'parent-b')
  const moved = row.nodes.find(item => item.uid === 'move-node')
  assert(parentB.children.includes('move-node') && moved.data.hyperlink === 'https://example.test/original' && moved.data.hyperlinkTitle === 'Original link', 'move_node did not preserve UID/parent/link fields', row.nodes)
  record('move_node preserves UID, hyperlink, and assigns parent', { operationId: moveId, uid: 'move-node', parentUid: 'parent-b', submissionPath: data.submissionPath, revision: row.version })

  let beforeMoveConflict = row.version
  result = await call(owner, 'move_node', {
    room_key: roomKey,
    uid: 'move-node',
    node: 'parent-a',
    parent_uid: 'parent-b',
    parent: 'parent-b',
    operation_id: randomUUID()
  })
  data = assertToolError('conflicting move_node UID aliases', result, 'MCP_MOVE_REFERENCE_INVALID')
  assert(Number(data.statusCode) === 400 && data.writeSubmitted === false, 'conflicting move_node aliases must be rejected before submission', data)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === beforeMoveConflict, 'conflicting move_node aliases changed room revision')
  record('move_node rejects conflicting canonical UID and alias before submission', { code: data.code, statusCode: data.statusCode, writeSubmitted: data.writeSubmitted, revision: beforeMoveConflict })

  result = await call(owner, 'move_node', {
    room_key: roomKey,
    uid: 'move-node',
    parent_uid: 'root',
    index: 1,
    operation_id: randomUUID()
  })
  data = assertToolOk('canonical move_node to root', result)
  assert(data.submissionPath === 'direct', 'canonical move_node did not use Direct path', data)
  row = await roomNodes(apiContainer.origin, ownerIdentity, ['root', 'parent-b', 'move-node'])
  const rootAfterMove = row.nodes.find(item => item.uid === 'root')
  const parentBAfterMove = row.nodes.find(item => item.uid === 'parent-b')
  const movedAtRoot = row.nodes.find(item => item.uid === 'move-node')
  assert(rootAfterMove.children.includes('move-node') && !parentBAfterMove.children.includes('move-node'), 'canonical parent_uid=root move did not update the parent links', row.nodes)
  assert(movedAtRoot.data.hyperlink === 'https://example.test/original' && movedAtRoot.data.hyperlinkTitle === 'Original link', 'canonical root move changed node data', movedAtRoot)
  record('canonical move_node accepts parent_uid=root and preserves node identity', { uid: 'move-node', parentUid: 'root', revision: row.version })

  result = await call(owner, 'move_node', {
    room_key: roomKey,
    uid: 'move-node',
    parent_uid: 'parent-b',
    index: 0,
    operation_id: randomUUID()
  })
  data = assertToolOk('canonical move_node to parent', result)
  assert(data.submissionPath === 'direct', 'canonical move_node to parent did not use Direct path', data)
  row = await roomNodes(apiContainer.origin, ownerIdentity, ['parent-b', 'move-node'])
  assert(row.nodes.find(item => item.uid === 'parent-b').children.includes('move-node'), 'canonical parent_uid move did not assign target parent', row.nodes)
  record('canonical move_node accepts uid and parent_uid', { uid: 'move-node', parentUid: 'parent-b', revision: row.version })

  result = await call(owner, 'move_node', { room_key: roomKey, node: 'parent-a', parent: 'descendant-a', operation_id: randomUUID() })
  data = assertToolError('cycle move', result, 'CYCLE_REJECTED')
  record('cycle move rejected', { code: data.code, revision: (await roomNodes(apiContainer.origin, ownerIdentity)).version })

  const deleteId = randomUUID()
  result = await call(owner, 'delete_node', { room_key: roomKey, node: 'delete-node', operation_id: deleteId })
  data = assertToolOk('delete_node', result)
  assert(data.submissionPath === 'direct', 'eligible delete_node did not use Direct path', data)
  row = await roomNodes(apiContainer.origin, ownerIdentity, ['delete-node', 'delete-child'])
  assert(row.nodes.length === 0, 'delete_node did not remove subtree from authoritative nodes', row.nodes)
  record('single delete_node removes subtree', { operationId: data.operationId, removed: data.removed, revision: row.version })

  const afterDeleteRevision = row.version
  result = await call(owner, 'delete_node', { room_key: roomKey, node: 'delete-node', operation_id: deleteId })
  const duplicateDelete = assertToolOk('delete_node same operation_id after tombstone', result)
  assert(duplicateDelete.duplicate === true && duplicateDelete.submissionPath === 'direct' && duplicateDelete.operationId === deleteId,
    'same-ID tombstone delete did not replay its Direct receipt', duplicateDelete)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === afterDeleteRevision,
    'same-ID tombstone delete added another room revision')
  record('same delete operation_id replays the Direct tombstone receipt', { operationId: deleteId, duplicate: duplicateDelete.duplicate, submissionPath: duplicateDelete.submissionPath, revision: afterDeleteRevision })

  const newDeleteId = randomUUID()
  const deleteFailureCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'delete_node', { room_key: roomKey, node: 'delete-node', operation_id: newDeleteId })
  data = assertToolError('new delete operation_id after tombstone', result, 'NODE_DELETED')
  const deleteFailureDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, deleteFailureCursor)
  const deleteFailureEvidence = assertFailedDirectDiagnostic(deleteFailureDiagnostics, newDeleteId, 'node.delete', 'NODE_DELETED')
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === afterDeleteRevision,
    'different-ID delete of tombstoned UID changed room revision')
  record('different delete operation_id rejects tombstoned UID through Direct without full path', { operationId: newDeleteId, code: data.code, diagnostics: deleteFailureEvidence, revision: afterDeleteRevision })

  const missingUid = '10000000-0000-4000-8000-000000000099'
  const missingUidId = randomUUID()
  let failClosedCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'update_node', { room_key: roomKey, node: missingUid, text: 'must not be created', operation_id: missingUidId })
  data = assertToolError('update missing UUID UID', result, 'NODE_DELETED')
  let failClosedDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, failClosedCursor)
  let failClosedEvidence = assertFailedDirectDiagnostic(failClosedDiagnostics, missingUidId, 'node.update', 'NODE_DELETED')
  record('missing UUID UID is rejected by Direct without full path', { operationId: missingUidId, code: data.code, diagnostics: failClosedEvidence })

  const missingParentUid = '20000000-0000-4000-8000-000000000099'
  const missingParentId = randomUUID()
  failClosedCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'add_node', { room_key: roomKey, text: `missing parent ${RUN_TOKEN}`, parent: missingParentUid, operation_id: missingParentId })
  data = assertToolError('add under missing UUID parent', result, 'PARENT_DELETED')
  failClosedDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, failClosedCursor)
  failClosedEvidence = assertFailedDirectDiagnostic(failClosedDiagnostics, missingParentId, 'node.insert', 'PARENT_DELETED')
  record('missing UUID insert parent is rejected by Direct without full path', { operationId: missingParentId, code: data.code, diagnostics: failClosedEvidence })

  const pathMoveId = randomUUID()
  failClosedCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'move_node', {
    room_key: roomKey,
    uid: 'MCP Writer Contract Root/Move me',
    parent_uid: 'root',
    operation_id: pathMoveId
  })
  data = assertToolError('move_node refuses a title path as UID', result, 'NODE_DELETED')
  failClosedDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, failClosedCursor)
  failClosedEvidence = assertFailedDirectDiagnostic(failClosedDiagnostics, pathMoveId, 'node.move', 'NODE_DELETED')
  record('canonical move_node treats non-UUID title path as an unknown UID and rejects without legacy/full fallback', { operationId: pathMoveId, code: data.code, diagnostics: failClosedEvidence })

  const titleRefId = randomUUID()
  let legacyCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'update_node', { room_key: roomKey, node: 'Move me', note: 'legacy title reference', operation_id: titleRefId })
  data = assertToolOk('update_node by title compatibility', result)
  assert(data.submissionPath === 'legacy' && data.fallbackReason === 'direct_policy_unsupported', 'title reference did not remain on explicit legacy compatibility path', data)
  let legacyDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, legacyCursor)
  let legacyEvidence = assertLegacyFallbackDiagnostic(legacyDiagnostics, titleRefId, 'node.update')
  const titleRefNodes = await roomNodes(apiContainer.origin, ownerIdentity, ['move-node'])
  assert(titleRefNodes.nodes[0] && titleRefNodes.nodes[0].data.note === 'legacy title reference', 'title reference compatibility update did not resolve the intended node', titleRefNodes.nodes)
  record('ordinary title reference explicitly uses legacy compatibility path', { operationId: titleRefId, submissionPath: data.submissionPath, fallbackReason: data.fallbackReason, diagnostics: legacyEvidence })

  const pathRefId = randomUUID()
  legacyCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  result = await call(owner, 'update_node', { room_key: roomKey, node: 'MCP Writer Contract Root/Parent B/Move me', note: 'legacy path reference', operation_id: pathRefId })
  data = assertToolOk('update_node by path compatibility', result)
  assert(data.submissionPath === 'legacy' && data.fallbackReason === 'direct_policy_unsupported', 'path reference did not remain on explicit legacy compatibility path', data)
  legacyDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, legacyCursor)
  legacyEvidence = assertLegacyFallbackDiagnostic(legacyDiagnostics, pathRefId, 'node.update')
  const pathRefNodes = await roomNodes(apiContainer.origin, ownerIdentity, ['move-node'])
  assert(pathRefNodes.nodes[0] && pathRefNodes.nodes[0].data.note === 'legacy path reference', 'path reference compatibility update did not resolve the intended node', pathRefNodes.nodes)
  record('ordinary full title path explicitly uses legacy compatibility path', { operationId: pathRefId, submissionPath: data.submissionPath, fallbackReason: data.fallbackReason, diagnostics: legacyEvidence })

  const beforeRoot = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  result = await call(owner, 'delete_node', { room_key: roomKey, node: 'root', operation_id: randomUUID() })
  data = assertToolError('delete root', result, 'ROOT_DELETE')
  const afterRoot = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  assert(beforeRoot === afterRoot, 'root delete changed room revision', { beforeRoot, afterRoot })
  record('root delete rejected without revision change', { code: data.code, revision: afterRoot })

  const beforeSop = afterRoot
  result = await call(owner, 'update_node', { room_key: roomKey, node: 'sop', text: 'Renamed SOP', operation_id: randomUUID() })
  data = assertToolError('SOP identity edit', result, 'SOP_CONFIRM_REQUIRED')
  const afterSop = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  assert(beforeSop === afterSop, 'unconfirmed SOP edit changed room revision', { beforeSop, afterSop })
  record('unconfirmed SOP identity edit rejected', { code: data.code, revision: afterSop })

  let beforeBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const batchId = randomUUID()
  const batchAddedUid = `batch-added-${RUN_TOKEN}`
  const batchOps = [
    { op: 'add', node: batchAddedUid, parent: 'parent-a', text: 'batch add success', hyperlink: 'https://example.test/batch', hyperlinkTitle: 'Batch link' },
    { op: 'move', node: addedUid, parent: 'parent-b', index: 0 },
    { op: 'update', node: 'sop', text: 'Renamed SOP by confirmed batch', confirm_sop_change: true },
    { op: 'update', node: `missing-${RUN_TOKEN}`, text: 'must fail' },
    { op: 'update', node: batchAddedUid, text: 'must depend on prior failed op', depends_on: [3] }
  ]
  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: batchOps, operation_id: batchId, base_revision: beforeBatch })
  data = assertToolOk('partial apply_nodes', result)
  assert(data.submissionPath === 'direct', 'eligible apply_nodes did not use Direct path', data)
  assert(data.outcome === 'partial' && data.count === 3 && data.failed === 2, 'batch did not return partial outcome/counts', data)
  assert(data.items && data.items[0].status === 'applied' && data.items[1].status === 'applied' && data.items[2].status === 'applied' && data.items[3].status === 'failed' && data.items[4].status === 'dependency_failed' && data.items[4].code === 'MCP_BATCH_DEPENDENCY_FAILED' && JSON.stringify(data.items[4].depends_on) === JSON.stringify([3]), 'batch per-item explicit dependency contract mismatch', data.items)
  const afterBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  assert(afterBatch === beforeBatch + 1, 'partial batch must add exactly one revision', { beforeBatch, afterBatch })
  const batchMoveNodes = await roomNodes(apiContainer.origin, ownerIdentity, ['parent-b'])
  assert(batchMoveNodes.nodes[0].children.includes(addedUid), 'successful batch move did not update parent children', batchMoveNodes.nodes)
  const batchAddNode = await roomNodes(apiContainer.origin, ownerIdentity, [batchAddedUid])
  assert(batchAddNode.nodes.length === 1 && batchAddNode.nodes[0].data.hyperlink === 'https://example.test/batch' && batchAddNode.nodes[0].data.hyperlinkTitle === 'Batch link', 'successful batch add did not persist hyperlink fields', batchAddNode.nodes)
  const confirmedSopNode = await roomNodes(apiContainer.origin, ownerIdentity, ['sop'])
  assert(confirmedSopNode.nodes[0].data.text === 'Renamed SOP by confirmed batch', 'confirmed SOP batch item was not applied', confirmedSopNode.nodes)
  record('partial apply_nodes with batch add/move/confirmed SOP, explicit and implicit depends_on, one revision', { operationId: batchId, outcome: data.outcome, items: data.items, beforeBatch, afterBatch })

  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: batchOps, operation_id: batchId, base_revision: beforeBatch })
  const replay = result.data
  assert(!result.isError && replay && replay.duplicate === true && isDeepStrictEqual(replay.items, data.items), 'same operation_id replay did not return the original item result', replay)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === afterBatch, 'same operation_id replay added another revision')
  record('real MCP same operation_id replay returns original partial result', { operationId: batchId, duplicate: replay.duplicate, outcome: replay.outcome, revision: afterBatch })

  beforeBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const generatedBatchId = randomUUID()
  const generatedBatchOps = [{ op: 'add', parent: 'parent-a', text: `generated batch UID ${RUN_TOKEN}` }]
  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: generatedBatchOps, operation_id: generatedBatchId, base_revision: beforeBatch })
  const generatedBatchResult = assertToolOk('apply_nodes generated UID', result)
  const generatedBatchUid = generatedBatchResult.items && generatedBatchResult.items[0] && generatedBatchResult.items[0].result && generatedBatchResult.items[0].result.uid
  assert(generatedBatchUid && generatedBatchResult.count === 1, 'batch add without explicit UID omitted its server-generated UID', generatedBatchResult)
  const afterGeneratedBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  assert(afterGeneratedBatch === beforeBatch + 1, 'generated-UID batch did not add exactly one revision')
  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: generatedBatchOps, operation_id: generatedBatchId, base_revision: beforeBatch })
  const generatedBatchReplay = assertToolOk('apply_nodes generated UID same-ID replay', result)
  assert(generatedBatchReplay.duplicate === true && isDeepStrictEqual(generatedBatchReplay.items, generatedBatchResult.items) && generatedBatchReplay.items[0].result.uid === generatedBatchUid, 'generated-UID batch replay did not preserve the first generated UID', generatedBatchReplay)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === afterGeneratedBatch, 'generated-UID batch replay added another revision')
  record('same-ID batch replay returns the first server-generated UID without a second write', { operationId: generatedBatchId, uid: generatedBatchUid, revision: afterGeneratedBatch })

  beforeBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const invalidMoveUid = `invalid-move-first-item-${RUN_TOKEN}`
  result = await call(owner, 'apply_nodes', {
    room_key: roomKey,
    operations: [
      { op: 'add', node: invalidMoveUid, parent: 'parent-a', text: 'must not partially commit before malformed move' },
      { op: 'move', node: 'move-node' }
    ],
    operation_id: randomUUID(),
    base_revision: beforeBatch
  })
  data = assertToolError('malformed move rejects entire batch', result, 'BAD_BATCH_REQUEST')
  assert(Number(data.statusCode) === 400 && data.writeSubmitted === false, 'malformed move must be a definite pre-submit request rejection', data)
  const afterMalformedMove = await roomNodes(apiContainer.origin, ownerIdentity, [invalidMoveUid])
  assert(afterMalformedMove.version === beforeBatch && afterMalformedMove.nodes.length === 0, 'valid first item partially committed before malformed move rejection', afterMalformedMove)
  record('malformed move in a later batch item rejects the request before any item or revision', { code: data.code, statusCode: data.statusCode, writeSubmitted: data.writeSubmitted, revision: beforeBatch })

  const invalidDependencyUid = `invalid-dependency-${RUN_TOKEN}`
  result = await call(owner, 'apply_nodes', {
    room_key: roomKey,
    operations: [
      { op: 'add', node: invalidDependencyUid, parent: 'parent-a', text: 'must not commit before invalid dependency' },
      { op: 'add', parent: 'parent-a', text: 'self dependency is malformed', depends_on: [1] }
    ],
    operation_id: randomUUID(),
    base_revision: beforeBatch
  })
  data = assertToolError('invalid dependency syntax rejects entire batch', result, 'BAD_BATCH_REQUEST')
  assert(Number(data.statusCode) === 400 && data.writeSubmitted === false, 'malformed depends_on must be a definite pre-submit request rejection', data)
  const afterMalformedDependency = await roomNodes(apiContainer.origin, ownerIdentity, [invalidDependencyUid])
  assert(afterMalformedDependency.version === beforeBatch && afterMalformedDependency.nodes.length === 0, 'valid first item partially committed before malformed dependency rejection', afterMalformedDependency)
  record('self-referencing dependency syntax rejects before any batch item or revision', { code: data.code, statusCode: data.statusCode, writeSubmitted: data.writeSubmitted, revision: beforeBatch })

  beforeBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const allFailedId = randomUUID()
  const allFailedOps = [
    { op: 'update', node: `no-update-${RUN_TOKEN}`, text: 'missing' },
    { op: 'delete', node: `no-delete-${RUN_TOKEN}` }
  ]
  result = await call(owner, 'apply_nodes', {
    room_key: roomKey,
    operations: allFailedOps, operation_id: allFailedId, base_revision: beforeBatch
  })
  data = assertToolError('all-failed apply_nodes', result)
  assert(data.outcome === 'all_failed' && Array.isArray(data.items) && data.items.length === 2 && data.items.every(item => item.status === 'failed'), 'all_failed response lost result structure or item failures', data)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === beforeBatch, 'all-failed batch added a revision')
  const firstAllFailed = data
  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: allFailedOps, operation_id: allFailedId, base_revision: beforeBatch })
  data = assertToolError('all-failed apply_nodes same operation_id retry', result)
  assert(data.duplicate === true && data.operationId === allFailedId && isDeepStrictEqual(data.items, firstAllFailed.items), 'same all-failed operation_id did not return its durable original receipt', data)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === beforeBatch, 'same all-failed operation_id replay changed room revision')
  const sameAllFailedRetry = data
  const newAllFailedId = randomUUID()
  result = await call(owner, 'apply_nodes', { room_key: roomKey, operations: allFailedOps, operation_id: newAllFailedId, base_revision: beforeBatch })
  data = assertToolError('all-failed apply_nodes new operation_id retry', result)
  assert(data.operationId === newAllFailedId && data.duplicate !== true && data.outcome === 'all_failed', 'new all-failed operation_id did not execute as a fresh request', data)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === beforeBatch, 'new all-failed request added a revision despite no item applying')
  record('all-failed batch returns its durable receipt for same ID and reruns with a new ID', { operationId: allFailedId, duplicateRetry: { duplicate: sameAllFailedRetry.duplicate, operationId: sameAllFailedRetry.operationId }, newOperationId: data.operationId, items: firstAllFailed.items, revision: beforeBatch })

  beforeBatch = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const implicitUid = 'parent-a'
  result = await call(owner, 'apply_nodes', {
    room_key: roomKey,
    operations: [
      { op: 'add', node: implicitUid, parent: 'root', text: 'duplicate parent uid' },
      { op: 'add', node: `implicit-child-${RUN_TOKEN}`, parent: implicitUid, text: 'must not run' }
    ], operation_id: randomUUID(), base_revision: beforeBatch
  })
  data = assertToolError('implicit dependency batch', result)
  assert(data.outcome === 'all_failed' && data.items[0].status === 'failed' && data.items[1].status === 'dependency_failed' && data.items[1].code === 'MCP_BATCH_DEPENDENCY_FAILED', 'implicit UID dependency was not enforced', data)
  assert((await roomNodes(apiContainer.origin, ownerIdentity)).version === beforeBatch, 'all-failed implicit dependency batch added a revision')
  record('implicit parent UID dependency fails closed', { items: data.items, revision: beforeBatch })

  const addVersion = await call(owner, 'create_version', { room_key: roomKey, name: `HTTP contract ${RUN_TOKEN}`, description: 'restore-base acceptance target' })
  const versionData = assertToolOk('create_version', addVersion)
  const targetVersionId = versionData.version && versionData.version.versionId
  assert(targetVersionId, 'create_version omitted version id', versionData)
  const versionDetails = await call(owner, 'get_version', { room_key: roomKey, version_id: targetVersionId })
  const versionDetailData = assertToolOk('get_version', versionDetails)
  assert(versionDetailData.version && versionDetailData.version.versionId === targetVersionId, 'get_version did not return created version', versionDetailData)
  const restoreBase = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const restoreExpectedTree = await roomTree(apiContainer.origin, ownerIdentity)
  assert(restoreExpectedTree.version === restoreBase, 'restore target snapshot changed while capturing expected state')
  assert(restoreExpectedTree.nodes.some(node => node.uid === batchAddedUid), 'restore target does not include successful partial-batch insertion')
  result = await call(owner, 'add_node', { room_key: roomKey, text: 'post-version marker', parent: 'parent-a', operation_id: randomUUID(), base_revision: restoreBase })
  assertToolOk('pre-restore add', result)
  const beforeRestore = (await call(owner, 'list_versions', { room_key: roomKey })).data
  const currentRevision = Number(beforeRestore.currentRevision)
  assert(Number.isSafeInteger(currentRevision) && currentRevision > restoreBase, 'list_versions did not expose currentRevision after write', beforeRestore)
  result = await call(owner, 'restore_version', { room_key: roomKey, version_id: targetVersionId, expected_current_revision: currentRevision, confirm: true })
  const restored = assertToolOk('restore_version', result)
  const restoredTree = await roomTree(apiContainer.origin, ownerIdentity)
  const postRestoreRevision = restoredTree.version
  assert(postRestoreRevision > currentRevision && restored.newRevision === postRestoreRevision, 'restore_version revision did not advance as expected', { currentRevision, restored, postRestoreRevision })
  const comparableNodes = nodes => (nodes || []).map(node => ({
    uid: node.uid,
    parent_uid: node.parent_uid == null ? null : node.parent_uid,
    data: node.data || {},
    children: Array.isArray(node.children) ? node.children : []
  })).sort((left, right) => String(left.uid).localeCompare(String(right.uid)))
  assert(isDeepStrictEqual(comparableNodes(restoredTree.nodes), comparableNodes(restoreExpectedTree.nodes)), 'restore_version did not reproduce the target revision tree, including successful partial-batch items', {
    expected: comparableNodes(restoreExpectedTree.nodes),
    actual: comparableNodes(restoredTree.nodes)
  })
  assert(restoredTree.nodes.some(node => node.uid === batchAddedUid && node.data.text === 'batch add success'), 'restore_version lost the exact committed batch UID or replayed a failed batch item', restoredTree.nodes.filter(node => node.uid === batchAddedUid))
  record('restore_version replays partial-batch events to the target tree over real HTTP/MCP', { targetRevision: restoreBase, restoredRevision: postRestoreRevision, nodeCount: restoredTree.nodes.length, batchAddedUid })
  result = await call(owner, 'add_node', { room_key: roomKey, text: 'stale base must reject', parent: 'parent-a', operation_id: randomUUID(), base_revision: restoreBase })
  data = assertToolError('write with pre-restore base_revision', result, 'STALE_AFTER_VERSION_RESTORE')
  record('restore epoch rejects old base_revision through real MCP', { restoreBase, currentRevision, postRestoreRevision, code: data.code, returnedBaseRevision: data.base_revision })

  const retryBaseTree = await roomNodes(apiContainer.origin, ownerIdentity)
  const retryBaseRevision = retryBaseTree.version
  const retryTargetResult = await call(owner, 'create_version', { room_key: roomKey, name: `Retry restore boundary ${RUN_TOKEN}`, description: 'fault-injected retry target' })
  const retryTargetData = assertToolOk('create retry-boundary target version', retryTargetResult)
  const retryTargetVersionId = retryTargetData.version && retryTargetData.version.versionId
  assert(retryTargetVersionId, 'retry-boundary target version omitted version id', retryTargetData)

  await faultProxyControl('reset', {})
  const pinnedRetryId = randomUUID()
  const pinnedRetryText = `must retain original payload and base through retry ${RUN_TOKEN}`
  await faultProxyControl('arm', { operationId: pinnedRetryId, mode: 'precommit_then_hold_retry' })
  const pinnedRetryPromise = call(owner, 'add_node', {
    room_key: roomKey,
    text: pinnedRetryText,
    parent: 'parent-a',
    operation_id: pinnedRetryId,
    base_revision: retryBaseRevision
  })
  const pinnedAttemptsBeforeRelease = await waitForProxyAttempts(
    pinnedRetryId,
    rows => rows.some(row => row.attempt === 1 && row.requestNotForwarded) &&
      rows.some(row => row.attempt === 2 && row.retryHeldUntilRestore)
  )
  assert(pinnedAttemptsBeforeRelease.length === 2, 'pre-commit fault did not produce exactly two retry attempts before release', pinnedAttemptsBeforeRelease)
  assert(pinnedAttemptsBeforeRelease[0].requestText === pinnedAttemptsBeforeRelease[1].requestText, 'automatic retry changed write content or baseVersion', pinnedAttemptsBeforeRelease)
  assert(pinnedAttemptsBeforeRelease.every(row => row.operationHeaderId === pinnedRetryId && row.requestBody.operation_id === pinnedRetryId && Number(row.requestBody.baseVersion) === retryBaseRevision), 'automatic retry changed operation_id or pinned baseVersion', pinnedAttemptsBeforeRelease)
  const directRestore = await restoreVersionDirect(apiContainer.origin, ownerIdentity, roomKey, retryTargetVersionId, retryBaseRevision)
  assert(Number(directRestore.newRevision) > retryBaseRevision, 'fault-injected retry restore did not advance room revision', directRestore)
  await faultProxyControl('release', {})
  result = await pinnedRetryPromise
  data = assertToolError('automatic retry after unsubmitted attempt and intervening restore', result, 'STALE_AFTER_VERSION_RESTORE')
  assert(data.outcomeUnknown === true && data.outcome === 'unknown' && data.writeSubmitted === true && Number(data.base_revision) === retryBaseRevision && data.operation_id === pinnedRetryId, 'unknown first attempt followed by stale rejection lost pinned outcome metadata', data)
  const pinnedAttempts = await waitForProxyAttempts(pinnedRetryId, rows => rows.length === 2 && !!rows[1].backend)
  assert(pinnedAttempts[1].backend.statusCode === 409 && /STALE_AFTER_VERSION_RESTORE/.test(pinnedAttempts[1].backend.body), 'second retry did not reach the server with the original stale base', pinnedAttempts)
  const afterPinnedRetry = await roomNodes(apiContainer.origin, ownerIdentity)
  const pinnedRetryNodeExists = await roomNodeExistsByText(apiContainer.origin, ownerIdentity, pinnedRetryText)
  assert(!pinnedRetryNodeExists && afterPinnedRetry.version === Number(directRestore.newRevision), 'unsubmitted write was applied or retry changed restore revision', { pinnedRetryNodeExists, afterPinnedRetry })
  record('automatic retry keeps ID/content/baseVersion; an intervening restore makes the retry stale while preserving outcomeUnknown', { operationId: pinnedRetryId, baseVersion: retryBaseRevision, restoredRevision: directRestore.newRevision, attempts: pinnedAttempts.map(row => ({ attempt: row.attempt, operationHeaderId: row.operationHeaderId, baseVersion: row.requestBody && row.requestBody.baseVersion, requestNotForwarded: row.requestNotForwarded, retryHeldUntilRestore: row.retryHeldUntilRestore, backend: row.backend })) })

  await faultProxyControl('reset', {})
  const ackBaseRevision = (await roomNodes(apiContainer.origin, ownerIdentity)).version
  const ackLossId = randomUUID()
  await faultProxyControl('arm', { operationId: ackLossId, mode: 'commit_then_drop_ack' })
  result = await call(owner, 'add_node', {
    room_key: roomKey,
    text: 'single commit despite lost acknowledgement',
    parent: 'parent-a',
    operation_id: ackLossId,
    base_revision: ackBaseRevision
  })
  data = assertToolOk('automatic same-ID retry after committed response loss', result)
  assert(data.duplicate === true && data.operationId === ackLossId, 'lost-ACK retry did not return the original committed receipt', data)
  const ackAttempts = await waitForProxyAttempts(ackLossId, rows => rows.length === 2 && !!rows[1].backend)
  assert(ackAttempts[0].responseDroppedAfterCommit === true && ackAttempts[0].backend && ackAttempts[0].backend.statusCode === 200, 'first ACK-loss attempt was not committed before its response was dropped', ackAttempts)
  assert(ackAttempts[1].backend && JSON.parse(ackAttempts[1].backend.body).duplicate === true, 'second same-ID submission did not return the durable duplicate receipt', ackAttempts)
  assert(ackAttempts[0].requestText === ackAttempts[1].requestText && ackAttempts.every(row => row.operationHeaderId === ackLossId && Number(row.requestBody.baseVersion) === ackBaseRevision), 'ACK-loss retry changed operation ID, content, or baseVersion', ackAttempts)
  const ackLossResult = await roomNodes(apiContainer.origin, ownerIdentity, [data.uid])
  const ackLossNodes = ackLossResult.nodes.filter(node => node.uid === data.uid)
  assert(ackLossResult.version === ackBaseRevision + 1 && data.uid && ackLossNodes.length === 1 && ackLossNodes[0].data.text === 'single commit despite lost acknowledgement', 'lost-ACK retry did not apply the write exactly once', ackLossResult)
  record('committed write with dropped ACK retries using the same ID and advances one revision only', { operationId: ackLossId, baseVersion: ackBaseRevision, finalVersion: ackLossResult.version, attempts: ackAttempts.map(row => ({ attempt: row.attempt, operationHeaderId: row.operationHeaderId, baseVersion: row.requestBody && row.requestBody.baseVersion, responseDroppedAfterCommit: row.responseDroppedAfterCommit, backend: row.backend })) })

  const member = await addMember(apiContainer.origin, ownerIdentity, viewerIdentity.userId, 'viewer')
  result = await call(viewerClient.client, 'add_node', { room_key: roomKey, text: 'viewer must not write', parent: 'root', operation_id: randomUUID() })
  data = assertToolError('viewer write permission', result)
  assert(Number(data.statusCode) === 403 || data.code === 'FORBIDDEN' || data.code === 'ROOM_READ_ONLY', 'viewer denial was not an ACL denial', data)
  record('viewer MCP JWT cannot write owner room', { userId: viewerIdentity.userId, role: member.role, code: data.code, statusCode: data.statusCode })

  const proofFaultId = randomUUID()
  const proofFaultCursor = (await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)).cursor
  const dbPool = new (pgModule().Pool)({ ...PG, database: DB_NAME, max: 1, connectionTimeoutMillis: 5000 })
  const faultColumn = `uid_proof_fault_${RUN_TOKEN}`
  let uidColumnRenamed = false
  try {
    const existingFaultColumn = await dbPool.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'room_nodes' and column_name = $1`,
      [faultColumn]
    )
    assert(existingFaultColumn.rowCount === 0, 'UID proof fault column already exists')
    const uidColumn = await dbPool.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'room_nodes' and column_name = 'uid'`
    )
    assert(uidColumn.rowCount === 1, 'isolated room_nodes.uid is unavailable before SQL fault injection')
    // Keep room_nodes present so the MCP base-revision and room-meta reads pass;
    // only the Direct UID-proof SELECT should fail on the missing uid column.
    await dbPool.query(`ALTER TABLE public.room_nodes RENAME COLUMN uid TO ${faultColumn}`)
    uidColumnRenamed = true
    result = await call(owner, 'update_node', {
      room_key: roomKey,
      node: addedUid,
      text: 'UID proof SQL failure must not fall back',
      operation_id: proofFaultId
    })
    data = assertToolError('UID proof SQL fault fails closed', result, 'MCP_DIRECT_REFERENCE_UNAVAILABLE')
    assert(Number(data.statusCode) === 503,
      'UID proof SQL error was not reported as a fail-closed 503', data)
    const proofFaultDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, proofFaultCursor)
    const proofFaultWrite = (proofFaultDiagnostics.events || []).find(event =>
      event.kind === 'mcp-write' && event.operationId === proofFaultId
    )
    assert(proofFaultWrite && proofFaultWrite.stage === 'reject' && proofFaultWrite.code === 'MCP_DIRECT_REFERENCE_UNAVAILABLE' &&
      proofFaultWrite.fallbackReason === 'uid_proof_query_failed', 'UID proof SQL failure diagnostic is missing or allowed fallback', proofFaultDiagnostics.events)
    const proofFaultFullPath = (proofFaultDiagnostics.events || []).filter(event =>
      event.source === 'mcp' && event.path === 'full' && ['pool', 'lock-query', 'transaction'].includes(event.kind)
    )
    assert(proofFaultFullPath.length === 0, 'UID proof SQL failure entered full-tree path', proofFaultFullPath)
    record('real PostgreSQL UID-proof query failure returns 503 and never falls back to full write', {
      operationId: proofFaultId,
      code: data.code,
      statusCode: data.statusCode,
      fallbackReason: proofFaultWrite.fallbackReason,
      fullPathCount: proofFaultFullPath.length
    })
  } finally {
    if (uidColumnRenamed) await dbPool.query(`ALTER TABLE public.room_nodes RENAME COLUMN ${faultColumn} TO uid`)
    await dbPool.end()
  }
  const proofFaultNode = await roomNodes(apiContainer.origin, ownerIdentity, [addedUid])
  assert(proofFaultNode.nodes.length === 1 && proofFaultNode.nodes[0].data.text === 'Updated via MCP',
    'failed UID proof SQL request changed node content after table recovery', proofFaultNode.nodes)

  return {
    room: roomKey, seed: seeded,
    owner: ownerIdentity.userId,
    tests: checks.slice(),
    endingRevision: (await roomNodes(apiContainer.origin, ownerIdentity)).version
  }
}

async function exportFileFingerprint(absolutePath, exportPath) {
  const normalizedAbsolutePath = typeof absolutePath === 'string'
    ? path.posix.normalize(absolutePath)
    : ''
  const relativeExportPath = typeof exportPath === 'string'
    ? exportPath.replace(/\\/g, '/')
    : ''
  assert(
    path.posix.isAbsolute(normalizedAbsolutePath) &&
      relativeExportPath.startsWith('.tmp/mindmap-exports/') &&
      !relativeExportPath.split('/').some(part => part === '.' || part === '..') &&
      normalizedAbsolutePath.endsWith(`/${relativeExportPath}`),
    'export_room_tree returned an unexpected file path',
    { absolutePath, exportPath }
  )
  const script = `const fs=require('fs'),crypto=require('crypto');const p=${JSON.stringify(normalizedAbsolutePath)};const s=fs.statSync(p,{bigint:true});console.log(JSON.stringify({size:Number(s.size),mtimeNs:s.mtimeNs.toString(),sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))`
  return JSON.parse(docker(['exec', apiContainer.name, 'node', '-e', script]).trim())
}

async function runFocusedContract() {
  ownerIdentity = await createIdentity(apiContainer.origin, `mcp-http-owner-${RUN_TOKEN}`)
  const seeded = await seedRoom(apiContainer.origin, ownerIdentity)
  ownerClient = await createMcpClient(ownerIdentity, MCP_TOKEN)
  const owner = ownerClient.client
  const roomKey = seeded.roomKey

  const attachmentName = `mcp-http-${RUN_TOKEN}.txt`
  const attachmentBytes = Buffer.from(`isolated MCP attachment HTTP proof ${RUN_ID}\n`, 'utf8')
  const uploadResult = await call(owner, 'upload_attachment', {
    room_key: roomKey,
    node: 'move-node',
    file_name: attachmentName,
    mime_type: 'text/plain',
    content_base64: attachmentBytes.toString('base64')
  })
  let uploaded = null
  if (uploadResult.isError) {
    const failureData = uploadResult.data || {}
    const uploadDetails = failureData.details || {}
    let nodeReadback = null
    let diagnostics = null
    let persistedRows = null
    let proxyTraffic = null
    try { nodeReadback = await roomNodes(apiContainer.origin, ownerIdentity, ['move-node']) } catch (error) { nodeReadback = { error: error.message } }
    try { diagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey) } catch (error) { diagnostics = { error: error.message } }
    try {
      const state = await faultProxyControl('state')
      proxyTraffic = (state.attempts || []).filter(row =>
        row.operationId === uploadDetails.operation_id ||
        (row.method === 'PATCH' && row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes/move-node`) ||
        (row.method === 'GET' && row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes?uids=move-node`)
      )
    } catch (error) { proxyTraffic = { error: error.message } }
    try {
      const pool = new (pgModule().Pool)({ ...PG, database: DB_NAME, max: 1, connectionTimeoutMillis: 4000 })
      try {
        const [operationRows, nodeRows, roomVersionRows] = await Promise.all([
          pool.query('select to_jsonb(o) as row from public.room_operations o where room_key=$1 and operation_id=$2', [roomKey, uploadDetails.operation_id || '']),
          pool.query('select to_jsonb(n) as row from public.room_nodes n where room_key=$1 and uid=$2', [roomKey, 'move-node']),
          pool.query('select version, updated_at from public.rooms where room_key=$1', [roomKey])
        ])
        persistedRows = {
          operation: operationRows.rows[0] && operationRows.rows[0].row,
          node: nodeRows.rows[0] && nodeRows.rows[0].row,
          room: roomVersionRows.rows[0] || null
        }
      } finally { await pool.end() }
    } catch (error) { persistedRows = { error: error.message } }
    const detail = {
      mcpError: failureData,
      proxiedRequestAndBackendResponse: (Array.isArray(proxyTraffic) ? proxyTraffic : []).map(row => ({
        ...row,
        backendBody: (() => {
          try { return row.backend && JSON.parse(row.backend.body) } catch (_) { return row.backend && row.backend.body }
        })()
      })),
      proxyCaptureError: !Array.isArray(proxyTraffic) && proxyTraffic ? proxyTraffic.error : null,
      nodeReadback,
      operation: persistedRows && persistedRows.operation,
      roomNode: persistedRows && persistedRows.node,
      relevantDiagnostics: (diagnostics && diagnostics.events || []).filter(event =>
        event.operationId === uploadDetails.operation_id ||
        (event.kind === 'http' && event.mcpTool && ['upload_attachment', 'update_node'].includes(event.mcpTool))
      )
    }
    checks.push({ name: 'real MCP attachment upload, mount, and stable-field read-back', status: 'fail', details: detail })
  } else {
    uploaded = assertToolOk('upload_attachment', uploadResult)
    assert(uploaded.persistence_verified === true, 'upload_attachment did not confirm node-field persistence', uploaded)
    assert(uploaded.attachment && uploaded.attachment.id, 'upload_attachment omitted stable attachment identity', uploaded)
    const attachmentId = String(uploaded.attachment.id)
    const attachedNode = await roomNodes(apiContainer.origin, ownerIdentity, ['move-node'])
    assert(attachedNode.nodes.length === 1, 'attachment read-back did not return target node', attachedNode)
    const attachmentData = attachedNode.nodes[0].data || {}
    assert(
      attachmentData.attachmentId === attachmentId &&
        attachmentData.attachmentName === attachmentName &&
        typeof attachmentData.attachmentUrl === 'string' &&
        typeof attachmentData.attachmentMimeType === 'string' &&
        ['pending', 'processing', 'ready', 'failed'].includes(String(attachmentData.attachmentStatus || '').toLowerCase()),
      'attachment stable fields did not survive an independent node read-back',
      { attachmentId, attachmentData }
    )
    const listed = assertToolOk('list_attachments', await call(owner, 'list_attachments', {
      room_key: roomKey,
      node_uid: 'move-node',
      limit: 20
    }))
    const listedItems = Array.isArray(listed.items) ? listed.items : Array.isArray(listed.attachments) ? listed.attachments : []
    assert(listedItems.some(item => String(item.id || item.attachmentId) === attachmentId), 'list_attachments did not return the uploaded attachment', listed)
    const proxyState = await faultProxyControl('state')
    const helperTraffic = (proxyState.attempts || []).filter(row =>
      row.path === `/api/files/${encodeURIComponent(roomKey)}/attachments` ||
      row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes/move-node` ||
      row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes?uids=move-node`
    )
    const helperReadback = helperTraffic.find(row =>
      row.method === 'GET' && row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes?uids=move-node`
    )
    const helperMount = helperTraffic.find(row =>
      row.method === 'PATCH' && row.path === `/api/files/${encodeURIComponent(roomKey)}/nodes/move-node`
    )
    assert(helperReadback && helperReadback.backend && helperReadback.backend.statusCode === 200,
      'attachment helper did not make a successful authoritative read-back request', helperTraffic)
    const helperReadbackBody = JSON.parse(helperReadback.backend.body)
    const helperReadbackNode = Array.isArray(helperReadbackBody.nodes)
      ? helperReadbackBody.nodes.find(node => node && node.uid === 'move-node')
      : helperReadbackBody.nodes && helperReadbackBody.nodes['move-node']
    assert(Number(helperReadbackBody.version) > Number(seeded.seedRevision),
      'attachment helper read-back did not observe the committed room revision', { helperReadbackBody, helperMount })
    assert(helperReadbackNode && helperReadbackNode.data && helperReadbackNode.data.attachmentId === attachmentId,
      'first attachment helper read-back body omitted the committed attachment identity', { helperReadbackBody, helperMount })
    assert(helperMount && helperMount.backend && helperMount.backend.statusCode === 200,
      'attachment helper PATCH did not return a successful commit', helperMount)
    const helperMountBody = JSON.parse(helperMount.backend.body)
    assert(Number(helperReadbackBody.version) === Number(helperMountBody.version),
      'attachment read-back version did not match the successful PATCH commit version', { helperReadbackBody, helperMountBody })
    const versionPool = new (pgModule().Pool)({ ...PG, database: DB_NAME, max: 1, connectionTimeoutMillis: 4000 })
    let sqlVersionEvidence
    try {
      const sqlVersion = await versionPool.query(
        `select r.version as room_version, n.node_version, n.data->>'attachmentId' as attachment_id
         from public.rooms r join public.room_nodes n on n.room_key = r.room_key
         where r.room_key = $1 and n.uid = $2`,
        [roomKey, 'move-node']
      )
      sqlVersionEvidence = sqlVersion.rows[0] || null
    } finally { await versionPool.end() }
    assert(sqlVersionEvidence && Number(sqlVersionEvidence.room_version) === Number(helperReadbackBody.version) &&
      Number(sqlVersionEvidence.node_version) === Number(helperReadbackBody.version) &&
      sqlVersionEvidence.attachment_id === attachmentId,
    'first helper read-back did not agree with committed PostgreSQL room/node versions', {
      sqlVersionEvidence, helperReadbackBody, helperMountBody
    })
    record('real MCP attachment upload, mount, and stable-field read-back', {
      attachmentId,
      nodeUid: 'move-node',
      fileName: attachmentName,
      size: attachmentBytes.length,
      mimeType: attachmentData.attachmentMimeType,
      status: attachmentData.attachmentStatus,
      persistenceVerified: uploaded.persistence_verified,
      listReturnedAttachment: true,
      uploadPostCount: helperTraffic.filter(row => row.method === 'POST').length,
      mountPatchCount: helperTraffic.filter(row => row.method === 'PATCH').length,
      helperReadbackVersion: helperReadbackBody.version,
      helperReadbackNodeUid: helperReadbackNode.uid,
      helperReadbackStableFields: {
        attachmentId: helperReadbackNode.data.attachmentId,
        attachmentName: helperReadbackNode.data.attachmentName,
        attachmentMimeType: helperReadbackNode.data.attachmentMimeType,
        attachmentStatus: helperReadbackNode.data.attachmentStatus,
        fieldVersion: helperReadbackNode.data.__fv && helperReadbackNode.data.__fv.attachment
      },
      sqlVersionEvidence,
      firstHelperGetBody: helperReadback.backend.body
    })
  }

  const importedCount = 501
  const bulkChildren = Array.from({ length: importedCount - 3 }, (_, index) => ({
    data: { uid: `bulk-${String(index).padStart(4, '0')}`, text: `Imported node ${index}`, expand: true },
    children: []
  }))
  const importedTree = {
    data: { uid: 'root', text: 'Imported Root', expand: true },
    children: [
      {
        data: { uid: 'deep-parent', text: 'Deep Parent', expand: true },
        children: [{ data: { uid: 'legacy-path-target', text: 'Legacy Path Target', expand: true }, children: [] }]
      },
      ...bulkChildren
    ]
  }
  const replace = assertToolOk('replace_tree', await call(owner, 'replace_tree', {
    room_key: roomKey,
    title: 'Isolated full-map import contract',
    tree: importedTree,
    confirm_sop_change: true
  }))
  const importedPage = await roomNodes(apiContainer.origin, ownerIdentity, ['root', 'deep-parent', 'legacy-path-target', 'bulk-0000'])
  assert(Number(importedPage.totalNodeCount || importedPage.nodeCount || importedPage.nodes.length) >= 4, 'replace_tree did not persist imported nodes', importedPage)
  assert(Number(importedPage.version) > Number(seeded.seedRevision), 'replace_tree did not advance isolated room revision', { seeded, importedPage })
  record('MCP replace_tree imports a full nested map into the isolated HTTP room', {
    expectedNodeCount: importedCount,
    sampledUids: importedPage.nodes.map(node => node.uid),
    version: importedPage.version,
    result: replace
  })

  const hintQueryArgs = {
    room_key: roomKey,
    selector: { type: 'uid', value: 'legacy-path-target' },
    scope: 'self'
  }
  const legacyHintRead = assertToolOk('query_nodes', await call(owner, 'query_nodes', hintQueryArgs))
  const legacyHintNode = (legacyHintRead.items || []).find(item => item && item.uid === 'legacy-path-target')
  assert(legacyHintNode, 'default query_nodes did not return the isolated target', legacyHintRead)
  assert(!Object.prototype.hasOwnProperty.call(legacyHintNode, 'write_hints'),
    'default query_nodes unexpectedly returned opt-in write hints', legacyHintNode)

  const hintRead = assertToolOk('query_nodes', await call(owner, 'query_nodes', {
    ...hintQueryArgs,
    include_write_hints: true
  }))
  const hintNode = (hintRead.items || []).find(item => item && item.uid === 'legacy-path-target')
  const updateHints = hintNode && hintNode.write_hints && hintNode.write_hints.update
  assert(hintNode && updateHints, 'include_write_hints query omitted update hints', hintRead)
  const targetFieldVersions = (hintNode.data && hintNode.data.__fv) || {}
  for (const group of ['text', 'note', 'hyperlink']) {
    const key = `__fv.${group}`
    const expectedVersion = Number(targetFieldVersions[group] ?? 0)
    const expectedHint = { uid: 'legacy-path-target', [key]: expectedVersion }
    assert(isDeepStrictEqual(updateHints[group], expectedHint),
      `query_nodes write hint ${group} did not preserve the flat expected key`, { hint: updateHints[group], expectedHint })
  }
  record('query_nodes write hints are opt-in and provide flat per-field expected values', {
    roomVersion: hintRead.version,
    uid: hintNode.uid,
    updateHints
  })

  const pathResult = assertToolOk('update_node', await call(owner, 'update_node', {
    room_key: roomKey,
    node: 'Imported Root/Deep Parent/Legacy Path Target',
    text: 'Legacy Path Updated',
    expected: updateHints.text,
    operation_id: randomUUID()
  }))
  assert(pathResult.submissionPath === 'legacy', 'complex path compatibility did not use its explicit legacy route', pathResult)
  const pathRead = assertToolOk('query_nodes', await call(owner, 'query_nodes', {
    room_key: roomKey,
    selector: { type: 'path', segments: ['Imported Root', 'Deep Parent', 'Legacy Path Updated'], match: 'exact' },
    scope: 'path',
    page_size: 2
  }))
  const pathNodes = [...(pathRead.items || [])]
  let pathPages = 1
  let pathHasMore = pathRead.has_more === true
  let pathCursor = pathRead.next_cursor || null
  while (pathHasMore && pathPages < 5) {
    assert(pathCursor, 'path query has_more without next_cursor', pathRead)
    const nextPage = assertToolOk('query_nodes', await call(owner, 'query_nodes', {
      room_key: roomKey,
      selector: { type: 'path', segments: ['Imported Root', 'Deep Parent', 'Legacy Path Updated'], match: 'exact' },
      scope: 'path',
      page_size: 2,
      cursor: pathCursor
    }))
    pathPages += 1
    pathNodes.push(...(nextPage.items || []))
    pathCursor = nextPage.next_cursor || null
    pathHasMore = nextPage.has_more === true
  }
  assert(!pathHasMore, 'path query pagination did not terminate', { pathPages, pathCursor })
  assert(pathNodes.length === 3 && pathNodes.some(node => node.data && node.data.text === 'Legacy Path Updated'), 'query_nodes path selector did not locate the imported target', { pathPages, pathNodes })

  const queryAll = []
  let cursor = null
  let pageCount = 0
  let hasMore = true
  const seenQueryCursors = new Set()
  const queryPageTrace = []
  while (hasMore && pageCount < 32) {
    const page = assertToolOk('query_nodes', await call(owner, 'query_nodes', {
      room_key: roomKey,
      selector: { type: 'uid', value: 'root' },
      scope: 'subtree',
      page_size: 125,
      ...(cursor ? { cursor } : {})
    }))
    pageCount += 1
    queryAll.push(...(page.items || []))
    hasMore = page.has_more === true
    const nextCursor = page.next_cursor || null
    queryPageTrace.push({
      page: pageCount,
      itemCount: (page.items || []).length,
      hasMore,
      cursorPresent: !!nextCursor,
      version: page.version
    })
    if (hasMore) {
      assert(nextCursor, 'query_nodes has_more without next_cursor', page)
      assert(!seenQueryCursors.has(nextCursor), 'query_nodes pagination repeated a cursor', { pageCount, queryPageTrace })
      seenQueryCursors.add(nextCursor)
    }
    cursor = nextCursor
  }
  const uniqueQueriedUids = new Set(queryAll.map(node => String(node.uid || (node.data && node.data.uid) || '')))
  assert(!hasMore && pageCount > 1 && uniqueQueriedUids.size === importedCount, 'query_nodes pagination omitted, duplicated, or failed to terminate across the imported tree', {
    pageCount,
    returnedCount: queryAll.length,
    uniqueCount: uniqueQueriedUids.size,
    expectedCount: importedCount,
    queryPageTrace
  })
  record('query_nodes locates a complex path and paginates the imported tree without loss', {
    pathPages,
    subtreePages: pageCount,
    returnedCount: queryAll.length,
    uniqueCount: uniqueQueriedUids.size,
    expectedCount: importedCount,
    queryPageTrace,
    pathSubmissionPath: pathResult.submissionPath
  })

  const diagnosticsBefore = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey)
  const diagnosticsCursor = Math.max(0, ...(diagnosticsBefore.events || []).map(event => Number(event.seq) || 0))
  const exported = assertToolOk('export_room_tree', await call(owner, 'export_room_tree', {
    room_key: roomKey,
    include_notes: true,
    include_references: true,
    format: 'json'
  }))
  assert(exported.delivery === 'file' && exported.complete === true && exported.exported_node_count === importedCount, 'export_room_tree did not produce a complete file-backed export for >500 nodes', exported)
  const fileBeforePages = await exportFileFingerprint(exported.export_absolute_path, exported.export_path)
  const exportPages = []
  let exportOffset = 0
  let exportHasMore = true
  let exportPageCount = 0
  while (exportHasMore && exportPageCount < 10) {
    const page = assertToolOk('read_room_export', await call(owner, 'read_room_export', {
      room_key: roomKey,
      revision: exported.revision,
      offset: exportOffset,
      limit: 200,
      format: 'json'
    }))
    exportPageCount += 1
    assert(page.export_path === exported.export_path && page.read_path === 'export_file' && page.complete === true, 'read_room_export did not page the existing complete export file', page)
    exportPages.push(...(page.nodes || []))
    exportHasMore = page.has_more === true
    exportOffset = page.next_offset == null ? exportOffset + (page.nodes || []).length : page.next_offset
  }
  assert(!exportHasMore && exportPageCount > 1 && exportPages.length === importedCount, 'read_room_export pagination was incomplete', { exportPageCount, exportedNodes: exportPages.length, expected: importedCount })
  const fileAfterPages = await exportFileFingerprint(exported.export_absolute_path, exported.export_path)
  assert(isDeepStrictEqual(fileBeforePages, fileAfterPages), 'read_room_export rewrote or changed the existing export file while paging', { fileBeforePages, fileAfterPages })
  const exportDiagnostics = await performanceDiagnostics(apiContainer.origin, ownerIdentity, roomKey, diagnosticsCursor)
  const exportHttpEvents = (exportDiagnostics.events || []).filter(event => event.kind === 'http' && event.route === '/api/files/:room/export-tree')
  const exportPosts = exportHttpEvents.filter(event => event.method === 'POST' && event.mcpTool === 'export_room_tree')
  const exportGets = exportHttpEvents.filter(event => event.method === 'GET' && event.mcpTool === 'read_room_export')
  assert(exportPosts.length === 1 && exportGets.length === exportPageCount, 'export/read HTTP trace shows duplicate full exports or missing file-page reads', { exportPosts, exportGets, exportPageCount, exportHttpEvents })
  record('one full export is paged from the same file without a second export traversal', {
    exportPath: exported.export_path,
    exportAbsolutePath: exported.export_absolute_path,
    revision: exported.revision,
    exportedNodeCount: exported.exported_node_count,
    readPageCount: exportPageCount,
    fileFingerprintUnchanged: isDeepStrictEqual(fileBeforePages, fileAfterPages),
    exportPostCount: exportPosts.length,
    fileReadGetCount: exportGets.length
  })

  return {
    room: roomKey,
    seed: seeded,
    owner: ownerIdentity.userId,
    tests: checks.slice(),
    endingRevision: (await roomNodes(apiContainer.origin, ownerIdentity, ['root'])).version
  }
}

async function cleanupContainers() {
  const results = []
  for (const [name, owner] of [...dockerOwned.entries()].reverse()) {
    const role = owner.role
    const runLabel = docker(['inspect', '--format', '{{index .Config.Labels "codex.mcp-writer-http-run"}}', name]).trim()
    const roleLabel = docker(['inspect', '--format', '{{index .Config.Labels "codex.mcp-writer-http-role"}}', name]).trim()
    assert(runLabel === RUN_ID && roleLabel === role && name.startsWith(`${CONTAINER_PREFIX}-`), `容器 marker 不匹配，拒绝清理 ${name}`)
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]).trim() === 'true'
    if (running) docker(['stop', '--time', '10', name])
    const logs = docker(['logs', name])
    fs.writeFileSync(role === 'api' ? API_LOG : role === 'proxy' ? PROXY_LOG : MCP_LOG, logs + '\n')
    docker(['rm', name])
    dockerOwned.delete(name)
    results.push({ name, role, stopped: running, removed: true, runMarkerVerified: true })
  }
  return results
}

async function cleanupDatabase() {
  if (!dbCreated) return { skipped: true }
  const pool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 4000 })
  try {
    const checkRow = await pool.query("select shobj_description(oid,'pg_database') as comment from pg_database where datname=$1", [DB_NAME])
    if (!checkRow.rowCount) return { absent: true }
    assert(checkRow.rows[0].comment === DB_MARKER, 'DB marker 不匹配，拒绝删除')
    await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [DB_NAME])
    await pool.query(`DROP DATABASE ${DB_NAME}`)
    return { dropped: true, database: DB_NAME, markerVerified: true }
  } finally { await pool.end() }
}

async function cleanupRedis() {
  if (!redisClaimed) return { skipped: true }
  const client = await connectRedis(REDIS_DB)
  try {
    const markerValue = await client.get(REDIS_MARKER)
    assert(markerValue === RUN_ID, 'Redis run marker 不匹配，拒绝清理 DB14')
    const keys = await client.keys('*')
    for (const key of keys) {
      if (key === REDIS_MARKER) continue
      if (key.startsWith(`presence:${encodeURIComponent(ROOM_KEY)}:`)) continue
      if (key === 'collab:events') {
        const entries = await client.xRange(key, '-', '+', { COUNT: 10000 })
        for (const entry of entries) {
          const raw = entry.message && (entry.message.json || entry.message.JSON)
          let event
          try { event = JSON.parse(raw || '{}') } catch (_) { event = null }
          assert(event && String(event.mapId || '').startsWith(`mcp-http-${RUN_TOKEN}`), 'Redis stream 含有非本 run 事件，拒绝 flush', { key, id: entry.id, mapId: event && event.mapId })
        }
        continue
      }
      throw new Error(`Redis DB14 出现未知 key，拒绝清理：${key}`)
    }
    await client.flushDb()
    assert(await client.dbSize() === 0, 'Redis DB14 清理后仍非空')
    return { flushedLogicalDb: REDIS_DB, removedKeys: keys.length, markerVerified: true, dbInitiallyEmpty: true }
  } finally { await client.quit().catch(() => {}) }
}

async function closeClients() {
  for (const holder of [ownerClient, viewerClient]) {
    if (holder && holder.client) {
      await holder.client.close().catch(() => {})
    }
  }
}

async function main() {
  parseArgs()
  const summary = { runId: RUN_ID, status: 'preflight', checks, createdAt: new Date().toISOString(), outputDirectory: RUN_DIR }
  let preflightResult
  try {
    preflightResult = await preflight()
    summary.preflight = preflightResult
    if (!runFlag) {
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    fs.mkdirSync(OUTPUT_RUNS, { recursive: true })
    fs.mkdirSync(RUN_DIR, { recursive: false })
    summary.sourceSnapshot = snapshotCurrentSource()
    summary.database = await createDatabase()
    const redis = await connectRedis(REDIS_DB)
    try {
      assert(await redis.dbSize() === 0, 'Redis DB14 已不为空，拒绝 claim')
      await redis.set(REDIS_MARKER, RUN_ID, { NX: true })
      assert(await redis.get(REDIS_MARKER) === RUN_ID, 'Redis DB14 run marker claim 失败')
      redisClaimed = true
    } finally { await redis.quit().catch(() => {}) }
    apiContainer = startContainer('api', `http://127.0.0.1:${API_PORT}`)
    await waitHttp(`${apiContainer.origin}/api/health`, 'collab API')
    proxyContainer = startFaultProxy()
    await waitHttp(`${proxyContainer.origin}/__control/state`, 'fault proxy')
    mcpContainer = startContainer('mcp', `http://127.0.0.1:${API_PORT}`)
    await waitHttp(`http://127.0.0.1:${MCP_PORT}/health`, 'MCP HTTP')
    summary.servicesStarted = { api: apiContainer, faultProxy: proxyContainer, mcp: mcpContainer, flags: { COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: '1', COLLAB_MCP_DIRECT: '1' }, resourceLimits: { apiAndMcpCpUsEach: 1, apiAndMcpMemoryEach: '1536m', proxy: 'test-only; no database or write logic' } }
    summary.contract = focusedFlag
      ? await runFocusedContract(apiContainer.origin)
      : await runContract(apiContainer.origin)
    const recordedFailure = focusedFlag && checks.find(item => item.status === 'fail')
    if (recordedFailure) {
      failure = new Error(`聚焦 HTTP 回归发现失败项：${recordedFailure.name}`)
      failure.details = recordedFailure.details
      summary.failure = { message: failure.message, details: failure.details }
      summary.status = 'fail'
    } else {
      summary.status = 'pass'
    }
  } catch (error) {
    failure = error
    summary.status = 'fail'
    summary.failure = { message: error.message, details: error.details || null, stack: error.stack }
  } finally {
    try { await closeClients() } catch (error) { summary.cleanupClientError = error.message }
    try { summary.cleanupContainers = await cleanupContainers() } catch (error) { summary.cleanupContainerError = error.message }
    try { summary.cleanupDatabase = await cleanupDatabase() } catch (error) { summary.cleanupDatabaseError = error.message }
    try { summary.cleanupRedis = await cleanupRedis() } catch (error) { summary.cleanupRedisError = error.message }
    summary.completedAt = new Date().toISOString()
    if (runFlag && fs.existsSync(RUN_DIR)) {
      fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n')
    }
  }
  console.log(JSON.stringify({ runId: RUN_ID, status: summary.status, summary: runFlag ? SUMMARY_FILE : null, failedCheck: failure && failure.message, checks: summary.contract ? summary.contract.tests : checks, cleanup: { containers: summary.cleanupContainers, database: summary.cleanupDatabase, redis: summary.cleanupRedis, errors: [summary.cleanupContainerError, summary.cleanupDatabaseError, summary.cleanupRedisError].filter(Boolean) } }, null, 2))
  if (failure) process.exitCode = 1
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
