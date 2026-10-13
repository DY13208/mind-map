import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const appA = process.env.MCP_BASELINE_APP_A || 'http://127.0.0.1:19090'
const appB = process.env.MCP_BASELINE_APP_B || 'http://127.0.0.1:19091'
const token = process.env.MCP_BASELINE_MCP_TOKEN || 'mcp-incremental-test-only-token-0160b5a7'
const roomKey = `mcp-incremental-smoke-${randomUUID().slice(0, 12)}`

async function request(base, path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(new URL(path, `${base}/`), { ...options, headers })
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch (_) {}
  return { response, data, text }
}

async function rpc(base, sessionId, body) {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2024-11-05',
    authorization: `Bearer ${token}`
  })
  if (sessionId) headers.set('mcp-session-id', sessionId)
  const response = await fetch(new URL('/mcp', base), {
    method: 'POST', headers, body: JSON.stringify(body)
  })
  const raw = await response.text()
  const newSessionId = response.headers.get('mcp-session-id') || sessionId
  let data
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try { data = JSON.parse(line.slice(5).trim()) } catch (_) {}
  }
  if (!data && raw) {
    try { data = JSON.parse(raw) } catch (_) {}
  }
  return { response, data, raw, sessionId: newSessionId }
}

for (const base of [appA, appB]) {
  const health = await request(base, '/api/health')
  assert.equal(health.response.status, 200, `${base} health: ${health.text}`)
  console.log(`health ${base}: ${health.text.slice(0, 160)}`)
}

const created = await request(appA, '/api/files', {
  method: 'POST',
  body: JSON.stringify({
    room_key: roomKey,
    title: 'MCP incremental smoke',
    tree: { data: { uid: 'root', text: 'Smoke root' }, children: [] }
  })
})
assert.ok([200, 201].includes(created.response.status), `create room: ${created.text}`)

const initialized = await rpc(appA, null, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mcp-incremental-smoke', version: '1.0.0' }
  }
})
assert.equal(initialized.response.status, 200, initialized.raw)
assert.ok(initialized.data?.result, initialized.raw)
assert.ok(initialized.sessionId, 'MCP session id missing')
await rpc(appA, initialized.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })

const add = await rpc(appA, initialized.sessionId, {
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'add_node', arguments: { room_key: roomKey, parent: 'root', text: `smoke-${randomUUID()}` } }
})
assert.equal(add.response.status, 200, add.raw)
assert.ok(add.data?.result && !add.data.result.isError, add.raw)
const text = (add.data.result.content || []).map(item => item.text || '').join('')
const payload = JSON.parse(text)
assert.ok(payload.uid || payload.node?.uid, text)

const outline = await request(appB, `/api/files/${encodeURIComponent(roomKey)}?format=outline&max_nodes=20`)
assert.equal(outline.response.status, 200, outline.text)
assert.ok(outline.text.includes(`smoke-`), 'app-b did not read shared PostgreSQL state')
console.log(JSON.stringify({ ok: true, roomKey, uid: payload.uid || payload.node.uid, appBSharedRead: true }))
