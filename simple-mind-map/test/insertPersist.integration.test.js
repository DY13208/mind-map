const assert = require('assert')
const crypto = require('crypto')
require('../bin/loadEnv')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8989'
const wsUrl = (
  process.env.COLLAB_DIRECT_WS_URL || baseUrl.replace(/^http/, 'ws')
).replace(/\/$/, '')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function authHeaders(extra = {}) {
  const token = process.env.MCP_TOKEN
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  }
}

async function request(path, options = {}) {
  const { headers, ...rest } = options
  const response = await fetch(baseUrl + path, {
    ...rest,
    headers: authHeaders(headers)
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function createRoom() {
  const roomKey = `persist-${crypto.randomUUID()}`
  const created = await request('/api/files', {
    method: 'POST',
    body: JSON.stringify({
      room_key: roomKey,
      title: 'Persist test',
      tree: { data: { uid: 'root', text: 'Root' }, children: [] }
    })
  })
  assert.strictEqual(created.response.status, 201, created.data.error)
  return roomKey
}

async function insertChild(roomKey, uid, text) {
  const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      parent: 'root',
      uid,
      text,
      confirm_sop_change: true
    })
  })
  assert.strictEqual(res.response.status, 200, res.data.error)
  return res.data
}

async function serverNodes(roomKey) {
  const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes?uids=root,${encodeURIComponent('child-test')}`)
  assert.strictEqual(res.response.status, 200, res.data.error)
  return res
}

async function preview(roomKey) {
  const res = await request(`/api/files/${encodeURIComponent(roomKey)}/preview?depth=3`)
  assert.strictEqual(res.response.status, 200, res.data.error)
  return res.data
}

function connectRoom(roomKey) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    connect: false,
    maxBackoffTime: 2000
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      reject(new Error('websocket sync timeout'))
    }, 15000)
    provider.on('sync', synced => {
      if (!synced) return
      clearTimeout(timer)
      resolve({ doc, provider })
    })
    provider.on('connection-error', reject)
    provider.connect()
  })
}

async function main() {
  const health = await request('/api/health')
  if (!health.response.ok) {
    throw new Error(`collab server not running at ${baseUrl}`)
  }
  console.log(`testing against ${baseUrl}`)

  const roomKey = await createRoom()

  // Simulate client joining room (creates live Y.Doc in server memory).
  const live = await connectRoom(roomKey)
  console.log('ws connected, live doc loaded')

  const inserted = await insertChild(roomKey, 'child-test', 'Child after join')
  assert.strictEqual(Number(inserted.version), 1)
  console.log('insert ok version=', inserted.version)

  // saveDoc is debounced (1500ms); wait for any stale save race.
  await delay(2500)

  const truth = await serverNodes(roomKey)
  const rootKids = (truth.data.nodes || []).find(n => n.uid === 'root')
  const childNode = (truth.data.nodes || []).find(n => n.uid === 'child-test')
  console.log('GET nodes root children:', rootKids && rootKids.children)
  console.log('GET nodes child:', childNode && childNode.data && childNode.data.text)

  assert.ok(childNode, 'child missing from GET /nodes after insert')
  assert.ok(
    (rootKids && rootKids.children || []).includes('child-test'),
    'root.children missing child-test'
  )

  const pv = await preview(roomKey)
  const branch = (pv.tree.children || []).find(
    item => item && item.data && item.data.uid === 'child-test'
  )
  console.log('preview children:', (pv.tree.children || []).map(c => c.data.uid))
  assert.ok(branch, 'child missing from preview after insert')
  assert.strictEqual(branch.data.text, 'Child after join')

  const version = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
  assert.strictEqual(version.data.version, 1)

  live.provider.destroy()
  live.doc.destroy()

  // Second client reconnects after "refresh".
  const reload = await connectRoom(roomKey)
  await delay(300)
  reload.provider.destroy()
  reload.doc.destroy()

  const afterReload = await preview(roomKey)
  const again = (afterReload.tree.children || []).find(
    item => item && item.data && item.data.uid === 'child-test'
  )
  assert.ok(again, 'child missing from preview after ws reconnect (refresh sim)')
  console.log('insert persist integration passed')

  await request(`/api/files/${encodeURIComponent(roomKey)}`, { method: 'DELETE' })
}

main().catch(err => {
  console.error('FAILED:', err.message || err)
  process.exitCode = 1
})
