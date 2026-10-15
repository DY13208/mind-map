"use strict"
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const { fork } = require('node:child_process')
const { gateBrowser } = require('./safeload-browser-gate.cjs')
const { cleanupAll } = require('./safeload-cleanup.cjs')
const { readConfig, withIsolatedPg } = require('./isolation.cjs')
const root = path.resolve(__dirname, '../..')
const node = path.join(root, 'work/performance-tdd/runtime/node_modules/node/bin/node')
const preload = path.join(__dirname, 'safeload-isolated-preload.cjs')
const artifact = path.join(root, 'work/performance-tdd/after-web-final26')
const baseEvidence = path.join(root, 'work/performance-tdd/safeload-acceptance')
const { Pool } = require(path.join(root, 'simple-mind-map/node_modules/pg'))
const proxyApi = require(path.join(root, 'web/node_modules/http-proxy'))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
  finally { clearTimeout(timer) }
}
function assertFrozen() {
  const prior = JSON.parse(fs.readFileSync('/Users/seven/Documents/Codex/2026-10-13/https-github-com-dy13208-mind-map/outputs/timeout-investigation/codex-final26-acceptance.json', 'utf8'))
  for (const row of prior.productionFiles) assert.equal(hash(path.join(root, row.file)), row.sha256, 'final26 source drift: ' + row.file)
  for (const row of prior.assets) assert.equal(hash(path.join(artifact, row.file)), row.sha256, 'final26 asset drift: ' + row.file)
  return { productionFiles: prior.productionFiles.length, assets: prior.assets.length }
}
async function fingerprint(pool) {
  const result = {}
  for (const table of ['rooms', 'room_nodes', 'wecom_users', 'auth_sessions']) {
    if (!(await pool.query('select to_regclass($1) as table_name', [table])).rows[0].table_name) { result[table] = null; continue }
    const row = (await pool.query(`select count(*)::int as count, md5(coalesce(string_agg(signature,'' order by signature),'')) as fingerprint from (select md5(row_to_json(t)::text) as signature from ${table} t) q`)).rows[0]
    result[table] = row
  }
  return result
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  try { process.kill(-child.pid, 'SIGTERM') } catch (_) { child.kill('SIGTERM') }
  try { await bounded(exited, 10000, 'child stop timeout') }
  catch (_) {
    try { process.kill(-child.pid, 'SIGKILL') } catch (_) { child.kill('SIGKILL') }
    await bounded(exited, 5000, 'child kill timeout')
  }
}
async function fixture() {
  const frozen = assertFrozen(), config = readConfig()
  const runId = crypto.randomBytes(8).toString('hex'), database = 'safeload_acceptance_' + runId
  assert.match(database, /^safeload_acceptance_[0-9a-f]{16}$/)
  const runDir = path.join(baseEvidence, 'run-' + runId)
  fs.mkdirSync(runDir, { recursive: true })
  const tempDir = path.join(runDir, 'tmp')
  fs.mkdirSync(tempDir)
  const devKey = crypto.randomBytes(32).toString('hex'), sessionKey = crypto.randomBytes(32).toString('hex')
  const mcpKey = crypto.randomBytes(32).toString('hex'), wecomSecret = crypto.randomBytes(32).toString('hex')
  const secrets = [devKey, sessionKey, mcpKey, wecomSecret, config.pg.password]
  const clean = text => secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text))
  let admin, own, front, proxy, server, created = false, stopped = false
  const served = {}, sockets = new Set(), serverLogs = []
  const receipt = { runId, database, frozen, legacySourceSha256: hash(path.join(root, 'simple-mind-map/test/safeLoad.partialChildren.p0.test.js')),
    runnerSha256: hash(__filename), preloadSha256: hash(preload), startedAt: new Date().toISOString(),
    isolation: { hostSentinelChecked: false, separateRunDatabase: true, noRootEnv: true, noTestAclShim: true,
      devBypassAllowPublic: false, secrets: 'random in-memory env only; redacted from logs', backend: 'real collabServer.js', artifact: 'after-web-final26' } }
  const save = () => fs.writeFileSync(path.join(runDir, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  async function cleanup() {
    if (stopped) return
    stopped = true
    const errors = []
    try { await stopProcess(server) } catch (error) { errors.push(clean(error.message)) }
    if (front) {
      const closed = new Promise(resolve => front.close(resolve))
      if (proxy) proxy.close()
      front.closeAllConnections(); for (const socket of sockets) socket.destroy()
      await bounded(closed, 5000, 'front close timeout').catch(error => errors.push(error.message))
    }
    if (created) {
      try {
        if (!own) own = new Pool({ ...config.pg, database, max: 2 })
        const value = (await own.query('select identity from safeload_test_identity where singleton')).rows[0]
        assert.equal(value && value.identity, runId, 'temporary DB ownership mismatch')
        receipt.cleanup = { ownershipIdentityMatched: true,
          ownedRooms: (await own.query("select to_regclass('rooms') as table_name")).rows[0].table_name
            ? Number((await own.query("select count(*)::int as count from rooms")).rows[0].count) : 0 }
        await own.end(); own = null
        await admin.query(`drop database "${database}" with (force)`)
        receipt.cleanup.databaseDropped = true
      } catch (error) { errors.push(clean(error.message)) }
    }
    if (admin) {
      try {
        receipt.hostAfter = await fingerprint(admin)
        receipt.hostUnchanged = JSON.stringify(receipt.hostBefore) === JSON.stringify(receipt.hostAfter)
        if (!receipt.hostUnchanged) errors.push('preexisting host fixture changed')
      } finally { await admin.end() }
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
    receipt.temporaryProfilesRemoved = true
    for (const role of ['server', 'legacy']) {
      const file = path.join(runDir, 'env-guard-' + role + '.json')
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).blockedEnvReads !== 0) errors.push('forbidden repository env access: ' + role)
    }
    const egress = path.join(runDir, 'server-egress-guard.json')
    if (fs.existsSync(egress)) {
      receipt.serverEgressGuard = JSON.parse(fs.readFileSync(egress, 'utf8'))
      if (receipt.serverEgressGuard.blocked.length) errors.push('backend attempted unexpected non-loopback egress')
    }
    receipt.cleanupErrors = errors
    receipt.finishedAt = new Date().toISOString()
    receipt.finalFrozen = assertFrozen()
    receipt.servedAssets = served
    save()
    fs.writeFileSync(path.join(runDir, 'server.log'), clean(serverLogs.join('')))
    if (errors.length) throw new Error('SafeLoad cleanup failed: ' + errors.join('; '))
  }
  try {
    await withIsolatedPg(async () => {})
    receipt.isolation.hostSentinelChecked = true
    admin = new Pool({ ...config.pg, max: 2 })
    receipt.hostBefore = await fingerprint(admin)
    await admin.query(`create database "${database}"`); created = true
    own = new Pool({ ...config.pg, database, max: 2 })
    await own.query('create table safeload_test_identity(singleton boolean primary key default true check(singleton), identity text not null)')
    await own.query('insert into safeload_test_identity(identity) values($1)', [runId])
    let backendBase = null
    front = http.createServer((req, res) => {
      let pathname = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname)
      if (pathname.startsWith('/api/') || pathname.startsWith('/collab-v2')) {
        if (!backendBase) { res.writeHead(503); res.end('fixture starting'); return }
        return proxy.web(req, res)
      }
      if (pathname === '/runtime-config.js') { res.setHeader('content-type', 'application/javascript'); res.end('window.__MIND_MAP_RUNTIME__={gateway:true,collabV2:true,publicPath:"/"};'); return }
      if (pathname.startsWith('/dist/')) pathname = pathname.slice(5)
      let filename = path.resolve(artifact, '.' + pathname)
      if (!filename.startsWith(artifact + path.sep) && filename !== artifact) { res.writeHead(400); res.end(); return }
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) filename = path.join(artifact, 'index.html')
      served[path.relative(artifact, filename)] = { bytes: fs.statSync(filename).size, sha256: hash(filename) }
      const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
      res.setHeader('content-type', mime[path.extname(filename)] || 'application/octet-stream'); fs.createReadStream(filename).pipe(res)
    })
    front.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    front.on('upgrade', (req, socket, head) => { if (proxy) proxy.ws(req, socket, head); else socket.destroy() })
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + front.address().port
    const env = { PATH: path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: tempDir + path.sep,
      MIND_MAP_SKIP_ROOT_ENV: '1', PERF_TDD_ISOLATED: '1', PGHOST: '127.0.0.1', PGPORT: String(config.pg.port), PGDATABASE: database,
      PGUSER: config.pg.user, PGPASSWORD: config.pg.password, PGAPPNAME: 'safeload-acceptance-' + runId,
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production', COLLAB_V2: '1', COLLAB_OUTBOX_PUBLISHER: '0', COLLAB_EVENT_BUS: 'postgres',
      KNOWLEDGE_COMPILER_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false',
      YIRAN_UPSTREAM: 'http://127.0.0.1:9', JOBHUB_UPSTREAM: 'http://127.0.0.1:9', BRIDGE_UPSTREAM: 'http://127.0.0.1:9', COGNEE_API: 'http://127.0.0.1:9',
      WECOM_AUTH_ENABLED: '1', ONEID_AUTH_ENABLED: '0', WORKBUDDY_AUTH_ENABLED: '0',
      WECOM_CORP_ID: 'wwsafeload' + runId, WECOM_AGENT_ID: '1', WECOM_SECRET: wecomSecret,
      WECOM_REDIRECT_URI: origin + '/api/auth/wecom/callback', AUTH_APP_ORIGIN: origin, AUTH_ALLOWED_ORIGINS: origin,
      AUTH_SESSION_SECRET: sessionKey, MCP_TOKEN: mcpKey, AUTH_DEV_BYPASS_KEY: devKey, AUTH_DEV_BYPASS_ALLOW_PUBLIC: '0',
      AUTH_DEV_BYPASS_USER_ID: 'safeload-' + runId, AUTH_DEV_BYPASS_USER_NAME: 'SafeLoad synthetic owner',
      PERF_SAFE_RUN_DIR: runDir, PERF_SAFE_ROLE: 'server' }
    server = fork(path.join(root, 'simple-mind-map/bin/collabServer.js'), [], {
      execPath: node, execArgv: ['--require', preload], cwd: root, env, detached: true, stdio: ['ignore','pipe','pipe','ipc']
    })
    server.stdout.on('data', chunk => serverLogs.push(clean(chunk))); server.stderr.on('data', chunk => serverLogs.push(clean(chunk)))
    backendBase = await bounded(new Promise((resolve, reject) => {
      server.on('message', message => { if (message.safeReady) resolve(message.base) })
      server.once('exit', code => reject(new Error('real server exited before readiness: ' + code)))
    }), 60000, 'real server startup timeout')
    proxy = proxyApi.createProxyServer({ target: backendBase, ws: true })
    proxy.on('error', (error, req, res) => { if (res && res.writeHead && !res.headersSent) res.writeHead(502); if (res && res.end) res.end('isolated proxy failed') })
    receipt.origin = origin; receipt.backendBase = backendBase
    const me = await fetch(origin + '/api/auth/me'); const meBody = await me.json()
    const anonymous = await fetch(origin + '/api/files')
    assert.equal(meBody.enabled, true); assert.equal(meBody.authenticated, false); assert.equal(anonymous.status, 401)
    const postLogin = key => fetch(origin + '/api/auth/dev-login', { method: 'POST', headers: { 'content-type':'application/json', Origin: origin }, body: JSON.stringify({ key }) })
    const missing = await postLogin(''), invalid = await postLogin('invalid-synthetic-key'), valid = await postLogin(devKey)
    assert.equal(missing.status, 401); assert.equal(invalid.status, 401); assert.equal(valid.status, 200)
    const cookie = String(valid.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie, 'real auth cookie missing')
    const authenticated = await fetch(origin + '/api/files', { headers: { Cookie: cookie, Origin: origin } })
    assert.equal(authenticated.status, 200)
    receipt.authentication = { enabled: true, anonymousStatus: anonymous.status, missingKeyStatus: missing.status, invalidKeyStatus: invalid.status,
      validKeyStatus: valid.status, sessionCookieReceived: true, authenticatedFilesStatus: authenticated.status }
    save()
    return { runDir, env: { ...env, PERF_SAFE_ROLE: 'legacy', C2_BROWSER_ORIGIN: origin, COLLAB_TEST_BASE_URL: origin, ORIGIN: origin,
      PERF_SAFE_ALLOWED_ORIGINS: JSON.stringify([origin, backendBase]) }, receipt, save, clean, cleanup, own, origin }
  } catch (error) {
    receipt.setupError = clean(error.stack || error)
    await cleanup().catch(cleanupError => { receipt.cleanupError = clean(cleanupError.message); save() })
    throw Object.assign(error, { runDir })
  }
}
async function finishRun(legacy, f, logs, filename = 'legacy.log') {
  await cleanupAll([
    () => stopProcess(legacy),
    () => { if (f) fs.writeFileSync(path.join(f.runDir, filename), f.clean(logs.join(''))) },
    async () => { if (f) await f.cleanup() }
  ])
}
async function main() {
  let f, legacy
  const logs = []
  try {
    f = await fixture()
    const entry = path.join(root, 'simple-mind-map/test/safeLoad.partialChildren.p0.test.js')
    const logPath = path.join(f.runDir, 'legacy.log')
    fs.writeFileSync(logPath, '', { flag: 'wx' })
    legacy = fork(entry, [], { execPath: node, execArgv: ['--require', preload], cwd: root, env: f.env, detached: true, stdio: ['ignore','pipe','pipe','ipc'] })
    const capture = chunk => { const text = String(chunk); logs.push(text); const stages = text.match(/PARENT_COMPARE|INSERT_CASE|DEPTH_CREATE|DEPTH_F5|LOCAL_RUN_FAIL|STATUS|SKIP/g); if (stages) console.log(JSON.stringify({ progress: stages, at: new Date().toISOString() })) }
    legacy.stdout.on('data', capture); legacy.stderr.on('data', capture)
    const result = await bounded(new Promise(resolve => legacy.once('exit', (code, signal) => resolve({ code, signal }))), 900000, 'complete SafeLoad script exceeded total fixture budget')
    const skipped = /SAFE_LOAD_PARTIAL: SKIP/.test(logs.join(''))
    f.receipt.legacy = { ...result, skipped, entrySha256: hash(entry), reportWritten: fs.existsSync(path.join(f.runDir, 'legacy-report.json')) }
    f.save()
    assert.equal(result.code, 0, 'legacy SafeLoad script failed; see ' + f.runDir)
    assert.equal(skipped, false, 'SafeLoad SKIP is not acceptance')
    assert.equal(f.receipt.legacy.reportWritten, true, 'legacy success report missing')
    const report = JSON.parse(fs.readFileSync(path.join(f.runDir, 'legacy-report.json'), 'utf8'))
    assert.equal(report.localRuns.total, 10); assert.equal(report.localRuns.pass, 10); assert.equal(report.LOCAL_P0_FIXED, 'YES')
    f.receipt.browserGate = gateBrowser(JSON.parse(fs.readFileSync(path.join(f.runDir, 'browser-observations.json'), 'utf8')))
    f.receipt.status = 'LEGACY_ALL_ASSERTIONS_PASS_NO_SKIP'; f.save()
    console.log(JSON.stringify({ runDir: f.runDir, status: f.receipt.status, localRuns: report.localRuns }))
  } catch (error) {
    if (f) { f.receipt.status = 'FAILED'; f.receipt.error = f.clean(error.stack || error); f.save() }
    console.error(JSON.stringify({ status: 'FAILED', runDir: f && f.runDir || error.runDir, error: f ? f.clean(error.message) : error.message }))
    process.exitCode = 1
  } finally {
    await finishRun(legacy, f, logs)
  }
}
module.exports = { fixture, stopProcess, finishRun, bounded, root, node, preload, assertFrozen }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
