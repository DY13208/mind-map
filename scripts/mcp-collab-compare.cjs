'use strict'

const fs = require('node:fs')
const path = require('node:path')

const INPUTS = [
  ['a-natural', 'A', 'natural'], ['a-full', 'A', 'full'],
  ['b-natural', 'B', 'natural'], ['b-full', 'B', 'full'],
  ['c-natural', 'C', 'natural'], ['c-full', 'C', 'full']
]
const BASELINE_COMMIT = require('node:child_process').execFileSync('git', ['rev-parse', process.env.MCP_COLLAB_BASELINE_REF || 'origin/main'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true }).trim()
const ROUND_PHASES = ['round-1', 'round-2', 'round-3']
const EXPECTED = Object.freeze({
  nodeCount: 10000,
  clientCount: 10,
  visibleNodes: 1000,
  roundCount: 3,
  roundDurationMs: 150000,
  warmupMs: 30000,
  sampleMs: 120000,
  writesPerSecond: 5,
  browserIntervalMs: 2000,
  sustainedDurationMs: 630000,
  sustainedSampleMs: 600000,
  batchItems: 100
})
const PRESSURE_WINDOW_MS = 120000
const RESOURCE_INTERVAL_MS = 5000
const MIN_SAMPLES_PER_STEADY_WINDOW = 5
const MIN_ROUTE_SAMPLES = 20
const MIN_IMPROVEMENT_RATIO = 0.5
const MAX_ROUTE_REGRESSION_RATIO = 0.1
const MEBIBYTE = 1024 * 1024

// These are the unchanged read paths relevant to collaboration. Changed node
// reads/writes and full exports are intentionally excluded from this comparison.
const CONTROL_ROUTES = new Set([
  'GET /api/files/:room/presence',
  'GET /api/files/:room/meta',
  'GET /api/files/:room/subtree',
  'GET /api/collab-v2/meta',
  'POST /api/files/:room/presence'
])
const CONTROL_READ_ROUTES = new Set([
  'GET /api/files/:room/meta',
  'GET /api/maps/:room/version'
])

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function asEpoch(value) {
  if (finite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function percentile(values, fraction) {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] : null
}

function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function linearSlopePerMinute(points) {
  const valid = points.filter(point => finite(point.at) && finite(point.value))
  if (valid.length < 2) return null
  const origin = valid[0].at
  const xs = valid.map(point => (point.at - origin) / 60000)
  const ys = valid.map(point => point.value)
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean)
    denominator += (xs[i] - xMean) ** 2
  }
  return denominator > 0 ? numerator / denominator : null
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8')
  const rows = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) }
    catch (error) { throw new Error(`${path.basename(file)} 第 ${index + 1} 行 JSONL 损坏：${error.message}`) }
  }
  return rows
}

function inputRun(label, variant, renderMode, dirValue) {
  const result = { label, variant, renderMode, dir: dirValue ? path.resolve(dirValue) : null,
    summary: null, samples: [], events: [], trace: null, issues: [], status: 'incomplete' }
  if (!result.dir) {
    result.issues.push({ severity: 'incomplete', code: 'input_not_provided', message: `未提供 ${label} 样本目录` })
    return result
  }
  const summaryPath = path.join(result.dir, 'summary.json')
  const samplesPath = path.join(result.dir, 'samples.jsonl')
  const eventsPath = path.join(result.dir, 'events.jsonl')
  const tracePath = path.join(result.dir, 'browser-trace.json')
  for (const requiredPath of [summaryPath, samplesPath, eventsPath, tracePath]) {
    if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
      result.issues.push({ severity: 'incomplete', code: 'artifact_missing', message: `缺少正式运行产物 ${requiredPath}` })
    }
  }
  if (result.issues.length) return result
  try {
    result.summary = readJson(summaryPath)
    result.samples = readJsonl(samplesPath)
    result.events = readJsonl(eventsPath)
    result.trace = readJson(tracePath)
  } catch (error) {
    result.issues.push({ severity: 'incomplete', code: 'artifact_unreadable', message: error.message })
    return result
  }
  validateRun(result)
  result.status = result.issues.some(issue => issue.severity === 'fail') ? 'fail'
    : result.issues.some(issue => issue.severity === 'incomplete') ? 'incomplete' : 'pass'
  return result
}

function issue(run, severity, code, message, details) {
  run.issues.push({ severity, code, message, ...(details === undefined ? {} : { details }) })
}

function validateRun(run) {
  const summary = run.summary
  if (!summary || summary.schema !== 'mcp-collab-performance-v1') {
    issue(run, 'incomplete', 'summary_schema', 'summary 缺失或不是正式 mcp-collab-performance-v1')
    return
  }
  if (summary.variant !== run.variant || summary.renderMode !== run.renderMode) {
    issue(run, 'fail', 'sample_identity_mismatch', `目录应为 ${run.variant}/${run.renderMode}，summary 实际为 ${summary.variant}/${summary.renderMode}`)
  }
  if (['smoke-pass', 'smoke-fail', 'precheck-pass', 'precheck-fail'].includes(summary.status) || summary.smoke || summary.warmupPrecheck) {
    issue(run, 'incomplete', 'not_formal_run', 'smoke/precheck 不能替代三轮正式采样')
  } else if (!['pass', 'fail', 'incomplete'].includes(summary.status)) {
    issue(run, 'incomplete', 'run_status', `未知正式运行状态：${summary.status || 'missing'}`)
  } else if (summary.status === 'incomplete') {
    issue(run, 'incomplete', 'run_incomplete', '主 harness 将此运行标记为 incomplete')
  }
  if (summary.errors && summary.errors.length) {
    issue(run, summary.status === 'incomplete' ? 'incomplete' : 'fail', 'run_errors', 'summary.errors 非空', summary.errors)
  }

  const room = summary.evidence && summary.evidence.room
  const browser = summary.evidence && summary.evidence.browser
  if (!room || room.requestedNodes !== EXPECTED.nodeCount || room.persistedNodes !== EXPECTED.nodeCount) {
    issue(run, 'fail', 'fixture_nodes', '测试房间未证明总节点数为 10,000', room || null)
  }
  if (!browser || browser.count !== EXPECTED.clientCount || !Array.isArray(browser.users) || browser.users.length !== EXPECTED.clientCount) {
    issue(run, 'fail', 'browser_count', '测试未证明 10 个独立浏览器客户端', browser ? { count: browser.count, users: browser.users && browser.users.length } : null)
  }
  if (room && room.expandedModelNodesExpected !== EXPECTED.visibleNodes) {
    issue(run, 'fail', 'visible_nodes', '展开节点数与验收规模 1,000 不符', room.expandedModelNodesExpected)
  }
  if (run.renderMode === 'full' && browser && Array.isArray(browser.users)) {
    const traced = run.trace && Array.isArray(run.trace.clients) ? run.trace.clients : []
    const bad = browser.users.filter(user => {
      const client = traced.find(row => row.userId === user.userId || row.label === user.label)
      const draw = client && client.readyStats && client.readyStats.visibleBranch && client.readyStats.visibleBranch.fullDrawStats
      return !draw || draw.domNodeCount !== EXPECTED.visibleNodes + 1 || draw.rootDomNodeCount !== 1 ||
        draw.nonRootDomNodeCount !== EXPECTED.visibleNodes || draw.uniqueNonRootDomUidCount !== EXPECTED.visibleNodes
    })
    if (bad.length) issue(run, 'incomplete', 'full_draw_proof', 'full 模式缺少 1,000 个非根节点加根节点的逐客户端 DOM 计数', bad.map(user => user.label))
  } else if (run.renderMode === 'natural' && browser && Array.isArray(browser.users)) {
    const bad = browser.users.filter(user => user.expandedModelNodes !== EXPECTED.visibleNodes - 1)
    if (bad.length) issue(run, 'fail', 'natural_expansion_proof', 'natural 模式没有逐客户端展开 1,000 个渲染树节点（含根）', bad.map(user => ({ label: user.label, expandedModelNodes: user.expandedModelNodes })))
  }

  validateDriverEvidence(run)
  validateRuntimeAndResources(run)
  validateSettings(run)
  validateFormalRounds(run)
  if (!summary.batch100 || !summary.burst100) issue(run, 'incomplete', 'discrete_scenarios_missing', '缺少 100 项批次或 100 事件突发场景结果')
  if (run.variant === 'C') {
    if (summary.status !== 'pass' || !summary.gates || summary.gates.overall !== 'pass') {
      issue(run, 'fail', 'candidate_gates', '候选修复版正式运行没有全部通过 harness gates', { status: summary.status, overall: summary.gates && summary.gates.overall })
    }
    validateCandidateDirectPath(run)
    validateSustainedRound(run)
  }
}

function validateDriverEvidence(run) {
  const evidence = run.summary.driverEvidence
  if (!evidence || !Array.isArray(evidence.hashes) || !evidence.hashes.length ||
      !evidence.nodeVersion || !evidence.browserInputMethod) {
    issue(run, 'incomplete', 'driver_evidence_missing', '缺少 driverEvidence 哈希、Node 版本或浏览器输入方法')
    return
  }
  const hashes = new Set()
  for (const row of evidence.hashes) {
    if (!row || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/i.test(row.sha256 || '')) {
      issue(run, 'incomplete', 'driver_hash_invalid', 'driverEvidence.hashes 含缺失或无效 SHA-256')
      continue
    }
    if (hashes.has(row.path)) issue(run, 'fail', 'driver_hash_duplicate', `driverEvidence 路径重复：${row.path}`)
    hashes.add(row.path)
  }
}

function validateRuntimeAndResources(run) {
  const evidence = run.summary.evidence || {}
  const server = evidence.server
  const host = evidence.host
  if (!server || !host) {
    issue(run, 'incomplete', 'runtime_evidence_missing', '缺少服务镜像或宿主资源参数')
    return
  }
  if (!/^v?20\./.test(String(server.containerNode || ''))) {
    issue(run, 'fail', 'container_node_version', `服务镜像 Node 不是已要求的 20.x：${server.containerNode || 'missing'}`)
  }
  if (server.cpuLimitPerContainer !== 4 || !/^4(?:g|GiB)$/i.test(String(server.memoryLimitPerContainer || ''))) {
    issue(run, 'fail', 'container_resource_limits', '服务容器资源限制不是统一的 4 CPU / 4 GiB', {
      cpuLimitPerContainer: server.cpuLimitPerContainer, memoryLimitPerContainer: server.memoryLimitPerContainer
    })
  }
  if (!finite(host.logicalCpus) || !finite(host.totalMemoryBytes) || !finite(host.freeMemoryAtSetupBytes)) {
    issue(run, 'incomplete', 'host_resource_evidence', '缺少宿主 CPU/内存/启动时可用内存数据')
  }
}

function validateSettings(run) {
  const expected = {
    COLLAB_V2: '1',
    COLLAB_V2_EVENT_BRIDGE: run.variant === 'A' ? '0' : '1',
    COLLAB_MCP_DIRECT: run.variant === 'A' ? '0' : '1'
  }
  if (stableJson(run.summary.settings || {}) !== stableJson(expected)) {
    issue(run, 'fail', 'variant_settings', '样本功能开关与 A/B/C 设计不符', { expected, actual: run.summary.settings || null })
  }
}

function validateFormalRounds(run) {
  const rounds = run.summary.rounds
  if (!Array.isArray(rounds) || rounds.length !== EXPECTED.roundCount) {
    issue(run, 'incomplete', 'round_count', `正式运行要求三轮；实际 ${Array.isArray(rounds) ? rounds.length : 'missing'}`)
    return
  }
  const samples = run.samples
  for (let index = 0; index < EXPECTED.roundCount; index += 1) {
    const phase = ROUND_PHASES[index]
    const round = rounds.find(item => item && item.phase === phase)
    if (!round) {
      issue(run, 'incomplete', 'round_missing', `缺少 ${phase}`)
      continue
    }
    validateRound(run, round, phase, EXPECTED.roundDurationMs, EXPECTED.sampleMs)
    const mcpRows = samples.filter(row => row.category === 'mcp-single-write' &&
      [phase, `${phase}-warmup`].includes(row.phase))
    const expectedCount = EXPECTED.roundDurationMs / 1000 * EXPECTED.writesPerSecond
    validateMcpAttempts(run, phase, round, mcpRows, expectedCount)
    const browserRows = samples.filter(row => ['browser-input-schedule', 'browser-input-error'].includes(row.category) &&
      [phase, `${phase}-warmup`].includes(row.phase))
    validateBrowserAttempts(run, phase, round, browserRows, EXPECTED.roundDurationMs / EXPECTED.browserIntervalMs,
      run.variant === 'C')
  }
}

function validateRound(run, round, phase, durationMs, sampleMs) {
  if (round.durationMs !== durationMs || round.warmupMs !== EXPECTED.warmupMs || round.sampleMs !== sampleMs) {
    issue(run, 'fail', 'round_timing', `${phase} 预热/采样/持续时间不符合正式协议`, {
      durationMs: round.durationMs, warmupMs: round.warmupMs, sampleMs: round.sampleMs
    })
  }
  if (!finite(asEpoch(round.startedAt)) || !finite(asEpoch(round.endedAt))) {
    issue(run, 'incomplete', 'round_timestamps', `${phase} 缺少开始或结束时间`)
  }
  if (round.undrained !== 0 || !round.browserSettlement || round.browserSettlement.settled !== true) {
    issue(run, 'incomplete', 'round_unfinished', `${phase} 尚有未完成客户端队列或未结算工作`, {
      undrained: round.undrained, browserSettlement: round.browserSettlement || null
    })
  }
  const mcpExpected = durationMs / 1000 * EXPECTED.writesPerSecond
  if (round.expectedScheduledMcpCalls !== mcpExpected || round.mcpDispatchStartedCount !== mcpExpected) {
    issue(run, 'incomplete', 'mcp_dispatch_incomplete', `${phase} 没有按计划真实派发全部 MCP 请求`, {
      expected: mcpExpected, scheduled: round.expectedScheduledMcpCalls, dispatched: round.mcpDispatchStartedCount
    })
  }
  const bins = round.mcpOneSecondBins
  if (!Array.isArray(bins) || bins.length !== Math.ceil(durationMs / 1000) ||
      bins.some(bin => !finite(bin.count) || bin.count < 3 || bin.count > 7)) {
    issue(run, 'incomplete', 'mcp_dispatch_cadence', `${phase} MCP 实际派发未能证明逐秒维持 3–7 次`, {
      binCount: Array.isArray(bins) ? bins.length : 0,
      lowBins: Array.isArray(bins) ? bins.filter(bin => !finite(bin.count) || bin.count < 3).length : null,
      highBins: Array.isArray(bins) ? bins.filter(bin => finite(bin.count) && bin.count > 7).length : null
    })
  }
}

function validateMcpAttempts(run, phase, round, rows, expectedCount) {
  if (rows.length !== expectedCount) {
    issue(run, 'incomplete', 'mcp_attempt_rows', `${phase} MCP 结果日志不完整`, { expected: expectedCount, recorded: rows.length })
  }
  const operationIds = rows.map(row => row.operationId).filter(value => typeof value === 'string' && value)
  if (operationIds.length !== rows.length || new Set(operationIds).size !== rows.length) {
    issue(run, 'incomplete', 'mcp_operation_ids', `${phase} MCP 请求存在缺少或重复 operation_id`)
  }
  const start = asEpoch(round.startedAt)
  const expectedSlots = new Set(Array.from({ length: expectedCount }, (_, index) => Math.round(start + index * 1000 / EXPECTED.writesPerSecond)))
  const observedSlots = new Set()
  let badLatencyRows = 0
  for (const row of rows) {
    const planned = asEpoch(row.plannedAt)
    if (planned === null || !expectedSlots.has(Math.round(planned))) continue
    observedSlots.add(Math.round(planned))
    if (!finite(row.latencyMs) || row.latencyMs < 0 || !finite(asEpoch(row.startedAt)) || !finite(asEpoch(row.completedAt))) badLatencyRows += 1
  }
  if (observedSlots.size !== expectedSlots.size) issue(run, 'incomplete', 'mcp_planned_slots', `${phase} 未逐项记录全部 MCP 计划时点`, {
    expected: expectedSlots.size, recorded: observedSlots.size
  })
  if (badLatencyRows) issue(run, 'incomplete', 'mcp_latency_missing', `${phase} 存在未结算或没有耗时的 MCP 结果`, badLatencyRows)
}

function validateBrowserAttempts(run, phase, round, rows, perClientExpected, requireCadence) {
  const expectedTotal = perClientExpected * EXPECTED.clientCount
  const byUser = new Map()
  for (const row of rows) {
    const userId = String(row.userId || '')
    const current = byUser.get(userId) || []
    current.push(row)
    byUser.set(userId, current)
  }
  const start = asEpoch(round.startedAt)
  const expectedTimes = Array.from({ length: perClientExpected }, (_, index) => Math.round(start + index * EXPECTED.browserIntervalMs))
  const missingByUser = []
  let onTimeCount = 0
  let keyboardCount = 0
  for (const [userId, userRows] of byUser) {
    const observed = new Set()
    for (const row of userRows) {
      const planned = asEpoch(row.plannedAt)
      if (planned !== null) observed.add(Math.round(planned))
      if (row.category === 'browser-input-schedule' && finite(row.firstKeyAt)) {
        keyboardCount += 1
        if (finite(row.firstKeyLatenessMs) && row.firstKeyLatenessMs <= EXPECTED.browserIntervalMs) onTimeCount += 1
      }
    }
    const missing = expectedTimes.filter(time => !observed.has(time))
    if (missing.length || observed.size !== perClientExpected) missingByUser.push({ userId, expected: perClientExpected, recorded: observed.size, missing: missing.length })
  }
  if (byUser.size !== EXPECTED.clientCount || rows.length !== expectedTotal || missingByUser.length) {
    issue(run, 'incomplete', 'browser_attempt_rows', `${phase} 没有逐客户端记录全部计划键盘尝试`, {
      expectedClients: EXPECTED.clientCount, recordedClients: byUser.size,
      expectedAttempts: expectedTotal, recordedAttempts: rows.length, missingByUser
    })
  }
  if (requireCadence) {
    const minimum = Math.ceil(expectedTotal * 0.95)
    if (keyboardCount < minimum || onTimeCount < minimum) {
      issue(run, 'fail', 'candidate_browser_cadence', `${phase} 候选版实际键盘输入节拍未达到 95%`, {
        expected: expectedTotal, keyboardCount, onTimeCount, required: minimum
      })
    }
  }
}

function validateCandidateDirectPath(run) {
  const rows = run.samples.filter(row => row.category === 'mcp-single-write' &&
    (ROUND_PHASES.includes(row.phase) || row.phase === 'sustained-10m'))
  const unknown = rows.filter(row => row.path !== 'direct' && row.submissionPath !== 'direct')
  const full = rows.filter(row => row.path === 'full' || row.submissionPath === 'legacy')
  if (full.length) issue(run, 'fail', 'candidate_full_path', '候选版合格普通 MCP 单写仍进入 full/legacy 路径', {
    count: full.length, examples: full.slice(0, 10).map(row => ({ operationId: row.operationId, path: row.path, submissionPath: row.submissionPath, fallbackReason: row.fallbackReason }))
  })
  if (unknown.length) issue(run, 'incomplete', 'candidate_path_missing', '候选版普通 MCP 写入缺少明确 direct 路径证据', {
    count: unknown.length, examples: unknown.slice(0, 10).map(row => ({ operationId: row.operationId, path: row.path, submissionPath: row.submissionPath }))
  })
}

function validateSustainedRound(run) {
  const round = run.summary.sustained
  if (!round) {
    issue(run, 'incomplete', 'sustained_missing', '候选版缺少 10 分钟持续混合负载轮次')
    return
  }
  validateRound(run, round, 'sustained-10m', EXPECTED.sustainedDurationMs, EXPECTED.sustainedSampleMs)
  const expectedMcp = EXPECTED.sustainedDurationMs / 1000 * EXPECTED.writesPerSecond
  const mcpRows = run.samples.filter(row => row.category === 'mcp-single-write' &&
    ['sustained-10m', 'sustained-10m-warmup'].includes(row.phase))
  validateMcpAttempts(run, 'sustained-10m', round, mcpRows, expectedMcp)
  const browserRows = run.samples.filter(row => ['browser-input-schedule', 'browser-input-error'].includes(row.category) &&
    ['sustained-10m', 'sustained-10m-warmup'].includes(row.phase))
  validateBrowserAttempts(run, 'sustained-10m', round, browserRows,
    EXPECTED.sustainedDurationMs / EXPECTED.browserIntervalMs, true)
}

function evidenceVector(run) {
  const evidence = run.summary && run.summary.driverEvidence
  if (!evidence || !Array.isArray(evidence.hashes)) return null
  return {
    hashes: evidence.hashes.map(item => ({ path: item.path, sha256: String(item.sha256 || '').toLowerCase() })).sort((a, b) => a.path.localeCompare(b.path)),
    nodeVersion: evidence.nodeVersion,
    browserInputMethod: evidence.browserInputMethod
  }
}

function runArtifacts(run) {
  const summary = run.summary || {}
  const evidence = summary.evidence || {}
  const source = evidence.source || {}
  const sourceManifest = source.imageManifest || {}
  const schema = source.sharedFixtureSchemaMigrations || {}
  return {
    commit: source.baselineArchiveProvenance && source.baselineArchiveProvenance.commit || null,
    imageId: evidence.server && evidence.server.imageId || null,
    containerNode: evidence.server && evidence.server.containerNode || null,
    imageManifestHash: sourceManifest.manifestSha256 || null,
    sourceFilesHash: sourceManifest.sourceFilesSha256 || null,
    runtimeAssetsHash: sourceManifest.runtimeAssetsSha256 || null,
    schemaImageId: schema.imageId || null,
    schemaManifestHash: schema.manifestSha256 || null,
    frontendBuildHash: evidence.frontendBuild && evidence.frontendBuild.tree && evidence.frontendBuild.tree.sha256 || null,
    hostNode: evidence.host && evidence.host.node || null,
    hostPlatform: evidence.host && evidence.host.platform || null,
    hostCpuCount: evidence.host && evidence.host.logicalCpus || null,
    hostMemoryBytes: evidence.host && evidence.host.totalMemoryBytes || null,
    cpuLimit: evidence.server && evidence.server.cpuLimitPerContainer || null,
    memoryLimit: evidence.server && evidence.server.memoryLimitPerContainer || null
  }
}

function compareIdentity(runs) {
  const issues = []
  const validRuns = runs.filter(run => run.summary)
  if (validRuns.length !== INPUTS.length) issues.push({ severity: 'incomplete', code: 'six_runs_missing', message: '六组 A/B/C × natural/full 未全部提供可读 summary' })
  const vectors = validRuns.map(run => ({ label: run.label, vector: evidenceVector(run) }))
  if (!vectors.length || vectors.some(item => !item.vector)) issues.push({ severity: 'incomplete', code: 'driver_vector_missing', message: '至少一组缺失 driverEvidence' })
  else if (new Set(vectors.map(item => stableJson(item.vector))).size !== 1) {
    issues.push({ severity: 'fail', code: 'driver_vector_mismatch', message: '六组 driver 哈希向量、宿主 Node 版本或输入方式不一致', details: vectors })
  }

  const artifactRows = validRuns.map(run => ({ label: run.label, variant: run.variant, artifacts: runArtifacts(run) }))
  for (const row of artifactRows) {
    if (row.artifacts.commit !== BASELINE_COMMIT) issues.push({ severity: row.artifacts.commit ? 'fail' : 'incomplete', code: 'baseline_commit', message: `${row.label} baseline commit 缺失或不符`, details: row.artifacts.commit })
    if (!row.artifacts.imageId || !row.artifacts.imageManifestHash || !row.artifacts.schemaImageId || !row.artifacts.schemaManifestHash) {
      issues.push({ severity: 'incomplete', code: 'image_evidence_missing', message: `${row.label} 缺少镜像或共享数据库结构来源证明` })
    }
    if (!row.artifacts.frontendBuildHash) issues.push({ severity: 'incomplete', code: 'frontend_evidence_missing', message: `${row.label} 缺少可比较的前端构建哈希` })
  }
  for (const variant of ['A', 'B', 'C']) {
    const pair = artifactRows.filter(row => row.variant === variant)
    if (pair.length !== 2) continue
    const fields = ['imageId', 'imageManifestHash', 'sourceFilesHash', 'runtimeAssetsHash', 'schemaImageId', 'schemaManifestHash', 'frontendBuildHash', 'containerNode']
    for (const field of fields) {
      const values = pair.map(row => row.artifacts[field])
      if (values.some(value => value == null)) {
        issues.push({ severity: 'incomplete', code: 'mode_artifact_missing', message: `${variant} 两种渲染模式缺少 ${field} 对照值` })
      } else if (new Set(values.map(String)).size !== 1) {
        issues.push({ severity: 'fail', code: 'mode_artifact_mismatch', message: `${variant} natural/full 使用了不同的 ${field}`, details: pair.map(row => ({ label: row.label, value: row.artifacts[field] })) })
      }
    }
  }
  const ab = artifactRows.filter(row => row.variant === 'A' || row.variant === 'B')
  if (ab.length === 4 && new Set(ab.map(row => row.artifacts.imageId)).size !== 1) {
    issues.push({ severity: 'fail', code: 'baseline_image_mismatch', message: 'A/B 基线运行没有使用同一不可变服务镜像', details: ab.map(row => ({ label: row.label, imageId: row.artifacts.imageId })) })
  }
  for (const row of artifactRows) {
    if (row.artifacts.containerNode && !/^v?20\./.test(String(row.artifacts.containerNode))) {
      issues.push({ severity: 'fail', code: 'service_node_not_20', message: `${row.label} 服务镜像不是 Node 20` })
    }
  }
  const resources = artifactRows.map(row => ({ label: row.label, artifacts: row.artifacts }))
  const fields = ['hostPlatform', 'hostCpuCount', 'hostMemoryBytes', 'cpuLimit', 'memoryLimit']
  if (resources.length) {
    for (const field of fields) {
      const values = resources.map(row => row.artifacts[field])
      if (values.some(value => value == null)) issues.push({ severity: 'incomplete', code: 'resource_comparison_missing', message: `无法核验统一资源参数：${field}` })
      else if (new Set(values.map(String)).size !== 1) issues.push({ severity: 'fail', code: 'resource_parameters_mismatch', message: `六组测试资源参数不一致：${field}`, details: resources.map(row => ({ label: row.label, value: row.artifacts[field] })) })
    }
  }
  const hostNodeVersions = artifactRows.map(row => row.artifacts.hostNode)
  if (hostNodeVersions.length) {
    if (hostNodeVersions.some(value => !value)) issues.push({ severity: 'incomplete', code: 'host_node_missing', message: '至少一组缺少宿主 Node 版本' })
    else if (new Set(hostNodeVersions).size !== 1) issues.push({ severity: 'fail', code: 'host_node_mismatch', message: '六组 driver 宿主 Node 版本不一致' })
  }
  return { status: statusFromIssues(issues), issues, artifacts: artifactRows, driverEvidence: vectors }
}

function runWindowSamples(run, category, phase) {
  return run.samples.filter(row => row.category === category && row.phase === phase)
}

function computeWriteMetrics(run) {
  const rows = run.samples.filter(row => row.category === 'mcp-single-write' && ROUND_PHASES.includes(row.phase))
  const latencies = rows.map(row => row.latencyMs).filter(finite)
  const outcomes = {}
  for (const row of rows) outcomes[row.outcome || 'missing'] = (outcomes[row.outcome || 'missing'] || 0) + 1
  const timedOut = rows.filter(row => /timeout|timed out|abort/i.test(String(row.error || '')) || row.status === 408).length
  const unfinished = rows.filter(row => !finite(row.latencyMs) || !finite(asEpoch(row.completedAt))).length
  return {
    phaseCount: rows.length,
    measuredCount: latencies.length,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99),
    outcomes, timedOut, unfinished,
    failureRows: rows.filter(row => row.outcome !== 'success').map(row => ({
      phase: row.phase, operationId: row.operationId || null, plannedAt: asEpoch(row.plannedAt),
      startedAt: asEpoch(row.startedAt), completedAt: asEpoch(row.completedAt), latencyMs: finite(row.latencyMs) ? row.latencyMs : null,
      status: row.status ?? null, outcome: row.outcome || 'missing', path: row.path || null,
      error: row.error || null
    }))
  }
}

function compareSingleWrite(runs) {
  const results = { natural: {}, full: {} }
  const issues = []
  for (const mode of ['natural', 'full']) {
    const find = variant => runs.find(run => run.variant === variant && run.renderMode === mode)
    const a = find('A'), b = find('B'), c = find('C')
    if (!a || !b || !c || !a.summary || !b.summary || !c.summary) {
      results[mode] = { status: 'incomplete', reason: '缺少同一渲染模式下 A/B/C 原始采样' }
      issues.push({ severity: 'incomplete', code: 'write_comparison_missing', message: `${mode} 单写 P95 缺少 A/B/C 样本` })
      continue
    }
    const metrics = { A: computeWriteMetrics(a), B: computeWriteMetrics(b), C: computeWriteMetrics(c) }
    let status = 'pass'
    const sampleIncomplete = [a, b, c].some(run => run.issues.some(item =>
      ['mcp_attempt_rows', 'mcp_latency_missing', 'mcp_dispatch_incomplete', 'mcp_planned_slots', 'mcp_operation_ids'].includes(item.code)))
    if (sampleIncomplete) status = 'incomplete'
    const improvementVsA = metrics.A.p95Ms > 0 && metrics.C.p95Ms !== null
      ? (metrics.A.p95Ms - metrics.C.p95Ms) / metrics.A.p95Ms : null
    const codeChangeVsB = metrics.B.p95Ms > 0 && metrics.C.p95Ms !== null
      ? (metrics.B.p95Ms - metrics.C.p95Ms) / metrics.B.p95Ms : null
    const thresholdPass = improvementVsA !== null && improvementVsA >= MIN_IMPROVEMENT_RATIO
    if (improvementVsA === null) status = 'incomplete'
    else if (!thresholdPass && !sampleIncomplete) status = 'fail'
    if (c.summary.status !== 'pass') status = 'fail'
    results[mode] = { status, metrics, improvementVsA, codeChangeVsB,
      requiredImprovementRatio: MIN_IMPROVEMENT_RATIO,
      interpretation: 'P95 合并三轮、排除各轮 30 秒 warmup；计入已结算失败/超时的有限 latency，不用成功子集美化结果。' }
    if (!thresholdPass && improvementVsA !== null && !sampleIncomplete) issues.push({ severity: 'fail', code: 'write_p95_threshold', message: `${mode} C 相对 A 的单写 HTTP P95 降幅不足 50%`, details: { improvementVsA, p95A: metrics.A.p95Ms, p95C: metrics.C.p95Ms } })
    if (improvementVsA === null) issues.push({ severity: 'incomplete', code: 'write_p95_unmeasurable', message: `${mode} 单写 P95 缺少可比较的 A/C 数据` })
    if (c.summary.status !== 'pass') issues.push({ severity: 'fail', code: 'candidate_run_failed', message: `${mode} 候选版 summary.status=${c.summary.status}` })
  }
  return { status: statusFromIssues(issues), issues, modes: results }
}

function computeRouteMetrics(run) {
  const rows = run.samples.filter(row => row.category === 'browser-http' &&
    ROUND_PHASES.includes(row.phase) && CONTROL_ROUTES.has(`${row.method} ${row.route}`))
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.method} ${row.route}`
    const list = groups.get(key) || []
    list.push(row)
    groups.set(key, list)
  }
  return Object.fromEntries([...groups].map(([route, items]) => [route, {
    count: items.length,
    failureCount: items.filter(row => row.outcome !== 'response' || (finite(row.status) && row.status >= 500)).length,
    p50Ms: percentile(items.map(row => row.latencyMs), 0.5),
    p95Ms: percentile(items.map(row => row.latencyMs), 0.95),
    p99Ms: percentile(items.map(row => row.latencyMs), 0.99),
    maxMs: items.map(row => row.latencyMs).filter(finite).length ? Math.max(...items.map(row => row.latencyMs).filter(finite)) : null
  }]))
}

function compareControlRoutes(runs) {
  const perRun = Object.fromEntries(runs.map(run => [run.label, run.summary ? computeRouteMetrics(run) : {}]))
  const comparisons = []
  const issues = []
  for (const mode of ['natural', 'full']) {
    const a = runs.find(run => run.variant === 'A' && run.renderMode === mode)
    const b = runs.find(run => run.variant === 'B' && run.renderMode === mode)
    const c = runs.find(run => run.variant === 'C' && run.renderMode === mode)
    if (!a || !b || !c || !a.summary || !b.summary || !c.summary) {
      issues.push({ severity: 'incomplete', code: 'control_route_run_missing', message: `${mode} 未改读/协作路由比较缺少 A/B/C` })
      continue
    }
    const fixedRoutes = [...CONTROL_READ_ROUTES].map(route => route.replace(/^GET /, ''))
    const naturalRoutes = [...CONTROL_ROUTES].filter(route => !route.startsWith('GET /api/files/:room/meta'))
      .filter(route => [a, b, c].every(run => perRun[run.label][route] &&
        perRun[run.label][route].count >= MIN_ROUTE_SAMPLES && perRun[run.label][route].measuredCount >= MIN_ROUTE_SAMPLES && perRun[run.label][route].p95Ms !== null))
    const controlRows = Object.fromEntries([a, b, c].map(run => [run.label,
      run.samples.filter(row => row.category === 'control-read' && ROUND_PHASES.includes(row.phase))]))
    for (const route of fixedRoutes) {
      const routeKey = `GET ${route}`
      const modeMetrics = {}
      for (const run of [a, b, c]) {
        const rows = controlRows[run.label].filter(row => row.method === 'GET' && row.route === route)
        modeMetrics[run.label] = routeRowsMetric(rows)
        const expectedWindowRows = 3 * EXPECTED.sampleMs / EXPECTED.browserIntervalMs
        if (rows.length < MIN_ROUTE_SAMPLES || rows.length > expectedWindowRows || modeMetrics[run.label].measuredCount < MIN_ROUTE_SAMPLES) {
          issues.push({ severity: 'incomplete', code: 'control_read_sample_count', message: `${run.label} ${routeKey} 固定对照读取样本不足或异常`, details: { recorded: rows.length, minimum: MIN_ROUTE_SAMPLES, plannedMaximum: expectedWindowRows } })
        }
      }
      const values = [a, b, c].map(run => modeMetrics[run.label].p95Ms)
      const routeComplete = [a, b, c].every(run => modeMetrics[run.label].count >= MIN_ROUTE_SAMPLES && modeMetrics[run.label].measuredCount >= MIN_ROUTE_SAMPLES)
      if (!routeComplete || values.some(value => value === null)) {
        issues.push({ severity: 'incomplete', code: 'control_read_latency_missing', message: `${mode} ${routeKey} 控制读取缺少有限耗时` })
        comparisons.push({ mode, route: routeKey, source: 'control-read', byRun: modeMetrics, status: 'incomplete' })
        continue
      }
      const p95A = modeMetrics[a.label].p95Ms, p95B = modeMetrics[b.label].p95Ms, p95C = modeMetrics[c.label].p95Ms
      const regressionVsA = p95A > 0 ? (p95C - p95A) / p95A : null
      const regressionVsB = p95B > 0 ? (p95C - p95B) / p95B : null
      const regressed = [regressionVsA, regressionVsB].some(value => value !== null && value > MAX_ROUTE_REGRESSION_RATIO)
      comparisons.push({ mode, route: routeKey, source: 'control-read', samples: { A: modeMetrics[a.label].count, B: modeMetrics[b.label].count, C: modeMetrics[c.label].count },
        p95Ms: { A: p95A, B: p95B, C: p95C }, regressionVsA, regressionVsB,
        status: regressed ? 'fail' : regressionVsA === null || regressionVsB === null ? 'incomplete' : 'pass' })
      if (regressed) issues.push({ severity: 'fail', code: 'control_route_regression', message: `${mode} ${routeKey} P95 相对 A 或 B 退化超过 10%`, details: { regressionVsA, regressionVsB } })
      else if (regressionVsA === null || regressionVsB === null) issues.push({ severity: 'incomplete', code: 'control_route_p95_missing', message: `${mode} ${routeKey} P95 无法比较` })
    }
    const candidateRoutes = naturalRoutes
    for (const route of candidateRoutes) {
      const p95A = perRun[a.label][route].p95Ms
      const p95B = perRun[b.label][route].p95Ms
      const p95C = perRun[c.label][route].p95Ms
      const regressionVsA = p95A > 0 ? (p95C - p95A) / p95A : null
      const regressionVsB = p95B > 0 ? (p95C - p95B) / p95B : null
      const regressed = [regressionVsA, regressionVsB].some(value => value !== null && value > MAX_ROUTE_REGRESSION_RATIO)
      comparisons.push({ mode, route, samples: { A: perRun[a.label][route].count, B: perRun[b.label][route].count, C: perRun[c.label][route].count },
        p95Ms: { A: p95A, B: p95B, C: p95C }, regressionVsA, regressionVsB,
        status: regressed ? 'fail' : regressionVsA === null || regressionVsB === null ? 'incomplete' : 'pass' })
      if (regressed) issues.push({ severity: 'fail', code: 'control_route_regression', message: `${mode} ${route} P95 相对 A 或 B 退化超过 10%`, details: { regressionVsA, regressionVsB } })
      else if (regressionVsA === null || regressionVsB === null) issues.push({ severity: 'incomplete', code: 'control_route_p95_missing', message: `${mode} ${route} P95 无法比较` })
    }
  }
  return { status: statusFromIssues(issues), issues, minimumSamplesPerRun: MIN_ROUTE_SAMPLES,
    comparisonUses: '三轮正常采样窗口，排除 warmup；只看固定未改 GET allowlist；GET /nodes、写入、export 等改动路径不纳入。', perRun, comparisons }
}

function routeRowsMetric(rows) {
  const latencies = rows.map(row => row.latencyMs).filter(finite)
  return { count: rows.length, measuredCount: latencies.length, p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99),
    failures: rows.filter(row => !['response'].includes(row.outcome)).length,
    timedOut: rows.filter(row => /timeout|timed out/i.test(String(row.error || '')) || row.status === 408).length }
}

function parseBytes(value) {
  if (finite(value)) return value
  if (typeof value !== 'string') return null
  const first = value.split('/')[0].trim()
  const match = first.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b|bytes?)$/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit === 'b' || unit === 'byte' || unit === 'bytes') return amount
  const powers = { kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, pb: 1000 ** 5, eb: 1000 ** 6,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5, eib: 1024 ** 6 }
  return powers[unit] ? amount * powers[unit] : null
}

function windowSeries(points, startAt, endAt, windowCount = 5) {
  const width = PRESSURE_WINDOW_MS
  const windows = []
  for (let index = 0; index < windowCount; index += 1) {
    const start = startAt + index * width
    const end = index === windowCount - 1 ? endAt : Math.min(endAt, start + width)
    const selected = points.filter(point => point.at >= start && (point.at < end || (index === windowCount - 1 && point.at <= end)))
    windows.push({ index, startAt: start, endAt: end, plannedDurationMs: Math.max(0, end - start), sampleCount: selected.length,
      median: median(selected.map(point => point.value)), min: selected.length ? Math.min(...selected.map(point => point.value)) : null,
      max: selected.length ? Math.max(...selected.map(point => point.value)) : null })
  }
  return windows
}

function analyzeSeries(name, points, expectedCount, measureStart, measureEnd, unit = 'bytes', trendDirection = 'increase') {
  const sorted = points.filter(point => finite(point.at) && finite(point.value)).sort((a, b) => a.at - b.at)
  const expectedWindowCount = Math.ceil((measureEnd - measureStart) / PRESSURE_WINDOW_MS)
  const windows = windowSeries(sorted, measureStart, measureEnd, expectedWindowCount)
  const measuredSpanMs = sorted.length > 1 ? sorted[sorted.length - 1].at - sorted[0].at : 0
  const coverageRequired = Math.ceil(expectedCount * 0.6)
  const enoughSamples = sorted.length >= coverageRequired
  const enoughSpan = measuredSpanMs >= Math.max(0, (measureEnd - measureStart) - 2 * RESOURCE_INTERVAL_MS)
  const steadyWindows = windows.slice(-3)
  const enoughSteadyWindows = steadyWindows.length === 3 && steadyWindows.every(window => window.sampleCount >= MIN_SAMPLES_PER_STEADY_WINDOW && finite(window.median))
  let growthObserved = null
  let growthThreshold = null
  let growthDetails = null
  if (enoughSteadyWindows) {
    const values = steadyWindows.map(window => window.median)
    growthThreshold = Math.max(unit === 'bytes' ? 10 * MEBIBYTE : 1, Math.abs(values[0]) * 0.1)
    const totalRise = values[2] - values[0]
    const monotonic = trendDirection === 'decrease'
      ? values[1] < values[0] && values[2] < values[1]
      : values[1] > values[0] && values[2] > values[1]
    growthObserved = monotonic && Math.abs(totalRise) > growthThreshold
    growthDetails = { windowMedians: values, totalRise, threshold: growthThreshold }
  }
  return {
    name, unit, sampleCount: sorted.length, expectedSampleCount: expectedCount,
    coveragePct: expectedCount ? Number((sorted.length / expectedCount * 100).toFixed(2)) : null,
    coverageRequiredCount: coverageRequired, measuredSpanMs, requiredSpanMs: Math.max(0, (measureEnd - measureStart) - 2 * RESOURCE_INTERVAL_MS),
    enoughSamples, enoughSpan, enoughSteadyWindows, growthObserved, growthThreshold, growthDetails, trendDirection,
    firstValue: sorted.length ? sorted[0].value : null,
    lastValue: sorted.length ? sorted[sorted.length - 1].value : null,
    minValue: sorted.length ? Math.min(...sorted.map(point => point.value)) : null,
    maxValue: sorted.length ? Math.max(...sorted.map(point => point.value)) : null,
    slopePerMinute: linearSlopePerMinute(sorted), windows,
    points: sorted.map(point => ({ at: point.at, value: point.value }))
  }
}

function extractSustainedSamples(run) {
  const round = run.summary && run.summary.sustained
  if (!round) return { issues: [{ severity: 'incomplete', code: 'sustained_missing', message: '缺少持续负载摘要' }], resources: {}, queues: {} }
  const start = asEpoch(round.startedAt)
  const end = asEpoch(round.endedAt)
  const sampleStart = start === null ? null : start + EXPECTED.warmupMs
  const sampleEnd = end
  if (start === null || end === null || sampleEnd - sampleStart < EXPECTED.sustainedSampleMs) {
    return { issues: [{ severity: 'incomplete', code: 'sustained_coverage_window', message: '持续负载实际窗口不足 10 分钟' }], resources: {}, queues: {} }
  }
  const resourceEvents = run.events.filter(event => event.type === 'resource-sample' && finite(asEpoch(event.at)) &&
    asEpoch(event.at) >= sampleStart && asEpoch(event.at) <= sampleEnd)
  const plannedCount = Math.floor(EXPECTED.sustainedSampleMs / RESOURCE_INTERVAL_MS)
  const resources = {}
  const hostRss = resourceEvents.map(event => ({ at: asEpoch(event.at), value: event.host && event.host.processRssBytes })).filter(point => finite(point.value))
  const freeMemory = resourceEvents.map(event => ({ at: asEpoch(event.at), value: event.host && event.host.freeMemoryBytes })).filter(point => finite(point.value))
  resources.driverRss = analyzeSeries('driverRSS', hostRss, plannedCount, sampleStart, sampleEnd, 'bytes')
  resources.hostFreeMemory = analyzeSeries('freeMemory', freeMemory, plannedCount, sampleStart, sampleEnd, 'bytes', 'decrease')

  const server = run.summary.evidence && run.summary.evidence.server || {}
  const containers = [...(server.apiProcesses || []), server.mcpProcess].filter(Boolean)
  if (!containers.length) {
    resources.containerRss = null
  } else {
    const containerRows = []
    for (const container of containers) {
      const name = container && container.name || String(container)
      const points = []
      for (const event of resourceEvents) {
        const item = (event.containers || []).find(entry => entry.name === name)
        const value = item && parseBytes(item.memory)
        if (finite(value)) points.push({ at: asEpoch(event.at), value })
      }
      containerRows.push(analyzeSeries(`containerRSS:${name}`, points, plannedCount, sampleStart, sampleEnd, 'bytes'))
    }
    resources.containerRss = containerRows
  }

  const queueEventsAll = run.events.filter(event => event.type === 'queue-depth-sample' &&
    finite(asEpoch(event.at)) && asEpoch(event.at) >= sampleStart && asEpoch(event.at) <= sampleEnd &&
    (!event.phase || event.phase === 'sustained-10m'))
  const queueEvents = queueEventsAll.filter(event => event.available === true)
  const queues = {}
  const queueFields = [
    ['mcp.submitQueue.currentDepth', event => event.mcp && event.mcp.currentDepth],
    ['apiA.eventBridge.queueLength', event => event.apiA && event.apiA.currentDepth],
    ['apiB.eventBridge.queueLength', event => event.apiB && event.apiB.currentDepth],
    ['apiA.eventBridge.pendingDrains', event => event.apiA && event.apiA.pendingDrains],
    ['apiB.eventBridge.pendingDrains', event => event.apiB && event.apiB.pendingDrains],
    ['apiA.dbPoolWaiting', event => event.apiA && event.apiA.dbPoolWaiting],
    ['apiB.dbPoolWaiting', event => event.apiB && event.apiB.dbPoolWaiting]
  ]
  for (const [name, select] of queueFields) {
    const points = queueEvents.map(event => ({ at: asEpoch(event.at), value: select(event) })).filter(point => finite(point.value))
    queues[name] = analyzeSeries(name, points, plannedCount, sampleStart, sampleEnd, 'depth')
  }
  const traceClients = run.trace && Array.isArray(run.trace.clients) ? run.trace.clients : []
  const browserOutbox = traceClients.map(client => {
    const points = (client.trace && Array.isArray(client.trace.queueSamples) ? client.trace.queueSamples : [])
      .filter(row => row.phase === 'sustained-10m' && finite(asEpoch(row.at)) && asEpoch(row.at) >= sampleStart &&
        asEpoch(row.at) <= sampleEnd && finite(row.currentDepth))
      .map(row => ({ at: asEpoch(row.at), value: row.currentDepth }))
    return analyzeSeries(`browserOutbox:${client.label || client.userId || 'unknown'}`, points, plannedCount,
      sampleStart, sampleEnd, 'depth')
  })
  queues.browserOutbox = browserOutbox
  const historicalMcpQueueEvents = run.events.filter(event => event.type === 'mcp-queue' || event.kind === 'mcp-queue').length
  const issues = []
  if (resourceEvents.length < Math.ceil(plannedCount * 0.6)) issues.push({ severity: 'incomplete', code: 'resource_sample_coverage', message: '10 分钟资源采样不足计划点数的 60%', details: { planned: plannedCount, recorded: resourceEvents.length } })
  for (const series of [resources.driverRss, resources.hostFreeMemory, ...(resources.containerRss || [])]) {
    if (!series.enoughSamples || !series.enoughSpan || !series.enoughSteadyWindows) {
      issues.push({ severity: 'incomplete', code: 'resource_series_incomplete', message: `${series.name} 未满足覆盖与末三窗样本要求`, details: {
        sampleCount: series.sampleCount, expected: series.expectedSampleCount, spanMs: series.measuredSpanMs,
        requiredSpanMs: series.requiredSpanMs, steadyWindowCounts: series.windows.slice(-3).map(window => window.sampleCount)
      } })
    } else if (series.growthObserved) {
      const verb = series.trendDirection === 'decrease' ? '连续下降' : '连续增长'
      issues.push({ severity: 'fail', code: 'sustained_memory_growth', message: `${series.name} 最后三个 120 秒窗口${verb}且超过阈值`, details: series.growthDetails })
    }
  }
  for (const [metricName, series] of Object.entries(queues).filter(([key]) => key !== 'browserOutbox')) {
    if (!series.enoughSamples || !series.enoughSpan || !series.enoughSteadyWindows) {
      issues.push({ severity: 'incomplete', code: 'queue_depth_evidence_incomplete', message: `${series.name} 缺少至少 10 分钟实时 currentDepth 采样`, details: {
        acceptedEvent: "{type:'queue-depth-sample', phase:'sustained-10m', at:<epoch-ms>, available:true, mcp:{currentDepth:n}, apiA/apiB:{currentDepth:n,pendingDrains:n,dbPoolWaiting:n}}",
        sampleCount: series.sampleCount, expected: series.expectedSampleCount, spanMs: series.measuredSpanMs,
        requiredSpanMs: series.requiredSpanMs, steadyWindowCounts: series.windows.slice(-3).map(window => window.sampleCount),
        unavailableSamples: queueEventsAll.length - queueEvents.length,
        ignoredHistoricalQueueEvents: historicalMcpQueueEvents, metric: metricName
      } })
    } else if (series.growthObserved) {
      issues.push({ severity: 'fail', code: 'sustained_queue_growth', message: `${series.name} 最后三个 120 秒窗口连续增长并超过深度阈值`, details: series.growthDetails })
    }
  }
  if (browserOutbox.length !== EXPECTED.clientCount) {
    issues.push({ severity: 'incomplete', code: 'browser_outbox_clients_missing', message: '缺少 10 个浏览器客户端的 outboxPending 队列轨迹', details: { expected: EXPECTED.clientCount, recorded: browserOutbox.length } })
  }
  for (const series of browserOutbox) {
    if (!series.enoughSamples || !series.enoughSpan || !series.enoughSteadyWindows) {
      issues.push({ severity: 'incomplete', code: 'browser_outbox_coverage', message: `${series.name} 缺少 10 分钟实时 outboxPending 采样`, details: {
        sampleCount: series.sampleCount, expected: plannedCount, spanMs: series.measuredSpanMs,
        steadyWindowCounts: series.windows.slice(-3).map(window => window.sampleCount)
      } })
    } else if (series.growthObserved) {
      issues.push({ severity: 'fail', code: 'browser_outbox_growth', message: `${series.name} 最后三个 120 秒窗口持续增长`, details: series.growthDetails })
    }
  }
  if (!resources.containerRss) issues.push({ severity: 'incomplete', code: 'container_rss_missing', message: '无法从 Docker MemUsage 解析 API/MCP 容器 RSS' })
  return { issues, resources, queues,
    coverage: { startAt: sampleStart, endAt: sampleEnd, plannedMs: sampleEnd - sampleStart,
      plannedResourceSamples: plannedCount, recordedResourceSamples: resourceEvents.length,
      plannedQueueSamples: plannedCount, recordedQueueSamples: queueEvents.length,
      resourceCoveragePct: Number((resourceEvents.length / plannedCount * 100).toFixed(2)),
      queueCoveragePct: Number((queueEvents.length / plannedCount * 100).toFixed(2)) },
    rules: {
      sampleEveryMs: RESOURCE_INTERVAL_MS, minimumCoveragePct: 60, windowsMs: PRESSURE_WINDOW_MS,
      minimumSamplesInEachFinalWindow: MIN_SAMPLES_PER_STEADY_WINDOW,
      memoryGrowth: 'final three 120s-window medians strictly rise and total increase exceeds max(10 MiB, first-window median × 10%)',
      queueGrowth: 'final three 120s-window medians strictly rise and total increase exceeds max(1 depth, first-window median × 10%)',
      freeMemoryTrend: 'falling freeMemory is reported as supporting pressure evidence with the same threshold; unrelated host activity may affect it.',
      limitation: '未观察到增长只表示本次 10 分钟测量未观察到，不代表长期稳定。'
    } }
}

function analyzeSustainedQueueAndMemory(cRun) {
  if (!cRun || !cRun.summary) return { status: 'incomplete', issues: [{ severity: 'incomplete', code: 'candidate_run_missing', message: '缺少 C 持续负载样本' }] }
  const result = extractSustainedSamples(cRun)
  return { status: statusFromIssues(result.issues), ...result }
}

function statusFromIssues(issues) {
  if (issues.some(item => item.severity === 'fail')) return 'fail'
  if (issues.some(item => item.severity === 'incomplete')) return 'incomplete'
  return 'pass'
}

function buildReport(runs) {
  const identity = compareIdentity(runs)
  const writes = compareSingleWrite(runs)
  const routes = compareControlRoutes(runs)
  const cRuns = ['natural', 'full'].map(renderMode => runs.find(run => run.variant === 'C' && run.renderMode === renderMode))
  const sustainedModes = Object.fromEntries(['natural', 'full'].map((mode, index) => [mode, analyzeSustainedQueueAndMemory(cRuns[index])]))
  const sustainedIssues = Object.entries(sustainedModes).flatMap(([mode, value]) => value.issues.map(item => ({ ...item, mode })))
  const sustained = { status: statusFromIssues(sustainedIssues), modes: sustainedModes, issues: sustainedIssues,
    rules: sustainedModes.natural.rules || sustainedModes.full.rules || null }
  const gates = [
    { name: '六组正式输入、样本与运行身份一致', status: statusFromIssues(runs.flatMap(run => run.issues).concat(identity.issues)), issues: [...runs.flatMap(run => run.issues), ...identity.issues] },
    { name: '候选版普通单写全部走 Direct，且相对 A 的 P95 至少下降 50%', status: writes.status, issues: writes.issues },
    { name: '未改读/协作路由 P95 相对 A、B 退化均不超过 10%', status: routes.status, issues: routes.issues },
    { name: '候选版持续负载队列与内存有足量实时采样且无持续增长', status: sustained.status, issues: sustained.issues }
  ]
  const overall = gates.some(gate => gate.status === 'fail') ? 'fail'
    : gates.some(gate => gate.status === 'incomplete') ? 'incomplete' : 'pass'
  return {
    schema: 'mcp-collab-compare-v1', generatedAt: new Date().toISOString(),
    overall,
    workloadContract: EXPECTED,
    comparisonNotes: [
      'A/B/C natural/full 六组必须来自相同 driver 哈希、宿主 Node 版本和输入方法；A/B 使用同一 baseline 镜像，C 两种模式使用同一候选镜像。',
      '单写 P95 从三轮样本窗口重算，不计 warmup，所有有耗时的失败/拒绝/超时请求仍纳入；未完成请求另列，缺样不能通过。',
      'A/B 的应用性能或浏览器节拍失败可保留为容量结果；但 MCP 真实派发与每个页面的计划尝试必须逐项可追溯。C 必须满足键盘实际输入节拍并通过自身 gates。',
      '固定 meta/version 控制读取通过 control-read 分类比较；presence/subtree 等未改路径只使用自然产生的 browser-http 样本，不为补样额外注入请求。',
      '资源/队列增长判断只覆盖本次 10 分钟数据；无增长不代表长期稳定。历史 mcp-queue 事件不是实时 currentDepth。'
    ],
    identity,
    singleWrite: writes,
    unchangedRoutes: routes,
    sustainedLoad: sustained,
    runs: runs.map(run => ({
      label: run.label, variant: run.variant, renderMode: run.renderMode, dir: run.dir,
      status: run.summary && run.summary.status || 'missing', summarySchema: run.summary && run.summary.schema || null,
      formalValidation: run.status, issues: run.issues,
      roundOutcomes: run.summary && Array.isArray(run.summary.rounds) ? run.summary.rounds.map(round => ({ phase: round.phase,
        expectedMcp: round.expectedScheduledMcpCalls, dispatchedMcp: round.mcpDispatchStartedCount,
        minBrowserKeyboardPct: round.browserMinKeyboardSubmissionCompletenessPct,
        minBrowserOnTimePct: round.browserMinOnTimeKeyboardCompletenessPct,
        browserCompletionPct: round.browserEditCompletionPct, undrained: round.undrained })) : [],
      writeSamples: run.summary ? computeWriteMetrics(run) : null,
      routeSamples: run.summary ? computeRouteMetrics(run) : null,
      harnessGateFailures: run.summary && run.summary.gates && Array.isArray(run.summary.gates.gates)
        ? run.summary.gates.gates.filter(gate => gate.status === 'fail').map(gate => ({ name: gate.name, value: gate.value, threshold: gate.threshold })) : []
    })),
    gates
  }
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`无法识别参数：${arg}`)
    const key = arg.slice(2)
    if (values[key] !== undefined) throw new Error(`参数重复：${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值：${arg}`)
    values[key] = value
    index += 1
  }
  return values
}

function markdownReport(report) {
  const label = { pass: '通过', fail: '失败', incomplete: '证据不完整' }
  const lines = [
    '# MCP 多人协作性能 A/B/C 对照', '',
    `总体状态：**${label[report.overall] || report.overall}**`, '',
    '比较 A/B/C × natural/full 六组正式运行。单写 P95 合并三轮、计入所有已结算结果；未完成与失败单独列出。', '',
    '## 关键门槛', '',
    '| 门槛 | 状态 |', '|---|---|',
    ...report.gates.map(gate => `| ${gate.name} | ${label[gate.status] || gate.status} |`), '',
    '## 单写 HTTP P95', '',
    '| 渲染模式 | A P95 | B P95 | C P95 | C 相对 A 降幅 | 状态 |',
    '|---|---:|---:|---:|---:|---|',
    ...['natural', 'full'].map(mode => {
      const value = report.singleWrite.modes[mode]
      const m = value && value.metrics || {}
      const pct = value && finite(value.improvementVsA) ? `${(value.improvementVsA * 100).toFixed(1)}%` : '—'
      return `| ${mode} | ${m.A && m.A.p95Ms != null ? `${m.A.p95Ms} ms` : '—'} | ${m.B && m.B.p95Ms != null ? `${m.B.p95Ms} ms` : '—'} | ${m.C && m.C.p95Ms != null ? `${m.C.p95Ms} ms` : '—'} | ${pct} | ${label[value.status] || value.status} |`
    }), '',
    '失败、超时和未完成 MCP 请求不会从 JSON 报告中删除；P95 只对存在有限响应耗时的请求计算。', '',
    '## 未改读/协作路由', '',
    report.unchangedRoutes.comparisons.length
      ? report.unchangedRoutes.comparisons.map(row => {
        if (!row.p95Ms) return `- ${row.mode} ${row.route}：样本不完整。`
        return `- ${row.mode} ${row.route}：A ${row.p95Ms.A} ms，B ${row.p95Ms.B} ms，C ${row.p95Ms.C} ms；相对 A ${(row.regressionVsA * 100).toFixed(1)}%，相对 B ${(row.regressionVsB * 100).toFixed(1)}%。`
      }).join('\n')
      : '没有可比较的未改路由样本；固定 meta/version 探针缺失会使门槛保持证据不完整。', '',
    '## 持续负载', '',
    ...['natural', 'full'].map(mode => {
      const sustained = report.sustainedLoad.modes[mode]
      const coverage = sustained && sustained.coverage
      return coverage
        ? `- ${mode}：资源覆盖 ${coverage.resourceCoveragePct}%（${coverage.recordedResourceSamples}/${coverage.plannedResourceSamples} 点），实时队列覆盖 ${coverage.queueCoveragePct}%（${coverage.recordedQueueSamples}/${coverage.plannedQueueSamples} 点）。`
        : `- ${mode}：缺少 10 分钟持续负载或有效实时采样。`
    }), '',
    '资源与队列规则、每窗中位数、峰值、线性斜率、缺失样本和失败 operation_id 请查看同目录 JSON。', '',
    '## 六组运行', '',
    '| 组别 | Harness 状态 | 对照验证 | MCP 样本 | 未完成/失败 |', '|---|---|---|---:|---:|',
    ...report.runs.map(run => {
      const writes = run.writeSamples
      const failureCount = writes ? writes.failureRows.length : 0
      const unfinished = writes ? writes.unfinished : 0
      return `| ${run.label} | ${run.status} | ${label[run.formalValidation] || run.formalValidation} | ${writes ? writes.phaseCount : 0} | ${failureCount}/${unfinished} |`
    }), '',
    '完整原始事件、样本和所有失败/超时条目仍保留在各输入运行目录；本报告不修改输入。'
  ]
  return lines.join('\n') + '\n'
}

function runComparison(values) {
  const outputDir = values['output-dir'] ? path.resolve(values['output-dir']) : null
  if (!outputDir) throw new Error('必须提供 --output-dir，且必须是新的目录')
  if (fs.existsSync(outputDir)) throw new Error(`拒绝覆盖已存在的输出目录：${outputDir}`)
  const runs = INPUTS.map(([label, variant, renderMode]) => inputRun(label, variant, renderMode, values[`${label}-dir`]))
  const report = buildReport(runs)
  fs.mkdirSync(path.dirname(outputDir), { recursive: true })
  fs.mkdirSync(outputDir)
  fs.writeFileSync(path.join(outputDir, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(outputDir, 'comparison.md'), markdownReport(report), { flag: 'wx' })
  return { outputDir, status: report.overall, report }
}

if (require.main === module) {
  try {
    const result = runComparison(parseArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ outputDir: result.outputDir, status: result.status,
      json: path.join(result.outputDir, 'comparison.json'), markdown: path.join(result.outputDir, 'comparison.md') }, null, 2) + '\n')
    if (result.status === 'fail') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}

module.exports = {
  BASELINE_COMMIT, CONTROL_ROUTES, EXPECTED, INPUTS, analyzeSeries, analyzeSustainedQueueAndMemory,
  buildReport, compareControlRoutes, compareIdentity, compareSingleWrite, computeRouteMetrics,
  computeWriteMetrics, inputRun, markdownReport, parseArgs, parseBytes, percentile, runComparison,
  validateFormalRounds
}
