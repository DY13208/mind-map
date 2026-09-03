const assert = require('assert')
const crypto = require('crypto')
require('../bin/loadEnv')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8989'
const wsUrl = (
  process.env.COLLAB_DIRECT_WS_URL ||
  baseUrl.replace(/^http/, 'ws') + '/collab'
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

class AuthedWebSocket extends WebSocket {
  constructor(url, protocols) {
    const token = process.env.MCP_TOKEN
    super(url, protocols, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
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

function connectPresence(roomKey) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(
    wsUrl,
    `${roomKey}__presence`,
    doc,
    {
      WebSocketPolyfill: AuthedWebSocket,
      disableBc: true,
      connect: false,
      maxBackoffTime: 2000
    }
  )
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      reject(new Error('presence ws timeout'))
    }, 15000)
    provider.on('status', ({ status }) => {
      if (status !== 'connected') return
      clearTimeout(timer)
      resolve({ doc, provider })
    })
    provider.on('connection-error', err => {
      clearTimeout(timer)
      provider.destroy()
      reject(err)
    })
    provider.connect()
  })
}

async function main() {
  const health = await request('/api/health')
  assert.ok(health.response.ok, 'health failed')
  console.log('wsUrl', wsUrl)

  const roomKey = `twoclient-${crypto.randomUUID().slice(0, 8)}`
  const created = await request('/api/files', {
    method: 'POST',
    body: JSON.stringify({
      room_key: roomKey,
      title: 'TwoClient',
      tree: { data: { uid: 'root', text: '未命名1' }, children: [] }
    })
  })
  assert.strictEqual(created.response.status, 201, created.data.error)

  const a = await connectPresence(roomKey)
  const b = await connectPresence(roomKey)
  a.provider.awareness.setLocalStateField('user', {
    userInfo: { id: 'user-a', name: '杨', color: '#a0f' }
  })
  b.provider.awareness.setLocalStateField('user', {
    userInfo: { id: 'user-b', name: '李', color: '#0af' }
  })
  await delay(500)

  const noticed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('B never got documentChange')),
      12000
    )
    b.provider.awareness.on('change', () => {
      for (const state of b.provider.awareness.getStates().values()) {
        const change = state.documentChange
        if (
          change &&
          change.roomKey === roomKey &&
          Number(change.version) >= 1 &&
          String(change.clientId) !== String(b.provider.awareness.clientID)
        ) {
          clearTimeout(timer)
          resolve(change)
          return
        }
      }
    })
  })

  const inserted = await request(`/api/files/${roomKey}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      parent: 'root',
      uid: 'child1',
      text: '二级节点',
      confirm_sop_change: true
    })
  })
  assert.strictEqual(inserted.response.status, 200, inserted.data.error)
  assert.strictEqual(Number(inserted.data.version), 1)

  // Simulate writer publishing presence documentChange (CooperateDialog path)
  a.provider.awareness.setLocalStateField('documentChange', {
    roomKey,
    userId: 'user-a',
    clientId: a.provider.awareness.clientID,
    version: 1,
    updatedAt: new Date().toISOString(),
    nonce: `${Date.now()}-test`
  })

  const change = await noticed
  console.log('B got documentChange', change.version, change.userId || change.clientId)

  // B recovers like the UI: poll version + fetch nodes
  const status = await request(`/api/files/${roomKey}/save-status`)
  assert.strictEqual(Number(status.data.version), 1)
  const nodes = await request(
    `/api/files/${roomKey}/nodes?uids=root,child1`
  )
  const root = (nodes.data.nodes || []).find(n => n.uid === 'root')
  assert.ok(root && root.children.includes('child1'), 'root missing child1')
  const preview = await request(`/api/files/${roomKey}/preview?depth=2`)
  const kid = (preview.data.tree.children || []).find(
    c => c.data && c.data.uid === 'child1'
  )
  assert.ok(kid, 'preview missing child')
  assert.strictEqual(kid.data.text, '二级节点')

  a.provider.destroy()
  b.provider.destroy()
  a.doc.destroy()
  b.doc.destroy()
  await request(`/api/files/${roomKey}`, { method: 'DELETE' })
  console.log('two-client presence+insert sync PASSED')
}

main().catch(err => {
  console.error('FAILED:', err && err.message ? err.message : err)
  process.exitCode = 1
})
