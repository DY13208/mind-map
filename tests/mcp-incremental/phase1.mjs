import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { api, appA, appB, seedRoom, token } from './fixtures.mjs'
import {
  armRemoteVisibility,
  closeBrowserClients,
  finishRemoteVisibilityProbe,
  finishWriteLoadObservers,
  openBrowserClients,
  startWriteLoadObservers
} from './browser-baseline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(here, 'results')
fs.mkdirSync(outputDir, { recursive: true })
const runId = String(process.env.MCP_BASELINE_RUN_ID || `baseline-${new Date().toISOString().replace(/[:.]/g, '-')}`).replace(/[^a-zA-Z0-9_-]/g, '-')
const rounds = Math.max(1, Number(process.env.MCP_BASELINE_ROUNDS || 10))
const writesPerRound = Math.max(1, Number(process.env.MCP_BASELINE_OPS || 100))
const resumeFromRound = Math.max(1, Number(process.env.MCP_BASELINE_RESUME_FROM || 1))
const resumeId = String(process.env.MCP_BASELINE_RESUME_ID || `resume-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
const resultPath = path.join(outputDir, `${runId}-baseline.jsonl`)
const summaryPath = path.join(outputDir, `${runId}-summary.json`)
const startedAt = new Date().toISOString()
assert.ok(resumeFromRound <= rounds + 1, `resume point must be at most rounds + 1 (${rounds + 1})`)
const sourceCommitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' })
const sourceCommit = sourceCommitResult.status === 0 ? sourceCommitResult.stdout.trim() : 'unavailable'
let priorRows = []
let priorRoundResults = []
let warmRoomKey = null
let warmupCalls = []
if (resumeFromRound === 1) {
  if (fs.existsSync(resultPath) || fs.existsSync(summaryPath)) {
    throw new Error(`runId ${runId} already has output; choose a new MCP_BASELINE_RUN_ID to preserve raw data`)
  }
} else {
  assert.ok(fs.existsSync(resultPath), `cannot resume missing raw file ${resultPath}`)
  assert.ok(!fs.existsSync(summaryPath), `cannot resume completed run ${runId}`)
  priorRows = fs.readFileSync(resultPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.ok(priorRows.every(row => row.runId === runId), `raw file contains a different run ID ${runId}`)
  const firstStart = priorRows.find(row => row.type === 'suite_start')
  assert.ok(firstStart, `raw file has no suite_start ${runId}`)
  assert.equal(firstStart.sourceCommit, sourceCommit, `source commit changed since run ${runId}`)
  assert.equal(firstStart.rounds, rounds, `round count changed since run ${runId}`)
  assert.equal(firstStart.writesPerRound, writesPerRound, `writes per round changed since run ${runId}`)
  priorRoundResults = priorRows.filter(row => row.type === 'round_complete').sort((a, b) => a.round - b.round)
  assert.deepEqual(priorRoundResults.map(row => row.round), Array.from({ length: resumeFromRound - 1 }, (_, index) => index + 1),
    `resume point ${resumeFromRound} does not follow contiguous completed rounds`)
  const priorWarmup = priorRows.find(row => row.type === 'warmup')
  warmRoomKey = priorWarmup?.roomKey || null
  warmupCalls = priorWarmup?.calls || []
}
let suiteComplete = false
let failureDetail = null
const rows = []
const append = row => {
  const full = { schema: 1, runId, at: new Date().toISOString(), ...row }
  rows.push(full)
  fs.appendFileSync(resultPath, `${JSON.stringify(full)}\n`)
}
process.on('uncaughtExceptionMonitor', (error, origin) => {
  failureDetail = { origin, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 4000) }
})
process.on('exit', exitCode => {
  if (suiteComplete || exitCode === 0) return
  try {
    const failure = { schema: 1, runId, at: new Date().toISOString(), type: 'suite_failure', exitCode, failure: failureDetail || { message: 'process exited before suite_complete' } }
    fs.appendFileSync(resultPath, `${JSON.stringify(failure)}\n`)
  } catch (_) {}
})

function roomHash(roomKey) {
  return createHash('sha1').update(roomKey).digest('hex').slice(0, 12)
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

function summarize(values) {
  return {
    count: values.filter(Number.isFinite).length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }
}

async function requestRpc(base, sessionId, body) {
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

async function initialize(base, label) {
  const init = await requestRpc(base, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: `mcp-incremental-baseline-${label}`, version: '1.0.0' }
    }
  })
  assert.equal(init.response.status, 200, `${label} initialize: ${init.raw}`)
  assert.ok(init.data?.result, `${label} initialize: ${init.raw}`)
  assert.ok(init.sessionId, `${label} missing session id`)
  await requestRpc(base, init.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  return { base, label, sessionId: init.sessionId, nextId: 2 }
}

async function callAddNode(session, roomKey, iteration, textOverride = null) {
  const id = session.nextId++
  const text = textOverride || `mcp-baseline-${runId}-${iteration}`
  const startedNs = process.hrtime.bigint()
  const startedMonotonicMs = performance.now()
  const started = new Date().toISOString()
  const startedEpochMs = Date.now()
  try {
    const result = await requestRpc(session.base, session.sessionId, {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'add_node', arguments: { room_key: roomKey, parent: 'root', text } }
    })
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6
    const responseCompletedMonotonicMs = performance.now()
    const responseCompletedAt = new Date().toISOString()
    const responseCompletedEpochMs = Date.now()
    if (result.response.status !== 200 || result.data?.error || result.data?.result?.isError) {
      return {
        iteration, text, elapsedMs, started, startedEpochMs, startedMonotonicMs, responseCompletedAt, responseCompletedEpochMs, responseCompletedMonotonicMs,
        statusCode: result.response.status,
        error: result.data?.error || result.data?.result?.content?.map(item => item.text || '').join('\n') || result.raw
      }
    }
    const content = (result.data?.result?.content || []).map(item => item.text || '').join('')
    let payload
    try { payload = JSON.parse(content) } catch (_) {
      return { iteration, text, elapsedMs, started, startedEpochMs, startedMonotonicMs, responseCompletedAt, responseCompletedEpochMs, responseCompletedMonotonicMs, statusCode: result.response.status, error: `tool response was not JSON: ${content}` }
    }
    const uid = payload.uid || payload.node?.uid
    if (!uid) return { iteration, text, elapsedMs, started, startedEpochMs, startedMonotonicMs, responseCompletedAt, responseCompletedEpochMs, responseCompletedMonotonicMs, statusCode: result.response.status, error: `UID missing: ${content}` }
    return {
      iteration, text, uid, elapsedMs, started, startedEpochMs, startedMonotonicMs, responseCompletedAt, responseCompletedEpochMs, responseCompletedMonotonicMs, statusCode: result.response.status,
      toolPayload: payload,
      operationId: payload.operationId || payload.operation_id || payload.operation?.operation_id || null,
      version: Number.isSafeInteger(Number(payload.version)) ? Number(payload.version) : null
    }
  } catch (error) {
    return { iteration, text, elapsedMs: Number(process.hrtime.bigint() - startedNs) / 1e6, started, startedEpochMs, startedMonotonicMs, responseCompletedAt: new Date().toISOString(), responseCompletedEpochMs: Date.now(), responseCompletedMonotonicMs: performance.now(), error: String(error.stack || error) }
  }
}

function pgConfig() {
  return {
    host: process.env.MCP_BASELINE_PGHOST || '127.0.0.1',
    port: Number(process.env.MCP_BASELINE_PGPORT || 25492),
    database: process.env.MCP_BASELINE_PGDATABASE || 'mcp_incremental_test',
    user: process.env.MCP_BASELINE_PGUSER || 'mcp_test',
    password: process.env.MCP_BASELINE_PGPASSWORD || 'mcp-incremental-test-db-password',
    application_name: `mcp-baseline-harness-${runId}`
  }
}

async function withDb(fn) {
  const client = new Client(pgConfig())
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

async function readMeta(base, roomKey) {
  const { response, data, text } = await api(base, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
  assert.equal(response.status, 200, `meta read ${roomKey}: ${response.status} ${text}`)
  const version = Number(data.currentRevision ?? data.revision ?? data.version)
  assert.ok(Number.isSafeInteger(version) && version >= 0, `meta version missing: ${JSON.stringify(data)}`)
  return { version, data }
}

function fixtureNodesByUid(tree) {
  const out = new Map()
  const visit = (node, parentUid = null) => {
    const uid = String(node?.data?.uid || '')
    assert.ok(uid, 'fixture node UID is required')
    assert.ok(!out.has(uid), `duplicate fixture UID ${uid}`)
    out.set(uid, { uid, parentUid, text: String(node.data.text || '') })
    for (const child of node.children || []) visit(child, uid)
  }
  visit(tree)
  return out
}

function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim()
}

function htmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function validateStartupNormalization(roomKey, seedVersion, stableVersion, fixtureTree) {
  return withDb(async client => {
    const result = await client.query(
      `select version::int, operation_id::text, operation_type, actor_id, client_id, payload
       from room_operations where room_key = $1 and version > $2 and version <= $3 order by version`,
      [roomKey, seedVersion, stableVersion]
    )
    const rows = result.rows
    assert.equal(rows.length, stableVersion - seedVersion, `startup operation/version gap ${roomKey}`)
    const fixtureByUid = fixtureNodesByUid(fixtureTree)
    const initializationOperations = []
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      assert.equal(row.version, seedVersion + index + 1, `non-contiguous startup operation ${roomKey}`)
      assert.equal(row.operation_type, 'node.batch', `unexpected pre-measurement operation type ${row.operation_type}`)
      assert.ok(row.client_id && row.client_id !== 'mcp-incremental-test-agent', `startup operation must be browser-originated ${roomKey}`)
      assert.equal(row.actor_id, 'anonymous', `unexpected startup actor ${row.actor_id}`)
      assert.equal(Number(row.payload?.baseRevision), row.version - 1, `startup baseRevision mismatch ${roomKey}`)
      assert.ok(Array.isArray(row.payload?.ops) && row.payload.ops.length > 0, `startup batch has no updates ${roomKey}`)
      const updates = row.payload.ops.map(item => {
        assert.equal(item?.type, 'node.update', `unexpected startup batch member ${roomKey}`)
        const value = item.payload || {}
        assert.deepEqual(Object.keys(value).sort(), ['richText', 'text', 'uid'], `startup update fields changed ${roomKey}`)
        const expected = fixtureByUid.get(String(value.uid))
        assert.ok(expected, `startup normalization targeted an unknown fixture UID ${value.uid}`)
        assert.equal(value.richText, true, `startup richText flag ${value.uid}`)
        assert.equal(value.text, `<p>${htmlEscape(expected.text)}</p>`, `startup normalization changed visible text ${value.uid}`)
        return { uid: value.uid, fields: Object.keys(value).sort(), text: plainText(value.text), richText: value.richText }
      })
      initializationOperations.push({
        version: row.version,
        operationId: row.operation_id,
        operationType: row.operation_type,
        actorId: row.actor_id,
        clientId: row.client_id,
        baseRevision: Number(row.payload.baseRevision),
        updates
      })
    }
    return initializationOperations
  })
}

async function captureStableHead(base, roomKey, seedVersion, fixtureTree) {
  const observations = []
  for (let attempt = 1; attempt <= 8; attempt++) {
    const first = await readMeta(base, roomKey)
    await new Promise(resolve => setTimeout(resolve, 500))
    const second = await readMeta(base, roomKey)
    observations.push({ attempt, firstVersion: first.version, secondVersion: second.version, sampledAt: new Date().toISOString() })
    if (first.version !== second.version) continue
    const initializationOperations = await validateStartupNormalization(roomKey, seedVersion, second.version, fixtureTree)
    const confirmation = await readMeta(base, roomKey)
    observations.push({ attempt, confirmationVersion: confirmation.version, confirmedAt: new Date().toISOString() })
    if (confirmation.version === second.version) {
      return { version: confirmation.version, data: confirmation.data, observations, initializationOperations }
    }
  }
  throw new Error(`room version did not stabilize after all browser clients saved: ${roomKey}`)
}

async function validateBaseGraph(roomKey, expectedNodes, leafCountPerBranch = 299, branchPrefix = `${roomKey}-branch-`, expectedTree = null) {
  return withDb(async client => {
    const counts = await client.query(
      `select count(*)::int as stored,
              count(*) filter (where deleted_at is null)::int as live,
              count(*) filter (where deleted_at is not null)::int as tombstones,
              count(*) filter (where is_root)::int as roots
       from room_nodes where room_key = $1`,
      [roomKey]
    )
    const root = await client.query(
      `select count(*)::int as children from room_nodes
       where room_key = $1 and parent_uid = 'root' and deleted_at is null`,
      [roomKey]
    )
    const branch = await client.query(
      `select parent_uid as uid, count(*)::int as children from room_nodes
       where room_key = $1 and parent_uid like $2 and deleted_at is null
       group by parent_uid order by parent_uid`,
      [roomKey, `${branchPrefix}%`]
    )
    assert.equal(counts.rows[0].live, expectedNodes, `live rows ${roomKey}`)
    assert.equal(counts.rows[0].stored, expectedNodes, `stored rows ${roomKey}`)
    assert.equal(counts.rows[0].tombstones, 0, `unexpected tombstones ${roomKey}`)
    assert.equal(counts.rows[0].roots, 1, `root row count ${roomKey}`)
    if (expectedNodes === 6001) {
      assert.equal(root.rows[0].children, 20, `root base branches ${roomKey}`)
      assert.equal(branch.rows.length, 20, `branch count ${roomKey}`)
      for (const row of branch.rows) assert.equal(row.children, leafCountPerBranch, `leaf count for ${row.uid}`)
    }
    const graph = { ...counts.rows[0], rootChildren: root.rows[0].children, branches: branch.rows.length }
    if (expectedTree) {
      const expectedByUid = fixtureNodesByUid(expectedTree)
      const actual = await client.query(
        `select uid, parent_uid, data->>'text' as text
         from room_nodes where room_key = $1 and deleted_at is null order by uid`,
        [roomKey]
      )
      assert.equal(actual.rows.length, expectedByUid.size, `fixture row count changed ${roomKey}`)
      for (const row of actual.rows) {
        const expected = expectedByUid.get(row.uid)
        assert.ok(expected, `unexpected fixture UID ${row.uid}`)
        assert.equal(row.parent_uid, expected.parentUid, `fixture parent changed for ${row.uid}`)
        assert.equal(plainText(row.text), plainText(expected.text), `fixture visible text changed for ${row.uid}`)
      }
    }
    return graph
  })
}

async function validateRound(roomKey, baseVersion, endVersion, calls) {
  return withDb(async client => {
    const result = await client.query(
      `select version::int, operation_id::text, operation_type, actor_id, client_id, payload
       from room_operations where room_key = $1 and version > $2 order by version`,
      [roomKey, baseVersion]
    )
    const ops = result.rows
    const successful = calls.filter(call => call.uid)
    for (let index = 0; index < ops.length; index++) {
      assert.equal(ops[index].version, baseVersion + index + 1, `non-contiguous version ${roomKey} at index ${index}`)
    }
    assert.equal(ops.length, endVersion - baseVersion, `operation log/version delta mismatch ${roomKey}`)

    const byText = new Map()
    for (const operation of ops) {
      const text = operation.payload?.text
      if (typeof text !== 'string') continue
      const matches = byText.get(text) || []
      matches.push(operation)
      byText.set(text, matches)
    }
    const matchedMcpOps = []
    for (const call of successful) {
      const matches = byText.get(call.text) || []
      assert.equal(matches.length, 1, `MCP call must map to exactly one committed operation (${call.text})`)
      const operation = matches[0]
      if (call.operationId) assert.equal(operation.operation_id, call.operationId, `operation ID mismatch ${roomKey} ${call.text}`)
      if (call.version != null) assert.equal(operation.version, call.version, `tool version mismatch ${roomKey} ${call.text}`)
      call.committedOperationId = operation.operation_id
      call.committedVersion = operation.version
      matchedMcpOps.push(operation)
    }
    const matchedIds = new Set(matchedMcpOps.map(operation => operation.operation_id))
    const extraOperations = ops.filter(operation => !matchedIds.has(operation.operation_id))

    const graph = await client.query(
      `select count(*) filter (where deleted_at is null)::int as live,
              count(*) filter (where deleted_at is not null)::int as tombstones,
              count(*) filter (where parent_uid = 'root' and deleted_at is null)::int as root_children,
              count(distinct uid)::int as unique_uids
       from room_nodes where room_key = $1`,
      [roomKey]
    )
    assert.equal(graph.rows[0].tombstones, 0, `unexpected tombstones ${roomKey}`)
    assert.equal(graph.rows[0].unique_uids, graph.rows[0].live + graph.rows[0].tombstones, `duplicate UID count ${roomKey}`)
    const mcpRows = await client.query(
      `select uid, parent_uid from room_nodes where room_key = $1 and uid = any($2::text[]) and deleted_at is null`,
      [roomKey, successful.map(call => call.uid)]
    )
    assert.equal(mcpRows.rows.length, successful.length, `MCP-created node count ${roomKey}`)
    for (const row of mcpRows.rows) assert.equal(row.parent_uid, 'root', `MCP-created node parent ${row.uid}`)
    const fixtureNodes = await client.query(
      `select count(*)::int as count from room_nodes where room_key = $1 and uid like 'fixture-6001-%' and deleted_at is null`,
      [roomKey]
    )
    assert.equal(fixtureNodes.rows[0].count, 6000, `base fixture nodes changed ${roomKey}`)
    const fixtureBranches = await client.query(
      `select parent_uid as uid, count(*)::int as children from room_nodes
       where room_key = $1 and parent_uid like 'fixture-6001-branch-%' and deleted_at is null
       group by parent_uid order by parent_uid`,
      [roomKey]
    )
    assert.equal(fixtureBranches.rows.length, 20, `fixture branch count ${roomKey}`)
    for (const row of fixtureBranches.rows) assert.equal(row.children, 299, `fixture branch shape changed ${row.uid}`)
    const children = await client.query(
      `select count(*)::int as count from room_nodes n
       left join room_nodes p on p.room_key = n.room_key and p.uid = n.parent_uid and p.deleted_at is null
       where n.room_key = $1 and n.deleted_at is null and n.parent_uid is not null and p.uid is null`,
      [roomKey]
    )
    assert.equal(children.rows[0].count, 0, `orphan nodes ${roomKey}`)
    return { operations: ops, matchedMcpOps, extraOperations, graph: graph.rows[0], fixtureNodes: fixtureNodes.rows[0].count, orphanNodes: children.rows[0].count }
  })
}

function readAppMetricRows() {
  const prefix = `${runId}-app-`
  const files = fs.readdirSync(outputDir).filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
  const parsed = []
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(outputDir, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try { parsed.push(JSON.parse(line)) } catch (_) {}
    }
  }
  return { files, rows: parsed }
}

async function dockerStats() {
  try {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'mcp-incremental-test-app-a-1', 'mcp-incremental-test-app-b-1', 'mcp-incremental-test-postgres-1', 'mcp-incremental-test-redis-1'], { encoding: 'utf8', timeout: 15000 })
    if (result.status !== 0) return { error: (result.stderr || result.stdout || '').trim() }
    return result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch (_) { return line } })
  } catch (error) {
    return { error: String(error.message || error) }
  }
}

const errors = []
const qualityFailures = priorRoundResults.flatMap(round => {
  const failures = []
  if (round.browser?.remoteVisibility?.status !== 'measured') failures.push({ round: round.round, roomKey: round.roomKey, type: 'remote-visibility', result: round.browser?.remoteVisibility || null })
  if (round.browser?.lcpSamples?.some(sample => sample.status !== 'measured')) failures.push({ round: round.round, roomKey: round.roomKey, type: 'lcp-unavailable' })
  return failures
})
const roundsOutput = [...priorRoundResults]
const health = []
for (const base of [appA, appB]) {
  const result = await api(base, '/api/health')
  assert.equal(result.response.status, 200, `health ${base}: ${result.text}`)
  health.push({ base, status: result.response.status, body: result.data })
}
if (resumeFromRound === 1) {
  append({ type: 'suite_start', startedAt, rounds, writesPerRound, health, sourceCommit })
} else {
  append({
    type: 'suite_resume', startedAt, resumeFromRound, resumeId, rounds: roundsOutput.length,
    writesPerRound, sourceCommit, reason: '继续已有有效轮次；前次在新round写入计时前被seed-version断言中止。'
  })
  errors.push(...roundsOutput.flatMap(round => (round.calls || []).filter(call => call.error).map(call => ({ round: round.round, roomKey: round.roomKey, ...call }))))
}

const sessions = [await initialize(appA, 'app-a'), await initialize(appB, 'app-b')]

// Warm each real MCP server once, then exclude those calls from the baseline.
if (resumeFromRound === 1) {
  warmRoomKey = `mcp-baseline-warmup-${randomUUID().slice(0, 12)}`
  await seedRoom(appA, warmRoomKey, 'small')
  for (const session of sessions) {
    for (let index = 0; index < 3; index++) warmupCalls.push(await callAddNode(session, warmRoomKey, `warmup-${session.label}-${index}`))
  }
  append({ type: 'warmup', roomKey: warmRoomKey, calls: warmupCalls })
}

for (let round = resumeFromRound; round <= rounds; round++) {
  const roomKey = `mcp-baseline-${runId}-${String(round).padStart(2, '0')}-${randomUUID().slice(0, 8)}`
  const session = sessions[(round - 1) % sessions.length]
  const roundStartedAt = new Date().toISOString()
  const fixture = await seedRoom(session.base, roomKey, '6001', { prefix: 'fixture-6001' })
  const fixtureHash = createHash('sha256').update(JSON.stringify(fixture.tree)).digest('hex')
  assert.equal(fixture.expectedCount, 6001)
  const browserRunId = resumeFromRound > 1
    ? `${runId}-${resumeId}-round-${String(round).padStart(2, '0')}`
    : `${runId}-round-${String(round).padStart(2, '0')}`
  let browserState = null
  let browserWriteLoad = null
  let remoteVisibility = null
  let remoteProbe = null
  let remoteResponseAt = null
  let callRows = []
  let totalMs = null
  let measuredStartedAt = null
  let measuredFinishedAt = null
  let fixtureStart = null
  let measuredEnd = null
  let initialGraph = null
  let initializationOperations = []
  let headStabilityObservations = []
  let checked = null
  try {
    browserState = await openBrowserClients({
      appA, appB, roomKey, runId: browserRunId, outputDir,
      pageLoadConcurrency: 4,
      expectedStructure: {
        rootUid: 'root', rootText: 'Baseline root fixture-6001',
        branchUid: 'fixture-6001-branch-01', branchText: 'Branch 2', collapsedChildCount: 299
      }
    })
    const loadReady = browserState.loadMetrics.summary
    assert.equal(browserState.clients.length, 13, `opened browser contexts ${roomKey}`)
    assert.equal(loadReady.collabV2ReadyClients, 13, `collabV2 readiness ${roomKey}: ${JSON.stringify(loadReady.collabV2ReadinessFailures)}`)
    assert.equal(loadReady.savedClients, 13, `browser save state ${roomKey}: ${JSON.stringify(loadReady.saveReadinessFailures)}`)
    assert.deepEqual(loadReady.saveReadinessFailures, [], `browser save state failures ${roomKey}`)
    assert.equal(loadReady.viewNormalizedClients, 13, `view normalization ${roomKey}: ${JSON.stringify(loadReady.viewNormalizationFailures)}`)
    assert.deepEqual(loadReady.viewNormalizationFailures, [], `view normalization failures ${roomKey}`)
    assert.equal(loadReady.structureReadyClients, 13, `root/Branch2 structure readiness ${roomKey}: ${JSON.stringify(loadReady.structureReadinessFailures)}`)
    assert.deepEqual(loadReady.failedClients, [], `browser navigation failures ${roomKey}`)
    assert.equal(browserState.websocketMetrics.instrumentedClients, 13, `WebSocket instrumentation ${roomKey}`)

    // Read a stable base after all 13 clients show the product's saved state.
    // Opening a legacy plain-text fixture may commit a browser-originated rich-text
    // normalization batch; allow it only when its payload proves that visible text
    // and the complete fixture graph remain unchanged.
    const stableHead = await captureStableHead(session.base, roomKey, fixture.version, fixture.tree)
    fixtureStart = stableHead
    initializationOperations = stableHead.initializationOperations
    headStabilityObservations = stableHead.observations
    initialGraph = await validateBaseGraph(roomKey, 6001, 299, 'fixture-6001-branch-', fixture.tree)
    const marker = `mcp-baseline-${runId}-round-${round}-remote-marker`
    remoteProbe = await armRemoteVisibility(browserState.clients, marker, { instance: 'appB', timeoutMs: 30_000 })
    const observerStart = await startWriteLoadObservers(browserState.clients)
    assert.equal(observerStart.longTasks.filter(item => item.status === 'started').length, 13, `LongTask observer start ${roomKey}`)
    assert.equal(observerStart.websocket.instrumentedClients, 13, `WebSocket observer start ${roomKey}`)

    measuredStartedAt = new Date().toISOString()
    const measuredStart = process.hrtime.bigint()
    let remoteResponseAt = null
    let remoteResponseEpochMs = null
    let remoteOperationIdFromResponse = null
    for (let index = 1; index <= writesPerRound; index++) {
      const iteration = `r${String(round).padStart(2, '0')}-n${String(index).padStart(3, '0')}`
      const text = index === 1 ? marker : null
      const result = await callAddNode(session, roomKey, iteration, text)
      callRows.push(result)
      if (index === 1) {
        remoteResponseAt = result.responseCompletedMonotonicMs
        remoteResponseEpochMs = result.responseCompletedEpochMs
        remoteOperationIdFromResponse = result.operationId
      }
      append({ type: 'mcp_call', round, instance: session.label, roomKey, ...result })
      if (result.error) errors.push({ round, roomKey, ...result })
    }
    totalMs = Number(process.hrtime.bigint() - measuredStart) / 1e6
    measuredFinishedAt = new Date().toISOString()

    // Stop browser observers and await the already-running remote probe outside the 100-call timing window.
    browserWriteLoad = await finishWriteLoadObservers(browserState.clients)
    remoteVisibility = await finishRemoteVisibilityProbe(remoteProbe, {
      writeCompletedAt: remoteResponseAt,
      requestStartedAtEpochMs: callRows[0]?.startedEpochMs ?? null,
      responseCompletedAtEpochMs: remoteResponseEpochMs,
      requestStartedAtMonotonicMs: callRows[0]?.startedMonotonicMs ?? null,
      responseCompletedAtMonotonicMs: remoteResponseAt,
      operationId: remoteOperationIdFromResponse
    })
    remoteVisibility.mcpRequestStartedAtEpochMs = callRows[0]?.startedEpochMs ?? null
    remoteVisibility.mcpResponseCompletedAtEpochMs = remoteResponseEpochMs
    remoteVisibility.mcpOperationText = callRows[0]?.text ?? null
    remoteVisibility.requestStartedAt = callRows[0]?.started ?? null
    remoteVisibility.responseCompletedAt = callRows[0]?.responseCompletedAt ?? null
    remoteVisibility.timestampTranslation = 'Browser Date.now epoch timestamps are supplied by the page and compared on the shared host clock; performance.now values remain local to their own browser or Node context and are not subtracted across contexts. Epoch clock error is not calibrated.'
    const probeWallEpochMs = Date.now()
    const probeMonotonicMs = performance.now()
    for (const client of remoteVisibility.clients || []) {
      const seenMonotonicMs = client.seenAtMonotonicMs ?? client.detectedAtMonotonicMs ?? client.detectedAt ?? null
      if (Number.isFinite(seenMonotonicMs)) {
        client.seenAtMonotonicMs = seenMonotonicMs
        client.seenAtEpochMs ??= client.detectedAtEpochMs ?? probeWallEpochMs + (seenMonotonicMs - probeMonotonicMs)
        client.detectedAtEpochMs ??= client.seenAtEpochMs
      }
    }
    if (remoteVisibility.status !== 'measured') qualityFailures.push({ round, roomKey, type: 'remote-visibility', result: remoteVisibility })

    measuredEnd = await readMeta(session.base, roomKey)
    checked = await validateRound(roomKey, fixtureStart.version, measuredEnd.version, callRows)
    const markerOperation = checked.matchedMcpOps.find(operation => operation.payload?.text === remoteVisibility.marker)
    remoteVisibility.operationId = markerOperation?.operation_id || null
    remoteVisibility.opId = remoteVisibility.operationId
    remoteVisibility.operationVersion = markerOperation?.version ?? null
  } finally {
    if (browserState) await closeBrowserClients(browserState)
  }

  const browserArtifactPath = path.join(outputDir, `${browserRunId}-browser-metrics.json`)
  const browserMetrics = JSON.parse(fs.readFileSync(browserArtifactPath, 'utf8'))
  if (browserMetrics.loadMetrics.summary.lcpUnavailableClients?.length) {
    qualityFailures.push({ round, roomKey, type: 'lcp-unavailable', clients: browserMetrics.loadMetrics.summary.lcpUnavailableClients })
  }
  const latencies = callRows.map(call => call.elapsedMs)
  const roundResult = {
    round, roomKey, instance: session.label,
    startedAt: roundStartedAt,
    measuredStartedAt,
    measuredFinishedAt,
    finishedAt: new Date().toISOString(),
    fixtureHash,
    roomKeyHash: roomHash(roomKey),
    seedVersion: fixture.version,
    baseVersion: fixtureStart.version,
    initializationVersionDelta: fixtureStart.version - fixture.version,
    initializationOperations,
    headStabilityObservations,
    endVersion: measuredEnd.version,
    versionDelta: measuredEnd.version - fixtureStart.version,
    fixtureNodes: fixture.expectedCount,
    initialGraph,
    writesAttempted: writesPerRound,
    writesSucceeded: callRows.filter(call => call.uid).length,
    totalMs,
    perCall: summarize(latencies),
    calls: callRows,
    operationIds: checked.matchedMcpOps.map(operation => operation.operation_id),
    operationVersions: checked.matchedMcpOps.map(operation => operation.version),
    extraOperations: checked.extraOperations,
    graph: checked.graph,
    fixtureLiveNodes: checked.fixtureNodes,
    orphanNodes: checked.orphanNodes,
    browser: {
      artifact: path.basename(browserArtifactPath),
      loadSummary: browserMetrics.loadMetrics.summary,
      lcpSamples: browserMetrics.loadMetrics.clients.map(client => ({ clientId: client.clientId, instance: client.instance, status: client.lcpStatus, lcpMs: client.lcpMs })),
      websocketTotalsAtClose: browserMetrics.websocketMetrics.totals,
      writeLoad: browserWriteLoad,
      remoteVisibility
    }
  }
  roundsOutput.push(roundResult)
  append({ type: 'round_complete', ...roundResult })
  console.log(JSON.stringify({ type: 'round_complete', round, roomKey, instance: session.label, totalMs, p95Ms: roundResult.perCall.p95Ms, successful: roundResult.writesSucceeded, versionDelta: roundResult.versionDelta, extraOperations: checked.extraOperations.length, remoteVisible: remoteVisibility.status }))
}

const allLatencies = roundsOutput.flatMap(round => round.calls.map(call => call.elapsedMs))
const browserLcpSamples = roundsOutput.flatMap(round => round.browser.lcpSamples)
const browserWriteLongTaskSamples = roundsOutput.flatMap(round => round.browser.writeLoad.longTasks.samples)
const remoteVisibilitySamples = roundsOutput.map(round => round.browser.remoteVisibility)
// App-side metrics are buffered and flushed once per second to avoid retaining
// every query in long-running server processes. Wait for the final measured
// events to reach the shared result volume before collecting them.
await new Promise(resolve => setTimeout(resolve, 1200))
const metrics = readAppMetricRows()
const allOperationIds = new Set(roundsOutput.flatMap(round => round.operationIds))
const measuredWindows = new Map(roundsOutput.map(round => [roomHash(round.roomKey), {
  start: Date.parse(round.measuredStartedAt),
  end: Date.parse(round.measuredFinishedAt)
}]))
const isInMeasuredWindow = row => {
  const window = measuredWindows.get(row.roomKeyHash)
  if (!window) return false
  const at = Date.parse(row.time || '')
  return Number.isFinite(at) && at >= window.start && at <= window.end
}
const transactions = metrics.rows.filter(row => row.type === 'pg_transaction' && (row.operationIds || []).some(id => allOperationIds.has(id)))
const cacheRows = metrics.rows.filter(row => row.type === 'cache_sync' && allOperationIds.has(row.operationId))
const lockRows = metrics.rows.filter(row => row.type === 'pg_query' && row.kind === 'lock_acquire' && isInMeasuredWindow(row))
const roomNodeReadRows = metrics.rows.filter(row => row.type === 'pg_query' && row.kind === 'room_nodes_read' && isInMeasuredWindow(row))
const mcpHttpRows = metrics.rows.filter(row => row.type === 'http_client' && isInMeasuredWindow(row) && ['mcp_meta_read', 'mcp_node_write'].includes(row.kind))
const instrumentation = metrics.rows.filter(row => row.type === 'instrumentation' || row.type === 'source_observer')
const operationTransactionTimes = transactions.map(row => row.elapsedMs)
const operationCacheTimes = cacheRows.map(row => row.elapsedMs)
const transactionLockRoundTrips = transactions.flatMap(row => row.lockAcquireRoundTripMs || [])
const remoteCommitCorrelations = roundsOutput.map(round => {
  const remote = round.browser.remoteVisibility
  const transaction = transactions.find(row => (row.operationIds || []).includes(remote.operationId)) || null
  const pgTransactionObservedAtEpochMs = transaction?.time ? Date.parse(transaction.time) : null
  return {
    round: round.round,
    roomKeyHash: round.roomKeyHash,
    marker: remote.marker,
    operationId: remote.operationId,
    operationVersion: remote.operationVersion,
    requestStartedAtEpochMs: remote.requestStartedAtEpochMs ?? remote.mcpRequestStartedAtEpochMs ?? null,
    responseCompletedAtEpochMs: remote.responseCompletedAtEpochMs ?? remote.mcpResponseCompletedAtEpochMs ?? null,
    pgTransactionObservedAt: transaction?.time || null,
    pgTransactionObservedAtEpochMs: Number.isFinite(pgTransactionObservedAtEpochMs) ? pgTransactionObservedAtEpochMs : null,
    pgTransactionElapsedMs: transaction?.elapsedMs ?? null,
    clients: (remote.clients || []).map(client => ({
      clientId: client.clientId,
      status: client.status,
      seenAtEpochMs: client.seenAtEpochMs ?? client.detectedAtEpochMs ?? null,
      latencyFromMcpResponseMs: client.latencyMs ?? null,
      observedCommitToSeenMs: Number.isFinite(client.seenAtEpochMs ?? client.detectedAtEpochMs) && Number.isFinite(pgTransactionObservedAtEpochMs)
        ? (client.seenAtEpochMs ?? client.detectedAtEpochMs) - pgTransactionObservedAtEpochMs
        : null
    })),
    correlationStatus: transaction && remote.operationId ? 'correlated' : 'missing-operation-id-or-pg-transaction'
  }
})
const sourceObservers = instrumentation.filter(row => row.type === 'source_observer' && row.component === 'applyCommittedLive')
const observedInstances = new Set(sourceObservers.filter(row => row.installed).map(row => row.instance))
const expectedOperations = rounds * writesPerRound
const metricCoverage = {
  expectedOperations,
  expectedHttpCalls: expectedOperations * 2,
  observedTransactions: transactions.length,
  observedCacheEvents: cacheRows.length,
  observedHttpCalls: mcpHttpRows.length,
  sourceObserverInstances: [...observedInstances],
  complete: transactions.length === expectedOperations &&
    cacheRows.length === expectedOperations &&
    mcpHttpRows.length === expectedOperations * 2 &&
    observedInstances.has('app-a') && observedInstances.has('app-b')
}
const lockWaitLogPath = path.join(outputDir, `${runId}-postgres-lock-waits.log`)
let postgresLogCapture = { captured: false, error: 'not attempted' }
try {
  const { spawnSync } = await import('node:child_process')
  const from = new Date(new Date(startedAt).getTime() - 10_000).toISOString()
  const result = spawnSync('docker', ['logs', '--since', from, 'mcp-incremental-test-postgres-1'], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 })
  if (result.status === 0) {
    fs.writeFileSync(lockWaitLogPath, result.stderr + result.stdout)
    const allLines = `${result.stderr}${result.stdout}`.split(/\r?\n/)
    const waitLines = allLines.filter(line => /still waiting for .* lock/i.test(line))
    postgresLogCapture = { captured: true, file: path.basename(lockWaitLogPath), exitCode: result.status, trueWaitStartLines: waitLines.length }
  } else {
    postgresLogCapture = { captured: false, error: (result.stderr || result.stdout || '').trim() }
  }
} catch (error) {
  postgresLogCapture = { captured: false, error: String(error.message || error) }
}

const summary = {
  schema: 1,
  runId,
  sourceCommit,
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: {
    appA, appB, rounds, writesPerRound,
    realMcpToolCalls: rounds * writesPerRound,
    fixture: 'one root + 20 branches + 299 leaves per branch = 6001 nodes',
    mcpToken: '[test-only token omitted]',
    metricFiles: metrics.files,
    dockerStats: await dockerStats()
  },
  health,
  warmup: { roomKey: warmRoomKey, callCount: warmupCalls.length, errors: warmupCalls.filter(row => row.error) },
  results: {
    singleNodeToolRoundTrip: summarize(allLatencies),
    perRoundTotalMs: summarize(roundsOutput.map(round => round.totalMs)),
    pgTransaction: summarize(operationTransactionTimes),
    lockAcquireRoundTrip: summarize(transactionLockRoundTrips),
    cacheObserver: summarize(operationCacheTimes),
    operationMetrics: {
      transactions: transactions.length,
      cacheSyncEvents: cacheRows.length,
      lockAcquireQueries: lockRows.length,
      roomNodesReads: roomNodeReadRows.length,
      mcpHttpCalls: mcpHttpRows.length,
      coverage: metricCoverage,
      instrumentationEvents: instrumentation
    },
    databaseLockWaits: { artifact: postgresLogCapture, interpretation: 'Only PostgreSQL log_lock_waits records are true waits. FOR UPDATE query round trips are reported separately and are not lock-wait time.' },
    browserLoad: {
      lcp: summarize(browserLcpSamples.filter(item => item.status === 'measured').map(item => item.lcpMs)),
      lcpUnavailable: browserLcpSamples.filter(item => item.status !== 'measured'),
      sampleCount: browserLcpSamples.length,
      longTasksDuringMcpWrites: {
        clients: browserWriteLongTaskSamples.length,
        measuredClients: browserWriteLongTaskSamples.filter(item => item.status === 'measured').length,
        totalCount: browserWriteLongTaskSamples.reduce((sum, item) => sum + (item.count || 0), 0),
        totalDurationMs: browserWriteLongTaskSamples.reduce((sum, item) => sum + (item.totalMs || 0), 0),
        maxTaskMs: Math.max(0, ...browserWriteLongTaskSamples.map(item => item.maxMs || 0)),
        samples: browserWriteLongTaskSamples
      },
      websocketDuringMcpWrites: roundsOutput.map(round => ({ round: round.round, ...round.browser.writeLoad.websocket.totals }))
    },
    remoteVisibility: {
      measurement: 'Six appB client observations per round. Epoch timestamps are compared with preload pg_transaction.time, which is recorded immediately after the COMMIT query returns; report this as an instrumented commit-response correlation, not a database-internal commit timestamp. Browser and app clocks are expected to share the host clock; clock error is not calibrated.',
      samples: remoteVisibilitySamples,
      commitCorrelations: remoteCommitCorrelations
    },
    browserExpandCollapse: { status: 'separate-run-pending', command: 'npm --prefix tests/mcp-incremental run interactions' },
    rounds: roundsOutput
  },
  errors,
  qualityFailures,
  retryPolicy: { retriesAttempted: 0, note: 'Baseline preserves each real request sample; failures and ambiguous outcomes are recorded without retry.' },
  rawFiles: {
    harnessJsonl: path.basename(resultPath),
    appMetrics: metrics.files,
    postgresLog: postgresLogCapture.file || null,
    browserArtifacts: roundsOutput.map(round => round.browser.artifact)
  }
}
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
append({ type: 'suite_complete', summaryFile: path.basename(summaryPath), totalCalls: rounds * writesPerRound, errors: errors.length })
suiteComplete = true
console.log(JSON.stringify({ type: 'suite_complete', summary: summaryPath, raw: resultPath, rounds: roundsOutput.length, calls: allLatencies.length, errors: errors.length, p50Ms: summary.results.singleNodeToolRoundTrip.p50Ms, p95Ms: summary.results.singleNodeToolRoundTrip.p95Ms, p99Ms: summary.results.singleNodeToolRoundTrip.p99Ms }))

if (errors.length || qualityFailures.length || allLatencies.length !== rounds * writesPerRound || !metricCoverage.complete || browserLcpSamples.filter(item => item.status === 'measured').length !== rounds * 13) process.exitCode = 1
