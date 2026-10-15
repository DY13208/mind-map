const { fork } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { configureIsolatedEnvironment } = require('./isolation.cjs')
const repo = path.resolve(__dirname, '../..')
const proxyModule = require(path.join(repo, 'web/node_modules/http-proxy'))
const fixtureBoundaries = {
  business: 'Real room ACL/PG, native business HTTP and Socket handlers, PostgresBus and complete webpack App/plugins',
  authentication: 'Explicit synthetic performance-owner transport identity; room_members authorization remains real',
  bootstrap: 'Owned Node20 child/control endpoint and loopback proxy; fixture /api/health readiness response and runtime-config.js gateway/V2 flags',
  health: 'The native health endpoint itself is not validated by this matrix. Separate existing MCP smoke uses its actual health API.',
  network: 'Owned loopback business HTTP/native WebSocket; external application HTTP/WS blocked. No enterprise OAuth, WAN latency or real attachment upload/download claim.'
}

async function application(phase) {
  configureIsolatedEnvironment()
  const child = fork(path.join(__dirname, 'online-server-child.cjs'), [phase === 'before' ? 'baseline' : 'current'], {
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
    if (pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    }
  })
  child.once('exit', code => readyResolve({ error: 'Test app exited ' + code }))
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
  return { ...started, control, logs,
    async close() {
      if (child.exitCode !== null) return
      const exited = new Promise(resolve => child.once('exit', resolve))
      try {
        await control('stop')
        await timed(exited, 'Owned application cleanup timeout')
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM')
      }
    }
  }
}

async function webServer(app, artifact) {
  const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  const proxy = proxyModule.createProxyServer({ target: app.base, ws: true })
  proxy.on('error', (error, req, res) => {
    if (res && res.writeHead && !res.headersSent) res.writeHead(502)
    if (res && res.end) res.end('Owned fixture proxy error')
  })
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname)
    if (pathname.startsWith('/api/') || pathname.startsWith('/collab-v2')) return proxy.web(req, res)
    if (pathname === '/runtime-config.js') {
      res.setHeader('content-type', 'application/javascript')
      res.end('window.__MIND_MAP_RUNTIME__={gateway:true,collabV2:true,publicPath:"/"};')
      return
    }
    let file = path.resolve(artifact, '.' + pathname)
    if (!file.startsWith(artifact + path.sep) && file !== artifact) { res.statusCode = 400; res.end(); return }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(artifact, 'index.html')
    res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  // closeAllConnections excludes upgraded WebSockets. Track only connections
  // accepted by this owned ephemeral proxy, so failure cleanup can release
  // those transports without touching any other browser or application's TCP.
  const acceptedSockets = new Set()
  server.on('connection', socket => {
    acceptedSockets.add(socket)
    socket.once('close', () => acceptedSockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const closed = new Promise(resolve => server.close(resolve))
      proxy.close()
      server.closeAllConnections()
      for (const socket of acceptedSockets) socket.destroy()
      await closed
    }
  }
}

async function startFixture({ phase = 'before', instances = 1 } = {}) {
  if (!['before', 'after'].includes(phase) || ![1, 2].includes(instances)) throw new Error('Unsupported online matrix')
  const artifact = process.env.PERF_TDD_E2E_ARTIFACT
    ? path.join(repo, 'work/performance-tdd', process.env.PERF_TDD_E2E_ARTIFACT)
    : path.join(repo, 'work/performance-tdd', phase === 'before' ? 'baseline-web' : 'after-web')
  if (!fs.existsSync(path.join(artifact, 'index.html'))) throw new Error('BLOCKED_ENV: Node20 web artifact missing for ' + phase)
  const apps = [], fronts = []
  try {
    for (let i = 0; i < instances; i++) {
      const app = await application(phase); apps.push(app)
      fronts.push(await webServer(app, artifact))
    }
    const seed = await apps[0].control('seed')
    if (process.env.PERF_TDD_ONLINE_DIAGNOSTIC === '1') console.log(JSON.stringify({ stage: 'fixture-ready', phase, instances, ...seed }))
    const hashes = fs.readdirSync(path.join(artifact, 'js')).filter(name => name.endsWith('.js')).map(name => {
      const content = fs.readFileSync(path.join(artifact, 'js', name))
      return [name, crypto.createHash('sha256').update(content).digest('hex')]
    })
    return { phase, instances, apps, fronts, ...seed, artifact, bundleHashes: hashes, fixtureBoundaries,
      async close() { for (const front of fronts) await front.close(); for (const app of apps.reverse()) await app.close() }
    }
  } catch (error) {
    for (const front of fronts) await front.close().catch(() => {})
    for (const app of apps.reverse()) await app.close().catch(() => {})
    throw error
  }
}
module.exports = { startFixture, repo, fixtureBoundaries }
