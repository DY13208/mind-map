const assert = require('assert')
const http = require('http')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const path = require('path')

// The baseline test install includes the one renderer dependency omitted from
// the desktop checkout's older node_modules tree.
const Module = require('module')
const baselineNodeModules = path.resolve(__dirname, '../../tests/mcp-incremental/node_modules')
process.env.NODE_PATH = [process.env.NODE_PATH, baselineNodeModules].filter(Boolean).join(path.delimiter)
Module._initPaths()

// This integration test is intentionally pinned to the isolated baseline
// containers. It never loads the repository .env or a developer database.
const TEST_ENV = {
  MIND_MAP_SKIP_ROOT_ENV: '1',
  PGHOST: '127.0.0.1',
  PGPORT: '25492',
  PGDATABASE: 'mcp_incremental_test',
  PGUSER: 'mcp_test',
  PGPASSWORD: 'mcp-incremental-test-db-password',
  PGAPPNAME: 'mcp-incremental-bridge-integration',
  REDIS_URL: 'redis://127.0.0.1:16389',
  COLLAB_EVENT_BUS: 'redis',
  COLLAB_V2: '1',
  COLLAB_V2_EVENT_BRIDGE: '1',
  COLLAB_OUTBOX_PUBLISHER: '1',
  COLLAB_OUTBOX_POLL_MS: '50',
  COLLAB_RATE_LIMIT_PER_ROOM: '800',
  COLLAB_RATE_LIMIT_GLOBAL: '8000',
  MCP_TOKEN: 'mcp-incremental-test-only-token-0160b5a7',
  WECOM_AUTH_ENABLED: '0',
  ONEID_AUTH_ENABLED: '0',
  WORKBUDDY_AUTH_ENABLED: '0',
  KNOWLEDGE_COMPILER_ENABLED: 'false',
  WIKI_COMPILER_SYNC_ENABLED: 'false',
  DOCMOST_SYNC_ENABLED: 'false',
  YIRAN_UPSTREAM: 'http://127.0.0.1:9',
  JOBHUB_UPSTREAM: 'http://127.0.0.1:9',
  BRIDGE_UPSTREAM: 'http://127.0.0.1:9',
  COGNEE_API: 'http://127.0.0.1:9'
}

Object.assign(process.env, TEST_ENV)
require('../bin/loadEnv')

const BASES = ['http://127.0.0.1:19092', 'http://127.0.0.1:19093']
const PORTS = [19092, 19093]
const SERVER_CWD = path.join(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ACK timeout`)), timeoutMs)
    socket.emit(event, payload, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

async function waitFor(check, timeoutMs, message) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error(message)
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

function startServer(port) {
  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      ...TEST_ENV,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.logTail = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      child.logTail = (child.logTail + String(chunk)).slice(-12000)
    })
  }
  return child
}

async function waitHealthy(base, child) {
  const health = await waitFor(async () => {
    if (child.exitCode != null) {
      throw new Error(`collab server exited (${child.exitCode})\n${child.logTail}`)
    }
    try {
      const response = await fetch(`${base}/api/health`)
      if (!response.ok) return null
      return await response.json()
    } catch (_) {
      return null
    }
  }, 30000, `collab server health timeout at ${base}\n${child.logTail}`)
  assert.strictEqual(health.ok, true)
  assert.strictEqual(health.eventBridge && health.eventBridge.enabled, true)
  assert.strictEqual(health.eventBridge.listenerHealthy, true)
  return health
}

function connectClient(url, clientId) {
  const { io } = require('socket.io-client')
  return io(url, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { userId: clientId }
  })
}

async function connect(socket) {
  if (socket.connected) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connect timeout')), 10000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function join(socket, roomKey, clientId) {
  return emitAck(socket, 'join', {
    roomKey,
    clientId,
    userId: clientId,
    name: clientId,
    lastServerRevision: 0
  })
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_) {}
      resolve()
    }, 6000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch (_) {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function main() {
  for (const port of PORTS) await assertPortFree(port)
  const { initSchema, upsertRoom, getPool } = require('../bin/storage')
  await initSchema()
  const roomKey = `mcp-bridge-dual-${randomUUID()}`
  await upsertRoom(roomKey, 'MCP bridge dual-instance regression', {
    nodes: {
      root: {
        isRoot: true,
        data: { uid: 'root', text: 'Root' },
        children: []
      }
    }
  })

  const children = []
  const sockets = []
  try {
    children.push(startServer(PORTS[0]))
    await waitHealthy(BASES[0], children[0])
    children.push(startServer(PORTS[1]))
    await waitHealthy(BASES[1], children[1])

    const clientA = randomUUID()
    const clientB = randomUUID()
    const a = connectClient(BASES[0], clientA)
    const b = connectClient(BASES[1], clientB)
    sockets.push(a, b)
    const eventsA = []
    const eventsB = []
    a.on('op:event', event => eventsA.push(event))
    b.on('op:event', event => eventsB.push(event))
    await Promise.all([connect(a), connect(b)])
    const [joinA, joinB] = await Promise.all([
      join(a, roomKey, clientA),
      join(b, roomKey, clientB)
    ])
    assert.strictEqual(joinA.ok, true, JSON.stringify(joinA))
    assert.strictEqual(joinB.ok, true, JSON.stringify(joinB))

    const text = `bridge-event-${randomUUID()}`
    const ack = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.insert',
      roomKey,
      userId: clientA,
      clientId: clientA,
      baseRevision: 0,
      payload: { parent: 'root', text }
    })
    assert.strictEqual(ack.ok, true, JSON.stringify(ack))

    const received = await waitFor(() => {
      const eventA = eventsA.find(item => Number(item.serverRevision) === Number(ack.serverRevision))
      const eventB = eventsB.find(item => Number(item.serverRevision) === Number(ack.serverRevision))
      return eventA && eventB ? { eventA, eventB } : null
    }, 8000, 'same-instance or cross-instance client missed committed operation')

    for (const event of [received.eventA, received.eventB]) {
      assert.strictEqual(event.type, 'node.inserted', JSON.stringify(event))
      assert.ok(event.payload.uid, 'server-generated UID missing from canonical broadcast')
      assert.strictEqual(event.payload.data.uid, event.payload.uid)
      assert.strictEqual(event.payload.data.text, text)
      assert.ok(event.payload.position, 'authoritative sibling position missing')
    }

    // Bridge mode replaces direct local broadcast; neither client may receive
    // both a direct event and the event recovered from the durable log.
    await delay(1200)
    const matchingA = eventsA.filter(item => Number(item.serverRevision) === Number(ack.serverRevision))
    const matchingB = eventsB.filter(item => Number(item.serverRevision) === Number(ack.serverRevision))
    assert.strictEqual(matchingA.length, 1, `instance A duplicate event count=${matchingA.length}`)
    assert.strictEqual(matchingB.length, 1, `instance B duplicate event count=${matchingB.length}`)

    const [healthA, healthB] = await Promise.all(BASES.map(async base => {
      const response = await fetch(`${base}/api/health`)
      return response.json()
    }))
    assert.ok(healthA.eventBridge.operationsSent >= 1)
    assert.ok(healthB.eventBridge.operationsSent >= 1)
    console.log(JSON.stringify({
      ok: true,
      instances: 2,
      roomKey,
      serverRevision: ack.serverRevision,
      generatedUid: received.eventB.payload.uid,
      eachClientReceivedOnce: true,
      bridgeOperationsSent: [healthA.eventBridge.operationsSent, healthB.eventBridge.operationsSent]
    }))
  } finally {
    sockets.forEach(socket => socket.close())
    await Promise.all(children.reverse().map(stopServer))
    const pool = getPool()
    await pool.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
