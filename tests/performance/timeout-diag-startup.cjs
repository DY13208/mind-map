// Timeout investigation E1: minimal observable NATURAL startup trials.
//
// Opens an owned real fixture room through the compiled final23 App and, at the
// same time, runs BOTH wait styles on the same predicate:
//   (a) the harness wait inside openActorEditor — Playwright page.waitForFunction
//       which polls with requestAnimationFrame by default;
//   (b) an independent host-side page.evaluate poll every 100 ms (the harness
//       wait uses Playwright's rAF polling).
// It also injects an rAF heartbeat + visibility probe, records the real native
// wire (join/op/op:event/ACK via the existing observeWire helper), real network
// timing / meta-preview shape / boot+join+apply globals / dialog state, and
// appends each trial to disk immediately so evidence survives a later hang.
//
// No product code, no default deployment config, only owned loopback services.
// Usage:
//   node tests/performance/timeout-diag-startup.cjs [small|10k] [trials] [budgetMs]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/diag-startup')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const REDACT = value => String(value).replace(/(token|password|secret|authorization|cookie)[^,;"' ]*/gi, '$1=[redacted]')
const isApiUrl = url => url.includes('/api/') || url.includes('/collab-v2')

function attachNetwork (page, trial, pending) {
  page.on('request', req => {
    const url = req.url()
    if (!isApiUrl(url)) return
    const record = { dir: 'req', method: req.method(), url: url.split('?')[0], startedAt: Date.now() }
    pending.set(req, record)
    trial.network.push(record)
  })
  page.on('response', async res => {
    const url = res.url()
    if (!isApiUrl(url)) return
    const reqRecord = pending.get(res.request())
    const record = { dir: 'res', status: res.status(), url: url.split('?')[0],
      durationMs: reqRecord ? Date.now() - reqRecord.startedAt : null }
    if (/\/(meta|preview)(\?|$)/.test(url)) {
      try {
        const text = await res.text()
        const json = JSON.parse(text)
        // The real preview endpoint returns the preview object at top level
        // (verified with a direct fixture fetch): { room_key, tree, node_count, ... }.
        // meta returns the integrity report at top level.
        if (url.includes('/preview')) {
          record.shape = { hasTree: !!(json && json.tree), rootUid: json && json.tree && json.tree.data && json.tree.data.uid,
            nodeCount: json && (json.node_count || json.nodeCount), version: json && json.version,
            lazyLoad: json && json.lazy_load, httpCollab: json && !!json.http_collab, treeSource: json && json.treeSource,
            roomNodesCount: json && json.roomNodesCount, roomsJsonCount: json && json.roomsJsonCount,
            roomNodesInitialized: json && json.roomNodesInitialized, legacyFallback: json && json.legacyFallback,
            role: json && json.role, canEdit: json && json.canEdit }
        } else {
          record.shape = { ok: json && json.ok, version: json && (json.version || (json.file && json.file.version)),
            liveCount: json && json.liveCount, errors: json && Array.isArray(json.errors) ? json.errors.length : null,
            role: json && json.role }
        }
      } catch (err) { record.shapeError = REDACT(err.message).slice(0, 200) }
    }
    trial.network.push(record)
  })
  page.on('requestfailed', req => {
    const url = req.url()
    if (!isApiUrl(url)) return
    const failure = req.failure()
    trial.network.push({ dir: 'failed', url: url.split('?')[0], errorText: failure && failure.errorText })
  })
  page.on('websocket', socket => {
    trial.websockets.push({ event: 'open', url: socket.url().split('?')[0] })
    socket.on('socketerror', error => trial.websockets.push({ event: 'error', message: REDACT(error) }))
    socket.on('close', () => trial.websockets.push({ event: 'close' }))
  })
}

function installProbes (context) {
  return context.addInitScript(() => {
    const probe = { ticks: 0, t0: performance.now(), gaps: [], visChanges: 0, vis: document.visibilityState, focus: document.hasFocus() }
    window.__diagProbe = probe
    document.addEventListener('visibilitychange', () => { probe.vis = document.visibilityState; probe.visChanges += 1 })
    let last = performance.now()
    const loop = now => {
      probe.ticks += 1
      const t = performance.now()
      if (t - last > 400) probe.gaps.push(Math.round(t - last))
      last = t
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
}

const SAMPLE = () => {
  const appEl = document.querySelector('#app')
  const app = appEl && appEl.__vue__
  const dialogs = []
  const stack = app ? [app] : []
  while (stack.length) {
    const vm = stack.pop()
    if (!vm) continue
    if (vm.$options && (vm.$options.name === 'CooperateDialog' || vm._autoJoinScheduled !== undefined)) {
      dialogs.push({ name: vm.$options && vm.$options.name, roomName: vm.roomName, connected: vm.connected,
        connecting: vm.connecting, autoJoinScheduled: vm._autoJoinScheduled, roomLoadFailed: vm._roomLoadFailed,
        roomLoadError: vm.roomLoadError, roomLoadPhase: vm.roomLoadPhase, openAttemptId: vm._openAttemptId,
        hasAdapter: !!vm.collabV2Adapter, hasMindMap: !!vm.mindMap, largeMapInitialOverview: vm.largeMapInitialOverview })
    }
    stack.push(...(vm.$children || []))
  }
  const status = typeof window.__COLLAB_V2_STATUS__ === 'function' ? window.__COLLAB_V2_STATUS__() : null
  const mm = window.__onlineMM
  return {
    at: Date.now(),
    hasMM: !!mm,
    modelCount: mm && mm.renderer && mm.renderer.renderTree ? (() => { let n = 0; const s = [mm.renderer.renderTree]; while (s.length) { const x = s.pop(); if (!x) continue; n++; s.push(...(x.children || [])) } return n })() : null,
    status: status ? { phase: status.phase, status: status.status, socketConnected: status.socketConnected,
      lastServerRevision: status.lastServerRevision, pendingCount: status.pendingCount, outboxPending: status.outboxPending,
      saveState: status.saveState, error: status.lastErrorMessage || status.error } : null,
    join: window.__COLLAB_V2_JOIN__ || null,
    apply: window.__COLLAB_V2_APPLY__ || null,
    bootError: window.__COLLAB_V2_BOOT_ERROR__ ? String(window.__COLLAB_V2_BOOT_ERROR__).slice(0, 300) : null,
    roomLoadTrace: window.__ROOM_LOAD_TRACE__ || null,
    integrity: window.__ROOM_INTEGRITY_REPORT__ ? { ok: window.__ROOM_INTEGRITY_REPORT__.ok,
      version: window.__ROOM_INTEGRITY_REPORT__.version, liveCount: window.__ROOM_INTEGRITY_REPORT__.liveCount,
      errors: Array.isArray(window.__ROOM_INTEGRITY_REPORT__.errors) ? window.__ROOM_INTEGRITY_REPORT__.errors.length : null } : null,
    probe: window.__diagProbe ? { ticks: window.__diagProbe.ticks, gaps: window.__diagProbe.gaps.slice(-4),
      vis: window.__diagProbe.vis, visChanges: window.__diagProbe.visChanges, focus: window.__diagProbe.focus } : null,
    dialogs
  }
}

async function main () {
  const size = process.argv[2] === '10k' ? '10k' : 'small'
  const trials = Number(process.argv[3] || 6)
  const budgetMs = Number(process.argv[4] || 30000)
  const artifact = process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23'
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  fs.mkdirSync(OUT, { recursive: true })
  const evidence = { runId, size, trials, budgetMs, artifact, startedAt: new Date().toISOString(), results: [] }
  let fixture, browser
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact })
    const seed = size === '10k'
      ? await fixture.apps[0].control('seedLarge', { runId, nodes: 10000 })
      : await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.seed = { roomKey: seed.roomKey, count: seed.count }
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (let index = 0; index < trials; index++) {
      const trial = { index, startedAt: Date.now(), network: [], websockets: [], frames: [], console: [], pageErrors: [], samples: [] }
      let pageRef = null, contextRef = null, stop = false, stopAfter = null, hostSawLive = null, hostSawMM = null
      let pollPromise = Promise.resolve()
      try {
        const started = Date.now()
        let client = null, openError = null, openResolvedAt = null
        try {
          client = await openActorEditor(browser, fixture, {
            actor: 'owner', roomKey: seed.roomKey, openPerformance: false,
            setupTimeoutMs: budgetMs, liveTimeoutMs: budgetMs,
            onPage: async (page, context) => {
              pageRef = page; contextRef = context
              await installProbes(context)
              attachNetwork(page, trial, new Map())
              observe.observeWire(page, index, trial.frames)
              page.on('console', message => { if (trial.console.length < 80) trial.console.push({ type: message.type(), text: REDACT(message.text()).slice(0, 300) }) })
              page.on('pageerror', error => trial.pageErrors.push(REDACT(error.message).slice(0, 300)))
              pollPromise = (async () => {
                while (!stop && (!stopAfter || Date.now() < stopAfter)) {
                  const at = Date.now()
                  try {
                    const sample = await Promise.race([
                      page.evaluate(SAMPLE),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 4000))
                    ])
                    sample.elapsedMs = at - started
                    trial.samples.push(sample)
                    if (sample.status && sample.status.phase === 'LIVE' && hostSawLive === null) hostSawLive = at
                    if (sample.hasMM && hostSawMM === null) hostSawMM = at
                  } catch (err) {
                    trial.samples.push({ at, elapsedMs: at - started, evaluateError: REDACT(err.message).slice(0, 200) })
                  }
                  await sleep(100)
                }
              })()
            }
          })
        } catch (error) {
          openError = REDACT(error.message).slice(0, 600)
        }
        openResolvedAt = Date.now()
        // Keep polling a little after the open settles so the LIVE transition
        // and the immediate post-open state are always captured.
        stopAfter = Date.now() + 2000
        await Promise.race([pollPromise, sleep(8000)])
        stop = true
        await Promise.race([pollPromise, sleep(2000)])
        trial.openError = openError
        trial.openMs = openResolvedAt - started
        trial.hostSawMMMs = hostSawMM ? hostSawMM - started : null
        trial.hostSawLiveMs = hostSawLive ? hostSawLive - started : null
        trial.rAFWaitMs = openError ? null : openResolvedAt - started
        trial.rAFMinusHostLiveMs = (hostSawLive && !openError) ? (openResolvedAt - started) - (hostSawLive - started) : null
        trial.rAFSawLive = !openError
        if (!openError) trial.status = 'OPEN_LIVE'
        else if (hostSawLive) trial.status = 'OBSERVER_FALSE_NEGATIVE'
        else trial.status = 'NO_LIVE'
        trial.lastSample = trial.samples.at(-1) || null
        if (client) await client.context.close().catch(() => {})
      } finally {
        stop = true
        if (contextRef) await contextRef.close().catch(() => {})
        trial.finishedAt = Date.now()
        evidence.results.push(trial)
        // Persist immediately: a later trial can hang past the budget and we
        // must not lose earlier evidence.
        fs.writeFileSync(path.join(OUT, `startup-${size}-${runId}.json`), JSON.stringify(evidence, null, 2))
        fs.writeFileSync(path.join(OUT, `trial-${size}-${runId}-${String(index).padStart(2, '0')}-${trial.status}.json`), JSON.stringify(trial, null, 2))
        console.log('TRIAL', JSON.stringify({ index, size, status: trial.status, openMs: trial.openMs,
          hostSawLiveMs: trial.hostSawLiveMs, rAFMinusHostLiveMs: trial.rAFMinusHostLiveMs, hostSawMMMs: trial.hostSawMMMs, rAFSawLive: trial.rAFSawLive,
          lastStatus: trial.lastSample && trial.lastSample.status,
          lastRoomLoad: trial.lastSample && trial.lastSample.roomLoadTrace,
          lastProbe: trial.lastSample && trial.lastSample.probe,
          recentNet: trial.network.slice(-6).map(n => ({ dir: n.dir, status: n.status, url: n.url && n.url.split('/').slice(-2).join('/'), ms: n.durationMs, err: n.errorText })),
          frameSummary: trial.frames.reduce((acc, f) => { const key = f.direction + ':' + (f.event || f.kind); acc[key] = (acc[key] || 0) + 1; return acc }, {}),
          consoleWarn: trial.console.filter(c => c.type === 'warning' || c.type === 'error').slice(0, 4),
          pageErrors: trial.pageErrors.slice(0, 3) }))
      }
    }
    evidence.status = 'COMPLETE'
    evidence.summary = evidence.results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})
    fs.writeFileSync(path.join(OUT, `startup-${size}-${runId}.json`), JSON.stringify(evidence, null, 2))
    console.log('SUMMARY', JSON.stringify(evidence.summary))
  } finally {
    try { await closeOwnedFixture(browser, [], fixture) } catch (err) { console.error('cleanup', err.message) }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
