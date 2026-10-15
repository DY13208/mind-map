// Runs the existing HTTP MCP smoke against owned loopback services only.
// Authentication is the product's test-only MCP service token; no root .env.
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const { withIsolatedPg } = require('./isolation.cjs')
const repo = path.resolve(__dirname, '../..')
const children = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let proxy

async function freePort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function start(file, args, env) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: path.join(repo, 'simple-mind-map'), env, stdio: ['ignore', 'pipe', 'pipe']
  })
  // Never echo child environment or logs containing configuration.
  child.stdout.resume()
  child.stderrTail = ''
  child.stderr.on('data', chunk => {
    let value = String(chunk)
    for (const secret of [env.MCP_TOKEN, env.PGPASSWORD, env.REDIS_URL]) {
      if (secret) value = value.split(secret).join('[redacted]')
    }
    child.stderrTail = (child.stderrTail + value).slice(-1600)
  })
  child.fixtureFile = file
  children.push(child)
  return child
}

async function ready(base, child, endpoint, bridge = false) {
  const until = Date.now() + 45000
  let lastState = null
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, `Owned smoke service ${child.fixtureFile} exited before readiness: ${child.stderrTail}`)
    try {
      const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(3000) })
      const data = await response.json()
      lastState = { httpStatus: response.status, ok: data.ok, collabV2: data.collabV2,
        eventBridge: { enabled: data.eventBridge?.enabled, listenerHealthy: data.eventBridge?.listenerHealthy } }
      // This owned database also holds deliberate failure/outbox fixtures from
      // other regressions. Global backlog alerts are separate from the native
      // bridge readiness that this existing smoke needs.
      if (response.ok && (bridge ? data.collabV2 && data.eventBridge?.enabled && data.eventBridge?.listenerHealthy : data.ok)) return lastState
    } catch (_) {}
    await delay(100)
  }
  throw new Error(`BLOCKED_ENV: owned smoke service ${child.fixtureFile} did not become ready: ${JSON.stringify(lastState)}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

async function main() {
  await withIsolatedPg(async pool => {
    const runId = randomUUID()
    const ports = await Promise.all([freePort(), freePort(), freePort()])
    assert.equal(new Set(ports).size, 3, 'Ephemeral smoke ports must be distinct')
    const bases = ports.map(port => `http://127.0.0.1:${port}`)
    const env = { ...process.env,
      NODE_PATH: path.join(repo, 'tests/mcp-incremental/node_modules'),
      MCP_TOKEN: randomBytes(32).toString('hex'), COLLAB_V2_EVENT_BRIDGE: '1',
      COLLAB_EVENT_BUS: 'postgres', COLLAB_OUTBOX_PUBLISHER: '0',
      COLLAB_HTTP_DIRECT: '1', COLLAB_MCP_DIRECT: '1',
      PGAPPNAME: `mindmap-owned-mcp-smoke-${runId}`, HOST: '127.0.0.1'
    }
    const a = start('bin/collabServer.js', [], { ...env, PORT: String(ports[0]) })
    // Existing initSchema DDL is not safe to run concurrently. Match the
    // product's existing two-instance regression's sequential startup.
    const healthA = await ready(bases[0], a, '/api/health', true)
    const b = start('bin/collabServer.js', [], { ...env, PORT: String(ports[1]) })
    const healthB = await ready(bases[1], b, '/api/health', true)
    const mcp = start('bin/mcpServer.mjs', ['--http'], { ...env,
      MIND_MAP_API: bases[0], MCP_HOST: '127.0.0.1', MCP_PORT: String(ports[2]),
      MCP_CLIENT_ID: `owned-smoke-${runId}`
    })
    await ready(bases[2], mcp, '/health')
    proxy = http.createServer((req, res) => {
      const target = new URL(req.url, req.url.split('?')[0] === '/mcp' ? bases[2] : bases[0])
      const upstream = http.request(target, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers)
        response.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(upstream)
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const baseA = `http://127.0.0.1:${proxy.address().port}`
    const smoke = spawn(process.execPath, [path.join(repo, 'tests/mcp-incremental/smoke.mjs')], {
      cwd: repo, env: { ...env, MCP_BASELINE_APP_A: baseA, MCP_BASELINE_APP_B: bases[1], MCP_BASELINE_MCP_TOKEN: env.MCP_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(smoke)
    let raw = '', stderr = ''
    smoke.stdout.on('data', value => { raw += String(value) })
    smoke.stderr.on('data', value => { stderr += String(value) })
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => smoke.kill('SIGKILL'), 120000)
      smoke.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    assert.equal(exit.code, 0, `Existing MCP smoke failed (${exit.code}, ${exit.signal}): ${stderr.slice(-2000)}`)
    const result = raw.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch (_) { return null } }).find(row => row?.ok && row.roomKey)
    assert.ok(result?.appBSharedRead, 'Smoke did not prove shared PostgreSQL read')
    assert.match(result.roomKey, /^mcp-incremental-smoke-[a-f0-9-]+$/)
    const stored = await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and deleted_at is null', [result.roomKey])
    assert.equal(stored.rows[0].n, 2, 'Smoke node must be durable in the owned PostgreSQL fixture')
    console.log(JSON.stringify({ runId, runtime: process.version, existingSmoke: 'PASS', nodeCount: stored.rows[0].n, appBSharedRead: true, roomKey: result.roomKey, healthA, healthB, scope: '2 real collabServer processes + native HTTP MCP + isolated PG; service token auth; deliberate fixture backlog alerts are not production health acceptance' }))
  })
}

main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(async () => {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
  for (const child of children.reverse()) await stop(child)
})
