'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const harnessPath = path.join(__dirname, 'mcp-collab-performance.cjs')
const source = fs.readFileSync(harnessPath, 'utf8')

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source)
  assert(match, `function ${name} was not found`)
  const start = match.index
  const marker = source.indexOf(') {', start + match[0].length)
  assert(marker >= 0, `function ${name} has no body`)
  const open = marker + 2
  let depth = 1
  let state = 'code'
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (char === '\\') index += 1
      else if (char === quote) state = 'code'
      continue
    }
    if (state === 'line-comment') { if (char === '\n') state = 'code'; continue }
    if (state === 'block-comment') { if (char === '*' && next === '/') { state = 'code'; index += 1 }; continue }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue }
    if (char === "'") { state = 'single'; continue }
    if (char === '"') { state = 'double'; continue }
    if (char === '`') { state = 'template'; continue }
    if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`function ${name} is unterminated`)
}

const names = ['countBy', 'percentile', 'metric', 'summarizeSamples', 'summarizeServiceQueueDiagnostics', 'summarizeMcpHttpLifecycle',
  'summarizeResourceSampling', 'buildIsolatedMcpDiagnosticArgs', 'roomScopedApiDiagnosticsUrl', 'projectMcpHttpEvents',
  'snapshotCounterDelta', 'collectOrdinarySnapshotEvidence', 'safePersistedError', 'sanitizePersistedValue', 'projectRenderNodeProbe',
  'summarizeMcpDispatchBins', 'append']
const logStates = new Map()
const context = { Number, Math, Object, String, Array, Set, Map, SAFE_UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, URL }
context.logStates = logStates
context.flushLogFile = async () => {}
vm.createContext(context)
vm.runInContext(`${names.map(extractFunction).join('\n')}\nthis.api={summarizeSamples,summarizeServiceQueueDiagnostics,summarizeMcpHttpLifecycle,summarizeResourceSampling,buildIsolatedMcpDiagnosticArgs,roomScopedApiDiagnosticsUrl,projectMcpHttpEvents,collectOrdinarySnapshotEvidence,safePersistedError,sanitizePersistedValue,projectRenderNodeProbe,summarizeMcpDispatchBins,append}`, context)

const oneTokenCanary = 'PRIVATE_SINGLE_TOKEN_CANARY'
assert.equal(context.api.safePersistedError(oneTokenCanary), 'error_details_redacted', 'untrusted single-token messages must not pass as safe labels')
assert.equal(context.api.safePersistedError(null), null, 'a successful probe must keep its error field null')
assert.equal(context.api.safePersistedError('response_body_read_failed'), 'response_body_read_failed', 'known static labels remain useful')
const safeErrorObject = context.api.safePersistedError({ name: 'TypeError', code: 'UND_ERR_SOCKET', message: oneTokenCanary })
assert.equal(safeErrorObject, 'TypeError:UND_ERR_SOCKET', 'Error objects may persist restricted name/code but never their message')
const safeGenericRow = JSON.stringify(context.api.sanitizePersistedValue({ error: oneTokenCanary, message: oneTokenCanary }))
assert(!safeGenericRow.includes(oneTokenCanary), 'error and message properties must redact private one-token messages')

const renderProbeCanary = 'PRIVATE_RENDER_PROBE_CANARY'
context.api.append('probe', {
  category: 'browser-render-node-probe', phase: 'load-precheck', token: 'browser1-1', uid: 'uid-safe', userId: 'test-user',
  message: renderProbeCanary,
  snapshot: {
    renderTreeUidPresent: true, renderTreeScanTruncated: false, rootModelUidPresent: false, rootModelScanTruncated: false,
    nodeIndexHasUid: true, nodeIndexSize: 42, rootNodeDataMatchesRenderTree: false, rendererIsRendering: false,
    hasRenderTimer: false, hasWaitRendering: true, rendererLayoutEpoch: 9, v2RemoteApplyEpoch: 11,
    adapterLastServerRevision: 12, adapterServerRevision: 13, safeRootUid: 'root-safe',
    content: renderProbeCanary, domHtml: renderProbeCanary, message: renderProbeCanary,
  },
})
const persistedProbe = logStates.get('probe').queue[0]
const parsedProbe = JSON.parse(persistedProbe)
assert.equal(parsedProbe.category, 'browser-render-node-probe')
assert.equal(parsedProbe.snapshot.renderTreeUidPresent, true)
assert.equal(parsedProbe.snapshot.nodeIndexSize, 42)
assert.equal(parsedProbe.snapshot.safeRootUid, 'root-safe')
assert(!persistedProbe.includes(renderProbeCanary), 'render diagnostics must omit content, DOM, and arbitrary message fields')
assert.deepEqual(Object.keys(parsedProbe.snapshot).sort(), [
  'adapterLastServerRevision', 'adapterServerRevision', 'hasRenderTimer', 'hasWaitRendering', 'nodeIndexHasUid', 'nodeIndexSize',
  'renderTreeScanTruncated', 'renderTreeUidPresent', 'rendererIsRendering', 'rendererLayoutEpoch', 'rootModelScanTruncated',
  'rootModelUidPresent', 'rootNodeDataMatchesRenderTree', 'safeRootUid', 'v2RemoteApplyEpoch'
].sort())

const mcp = context.api.summarizeSamples([
  { category: 'mcp-single-write', phase: 'load', outcome: 'success', writeSubmitted: true, dispatchStatus: 'dispatched',
    latencyMs: 100, driverDispatchDelayMs: 20, queueDelayMs: 20, path: 'direct' },
  { category: 'mcp-single-write', phase: 'load', outcome: 'unknown', writeSubmitted: true, dispatchStatus: 'dispatched',
    latencyMs: 500, driverDispatchDelayMs: 45, queueDelayMs: 45, path: null },
  { category: 'mcp-single-write', phase: 'load', outcome: 'missed', writeSubmitted: false, dispatchStatus: 'missed',
    latencyMs: null, driverDispatchDelayMs: null, queueDelayMs: null, path: null },
])
assert.equal(mcp.expectedWriteSlots, 3)
assert.equal(mcp.submittedWriteCount, 2)
assert.equal(mcp.unsubmittedWriteCount, 1)
assert.equal(mcp.unknownOutcomeCount, 1)
assert.equal(mcp.dispatchCompletenessPct, 66.67)
assert.equal(mcp.mcpSingleWriteResponse.count, 2)
assert.equal(mcp.mcpSingleWriteResponse.p95Ms, 500)
assert.equal(mcp.directPathCount, 1)
assert.equal(mcp.pathMissingCount, 1, 'path coverage denominator excludes the unsubmitted slot')
assert.equal(mcp.driverDispatchDelay.p95Ms, 45)
assert.equal(mcp.queueDelay.aliasOf, 'driverDispatchDelay')
assert.match(mcp.queueDelay.definition, /not server queue waiting/)

const roundStartedAt = 1_000_000
const stableBinsBeforeWallJump = context.api.summarizeMcpDispatchBins([
  { plannedAt: roundStartedAt + 900, startLatenessMs: 50, dispatchedAt: roundStartedAt + 950 },
  { plannedAt: roundStartedAt + 950, startLatenessMs: 50, dispatchedAt: roundStartedAt + 1000 },
], roundStartedAt, 2000)
const stableBinsAfterWallJump = context.api.summarizeMcpDispatchBins([
  { plannedAt: roundStartedAt + 900, startLatenessMs: 50, dispatchedAt: roundStartedAt + 90_000_950 },
  { plannedAt: roundStartedAt + 950, startLatenessMs: 50, dispatchedAt: roundStartedAt - 99_999_000 },
], roundStartedAt, 2000)
assert.deepEqual(JSON.parse(JSON.stringify(stableBinsBeforeWallJump)), [{ second: 0, count: 1 }, { second: 1, count: 1 }])
assert.deepEqual(JSON.parse(JSON.stringify(stableBinsAfterWallJump)), JSON.parse(JSON.stringify(stableBinsBeforeWallJump)),
  'one-second dispatch bins must use fixed planned offset plus monotonic lateness, independent of wall-clock jumps')

const serviceQueue = context.api.summarizeServiceQueueDiagnostics([
  { type: 'queue-depth-sample', available: true, latencyMs: 12, mcp: { currentDepth: 4, active: 2 },
    apiA: { currentDepth: 3, pendingDrains: 1 } },
  { type: 'queue-depth-sample', available: false, latencyMs: 30 },
])
assert.equal(serviceQueue.sampleCount, 2)
assert.equal(serviceQueue.mcpQueuedGlobal.p95Ms, 4)
assert.equal(serviceQueue.diagnosticsRequestRoundTrip.p95Ms, 30)
assert.match(serviceQueue.definition, /not time spent waiting in the service queue/)
assert.equal(serviceQueue.mcpScope, 'isolated-mcp-process')
assert.match(serviceQueue.apiAQueueStatus, /room-scoped/)

const diagnosticArgs = context.api.buildIsolatedMcpDiagnosticArgs({ inputSchema: { properties: {
  room_key: { type: 'string' }, writer_after: { type: 'number' }, path: { type: 'string' }, minutes: { type: 'number' },
} } }, 17)
assert.deepEqual(JSON.parse(JSON.stringify(diagnosticArgs)), { writer_after: 17, path: 'full', minutes: 15 },
  'isolated MCP diagnostics must use the global writer cursor without a room filter')
const apiUrl = new URL(context.api.roomScopedApiDiagnosticsUrl(19415, 'room-safe', 1234))
assert.equal(apiUrl.searchParams.get('room'), 'room-safe', 'direct API diagnostics remain room scoped')
assert.equal(apiUrl.searchParams.get('since'), '1234')

const clientRequestId = '30000000-0000-4000-8000-000000000001'
const lifecycle = context.api.projectMcpHttpEvents({ events: [
  { kind: 'mcp-http', seq: 2, requestId: '40000000-0000-4000-8000-000000000001', clientRequestId,
    operationId: clientRequestId, stage: 'request-received', method: 'POST', durationMs: 1.5, status: 200,
    bodyComplete: true, bodyParsed: true, responseFinished: true, sessionPresent: true,
    roomKey: 'do-not-persist', url: 'https://secret.example', payload: 'secret' },
  { kind: 'mcp-http', clientRequestId, stage: 'body-parsed' },
  { kind: 'mcp-http', clientRequestId, stage: 'transport-dispatched' },
  { kind: 'mcp-http', clientRequestId, stage: 'response-finish' },
  { kind: 'http', clientRequestId, route: '/api/files/:room/snapshot' },
] }, 123, new Map([[clientRequestId, { phase: 'load-precheck' }]]))
assert.equal(lifecycle.length, 4)
assert.equal(lifecycle[0].scope, 'isolated-mcp-process')
assert.equal(lifecycle[0].phase, 'load-precheck')
assert.equal(lifecycle[0].clientRequestId, clientRequestId)
assert(!JSON.stringify(lifecycle).includes('secret.example'))
assert(!JSON.stringify(lifecycle).includes('do-not-persist'))
const lifecycleMetrics = context.api.summarizeMcpHttpLifecycle(lifecycle.map(row => ({ ...row, type: 'mcp-http-lifecycle' })))
assert.equal(lifecycleMetrics.uniqueClientRequestCount, 1)
assert.equal(lifecycleMetrics.stageCounts['request-received'], 1)
assert.equal(lifecycleMetrics.stageCounts['body-parsed'], 1)
assert.equal(lifecycleMetrics.stageCounts['transport-dispatched'], 1)

const roomSnapshotEvidence = context.api.collectOrdinarySnapshotEvidence({
  mcpPreload: { available: true, snapshotCounters: null },
  apiPreload: {
    apiA: { available: true, snapshotCounters: [
      { key: 'mcp|/files/:room/snapshot', source: 'mcp', count: 1 },
      { key: 'browser-http|/files/:room/snapshot', source: 'browser-http', count: 4 },
    ] },
    apiB: { available: true, snapshotCounters: [] },
  },
  mcpWarmupPrecheck: { available: true },
  apiWarmupPrecheck: {
    apiA: { available: true, snapshotCounters: [
      { key: 'mcp|/files/:room/snapshot', source: 'mcp', count: 1 },
      { key: 'browser-http|/files/:room/snapshot', source: 'browser-http', count: 4 },
    ] },
    apiB: { available: true, snapshotCounters: [] },
  },
})
assert.equal(roomSnapshotEvidence.available, true, 'ordinary snapshot evidence uses the direct room-scoped API snapshots')
assert.equal(roomSnapshotEvidence.noUnexpectedSnapshots, true)

const resources = context.api.summarizeResourceSampling([
  { type: 'resource-sample', partial: true, resourceErrors: [{ component: 'postgres' }], missingComponents: ['postgres'] },
  { type: 'resource-sample-skipped', missingComponents: ['containers', 'postgres', 'redis'] },
  { type: 'resource-sample-error', missingComponents: ['containers', 'postgres', 'redis'] },
])
assert.equal(resources.attemptCount, 3)
assert.equal(resources.completedSampleCount, 1)
assert.equal(resources.skippedSampleCount, 1)
assert.equal(resources.failedSampleCount, 1)
assert.equal(resources.partialSampleCount, 1)
assert.deepEqual(JSON.parse(JSON.stringify(resources.missingProbeCounts)), { containers: 2, postgres: 3, redis: 2 })

console.log('PASS: dispatch misses, response percentiles, Direct path coverage, driver-vs-service queue labels, and partial resource-sample accounting.')
