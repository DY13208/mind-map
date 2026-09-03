const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')
require('../bin/loadEnv')

const portA = Number(process.env.COLLAB_FAULT_PORT_A || 18795)
const portB = Number(process.env.COLLAB_FAULT_PORT_B || 18796)
const baseA = `http://127.0.0.1:${portA}`
const baseB = `http://127.0.0.1:${portB}`
const wsB = `ws://127.0.0.1:${portB}`

class AuthedWebSocket extends WebSocket {
  constructor(url, protocols) {
    const token = process.env.MCP_TOKEN
    super(url, protocols, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
  }
}

function authHeaders(extra = {}) {
  const token = process.env.MCP_TOKEN
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  }
}

async function request(base, pathname, options = {}) {
  const { headers, ...rest } = options
  const response = await fetch(base + pathname, {
    ...rest,
    headers: authHeaders(headers)
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function startServer(port, envExtra = {}) {
  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COLLAB_EVENT_BUS: 'postgres',
      COLLAB_OUTBOX_POLL_MS: '80',
      ...envExtra
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    if (/error|failed|fault|outbox/i.test(text)) process.stderr.write(text)
  })
  return child
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve()
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (err) {
        // ignore
      }
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill()
    } catch (err) {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function waitHealth(base, label) {
  const started = Date.now()
  while (Date.now() - started < 25000) {
    try {
      const { response, data } = await request(base, '/api/health')
      if (response.ok && data.ok) return data
    } catch (err) {
      // still starting
    }
    await delay(200)
  }
  throw new Error(`collab server did not become healthy (${label})`)
}

function connectPresence(roomKey) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(
    wsB,
    `${roomKey}__presence`,
    doc,
    {
      WebSocketPolyfill: AuthedWebSocket,
      disableBc: true,
      connect: false,
      maxBackoffTime: 1000
    }
  )
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      doc.destroy()
      reject(new Error('presence websocket timeout'))
    }, 20000)
    provider.on('sync', synced => {
      if (!synced) return
      clearTimeout(timer)
      resolve({ provider, doc })
    })
    provider.on('connection-error', err => {
      clearTimeout(timer)
      provider.destroy()
      doc.destroy()
      reject(err)
    })
    provider.connect()
  })
}

function waitDocumentChange(provider, version) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.awareness.off('change', onChange)
      reject(new Error(`documentChange v${version} not received`))
    }, 15000)
    const onChange = () => {
      const hit = Array.from(provider.awareness.getStates().values()).find(
        state =>
          state.documentChange &&
          Number(state.documentChange.version) === version
      )
      if (!hit) return
      clearTimeout(timer)
      provider.awareness.off('change', onChange)
      resolve(hit.documentChange)
    }
    provider.awareness.on('change', onChange)
    onChange()
  })
}

async function createRoom(base, roomKey) {
  const created = await request(base, '/api/files', {
    method: 'POST',
    body: JSON.stringify({
      room_key: roomKey,
      title: 'Fault recovery',
      tree: { data: { uid: 'root', text: 'Root' }, children: [] }
    })
  })
  assert.strictEqual(created.response.status, 201, created.data.error)
}

async function addNode(base, roomKey, uid, text) {
  return request(base, `/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      parent: 'root',
      uid,
      text,
      confirm_sop_change: true
    })
  })
}

async function getVersion(base, roomKey) {
  const res = await request(base, `/api/maps/${encodeURIComponent(roomKey)}/version`)
  assert.strictEqual(res.response.status, 200, res.data.error)
  return Number(res.data.version)
}

async function waitOutboxPublished(base, roomKey, version, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const listed = await request(base, '/api/ops/outbox?pending=0&limit=100')
    assert.strictEqual(listed.response.status, 200, listed.data.error)
    const row = (listed.data.items || []).find(
      item => item.room_key === roomKey && Number(item.version) === version
    )
    if (row && row.published_at) return row
    await delay(100)
  }
  throw new Error(`outbox v${version} was not published`)
}

async function testBeforeCommitRollback() {
  const roomKey = `fault-before-${crypto.randomUUID()}`
  let child = startServer(portA, {
    COLLAB_FAULT_INJECT: 'before_commit_once'
  })
  try {
    await waitHealth(baseA, 'before-commit A')
    await createRoom(baseA, roomKey)
    assert.strictEqual(await getVersion(baseA, roomKey), 0)

    const failed = await addNode(baseA, roomKey, 'should-roll-back', 'Nope')
    assert.ok(failed.response.status >= 400, 'expected fault injection error')
    assert.strictEqual(failed.data.code, 'FAULT_INJECTED')
    assert.strictEqual(await getVersion(baseA, roomKey), 0)

    const full = await request(
      baseA,
      `/api/files/${encodeURIComponent(roomKey)}?format=full`
    )
    assert.ok(!JSON.stringify(full.data).includes('should-roll-back'))

    // Server should still accept writes after one-shot fault clears.
    const ok = await addNode(baseA, roomKey, 'after-fault', 'Survived')
    assert.strictEqual(ok.response.status, 200, ok.data.error)
    assert.strictEqual(ok.data.version, 1)
    console.log('fault before-commit rollback passed')
  } finally {
    try {
      await request(baseA, `/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // ignore
    }
    await stopServer(child)
  }
}

async function testAfterCommitBeforePublish() {
  const roomKey = `fault-after-${crypto.randomUUID()}`
  // Writer has no publisher: durable outbox stays unpublished.
  // Kill writer after HTTP 200 so survivor must drain outbox (NOTIFY already lost).
  let childA = startServer(portA, {
    COLLAB_OUTBOX_PUBLISHER: '0'
  })
  let childB = null
  let presence = null
  try {
    await waitHealth(baseA, 'after-commit A')
    await createRoom(baseA, roomKey)

    const added = await addNode(baseA, roomKey, 'committed-node', 'Durable')
    assert.strictEqual(added.response.status, 200, added.data.error)
    assert.strictEqual(added.data.version, 1)
    assert.strictEqual(await getVersion(baseA, roomKey), 1)

    await stopServer(childA)
    childA = null

    // Survivor starts after the writer died; missed in-tx NOTIFY must be
    // recovered from durable outbox (replay clears published_at if needed).
    childB = startServer(portB, {
      COLLAB_OUTBOX_PUBLISHER: '1',
      COLLAB_OUTBOX_POLL_MS: '60000'
    })
    await waitHealth(baseB, 'after-commit B')

    assert.strictEqual(await getVersion(baseB, roomKey), 1)
    const ops = await request(
      baseB,
      `/api/maps/${encodeURIComponent(roomKey)}/operations?after=0&limit=10`
    )
    assert.strictEqual(ops.response.status, 200, ops.data.error)
    assert.strictEqual((ops.data.operations || []).length, 1)
    assert.strictEqual(ops.data.operations[0].version, 1)

    presence = await connectPresence(roomKey)
    const changePromise = waitDocumentChange(presence.provider, 1)

    const replay = await request(baseB, '/api/ops/outbox', {
      method: 'POST',
      body: JSON.stringify({ roomKey, version: 1 })
    })
    assert.strictEqual(replay.response.status, 200, replay.data.error)
    assert.ok(replay.data.replayed >= 1, 'expected outbox replay')

    await waitOutboxPublished(baseB, roomKey, 1)
    const change = await changePromise
    assert.strictEqual(Number(change.version), 1)

    const full = await request(
      baseB,
      `/api/files/${encodeURIComponent(roomKey)}?format=full`
    )
    assert.ok(
      JSON.stringify(full.data).includes('Durable'),
      'committed node missing after writer crash'
    )
    console.log('fault after-commit outbox recovery passed')
  } finally {
    if (presence) {
      try {
        presence.provider.destroy()
        presence.doc.destroy()
      } catch (err) {
        // ignore
      }
    }
    await stopServer(childA)
    await stopServer(childB)
    try {
      await request(baseB, `/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      try {
        await request(baseA, `/api/files/${encodeURIComponent(roomKey)}`, {
          method: 'DELETE'
        })
      } catch (err2) {
        // ignore
      }
    }
  }
}

async function terminateCollabBackends(appName) {
  const { Client } = require('pg')
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    application_name: 'collab-fault-killer'
  })
  await client.connect()
  try {
    const res = await client.query(
      `select pg_terminate_backend(pid) as killed
       from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and application_name = $1`,
      [appName]
    )
    return res.rowCount || 0
  } finally {
    await client.end().catch(() => {})
  }
}

async function testPgBriefDisconnect() {
  const roomKey = `fault-pg-${crypto.randomUUID()}`
  const appName = `collab-fault-${crypto.randomUUID().slice(0, 8)}`
  let child = startServer(portA, {
    COLLAB_PG_APP_NAME: appName,
    COLLAB_PG_RETRY: '5'
  })
  try {
    await waitHealth(baseA, 'pg-disconnect A')
    await createRoom(baseA, roomKey)

    const first = await addNode(baseA, roomKey, 'before-kill', 'Before')
    assert.strictEqual(first.response.status, 200, first.data.error)
    assert.strictEqual(first.data.version, 1)

    const killed = await terminateCollabBackends(appName)
    assert.ok(killed >= 1, 'expected at least one collab backend terminated')

    // Pool should reconnect; operationId idempotency keeps retries safe.
    let recovered = null
    const started = Date.now()
    while (Date.now() - started < 15000) {
      recovered = await addNode(baseA, roomKey, 'after-kill', 'After reconnect')
      if (recovered.response.status === 200) break
      await delay(200)
    }
    assert.ok(recovered, 'no response after pg kill')
    assert.strictEqual(recovered.response.status, 200, recovered.data.error)
    assert.strictEqual(recovered.data.version, 2)
    assert.strictEqual(await getVersion(baseA, roomKey), 2)

    const full = await request(
      baseA,
      `/api/files/${encodeURIComponent(roomKey)}?format=full`
    )
    const body = JSON.stringify(full.data)
    assert.ok(body.includes('Before'))
    assert.ok(body.includes('After reconnect'))
    console.log('fault pg brief disconnect recovery passed')
  } finally {
    try {
      await request(baseA, `/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // ignore
    }
    await stopServer(child)
  }
}

async function main() {
  await testBeforeCommitRollback()
  await testAfterCommitBeforePublish()
  await testPgBriefDisconnect()
  console.log('fault recovery integration passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
