// Bounded setup diagnostic with a failure-path sample. Captures network,
// console, router/auth, mm.opt, every CooperateDialog component state and the
// room-load/V2-boot traces. On open failure it samples the still-alive page
// immediately instead of waiting out the budget.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e/diag-setup')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const REDACT = value => String(value).replace(/(token|password|secret|authorization|cookie)[^,;"' ]*/gi, '$1=[redacted]')

async function sampleState (page) {
  return page.evaluate(() => {
    const appEl = document.querySelector('#app')
    const app = appEl && appEl.__vue__
    const router = app && app.$router
    const route = router && router.currentRoute
    const dialogs = []
    const stack = app ? [app] : []
    while (stack.length) {
      const vm = stack.pop()
      if (!vm) continue
      if (vm.$options && (vm.$options.name === 'CooperateDialog' || vm.roomName !== undefined || vm._autoJoinScheduled !== undefined)) {
        dialogs.push({ name: vm.$options && vm.$options.name, roomName: vm.roomName, connected: vm.connected,
          connecting: vm.connecting, autoJoinScheduled: vm._autoJoinScheduled, roomLoadFailed: vm._roomLoadFailed,
          roomLoadError: vm.roomLoadError, roomLoadPhase: vm.roomLoadPhase, openAttemptId: vm._openAttemptId,
          dialogVisible: vm.dialogVisible, hasAdapter: !!vm.collabV2Adapter, hasMindMap: !!vm.mindMap,
          hasCooperate: !!(vm.mindMap && vm.mindMap.cooperate) })
      }
      stack.push(...(vm.$children || []))
    }
    const mm = window.__onlineMM
    return {
      href: location.href, search: location.search, routeQueryRoom: route && route.query ? route.query.room : null,
      status: window.__COLLAB_V2_STATUS__ ? window.__COLLAB_V2_STATUS__() : null,
      bootState: window.__COLLAB_V2_STATE__ || null,
      bootError: window.__COLLAB_V2_BOOT_ERROR__ || null,
      join: window.__COLLAB_V2_JOIN__ || null,
      apply: window.__COLLAB_V2_APPLY__ || null,
      roomLoadTrace: window.__ROOM_LOAD_TRACE__ || null,
      integrity: window.__ROOM_INTEGRITY_REPORT__ || null,
      runtimeConfig: window.__MIND_MAP_RUNTIME__ || null,
      mmOpt: mm ? { openPerformance: mm.opt.openPerformance, readonly: mm.opt.readonly, layout: mm.getLayout() } : null,
      hasCooperate: !!(mm && mm.cooperate), safeLoadMode: mm && mm.cooperate ? mm.cooperate.safeLoadMode : null,
      dialogs
    }
  })
}

async function main () {
  const size = process.argv[2] === '10k' ? '10k' : 'small'
  const budgetMs = Number(process.argv[3] || (size === '10k' ? 60000 : 30000))
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const evidence = { runId, size, budgetMs, artifactEnv: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', network: [], console: [], pageErrors: [], samples: [] }
  let fixture, browser, clients = [], pageRef = null
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = size === '10k' ? await fixture.apps[0].control('seedLarge', { runId, nodes: 10000 }) : await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.seed = { roomKey: seed.roomKey, count: seed.count }
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const client = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: seed.roomKey,
      setupTimeoutMs: budgetMs, liveTimeoutMs: budgetMs, onPage: async (page, context) => {
        pageRef = page
        page.on('request', req => { const u = req.url(); if (u.includes('/api/') || u.includes('/collab-v2')) evidence.network.push({ dir: 'req', method: req.method(), url: u.split('?')[0] }) })
        page.on('response', res => { const u = res.url(); if (u.includes('/api/') || u.includes('/collab-v2')) evidence.network.push({ dir: 'res', status: res.status(), url: u.split('?')[0] }) })
        page.on('console', m => { if (evidence.console.length < 120) evidence.console.push({ type: m.type(), text: REDACT(m.text()).slice(0, 500) }) })
        page.on('pageerror', e => evidence.pageErrors.push(REDACT(e.message).slice(0, 500)))
      } }).catch(error => { evidence.openError = REDACT(error.message); return null })
    if (client) clients = [client]
    if (client) {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        const sample = await sampleState(pageRef).catch(e => ({ evaluateError: String(e && e.message) }))
        evidence.samples.push({ at: Date.now(), sample })
        if (sample.status && sample.status.phase === 'LIVE') { evidence.reachedLive = true; break }
        await sleep(3000)
      }
      if (evidence.reachedLive) evidence.status = 'LIVE'
      else evidence.status = 'NOT_LIVE'
    } else {
      // openActorEditor failed (e.g. LIVE timeout): sample immediately, do not idle.
      const sample = await sampleState(pageRef).catch(e => ({ evaluateError: String(e && e.message) }))
      evidence.samples.push({ at: Date.now(), sample })
      evidence.status = 'OPEN_FAILED'
    }
    fs.writeFileSync(path.join(OUT, `diag-${size}-${runId}.json`), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ size, status: evidence.status, openError: evidence.openError,
      last: evidence.samples.at(-1) && evidence.samples.at(-1).sample,
      network: evidence.network, pageErrors: evidence.pageErrors, console: evidence.console.slice(0, 15) }, null, 1).slice(0, 5000))
  } finally {
    try { if (fixture) await closeOwnedFixture(browser, clients, fixture) } catch (_) {}
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
