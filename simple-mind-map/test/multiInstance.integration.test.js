const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')
require('../bin/loadEnv')

const portA = Number(process.env.COLLAB_MULTI_PORT_A || 18791)
const portB = Number(process.env.COLLAB_MULTI_PORT_B || 18792)
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
  return spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COLLAB_EVENT_BUS: process.env.COLLAB_MULTI_EVENT_BUS || 'postgres',
      COLLAB_OUTBOX_POLL_MS: '80',
      REDIS_URL: process.env.REDIS_URL || process.env.COLLAB_REDIS_URL || ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    if (/error|failed|outbox-fanout/i.test(text)) process.stderr.write(text)
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

function watchDocumentChanges(provider) {
  const versions = []
  const onChange = () => {
    Array.from(provider.awareness.getStates().values()).forEach(state => {
      const change = state && state.documentChange
      if (!change || !Number.isFinite(Number(change.version))) return
      const version = Number(change.version)
      if (versions.includes(version)) return
      versions.push(version)
    })
  }
  provider.awareness.on('change', onChange)
  onChange()
  return {
    versions,
    stop() {
      provider.awareness.off('change', onChange)
    }
  }
}

async function waitForVersions(watcher, expected, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const have = watcher.versions.slice().sort((a, b) => a - b)
    if (expected.every(v => have.includes(v))) return have
    await delay(100)
  }
  throw new Error(
    `expected documentChange versions ${expected.join(',')} got ${watcher.versions.join(',')}`
  )
}

async function fetchOperationVersions(base, roomKey) {
  const res = await request(
    base,
    `/api/maps/${encodeURIComponent(roomKey)}/operations?after=0&limit=1000`
  )
  assert.strictEqual(res.response.status, 200, res.data.error)
  return (res.data.operations || []).map(item => Number(item.version))
}

function assertStrictlyIncreasing(versions, label) {
  for (let i = 1; i < versions.length; i++) {
    assert.strictEqual(
      versions[i],
      versions[i - 1] + 1,
      `${label}: version gap at index ${i} (${versions.join(',')})`
    )
  }
}

async function addNode(base, roomKey, uid, text) {
  const res = await request(base, `/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      parent: 'root',
      uid,
      text,
      confirm_sop_change: true
    })
  })
  assert.strictEqual(res.response.status, 200, res.data.error)
  return Number(res.data.version)
}

async function main() {
  const roomKey = `multi-${crypto.randomUUID()}`
  let childA = startServer(portA)
  let childB = null
  let presence = null
  let watcher = null
  try {
    await waitHealth(baseA, 'instance A')
    childB = startServer(portB)
    await waitHealth(baseB, 'instance B')

    const created = await request(baseA, '/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: 'Multi instance',
        tree: { data: { uid: 'root', text: 'Root' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201, created.data.error)

    presence = await connectPresence(roomKey)
    watcher = watchDocumentChanges(presence.provider)

    const expectedVersions = []
    for (let i = 1; i <= 5; i++) {
      const version = await addNode(baseA, roomKey, `n${i}`, `Node ${i}`)
      expectedVersions.push(version)
      assert.strictEqual(version, i)
    }

    await waitForVersions(watcher, expectedVersions)
    assertStrictlyIncreasing(watcher.versions.slice().sort((a, b) => a - b), 'ws')

    const versionsOnB = await fetchOperationVersions(baseB, roomKey)
    assert.deepStrictEqual(versionsOnB, expectedVersions)
    assertStrictlyIncreasing(versionsOnB, 'http B')

    const versionRes = await request(
      baseB,
      `/api/maps/${encodeURIComponent(roomKey)}/version`
    )
    assert.strictEqual(versionRes.data.version, 5)

    // Simulate scale-down: stop instance B
    watcher.stop()
    presence.provider.destroy()
    presence.doc.destroy()
    presence = null
    await stopServer(childB)
    childB = null

    // Scale-up: start fresh instance B
    childB = startServer(portB)
    await waitHealth(baseB, 'instance B after restart')

    const versionsAfterRestart = await fetchOperationVersions(baseB, roomKey)
    assert.deepStrictEqual(versionsAfterRestart, expectedVersions)

    presence = await connectPresence(roomKey)
    watcher = watchDocumentChanges(presence.provider)

    const version6 = await addNode(baseA, roomKey, 'n6', 'Node 6')
    assert.strictEqual(version6, 6)

    await waitForVersions(watcher, [6])
    const versionsFinal = await fetchOperationVersions(baseB, roomKey)
    assert.deepStrictEqual(versionsFinal, [1, 2, 3, 4, 5, 6])
    assertStrictlyIncreasing(versionsFinal, 'http B after restart')

    console.log(`multi-instance scale integration passed (${roomKey})`)
  } finally {
    if (watcher) watcher.stop()
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
      await request(baseA, `/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // ignore cleanup
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
