const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')
require('../bin/loadEnv')

const portA = Number(process.env.COLLAB_OUTBOX_PORT_A || 18771)
const portB = Number(process.env.COLLAB_OUTBOX_PORT_B || 18772)
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

function startServer(port) {
  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COLLAB_EVENT_BUS: 'postgres',
      COLLAB_OUTBOX_POLL_MS: '100'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    if (/error|failed|outbox-fanout/i.test(text)) process.stderr.write(text)
  })
  return child
}

async function waitHealth(base, label) {
  const started = Date.now()
  while (Date.now() - started < 20000) {
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
    }, 15000)
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
      reject(new Error('documentChange not received on instance B'))
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

async function main() {
  const roomKey = `outbox-${crypto.randomUUID()}`
  let childA = startServer(portA)
  let childB = null
  let presence = null
  try {
    const healthA = await waitHealth(baseA, 'instance A')
    childB = startServer(portB)
    const healthB = await waitHealth(baseB, 'instance B')
    assert.ok(healthA.outbox)
    assert.ok(healthB.outbox)

    const created = await request(baseA, '/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: '双实例外盒',
        tree: { data: { uid: 'root', text: 'Root' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201, created.data.error)

    presence = await connectPresence(roomKey)
    const changePromise = waitDocumentChange(presence.provider, 1)

    const added = await request(baseA, `/api/files/${encodeURIComponent(roomKey)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({
        parent: 'root',
        uid: 'cross-instance',
        text: 'From A',
        confirm_sop_change: true
      })
    })
    assert.strictEqual(added.response.status, 200, added.data.error)
    assert.strictEqual(added.data.version, 1)

    const started = Date.now()
    let published = null
    while (Date.now() - started < 8000) {
      const listed = await request(baseB, '/api/ops/outbox?pending=0&limit=50')
      assert.strictEqual(listed.response.status, 200, listed.data.error)
      published = (listed.data.items || []).find(
        row => row.room_key === roomKey && Number(row.version) === 1
      )
      if (published && published.published_at) break
      await delay(100)
    }
    assert.ok(published && published.published_at, 'outbox row was not published')

    const change = await changePromise
    assert.strictEqual(Number(change.version), 1)
    assert.strictEqual(change.roomKey, roomKey)

    const pending = await request(baseA, '/api/ops/outbox')
    assert.ok(
      !(pending.data.items || []).some(
        row => row.room_key === roomKey && !row.published_at
      )
    )
    console.log('outbox two-instance integration passed')
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
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
