// E4: concurrent cold-stat open mechanism test (NO injection, NO product change).
//
// Same deterministic cold statistics as the frozen RED, then 2-3 independent
// browser contexts (distinct actors) open the same real 10k room at once with
// the App's own unchanged 15 s safe-preview timeout and openPerformance:false.
// Captures the real network timing/abort, ROOM_LOAD_TRACE, adapter status getter,
// dialog state, model count and page errors per actor, persisting after each
// step so a 30 s diagnostic budget never risks the evidence.
//
// Usage: node tests/performance/timeout-diag-cold-open.cjs [nodes] [actors] [budgetMs]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/diag-cold-open')
const REDACT = value => String(value).replace(/(token|password|secret|authorization|cookie)[^,;"' ]*/gi, '$1=[redacted]')

const SAMPLE = () => {
  const appEl = document.querySelector('#app')
  const app = appEl && appEl.__vue__
  const dialogs = []
  const stack = app ? [app] : []
  while (stack.length) {
    const vm = stack.pop()
    if (!vm) continue
    if (vm.$options && (vm.$options.name === 'CooperateDialog' || vm._autoJoinScheduled !== undefined)) {
      dialogs.push({ roomName: vm.roomName, connected: vm.connected, connecting: vm.connecting,
        autoJoinScheduled: vm._autoJoinScheduled, roomLoadFailed: vm._roomLoadFailed,
        roomLoadError: vm.roomLoadError, roomLoadPhase: vm.roomLoadPhase, openAttemptId: vm._openAttemptId,
        hasAdapter: !!vm.collabV2Adapter, hasMindMap: !!vm.mindMap })
    }
    stack.push(...(vm.$children || []))
  }
  const mm = window.__onlineMM
  let modelCount = null
  if (mm && mm.renderer && mm.renderer.renderTree) {
    modelCount = 0; const s = [mm.renderer.renderTree]
    while (s.length) { const x = s.pop(); if (!x) continue; modelCount++; s.push(...(x.children || [])) }
  }
  const status = typeof window.__COLLAB_V2_STATUS__ === 'function' ? window.__COLLAB_V2_STATUS__() : null
  return { at: Date.now(), hasMM: !!mm, modelCount,
    status: status ? { phase: status.phase, status: status.status, error: status.lastErrorMessage || status.error } : null,
    roomLoadTrace: window.__ROOM_LOAD_TRACE__ || null,
    bootError: window.__COLLAB_V2_BOOT_ERROR__ ? String(window.__COLLAB_V2_BOOT_ERROR__).slice(0, 300) : null,
    integrity: window.__ROOM_INTEGRITY_REPORT__ ? { ok: window.__ROOM_INTEGRITY_REPORT__.ok, liveCount: window.__ROOM_INTEGRITY_REPORT__.liveCount } : null,
    dialogs }
}

async function main () {
  const nodes = Number(process.argv[2] || 10000)
  const actors = (process.argv[3] || 'owner,editor-a,editor-b').split(',').slice(0, 3)
  const budgetMs = Number(process.argv[4] || 30000)
  const artifact = process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23'
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  fs.mkdirSync(OUT, { recursive: true })
  const evidence = { runId, nodes, actors, budgetMs, artifact, startedAt: new Date().toISOString(), perActor: {} }
  const file = path.join(OUT, `cold-open-${nodes}-${runId}.json`)
  const flush = () => fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  let fixture, browser
  const pages = new Map()
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact })
    const storage = require(path.join(repo, 'simple-mind-map/bin/storage'))
    const pool = storage.getPool()
    try { await pool.query('alter table room_nodes set (autovacuum_enabled = false)'); evidence.autovacuumDisabled = true }
    catch (error) { evidence.autovacuumDisabled = String(error.message) }
    await pool.query('analyze room_nodes')
    evidence.coldStats = (await pool.query(`select n_live_tup, n_mod_since_analyze, last_autoanalyze from pg_stat_all_tables where relname='room_nodes'`)).rows[0]
    const seed = await fixture.apps[0].control('seedLarge', { runId, nodes })
    fixture.roomKey = seed.roomKey
    evidence.seed = { roomKey: seed.roomKey, count: seed.count }
    evidence.statsAfterSeed = (await pool.query(`select n_live_tup, n_mod_since_analyze from pg_stat_all_tables where relname='room_nodes'`)).rows[0]
    flush()

    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of actors) evidence.perActor[actor] = { actor, network: [], console: [], pageErrors: [], status: 'pending' }
    flush()
    const openOne = actor => openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, openPerformance: false,
      setupTimeoutMs: budgetMs, liveTimeoutMs: budgetMs, onPage: async (page, context) => {
        const record = evidence.perActor[actor]
        pages.set(actor, page)
        page.on('request', req => { const u = req.url(); if (u.includes('/api/') || u.includes('/collab-v2')) { record.network.push({ dir: 'req', url: u.split('?')[0], at: Date.now() }); flush() } })
        page.on('response', res => { const u = res.url(); if (u.includes('/api/') || u.includes('/collab-v2')) { record.network.push({ dir: 'res', status: res.status(), url: u.split('?')[0], at: Date.now() }); flush() } })
        page.on('requestfailed', req => { const u = req.url(); if (u.includes('/api/') || u.includes('/collab-v2')) { record.network.push({ dir: 'failed', url: u.split('?')[0], errorText: req.failure() && req.failure().errorText, at: Date.now() }); flush() } })
        page.on('console', message => { if (record.console.length < 60) { record.console.push({ type: message.type(), text: REDACT(message.text()).slice(0, 240) }); flush() } })
        page.on('pageerror', error => { record.pageErrors.push(REDACT(error.message).slice(0, 240)); flush() })
      } })
    const startedAll = Date.now()
    const settled = await Promise.allSettled(actors.map(openOne))
    evidence.concurrentMs = Date.now() - startedAll
    settled.forEach((outcome, index) => {
      const actor = actors[index]
      evidence.perActor[actor].openOutcome = outcome.status === 'fulfilled' ? 'LIVE' : 'OPEN_FAILED'
      if (outcome.status === 'rejected') evidence.perActor[actor].openError = REDACT(outcome.reason && outcome.reason.message).slice(0, 600)
    })
    flush()
    // Sample every still-alive page after the dust settles; no long waits.
    for (const actor of actors) {
      const page = pages.get(actor)
      const record = evidence.perActor[actor]
      if (!page) continue
      const sample = await Promise.race([page.evaluate(SAMPLE), new Promise(resolve => setTimeout(() => resolve({ runtimeBlocked: true }), 3000))]).catch(error => ({ evaluateError: String(error.message) }))
      record.sample = sample
      flush()
    }
    evidence.status = 'COMPLETE'
    flush()
    console.log(JSON.stringify({ runId, nodes, concurrentMs: evidence.concurrentMs,
      perActor: actors.map(actor => { const r = evidence.perActor[actor]; const preview = (r.network || []).filter(n => n.url && n.url.endsWith('/preview'))
        return { actor, openOutcome: r.openOutcome, openError: r.openError,
          previewRes: preview.filter(n => n.dir === 'res').map(n => n.status),
          previewFailed: preview.filter(n => n.dir === 'failed').map(n => n.errorText),
          lastStatus: r.sample && r.sample.status, modelCount: r.sample && r.sample.modelCount,
          roomLoadTrace: r.sample && r.sample.roomLoadTrace,
          dialog: r.sample && r.sample.dialogs && r.sample.dialogs[0] } }) }, null, 1))
  } catch (error) {
    evidence.status = 'HARNESS_FAILED'
    evidence.error = String(error.message)
    flush()
    throw error
  } finally {
    try { const storage = require(path.join(repo, 'simple-mind-map/bin/storage')); await storage.getPool().query('alter table room_nodes reset (autovacuum_enabled)'); evidence.autovacuumRestored = true }
    catch (error) { evidence.autovacuumRestoreError = String(error.message) }
    try { await closeOwnedFixture(browser, [], fixture) } catch (err) { console.error('cleanup', err.message) }
    flush()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
