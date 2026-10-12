import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { api, appA, seedRoom, token } from './fixtures.mjs'

const require = createRequire(import.meta.url)
const { applyRestore } = require('../../simple-mind-map/bin/collabUndo.js')
const here = path.dirname(fileURLToPath(import.meta.url))
const runId = String(process.env.MCP_BASELINE_RUN_ID || `failure-cases-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
const output = path.join(here, 'results', `${runId}-failure-cases.json`)
const pg = new Client({
  host: process.env.MCP_BASELINE_PGHOST || '127.0.0.1',
  port: Number(process.env.MCP_BASELINE_PGPORT || 25492),
  database: process.env.MCP_BASELINE_PGDATABASE || 'mcp_incremental_test',
  user: process.env.MCP_BASELINE_PGUSER || 'mcp_test',
  password: process.env.MCP_BASELINE_PGPASSWORD || 'mcp-incremental-test-db-password',
  application_name: `mcp-failure-cases-${runId}`
})

async function rpc(sessionId, body) {
  const response = await fetch(new URL('/mcp', appA), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2024-11-05',
      authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify(body)
  })
  const raw = await response.text()
  let data
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try { data = JSON.parse(line.slice(5).trim()) } catch (_) {}
  }
  return { response, raw, data, sessionId: response.headers.get('mcp-session-id') || sessionId }
}

async function initialize() {
  const result = await rpc(null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-failure-cases', version: '1.0.0' } }
  })
  assert.equal(result.response.status, 200, result.raw)
  assert.ok(result.sessionId, 'MCP session ID missing')
  await rpc(result.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  return result.sessionId
}

async function callAdd(sessionId, roomKey, text, id) {
  const result = await rpc(sessionId, {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'add_node', arguments: { room_key: roomKey, parent: 'root', text } }
  })
  assert.equal(result.response.status, 200, result.raw)
  assert.ok(result.data?.result && !result.data.result.isError, result.raw)
  const content = (result.data.result.content || []).map(item => item.text || '').join('')
  const payload = JSON.parse(content)
  return { uid: payload.uid || payload.node?.uid, content }
}

const report = { schema: 1, runId, createdAt: new Date().toISOString(), cases: [] }

// Historical inverse payloads can exist in both the old node-map and Direct rows forms.
const initial = { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } }
const legacyRestored = applyRestore(initial, {
  nodes: { legacy: { isRoot: false, data: { uid: 'legacy', text: 'Legacy node' }, children: [] } },
  uid: 'legacy', parentUid: 'root'
})
assert.ok(legacyRestored.legacy)
assert.deepEqual(legacyRestored.root.children, ['legacy'])
const rowsRestored = applyRestore(initial, {
  rows: [{ uid: 'direct', parent_uid: 'root', position: '00000001', is_root: false, data: { text: 'Direct row' } }],
  uid: 'direct', parentUid: 'root'
})
assert.ok(rowsRestored.direct)
assert.deepEqual(rowsRestored.root.children, ['direct'])
report.cases.push({
  name: 'inverse-payload-legacy-nodes-and-direct-rows',
  reproducedRisk: true,
  outcome: 'both shapes restore the node and parent ordering in the base implementation',
  passed: true
})

await pg.connect()
try {
  // A compact deterministic archive fixture represents an already archived operation range.
  const archiveRoom = `mcp-baseline-${runId}-archive-gap-${randomUUID().slice(0, 6)}`
  await seedRoom(appA, archiveRoom, 'small')
  await pg.query(
    `insert into room_operations_archive
       (room_key, version, operation_id, actor_id, client_id, operation_type, payload, event, inverse_payload, created_at, archived_at)
     select $1, v, gen_random_uuid(), 'baseline-test', null, 'node.add', '{}'::jsonb, '{}'::jsonb, null, now(), now()
     from generate_series(1, 500) as v`,
    [archiveRoom]
  )
  await pg.query('delete from room_operations where room_key = $1 and version <= 500', [archiveRoom])
  await pg.query(
    `insert into room_operations
       (room_key, version, operation_id, actor_id, client_id, operation_type, payload, event, inverse_payload)
     select $1, v, gen_random_uuid(), 'baseline-test', null, 'node.add', '{}'::jsonb, '{}'::jsonb, null
     from generate_series(501, 520) as v`,
    [archiveRoom]
  )
  await pg.query('update rooms set version = 520 where room_key = $1', [archiveRoom])
  const gap = await api(appA, `/api/maps/${encodeURIComponent(archiveRoom)}/operations?after=1`)
  assert.equal(gap.response.status, 409, `archive gap status ${gap.response.status}: ${gap.text}`)
  assert.equal(gap.data.code, 'RESNAPSHOT_REQUIRED', `archive gap code: ${gap.text}`)
  report.cases.push({
    name: 'http-operations-archived-gap',
    roomKey: archiveRoom,
    archivedVersions: [1, 500],
    activeVersions: [501, 520],
    observed: { status: gap.response.status, code: gap.data.code, minVersion: gap.data.minVersion, currentVersion: gap.data.currentVersion },
    passed: true
  })

  // Simulate an ambiguous client retry: current MCP schema exposes no operation_id argument.
  const duplicateRoom = `mcp-baseline-${runId}-duplicate-${randomUUID().slice(0, 6)}`
  const seeded = await seedRoom(appA, duplicateRoom, 'small')
  const sessionId = await initialize()
  const sameText = `duplicate retry payload ${runId}`
  const first = await callAdd(sessionId, duplicateRoom, sameText, 2)
  const second = await callAdd(sessionId, duplicateRoom, sameText, 3)
  assert.ok(first.uid && second.uid)
  assert.notEqual(first.uid, second.uid)
  const rows = await pg.query(
    `select version::int, operation_id::text, payload->>'text' as text
     from room_operations where room_key = $1 and version > $2 order by version`,
    [duplicateRoom, seeded.version]
  )
  assert.equal(rows.rows.length, 2)
  assert.equal(rows.rows[0].text, sameText)
  assert.equal(rows.rows[1].text, sameText)
  report.cases.push({
    name: 'same-mcp-arguments-retried-without-operation-id',
    roomKey: duplicateRoom,
    sameArguments: true,
    observedVersions: rows.rows.map(row => row.version),
    operationIds: rows.rows.map(row => row.operation_id),
    returnedUids: [first.uid, second.uid],
    reproducedRisk: rows.rows[0].operation_id !== rows.rows[1].operation_id,
    passed: true,
    note: 'The current MCP add_node schema has no operation_id; distinct retries commit distinct operations. This is a risk reproduction, not an assertion that repeated independent user actions should deduplicate.'
  })
} finally {
  await pg.end()
}

fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output, cases: report.cases }))
