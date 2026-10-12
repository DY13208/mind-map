import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../..')
const RESULTS_DIR = path.join(TESTS_DIR, 'results')
const PROJECT = 'mcp-incremental-test'
const SERVICES = [
  { name: `${PROJECT}-app-a-1`, service: 'app-a', instance: 'app-a' },
  { name: `${PROJECT}-app-b-1`, service: 'app-b', instance: 'app-b' },
  { name: `${PROJECT}-postgres-1`, service: 'postgres' },
  { name: `${PROJECT}-redis-1`, service: 'redis' }
]
const DUMMY_TOKEN = 'mcp-incremental-test-only-token-0160b5a7'
const DB_PASSWORD = 'mcp-incremental-test-db-password'
const OUTPUT_SUFFIXES = [
  '-resources.jsonl',
  '-resources-summary.json',
  '-phase1.stdout.log',
  '-phase1.stderr.log',
  '-baseline.jsonl',
  '-summary.json',
  '-round-01-browser-metrics.json',
  '-postgres-lock-waits.log'
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function runDocker(args) {
  let result
  try {
    result = spawnSync('docker', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    })
  } catch (error) {
    throw new Error(`docker ${args[0]} failed: ${error.message}`)
  }
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  return result.stdout.trim()
}

function readContainerLabels(containerName) {
  const raw = runDocker(['inspect', '--format', '{{json .Config.Labels}}', containerName])
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`could not read Compose labels for ${containerName}`)
  }
}

function assertTestComposeProject(runId) {
  const actualNames = runDocker([
    'ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--format', '{{.Names}}'
  ]).split(/\r?\n/).filter(Boolean).sort()
  const expectedNames = SERVICES.map(item => item.name).sort()
  assert(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `refusing to sample unexpected Compose services; expected only ${expectedNames.join(', ')}, found ${actualNames.join(', ') || '(none)'}`
  )

  for (const expected of SERVICES) {
    const labels = readContainerLabels(expected.name)
    assert(labels?.['com.docker.compose.project'] === PROJECT, `${expected.name} is not in Compose project ${PROJECT}`)
    assert(labels?.['com.docker.compose.service'] === expected.service, `${expected.name} has an unexpected Compose service label`)
    assert(runDocker(['inspect', '--format', '{{.State.Status}}', expected.name]) === 'running', `${expected.name} is not running`)

    if (expected.instance) {
      // Read only the specific test identity fields. Never print or dump container environment variables.
      const selected = `process.stdout.write(JSON.stringify({skip:process.env.MIND_MAP_SKIP_ROOT_ENV,runId:process.env.MCP_BASELINE_RUN_ID,instance:process.env.MCP_BASELINE_INSTANCE,metricsFile:process.env.MCP_BASELINE_METRICS_FILE,pgHost:process.env.PGHOST,pgPort:process.env.PGPORT,pgDatabase:process.env.PGDATABASE,pgUser:process.env.PGUSER,redisUrl:process.env.REDIS_URL,token:process.env.MCP_TOKEN}))`
      const runtime = JSON.parse(runDocker(['exec', expected.name, 'node', '-e', selected]))
      assert(runtime.skip === '1', `${expected.name} must set MIND_MAP_SKIP_ROOT_ENV=1`)
      assert(runtime.runId === runId, `${expected.name} uses a different run ID; recreate only test app-a/app-b with MCP_BASELINE_RUN_ID=${runId}`)
      assert(runtime.instance === expected.instance, `${expected.name} has an unexpected baseline instance name`)
      assert(runtime.metricsFile === `/baseline/${runId}-${expected.instance}.jsonl`, `${expected.name} metrics file prefix does not match run ID ${runId}`)
      assert(runtime.pgHost === 'postgres' && runtime.pgPort === '5432', `${expected.name} is not pointed at the test Compose PostgreSQL`)
      assert(runtime.pgDatabase === 'mcp_incremental_test' && runtime.pgUser === 'mcp_test', `${expected.name} is not pointed at the test database`)
      assert(runtime.redisUrl === 'redis://redis:6379', `${expected.name} is not pointed at the test Compose Redis`)
      assert(runtime.token === DUMMY_TOKEN, `${expected.name} is not using the fixed test-only MCP token`)
    }
  }
}

function requiredRunId() {
  const runId = String(process.env.MCP_BASELINE_RUN_ID || '').trim()
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(runId), 'set a fresh MCP_BASELINE_RUN_ID (3-64 letters, digits, _ or -) before starting the test containers')
  return runId
}

function ensureFixedHostConfiguration() {
  const fixed = {
    MCP_BASELINE_APP_A: 'http://127.0.0.1:19090',
    MCP_BASELINE_APP_B: 'http://127.0.0.1:19091',
    MCP_BASELINE_MCP_TOKEN: DUMMY_TOKEN,
    MCP_BASELINE_PGHOST: '127.0.0.1',
    MCP_BASELINE_PGPORT: '25492',
    MCP_BASELINE_PGDATABASE: 'mcp_incremental_test',
    MCP_BASELINE_PGUSER: 'mcp_test',
    MCP_BASELINE_PGPASSWORD: DB_PASSWORD
  }
  for (const [key, value] of Object.entries(fixed)) {
    const supplied = process.env[key]
    assert(supplied == null || supplied === value, `${key} must use the fixed local test-only value`)
  }
}

function parsePercent(value) {
  const number = Number.parseFloat(String(value || '').replace('%', '').trim())
  return Number.isFinite(number) ? number : null
}

function parseBytes(value, unit) {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount)) return null
  const units = {
    B: 1,
    kB: 1000,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4
  }
  return units[unit] ? Math.round(amount * units[unit]) : null
}

function parseMemoryUsage(value) {
  const match = String(value || '').match(/^\s*([\d.]+)\s*([A-Za-z]+)\s*\/\s*([\d.]+)\s*([A-Za-z]+)\s*$/)
  if (!match) return { currentBytes: null, limitBytes: null }
  return {
    currentBytes: parseBytes(match[1], match[2]),
    limitBytes: parseBytes(match[3], match[4])
  }
}

function summarizeSamples(samples) {
  const cpu = samples.map(item => item.cpuPercent).filter(Number.isFinite)
  const memory = samples.map(item => item.memoryCurrentBytes).filter(Number.isFinite)
  const memoryPercent = samples.map(item => item.memoryPercent).filter(Number.isFinite)
  const latestLimit = [...samples].reverse().find(item => Number.isFinite(item.memoryLimitBytes))?.memoryLimitBytes ?? null
  const maxMemory = samples.filter(item => Number.isFinite(item.memoryCurrentBytes))
    .reduce((best, item) => item.memoryCurrentBytes > (best?.memoryCurrentBytes ?? -1) ? item : best, null)
  const maxCpu = samples.filter(item => Number.isFinite(item.cpuPercent))
    .reduce((best, item) => item.cpuPercent > (best?.cpuPercent ?? -1) ? item : best, null)
  const intervals = []
  const ordered = samples.slice().sort((a, b) => a.observedAtEpochMs - b.observedAtEpochMs)
  for (let i = 1; i < ordered.length; i++) intervals.push(ordered[i].observedAtEpochMs - ordered[i - 1].observedAtEpochMs)
  const percentile = (values, p) => {
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null
  }
  return {
    sampleCount: samples.length,
    observedIntervalMs: {
      min: intervals.length ? Math.min(...intervals) : null,
      p50: percentile(intervals, 0.5),
      p95: percentile(intervals, 0.95),
      max: intervals.length ? Math.max(...intervals) : null,
      source: 'host receive-time differences for successive docker stats rows; Docker does not provide per-row sample timestamps here'
    },
    cpuPercentMaxObserved: cpu.length ? Math.max(...cpu) : null,
    cpuPercentMaxObservedAtEpochMs: maxCpu?.observedAtEpochMs ?? null,
    memoryCurrentBytesMaxObserved: memory.length ? Math.max(...memory) : null,
    memoryCurrentMaxRaw: maxMemory?.memoryUsageRaw ?? null,
    memoryCurrentMaxObservedAtEpochMs: maxMemory?.observedAtEpochMs ?? null,
    memoryLimitBytesLastObserved: latestLimit,
    memoryPercentMaxObserved: memoryPercent.length ? Math.max(...memoryPercent) : null
  }
}

function getPhaseWindows(summary, rawRows, outputDir) {
  const windows = []
  const suiteStart = rawRows.find(row => row.type === 'suite_start')
  const suiteComplete = rawRows.find(row => row.type === 'suite_complete')
  const round = summary?.results?.rounds?.[0]
  if (!round) return windows

  const browserArtifactPath = round.browser?.artifact
    ? path.join(outputDir, round.browser.artifact)
    : null
  let browserStartedAt = null
  if (browserArtifactPath && fs.existsSync(browserArtifactPath)) {
    try {
      browserStartedAt = Date.parse(JSON.parse(fs.readFileSync(browserArtifactPath, 'utf8'))?.loadMetrics?.startedAt)
    } catch {}
  }
  const add = (name, start, end, source) => {
    const startEpochMs = typeof start === 'number' ? start : Date.parse(start || '')
    const endEpochMs = typeof end === 'number' ? end : Date.parse(end || '')
    if (Number.isFinite(startEpochMs) && Number.isFinite(endEpochMs) && endEpochMs >= startEpochMs) {
      windows.push({ name, startEpochMs, endEpochMs, durationMs: endEpochMs - startEpochMs, source })
    }
  }

  add('phase1_total', suiteStart?.at, suiteComplete?.at, 'phase1 JSONL suite_start/suite_complete rows')
  add('fixture_seed_and_browser_process_launch', round.startedAt, browserStartedAt, 'phase1 round start through browser helper loadMetrics.startedAt')
  add('13_client_readiness_and_prewrite_validation', browserStartedAt, round.measuredStartedAt, 'browser-baseline loadMetrics.startedAt through phase1 measuredStartedAt')
  add('mcp_100_call_loop', round.measuredStartedAt, round.measuredFinishedAt, 'phase1 measuredStartedAt/measuredFinishedAt around the 100 sequential MCP calls')
  add('post_write_validation_and_browser_close', round.measuredFinishedAt, round.finishedAt, 'phase1 measuredFinishedAt through round finishedAt')

  const warmup = rawRows.find(row => row.type === 'warmup')
  const calls = warmup?.calls || []
  const warmStart = Math.min(...calls.map(item => item.startedEpochMs).filter(Number.isFinite))
  const warmEnd = Math.max(...calls.map(item => item.responseCompletedEpochMs).filter(Number.isFinite))
  if (Number.isFinite(warmStart) && Number.isFinite(warmEnd)) add('mcp_warmup', warmStart, warmEnd, 'timestamps in phase1 warmup calls')
  return windows
}

function validatePhase1(summary, rawRows, phase1ExitCode) {
  const rounds = summary?.results?.rounds || []
  const round = rounds[0]
  const coverage = summary?.results?.operationMetrics?.coverage
  const calls = rawRows.filter(row => row.type === 'mcp_call')
  const warmup = rawRows.find(row => row.type === 'warmup')
  const warmupCalls = Array.isArray(warmup?.calls) ? warmup.calls : []
  const clients = round?.browser?.loadSummary
  const completeEvidence = {
    suiteComplete: rawRows.some(row => row.type === 'suite_complete'),
    oneRound: rounds.length === 1 && Number(summary?.environment?.rounds) === 1,
    exactly100MeasuredMcpCalls: calls.length === 100 && calls.every(row => row.uid && !row.error),
    warmupCallsSucceeded: warmupCalls.length === 6 && warmupCalls.every(row => row.uid && !row.error),
    roundCounts100Successful: round?.writesAttempted === 100 && round?.writesSucceeded === 100,
    largeFixtureVerified: round?.fixtureNodes === 6001 && round?.fixtureLiveNodes === 6000 && rawRows.some(row => row.type === 'round_complete'),
    thirteenBrowserClientsReady: round?.browser?.lcpSamples?.length === 13 && clients?.successfulClients === 13 && clients?.collabV2ReadyClients === 13 && clients?.structureReadyClients === 13,
    metricCoverageComplete: coverage?.complete === true && coverage?.observedTransactions === 100 && coverage?.observedCacheEvents === 100 && coverage?.observedHttpCalls === 200,
    noHarnessErrors: Array.isArray(summary?.errors) && summary.errors.length === 0
  }
  const coreComplete = Object.values(completeEvidence).every(Boolean)
  const qualityFailures = summary?.qualityFailures || []
  const phase1Status = coreComplete
    ? (qualityFailures.length === 0 && phase1ExitCode === 0 ? 'complete' : 'core-complete-with-quality-failures')
    : 'incomplete'
  return { phase1Status, coreComplete, completeEvidence, qualityFailures, phase1ExitCode }
}

async function waitForInitialSamples(state, samplesByContainer, timeoutMs = 15000) {
  const expected = new Set(SERVICES.map(item => item.name))
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (state.error) throw state.error
    if (state.exited) throw new Error(`docker stats exited before sampling all four test containers (code ${state.exitCode})`)
    if ([...expected].every(name => samplesByContainer.get(name)?.length > 0)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`docker stats did not produce an initial row for every test container within ${timeoutMs}ms`)
}

async function main() {
  const runId = requiredRunId()
  ensureFixedHostConfiguration()
  assertTestComposeProject(runId)
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  for (const suffix of OUTPUT_SUFFIXES) {
    assert(!fs.existsSync(path.join(RESULTS_DIR, `${runId}${suffix}`)), `preserving existing output; choose a fresh MCP_BASELINE_RUN_ID (found ${runId}${suffix})`)
  }
  assert(!fs.readdirSync(RESULTS_DIR).some(name => name.startsWith(`${runId}-round-01-`)), `preserving existing browser artifacts for run ${runId}; choose a fresh MCP_BASELINE_RUN_ID`)

  const resourcePath = path.join(RESULTS_DIR, `${runId}-resources.jsonl`)
  const summaryPath = path.join(RESULTS_DIR, `${runId}-resources-summary.json`)
  const stdoutPath = path.join(RESULTS_DIR, `${runId}-phase1.stdout.log`)
  const stderrPath = path.join(RESULTS_DIR, `${runId}-phase1.stderr.log`)
  const resourceStream = fs.createWriteStream(resourcePath, { flags: 'wx' })
  const stdoutLog = fs.createWriteStream(stdoutPath, { flags: 'wx' })
  const stderrLog = fs.createWriteStream(stderrPath, { flags: 'wx' })
  const writeRow = row => resourceStream.write(`${JSON.stringify({ schema: 1, runId, ...row })}\n`)
  const captureStartedAtEpochMs = Date.now()
  writeRow({
    type: 'resource_capture_start',
    at: new Date(captureStartedAtEpochMs).toISOString(),
    atEpochMs: captureStartedAtEpochMs,
    composeProject: PROJECT,
    containers: SERVICES.map(item => ({ name: item.name, service: item.service })),
    collector: 'continuous docker stats --format {{json .}}; no --no-stream snapshot is used for peak calculations',
    intervalClaim: 'not assumed; host receive timestamps and actual per-container intervals are recorded'
  })

  const samplesByContainer = new Map(SERVICES.map(item => [item.name, []]))
  const statsErrors = []
  const statsState = { error: null, exited: false, exitCode: null }
  const stats = spawn('docker', ['stats', '--format', '{{json .}}', ...SERVICES.map(item => item.name)], {
    cwd: REPO_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = createInterface({ input: stats.stdout, crlfDelay: Infinity })
  stdout.on('line', line => {
      const observedAtEpochMs = Date.now()
      let record
      try { record = JSON.parse(line) } catch {
        statsErrors.push({ atEpochMs: observedAtEpochMs, reason: 'non-json docker stats row', row: line.slice(0, 1000) })
        writeRow({ type: 'docker_stats_parse_error', atEpochMs: observedAtEpochMs, row: line.slice(0, 1000) })
        return
      }
      const candidateNames = [record.Name, record.Container]
        .map(value => String(value || '').replace(/^\//, ''))
      const container = candidateNames.find(name => samplesByContainer.has(name)) || candidateNames.find(Boolean) || ''
      const samples = samplesByContainer.get(container)
      if (!samples) {
        statsState.error = new Error(`docker stats returned a non-allowlisted container: ${container || '(missing name)'}`)
        statsErrors.push({ atEpochMs: observedAtEpochMs, error: statsState.error.message })
        writeRow({ type: 'docker_stats_container_refused', atEpochMs: observedAtEpochMs, container: container || null })
        stats.kill('SIGTERM')
        return
      }
      const memory = parseMemoryUsage(record.MemUsage)
      const row = {
        type: 'docker_stats_sample',
        observedAtEpochMs,
        observedAt: new Date(observedAtEpochMs).toISOString(),
        container,
        dockerNameRaw: record.Name ?? null,
        dockerContainerRaw: record.Container ?? null,
        cpuPercentRaw: String(record.CPUPerc || ''),
        cpuPercent: parsePercent(record.CPUPerc),
        memoryUsageRaw: String(record.MemUsage || ''),
        memoryCurrentBytes: memory.currentBytes,
        memoryLimitBytes: memory.limitBytes,
        memoryPercentRaw: String(record.MemPerc || ''),
        memoryPercent: parsePercent(record.MemPerc),
        networkIoRaw: String(record.NetIO || ''),
        blockIoRaw: String(record.BlockIO || ''),
        pidsRaw: String(record.PIDs || '')
      }
      samples.push(row)
      writeRow(row)
  })
  stats.stderr.on('data', chunk => {
      const message = String(chunk).trim()
      if (message) {
        statsErrors.push({ atEpochMs: Date.now(), stderr: message.slice(0, 2000) })
        writeRow({ type: 'docker_stats_stderr', atEpochMs: Date.now(), text: message.slice(0, 2000) })
      }
  })
  stats.once('error', error => { statsState.error = error })
  stats.once('close', code => {
    statsState.exited = true
    statsState.exitCode = code
    if (code !== 0 && code !== null) statsState.error = new Error(`docker stats exited with code ${code}`)
  })

  let phase1Child = null
  let phase1ExitCode = null
  let interrupted = null
  const childEnv = {
    ...process.env,
    MIND_MAP_SKIP_ROOT_ENV: '1',
    MCP_BASELINE_RUN_ID: runId,
    MCP_BASELINE_APP_A: 'http://127.0.0.1:19090',
    MCP_BASELINE_APP_B: 'http://127.0.0.1:19091',
    MCP_BASELINE_MCP_TOKEN: DUMMY_TOKEN,
    MCP_BASELINE_PGHOST: '127.0.0.1',
    MCP_BASELINE_PGPORT: '25492',
    MCP_BASELINE_PGDATABASE: 'mcp_incremental_test',
    MCP_BASELINE_PGUSER: 'mcp_test',
    MCP_BASELINE_PGPASSWORD: DB_PASSWORD,
    MCP_BASELINE_ROUNDS: '1',
    MCP_BASELINE_OPS: '100',
    MCP_BASELINE_RESUME_FROM: '1'
  }
  const signalHandler = signal => {
    interrupted = signal
    phase1Child?.kill('SIGTERM')
    stats.kill('SIGTERM')
  }
  process.once('SIGINT', signalHandler)
  process.once('SIGTERM', signalHandler)

  try {
    await waitForInitialSamples(statsState, samplesByContainer, 16000)
    if (statsState.error) throw statsState.error
    phase1Child = spawn(process.execPath, [path.join(TESTS_DIR, 'phase1.mjs')], {
      cwd: REPO_ROOT,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    phase1Child.stdout.on('data', chunk => { stdoutLog.write(chunk); process.stdout.write(chunk) })
    phase1Child.stderr.on('data', chunk => { stderrLog.write(chunk); process.stderr.write(chunk) })
    await new Promise((resolve, reject) => {
      phase1Child.once('error', reject)
      phase1Child.once('close', (code, signal) => {
        phase1ExitCode = code
        if (signal && !interrupted) interrupted = signal
        resolve()
      })
    })
  } catch (error) {
    interrupted ||= 'precondition-or-run-error'
    statsErrors.push({ atEpochMs: Date.now(), error: String(error.stack || error) })
    writeRow({ type: 'resource_capture_error', atEpochMs: Date.now(), message: String(error.message || error) })
    phase1Child?.kill('SIGTERM')
  } finally {
    process.removeListener('SIGINT', signalHandler)
    process.removeListener('SIGTERM', signalHandler)
    if (stats.exitCode == null) {
      stats.kill('SIGTERM')
      await Promise.race([new Promise(resolve => stats.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))])
    }
    const captureFinishedAtEpochMs = Date.now()
    writeRow({
      type: 'resource_capture_finish',
      at: new Date(captureFinishedAtEpochMs).toISOString(),
      atEpochMs: captureFinishedAtEpochMs,
      statsProcessExitCode: statsState.exitCode,
      statsStoppedIntentionally: phase1ExitCode !== null || interrupted !== null,
      interrupted
    })
    resourceStream.end()
    stdoutLog.end()
    stderrLog.end()
    await Promise.all([finished(resourceStream), finished(stdoutLog), finished(stderrLog)])
  }

  const rawPath = path.join(RESULTS_DIR, `${runId}-baseline.jsonl`)
  const phase1SummaryPath = path.join(RESULTS_DIR, `${runId}-summary.json`)
  const rawRows = fs.existsSync(rawPath)
    ? fs.readFileSync(rawPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    : []
  let phase1Summary = null
  if (fs.existsSync(phase1SummaryPath)) {
    try { phase1Summary = JSON.parse(fs.readFileSync(phase1SummaryPath, 'utf8')) } catch {}
  }
  const phase1 = validatePhase1(phase1Summary, rawRows, phase1ExitCode)
  const phaseWindows = getPhaseWindows(phase1Summary, rawRows, RESULTS_DIR)
  const samples = [...samplesByContainer.values()].flat()
  const resourcesByContainer = Object.fromEntries(SERVICES.map(item => {
    const containerSamples = samplesByContainer.get(item.name) || []
    return [item.name, summarizeSamples(containerSamples)]
  }))
  const phaseResourceSummaries = phaseWindows.map(window => {
    const phaseSamples = samples.filter(item => item.observedAtEpochMs >= window.startEpochMs && item.observedAtEpochMs <= window.endEpochMs)
    return {
      ...window,
      containers: Object.fromEntries(SERVICES.map(item => [
        item.name,
        summarizeSamples(phaseSamples.filter(sample => sample.container === item.name))
      ]))
    }
  })
  const resourceComplete = SERVICES.every(item => (samplesByContainer.get(item.name)?.length || 0) >= 2) &&
    phaseWindows.some(window => window.name === 'mcp_100_call_loop') &&
    !statsState.error &&
    !statsErrors.some(item => item.error || item.stderr || item.reason)
  const summary = {
    schema: 1,
    runId,
    sourceCommit: phase1Summary?.sourceCommit || null,
    composeProject: PROJECT,
    containers: SERVICES.map(item => ({ name: item.name, service: item.service })),
    testEnvironment: {
      appA: 'http://127.0.0.1:19090',
      appB: 'http://127.0.0.1:19091',
      database: '127.0.0.1:25492/mcp_incremental_test',
      token: '[fixed test-only token omitted]',
      rootEnvFileLoadedByScript: false
    },
    phase1: {
      ...phase1,
      measuredMcpToolCalls: rawRows.filter(row => row.type === 'mcp_call').length,
      unmeasuredWarmupMcpToolCalls: rawRows.find(row => row.type === 'warmup')?.calls?.length || 0,
      knownTotalMcpToolCalls: rawRows.filter(row => row.type === 'mcp_call').length + (rawRows.find(row => row.type === 'warmup')?.calls?.length || 0),
      phase1SummaryFile: fs.existsSync(phase1SummaryPath) ? path.basename(phase1SummaryPath) : null,
      rawHarnessFile: fs.existsSync(rawPath) ? path.basename(rawPath) : null,
      stdoutFile: path.basename(stdoutPath),
      stderrFile: path.basename(stderrPath)
    },
    resourceCapture: {
      status: resourceComplete ? 'complete' : 'incomplete',
      captureStartedAtEpochMs,
      captureFinishedAtEpochMs: Date.now(),
      source: 'continuous docker stats stream restricted to the four validated test containers',
      sampleTimeSemantics: 'observedAtEpochMs is host time when a Docker CLI row arrived; per-container intervals are measured from those timestamps. Docker-side sample timestamps are unavailable.',
      cadenceClaim: 'none; use observedIntervalMs for the measured cadence and sampling gaps',
      noOneShotPeak: true,
      peakSemantics: 'CPU and memory maxima are maxima across the recorded continuous-stream rows, not a docker stats --no-stream snapshot; they can still miss sub-interval spikes.',
      sampleCount: samples.length,
      samplesByContainer: Object.fromEntries(SERVICES.map(item => [item.name, samplesByContainer.get(item.name)?.length || 0])),
      containers: resourcesByContainer,
      phaseWindows,
      phaseResources: phaseResourceSummaries,
      collectorErrors: statsErrors,
      rawFile: path.basename(resourcePath)
    },
    status: resourceComplete && phase1.coreComplete
      ? (phase1.phase1Status === 'complete' ? 'complete' : 'core-complete-with-quality-failures')
      : 'incomplete',
    interpretation: 'phase1 measures exactly 100 MCP add_node writes and also performs 6 unmeasured warm-up writes. A phase1 exit code of 1 is preserved. If measured writes, DB assertions, 13-client readiness and metric coverage pass while qualityFailures remain, the result is core-complete-with-quality-failures, not all-pass.',
    limits: [
      'The sampler does not start, stop, build, or recreate Compose services.',
      'It refuses any Compose project/container outside the fixed mcp-incremental-test allowlist.',
      'A sampled maximum is not proof of a hard peak; sub-interval resource spikes can be missed.',
      'Phase windows come from phase1/browser-helper timestamps; only the MCP write loop has explicit measured start/end fields.'
    ]
  }
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ type: 'resource_sample_complete', runId, status: summary.status, phase1Status: phase1.phase1Status, phase1ExitCode, sampleCount: samples.length, summary: summaryPath }))
  if (phase1ExitCode != null && phase1ExitCode !== 0) process.exitCode = phase1ExitCode
  else if (summary.status !== 'complete') process.exitCode = 1
}

const HELP = `资源采样：在隔离测试 project 上执行一轮 phase1（100 次真实 MCP 写入、13 个浏览器客户端），并持续采集四个测试容器的 docker stats。

先用一个未使用过的 run ID 重建两个测试应用容器，使 preload 计量文件前缀与本轮一致：
  $env:MIND_MAP_SKIP_ROOT_ENV = '1'
  $env:MCP_BASELINE_RUN_ID = 'mcp-resource-20261012-a01'
  docker compose --env-file tests/mcp-incremental/test.env -p mcp-incremental-test -f docker/mcp-incremental-test.compose.yml up -d --no-build --no-deps --force-recreate app-a app-b
  node tests/mcp-incremental/resource-sample.mjs

Compose 始终显式指定测试 env 文件和 project；不要省略 --env-file 或 -p。脚本不会启动、重建或停止服务。
仅接受 project mcp-incremental-test 的 app-a/app-b/postgres/redis 四个容器；数据使用测试数据库 mcp_incremental_test（端口 25492）和固定测试 token。
--help 不访问 Docker，也不执行基线。`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP)
} else {
  main().catch(error => {
    console.error(`resource sampler refused or failed: ${error.message}`)
    process.exitCode = 1
  })
}
