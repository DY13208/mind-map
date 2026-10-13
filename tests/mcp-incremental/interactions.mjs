import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { api, appA, appB, seedRoom } from './fixtures.mjs'
import { closeBrowserClients, measureExpandCollapse, openBrowserClients } from './browser-baseline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(here, 'results')
fs.mkdirSync(outputDir, { recursive: true })
const baselineRunId = String(process.env.MCP_BASELINE_RUN_ID || `baseline-${new Date().toISOString().replace(/[:.]/g, '-')}`).replace(/[^a-zA-Z0-9_-]/g, '-')
const runId = String(process.env.MCP_BASELINE_INTERACTION_RUN_ID || `${baselineRunId}-interactions`).replace(/[^a-zA-Z0-9_-]/g, '-')
const sourceCommitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' })
const sourceCommit = sourceCommitResult.status === 0 ? sourceCommitResult.stdout.trim() : 'unavailable'
const roomKey = `mcp-b2-${randomUUID().slice(0, 12)}`
const summaryPath = path.join(outputDir, `${runId}-interaction-summary.json`)
const checkpointPath = path.join(outputDir, `${runId}-checkpoints.jsonl`)
if (fs.existsSync(summaryPath) || fs.existsSync(checkpointPath)) throw new Error(`interaction run ${runId} already has output; choose a new run ID`)
fs.writeFileSync(checkpointPath, '')

function checkpoint(entry) {
  const { page, ...sample } = entry
  fs.appendFileSync(checkpointPath, `${JSON.stringify({ schema: 1, runId, roomKey, at: new Date().toISOString(), ...sample })}\n`)
  return page
}

const structure = {
  rootUid: 'root',
  rootText: 'Baseline root fixture-6001',
  branchUid: 'fixture-6001-branch-09',
  branchText: 'Branch 10',
  collapsedChildCount: 299
}

function fixtureNodesByUid(tree) {
  const nodes = new Map()
  const visit = (node, parentUid = null) => {
    const uid = String(node?.data?.uid || '')
    assert.ok(uid && !nodes.has(uid), `fixture UID must be unique: ${uid}`)
    nodes.set(uid, { uid, parentUid, text: String(node.data.text || '') })
    for (const child of node.children || []) visit(child, uid)
  }
  visit(tree)
  return nodes
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

function pgConfig() {
  return {
    host: process.env.MCP_BASELINE_PGHOST || '127.0.0.1',
    port: Number(process.env.MCP_BASELINE_PGPORT || 25492),
    database: process.env.MCP_BASELINE_PGDATABASE || 'mcp_incremental_test',
    user: process.env.MCP_BASELINE_PGUSER || 'mcp_test',
    password: process.env.MCP_BASELINE_PGPASSWORD || 'mcp-incremental-test-db-password',
    application_name: `mcp-baseline-interactions-${runId}`
  }
}

async function validateInitialization(roomKey, seedVersion, stableVersion, tree) {
  const client = new Client(pgConfig())
  await client.connect()
  try {
    const expected = fixtureNodesByUid(tree)
    const operations = await client.query(
      `select version::int, operation_id::text, operation_type, actor_id, client_id, payload
       from room_operations where room_key = $1 and version > $2 and version <= $3 order by version`,
      [roomKey, seedVersion, stableVersion]
    )
    assert.equal(operations.rows.length, stableVersion - seedVersion, `initialization operation gap ${roomKey}`)
    const normalized = []
    for (let index = 0; index < operations.rows.length; index++) {
      const row = operations.rows[index]
      assert.equal(row.version, seedVersion + index + 1)
      assert.equal(row.operation_type, 'node.batch', `unexpected startup operation ${row.operation_type}`)
      assert.equal(row.actor_id, 'anonymous')
      assert.ok(row.client_id && row.client_id !== 'mcp-incremental-test-agent')
      assert.equal(Number(row.payload?.baseRevision), row.version - 1)
      assert.ok(Array.isArray(row.payload?.ops) && row.payload.ops.length > 0)
      const updates = row.payload.ops.map(item => {
        assert.equal(item.type, 'node.update')
        const value = item.payload || {}
        assert.deepEqual(Object.keys(value).sort(), ['richText', 'text', 'uid'])
        const fixtureNode = expected.get(String(value.uid))
        assert.ok(fixtureNode, `unknown startup UID ${value.uid}`)
        assert.equal(value.richText, true)
        assert.equal(value.text, `<p>${fixtureNode.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
        return { uid: value.uid, text: plainText(value.text), richText: value.richText }
      })
      normalized.push({ version: row.version, operationId: row.operation_id, operationType: row.operation_type, actorId: row.actor_id, clientId: row.client_id, updates })
    }
    const graph = await client.query(
      `select uid, parent_uid, data->>'text' as text from room_nodes where room_key = $1 and deleted_at is null order by uid`,
      [roomKey]
    )
    assert.equal(graph.rows.length, expected.size, `fixture row count changed ${roomKey}`)
    for (const row of graph.rows) {
      const fixtureNode = expected.get(row.uid)
      assert.ok(fixtureNode, `unexpected fixture UID ${row.uid}`)
      assert.equal(row.parent_uid, fixtureNode.parentUid, `fixture parent changed ${row.uid}`)
      assert.equal(plainText(row.text), plainText(fixtureNode.text), `fixture visible text changed ${row.uid}`)
    }
    return normalized
  } finally {
    await client.end()
  }
}

async function captureStableHead(base, roomKey, seedVersion, tree) {
  const observations = []
  for (let attempt = 1; attempt <= 8; attempt++) {
    const first = await api(base, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
    assert.equal(first.response.status, 200, `meta first sample: ${first.text}`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const second = await api(base, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
    assert.equal(second.response.status, 200, `meta second sample: ${second.text}`)
    const firstVersion = Number(first.data.currentRevision ?? first.data.revision ?? first.data.version)
    const secondVersion = Number(second.data.currentRevision ?? second.data.revision ?? second.data.version)
    observations.push({ attempt, firstVersion, secondVersion, sampledAt: new Date().toISOString() })
    if (!Number.isSafeInteger(secondVersion) || firstVersion !== secondVersion) continue
    const initializationOperations = await validateInitialization(roomKey, seedVersion, secondVersion, tree)
    const confirmation = await api(base, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
    assert.equal(confirmation.response.status, 200)
    const confirmedVersion = Number(confirmation.data.currentRevision ?? confirmation.data.revision ?? confirmation.data.version)
    observations.push({ attempt, confirmedVersion, confirmedAt: new Date().toISOString() })
    if (confirmedVersion === secondVersion) return { version: confirmedVersion, observations, initializationOperations }
  }
  throw new Error(`room version did not stabilize after all browser clients saved: ${roomKey}`)
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null
  return {
    samples: sorted.length,
    p50Ms: at(0.50),
    p95Ms: at(0.95),
    p99Ms: at(0.99)
  }
}

async function measureSequentially(clients, options) {
  const perClient = []
  // All pages share one persisted room; a single page measures at a time to
  // avoid concurrent rendering and click interference on the shared canvas.
  for (const client of clients) {
    checkpoint({ phase: 'client-measure-start', clientId: client.id, instance: client.instance })
    const single = await measureExpandCollapse([client], {
      ...options,
      onCheckpoint: async event => {
        const page = checkpoint(event)
        if (event.phase === 'interaction-failure') {
          try {
            await page.screenshot({ path: path.join(outputDir, `${runId}-${event.clientId}-round-${event.round}-failure.png`), fullPage: false, timeout: 5000 })
          } catch (_) {}
        }
      }
    })
    perClient.push(single.perClient[0])
    checkpoint({ phase: 'client-measure-end', clientId: client.id, instance: client.instance, status: single.perClient[0]?.status, completedPairs: single.perClient[0]?.rounds?.filter(round => round.expand?.status === 'measured' && round.collapse?.status === 'measured').length || 0 })
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const measured = perClient.flatMap(sample => sample.rounds.filter(round => round.expand?.status === 'measured' && round.collapse?.status === 'measured'))
  const values = rounds => ({
    expand: summarize(rounds.map(round => round.expand.durationMs)),
    collapse: summarize(rounds.map(round => round.collapse.durationMs))
  })
  return {
    roundsRequested: options.rounds,
    condition: '13 real browser contexts remain online; one context performs three expand/collapse pairs at a time to avoid concurrent toggles against the shared room; other clients receive normal collabV2 operations',
    clients: perClient.length,
    completedClients: perClient.filter(sample => sample.status === 'measured').length,
    completedRoundPairs: measured.length,
    ...values(measured),
    cold: values(measured.filter(round => round.round === 1)),
    warm: values(measured.filter(round => round.round > 1)),
    perClient,
    samples: perClient
  }
}

checkpoint({ phase: 'suite-start', sourceCommit, nodeCountExpected: 6001 })
const fixtureStartedAt = Date.now()
const fixture = await seedRoom(appA, roomKey, '6001', { prefix: 'fixture-6001' })
const fixtureHash = createHash('sha256').update(JSON.stringify(fixture.tree)).digest('hex')
checkpoint({ phase: 'fixture-seeded', version: fixture.version, expectedCount: fixture.expectedCount, fixtureSha256: fixtureHash, durationMs: Date.now() - fixtureStartedAt })
let browser = null
let interaction = null
let baseVersion = null
let versionAfter = null
let initializationOperations = []
let headStabilityObservations = []
let caughtError = null
try {
  checkpoint({ phase: 'browser-open-start', concurrency: 4, expectedClients: 13 })
  browser = await openBrowserClients({ appA, appB, roomKey, runId, outputDir, pageLoadConcurrency: 4, expectedStructure: structure, onProgress: checkpoint })
  checkpoint({ phase: 'browser-open-end', ...(browser.loadMetrics.summary || {}) })
  const readiness = browser.loadMetrics.summary
  assert.equal(readiness.collabV2ReadyClients, 13, `collabV2 readiness: ${JSON.stringify(readiness.collabV2ReadinessFailures)}`)
  assert.equal(readiness.viewNormalizedClients, 13, `view normalization: ${JSON.stringify(readiness.viewNormalizationFailures)}`)
  assert.deepEqual(readiness.viewNormalizationFailures, [], 'view normalization failures')
  assert.equal(readiness.structureReadyClients, 13, `structure readiness: ${JSON.stringify(readiness.structureReadinessFailures)}`)
  assert.deepEqual(readiness.failedClients, [], 'browser navigation failures')

  const before = await api(appA, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
  assert.equal(before.response.status, 200, `meta before interactions: ${before.response.status} ${before.text}`)
  const seedVersion = Number(before.data.currentRevision ?? before.data.revision ?? before.data.version)
  assert.ok(Number.isSafeInteger(seedVersion), `missing seed version: ${JSON.stringify(before.data)}`)
  const stableHead = await captureStableHead(appA, roomKey, fixture.version, fixture.tree)
  baseVersion = stableHead.version
  initializationOperations = stableHead.initializationOperations
  headStabilityObservations = stableHead.observations
  checkpoint({ phase: 'stable-head', seedVersion: fixture.version, baseVersion, initializationOperationCount: initializationOperations.length, observations: headStabilityObservations })

  checkpoint({ phase: 'interaction-suite-start', clientCount: browser.clients.length, roundsPerClient: 3, timeoutMs: 20_000 })
  interaction = await measureSequentially(browser.clients, {
    rootUid: structure.rootUid,
    rootText: structure.rootText,
    branchUid: structure.branchUid,
    branchText: structure.branchText,
    expectedDirectChildren: structure.collapsedChildCount,
    rounds: 3,
    timeoutMs: 20_000
  })
  checkpoint({ phase: 'interaction-suite-end', completedClients: interaction.completedClients, completedRoundPairs: interaction.completedRoundPairs, expandP95Ms: interaction.expand?.p95Ms, collapseP95Ms: interaction.collapse?.p95Ms })

  const after = await api(appA, `/api/files/${encodeURIComponent(roomKey)}?format=meta`)
  assert.equal(after.response.status, 200, `meta after interactions: ${after.response.status} ${after.text}`)
  versionAfter = Number(after.data.currentRevision ?? after.data.revision ?? after.data.version)
  assert.equal(versionAfter, baseVersion, 'view-only expand/collapse must not change persisted room version')
  checkpoint({ phase: 'version-verified', baseVersion, versionAfter })
} catch (error) {
  caughtError = { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 1000) }
  checkpoint({ phase: 'suite-failure', error: caughtError })
} finally {
  checkpoint({ phase: 'browser-close-start', openedClients: browser?.clients?.length || 0 })
  if (browser) await closeBrowserClients(browser)
  checkpoint({ phase: 'browser-close-end' })
}

const browserArtifact = path.join(outputDir, `${runId}-browser-metrics.json`)
const browserMetrics = fs.existsSync(browserArtifact) ? JSON.parse(fs.readFileSync(browserArtifact, 'utf8')) : null
const completed = interaction?.completedClients === 13 && interaction?.completedRoundPairs === 39
const summary = {
  schema: 1,
  runId,
  sourceCommit,
  roomKey,
  fixture: { nodeCount: fixture.expectedCount, sha256: fixtureHash, shape: 'root + 20 branches + 299 leaves per branch' },
  clients: browser?.loadMetrics.summary || null,
  baseVersion,
  seedVersion: fixture.version,
  initializationVersionDelta: Number.isSafeInteger(baseVersion) ? baseVersion - fixture.version : null,
  initializationOperations,
  headStabilityObservations,
  versionAfter,
  versionDelta: Number.isSafeInteger(baseVersion) && Number.isSafeInteger(versionAfter) ? versionAfter - baseVersion : null,
  measurement: {
    method: '13 independent browser contexts remain online, same 1440x960 viewport and Branch 10 UID; one page at a time performs three expand/collapse pairs to avoid concurrent toggles on the shared room. Before measuring, each page clicks the existing Back to Root UI control once outside the timed interval. Expand/collapse clicks and child-DOM waits have a 20-second cap; per-action checkpoints capture failures and button geometry. Global SVG node counts are informational because off-viewport nodes are culled.',
    result: interaction,
    completed
  },
  lcp: browserMetrics?.loadMetrics?.summary?.lcp || null,
  rawFiles: { browserArtifact: path.basename(browserArtifact), checkpoints: path.basename(checkpointPath), summary: path.basename(summaryPath) },
  error: caughtError
}
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ type: 'interaction_complete', summary: summaryPath, completedClients: interaction?.completedClients ?? 0, completedRoundPairs: interaction?.completedRoundPairs ?? 0, expandP95Ms: interaction?.expand?.p95Ms ?? null, collapseP95Ms: interaction?.collapse?.p95Ms ?? null, error: caughtError }))
checkpoint({ phase: 'suite-complete', completed, completedClients: interaction?.completedClients ?? 0, completedRoundPairs: interaction?.completedRoundPairs ?? 0, error: caughtError })
if (caughtError || !completed || browserMetrics?.loadMetrics?.summary?.lcpUnavailableClients?.length) process.exitCode = 1
