// Timeout investigation E2 (v2): one full 10,000-node dual-actor run on the real
// compiled final23 App with openPerformance:false. Records, per direction:
//   (a) the legacy-style in-page rAF wait for the target text,
//   (b) an independent host-side evaluate poll of the SAME predicate,
//   (c) the author command state BEFORE/AFTER dispatch (isApplyingRemote,
//       localIntentEpochOf, _pendingTextUids, lastPushed[uid], pending/outbox),
//   (d) the observer renderer/queue liveness including
//       renderer.root.nodeData === renderer.renderTree, the remote-apply epoch,
//       _v2RendererWaiters.size and node_tree_render_start/end/cancelled counters,
//   (e) the real native frames (join/op/op:event/ACK).
// Directions: owner -> peer (root), then peer -> owner (e2e-0), matching the
// original test flow. Evidence is persisted after every stage.
//
// No product code, no default deployment config, only owned loopback services.
// Usage:
//   node tests/performance/timeout-diag-propagate.cjs [runs] [rafTimeoutMs]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/diag-propagate')
const TOTAL = 10000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Bounded race that ALWAYS clears its timer and never leaves a losing timer
// keeping the Node process alive.
function withBudget (promise, ms, label) {
  let timer
  return new Promise(resolve => {
    timer = setTimeout(() => resolve({ budgetExceeded: true, label }), ms)
    Promise.resolve(promise).then(
      value => resolve({ resolved: true, value }),
      error => resolve({ rejected: true, error: String((error && error.message) || error) })
    )
  }).finally(() => clearTimeout(timer))
}

function installProbes (context) {
  return context.addInitScript(() => {
    const probe = { ticks: 0, gaps: [], visChanges: 0, vis: document.visibilityState }
    window.__diagProbe = probe
    window.__diagIds = new WeakMap()
    window.__diagSeq = 0
    window.__diagId = value => { if (value === null || typeof value !== 'object') return null; let id = window.__diagIds.get(value); if (!id) { id = ++window.__diagSeq; window.__diagIds.set(value, id) } return id }
    document.addEventListener('visibilitychange', () => { probe.vis = document.visibilityState; probe.visChanges += 1 })
    let last = performance.now()
    const loop = () => { probe.ticks += 1; const t = performance.now(); if (t - last > 400) probe.gaps.push(Math.round(t - last)); last = t; requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
}

const SAMPLE = ({ uid, text }) => {
  const mm = window.__onlineMM
  const r = mm.renderer
  const c = mm.cooperate
  const a = c && c.collabV2Adapter
  const node = r.findNodeByUid(uid)
  const status = a && a.getStatus ? a.getStatus() : null
  return {
    at: Date.now(),
    isRendering: r.isRendering,
    renderTimer: !!r.renderTimer,
    hasWaitRendering: !!r.hasWaitRendering,
    rootNodeDataIsRenderTree: !!(r.root && r.root.nodeData === r.renderTree),
    renderTreeId: window.__diagId(r.renderTree),
    rootNodeDataId: window.__diagId(r.root && r.root.nodeData),
    waiters: c && c._v2RendererWaiters ? c._v2RendererWaiters.size : null,
    epoch: (c && c._v2RemoteApplyEpoch) || 0,
    isApplyingRemote: !!(c && c.isApplyingRemote),
    localIntentEpoch: c && typeof c.localIntentEpochOf === 'function' ? c.localIntentEpochOf(uid) : null,
    pendingTextUids: c && c._pendingTextUids ? Array.from(c._pendingTextUids) : null,
    lastPushedText: c && c.lastPushed && c.lastPushed[uid] ? c.lastPushed[uid].text : null,
    modelText: node ? node.getData('text') : null,
    domText: node && node.group && node.group.node ? node.group.node.textContent : null,
    matchesTarget: !!(node && node.getData('text') === text),
    status: status ? { phase: status.phase, status: status.status, lastServerRevision: status.lastServerRevision,
      pendingCount: status.pendingCount, outboxPending: status.outboxPending, saveState: status.saveState } : null,
    counts: window.__diagCounts ? { ...window.__diagCounts } : null,
    probe: window.__diagProbe ? { ticks: window.__diagProbe.ticks, gaps: window.__diagProbe.gaps.slice(-3), vis: window.__diagProbe.vis } : null
  }
}

async function stats (client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    let total = 0
    const stack = [mm.renderer.renderTree]
    while (stack.length) { const n = stack.pop(); if (!n) continue; total++; stack.push(...(n.children || [])) }
    const draw = mm.nodeDraw && mm.nodeDraw.node
    return { total, attached: draw ? draw.querySelectorAll('g.smm-node').length : null, openPerformance: mm.opt.openPerformance }
  })
}

async function loadFull (client, budgetMs, total) {
  const deadline = Date.now() + budgetMs
  await client.page.evaluate(() => window.__onlineMM.updateConfig({ openPerformance: false }))
  const expand = withBudget(client.page.evaluate(async () => {
    const r = window.__onlineMM.renderer
    if (typeof r.expandAllNode === 'function') await r.expandAllNode('')
    else window.__onlineMM.execCommand('EXPAND_ALL')
    return true
  }), budgetMs, 'expand-budget')
  const outcome = await expand
  let s = await stats(client)
  while (s.total < total && Date.now() < deadline) { await sleep(3000); s = await stats(client) }
  await withBudget(settled(client), budgetMs, 'settled-budget')
  s = await stats(client)
  return { ...s, expandOutcome: outcome.resolved ? 'resolved' : outcome.label, reachedTotal: s.total >= total }
}

async function probeDirection ({ label, author, observer, uid, text, rafTimeoutMs, evidence, frames, flush, stage, settleBefore = true }) {
  if (settleBefore) await Promise.all([withBudget(settled(author), 60000, 'settle-author'), withBudget(settled(observer), 60000, 'settle-observer')])
  const t0 = Date.now()
  const pre = { author: await author.page.evaluate(SAMPLE, { uid, text }), observer: await observer.page.evaluate(SAMPLE, { uid, text }) }
  let hostMatchedAt = null, hostLast = null, stop = false
  const samples = []
  const hostPoll = (async () => {
    while (!stop) {
      const at = Date.now()
      const s = await withBudget(observer.page.evaluate(SAMPLE, { uid, text }), 4000, 'sample-budget')
      if (s.resolved) { s.value.elapsedMs = at - t0; samples.push(s.value); hostLast = s.value; if (s.value.matchesTarget && hostMatchedAt === null) hostMatchedAt = at }
      else samples.push({ at, elapsedMs: at - t0, sampleError: s.error || s.label })
      await sleep(100)
    }
  })()
  // Arm BOTH waits. The rAF outcome MUST NOT be awaited before the edit is
  // dispatched, otherwise the diagnostic itself fabricates the timeout.
  const rafWait = observer.page.waitForFunction(({ uid, text }) => {
    const n = window.__onlineMM.renderer.findNodeByUid(uid)
    return !!(n && n.getData('text') === text)
  }, { uid, text }, { timeout: rafTimeoutMs })
    .then(() => ({ resolved: true, ms: Date.now() - t0 }))
    .catch(error => ({ rejected: true, error: String(error.message).split('\n')[0], ms: Date.now() - t0 }))
  const rafOutcomePromise = withBudget(rafWait, rafTimeoutMs + 10000, 'raf-budget')
  const order = { armedAt: Date.now() - t0, dispatchedAt: null }
  stage(label + ':waits-armed')

  const dispatchStart = Date.now()
  let dispatchMs = null, authorAfterDispatch = null, authorAfter200 = null, rafResult = null
  try {
    await author.page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid, text })
    order.dispatchedAt = Date.now() - t0
    dispatchMs = Date.now() - dispatchStart
    evidence.dispatched = true
    stage(label + ':edit-dispatched')
    authorAfterDispatch = await author.page.evaluate(SAMPLE, { uid, text })
    await sleep(200)
    authorAfter200 = await author.page.evaluate(SAMPLE, { uid, text })

    if (order.dispatchedAt === null) throw new Error('DIAGNOSTIC_ORDER: edit was not dispatched before awaiting the rAF budget')
    const outcome = await rafOutcomePromise
    rafResult = outcome.resolved ? outcome.value : { budgetExceeded: true, label: outcome.label, error: outcome.error }
    // A fast transition can fall between the 100 ms host-poll ticks; take one
    // explicit final host sample before stopping so both observers are compared
    // on the same end state.
    const finalSample = await withBudget(observer.page.evaluate(SAMPLE, { uid, text }), 4000, 'final-sample-budget')
    if (finalSample.resolved) {
      finalSample.value.finalHostSample = true
      samples.push(finalSample.value)
      hostLast = finalSample.value
      if (finalSample.value.matchesTarget && hostMatchedAt === null) hostMatchedAt = Date.now()
    }
  } finally {
    // Always stop the looping observers and settle the losing rAF budget so a
    // diagnostic error (e.g. a node temporarily missing during a real render)
    // can never keep the process and its owned services alive.
    stop = true
    await withBudget(hostPoll, 5000, 'poll-stop')
    await withBudget(rafOutcomePromise, 2000, 'raf-stop')
  }

  const opsForUid = frames.filter(frame => frame.direction === 'sent' && frame.event === 'op' &&
    frame.body && frame.body.payload && frame.body.payload.uid === uid)
  const acksForUid = frames.filter(frame => frame.direction === 'received' && frame.kind === 'ack' &&
    frame.body && opsForUid.some(op => op.body.opId === frame.body.opId))
  const receivedForUid = frames.filter(frame => frame.direction === 'received' && frame.event === 'op:event' &&
    frame.body && frame.body.payload && frame.body.payload.uid === uid)
  const classification = (hostMatchedAt && rafResult.resolved) ? 'BOTH_SAW_TARGET'
    : (hostMatchedAt && !rafResult.resolved) ? 'OBSERVER_FALSE_NEGATIVE'
      : (!hostMatchedAt && rafResult.resolved) ? 'RAF_ONLY' : 'NEITHER_SAW_TARGET'
  const result = { label, uid, text, dispatchMs, classification, order,
    hostMatchedMs: hostMatchedAt ? hostMatchedAt - t0 : null,
    rafResult, pre, authorAfterDispatch, authorAfter200,
    sentOps: opsForUid.map(f => ({ opId: f.body.opId, at: f.at })), ackedOps: acksForUid.map(f => ({ opId: f.body.opId, ok: f.body.ok, rev: f.body.serverRevision })),
    observerReceivedOps: receivedForUid.map(f => ({ opId: f.body.opId, rev: f.body.serverRevision, at: f.at })),
    sampleCount: samples.length,
    observerSamples: samples.filter((s, i) => i % 5 === 0 || s.matchesTarget).slice(-60),
    lastObserverSample: hostLast,
    meanProbeGapMs: (() => { const g = samples.flatMap(s => (s.probe && s.probe.gaps) || []); return g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0 })() }
  evidence.directions.push(result)
  flush()
  return result
}

async function runOnce (browser, fixture, runIndex, rafTimeoutMs, size, race) {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const seed = size === 'small'
    ? await fixture.apps[0].control('seedSmall', { runId })
    : await fixture.apps[0].control('seedLarge', { runId, nodes: TOTAL })
  fixture.roomKey = seed.roomKey
  const total = seed.count
  const evidence = { runIndex, runId, size, total, roomKey: seed.roomKey, rafTimeoutMs, startedAt: new Date().toISOString(),
    t0: Date.now(), network: [], frames: [], pageErrors: [], stages: [], directions: [] }
  const file = path.join(OUT, `propagate-${runId}.json`)
  const flush = () => fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const stage = name => { evidence.stages.push({ name, t: Date.now() - evidence.t0, at: new Date().toISOString() }); flush() }
  const clients = []
  try {
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, openPerformance: false,
        setupTimeoutMs: 300000, liveTimeoutMs: 300000, onPage: async (page, context) => {
          await installProbes(context)
          observe.observeWire(page, clients.length, evidence.frames)
          page.on('pageerror', error => { evidence.pageErrors.push(String(error.message).slice(0, 300)); flush() })
          page.on('requestfailed', req => { const u = req.url(); if (u.includes('/api/') || u.includes('/collab-v2')) { evidence.network.push({ dir: 'failed', url: u.split('?')[0], errorText: req.failure() && req.failure().errorText }); flush() } })
        } })
      clients.push(client)
    }
    stage('opened')
    const [owner, peer] = clients
    await Promise.all([withBudget(settled(owner), 120000, 'settle-open-owner'), withBudget(settled(peer), 120000, 'settle-open-peer')])
    stage('settled-after-open')
    evidence.loaded = { owner: await loadFull(owner, 240000, total), peer: await loadFull(peer, 240000, total) }
    stage('loaded-' + size)
    for (const c of clients) {
      await c.page.evaluate(() => {
        const mm = window.__onlineMM
        window.__diagCounts = { render_start: 0, render_end: 0, render_cancelled: 0, render_complete: 0 }
        mm.on('node_tree_render_start', () => window.__diagCounts.render_start++)
        mm.on('node_tree_render_end', () => window.__diagCounts.render_end++)
        mm.on('render_cancelled', () => window.__diagCounts.render_cancelled++)
        mm.on('render_complete', () => window.__diagCounts.render_complete++)
      })
    }
    await probeDirection({ label: 'owner->peer:root', author: owner, observer: peer, uid: 'root', text: '<p>10k owner edit</p>',
      rafTimeoutMs, evidence, frames: evidence.frames, flush, stage })
    stage('direction-1-done')
    // In race mode the second edit is dispatched immediately after the observer
    // sees the first target, mirroring the original test flow and the
    // isApplyingRemote window, instead of waiting for both sides to settle.
    await probeDirection({ label: 'peer->owner:' + (size === 'small' ? 'leaf-0-0' : 'e2e-0'), author: peer, observer: owner,
      uid: size === 'small' ? 'leaf-0-0' : 'e2e-0', text: '<p>10k peer edit</p>',
      rafTimeoutMs, evidence, frames: evidence.frames, flush, stage, settleBefore: !race })
    stage('direction-2-done')
    evidence.status = 'COMPLETE'
    flush()
    console.log('PROPAGATE', JSON.stringify({ runId, directions: evidence.directions.map(d => ({ label: d.label, classification: d.classification,
      hostMatchedMs: d.hostMatchedMs, rafResult: d.rafResult, dispatchMs: d.dispatchMs,
      authorAfterDispatch: { applying: d.authorAfterDispatch.isApplyingRemote, pending: d.authorAfterDispatch.pendingTextUids, intent: d.authorAfterDispatch.localIntentEpoch, lastPushed: d.authorAfterDispatch.lastPushedText, status: d.authorAfterDispatch.status },
      sentOps: d.sentOps.length, ackedOps: d.ackedOps.length, observerReceived: d.observerReceivedOps.length,
      beforeRootRef: d.pre.observer.rootNodeDataIsRenderTree, afterRootRef: d.lastObserverSample && d.lastObserverSample.rootNodeDataIsRenderTree })),
      pageErrors: evidence.pageErrors }))
    return evidence
  } finally {
    for (const c of clients) await c.context.close().catch(() => {})
  }
}

// Guards the diagnostic ordering that a previous revision got wrong: the rAF
// budget must never be awaited before the edit is dispatched, and bounded races
// must clear their losing timer.
function selftest () {
  const assert = require('node:assert/strict')
  const src = fs.readFileSync(__filename, 'utf8')
  const dispatchIdx = src.indexOf("execCommand('SET_NODE_TEXT'")
  const awaitIdx = src.indexOf('await rafOutcomePromise')
  assert.ok(dispatchIdx >= 0, 'SET_NODE_TEXT dispatch call is present')
  assert.ok(awaitIdx >= 0, 'rafOutcomePromise is awaited')
  assert.ok(dispatchIdx < awaitIdx, 'DIAGNOSTIC_ORDER: edit must be dispatched before awaiting the rAF budget')
  assert.ok(!/const rafOutcome\s*=\s*await\s+withBudget/.test(src), 'no awaited rAF budget before dispatch')
  assert.ok(src.includes('clearTimeout(timer)'), 'withBudget must clear its timer')
  console.log('SELFTEST_OK')
}

async function main () {
  const runs = Number(process.argv[2] || 1)
  const rafTimeoutMs = Number(process.argv[3] || 120000)
  const size = process.argv[4] === 'small' ? 'small' : '10k'
  const race = process.argv[5] === 'race'
  const artifact = process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23'
  fs.mkdirSync(OUT, { recursive: true })
  const summary = { artifact, runs, size, race, rafTimeoutMs, startedAt: new Date().toISOString(), results: [] }
  let fixture, browser
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact })
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (let index = 0; index < runs; index++) {
      const evidence = await runOnce(browser, fixture, index, rafTimeoutMs, size, race)
      summary.results.push({ runIndex: index, runId: evidence.runId,
        directions: evidence.directions.map(d => ({ label: d.label, classification: d.classification, hostMatchedMs: d.hostMatchedMs, rafResult: d.rafResult })) })
      fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
    }
    summary.status = 'COMPLETE'
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log('SUMMARY', JSON.stringify(summary.results))
  } finally {
    try { await closeOwnedFixture(browser, [], fixture) } catch (err) { console.error('cleanup', err.message) }
  }
}
if (process.argv[2] === '--selftest') selftest()
else main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { selftest }
