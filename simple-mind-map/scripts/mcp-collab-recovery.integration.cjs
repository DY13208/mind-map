'use strict'

// Focused real-service collaboration recovery acceptance. A default invocation
// is read-only preflight; --run is required before creating an isolated schema,
// Redis stream, API containers, or test room.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { execFileSync } = require('child_process')

const APP = path.resolve(__dirname, '..')
const REPO = path.resolve(APP, '..')
const OUTPUT_ROOT = path.join(REPO, 'output', 'playwright', 'mcp-collab-recovery')
const IMAGE_DEFAULT = 'mind-map-app:merge-validate-097fa95e-20261015-candidate'
const IMAGE_ID_DEFAULT = 'sha256:6038254387ffd35811a44594e3e7a6bedb2f7f07418fa21a545caa6a4f38dc4d'
const MANIFEST_DEFAULT = path.join(REPO, 'output', 'merge-validate-20261015-097fa95e', 'candidate-image-manifest.json')
const SOURCE_MANIFEST_DEFAULT = path.join(REPO, 'output', 'merge-validate-20261015-097fa95e', 'full-source-manifest.json')
const NETWORK = 'mcp-incremental-test_default'
const POSTGRES = 'mcp-incremental-test-postgres-1'
const REDIS = 'mcp-incremental-test-redis-1'
const PG = { host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password' }
const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16389
const REDIS_DB = 12
const API_PORT_A = 19433
const API_PORT_B = 19435
const REQUIRED_IMAGE_PATHS = [
  'simple-mind-map/bin/collabServer.js',
  'simple-mind-map/bin/collabV2/socketServer.js',
  'simple-mind-map/bin/collabV2/operationEventBridge.js',
  'simple-mind-map/bin/collabV2/sequencer.js',
  'simple-mind-map/bin/collabV2/directApplier.js',
  'simple-mind-map/bin/eventBus.js',
  'simple-mind-map/bin/outbox.js',
  'simple-mind-map/migrations/009_mcp_archive_operation_id_index.up.sql',
  'simple-mind-map/migrations/012_mcp_terminal_receipts.up.sql',
  'simple-mind-map/migrations/011_access_request_roles.up.sql'
]
const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const value = argv[i + 1]
  if (value && !value.startsWith('--')) {
    args[key] = value
    i += 1
  } else args[key] = true
}
const runEnabled = argv.includes('--run')
const image = String(args.image || process.env.MCP_COLLAB_CANDIDATE_IMAGE || IMAGE_DEFAULT)
const expectedImageId = String(args['image-id'] || process.env.MCP_COLLAB_CANDIDATE_IMAGE_ID || IMAGE_ID_DEFAULT)
const manifestFile = path.resolve(String(args.manifest || process.env.MCP_COLLAB_CANDIDATE_MANIFEST || MANIFEST_DEFAULT))
const sourceManifestFile = path.resolve(String(args['source-manifest'] || process.env.MCP_COLLAB_CANDIDATE_SOURCE_MANIFEST || SOURCE_MANIFEST_DEFAULT))
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8)
const runToken = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const roomKey = 'recovery-' + runToken
const dbName = 'mcp_recovery_' + runToken
const dbMarker = 'codex-mcp-collab-recovery:' + runId
const streamKey = 'codex:mcp-collab-recovery:' + runToken + ':events'
const containerNames = {
  a: 'mcp-recovery-' + runToken + '-api-a',
  b: 'mcp-recovery-' + runToken + '-api-b'
}
const origins = { a: 'http://127.0.0.1:' + API_PORT_A, b: 'http://127.0.0.1:' + API_PORT_B }
const migrationHashes = new Map()
const ownedContainers = new Map()
const summary = {
  runId,
  runToken,
  image,
  expectedImageId,
  isolation: { postgresTemplate: PG.database, database: dbName, redisDatabase: REDIS_DB, streamKey, roomKey, ports: [API_PORT_A, API_PORT_B] },
  mode: runEnabled ? 'run' : 'preflight',
  checks: {},
  cleanup: {},
  failures: []
}
const runDir = path.join(OUTPUT_ROOT, runId)
const summaryPath = path.join(runDir, 'summary.json')

function docker(argv, options = {}) {
  return execFileSync('docker', argv, {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio || ['pipe', 'pipe', 'pipe']
  })
}

function pgModule() { return require(path.join(APP, 'node_modules', 'pg')) }
function redisModule() { return require(path.join(APP, 'node_modules', 'redis')) }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase() }
function writeSummary() {
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')
}
function assertRunDatabaseName(name) { assert(/^mcp_recovery_[a-f0-9]{12}$/.test(name), 'refusing non-run-owned database name') }
function assertSafeSqlIdentifier(name) { assert(/^[a-z][a-z0-9_]{0,62}$/.test(name), 'refusing unsafe SQL identifier') }

async function connectRedis() {
  const { createClient } = redisModule()
  const client = createClient({ url: 'redis://' + REDIS_HOST + ':' + REDIS_PORT + '/' + REDIS_DB, socket: { connectTimeout: 5000 } })
  client.on('error', () => {})
  await client.connect()
  return client
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(new Error('port ' + port + ' is unavailable: ' + error.code)))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}

function readManifestEvidence() {
  assert(fs.existsSync(manifestFile), 'candidate image manifest missing: ' + manifestFile)
  assert(fs.existsSync(sourceManifestFile), 'candidate source manifest missing: ' + sourceManifestFile)
  const imageManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const sourceManifestBytes = fs.readFileSync(sourceManifestFile)
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'))
  assert(String(imageManifest.imageId) === expectedImageId, 'candidate manifest image ID does not match requested image ID')
  assert(sha256(sourceManifestBytes) === String(imageManifest.sourceManifestSha256).toUpperCase(), 'candidate source manifest digest mismatch')
  const entries = new Map((sourceManifest.files || []).filter(row => row && row.imagePath).map(row => [row.path, row]))
  for (const sourcePath of REQUIRED_IMAGE_PATHS) {
    assert(entries.has(sourcePath), 'candidate source manifest does not bind ' + sourcePath)
  }
  return { imageManifest, sourceManifest, entries }
}

function verifyCandidateFiles(evidence) {
  const selected = REQUIRED_IMAGE_PATHS.map(sourcePath => {
    const row = evidence.entries.get(sourcePath)
    return { path: row.path, imagePath: row.imagePath, hash: String(row.hash || row.sha256).toUpperCase() }
  })
  const script = [
    "const fs=require('fs'),crypto=require('crypto');",
    "const input=JSON.parse(fs.readFileSync(0,'utf8'));",
    "const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();",
    "process.stdout.write(JSON.stringify(input.map(x=>({path:x.path,exists:fs.existsSync(x.imagePath),sha256:fs.existsSync(x.imagePath)?digest(x.imagePath):null}))))"
  ].join('')
  const actual = JSON.parse(docker(['run', '--rm', '-i', '--entrypoint', 'node', image, '-e', script], { input: JSON.stringify(selected) }))
  const mismatches = actual.filter((row, index) => !row.exists || row.sha256 !== selected[index].hash)
  assert.deepStrictEqual(mismatches, [], 'candidate image source hash mismatch: ' + JSON.stringify(mismatches))
  for (const row of actual) {
    if (row.path.endsWith('.sql')) migrationHashes.set(row.path, row.sha256)
  }
  return {
    imageId: docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim(),
    sourceManifestSha256: sha256(fs.readFileSync(sourceManifestFile)),
    verifiedFileCount: actual.length,
    fileSetSha256: sha256(actual.map(row => row.path + '\0' + row.sha256).join('\0'))
  }
}

async function verifyInfrastructure() {
  const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim()
  assert(imageId === expectedImageId, 'candidate image ID mismatch: expected ' + expectedImageId + ', got ' + imageId)
  const network = JSON.parse(docker(['network', 'inspect', NETWORK]))[0]
  assert(network && network.Containers, 'isolated Docker network unavailable')
  const members = Object.values(network.Containers).map(row => row.Name)
  assert(members.includes(POSTGRES) && members.includes(REDIS), 'isolated PG/Redis containers are not both attached to test network')
  const pgPool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
  let redis = null
  try {
    redis = await connectRedis()
    const identity = await pgPool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === PG.database && identity.rows[0].username === PG.user, 'PG source identity mismatch')
    assert(await redis.ping() === 'PONG', 'isolated Redis PING failed')
    const dbSize = await redis.dbSize()
    assert.strictEqual(dbSize, 0, 'Redis DB 12 is not empty (' + dbSize + ' keys); refusing to use/clean it')
    for (const port of [API_PORT_A, API_PORT_B]) await assertPortFree(port)
    const existingNames = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
    for (const name of Object.values(containerNames)) assert(!existingNames.includes(name), 'run-owned container name already exists: ' + name)
    const evidence = readManifestEvidence()
    const sourceEvidence = verifyCandidateFiles(evidence)
    summary.checks.infrastructure = {
      postgres: { database: identity.rows[0].database, user: identity.rows[0].username },
      redis: { host: REDIS_HOST, port: REDIS_PORT, database: REDIS_DB, initialKeyCount: dbSize },
      network: NETWORK,
      portsFree: [API_PORT_A, API_PORT_B],
      candidate: sourceEvidence
    }
  } finally {
    if (redis) await redis.quit().catch(() => {})
    await pgPool.end()
  }
}

function imageReadText(imagePath) {
  const script = "const fs=require('fs');process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))"
  return docker(['run', '--rm', '--entrypoint', 'node', image, '-e', script, imagePath])
}

async function createScratchDatabase() {
  assertRunDatabaseName(dbName)
  assertSafeSqlIdentifier(dbName)
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const source = await pool.query('select current_database() as database,current_user as username')
    assert(source.rows[0].database === PG.database && source.rows[0].username === PG.user, 'database clone source mismatch')
    const exists = await pool.query('select 1 from pg_database where datname=$1', [dbName])
    assert.strictEqual(exists.rowCount, 0, 'scratch database name already exists; refusing to reuse')
    const dump = docker(['exec', POSTGRES, 'pg_dump', '-U', PG.user, '--schema-only', '--no-owner', '--no-acl', PG.database])
    await pool.query('CREATE DATABASE ' + dbName + ' OWNER ' + PG.user)
    await pool.query("COMMENT ON DATABASE " + dbName + " IS '" + dbMarker.replace(/'/g, "''") + "'")
    docker(['exec', '-i', POSTGRES, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', dbName], { input: dump })
    const marker = await pool.query("select shobj_description(oid,'pg_database') as comment from pg_database where datname=$1", [dbName])
    assert(marker.rows[0] && marker.rows[0].comment === dbMarker, 'scratch database ownership marker mismatch')
    summary.checks.database = { database: dbName, sourceDatabase: PG.database, schemaOnly: true, dataCopied: false, ownershipMarker: dbMarker, schemaDumpSha256: sha256(dump) }
  } finally {
    await pool.end()
  }
}

async function applyRequiredMigrations() {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === dbName && identity.rows[0].username === PG.user, 'migration target identity mismatch')
    const evidence = readManifestEvidence()
    const files = REQUIRED_IMAGE_PATHS.filter(file => file.endsWith('.sql'))
    const sqlByFile = new Map()
    for (const file of files) {
      const item = evidence.entries.get(file)
      const sql = imageReadText(item.imagePath)
      assert(sha256(sql) === migrationHashes.get(file), 'candidate migration source hash changed: ' + file)
      sqlByFile.set(file, sql)
    }

    const indexName = 'room_operations_archive_operation_id_idx'
    const index = await pool.query("select i.indisvalid as valid,i.indisready as ready from pg_class c join pg_index i on i.indexrelid=c.oid where c.oid=to_regclass('public." + indexName + "')")
    if (!index.rowCount || !index.rows[0].valid || !index.rows[0].ready) {
      const statement = sqlByFile.get('simple-mind-map/migrations/009_mcp_archive_operation_id_index.up.sql').match(/create\s+index\s+concurrently\s+if\s+not\s+exists[\s\S]*?;/i)
      assert(statement, '009 migration lacks its concurrent index statement')
      await pool.query("set lock_timeout='2s'")
      try { await pool.query(statement[0]) } finally { await pool.query('reset lock_timeout') }
    }
    const verifiedIndex = await pool.query("select i.indisvalid as valid,i.indisready as ready from pg_class c join pg_index i on i.indexrelid=c.oid where c.oid=to_regclass('public." + indexName + "')")
    assert(verifiedIndex.rowCount === 1 && verifiedIndex.rows[0].valid && verifiedIndex.rows[0].ready, '009 archive index is not valid after migration')
    await pool.query(sqlByFile.get('simple-mind-map/migrations/012_mcp_terminal_receipts.up.sql'))
    await pool.query(sqlByFile.get('simple-mind-map/migrations/011_access_request_roles.up.sql'))
    const schema = await pool.query("select to_regclass('public.mcp_terminal_receipts') as receipt_table, exists(select 1 from information_schema.columns where table_schema='public' and table_name='room_access_requests' and column_name='granted_role') as access_roles")
    assert(schema.rows[0].receipt_table && schema.rows[0].access_roles, '010/011 required schema is missing')
    summary.checks.migrations = { candidateImageApplied: true, sourceHashes: Object.fromEntries([...migrationHashes.entries()]), receiptTable: schema.rows[0].receipt_table, accessRequestRoleField: schema.rows[0].access_roles, archiveIndexValid: true }
  } finally {
    await pool.end()
  }
}

function containerEnv(role, apiOrigin) {
  const isA = role === 'a'
  const allowedOrigins = origins.a + ',' + origins.b
  return {
    MIND_MAP_SKIP_ROOT_ENV: '1', HOST: '0.0.0.0', PORT: '1234',
    PGHOST: POSTGRES, PGPORT: '5432', PGDATABASE: dbName, PGUSER: PG.user, PGPASSWORD: PG.password,
    REDIS_URL: 'redis://' + REDIS + ':6379/' + REDIS_DB,
    COLLAB_REDIS_STREAM: streamKey, COLLAB_EVENT_BUS: 'redis',
    COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: '1', COLLAB_MCP_DIRECT: '1',
    COLLAB_OUTBOX_PUBLISHER: '1', COLLAB_OUTBOX_POLL_MS: '80',
    COLLAB_E2E: '1', COLLAB_TRACE: '0', COLLAB_V2_TRACE: '0',
    COLLAB_PRESENCE_BACKEND: 'redis', COLLAB_RATE_LIMIT_PER_ROOM: '8000', COLLAB_RATE_LIMIT_GLOBAL: '80000',
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef', WECOM_AGENT_ID: '1000001', WECOM_SECRET: 'mcp-collab-recovery-test-only',
    AUTH_SESSION_SECRET: 'mcp-collab-recovery-' + runToken + '-session-secret-32-chars',
    AUTH_APP_ORIGIN: apiOrigin, AUTH_ALLOWED_ORIGINS: allowedOrigins, AUTH_COOKIE_SECURE: 'false',
    WECOM_REDIRECT_URI: apiOrigin + '/api/auth/wecom/callback', MCP_TOKEN: 'mcp-collab-recovery-test-token-' + runToken,
    KNOWLEDGE_COMPILER_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false'
  }
}

function startApi(role) {
  const name = containerNames[role]
  const port = role === 'a' ? API_PORT_A : API_PORT_B
  const origin = origins[role]
  const existing = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
  assert(!existing.includes(name), 'refusing to replace existing container: ' + name)
  const env = containerEnv(role, origin)
  assert(env.MCP_TOKEN.length >= 32, 'recovery fixture MCP_TOKEN must meet the runtime minimum length')
  const cmd = [
    'run', '--detach', '--name', name,
    '--label', 'codex.mcp-collab-recovery-run=' + runId,
    '--label', 'codex.mcp-collab-recovery-role=api-' + role,
    '--network', NETWORK, '--cpus', '2', '--memory', '2g',
    '--publish', '127.0.0.1:' + port + ':1234',
    '--workdir', '/app/simple-mind-map'
  ]
  for (const [key, value] of Object.entries(env)) cmd.push('--env', key + '=' + value)
  cmd.push('--entrypoint', 'node', image, '/app/simple-mind-map/bin/collabServer.js')
  docker(cmd)
  ownedContainers.set(name, 'api-' + role)
  return { name, origin, port }
}

function requireOwnedContainer(name, role) {
  const actualRun = docker(['inspect', '--format', '{{ index .Config.Labels "codex.mcp-collab-recovery-run" }}', name]).trim()
  const actualRole = docker(['inspect', '--format', '{{ index .Config.Labels "codex.mcp-collab-recovery-role" }}', name]).trim()
  assert(actualRun === runId && actualRole === role, 'refusing to mutate a container without matching run ownership labels: ' + name)
}

async function waitFor(predicate, label, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result } catch (error) {
      if (error && error.abortWait === true) throw error
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(label + ' timed out' + (lastError ? ': ' + lastError.message : ''))
}

function sanitizeDiagnosticText(value) {
  return String(value || '')
    .replace(/(MCP_TOKEN|WECOM_SECRET|AUTH_SESSION_SECRET|PGPASSWORD|password|secret|token|authorization|cookie)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(-18000)
}

async function probeTcp(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ reachable: false, error: 'timeout' })
    }, 1000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve({ reachable: true })
    })
    socket.once('error', error => {
      clearTimeout(timer)
      resolve({ reachable: false, error: error.code || error.message })
    })
  })
}

async function captureReadinessDiagnostics() {
  const services = []
  for (const role of ['a', 'b']) {
    const name = containerNames[role]
    const origin = origins[role]
    const port = role === 'a' ? API_PORT_A : API_PORT_B
    const service = { name, origin, hostPort: port }
    try {
      service.containerState = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]))
      service.containerPorts = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))
    } catch (error) {
      service.containerInspectError = sanitizeDiagnosticText(error.message)
    }
    try {
      service.tcp = await probeTcp(port)
    } catch (error) {
      service.tcp = { reachable: false, error: sanitizeDiagnosticText(error.message) }
    }
    try {
      const response = await requestJson(origin, '/api/health', { signal: AbortSignal.timeout(2500) })
      service.health = { status: response.response.status, ok: response.response.ok, body: sanitizeDiagnosticText(response.text).slice(0, 1200) }
    } catch (error) {
      service.health = { reachable: false, error: sanitizeDiagnosticText(error.message) }
    }
    try {
      service.logsTail = sanitizeDiagnosticText(docker(['logs', '--tail', '80', name]))
    } catch (error) {
      service.logsError = sanitizeDiagnosticText(error.message)
    }
    services.push(service)
  }
  summary.checks.readinessFailure = { capturedAt: new Date().toISOString(), services }
}

async function requestJson(origin, pathname, options = {}) {
  const response = await fetch(origin + pathname, { ...options, signal: options.signal || AbortSignal.timeout(30000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) {}
  return { response, text, data }
}

function apiHeaders(cookie, origin) { return { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' } }

async function createIdentity(origin) {
  const userId = 'recovery-user-' + runToken
  const result = await requestJson(origin, '/api/auth/e2e-identity', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId })
  })
  assert(result.response.ok && result.data && result.data.token, 'E2E identity creation failed: HTTP ' + result.response.status + ' ' + result.text.slice(0, 240))
  return { userId, cookie: 'mind_map_session=' + result.data.token }
}

function connectSocket(origin, cookie, clientId) {
  const { io } = require(path.join(APP, 'node_modules', 'socket.io-client'))
  return io(origin, {
    path: '/collab-v2', transports: ['websocket'], forceNew: true, reconnection: false,
    extraHeaders: { Cookie: cookie, Origin: origin }, auth: { clientId }
  })
}

async function waitConnected(socket, label) {
  if (socket.connected) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' socket connect timeout')), 12000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', error => { clearTimeout(timer); reject(error) })
  })
}

function emitAck(socket, event, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + ' acknowledgement timeout')), timeoutMs)
    socket.emit(event, payload, result => { clearTimeout(timer); resolve(result) })
  })
}

async function join(socket, clientId, lastServerRevision) {
  const result = await emitAck(socket, 'join', { roomKey, clientId, userId: 'recovery-user-' + runToken, name: clientId, lastServerRevision })
  assert(result && result.ok, 'socket join rejected: ' + JSON.stringify(result))
  return result
}

function createOperation(socket, clientId, type, payload) {
  const opId = crypto.randomUUID()
  const promise = emitAck(socket, 'op', { roomKey, opId, clientId, userId: 'recovery-user-' + runToken, type, payload })
    .then(result => {
      assert(result && result.ok, 'operation rejected: ' + JSON.stringify(result))
      assert.strictEqual(result.opId, opId, 'operation ACK id mismatch')
      return { opId, result }
    })
  return { opId, promise }
}

async function getStreamEntries(redis) {
  return redis.xRange(streamKey, '-', '+')
}

async function waitStreamEntry(redis, opId, expectedCount = 1) {
  return waitFor(async () => {
    const entries = await getStreamEntries(redis)
    const hits = entries.filter(item => {
      try { return JSON.parse(item.message.json || '{}').operationId === opId } catch (_) { return false }
    })
    return hits.length >= expectedCount ? hits : null
  }, 'Redis stream operation ' + opId)
}

function eventRevision(op) { return Number(op && (op.serverRevision || op.version || (op.operation && (op.operation.serverRevision || op.operation.version))) || 0) }
function eventOpId(op) { return String(op && (op.opId || op.operationId || (op.operation && (op.operation.opId || op.operation.operationId))) || '') }

async function waitForBridgeRoom(origin, expectedRooms = 1) {
  return waitFor(async () => {
    const result = await requestJson(origin, '/api/health')
    if (!result.response.ok || !result.data || !result.data.eventBridge) return null
    const bridge = result.data.eventBridge
    return bridge.enabled && bridge.listenerHealthy && Number(bridge.activeRooms) >= expectedRooms ? bridge : null
  }, 'event bridge room activation')
}

async function createRoom(ownerCookie) {
  const created = await requestJson(origins.a, '/api/files', {
    method: 'POST', headers: apiHeaders(ownerCookie, origins.a),
    body: JSON.stringify({ room_key: roomKey, title: 'MCP collaboration recovery integration' })
  })
  assert(created.response.ok, 'room create failed: HTTP ' + created.response.status + ' ' + created.text.slice(0, 300))
  const tree = {
    data: { uid: 'root', text: 'Root', expand: true },
    children: [{
      data: { uid: 'parent-a', text: 'Parent A', expand: true },
      children: [{ data: { uid: 'shared-uid', text: 'Initial value', expand: true }, children: [] }]
    }]
  }
  const replace = await requestJson(origins.a, '/api/files/' + encodeURIComponent(roomKey) + '/replace', {
    method: 'POST', headers: apiHeaders(ownerCookie, origins.a),
    body: JSON.stringify({ tree, client_id: 'recovery-seed-' + runToken, operation_id: crypto.randomUUID(), allowFullTree: true })
  })
  assert(replace.response.ok, 'room seed failed: HTTP ' + replace.response.status + ' ' + replace.text.slice(0, 300))
  return replace.data
}

async function assertForgedMcpResultCannotEnterHistory(pool, identity, socket, clientId, seedRevision) {
  const httpUid = 'forged-http-' + runToken
  const httpOpId = crypto.randomUUID()
  const httpWrite = await requestJson(origins.a, '/api/maps/' + encodeURIComponent(roomKey) + '/operations/batch', {
    method: 'POST',
    headers: apiHeaders(identity.cookie, origins.a),
    body: JSON.stringify({
      operations: [{
        operationId: httpOpId,
        clientId,
        type: 'node.insert',
        payload: {
          uid: httpUid,
          parentUid: 'parent-a',
          text: 'HTTP request with forged MCP metadata',
          __mcpResult: { items: [{ index: 0, status: 'failed', errorCode: 'FORGED_HTTP_RESULT' }] }
        }
      }]
    })
  })
  assert(httpWrite.response.ok, 'forged HTTP batch-envelope request failed: HTTP ' + httpWrite.response.status + ' ' + httpWrite.text.slice(0, 300))
  const httpRowResult = await pool.query(
    'select version,operation_type,payload,event from room_operations where room_key=$1 and operation_id=$2',
    [roomKey, httpOpId]
  )
  assert.strictEqual(httpRowResult.rowCount, 1, 'ordinary HTTP batch-envelope operation was not persisted')
  const httpRow = httpRowResult.rows[0]
  assert(!Object.prototype.hasOwnProperty.call(httpRow.payload || {}, '__mcpResult'), 'ordinary HTTP request injected __mcpResult into durable history')

  const socketUid = 'forged-socket-' + runToken
  const socketOp = createOperation(socket, clientId, 'node.batch', {
    ops: [{
      type: 'node.insert',
      payload: { uid: socketUid, parentUid: 'parent-a', text: 'Socket batch with forged MCP metadata' }
    }],
    __mcpResult: { items: [{ index: 0, status: 'failed', errorCode: 'FORGED_SOCKET_RESULT' }] }
  })
  const socketAck = await socketOp.promise
  const socketRowResult = await pool.query(
    'select version,operation_type,payload,event from room_operations where room_key=$1 and operation_id=$2',
    [roomKey, socketOp.opId]
  )
  assert.strictEqual(socketRowResult.rowCount, 1, 'ordinary Socket node.batch operation was not persisted')
  const socketRow = socketRowResult.rows[0]
  assert(!Object.prototype.hasOwnProperty.call(socketRow.payload || {}, '__mcpResult'), 'ordinary Socket request injected __mcpResult into durable batch history')
  const replayRows = await pool.query(
    `select version,operation_id,actor_id,client_id,operation_type,payload,event,inverse_payload
     from room_operations where room_key=$1 and version>$2 and version<=$3 order by version`,
    [roomKey, seedRevision, Number(socketRow.version)]
  )
  const replay = await require(path.join(APP, 'bin', 'collabHistory', 'replayer')).replayOperations(
    {
      root: { isRoot: true, data: { uid: 'root', text: 'Root', expand: true }, children: ['parent-a'] },
      'parent-a': { data: { uid: 'parent-a', text: 'Parent A', expand: true }, children: ['shared-uid'] },
      'shared-uid': { data: { uid: 'shared-uid', text: 'Initial value', expand: true }, children: [] }
    },
    {},
    replayRows.rows,
    { requireContinuous: true, fromRevision: seedRevision }
  )
  assert(replay.tree[httpUid] && replay.tree[socketUid], 'historical replay did not apply the two committed insertions')
  assert.strictEqual(Number(socketAck.result.serverRevision), Number(socketRow.version), 'Socket batch ACK revision differs from persisted version')
  return {
    httpEnvelope: { operationId: httpOpId, version: Number(httpRow.version), forgedResultRemoved: true },
    socketBatch: { operationId: socketOp.opId, version: Number(socketRow.version), forgedResultRemoved: true },
    replayedRows: replayRows.rowCount,
    replayedInsertedUids: [httpUid, socketUid]
  }
}

async function waitEventCount(events, opId, expected, label) {
  return waitFor(() => {
    const matches = events.filter(item => eventOpId(item) === opId)
    return matches.length >= expected ? matches : null
  }, label || ('operation event ' + opId))
}

async function waitEventRevision(events, revision) {
  return waitFor(() => events.find(item => eventRevision(item) === revision) || null, 'operation event revision ' + revision)
}

async function pauseAndDisconnectRedisReader(apiB, redis) {
  requireOwnedContainer(apiB.name, 'api-b')
  docker(['pause', apiB.name])
  const ip = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', apiB.name]).trim()
  assert(ip, 'could not resolve isolated API B container IP')
  const listing = String(await redis.sendCommand(['CLIENT', 'LIST']))
  const ids = listing.split(/\r?\n/).map(line => {
    const fields = Object.fromEntries(line.split(' ').map(part => part.split('=').slice(0, 2)))
    return fields.addr && fields.addr.startsWith(ip + ':') && fields.db === String(REDIS_DB) ? fields.id : null
  }).filter(Boolean)
  assert(ids.length >= 1, 'no API B Redis DB12 clients found to interrupt')
  for (const id of ids) await redis.sendCommand(['CLIENT', 'KILL', 'ID', String(id)])
  summary.checks.interruptedRedisConnections = { count: ids.length, apiBContainerIp: ip }
  return ids.length
}

async function removeStreamEvent(redis, opId) {
  const entries = await waitStreamEntry(redis, opId)
  const ids = entries.filter(item => {
    try { return JSON.parse(item.message.json || '{}').operationId === opId } catch (_) { return false }
  }).map(item => item.id)
  assert(ids.length === 1, 'expected exactly one Redis stream item for new operation ' + opId + ', got ' + ids.length)
  const deleted = await redis.xDel(streamKey, ids)
  assert.strictEqual(Number(deleted), 1, 'failed to remove the run-owned stream notification')
  const remaining = (await getStreamEntries(redis)).some(item => item.id === ids[0])
  assert(!remaining, 'run-owned stream entry still exists after XDEL')
  return { streamEntryId: ids[0], deleted }
}

async function deleteOwnOperationLogRow(pool, version, expectedOpId) {
  const identity = await pool.query('select current_database() as database')
  assert.strictEqual(identity.rows[0].database, dbName, 'log-gap write target is not run-owned database')
  const found = await pool.query('select operation_id from room_operations where room_key=$1 and version=$2', [roomKey, version])
  assert(found.rowCount === 1 && found.rows[0].operation_id === expectedOpId, 'expected run-owned operation row is missing or mismatched before gap injection')
  await pool.query('begin')
  try {
    await pool.query('delete from room_outbox where room_key=$1 and version=$2', [roomKey, version])
    const deleted = await pool.query('delete from room_operations where room_key=$1 and version=$2 and operation_id=$3', [roomKey, version, expectedOpId])
    assert.strictEqual(deleted.rowCount, 1, 'expected to remove exactly one run-owned operation row')
    await pool.query('commit')
  } catch (error) {
    await pool.query('rollback').catch(() => {})
    throw error
  }
  const stillThere = await pool.query('select 1 from room_operations where room_key=$1 and version=$2', [roomKey, version])
  assert.strictEqual(stillThere.rowCount, 0, 'operation log gap injection did not remove its exact row')
  const head = await pool.query('select version from rooms where room_key=$1', [roomKey])
  assert(Number(head.rows[0].version) >= version, 'authoritative room head was unexpectedly lowered')
}

async function runAcceptance() {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 2, connectionTimeoutMillis: 5000 })
  let redis = null
  let socketA = null
  let socketB = null
  let pausedB = false
  try {
    redis = await connectRedis()
    const apiA = startApi('a')
    const apiB = startApi('b')
    summary.checks.containers = [apiA.name, apiB.name]
    try {
      await waitFor(async () => {
        const states = [apiA, apiB].map(api => ({
          name: api.name,
          state: docker(['inspect', '--format', '{{.State.Status}}', api.name]).trim(),
          exitCode: Number(docker(['inspect', '--format', '{{.State.ExitCode}}', api.name]).trim())
        }))
        const exited = states.find(item => item.state === 'exited' || item.state === 'dead')
        if (exited) {
          const error = new Error('API container exited before health readiness: ' + exited.name + ' state=' + exited.state + ' exitCode=' + exited.exitCode)
          error.abortWait = true
          throw error
        }
        const [a, b] = await Promise.all([requestJson(apiA.origin, '/api/health'), requestJson(apiB.origin, '/api/health')])
        return a.response.ok && b.response.ok && a.data && b.data ? true : null
      }, 'dual API readiness', 60000, 250)
    } catch (error) {
      await captureReadinessDiagnostics()
      writeSummary()
      throw new Error(error.message + ' (container state, host TCP, HTTP status, and redacted logs saved in summary)')
    }
    for (const origin of [apiA.origin, apiB.origin]) {
      const health = await requestJson(origin, '/api/health')
      assert(health.data.collabV2, 'Collab V2 is disabled at ' + origin)
      assert(health.data.eventBridge && health.data.eventBridge.enabled && health.data.eventBridge.listenerHealthy, 'event bridge is not healthy at ' + origin)
      assert(health.data.bus && health.data.bus.name === 'redis' && health.data.bus.ok, 'Redis bus is not healthy at ' + origin)
    }
    const identity = await createIdentity(apiA.origin)
    const seeded = await createRoom(identity.cookie)
    const seedRevision = Number(seeded.version || seeded.currentRevision || 0)
    socketA = connectSocket(apiA.origin, identity.cookie, 'recovery-client-a-' + runToken)
    socketB = connectSocket(apiB.origin, identity.cookie, 'recovery-client-b-' + runToken)
    const eventsA = []
    const eventsB = []
    const resnapshotsB = []
    socketA.on('op:event', item => eventsA.push(item))
    socketB.on('op:event', item => eventsB.push(item))
    socketB.on('sync:resnapshot-required', item => resnapshotsB.push(item))
    await Promise.all([waitConnected(socketA, 'A'), waitConnected(socketB, 'B')])
    const joinedA = await join(socketA, 'recovery-client-a-' + runToken, seedRevision)
    const joinedB = await join(socketB, 'recovery-client-b-' + runToken, seedRevision)
    assert(joinedA.canEdit && joinedB.canEdit, 'both real API clients must have edit access')
    await Promise.all([waitForBridgeRoom(apiA.origin), waitForBridgeRoom(apiB.origin)])
    summary.checks.dualInstance = { apiA: apiA.name, apiB: apiB.name, seedRevision, joined: true, bridgeRoomsActive: true }
    summary.checks.untrustedMcpResultMetadata = await assertForgedMcpResultCannotEnterHistory(
      pool, identity, socketA, 'recovery-client-a-' + runToken, seedRevision
    )

    // Duplicate publication: replay the same durable outbox row after B has
    // received its first event. The bridge should not emit that operation twice.
    const duplicateOp = createOperation(socketA, 'recovery-client-a-' + runToken, 'node.update', { uid: 'shared-uid', text: 'duplicate-once' })
    const duplicateAck = await duplicateOp.promise
    const duplicateRevision = Number(duplicateAck.result.serverRevision)
    await waitEventCount(eventsB, duplicateOp.opId, 1, 'first delivery before duplicate replay')
    const replay = await requestJson(apiA.origin, '/api/ops/outbox', {
      method: 'POST', headers: apiHeaders(identity.cookie, apiA.origin),
      body: JSON.stringify({ roomKey, version: duplicateRevision })
    })
    assert(replay.response.ok && Number(replay.data.replayed) >= 1, 'outbox replay failed: ' + replay.text.slice(0, 300))
    const duplicateStreamItems = await waitStreamEntry(redis, duplicateOp.opId, 2)
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.strictEqual(eventsB.filter(item => eventOpId(item) === duplicateOp.opId).length, 1, 'duplicate notification caused duplicate op:event delivery')
    summary.checks.duplicateNotification = { operationId: duplicateOp.opId, revision: duplicateRevision, streamDeliveries: duplicateStreamItems.length, clientDeliveries: 1, replayedOutboxRows: replay.data.replayed }

    // Suppress B's Redis subscriber while A commits. Delete the sole stream
    // wakeup before B resumes; the live client must be repaired from PG log.
    const previousBRevision = duplicateRevision
    await pauseAndDisconnectRedisReader(apiB, redis)
    pausedB = true
    const recoveredOp = createOperation(socketA, 'recovery-client-a-' + runToken, 'node.update', { uid: 'shared-uid', text: 'recovered-from-operation-log' })
    const recoveredAck = await recoveredOp.promise
    const removedNotification = await removeStreamEvent(redis, recoveredOp.opId)
    requireOwnedContainer(apiB.name, 'api-b')
    docker(['unpause', apiB.name])
    pausedB = false
    await waitEventCount(eventsB, recoveredOp.opId, 1, 'durable operation-log compensation after lost notification')
    assert.strictEqual(eventsB.filter(item => eventOpId(item) === recoveredOp.opId).length, 1, 'log compensation emitted duplicate operation')
    summary.checks.lostNotificationCompensation = {
      operationId: recoveredOp.opId,
      previousRevision: previousBRevision,
      committedRevision: Number(recoveredAck.result.serverRevision),
      streamNotificationDeleted: removedNotification.deleted === 1,
      recoveredClientDeliveries: 1,
      mechanism: 'event bridge active-head reconciliation from persistent room_operations'
    }

    // Concurrent writes to one UID and concurrent inserts at the same parent
    // exercise per-room serialization and final tree convergence across APIs.
    const updateJobs = []
    for (let i = 0; i < 8; i += 1) {
      const socket = i % 2 ? socketA : socketB
      const clientId = i % 2 ? 'recovery-client-a-' + runToken : 'recovery-client-b-' + runToken
      updateJobs.push(createOperation(socket, clientId, 'node.update', { uid: 'shared-uid', text: 'concurrent-update-' + i }))
    }
    const updateResults = await Promise.all(updateJobs.map(job => job.promise))
    const latestUpdate = updateResults.reduce((left, right) => Number(left.result.serverRevision) > Number(right.result.serverRevision) ? left : right)
    const insertJobs = []
    for (let i = 0; i < 8; i += 1) {
      const socket = i % 2 ? socketA : socketB
      const clientId = i % 2 ? 'recovery-client-a-' + runToken : 'recovery-client-b-' + runToken
      insertJobs.push(createOperation(socket, clientId, 'node.insert', { uid: 'concurrent-child-' + i, parent: 'parent-a', index: 0, text: 'Concurrent child ' + i }))
    }
    const insertResults = await Promise.all(insertJobs.map(job => job.promise))
    const concurrentResults = updateResults.concat(insertResults)
    for (const item of concurrentResults) await waitEventCount(eventsB, item.opId, 1, 'cross-instance concurrent operation propagation')
    const concurrentVersions = concurrentResults.map(item => Number(item.result.serverRevision)).sort((a, b) => a - b)
    assert.strictEqual(new Set(concurrentVersions).size, concurrentResults.length, 'concurrent operations reused a server revision')
    for (let i = 1; i < concurrentVersions.length; i += 1) assert.strictEqual(concurrentVersions[i], concurrentVersions[i - 1] + 1, 'concurrent operation revisions are not contiguous')
    const nodeRows = await pool.query("select uid,parent_uid,position,data,node_version from room_nodes where room_key=$1 and deleted_at is null and (uid='shared-uid' or uid like 'concurrent-child-%') order by uid", [roomKey])
    const shared = nodeRows.rows.find(row => row.uid === 'shared-uid')
    const children = nodeRows.rows.filter(row => row.uid.startsWith('concurrent-child-'))
    assert(shared && Number(shared.node_version) === Number(latestUpdate.result.serverRevision), 'same-UID final row does not match last committed update')
    assert.strictEqual(shared.data.text, latestUpdate.result.operation.payload.text, 'same-UID final content does not match highest revision')
    assert.strictEqual(children.length, 8, 'same-parent concurrent insert lost nodes')
    assert(children.every(row => row.parent_uid === 'parent-a' && row.position), 'same-parent insert lost its parent/order')
    assert.strictEqual(new Set(children.map(row => row.position)).size, 8, 'same-parent concurrent inserts reused positions')
    summary.checks.concurrentWrites = { sameUidUpdates: updateResults.length, sameParentInserts: children.length, consecutiveRevisions: true, finalNodeVersion: Number(shared.node_version), finalText: shared.data.text, uniquePositions: 8 }

    // Real socket sync pagination: each page is bounded and versions are
    // contiguous until the current revision is reached.
    const pagedVersions = []
    let afterRevision = 0
    let pageCount = 0
    for (;;) {
      const page = await emitAck(socketB, 'sync', { roomKey, afterRevision, limit: 5 })
      assert(page && page.ok && !page.reload, 'operation page requested resnapshot before injected gap: ' + JSON.stringify(page))
      const operations = page.operations || []
      assert(operations.length <= 5, 'sync page exceeded its requested limit')
      for (const operation of operations) pagedVersions.push(eventRevision(operation))
      pageCount += 1
      afterRevision = Number(page.toRevision || afterRevision)
      if (!page.hasMore) break
      assert(pageCount < 20, 'operation sync pagination failed to terminate')
    }
    const apiVersion = await requestJson(apiA.origin, '/api/maps/' + encodeURIComponent(roomKey) + '/version', { headers: apiHeaders(identity.cookie, apiA.origin) })
    assert(apiVersion.response.ok, 'version query failed')
    const headBeforeGap = Number(apiVersion.data.version)
    assert.strictEqual(afterRevision, headBeforeGap, 'paged sync did not reach current room revision')
    assert.strictEqual(pagedVersions.length, headBeforeGap, 'paged sync omitted a committed version')
    for (let i = 0; i < pagedVersions.length; i += 1) assert.strictEqual(pagedVersions[i], i + 1, 'paged sync has a gap/duplicate at position ' + i)
    assert(pageCount >= 3, 'test did not exercise multiple sync pages')
    summary.checks.multiPageSync = { pageSize: 5, pageCount, operationCount: pagedVersions.length, fromRevision: 0, toRevision: headBeforeGap, contiguous: true }

    // Disconnect/reconnect B and verify the join response catches up from its
    // pre-disconnect revision without needing a full snapshot.
    const beforeReconnect = headBeforeGap
    socketB.disconnect()
    await new Promise(resolve => setTimeout(resolve, 150))
    const reconnectOp = createOperation(socketA, 'recovery-client-a-' + runToken, 'node.update', { uid: 'shared-uid', text: 'after-socket-reconnect' })
    const reconnectAck = await reconnectOp.promise
    socketB.connect()
    await waitConnected(socketB, 'B reconnect')
    const rejoined = await join(socketB, 'recovery-client-b-' + runToken, beforeReconnect)
    const reconnectOps = (rejoined.sync && rejoined.sync.operations) || []
    assert(rejoined.sync && !rejoined.sync.reload, 'socket reconnect unexpectedly required snapshot')
    assert(reconnectOps.some(item => eventOpId(item) === reconnectOp.opId), 'reconnect sync omitted the committed operation')
    summary.checks.socketReconnect = { priorRevision: beforeReconnect, committedRevision: Number(reconnectAck.result.serverRevision), caughtUpOperationId: reconnectOp.opId, catchUpCount: reconnectOps.length, reload: false }
    await waitForBridgeRoom(apiB.origin)

    // Inject one actual log hole after the database has committed the node
    // change. Remove only that room/version and its outbox row in this scratch
    // DB, suppress the Redis wakeup, then require the bridge resnapshot signal.
    const beforeGap = Number(reconnectAck.result.serverRevision)
    await pauseAndDisconnectRedisReader(apiB, redis)
    pausedB = true
    const gapOp = createOperation(socketA, 'recovery-client-a-' + runToken, 'node.update', { uid: 'shared-uid', text: 'authoritative-snapshot-after-real-log-gap' })
    const gapAck = await gapOp.promise
    const gapRevision = Number(gapAck.result.serverRevision)
    const gapStreamRemoval = await removeStreamEvent(redis, gapOp.opId)
    await deleteOwnOperationLogRow(pool, gapRevision, gapOp.opId)
    requireOwnedContainer(apiB.name, 'api-b')
    docker(['unpause', apiB.name])
    pausedB = false
    const required = await waitFor(() => resnapshotsB.find(item => Number(item.missingVersion) === gapRevision) || null, 'resnapshot-required for real operation-log gap', 12000)
    assert.strictEqual(required.code, 'RESNAPSHOT_REQUIRED')
    const snapshot = await requestJson(apiB.origin, '/api/files/' + encodeURIComponent(roomKey) + '/nodes?uids=shared-uid', { headers: apiHeaders(identity.cookie, apiB.origin) })
    assert(snapshot.response.ok, 'authoritative node snapshot failed: HTTP ' + snapshot.response.status + ' ' + snapshot.text.slice(0, 250))
    assert(Number(snapshot.data.version) >= gapRevision, 'authoritative snapshot version did not include committed gap operation')
    assert(JSON.stringify(snapshot.data.nodes).includes('authoritative-snapshot-after-real-log-gap'), 'authoritative snapshot omitted node state written by gap operation')
    const gapJoinSocket = connectSocket(apiA.origin, identity.cookie, 'recovery-gap-check-' + runToken)
    try {
      await waitConnected(gapJoinSocket, 'gap reload check')
      const gapJoin = await join(gapJoinSocket, 'recovery-gap-check-' + runToken, beforeGap)
      assert(gapJoin.sync && gapJoin.sync.reload, 'joining behind the real log gap did not require snapshot')
      assert(Number(gapJoin.sync.missingVersion) === beforeGap + 1, 'gap join reported an unexpected missing version')
      summary.checks.realLogGapSnapshot = {
        missingVersion: Number(required.missingVersion), currentRevision: Number(required.currentRevision || required.serverRevision),
        gapOperationId: gapOp.opId, logRowDeleted: true, redisWakeupDeleted: gapStreamRemoval.deleted === 1,
        resnapshotSignalReceived: true, snapshotVersion: Number(snapshot.data.version), snapshotContainsCommittedState: true,
        staleJoinRequiresReload: true
      }
    } finally { gapJoinSocket.close() }

    const finalVersion = await requestJson(apiA.origin, '/api/maps/' + encodeURIComponent(roomKey) + '/version', { headers: apiHeaders(identity.cookie, apiA.origin) })
    assert(finalVersion.response.ok && Number(finalVersion.data.version) === gapRevision, 'real gap injection unexpectedly changed the authoritative head')
    summary.checks.finalState = { authoritativeVersion: Number(finalVersion.data.version), activeLogGapAt: gapRevision, roomKey }
  } finally {
    if (pausedB && ownedContainers.has(containerNames.b)) {
      try { requireOwnedContainer(containerNames.b, 'api-b'); docker(['unpause', containerNames.b]) } catch (_) {}
    }
    if (socketA) socketA.close()
    if (socketB) socketB.close()
    if (redis) await redis.quit().catch(() => {})
    await pool.end()
  }
}

async function cleanupOwnedResources() {
  const cleanedContainers = []
  for (const [name, role] of [...ownedContainers.entries()].reverse()) {
    try {
      requireOwnedContainer(name, role)
      const state = docker(['inspect', '--format', '{{.State.Status}}', name]).trim()
      if (state === 'paused') docker(['unpause', name])
      if (state === 'running' || state === 'paused') docker(['stop', '--time', '10', name])
      docker(['rm', name])
      cleanedContainers.push(name)
    } catch (error) {
      summary.failures.push({ phase: 'container-cleanup', name, message: error.message })
    }
  }
  summary.cleanup.containersRemoved = cleanedContainers

  let redis = null
  try {
    redis = await connectRedis()
    const streamRemoved = await redis.del(streamKey)
    const presencePattern = 'presence:' + encodeURIComponent(roomKey) + ':*'
    let cursor = '0'
    let presenceKeys = []
    do {
      const scan = await redis.scan(cursor, { MATCH: presencePattern, COUNT: 100 })
      cursor = scan.cursor
      presenceKeys = presenceKeys.concat(scan.keys)
    } while (String(cursor) !== '0')
    if (presenceKeys.length) await redis.del(presenceKeys)
    assert.strictEqual(Number(await redis.exists(streamKey)), 0, 'run-owned Redis stream key remains after cleanup')
    const remaining = await redis.scan('0', { MATCH: presencePattern, COUNT: 100 })
    assert.strictEqual(remaining.keys.length, 0, 'run-owned Redis presence keys remain after cleanup')
    summary.cleanup.redis = { database: REDIS_DB, deletedStreamKey: Number(streamRemoved), deletedPresenceKeys: presenceKeys.length, verified: true }
  } catch (error) {
    summary.failures.push({ phase: 'redis-cleanup', message: error.message })
  } finally {
    if (redis) await redis.quit().catch(() => {})
  }

  try {
    assertRunDatabaseName(dbName)
    assertSafeSqlIdentifier(dbName)
    const pool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
    try {
      const marker = await pool.query("select shobj_description(oid,'pg_database') as comment from pg_database where datname=$1", [dbName])
      if (marker.rowCount) {
        assert.strictEqual(marker.rows[0].comment, dbMarker, 'database marker does not belong to this run; refusing cleanup')
        await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [dbName])
        await pool.query('DROP DATABASE ' + dbName)
        summary.cleanup.databaseDropped = dbName
      } else summary.cleanup.databaseDropped = false
    } finally { await pool.end() }
  } catch (error) {
    summary.failures.push({ phase: 'database-cleanup', message: error.message })
  }
}

async function main() {
  fs.mkdirSync(runDir, { recursive: true })
  try {
    await verifyInfrastructure()
    writeSummary()
    if (!runEnabled) {
      console.log('Read-only recovery preflight passed. To run isolated backend scenarios, pass --run.')
      return
    }
    await createScratchDatabase()
    await applyRequiredMigrations()
    await runAcceptance()
  } catch (error) {
    summary.failures.push({ phase: runEnabled ? 'acceptance' : 'preflight', message: error.message })
    throw error
  } finally {
    if (runEnabled) await cleanupOwnedResources()
    writeSummary()
  }
  if (summary.failures.length) throw new Error('recovery acceptance failed; see ' + summaryPath)
  console.log('PASS: dual-instance duplicate/lost notification, durable log compensation, reconnect, multi-page sync, real log-gap snapshot, and concurrent consistency.')
  console.log('Evidence: ' + summaryPath)
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
