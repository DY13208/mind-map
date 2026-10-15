// Runs the existing complete-App C2 stable main under the same owned Node20
// fixture. Its original 2 warmups + 5 formal samples are a separate regression,
// never substituted for the >=200 independent native performance groups.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const sourceManifest = require('./online-source-manifest.cjs')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')
const { prepareStableRooms, remainingSeededRooms } = require('./stable-seeded-rooms.cjs')

function childFamily(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2 && row.every(Number.isInteger))
  const family = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of rows) if (family.has(parent) && !family.has(pid)) { family.add(pid); changed = true }
  }
  return [...family].filter(pid => rows.some(row => row[0] === pid))
}

async function terminateBenchmarkChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { childPid: child.pid, terminatedPids: [], alreadyClosed: true }
  const pids = childFamily(child.pid)
  const identities = new Map(execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => { const match = line.trim().match(/^(\d+)\s+(.+)$/); return match && [Number(match[1]), match[2]] }).filter(Boolean))
  const terminatedPids = []
  // Capture this still-live child subtree before killing its root. Never scan
  // arbitrary Chrome processes or other agents' browser children.
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, 'SIGTERM'); terminatedPids.push(pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
  const escalatedPids = []
  for (const pid of pids) {
    let current
    try { current = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
    catch { continue }
    if (current !== identities.get(pid)) continue // The original owned process already exited; never target a reused PID.
    try { process.kill(pid, 'SIGKILL'); escalatedPids.push(pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  return { childPid: child.pid, capturedOwnedPids: pids, terminatedPids, escalatedPids }
}

async function main() {
  const timeoutMs = Number(process.env.PERF_TDD_C2_STABLE_TIMEOUT || 1800000)
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 7200000, 'Explicit stable harness total timeout is bounded')
  const prefix = 'performance-c2-stable-' + crypto.randomUUID()
  const label = 'online-isolated-' + crypto.randomUUID()
  const output = path.join(onlineOutputDirectory('after', 'stable-existing'), label)
  fs.mkdirSync(output, { recursive: true })
  sourceManifest.capture('after', output)
  fs.writeFileSync(path.join(output, 'harness-manifest.json'), JSON.stringify({ capturedAt: Date.now(), runtime: process.version,
    files: ['online-stable-existing.cjs', 'stable-seeded-rooms.cjs', 'online-web-fixture.cjs', 'online-server-child.cjs', 'online-cleanup.cjs', 'online-source-manifest.cjs', 'online-output-directory.cjs', 'isolation.cjs']
      .map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex') })) }, null, 2))
  const fixture = await startFixture({ phase: 'after', instances: 1 })
  const script = path.join(repo, 'simple-mind-map/test/c2RendererStable.benchmark.test.js')
  const logPath = path.join(output, 'original-entry.log')
  const log = fs.openSync(logPath, 'wx')
  const startedAt = Date.now()
  let child, childPid, exitCode, adopted, failure, timeoutCleanup, seeded, seededRoomsPath
  // Recorded as soon as each owned room exists, so a partial seeding failure
  // still leaves a verifiable cleanup obligation for the child's tracked rooms.
  const seededRoomKeys = []
  try {
    // Test-only owned-fixture data preparation, outside the measured interval.
    // The product POST /api/files create path falls back to a Tencent COS read
    // for a brand-new room (the observed 500 `missing param Bucket`); that COS
    // read is fixture setup only. The owned child's existing native seed
    // controls write the exact authoritative trees into the real isolated PG,
    // after which the original browser measurement still runs unchanged (real
    // HTTP full fetch, real native WebSocket, 2 warmup + 5 formal samples).
    seeded = await prepareStableRooms(fixture.apps[0], [1000, 5000, 10000], entry => seededRoomKeys.push(entry.roomKey))
    seededRoomsPath = path.join(output, 'seeded-rooms.json')
    fs.writeFileSync(seededRoomsPath, JSON.stringify({ preparedAt: Date.now(),
      seedSource: 'Owned fixture control seed + persistTree (native storage.upsertRoom); no product COS, no production code or test-only production entry added',
      boundary: 'Covers real isolated-PG room/owner/node fixture preparation and the real browser render measurement. Does NOT cover product POST /api/files file creation or real TCloud COS object storage.',
      rooms: seeded.rooms, proofs: seeded.proofs }, null, 2))
    child = spawn(path.join(repo, 'work/performance-tdd/runtime/node_modules/node/bin/node'), [script], {
      cwd: repo, stdio: ['ignore', log, log], env: { ...process.env,
        MIND_MAP_SKIP_ROOT_ENV: '1', AUTH_DEV_BYPASS_KEY: 'isolated-auth-transport-sentinel-not-used-for-login',
        C2_BROWSER_ORIGIN: fixture.fronts[0].base, C2_RENDER_ALLOWED_ORIGINS: JSON.stringify([...fixture.fronts, ...fixture.apps].map(item => item.base)),
        C2_RENDER_COMPACT_LAYOUT: 'false', C2_RENDER_ROOM_PREFIX: prefix, C2_RENDER_LABEL: label,
        C2_RENDER_SIZES: '1000,5000,10000', C2_RENDER_WARMUPS: '2', C2_RENDER_RUNS: '5',
        C2_RENDER_SEEDED_ROOMS_FILE: seededRoomsPath,
        C2_BROWSER_EXECUTABLE_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
    })
    childPid = child.pid
    fs.writeFileSync(path.join(output, 'invocation.json'), JSON.stringify({ startedAt, childPid,
      command: 'Node20 simple-mind-map/test/c2RendererStable.benchmark.test.js (original test:c2:renderer-stable entry)',
      originalScriptSha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),
      browserExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', prefix, seededRoomsPath,
      source: 'Complete candidate webpack App; owned-fixture PG seed (native upsertRoom) then real HTTP full fetch; synthetic auth/me with actual ACL and PG/socket. Product POST /api/files create and real COS creation are intentionally not claimed.',
      seededRooms: seeded.rooms,
      fixtureProofs: seeded.proofs,
      layout: 'Actual saved logicalStructure preference and compactLayout=false; distinct from default compact diagnostics',
      sampleBoundary: 'Original2 warmups +5 formal per1k/5k/10k; a compatibility regression, no>=200/P95 acceptance claim',
      bundleHashes: fixture.bundleHashes, appStartupManifest: fixture.apps[0].manifestPath,
      fixtureBoundaries: fixture.fixtureBoundaries }, null, 2))
    exitCode = await new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(async () => {
        timedOut = true
        try { timeoutCleanup = await terminateBenchmarkChild(child) }
        catch (error) { timeoutCleanup = { childPid, cleanupError: error.message } }
        const error = new Error('HARNESS_PROCESS_TIMEOUT: existing C2 child exceeded its total deadline; no renderer RED inferred')
        error.code = 'HARNESS_PROCESS_TIMEOUT'
        reject(error)
      }, timeoutMs)
      child.once('error', error => { if (!timedOut) { clearTimeout(timer); reject(error) } })
      child.once('close', code => { if (!timedOut) { clearTimeout(timer); resolve(code) } })
    })
    assert.equal(exitCode, 0, 'Existing C2 stable entry failed; inspect original-entry.log')
    const reportPath = path.join(repo, 'simple-mind-map/test/reports', 'c2-renderer-stable-' + label + '.json')
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    assert.deepEqual(report.config.sizes, [1000, 5000, 10000])
    for (const size of [1000, 5000, 10000]) {
      const rows = report.sizes[size].rows
      assert.equal(rows.filter(row => row.phase === 'warmup').length, 2)
      assert.equal(rows.filter(row => row.phase === 'formal').length, 5)
      for (const row of rows) {
        assert.equal(row.ACTUAL_LAYOUT, 'logicalStructure')
        assert.equal(row.ACTUAL_COMPACT_LAYOUT, false)
        assert.ok(row.CURRENT_NODE_CACHE_COUNT >= size && row.ATTACHED_NODE_GROUP_COUNT > 0,
          'Existing stability sample keeps complete model instances and actual connected paint')
      }
    }
    fs.copyFileSync(reportPath, path.join(output, 'original-report.json'))
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ startedAt, completedAt: Date.now(), exitCode,
      status: 'EXISTING_C2_STABLE_ENTRY_COMPLETED', phase: 'after', prefix,
      boundary: 'The original stable main really ran.2+5 samples retain their original statistics; the separate10k full-App correctness runner supplies complete model UID/SVG/crossing protection; the isolated room fixture was prepared through the owned native PG seed (no product COS); product POST /api/files creation and real TCloud COS are not claimed; no enterprise OAuth or external resources tested',
      seededRooms: seeded.rooms, config: report.config, environment: report.environment }, null, 2))
  } catch (error) {
    failure = error
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ startedAt, completedAt: Date.now(), exitCode,
      status: error.code === 'HARNESS_PROCESS_TIMEOUT' ? 'BLOCKED_ENV' : 'REGRESSION_FAILED',
      failureKind: error.code || null, message: error.message, stack: error.stack, timeoutCleanup }, null, 2))
  } finally {
    fs.closeSync(log)
    const ownedSeededRoomKeys = seeded ? Object.values(seeded.rooms) : seededRoomKeys
    const cleanup = { timeoutCleanup: timeoutCleanup || null, seededRooms: seeded ? seeded.rooms : null,
      seedingIncomplete: !seeded && seededRoomKeys.length > 0, partialSeededRooms: seeded ? null : seededRoomKeys }
    try { adopted = await fixture.apps[0].control('adoptStableRooms', { prefix }); cleanup.adopted = adopted }
    catch (error) { cleanup.adoptionError = error.message; if (!failure) failure = error }
    finally { cleanup.fixture = await closeOwnedFixture(null, [], fixture) }
    if (ownedSeededRoomKeys.length) {
      // The owned child tracks every seeded room and deletes it on stop; prove
      // the deletion in the real isolated PG instead of the prefix-adoption path.
      // This runs for a complete run and for a partial seeding failure alike.
      try { cleanup.seededRoomsRemaining = await remainingSeededRooms(ownedSeededRoomKeys) }
      catch (error) { cleanup.cleanupVerificationError = error.message; if (!failure) failure = error }
    }
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
    if (exitCode === 0 && adopted) {
      if (ownedSeededRoomKeys.length) assert.deepEqual(cleanup.seededRoomsRemaining, [], 'All owned seeded C2 rooms were removed from real PG')
      else assert.equal(adopted.adoptedForCleanup.length, 3, 'All three exact namespaced C2 rooms were adopted for cleanup')
    }
  }
  if (failure) throw failure
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
