// Test-only boundary: real production HTTP/SQL, explicit isolated PG identity.
const assert = require('node:assert/strict')
const http = require('node:http')
const { fork } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const isolation = require('../../tests/performance/isolation.cjs')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function timeout(promise, label, ms = 10000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })
  ]).finally(() => clearTimeout(timer))
}

function installObservation(storage) {
  const { Client } = require('pg')
  const crypto = require('node:crypto')
  const originalQuery = Client.prototype.query
  const originalHash = crypto.createHash
  const originalSnapshot = storage.getRoomSnapshot
  let state
  let barrier = null
  function reset() {
    state = { snapshotCalls: 0, fullTreeHashes: 0, sql: [] }
  }
  reset()
  async function observe(result, sql, values) {
    const normalized = String(sql || '').replace(/\s+/g, ' ').trim()
    state.sql.push({ sql: normalized, rows: result && result.rows ? result.rows.length : 0 })
    if (barrier && !barrier.fired && Array.isArray(values) && values.includes(barrier.roomKey) &&
        /\bfrom rooms\b/i.test(normalized) && result && result.rows &&
        result.rows.some(row => Object.hasOwn(row, 'version'))) {
      barrier.fired = true
      barrier.entered.resolve()
      await barrier.release.promise
    }
    return result
  }
  Client.prototype.query = function observedQuery(...args) {
    const config = args[0]
    const sql = typeof config === 'string' ? config : config && config.text
    const values = Array.isArray(args[1]) ? args[1] : config && config.values
    const callbackIndex = args.findLastIndex(item => typeof item === 'function')
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex]
      args[callbackIndex] = (error, result) => {
        if (error) return callback(error, result)
        observe(result, sql, values).then(value => callback(null, value), callback)
      }
      return originalQuery.apply(this, args)
    }
    const result = originalQuery.apply(this, args)
    return result && typeof result.then === 'function'
      ? result.then(value => observe(value, sql, values)) : result
  }
  crypto.createHash = function observedHash(...args) {
    if (String(new Error().stack).includes('bin/roomNodes.js')) state.fullTreeHashes += 1
    return originalHash.apply(this, args)
  }
  storage.getRoomSnapshot = function observedSnapshot(...args) {
    state.snapshotCalls += 1
    return originalSnapshot.apply(this, args)
  }
  return {
    reset,
    trace: () => JSON.parse(JSON.stringify(state)),
    arm(roomKey) { barrier = { roomKey, fired: false, entered: deferred(), release: deferred() } },
    entered: () => timeout(barrier.entered.promise, 'room revision read barrier was not reached'),
    release() { if (barrier) barrier.release.resolve() },
    restore() {
      this.release()
      Client.prototype.query = originalQuery
      crypto.createHash = originalHash
      storage.getRoomSnapshot = originalSnapshot
    }
  }
}

function graphFixture(size = 1000) {
  const graph = {}
  const node = (uid, children = [], data = {}) => {
    graph[uid] = { isRoot: uid === 'root', data: { uid, text: uid, ...data }, children }
  }
  node('root', ['target', 'unrelated'])
  node('target', ['child-0', 'child-1', 'child-2', 'child-3', 'child-4'], {
    note: 'kept note', tags: ['business'], image: 'https://example.invalid/image.png',
    imageSize: { width: 20, height: 10 }, attachmentId: 'synthetic-attachment',
    imgMap: { original: 'synthetic-heavy-data' }
  })
  for (let i = 0; i < 5; i++) {
    node('child-' + i, ['grand-' + i + '-0', 'grand-' + i + '-1'])
    node('grand-' + i + '-0')
    node('grand-' + i + '-1')
  }
  node('unrelated')
  let allocated = Object.keys(graph).length
  while (allocated < size) {
    const uid = 'unrelated-' + graph.unrelated.children.length
    graph.unrelated.children.push(uid)
    node(uid)
    allocated += 1
  }
  const { canonicalizeNodes } = require('../bin/roomNodes')
  const canonical = canonicalizeNodes(graph)
  assert.equal(canonical.ok, true)
  return canonical.nodes
}

async function request(base, pathname, options = {}) {
  const { body, actor = 'performance-owner', mcpPrincipal, ...rest } = options
  const response = await fetch(new URL(pathname, base), {
    ...rest,
    headers: {
      'content-type': 'application/json', 'x-performance-actor': actor,
      ...(mcpPrincipal ? { 'x-performance-mcp-principal': mcpPrincipal } : {}),
      ...(options.headers || {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  return { status: response.status, body: raw ? JSON.parse(raw) : null }
}

async function createHarness(options = {}) {
  isolation.configureIsolatedEnvironment()
  isolation.assertIsolatedEnvironment()
  Object.assign(process.env, {
    COLLAB_V2: '1', COLLAB_V2_EVENT_BRIDGE: '1', COLLAB_MCP_DIRECT: '1',
    COLLAB_HTTP_DIRECT: '1', COLLAB_NODE_COUNT_CACHE: '1', COLLAB_NODE_COUNT_CACHE_WRITERS_READY: '1',
    COLLAB_TEST_ACL: '1', WECOM_AUTH_ENABLED: '0', ONEID_AUTH_ENABLED: '0',
    WORKBUDDY_AUTH_ENABLED: '0', KNOWLEDGE_COMPILER_ENABLED: 'false',
    WIKI_COMPILER_SYNC_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false'
  })
  const storage = require('../bin/storage')
  const acl = require('../bin/roomAcl')
  const pool = storage.getPool()
  await isolation.withIsolatedPg(async guardedPool => {
    assert.equal(pool.options.database, guardedPool.options.database)
    assert.equal(Number(pool.options.port), Number(guardedPool.options.port))
    if (options.initialize !== false) await storage.initSchema()
  })
  const observer = installObservation(storage)
  const rooms = new Set()
  const server = http.createServer((req, res) => {
    // Synthetic trusted identity at the transport boundary; real room ACL runs.
    const allowed = new Set(['performance-owner', 'performance-viewer', 'performance-outsider'])
    const actor = String(req.headers['x-performance-actor'] || 'performance-owner')
    req.authUser = { id: allowed.has(actor) ? actor : 'performance-outsider', name: 'Synthetic test actor' }
    req.forceAcl = true
    const principal = String(req.headers['x-performance-mcp-principal'] || '')
    if (['performance-owner', 'performance-viewer'].includes(principal)) {
      req.verifiedMcpSource = { principalId: principal, kind: 'user' }
    }
    if (req.headers['x-performance-drop-response'] === '1') {
      // Deliberately lose only the transport response, after production commit.
      res.end = function loseCommittedResponse() { res.destroy() }
    }
    Promise.resolve(storage.handleApi(req, res)).then(handled => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'TEST_ROUTE_NOT_FOUND' }))
      }
    }).catch(error => {
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: error.code || 'TEST_HTTP_ERROR', error: error.message }))
    })
  })
  let bus = null
  let collab = null
  let dropNotifications = false
  if (options.sockets) {
    bus = require('../bin/eventBus').createPostgresBus(pool)
    const subscribe = bus.subscribe.bind(bus)
    bus.subscribe = listener => subscribe(event => {
      if (!dropNotifications) return listener(event)
    })
    await bus.start()
    collab = require('../bin/collabV2/socketServer').attachCollabV2(server, { eventBus: bus })
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const base = 'http://127.0.0.1:' + server.address().port
  return {
    storage, pool, observer, base,
    dropNotifications(value) { dropNotifications = !!value },
    async seed(size = 1000, customGraph) {
      const roomKey = 'performance-backend-' + randomUUID()
      rooms.add(roomKey)
      const graph = customGraph || graphFixture(size)
      await storage.upsertRoom(roomKey, 'Synthetic performance fixture', { nodes: graph })
      await pool.query('update rooms set version = 7 where room_key = $1', [roomKey])
      await pool.query(
        `insert into room_members(room_key,user_id,role,direct_role,source)
         values ($1,'performance-owner','owner','owner','direct_share'),
                ($1,'performance-viewer','viewer','viewer','direct_share')`, [roomKey]
      )
      observer.reset()
      return { roomKey, graph, version: 7 }
    },
    async counters(roomKey) {
      const result = await pool.query(
        `select version,
          coalesce((to_jsonb(rooms)->>'node_counts_generation')::bigint,0) as counts_generation,
          (select count(*)::int from room_operations where room_key=$1) as operations,
          (select count(*)::int from room_outbox where room_key=$1) as outbox
         from rooms where room_key=$1`, [roomKey]
      )
      return result.rows[0]
    },
    async close() {
      observer.release()
      if (collab) await collab.stop()
      if (collab && collab.io) await new Promise(resolve => collab.io.close(resolve))
      else await new Promise(resolve => server.close(resolve))
      if (bus) await bus.close()
      observer.restore()
      for (const roomKey of rooms) {
        for (const table of ['room_outbox', 'room_operations', 'room_operations_archive', 'room_snapshots']) {
          await pool.query(`delete from ${table} where room_key=$1`, [roomKey])
        }
        await pool.query('delete from rooms where room_key=$1', [roomKey])
      }
      await pool.end()
    }
  }
}

async function isolatedInstance(options = {}) {
  const child = fork(__filename, ['--server'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PERFORMANCE_BACKEND_SOCKETS: options.sockets ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let sequence = 0
  const pending = new Map()
  const ready = deferred()
  const logs = []
  child.stdout.on('data', chunk => logs.push(String(chunk)))
  child.stderr.on('data', chunk => logs.push(String(chunk)))
  child.on('message', message => {
    if (message.ready) ready.resolve(message)
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    }
  })
  child.once('exit', code => { if (code) ready.resolve({ error: 'isolated app exited ' + code }) })
  const started = await timeout(ready.promise, 'isolated application did not start', 30000)
  if (started.error) throw new Error(started.error + '\n' + logs.join('').slice(-4000))
  async function control(action, data = {}) {
    const id = ++sequence
    const waiting = new Promise(resolve => pending.set(id, resolve))
    child.send({ id, action, ...data })
    const result = await timeout(waiting, 'isolated application control timeout: ' + action)
    if (result.error) throw new Error(result.error)
    return result.value
  }
  return { base: started.base, control, logs,
    async close() {
      if (child.exitCode !== null) return
      await control('stop')
      await timeout(new Promise(resolve => child.once('exit', resolve)), 'isolated application did not stop')
    }
  }
}

if (require.main === module && process.argv[2] === '--server') {
  createHarness({ initialize: false, sockets: process.env.PERFORMANCE_BACKEND_SOCKETS === '1' }).then(app => {
    process.send({ ready: true, base: app.base })
    process.on('message', async message => {
      try {
        let value
        if (message.action === 'reset') app.observer.reset()
        else if (message.action === 'trace') value = app.observer.trace()
        else if (message.action === 'env') Object.assign(process.env, message.values)
        else if (message.action === 'dropNotifications') app.dropNotifications(message.value)
        else if (message.action === 'maintenanceReplace') {
          await app.storage.replaceRoomNodes(message.roomKey, message.graph, message.version)
        } else if (message.action === 'stop') {
          await app.close()
          process.send({ id: message.id, value: true }, () => process.exit(0))
          return
        } else throw new Error('unknown test control')
        process.send({ id: message.id, value })
      } catch (error) { process.send({ id: message.id, error: error.message }) }
    })
  }).catch(error => { process.send({ ready: true, error: error.message }); process.exit(1) })
}

module.exports = { createHarness, graphFixture, request, isolatedInstance, timeout }
