'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  BASELINE_COMMIT, EXPECTED, INPUTS, analyzeSeries, buildReport, inputRun, parseBytes, runComparison
} = require('./mcp-collab-compare.cjs')

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex') }

function makeRound(phase, startedAt, durationMs = EXPECTED.roundDurationMs, sampleMs = EXPECTED.sampleMs) {
  const expectedMcp = durationMs / 1000 * EXPECTED.writesPerSecond
  const expectedBrowser = durationMs / EXPECTED.browserIntervalMs
  return {
    phase, startedAt, endedAt: startedAt + durationMs, durationMs,
    warmupMs: EXPECTED.warmupMs, sampleMs,
    expectedScheduledMcpCalls: expectedMcp, mcpDispatchStartedCount: expectedMcp,
    mcpOneSecondBins: Array.from({ length: durationMs / 1000 }, (_, second) => ({ second, count: 5 })),
    expectedBrowserEditsPerClient: expectedBrowser,
    browserMinKeyboardSubmissionCompletenessPct: 100,
    browserMinOnTimeKeyboardCompletenessPct: 100,
    browserEditCompletionPct: 100,
    undrained: 0, browserSettlement: { settled: true }
  }
}

function makeSummary(variant, renderMode, baseTime) {
  const candidate = variant === 'C'
  const imageId = candidate ? 'sha256:candidate' : 'sha256:baseline'
  const codeHash = candidate ? 'candidate-code' : 'baseline-code'
  const users = Array.from({ length: EXPECTED.clientCount }, (_, index) => ({
    label: `browser-${String(index + 1).padStart(2, '0')}`,
    userId: `${variant}-${renderMode}-user-${index + 1}`,
    expandedModelNodes: renderMode === 'natural' ? 999 : 1000,
    naturalViewportDomNodes: 40,
    state: { status: 'live' }
  }))
  const summary = {
    schema: 'mcp-collab-performance-v1', variant, renderMode,
    status: 'pass', errors: [],
    driverEvidence: { hashes: [
      { path: 'scripts/mcp-collab-performance.cjs', sha256: sha('harness') },
      { path: 'scripts/mcp-collab-load-worker.cjs', sha256: sha('worker') },
      { path: 'simple-mind-map/bin/mindDoc.js', sha256: sha('normalizer') }
    ], nodeVersion: 'v22.12.0', browserInputMethod: 'actual-keypress-and-product-tab' },
    settings: {
      COLLAB_V2: '1',
      COLLAB_V2_EVENT_BRIDGE: variant === 'A' ? '0' : '1',
      COLLAB_MCP_DIRECT: variant === 'A' ? '0' : '1'
    },
    evidence: {
      host: { node: 'v22.12.0', platform: 'win32', logicalCpus: 16, totalMemoryBytes: 16 * 1024 ** 3, freeMemoryAtSetupBytes: 12 * 1024 ** 3 },
      server: { image: imageId, imageId, containerNode: 'v20.19.3', cpuLimitPerContainer: 4,
        memoryLimitPerContainer: '4g', apiProcesses: [{ name: 'api-a' }, { name: 'api-b' }], mcpProcess: { name: 'mcp' } },
      source: {
        baselineArchiveProvenance: { commit: BASELINE_COMMIT },
        imageManifest: { manifestSha256: sha(`${variant}-manifest`), sourceFilesSha256: sha(codeHash), runtimeAssetsSha256: sha(`${variant}-assets`) },
        sharedFixtureSchemaMigrations: { imageId: 'sha256:schema', manifestSha256: sha('schema-manifest') }
      },
      frontendBuild: { tree: { sha256: sha(`${variant}-frontend`) } },
      room: { requestedNodes: EXPECTED.nodeCount, persistedNodes: EXPECTED.nodeCount, expandedModelNodesExpected: EXPECTED.visibleNodes },
      browser: { count: EXPECTED.clientCount, users }
    },
    rounds: [
      makeRound('round-1', baseTime), makeRound('round-2', baseTime + 200000), makeRound('round-3', baseTime + 400000)
    ],
    batch100: { responseMs: 100, outcome: 'success' }, burst100: { outcome: 'success' },
    gates: { overall: 'pass', gates: [] }
  }
  if (candidate) {
    summary.sustained = makeRound('sustained-10m', baseTime + 600000, EXPECTED.sustainedDurationMs, EXPECTED.sustainedSampleMs)
  }
  return summary
}

function makeSampleRows(variant, renderMode, summary, latencyMs) {
  const rows = []
  const candidate = variant === 'C'
  const phases = [...summary.rounds, ...(summary.sustained ? [summary.sustained] : [])]
  for (const round of phases) {
    const durationMs = round.durationMs
    const phase = round.phase
    const mcpCount = durationMs / 1000 * EXPECTED.writesPerSecond
    for (let index = 0; index < mcpCount; index += 1) {
      const plannedAt = round.startedAt + index * 200
      const warmup = index * 200 < durationMs - round.sampleMs
      rows.push({ category: 'mcp-single-write', phase: warmup ? `${phase}-warmup` : phase,
        operationId: `${variant}-${renderMode}-${phase}-mcp-${index}`, uid: `uid-${index}`,
        plannedAt, startedAt: plannedAt + 3, completedAt: plannedAt + 3 + latencyMs,
        latencyMs, outcome: 'success', status: 200,
        path: candidate ? 'direct' : 'full', submissionPath: candidate ? 'direct' : 'legacy' })
    }
    const browserPerClient = durationMs / EXPECTED.browserIntervalMs
    for (let clientIndex = 0; clientIndex < EXPECTED.clientCount; clientIndex += 1) {
      const userId = `${variant}-${renderMode}-user-${clientIndex + 1}`
      for (let index = 0; index < browserPerClient; index += 1) {
        const plannedAt = round.startedAt + index * EXPECTED.browserIntervalMs
        const warmup = index * EXPECTED.browserIntervalMs < durationMs - round.sampleMs
        rows.push({ category: 'browser-input-schedule', phase: warmup ? `${phase}-warmup` : phase,
          userId, token: `${phase}-${clientIndex}-${index}`, plannedAt, firstKeyAt: plannedAt + 20,
          firstKeyLatenessMs: 20, keyboardSubmittedAt: plannedAt + 50, outcome: 'success' })
      }
    }
    if (summary.rounds.includes(round)) {
      for (const route of ['/api/files/:room/meta', '/api/maps/:room/version']) {
        for (let index = 0; index < durationMs / EXPECTED.browserIntervalMs; index += 1) {
          const plannedAt = round.startedAt + index * EXPECTED.browserIntervalMs
          const warmup = index * EXPECTED.browserIntervalMs < durationMs - round.sampleMs
          if (warmup) continue
          rows.push({ category: 'control-read', phase, method: 'GET', route, outcome: 'response', status: 200,
            plannedAt, startedAt: plannedAt + 5, completedAt: plannedAt + 5 + 100, latencyMs: 100 })
        }
      }
    }
  }
  return rows
}

function makeEvents(variant, renderMode, summary) {
  const events = []
  if (variant !== 'C') return events
  const startAt = summary.sustained.startedAt
  const endAt = summary.sustained.endedAt
  for (let at = startAt + EXPECTED.warmupMs; at <= endAt; at += 5000) {
    events.push({ type: 'resource-sample', at,
      host: { processRssBytes: 300 * 1024 ** 2, freeMemoryBytes: 8 * 1024 ** 3 },
      containers: ['api-a', 'api-b', 'mcp'].map(name => ({ name, memory: '512MiB / 4GiB' })) })
    events.push({ type: 'queue-depth-sample', phase: 'sustained-10m', at, available: true,
      mcp: { currentDepth: 0, active: 1, queuedBytes: 0 },
      apiA: { currentDepth: 0, pendingDrains: 0, dbPoolWaiting: 0 },
      apiB: { currentDepth: 0, pendingDrains: 0, dbPoolWaiting: 0 } })
  }
  return events
}

function makeTrace(variant, renderMode, summary) {
  const clients = summary.evidence.browser.users.map(user => {
    const fullDrawStats = renderMode === 'full' ? {
      domNodeCount: 1001, rootDomNodeCount: 1, nonRootDomNodeCount: 1000, uniqueNonRootDomUidCount: 1000
    } : null
    const queueSamples = []
    if (variant === 'C') {
      const startAt = summary.sustained.startedAt + EXPECTED.warmupMs
      const endAt = summary.sustained.endedAt
      for (let at = startAt; at <= endAt - 5000; at += 5000) {
        queueSamples.push({ at, phase: 'sustained-10m', currentDepth: 0, sending: 0, revision: 10 })
      }
    }
    return { label: user.label, userId: user.userId,
      readyStats: { visibleBranch: { fullDrawStats } }, trace: { queueSamples } }
  })
  return { capturedAt: new Date().toISOString(), clients }
}

function writeFixture(root, label, variant, renderMode, baseTime) {
  const dir = path.join(root, label)
  fs.mkdirSync(dir)
  const summary = makeSummary(variant, renderMode, baseTime)
  const latency = variant === 'A' ? (renderMode === 'natural' ? 1000 : 1100)
    : variant === 'B' ? (renderMode === 'natural' ? 700 : 750) : (renderMode === 'natural' ? 400 : 450)
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary))
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), makeSampleRows(variant, renderMode, summary, latency).map(row => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'events.jsonl'), makeEvents(variant, renderMode, summary).map(row => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'browser-trace.json'), JSON.stringify(makeTrace(variant, renderMode, summary)))
  return dir
}

function makeRuns(root) {
  fs.mkdirSync(root, { recursive: true })
  const dirs = {}
  for (const [label, variant, mode] of INPUTS) dirs[label] = writeFixture(root, label, variant, mode, 1_800_000_000_000)
  return INPUTS.map(([label, variant, mode]) => inputRun(label, variant, mode, dirs[label]))
}

function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-collab-compare-unit-'))
  try {
    const runs = makeRuns(path.join(tempRoot, 'fixtures'))
    const pass = buildReport(runs)
    assert.equal(pass.overall, 'pass', JSON.stringify(pass.gates.map(gate => ({ name: gate.name, status: gate.status, issues: gate.issues.slice(0, 2) }))))
    assert.equal(pass.singleWrite.modes.natural.improvementVsA, 0.6)
    assert.equal(pass.singleWrite.modes.full.improvementVsA, (1100 - 450) / 1100)
    assert.equal(pass.unchangedRoutes.status, 'pass')
    assert.equal(pass.sustainedLoad.modes.natural.queues['mcp.submitQueue.currentDepth'].growthObserved, false)
    assert.equal(pass.sustainedLoad.modes.full.resources.driverRss.enoughSamples, true)

    const missing = INPUTS.map(([label, variant, mode]) => inputRun(label, variant, mode, null))
    const incomplete = buildReport(missing)
    assert.equal(incomplete.overall, 'incomplete', '缺少六组样本必须是 incomplete，不能 pass')

    const failRuns = makeRuns(path.join(tempRoot, 'fail-fixtures'))
    const failC = failRuns.find(item => item.variant === 'C' && item.renderMode === 'natural')
    for (const row of failC.samples) {
      if (row.category === 'mcp-single-write' && ROUND_IS_NORMAL(row.phase)) row.latencyMs = 600
    }
    const failed = buildReport(failRuns)
    assert.equal(failed.singleWrite.modes.natural.status, 'fail', '低于 50% 的降幅必须失败')
    assert.equal(failed.overall, 'fail')

    assert.equal(parseBytes('1.5GiB / 4GiB'), 1.5 * 1024 ** 3)
    assert.equal(parseBytes('10.5MB / 4GB'), 10.5 * 1000 ** 2)
    const rising = []
    for (let window = 0; window < 5; window += 1) {
      for (let sample = 0; sample < 24; sample += 1) {
        const at = window * 120000 + sample * 5000
        const value = window >= 2 ? (window - 1) * 8 * 1024 ** 2 : 0
        rising.push({ at, value })
      }
    }
    assert.equal(analyzeSeries('growth-fixture', rising, 120, 0, 600000).growthObserved, true)

    const dirs = Object.fromEntries(runs.map(item => [`${item.label}-dir`, item.dir]))
    const outputDir = path.join(tempRoot, 'reports', 'fresh-report')
    const written = runComparison({ ...dirs, 'output-dir': outputDir })
    assert.equal(written.status, 'pass')
    assert.ok(fs.existsSync(path.join(outputDir, 'comparison.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'comparison.md')))
    assert.throws(() => runComparison({ ...dirs, 'output-dir': outputDir }), /拒绝覆盖/)
    process.stdout.write('mcp-collab-compare unit: PASS\n')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function ROUND_IS_NORMAL(phase) { return ['round-1', 'round-2', 'round-3'].includes(phase) }

if (require.main === module) run()

module.exports = { makeEvents, makeRuns, makeSummary, makeTrace, run, writeFixture }
