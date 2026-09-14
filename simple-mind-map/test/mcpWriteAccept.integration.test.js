/**
 * Live acceptance: MCP write path vs Collab V2 clientId gate.
 *
 * Against a running gateway (default http://127.0.0.1:8989):
 *  1) POST /nodes without clientId → 400 clientId 不能为空
 *  2) POST /nodes with x-client-id (MCP injects this) → 200 + readable
 *  3) MCP HTTP tools/call add_node → 200 (end-to-end)
 *
 * Env:
 *   COLLAB_TEST_BASE_URL  gateway base (default http://127.0.0.1:8989)
 *   MCP_TOKEN             service bearer (required)
 */
const assert = require('assert')
const crypto = require('crypto')
const { randomUUID } = crypto

try {
  require('../bin/loadEnv')
} catch (_) {
  // optional; Docker runs may inject MCP_TOKEN already
}

const baseUrl = (
  process.env.COLLAB_TEST_BASE_URL ||
  process.env.MIND_MAP_BASE_URL ||
  'http://127.0.0.1:8989'
).replace(/\/$/, '')

const mcpUrl = `${baseUrl}/mcp`
const marker = `mcp-accept-${Date.now()}`

function authHeaders(extra = {}) {
  const token = String(process.env.MCP_TOKEN || '').trim()
  assert.ok(token, 'MCP_TOKEN is required for acceptance')
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...extra
  }
}

async function request(path, options = {}) {
  const { headers, ...rest } = options
  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: authHeaders(headers)
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function createRoom() {
  const roomKey = `mcp-accept-${randomUUID().slice(0, 8)}`
  const created = await request('/api/files', {
    method: 'POST',
    body: JSON.stringify({
      room_key: roomKey,
      title: 'MCP write accept',
      tree: { data: { uid: 'root', text: 'Root' }, children: [] }
    })
  })
  assert.ok(
    created.response.status === 201 || created.response.status === 200,
    `create room failed: ${created.response.status} ${created.data.error || ''}`
  )
  return roomKey
}

async function deleteRoom(roomKey) {
  await request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE'
  }).catch(() => {})
}

async function stepRejectWithoutClientId(roomKey) {
  const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      parent: 'root',
      text: `${marker}-no-client`,
      note: 'should be rejected'
    })
  })
  assert.strictEqual(
    res.response.status,
    400,
    `expected 400 without clientId, got ${res.response.status} ${JSON.stringify(res.data)}`
  )
  assert.match(
    String(res.data.error || ''),
    /clientId/,
    `expected clientId error, got ${JSON.stringify(res.data)}`
  )
  console.log('  ✓ API write without clientId rejected:', res.data.error)
}

async function stepAcceptWithHeader(roomKey) {
  const clientId = `mcp-accept-${randomUUID()}`
  const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    headers: { 'x-client-id': clientId },
    body: JSON.stringify({
      parent: 'root',
      text: `${marker}-with-header`,
      note: 'injected like mcpServer.mjs'
    })
  })
  assert.strictEqual(
    res.response.status,
    200,
    `expected 200 with x-client-id, got ${res.response.status} ${JSON.stringify(res.data)}`
  )
  assert.ok(res.data.uid || (res.data.node && res.data.node.uid), res.data)
  const uid = res.data.uid || res.data.node.uid
  console.log('  ✓ API write with x-client-id ok uid=', uid, 'version=', res.data.version)

  const outline = await request(
    `/api/files/${encodeURIComponent(roomKey)}?format=outline&max_nodes=50`
  )
  assert.ok(outline.response.ok, outline.data.error)
  const blob = JSON.stringify(outline.data)
  assert.ok(
    blob.includes(`${marker}-with-header`),
    'outline missing written node text'
  )
  console.log('  ✓ outline reread contains node')
  return uid
}

async function mcpJsonRpc(sessionId, body) {
  const headers = authHeaders({
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05'
  })
  if (sessionId) headers['mcp-session-id'] = sessionId
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const raw = await response.text()
  const newSession = response.headers.get('mcp-session-id') || sessionId
  let data = null
  if (raw.startsWith('event:') || raw.includes('data:')) {
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
      if (line.startsWith('data:')) {
        try {
          data = JSON.parse(line.slice(5).trim())
        } catch (_) {
          // keep scanning
        }
      }
    }
  } else if (raw) {
    data = JSON.parse(raw)
  }
  return { response, data, sessionId: newSession, raw }
}

async function stepMcpAddNode(roomKey) {
  const init = await mcpJsonRpc(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-write-accept', version: '1.0.0' }
    }
  })
  assert.ok(init.response.ok, `MCP initialize HTTP ${init.response.status} ${init.raw}`)
  assert.ok(init.sessionId, 'MCP missing mcp-session-id')
  assert.ok(init.data && init.data.result, `MCP initialize body: ${init.raw}`)

  await mcpJsonRpc(init.sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })

  const call = await mcpJsonRpc(init.sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'add_node',
      arguments: {
        room_key: roomKey,
        parent: 'root',
        text: `${marker}-via-mcp`,
        note: 'end-to-end MCP tool write'
      }
    }
  })
  assert.ok(call.response.ok, `MCP tools/call HTTP ${call.response.status} ${call.raw}`)
  assert.ok(call.data && call.data.result, `MCP tools/call body: ${call.raw}`)
  assert.ok(
    !call.data.result.isError,
    `MCP add_node isError: ${JSON.stringify(call.data.result)}`
  )
  const text =
    (call.data.result.content &&
      call.data.result.content.map(c => c.text || '').join('')) ||
    ''
  assert.ok(text, 'MCP add_node empty content')
  const parsed = JSON.parse(text)
  assert.ok(parsed.uid || (parsed.node && parsed.node.uid), parsed)
  console.log(
    '  ✓ MCP add_node ok uid=',
    parsed.uid || parsed.node.uid,
    'version=',
    parsed.version
  )

  const outline = await request(
    `/api/files/${encodeURIComponent(roomKey)}?format=outline&max_nodes=50`
  )
  const blob = JSON.stringify(outline.data)
  assert.ok(blob.includes(`${marker}-via-mcp`), 'outline missing MCP-written node')
  console.log('  ✓ outline reread contains MCP node')
}

async function main() {
  console.log(`MCP write acceptance against ${baseUrl}`)
  const health = await request('/health').catch(() =>
    request('/api/health')
  )
  assert.ok(
    health.response.ok,
    `gateway/collab not reachable at ${baseUrl}`
  )

  const roomKey = await createRoom()
  console.log('room', roomKey)
  try {
    console.log('1) reject bare HTTP write (legacy MCP bug)')
    await stepRejectWithoutClientId(roomKey)
    console.log('2) accept HTTP write with x-client-id (MCP fix)')
    await stepAcceptWithHeader(roomKey)
    console.log('3) MCP tools/call add_node end-to-end')
    await stepMcpAddNode(roomKey)
    console.log('PASSED mcp write acceptance')
  } finally {
    await deleteRoom(roomKey)
    console.log('cleaned room', roomKey)
  }
}

main().catch(err => {
  console.error('FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
