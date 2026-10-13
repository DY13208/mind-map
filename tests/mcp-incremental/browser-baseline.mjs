import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const CLIENT_COUNT = 13
const APP_A_CLIENTS = 7
const DEFAULT_TIMEOUT_MS = 90_000
const sessions = new WeakMap()

function now() {
  return performance.now()
}

function percentile(values, fraction) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (finite.length === 0) return null
  return finite[Math.max(0, Math.ceil(fraction * finite.length) - 1)]
}

function summarize(values) {
  return {
    samples: values.filter(Number.isFinite).length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99)
  }
}

function decodeSocketEvent(payload) {
  if (typeof payload !== 'string') return ''
  const offset = payload.indexOf('[')
  if (offset < 0) return ''
  try {
    const decoded = JSON.parse(payload.slice(offset))
    return Array.isArray(decoded) && typeof decoded[0] === 'string' ? decoded[0] : ''
  } catch (_) {
    return ''
  }
}

function attachSocketProbe(cdp, counters) {
  let hadHandshake = false
  let closedSinceHandshake = false
  cdp.on('Network.webSocketCreated', () => { counters.opened += 1 })
  cdp.on('Network.webSocketHandshakeResponseReceived', (event) => {
    if (event.response?.status === 101) {
      if (hadHandshake && closedSinceHandshake) counters.reconnects += 1
      counters.successfulOpens += 1
      hadHandshake = true
      closedSinceHandshake = false
    }
  })
  cdp.on('Network.webSocketClosed', () => { counters.closed += 1; closedSinceHandshake = true })
  cdp.on('Network.webSocketFrameSent', (event) => {
    counters.framesSent += 1
    const frame = event.response?.payloadData
    const eventName = decodeSocketEvent(frame)
    if (/gap/i.test(eventName) || /GAP_SYNC|VERSION_GAP/.test(frame || '')) counters.gapEvents += 1
    if (/resnapshot|required/i.test(eventName) || /RESNAPSHOT_REQUIRED/.test(frame || '')) counters.resnapshotEvents += 1
    if (/retry/i.test(eventName) || /"retry"\s*:\s*true/i.test(frame || '')) counters.retryEvents += 1
  })
  cdp.on('Network.webSocketFrameReceived', (event) => {
    counters.framesReceived += 1
    const frame = event.response?.payloadData
    const eventName = decodeSocketEvent(frame)
    if (eventName === 'op:event') counters.opEventsReceived += 1
    if (/gap/i.test(eventName) || /GAP_SYNC|VERSION_GAP/.test(frame || '')) counters.gapEvents += 1
    if (/resnapshot|required/i.test(eventName) || /RESNAPSHOT_REQUIRED/.test(frame || '')) counters.resnapshotEvents += 1
    if (/retry/i.test(eventName) || /"retry"\s*:\s*true/i.test(frame || '')) counters.retryEvents += 1
  })
}

function socketCounterSnapshot(client) {
  return client.websocketCounters ? { ...client.websocketCounters } : null
}

async function collabStateSnapshot(page) {
  return page.evaluate(() => {
    const state = window.__COLLAB_V2_STATE__ || {}
    const apply = window.__COLLAB_V2_APPLY__ || {}
    const trace = Array.isArray(window.__V2_TRACE_LOG__) ? window.__V2_TRACE_LOG__ : null
    return {
      useV2: apply.useV2 === true,
      status: state.status || null,
      phase: state.phase || null,
      socketConnected: Boolean(state.socketId),
      reconnectCount: Number.isFinite(Number(state.reconnectCount)) ? Number(state.reconnectCount) : null,
      gapRecoveredOps: Number.isFinite(Number(state.gapRecoveredOps)) ? Number(state.gapRecoveredOps) : null,
      snapshotRecoveryCount: Number.isFinite(Number(state.snapshotRecoveryCount)) ? Number(state.snapshotRecoveryCount) : null,
      retryTraceEvents: trace ? trace.filter((row) => /retry/i.test(String(row.stage || ''))).length : null
    }
  })
}

function browserInstrumentation() {
  const perf = {
    lcpMs: null,
    lcpEntries: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: null,
    longTasksSupported: false,
    longTaskWindow: null
  }
  Object.defineProperty(window, '__mcpBaselinePerf', {
    configurable: false,
    enumerable: false,
    value: perf
  })

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.lcpMs = entry.startTime
        perf.lcpEntries += 1
      }
    })
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (_) {
    perf.lcpUnsupported = true
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      perf.longTasksSupported = true
      for (const entry of list.getEntries()) {
        perf.longTaskCount += 1
        perf.longTaskTotalMs += entry.duration
        perf.longTaskMaxMs = Math.max(perf.longTaskMaxMs ?? 0, entry.duration)
        if (perf.longTaskWindow?.active) {
          perf.longTaskWindow.count += 1
          perf.longTaskWindow.totalMs += entry.duration
          perf.longTaskWindow.maxMs = Math.max(perf.longTaskWindow.maxMs ?? 0, entry.duration)
        }
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
    perf.longTasksSupported = true
  } catch (_) {
    perf.longTasksSupported = false
  }

}

function normalizeBranchText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

async function visibleNodeCount(page) {
  return page.locator('.smm-node').count()
}

async function waitForStableNodeCount(page, timeoutMs) {
  const started = Date.now()
  let previous = 0
  let stableSamples = 0
  while (Date.now() - started < timeoutMs) {
    const count = await visibleNodeCount(page)
    if (count > 0 && count === previous) stableSamples += 1
    else stableSamples = count > 0 ? 1 : 0
    if (stableSamples >= 3) return count
    previous = count
    await page.waitForTimeout(250)
  }
  throw new Error('stable-node-count-timeout')
}

async function inspectExpectedStructure(page, expected) {
  return page.evaluate((spec) => {
    const nodes = Array.from(document.querySelectorAll('.smm-node'))
    const ownText = (element) => String(element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText ||
      element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent || '').replace(/\s+/g, ' ').trim()
    const find = (uid, text) => nodes.find((element) => {
      if (uid && element.getAttribute('data-node-uid') !== uid) return false
      return !text || ownText(element) === text
    }) || null
    const root = find(spec.rootUid, spec.rootText)
    const branch = find(spec.branchUid, spec.branchText)
    const branchUid = branch?.getAttribute('data-node-uid') || null
    const directChildren = branchUid
      ? nodes.filter((element) => element.getAttribute('data-parent-uid') === branchUid)
      : []
    const badgeText = branch?.querySelector('.smm-expand-btn-text')?.textContent?.trim() || null
    const badgeNumber = badgeText && /^\d+$/.test(badgeText) ? Number(badgeText) : null
    const rect = branch?.getBoundingClientRect()
    const rootRect = root?.getBoundingClientRect()
    const svg = root?.closest('svg') || branch?.closest('svg') || null
    const rootUid = root?.getAttribute('data-node-uid') || null
    const rootChildren = rootUid ? nodes.filter((element) => element.getAttribute('data-parent-uid') === rootUid) : []
    const rectSnapshot = (value) => value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null
    const branchIntersectsViewport = Boolean(rect && rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight)
    return {
      globalDomNodeCount: nodes.length,
      rootPresent: Boolean(root),
      rootUid,
      rootText: root ? ownText(root) : null,
      rootTransform: root?.getAttribute('transform') || null,
      rootBoundingBox: rectSnapshot(rootRect),
      rootChildDomCount: rootChildren.length,
      rootChildDomUids: rootChildren.slice(0, 25).map((element) => element.getAttribute('data-node-uid')),
      branchPresent: Boolean(branch),
      branchUid,
      branchText: branch ? ownText(branch) : null,
      branchParentUid: branch?.getAttribute('data-parent-uid') || null,
      branchTransform: branch?.getAttribute('transform') || null,
      branchBoundingBox: rectSnapshot(rect),
      branchBadgeText: badgeText,
      branchBadgeCount: badgeNumber,
      branchDirectChildDomCount: directChildren.length,
      branchIntersectsViewport,
      svgViewBox: svg?.getAttribute('viewBox') || null,
      svgBoundingBox: rectSnapshot(svg?.getBoundingClientRect()),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }
    }
  }, expected)
}

async function normalizeRootView(page, expected, timeoutMs) {
  const result = {
    status: 'pending',
    selector: '.navigatorToolbarDock .btn.icondingwei',
    action: 'click the existing Back to Root UI control (renderer.setRootNodeCenter)',
    attempts: 0,
    startedAt: null,
    completedAt: null,
    before: null,
    after: null,
    error: null
  }
  try {
    result.before = await inspectExpectedStructure(page, expected)
    const control = page.locator(result.selector)
    const matches = await control.count()
    if (matches !== 1) throw new Error(`expected one view-centering control, found ${matches}`)
    await control.waitFor({ state: 'visible', timeout: timeoutMs })
    result.attempts = 1
    result.startedAt = new Date().toISOString()
    await control.click()
    await page.waitForFunction((spec) => {
      const nodes = Array.from(document.querySelectorAll('.smm-node'))
      const find = (uid, text) => nodes.find((element) => {
        if (uid && element.getAttribute('data-node-uid') !== uid) return false
        const ownText = String(element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText ||
          element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent || '').replace(/\s+/g, ' ').trim()
        return !text || ownText === text
      }) || null
      const root = find(spec.rootUid, spec.rootText)
      const branch = find(spec.branchUid, spec.branchText)
      const svg = root?.closest('svg')
      if (!root || !branch || !svg || branch.getAttribute('data-parent-uid') !== root.getAttribute('data-node-uid')) return false
      const rootRect = root.getBoundingClientRect()
      const svgRect = svg.getBoundingClientRect()
      const branchRect = branch.getBoundingClientRect()
      const rootCentered = Math.abs((rootRect.left + rootRect.width / 2) - (svgRect.left + svgRect.width / 2)) <= 3 &&
        Math.abs((rootRect.top + rootRect.height / 2) - (svgRect.top + svgRect.height / 2)) <= 3
      const branchVisible = branchRect.width > 0 && branchRect.height > 0 && branchRect.right > svgRect.left &&
        branchRect.left < svgRect.right && branchRect.bottom > svgRect.top && branchRect.top < svgRect.bottom
      const badgeText = branch.querySelector('.smm-expand-btn-text')?.textContent?.trim() || ''
      const badgeCorrect = !Number.isInteger(spec.collapsedChildCount) || Number(badgeText) === spec.collapsedChildCount
      const hasRenderedChildren = nodes.some((element) => element.getAttribute('data-parent-uid') === branch.getAttribute('data-node-uid'))
      return rootCentered && branchVisible && badgeCorrect && !hasRenderedChildren
    }, expected, { timeout: timeoutMs })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    result.after = await inspectExpectedStructure(page, expected)
    result.completedAt = new Date().toISOString()
    result.status = 'measured'
    return result
  } catch (error) {
    result.after = await inspectExpectedStructure(page, expected).catch(() => null)
    result.completedAt = new Date().toISOString()
    result.status = 'failed'
    result.error = { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 500) }
    error.viewNormalization = result
    throw error
  }
}

async function findBranchNode(page, branchText, branchUid = null) {
  const expectedText = normalizeBranchText(branchText)
  const matches = await page.locator('.smm-node').evaluateAll((elements, criteria) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    return elements
      .map((element, index) => ({
        index,
        uid: element.getAttribute('data-node-uid'),
        text: normalize(element.innerText || element.textContent),
        ownText: normalize(element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText || element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent || '')
      }))
      .filter((item) => (!criteria.branchUid || item.uid === criteria.branchUid) &&
        (!criteria.branchText || item.ownText === criteria.branchText || item.text === criteria.branchText))
  }, { branchUid, branchText: expectedText })

  if (matches.length === 0) throw new Error(`branch not found: ${branchUid || expectedText}`)
  if (matches.length > 1) throw new Error(`branch selector is ambiguous: ${branchUid || expectedText} (${matches.length} matches)`)

  const node = page.locator('.smm-node').nth(matches[0].index)
  const button = node.locator('.smm-expand-btn')
  if (await button.count() !== 1) {
    throw new Error(`expected one .smm-expand-btn inside branch ${expectedText}`)
  }
  return button
}

async function waitForBranchDomState(page, {
  branchUid = null,
  branchText = null,
  rootUid = null,
  expanded,
  expectedDirectChildren = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const result = await page.evaluate(async (spec) => {
    const started = performance.now()
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const findBranch = () => Array.from(document.querySelectorAll('.smm-node')).find((element) =>
      spec.branchUid
        ? element.getAttribute('data-node-uid') === spec.branchUid
        : normalize(element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText ||
          element.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent) === spec.branchText) || null
    const rectOf = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10)
    }
    let previousSignature = null
    let stableFrames = 0
    let last = null
    while (performance.now() - started < spec.timeoutMs) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const branch = findBranch()
      if (!branch) {
        previousSignature = null
        stableFrames = 0
        continue
      }
      const uid = branch.getAttribute('data-node-uid')
      const nodes = Array.from(document.querySelectorAll('.smm-node'))
      const children = nodes.filter((element) => element.getAttribute('data-parent-uid') === uid)
      const badgeText = branch.querySelector('.smm-expand-btn-text')?.textContent?.trim() || ''
      const badgeCount = /^\d+$/.test(badgeText) ? Number(badgeText) : null
      const targetStateReached = spec.expanded
        ? children.length > 0
        : children.length === 0 && (!Number.isInteger(spec.expectedDirectChildren) || badgeCount === spec.expectedDirectChildren)
      const root = spec.rootUid
        ? nodes.find((element) => element.getAttribute('data-node-uid') === spec.rootUid)
        : null
      const signature = JSON.stringify({
        directChildCount: children.length,
        branchTransform: branch.getAttribute('transform'),
        branchRect: rectOf(branch),
        representativeChildRect: rectOf(children[0]),
        rootRect: rectOf(root)
      })
      if (targetStateReached && signature === previousSignature) stableFrames += 1
      else stableFrames = targetStateReached ? 1 : 0
      previousSignature = targetStateReached ? signature : null
      last = {
        directChildCount: children.length,
        badgeCount,
        globalDomNodeCount: nodes.length,
        branchRect: rectOf(branch),
        representativeChildRect: rectOf(children[0]),
        rootRect: rectOf(root),
        stableFrames,
        durationMs: performance.now() - started
      }
      if (stableFrames >= 3) return { status: 'measured', ...last }
    }
    return { status: 'timeout', ...last, timeoutMs: spec.timeoutMs }
  }, {
    branchUid,
    branchText: normalizeBranchText(branchText),
    rootUid,
    expanded,
    expectedDirectChildren,
    timeoutMs
  })

  if (result?.status !== 'measured') {
    const stateName = expanded ? 'expanded' : 'collapsed'
    const error = new Error(`branch-${stateName}-state-timeout`)
    error.observedState = result || null
    throw error
  }
  return result
}

function summarizeInteraction(samples) {
  const expanded = samples.map((sample) => sample.expand?.durationMs).filter(Number.isFinite)
  const collapsed = samples.map((sample) => sample.collapse?.durationMs).filter(Number.isFinite)
  return {
    clients: samples.length,
    completed: samples.filter((sample) => sample.status === 'measured').length,
    expand: summarize(expanded),
    collapse: summarize(collapsed),
    samples
  }
}

/**
 * Open 13 real Chromium clients against the isolated two-instance test stack.
 * The room must already be seeded by the caller; this function never creates or
 * overwrites test data.
 */
export async function openBrowserClients({ appA, appB, roomKey, runId, outputDir, expectedVisibleNodes = null, expectedStructure = null, pageLoadConcurrency = 4, onProgress = null }) {
  if (!appA || !appB || !roomKey || !runId || !outputDir) {
    throw new TypeError('appA, appB, roomKey, runId and outputDir are required')
  }
  if (!Number.isInteger(pageLoadConcurrency) || pageLoadConcurrency < 1 || pageLoadConcurrency > CLIENT_COUNT) {
    throw new TypeError(`pageLoadConcurrency must be an integer from 1 to ${CLIENT_COUNT}`)
  }
  if (expectedStructure && (!expectedStructure.rootUid && !expectedStructure.rootText ||
      !expectedStructure.branchUid && !expectedStructure.branchText ||
      (expectedStructure.collapsedChildCount != null && (!Number.isInteger(expectedStructure.collapsedChildCount) || expectedStructure.collapsedChildCount < 0)))) {
    throw new TypeError('expectedStructure requires rootUid/rootText, branchUid/branchText and an optional non-negative collapsedChildCount')
  }

  const timeoutMs = Number(process.env.MCP_BASELINE_BROWSER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  const structureTimeoutMs = Math.min(timeoutMs, Number(process.env.MCP_BASELINE_STRUCTURE_TIMEOUT_MS || 30_000))
  const browserChannel = process.env.MCP_BASELINE_BROWSER_CHANNEL || 'chrome'
  const browser = await chromium.launch({ channel: browserChannel, headless: true })
  await mkdir(outputDir, { recursive: true })

  const loadMetrics = {
    runId,
    roomKey,
    clientCountExpected: CLIENT_COUNT,
    pageLoadConcurrency,
    pageLoadWaveCount: Math.ceil(CLIENT_COUNT / pageLoadConcurrency),
    pageLoadSemantics: 'Clients are initialized in bounded waves; all 13 must be live and structure-ready before measured writes or interactions begin. LCP is per client and is not a simultaneous 13-client cold-start measurement.',
    clientCountOpened: 0,
    startedAt: new Date().toISOString(),
    clients: [],
    summary: null
  }
  const websocketMetrics = {
    runId,
    roomKey,
    clients: [],
    totals: null,
    semantics: 'Counts browser WebSocket frames and recognized Socket.IO event names; it does not inspect or persist frame payloads.'
  }
  const state = { browser, clients: [], loadMetrics, websocketMetrics }
  const internal = { outputDir, timeoutMs, closed: false }
  sessions.set(state, internal)

  try {
    const navigationStarted = now()
    const reportProgress = async (entry) => {
      if (typeof onProgress !== 'function') return
      try { await onProgress({ at: new Date().toISOString(), runId, roomKey, ...entry }) } catch (_) {}
    }
    const openClient = async (index) => {
      const pageLoadWave = Math.floor(index / pageLoadConcurrency) + 1
      const clientId = `browser-${String(index + 1).padStart(2, '0')}`
      const instance = index < APP_A_CLIENTS ? 'appA' : 'appB'
      const baseUrl = instance === 'appA' ? appA : appB
      await reportProgress({ phase: 'client-open-start', clientId, instance, pageLoadWave })
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
      await context.addInitScript(browserInstrumentation)
      const page = await context.newPage()
      const websocketCounters = {
        opened: 0,
        successfulOpens: 0,
        closed: 0,
        framesSent: 0,
        framesReceived: 0,
        opEventsReceived: 0,
        gapEvents: 0,
        resnapshotEvents: 0,
        retryEvents: 0,
        reconnects: 0
      }
      const cdp = await context.newCDPSession(page)
      await cdp.send('Network.enable')
      attachSocketProbe(cdp, websocketCounters)
      const client = {
        id: clientId,
        instance,
        baseUrl,
        roomKey,
        context,
        page,
        cdp,
        websocketCounters,
        navigation: { status: 'pending', startedAt: null, completedAt: null, durationMs: null, httpStatus: null },
        pageErrors: [],
        interactions: []
      }
      state.clients[index] = client

      const loadRecord = {
        clientId,
        instance,
        pageLoadWave,
        pageLoadConcurrency,
        status: 'pending',
        navigationMs: null,
        domContentLoadedMs: null,
        firstNodeMs: null,
        lcpStatus: 'pending',
        lcpMs: null,
        lcpEntries: null,
        collabHealthProbe: { requests: [], responses: [], failures: [] },
        collabHealthFailureScreen: null,
        navigationAttempts: [],
        longTasksSupported: null,
        longTaskCount: null,
        longTaskTotalMs: null,
        longTaskMaxMs: null,
        visibleNodeCount: null,
        collabV2ReadyStatus: 'pending',
        saveStateStatus: 'pending',
        saveStateAtEpochMs: null,
        onlinePresenceText: null,
        collabState: null,
        structureReadyStatus: expectedStructure
          ? 'pending'
          : (expectedVisibleNodes == null ? 'stable-count-required' : 'pending'),
        viewNormalizationStatus: expectedStructure ? 'pending' : 'not-requested',
        viewNormalization: null,
        structureReadiness: null,
        httpStatus: null,
        errorType: null,
        errorMessage: null
      }
      const socketRecord = {
        clientId,
        instance,
        status: 'pending',
        opened: null,
        successfulOpens: null,
        closed: null,
        framesSent: null,
        framesReceived: null,
        opEventsReceived: null,
        gapEvents: null,
        resnapshotEvents: null,
        retryEvents: null,
        reconnects: null,
        instrumentationSupported: null
      }
      loadMetrics.clients[index] = loadRecord
      websocketMetrics.clients[index] = socketRecord

      page.on('request', (request) => {
        try {
          const url = new URL(request.url())
          if (url.pathname === '/api/health') {
            loadRecord.collabHealthProbe.requests.push({ method: request.method(), startedAtEpochMs: Date.now() })
          }
        } catch (_) {}
      })
      page.on('response', (response) => {
        try {
          const url = new URL(response.url())
          if (url.pathname === '/api/health') {
            loadRecord.collabHealthProbe.responses.push({
              status: response.status(),
              statusText: response.statusText(),
              ok: response.ok(),
              receivedAtEpochMs: Date.now(),
              fromServiceWorker: response.fromServiceWorker()
            })
          }
        } catch (_) {}
      })
      page.on('requestfailed', (request) => {
        try {
          const url = new URL(request.url())
          if (url.pathname === '/api/health') {
            loadRecord.collabHealthProbe.failures.push({
              method: request.method(),
              failedAtEpochMs: Date.now(),
              errorText: request.failure()?.errorText || null
            })
          }
        } catch (_) {}
      })

      page.on('pageerror', (error) => client.pageErrors.push({ type: 'pageerror', name: error.name || 'Error' }))
      page.on('console', (message) => {
        if (message.type() === 'error') client.pageErrors.push({ type: 'console', name: 'ConsoleError' })
      })

      const started = now()
      client.navigation.startedAt = new Date().toISOString()
      try {
        const targetUrl = `${baseUrl.replace(/\/$/, '')}/?room=${encodeURIComponent(roomKey)}`
        let mainResponse = null
        let recoveredHealthFailure = false
        for (let attempt = 0; attempt <= 2; attempt++) {
          const attemptStartedAtEpochMs = Date.now()
          const attemptStarted = now()
          const probeStart = {
            requests: loadRecord.collabHealthProbe.requests.length,
            responses: loadRecord.collabHealthProbe.responses.length,
            failures: loadRecord.collabHealthProbe.failures.length
          }
          const navigationAttempt = {
            attempt: attempt + 1,
            action: attempt === 0 ? 'goto' : 'reload',
            startedAtEpochMs: attemptStartedAtEpochMs,
            httpStatus: null,
            terminalStatus: 'pending',
            errorText: null,
            healthProbe: null,
            lcp: null
          }
          let navigationError = null
          try {
            mainResponse = attempt === 0
              ? await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
              : await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
            navigationAttempt.httpStatus = mainResponse?.status() ?? null
            client.navigation.httpStatus = navigationAttempt.httpStatus
            loadRecord.httpStatus = navigationAttempt.httpStatus
            if (attempt === 0) loadRecord.domContentLoadedMs = now() - started

            await page.waitForFunction(() => {
              const text = document.body?.innerText || ''
              return document.querySelectorAll('.smm-node').length > 0 || text.includes('SERVICE_UNAVAILABLE')
            }, null, { timeout: timeoutMs })
          } catch (error) {
            navigationError = error
            navigationAttempt.errorText = String(error?.message || error).replaceAll(roomKey, '<roomKey>').slice(0, 500)
          }

          const pageState = await page.evaluate((spec) => {
            const text = document.body?.innerText || ''
            const nodes = Array.from(document.querySelectorAll('.smm-node'))
            const ownText = (element) => String(element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText ||
              element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent || '').replace(/\s+/g, ' ').trim()
            const find = (uid, value) => nodes.find((element) => {
              if (uid && element.getAttribute('data-node-uid') !== uid) return false
              return !value || ownText(element) === value
            }) || null
            const root = find(spec?.rootUid, spec?.rootText)
            const branch = find(spec?.branchUid, spec?.branchText)
            const svg = root?.closest('svg') || branch?.closest('svg') || null
            const rectSnapshot = (element) => {
              const rect = element?.getBoundingClientRect()
              return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
            }
            return {
              hasNodes: nodes.length > 0,
              healthFailureScreen: text.includes('SERVICE_UNAVAILABLE')
                ? text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 8)
                : null,
              perf: window.__mcpBaselinePerf || null,
              geometry: {
                rootPresent: Boolean(root),
                rootTransform: root?.getAttribute('transform') || null,
                rootBoundingBox: rectSnapshot(root),
                branchPresent: Boolean(branch),
                branchTransform: branch?.getAttribute('transform') || null,
                branchBoundingBox: rectSnapshot(branch),
                svgBoundingBox: rectSnapshot(svg),
                viewport: { width: window.innerWidth, height: window.innerHeight }
              }
            }
          }, expectedStructure).catch(() => ({ hasNodes: false, healthFailureScreen: null, perf: null, geometry: null }))
          const requestFailed = loadRecord.collabHealthProbe.failures.slice(probeStart.failures)
          const healthResponses = loadRecord.collabHealthProbe.responses.slice(probeStart.responses)
          navigationAttempt.healthProbe = {
            requests: loadRecord.collabHealthProbe.requests.slice(probeStart.requests),
            responses: healthResponses,
            failures: requestFailed
          }
          navigationAttempt.completedAtEpochMs = Date.now()
          navigationAttempt.durationMs = now() - attemptStarted
          navigationAttempt.lcp = pageState.perf?.lcpMs ?? null
          navigationAttempt.geometry = pageState.geometry
          navigationAttempt.lcpStatus = pageState.perf?.lcpMs == null
            ? (pageState.perf?.lcpUnsupported ? 'unsupported' : 'no-entry')
            : 'measured'

          if (pageState.healthFailureScreen) {
            navigationAttempt.terminalStatus = 'service_unavailable'
            navigationAttempt.healthFailureScreen = pageState.healthFailureScreen
            loadRecord.collabHealthFailureScreen = pageState.healthFailureScreen
            const isHealthFailure = requestFailed.length > 0 || healthResponses.some((item) => item.status >= 500) ||
              pageState.healthFailureScreen.some((line) => line.includes('SERVICE_UNAVAILABLE'))
            if (isHealthFailure && attempt < 2) {
              navigationAttempt.retryReason = 'explicit-collab-health-service-unavailable'
              loadRecord.navigationAttempts.push(navigationAttempt)
              await page.waitForTimeout(300)
              const perf = await page.evaluate(() => window.__mcpBaselinePerf || null).catch(() => null)
              navigationAttempt.lcp = perf?.lcpMs ?? navigationAttempt.lcp
              navigationAttempt.lcpStatus = perf?.lcpMs == null
                ? (perf?.lcpUnsupported ? 'unsupported' : navigationAttempt.lcpStatus)
                : 'measured'
              navigationAttempt.retryActionAtEpochMs = Date.now()
              recoveredHealthFailure = true
              continue
            }
            loadRecord.navigationAttempts.push(navigationAttempt)
            const error = new Error('collab-health-service-unavailable')
            error.collabHealthFailureScreen = pageState.healthFailureScreen
            error.healthRetryExhausted = isHealthFailure && attempt >= 2
            throw error
          }

          if (pageState.hasNodes) {
            navigationAttempt.terminalStatus = 'editor-ready'
            navigationAttempt.recoveredPreviousHealthFailure = recoveredHealthFailure
            loadRecord.navigationAttempts.push(navigationAttempt)
            break
          }

          navigationAttempt.terminalStatus = navigationError ? 'navigation-error' : 'editor-timeout'
          loadRecord.navigationAttempts.push(navigationAttempt)
          throw navigationError || new Error('editor did not reach a ready or explicit health-failure state')
        }

        await waitForStableNodeCount(page, timeoutMs)
        loadRecord.firstNodeMs = now() - started
        await page.waitForTimeout(500)

        const browserMetrics = await page.evaluate(() => ({
          perf: window.__mcpBaselinePerf || null
        }))
        if (browserMetrics.perf) {
          const perf = browserMetrics.perf
          loadRecord.lcpStatus = perf.lcpMs === null
            ? (perf.lcpUnsupported ? 'unsupported' : 'no-entry')
            : 'measured'
          loadRecord.lcpMs = perf.lcpMs
          loadRecord.lcpEntries = perf.lcpEntries
          loadRecord.longTasksSupported = perf.longTasksSupported
          loadRecord.longTaskCount = perf.longTaskCount
          loadRecord.longTaskTotalMs = perf.longTaskTotalMs
          loadRecord.longTaskMaxMs = perf.longTaskMaxMs
          socketRecord.status = 'measured'
          Object.assign(socketRecord, socketCounterSnapshot(client) || {})
          socketRecord.instrumentationSupported = true
        } else {
          loadRecord.lcpStatus = 'instrumentation-unavailable'
          socketRecord.status = 'measured'
          Object.assign(socketRecord, socketCounterSnapshot(client) || {})
          socketRecord.instrumentationSupported = true
        }

        try {
          await page.waitForFunction(() => {
            const state = window.__COLLAB_V2_STATE__ || {}
            const apply = window.__COLLAB_V2_APPLY__ || {}
            const text = document.body?.innerText || ''
            return apply.useV2 === true && state.status === 'live' && Boolean(state.socketId) &&
              /\d+\s*人在线/.test(text) && text.includes('已保存')
          }, null, { timeout: timeoutMs })
          loadRecord.collabV2ReadyStatus = 'measured'
          loadRecord.onlinePresenceText = await page.locator('body').innerText().then((text) => text.match(/\d+\s*人在线/)?.[0] ?? null)
          loadRecord.collabState = await collabStateSnapshot(page)
          client.collabStateBaseline = loadRecord.collabState
        } catch (error) {
          loadRecord.collabV2ReadyStatus = 'timeout'
          loadRecord.collabV2ReadyErrorType = error?.name || 'Error'
        }

        if (expectedStructure) {
          loadRecord.viewNormalization = await normalizeRootView(page, expectedStructure, structureTimeoutMs)
          loadRecord.viewNormalizationStatus = 'measured'
          try {
            await page.waitForFunction((spec) => {
              const nodes = Array.from(document.querySelectorAll('.smm-node'))
              const ownText = (element) => String(element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.innerText ||
                element?.querySelector('.smm-richtext-node-wrap, .smm-node-text')?.textContent || '').replace(/\s+/g, ' ').trim()
              const find = (uid, text) => nodes.find((element) => {
                if (uid && element.getAttribute('data-node-uid') !== uid) return false
                return !text || ownText(element) === text
              }) || null
              const root = find(spec.rootUid, spec.rootText)
              const branch = find(spec.branchUid, spec.branchText)
              if (!root || !branch || !branch.querySelector('.smm-expand-btn')) return false
              if (spec.rootUid && branch.getAttribute('data-parent-uid') !== spec.rootUid) return false
              const badgeText = branch.querySelector('.smm-expand-btn-text')?.textContent?.trim() || ''
              if (Number.isInteger(spec.collapsedChildCount) && Number(badgeText) !== spec.collapsedChildCount) return false
              const branchUid = branch.getAttribute('data-node-uid')
              return !nodes.some((element) => element.getAttribute('data-parent-uid') === branchUid)
            }, expectedStructure, { timeout: structureTimeoutMs })
            loadRecord.structureReadiness = await inspectExpectedStructure(page, expectedStructure)
            loadRecord.structureReadyStatus = 'measured'
          } catch (error) {
            loadRecord.structureReadiness = await inspectExpectedStructure(page, expectedStructure).catch(() => null)
            loadRecord.structureReadyStatus = 'timeout-or-mismatch'
            loadRecord.structureReadyErrorType = error?.name || 'Error'
            loadRecord.structureReadyTimeoutMs = structureTimeoutMs
            try {
              const screenshotPath = join(outputDir, `${runId}-${clientId}-structure-failed.png`)
              await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5000 })
              loadRecord.structureFailureScreenshot = screenshotPath
            } catch (screenshotError) {
              loadRecord.structureFailureScreenshotErrorType = screenshotError?.name || 'Error'
            }
          }
        } else if (Number.isInteger(expectedVisibleNodes) && expectedVisibleNodes > 0) {
          try {
            await page.waitForFunction((count) => document.querySelectorAll('.smm-node').length === count, expectedVisibleNodes, { timeout: timeoutMs })
            loadRecord.structureReadyStatus = 'measured'
          } catch (error) {
            loadRecord.structureReadyStatus = 'timeout-or-mismatch'
            loadRecord.structureReadyErrorType = error?.name || 'Error'
          }
        }
        try {
          await page.waitForFunction(() => {
            const text = document.body?.innerText || ''
            const state = window.__COLLAB_V2_STATE__ || {}
            return state.status === 'live' && text.includes('已保存') && !/保存中|保存失败|未保存/.test(text)
          }, null, { timeout: timeoutMs })
          loadRecord.saveStateStatus = 'measured'
          loadRecord.saveStateAtEpochMs = Date.now()
        } catch (error) {
          loadRecord.saveStateStatus = 'timeout'
          loadRecord.saveStateErrorType = error?.name || 'Error'
          throw new Error(`client save state not settled: ${error?.name || 'Error'}`)
        }
        loadRecord.visibleNodeCount = await waitForStableNodeCount(page, timeoutMs)

        client.navigation.status = 'loaded'
        client.navigation.completedAt = new Date().toISOString()
        client.navigation.durationMs = now() - started
        loadRecord.navigationMs = client.navigation.durationMs
        loadRecord.status = 'measured'
      } catch (error) {
        const errorName = error?.name || 'Error'
        const errorMessage = String(error?.message || '').replaceAll(roomKey, '<roomKey>').slice(0, 300)
        client.navigation.status = 'failed'
        client.navigation.completedAt = new Date().toISOString()
        client.navigation.durationMs = now() - started
        client.navigation.errorType = errorName
        loadRecord.status = 'failed'
        loadRecord.errorType = errorName
        loadRecord.errorMessage = errorMessage || null
        if (error?.collabHealthFailureScreen) loadRecord.collabHealthFailureScreen = error.collabHealthFailureScreen
        if (loadRecord.visibleNodeCount > 0 && loadRecord.collabV2ReadyStatus === 'pending') {
          loadRecord.collabV2ReadyStatus = 'timeout-or-failed'
        }
        if (loadRecord.viewNormalizationStatus === 'pending') {
          loadRecord.viewNormalization = error?.viewNormalization || null
          loadRecord.viewNormalizationStatus = error?.viewNormalization?.status || 'failed'
        }
        loadRecord.lcpStatus = 'not-measured-navigation-failed'
        loadRecord.lcpMs = null
        loadRecord.lcpEntries = null
        if (!loadRecord.longTasksSupported) {
          loadRecord.longTaskCount = null
          loadRecord.longTaskTotalMs = null
          loadRecord.longTaskMaxMs = null
        }
        loadRecord.navigationMs = client.navigation.durationMs
        socketRecord.status = 'not-measured'
        socketRecord.instrumentationSupported = false
        try {
          const screenshotPath = join(outputDir, `${runId}-${clientId}-open-failed.png`)
          await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5000 })
          loadRecord.failureScreenshot = screenshotPath
        } catch (_) {}
      }
      await reportProgress({
        phase: 'client-open-end', clientId, instance, pageLoadWave,
        status: client.navigation.status,
        errorType: client.navigation.errorType || null,
        durationMs: client.navigation.durationMs,
        collabV2ReadyStatus: loadRecord.collabV2ReadyStatus,
        structureReadyStatus: loadRecord.structureReadyStatus,
        saveStateStatus: loadRecord.saveStateStatus,
        geometry: loadRecord.viewNormalization?.after || loadRecord.structureReadiness || null
      })
    }

    for (let offset = 0; offset < CLIENT_COUNT; offset += pageLoadConcurrency) {
      const batchSize = Math.min(pageLoadConcurrency, CLIENT_COUNT - offset)
      const pageLoadWave = Math.floor(offset / pageLoadConcurrency) + 1
      await reportProgress({ phase: 'page-wave-start', pageLoadWave, firstClientIndex: offset + 1, clientCount: batchSize })
      await Promise.all(Array.from({ length: batchSize }, (_, batchIndex) => openClient(offset + batchIndex)))
      await reportProgress({ phase: 'page-wave-end', pageLoadWave, completedClients: state.clients.filter(Boolean).length })
    }

    loadMetrics.clientCountOpened = state.clients.filter(Boolean).length
    const totalDurationMs = now() - navigationStarted
    const navigationSamples = loadMetrics.clients.map((item) => item.navigationMs)
    const lcpSamples = loadMetrics.clients.map((item) => item.lcpMs)
    loadMetrics.summary = {
      totalDurationMs,
      navigation: summarize(navigationSamples),
      lcp: summarize(lcpSamples),
      successfulClients: loadMetrics.clients.filter((item) => item.status === 'measured').length,
      pageLoadConcurrency,
      pageLoadWaveCount: Math.ceil(CLIENT_COUNT / pageLoadConcurrency),
      pageLoadWaves: [...new Set(loadMetrics.clients.map((item) => item.pageLoadWave))],
      collabV2ReadyClients: loadMetrics.clients.filter((item) => item.collabV2ReadyStatus === 'measured').length,
      collabV2ReadinessFailures: loadMetrics.clients.filter((item) => item.collabV2ReadyStatus !== 'measured').map((item) => ({ clientId: item.clientId, status: item.collabV2ReadyStatus, errorType: item.collabV2ReadyErrorType || null })),
      savedClients: loadMetrics.clients.filter((item) => item.saveStateStatus === 'measured').length,
      saveReadinessFailures: loadMetrics.clients.filter((item) => item.saveStateStatus !== 'measured').map((item) => ({ clientId: item.clientId, status: item.saveStateStatus, errorType: item.saveStateErrorType || null })),
      healthRetryClients: loadMetrics.clients.filter((item) => (item.navigationAttempts || []).some((attempt) => attempt.retryReason === 'explicit-collab-health-service-unavailable')).map((item) => ({
        clientId: item.clientId,
        retryAttempts: (item.navigationAttempts || []).filter((attempt) => attempt.retryReason).length,
        attempts: item.navigationAttempts
      })),
      healthRetryCount: loadMetrics.clients.reduce((count, item) => count + (item.navigationAttempts || []).filter((attempt) => attempt.retryReason).length, 0),
      expectedVisibleNodes,
      expectedStructure: expectedStructure || null,
      visibleNodeCountSemantics: expectedStructure ? 'informational-only; SVG renderer may cull off-viewport nodes' : 'exact-count-when-requested',
      structureReadyClients: expectedStructure || expectedVisibleNodes != null
        ? loadMetrics.clients.filter((item) => item.structureReadyStatus === 'measured').length
        : null,
      viewNormalizedClients: expectedStructure
        ? loadMetrics.clients.filter((item) => item.viewNormalizationStatus === 'measured').length
        : null,
      viewNormalizationFailures: expectedStructure
        ? loadMetrics.clients.filter((item) => item.viewNormalizationStatus !== 'measured').map((item) => ({
          clientId: item.clientId,
          status: item.viewNormalizationStatus,
          result: item.viewNormalization
        }))
        : [],
      structureReadinessFailures: expectedStructure || expectedVisibleNodes != null
        ? loadMetrics.clients.filter((item) => item.structureReadyStatus !== 'measured').map((item) => ({
          clientId: item.clientId,
          status: item.structureReadyStatus,
          errorType: item.structureReadyErrorType || null,
          actualVisibleNodeCount: item.visibleNodeCount,
          observedStructure: item.structureReadiness
        }))
        : [],
      failedClients: loadMetrics.clients.filter((item) => item.status !== 'measured').map((item) => ({ clientId: item.clientId, status: item.status, errorType: item.errorType, errorMessage: item.errorMessage }))
    }

    const totals = ['opened', 'successfulOpens', 'closed', 'framesSent', 'framesReceived', 'opEventsReceived', 'gapEvents', 'resnapshotEvents', 'retryEvents', 'reconnects']
    websocketMetrics.totals = Object.fromEntries(totals.map((key) => [key, websocketMetrics.clients.reduce((sum, item) => sum + (Number.isFinite(item[key]) ? item[key] : 0), 0)]))
    websocketMetrics.instrumentedClients = websocketMetrics.clients.filter((item) => item.instrumentationSupported).length
    return state
  } catch (error) {
    await browser.close().catch(() => {})
    internal.closed = true
    throw error
  }
}

/** Measure expand/collapse by selected-branch DOM state, not total SVG node count. */
export async function measureExpandCollapse(clients, {
  rootText = null,
  rootUid = null,
  branchText,
  branchUid = null,
  expectedDirectChildren = null,
  // Kept as accepted legacy metadata only; total .smm-node counts are not assertions
  // because the canvas renderer culls nodes outside the viewport.
  expectedExpandedNodes = null,
  expectedCollapsedNodes = null,
  rounds = 3,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onCheckpoint = null
} = {}) {
  if (!Array.isArray(clients) || clients.length === 0) throw new TypeError('clients must be a non-empty array')
  if ((!branchText && !branchUid) || !Number.isInteger(rounds) || rounds < 1 ||
      (expectedDirectChildren !== null && (!Number.isInteger(expectedDirectChildren) || expectedDirectChildren < 0))) {
    throw new TypeError('branchText or branchUid, optional non-negative expectedDirectChildren, and positive rounds are required')
  }

  const structureSpec = { rootText, rootUid, branchText, branchUid }
  const samples = await Promise.all(clients.map(async (client) => {
    const checkpoint = async (phase, extra = {}) => {
      if (typeof onCheckpoint !== 'function') return
      try {
        await onCheckpoint({ phase, clientId: client.id, instance: client.instance, at: new Date().toISOString(), page: client.page, ...extra })
      } catch (_) {}
    }
    const sample = {
      clientId: client.id,
      instance: client.instance,
      status: 'pending',
      rounds: [],
      errorType: null,
      viewportCullingAware: true,
      expectedDirectChildren,
      legacyGlobalCountExpectationsIgnored: Number.isInteger(expectedExpandedNodes) || Number.isInteger(expectedCollapsedNodes)
    }
    let currentStage = 'client-start'
    try {
      await checkpoint('client-start')
      if (client.navigation.status !== 'loaded') throw new Error('client-not-loaded')
      let initial = await inspectExpectedStructure(client.page, structureSpec)
      if (rootText && (!initial.rootPresent || initial.rootText !== normalizeBranchText(rootText))) throw new Error('root-structure-mismatch')
      if (rootUid && initial.rootUid !== rootUid) throw new Error('root-structure-mismatch')
      if (!initial.branchPresent) throw new Error('branch-not-present')
      if (branchUid && initial.branchUid !== branchUid) throw new Error('branch-identity-mismatch')
      if (rootUid && initial.branchParentUid !== rootUid) throw new Error('branch-parent-mismatch')
      if (expectedDirectChildren !== null && initial.branchBadgeCount !== expectedDirectChildren) throw new Error('branch-child-count-mismatch')
      if (initial.branchDirectChildDomCount !== 0) throw new Error('branch-not-collapsed')

      for (let round = 0; round < rounds; round += 1) {
        currentStage = `round-${round + 1}-inspect-collapsed`
        initial = await inspectExpectedStructure(client.page, structureSpec)
        if (initial.branchDirectChildDomCount !== 0) throw new Error('branch-not-collapsed')
        if (expectedDirectChildren !== null && initial.branchBadgeCount !== expectedDirectChildren) throw new Error('branch-child-count-mismatch')
        const roundSample = {
          round: round + 1,
          condition: round === 0 ? 'cold-first-interaction-on-fresh-context' : 'warm-repeat-on-same-page',
          globalDomNodeCountBefore: initial.globalDomNodeCount,
          globalDomNodeCountAfterExpand: null,
          globalDomNodeCountAfterCollapse: null,
          branchDirectChildDomCountAfterExpand: null,
          branchBadgeCountBefore: initial.branchBadgeCount,
          branchBadgeCountAfterCollapse: null,
          branchIntersectsViewport: initial.branchIntersectsViewport,
          expand: { status: 'pending', durationMs: null },
          collapse: { status: 'pending', durationMs: null }
        }

        const expandButton = await findBranchNode(client.page, branchText, branchUid)
        currentStage = `round-${round + 1}-expand`
        await checkpoint('expand-start', { round: round + 1, structure: initial })
        const expandStarted = now()
        await expandButton.click({ timeout: timeoutMs })
        const expandedLayout = await waitForBranchDomState(client.page, {
          branchUid,
          branchText,
          rootUid,
          expanded: true,
          expectedDirectChildren,
          timeoutMs
        })
        const expandedState = await inspectExpectedStructure(client.page, structureSpec)
        roundSample.globalDomNodeCountAfterExpand = expandedState.globalDomNodeCount
        roundSample.branchDirectChildDomCountAfterExpand = expandedState.branchDirectChildDomCount
        roundSample.expandedLayout = expandedLayout
        roundSample.expand = { status: 'measured', durationMs: now() - expandStarted }
        await checkpoint('expand-end', { round: round + 1, durationMs: roundSample.expand.durationMs, layout: expandedLayout, structure: expandedState })

        currentStage = `round-${round + 1}-collapse`
        const collapseButton = await findBranchNode(client.page, branchText, branchUid)
        await checkpoint('collapse-start', { round: round + 1, structure: expandedState })
        const collapseStarted = now()
        await collapseButton.click({ timeout: timeoutMs })
        const collapsedLayout = await waitForBranchDomState(client.page, {
          branchUid,
          branchText,
          rootUid,
          expanded: false,
          expectedDirectChildren,
          timeoutMs
        })
        const collapsedState = await inspectExpectedStructure(client.page, structureSpec)
        roundSample.globalDomNodeCountAfterCollapse = collapsedState.globalDomNodeCount
        roundSample.branchBadgeCountAfterCollapse = collapsedState.branchBadgeCount
        roundSample.branchDirectChildDomCountAfterCollapse = collapsedState.branchDirectChildDomCount
        roundSample.collapsedLayout = collapsedLayout
        roundSample.collapse = { status: 'measured', durationMs: now() - collapseStarted }
        await checkpoint('collapse-end', { round: round + 1, durationMs: roundSample.collapse.durationMs, layout: collapsedLayout, structure: collapsedState })
        sample.rounds.push(roundSample)
      }
      sample.status = 'measured'
      sample.finalStructure = await inspectExpectedStructure(client.page, structureSpec)
      await checkpoint('client-end', { status: sample.status, roundsCompleted: sample.rounds.length, finalStructure: sample.finalStructure })
    } catch (error) {
      sample.status = 'failed'
      sample.errorType = [
        'client-not-loaded', 'root-structure-mismatch', 'branch-not-present',
        'branch-identity-mismatch', 'branch-parent-mismatch',
        'branch-child-count-mismatch', 'branch-not-collapsed'
      ].includes(error?.message) ? error.message : (error?.name || 'Error')
      sample.errorMessage = String(error?.message || '').replaceAll(String(branchText || branchUid), '<branch>').slice(0, 300) || null
      sample.observedStructure = await inspectExpectedStructure(client.page, structureSpec).catch(() => null)
      sample.failedStage = currentStage
      sample.failedAtRound = sample.rounds.length + 1
      sample.rounds.push({
        round: sample.failedAtRound,
        condition: sample.failedAtRound === 1 ? 'cold-first-interaction-on-fresh-context' : 'warm-repeat-on-same-page',
        expand: { status: 'not-measured', durationMs: null },
        collapse: { status: 'not-measured', durationMs: null },
        errorType: sample.errorType
      })
      const clickTarget = await client.page.evaluate((uid) => {
        const node = Array.from(document.querySelectorAll('.smm-node')).find(item => item.getAttribute('data-node-uid') === uid)
        const button = node?.querySelector('.smm-expand-btn')
        const rect = button?.getBoundingClientRect()
        const x = rect ? rect.left + rect.width / 2 : null
        const y = rect ? rect.top + rect.height / 2 : null
        const hit = x !== null ? document.elementFromPoint(x, y) : null
        return {
          branchRect: node?.getBoundingClientRect().toJSON() || null,
          buttonRect: rect?.toJSON() || null,
          buttonVisibility: button ? getComputedStyle(button).visibility : null,
          buttonDisplay: button ? getComputedStyle(button).display : null,
          buttonPointerEvents: button ? getComputedStyle(button).pointerEvents : null,
          centerHitTag: hit?.tagName || null,
          centerHitClass: hit?.getAttribute('class') || null,
          centerHitUid: hit?.closest('.smm-node')?.getAttribute('data-node-uid') || null,
          directChildDomCount: node ? document.querySelectorAll(`.smm-node[data-parent-uid="${uid}"]`).length : null
        }
      }, branchUid).catch(() => null)
      sample.clickTargetAtFailure = clickTarget
      await checkpoint('interaction-failure', { stage: currentStage, errorType: sample.errorType, errorMessage: sample.errorMessage, structure: sample.observedStructure, clickTargetAtFailure: clickTarget, round: sample.failedAtRound })
    }
    client.interactions.push(sample)
    return sample
  }))

  const measuredRounds = samples.flatMap((sample) => sample.rounds.filter((round) => round.expand?.status === 'measured' && round.collapse?.status === 'measured'))
  const perClient = samples.map((sample) => ({
    clientId: sample.clientId,
    instance: sample.instance,
    status: sample.status,
    expand: summarize(sample.rounds.map((round) => round.expand?.durationMs)),
    collapse: summarize(sample.rounds.map((round) => round.collapse?.durationMs)),
    rounds: sample.rounds,
    errorType: sample.errorType || null,
    errorMessage: sample.errorMessage || null
  }))
  return {
    roundsRequested: rounds,
    condition: 'same 1440x960 viewport and selected branch per fresh browser context; completion uses direct-child DOM presence/absence, total SVG node count is auxiliary because off-viewport nodes may be culled',
    clients: samples.length,
    completedClients: samples.filter((sample) => sample.status === 'measured').length,
    completedRoundPairs: measuredRounds.length,
    expand: summarize(measuredRounds.map((round) => round.expand.durationMs)),
    collapse: summarize(measuredRounds.map((round) => round.collapse.durationMs)),
    cold: {
      expand: summarize(measuredRounds.filter((round) => round.round === 1).map((round) => round.expand.durationMs)),
      collapse: summarize(measuredRounds.filter((round) => round.round === 1).map((round) => round.collapse.durationMs))
    },
    warm: {
      expand: summarize(measuredRounds.filter((round) => round.round > 1).flatMap((round) => [round.expand.durationMs])),
      collapse: summarize(measuredRounds.filter((round) => round.round > 1).flatMap((round) => [round.collapse.durationMs]))
    },
    perClient,
    samples
  }
}

/** Start a separately bounded Long Tasks measurement window on each page. */
export async function startLongTaskObserver(clients) {
  if (!Array.isArray(clients) || clients.length === 0) throw new TypeError('clients must be a non-empty array')
  return Promise.all(clients.map(async (client) => {
    if (client.navigation.status !== 'loaded') return { clientId: client.id, status: 'client-not-loaded' }
    try {
      const result = await client.page.evaluate(() => {
        const perf = window.__mcpBaselinePerf
        if (!perf || !perf.longTasksSupported) return { status: 'unsupported' }
        if (perf.longTaskWindow?.active) return { status: 'already-running' }
        perf.longTaskWindow = { active: true, startedAt: performance.now(), count: 0, totalMs: 0, maxMs: null }
        return { status: 'started', startedAt: perf.longTaskWindow.startedAt }
      })
      client.longTaskWindows ||= []
      return { clientId: client.id, instance: client.instance, ...result }
    } catch (error) {
      return { clientId: client.id, instance: client.instance, status: 'failed', errorType: error?.name || 'Error' }
    }
  }))
}

/** Stop and return Long Tasks collected since startLongTaskObserver. */
export async function stopLongTaskObserver(clients) {
  if (!Array.isArray(clients) || clients.length === 0) throw new TypeError('clients must be a non-empty array')
  const results = await Promise.all(clients.map(async (client) => {
    if (client.navigation.status !== 'loaded') return { clientId: client.id, instance: client.instance, status: 'client-not-loaded', count: null, totalMs: null, maxMs: null }
    try {
      const result = await client.page.evaluate(() => {
        const perf = window.__mcpBaselinePerf
        if (!perf || !perf.longTasksSupported) return { status: 'unsupported', count: null, totalMs: null, maxMs: null }
        const windowMetrics = perf.longTaskWindow
        if (!windowMetrics?.active) return { status: 'not-running', count: null, totalMs: null, maxMs: null }
        windowMetrics.active = false
        return {
          status: 'measured',
          count: windowMetrics.count,
          totalMs: windowMetrics.totalMs,
          maxMs: windowMetrics.maxMs,
          durationMs: performance.now() - windowMetrics.startedAt
        }
      })
      client.longTaskWindows ||= []
      client.longTaskWindows.push(result)
      return { clientId: client.id, instance: client.instance, ...result }
    } catch (error) {
      return { clientId: client.id, instance: client.instance, status: 'failed', count: null, totalMs: null, maxMs: null, errorType: error?.name || 'Error' }
    }
  }))
  const measured = results.filter((item) => item.status === 'measured')
  return {
    clients: results.length,
    measuredClients: measured.length,
    totalLongTasks: measured.reduce((sum, item) => sum + item.count, 0),
    totalDurationMs: measured.reduce((sum, item) => sum + item.totalMs, 0),
    maxTaskMs: measured.some((item) => item.count > 0) ? Math.max(...measured.map((item) => item.maxMs || 0)) : null,
    duration: summarize(measured.map((item) => item.durationMs)),
    samples: results
  }
}

/**
 * Start a bounded Long Tasks window and record WebSocket counters as the write
 * load's lower bound. The socket probe itself was installed before navigation.
 */
export async function startWriteLoadObservers(clients) {
  const longTaskStart = await startLongTaskObserver(clients)
  const socketStart = await Promise.all(clients.map(async (client) => {
    if (client.navigation.status !== 'loaded') return { clientId: client.id, status: 'client-not-loaded', counters: null }
    try {
      const counters = socketCounterSnapshot(client)
      const collab = await collabStateSnapshot(client.page)
      client.writeLoadObserverBaseline = { websocket: counters, collab }
      return { clientId: client.id, instance: client.instance, status: counters ? 'measured' : 'unsupported', counters, collab }
    } catch (error) {
      return { clientId: client.id, instance: client.instance, status: 'failed', counters: null, errorType: error?.name || 'Error' }
    }
  }))
  const result = {
    startedAt: new Date().toISOString(),
    longTasks: longTaskStart,
    websocket: { instrumentedClients: socketStart.filter((item) => item.status === 'measured').length, samples: socketStart }
  }
  if (clients[0]) {
    clients[0].writeLoadObserverWindows ||= []
    clients[0].writeLoadObserverWindows.push({ start: result, finish: null })
  }
  return result
}

/** Stop the bounded Long Tasks window and return browser-side deltas. */
export async function finishWriteLoadObservers(clients) {
  const longTasks = await stopLongTaskObserver(clients)
  const counters = await Promise.all(clients.map(async (client) => {
    const baseline = client.writeLoadObserverBaseline
    if (!baseline) return { clientId: client.id, instance: client.instance, status: 'no-start-baseline', delta: null }
    try {
      const current = socketCounterSnapshot(client)
      if (!current) return { clientId: client.id, instance: client.instance, status: 'unsupported', delta: null }
      const delta = Object.fromEntries(Object.keys(current).map((key) => [key, current[key] - baseline.websocket[key]]))
      const collabCurrent = await collabStateSnapshot(client.page)
      const collabDelta = Object.fromEntries(['reconnectCount', 'gapRecoveredOps', 'snapshotRecoveryCount', 'retryTraceEvents'].map((key) => {
        const before = baseline.collab?.[key]
        const after = collabCurrent?.[key]
        return [key, Number.isFinite(before) && Number.isFinite(after) ? after - before : null]
      }))
      return { clientId: client.id, instance: client.instance, status: 'measured', delta, collabDelta, collabState: collabCurrent }
    } catch (error) {
      return { clientId: client.id, instance: client.instance, status: 'failed', delta: null, errorType: error?.name || 'Error' }
    }
  }))
  const measured = counters.filter((item) => item.status === 'measured')
  const keys = ['opened', 'successfulOpens', 'closed', 'framesSent', 'framesReceived', 'opEventsReceived', 'gapEvents', 'resnapshotEvents', 'retryEvents', 'reconnects']
  const collabKeys = ['reconnectCount', 'gapRecoveredOps', 'snapshotRecoveryCount', 'retryTraceEvents']
  const result = {
    finishedAt: new Date().toISOString(),
    longTasks,
    websocket: {
      instrumentedClients: measured.length,
      totals: Object.fromEntries(keys.map((key) => [key, measured.reduce((sum, item) => sum + item.delta[key], 0)])),
      collabV2Totals: Object.fromEntries(collabKeys.map((key) => {
        const values = measured.map((item) => item.collabDelta?.[key]).filter(Number.isFinite)
        return [key, values.length ? values.reduce((sum, value) => sum + value, 0) : null]
      })),
      samples: counters
    }
  }
  const windowRecord = clients[0]?.writeLoadObserverWindows?.findLast((item) => item.finish === null)
  if (windowRecord) windowRecord.finish = result
  return result
}

/**
 * Trigger one real write and measure when its marker appears in every browser
 * DOM. A timeout or pre-existing marker is recorded as a failure, never zero.
 */
export async function observeRemoteVisibility(clients, { marker, triggerWrite, timeoutMs = 30_000, operationId = null, opId = null } = {}) {
  if (!Array.isArray(clients) || clients.length === 0) throw new TypeError('clients must be a non-empty array')
  if (!marker || typeof triggerWrite !== 'function') throw new TypeError('marker and triggerWrite function are required')
  const target = String(marker)
  const probe = await armRemoteVisibility(clients, target, { instance: null, timeoutMs, operationId: operationId || opId })
  const requestStartedAtEpochMs = Date.now()
  const requestStartedAtMonotonicMs = now()
  try {
    const response = await triggerWrite()
    const responseCompletedAtEpochMs = Date.now()
    const responseCompletedAtMonotonicMs = now()
    const measured = await finishRemoteVisibilityProbe(probe, {
      requestStartedAtEpochMs,
      responseCompletedAtEpochMs,
      requestStartedAtMonotonicMs,
      responseCompletedAtMonotonicMs,
      operationId: response?.operationId || response?.operation_id || operationId || opId
    })
    measured.writeDurationMs = responseCompletedAtMonotonicMs - requestStartedAtMonotonicMs
    measured.writeStatus = 'completed'
    return measured
  } catch (error) {
    const erroredAtEpochMs = Date.now()
    const erroredAtMonotonicMs = now()
    const observations = await Promise.all(probe.pending)
    const failed = {
      status: 'write-failed',
      marker: target,
      operationId: operationId || opId || null,
      requestStartedAtEpochMs,
      responseCompletedAtEpochMs: null,
      erroredAtEpochMs,
      writeDurationMs: erroredAtMonotonicMs - requestStartedAtMonotonicMs,
      errorType: error?.name || 'Error',
      clients: observations
    }
    if (clients[0]) {
      clients[0].remoteVisibilitySamples ||= []
      clients[0].remoteVisibilitySamples.push(failed)
    }
    return {
      ...failed
    }
  }
}

/** Arm a non-blocking cross-instance DOM probe before a write loop begins. */
export async function armRemoteVisibility(clients, marker, { instance = 'appB', timeoutMs = 30_000, operationId = null, opId = null } = {}) {
  if (!Array.isArray(clients) || clients.length === 0) throw new TypeError('clients must be a non-empty array')
  if (!marker) throw new TypeError('marker is required')
  const target = String(marker)
  const selected = clients.filter((client) => !instance || client.instance === instance)
  if (selected.length === 0) throw new Error(`no browser clients selected for instance ${instance}`)

  const readiness = await Promise.all(selected.map(async (client) => {
    if (client.navigation.status !== 'loaded') return { client, status: 'client-not-loaded' }
    try {
      const exists = await client.page.locator('.smm-node').evaluateAll((elements, value) =>
        elements.some((element) => (element.innerText || element.textContent || '').includes(value)), target)
      return { client, status: exists ? 'preexisting' : 'armed' }
    } catch (error) {
      return { client, status: 'failed-to-arm', errorType: error?.name || 'Error' }
    }
  }))

  const startedAt = now()
  const armedAtEpochMs = Date.now()
  const armedAt = new Date(armedAtEpochMs).toISOString()
  const pending = readiness.map((item) => {
    const { client, status } = item
    if (status !== 'armed') return Promise.resolve({
      clientId: client.id,
      instance: client.instance,
      status,
      domRendered: status === 'preexisting',
      domRenderStatus: status,
      viewportVisibilityStatus: status === 'preexisting' ? 'unknown-preexisting' : 'not-observed',
      seenAtEpochMs: null,
      detectedAtEpochMs: null,
      seenAtMonotonicMs: null,
      errorType: item.errorType || null
    })
    return client.page.waitForFunction((value) => {
      const node = Array.from(document.querySelectorAll('.smm-node')).find((element) =>
        String(element.innerText || element.textContent || '').includes(value))
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const intersectsViewport = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const centerInsideViewport = centerX >= 0 && centerY >= 0 && centerX < window.innerWidth && centerY < window.innerHeight
      const hit = centerInsideViewport ? document.elementFromPoint(centerX, centerY) : null
      const centerHitBelongsToNode = Boolean(hit && (hit === node || node.contains(hit) || hit.contains?.(node)))
      const paintable = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      const seenAtEpochMs = Date.now()
      const seenAtMonotonicMs = performance.now()
      return {
        seenAtEpochMs,
        detectedAtEpochMs: seenAtEpochMs,
        seenAtMonotonicMs,
        markerNodeUid: node.getAttribute('data-node-uid'),
        domRendered: true,
        viewportIntersecting: intersectsViewport,
        viewportVisibleAtCenter: centerInsideViewport && paintable && centerHitBelongsToNode,
        viewportVisibilityStatus: !intersectsViewport
          ? 'offscreen'
          : (!centerInsideViewport ? 'center-offscreen' : (paintable && centerHitBelongsToNode ? 'visible-at-center' : 'occluded-or-hidden')),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    }, target, { timeout: timeoutMs })
      .then(async (handle) => {
        const result = await handle.jsonValue()
        await handle.dispose()
        return {
          clientId: client.id,
          instance: client.instance,
          status: 'measured',
          domRenderStatus: 'measured',
          ...result
        }
      })
      .catch((error) => ({
        clientId: client.id,
        instance: client.instance,
        status: 'timeout',
        domRendered: false,
        domRenderStatus: 'timeout',
        viewportVisibilityStatus: 'not-observed',
        seenAtEpochMs: null,
        detectedAtEpochMs: null,
        seenAtMonotonicMs: null,
        errorType: error?.name || 'Error'
      }))
  })

  return {
    marker: target,
    instance,
    timeoutMs,
    armedAt,
    armedAtEpochMs,
    startedAt,
    operationId: operationId || opId || null,
    pending,
    clients: selected
  }
}

/** Complete an armed asynchronous visibility probe without extending write-loop timing. */
export async function finishRemoteVisibilityProbe(probe, {
  requestStartedAtEpochMs = null,
  responseCompletedAtEpochMs = null,
  requestStartedAtMonotonicMs = null,
  responseCompletedAtMonotonicMs = null,
  operationId = null,
  opId = null,
  // Legacy monotonic completion timestamp accepted for existing callers.
  writeCompletedAt = null
} = {}) {
  if (!probe || !Array.isArray(probe.pending)) throw new TypeError('remote visibility probe is invalid')
  const resolved = await Promise.all(probe.pending)
  const observations = resolved.map((item) => {
    const common = {
      operationId: operationId || opId || probe.operationId || null,
      opId: operationId || opId || probe.operationId || null,
      requestStartedAtEpochMs: Number.isFinite(requestStartedAtEpochMs) ? requestStartedAtEpochMs : null,
      responseCompletedAtEpochMs: Number.isFinite(responseCompletedAtEpochMs) ? responseCompletedAtEpochMs : null,
      requestStartedAtMonotonicMs: Number.isFinite(requestStartedAtMonotonicMs) ? requestStartedAtMonotonicMs : null,
      responseCompletedAtMonotonicMs: Number.isFinite(responseCompletedAtMonotonicMs) ? responseCompletedAtMonotonicMs : (Number.isFinite(writeCompletedAt) ? writeCompletedAt : null)
    }
    if (item.status !== 'measured') return { ...item, ...common, responseToDomRenderMs: null, responseToViewportVisibleMs: null }
    const epochLatencyMs = Number.isFinite(responseCompletedAtEpochMs) && Number.isFinite(item.seenAtEpochMs)
      ? item.seenAtEpochMs - responseCompletedAtEpochMs
      : null
    const requestLatencyMs = Number.isFinite(requestStartedAtEpochMs) && Number.isFinite(item.seenAtEpochMs)
      ? item.seenAtEpochMs - requestStartedAtEpochMs
      : null
    return {
      ...item,
      ...common,
      viewportVisibleAtEpochMs: item.viewportVisibleAtCenter ? item.seenAtEpochMs : null,
      latencyStatus: epochLatencyMs !== null ? 'measured' : 'missing-response-epoch-timestamp',
      requestToDomRenderMs: requestLatencyMs,
      responseToDomRenderMs: epochLatencyMs,
      responseToDomRenderTimebase: epochLatencyMs !== null ? 'epoch' : null,
      responseToViewportVisibleMs: item.viewportVisibleAtCenter ? epochLatencyMs : null,
      markerSeenBeforeResponseCompleted: epochLatencyMs !== null ? epochLatencyMs < 0 : null
    }
  })
  const renderedSamples = observations.filter((item) => item.status === 'measured').map((item) => item.responseToDomRenderMs)
  const viewportSamples = observations.filter((item) => item.status === 'measured' && item.viewportVisibleAtCenter).map((item) => item.responseToViewportVisibleMs)
  const result = {
    status: observations.every((item) => item.status === 'measured') ? 'measured' : 'partial-or-failed',
    marker: probe.marker,
    instance: probe.instance,
    timeoutMs: probe.timeoutMs,
    armedAt: probe.armedAt,
    operationId: operationId || opId || probe.operationId || null,
    opId: operationId || opId || probe.operationId || null,
    requestStartedAtEpochMs: Number.isFinite(requestStartedAtEpochMs) ? requestStartedAtEpochMs : null,
    responseCompletedAtEpochMs: Number.isFinite(responseCompletedAtEpochMs) ? responseCompletedAtEpochMs : null,
    requestStartedAtMonotonicMs: Number.isFinite(requestStartedAtMonotonicMs) ? requestStartedAtMonotonicMs : null,
    responseCompletedAtMonotonicMs: Number.isFinite(responseCompletedAtMonotonicMs) ? responseCompletedAtMonotonicMs : (Number.isFinite(writeCompletedAt) ? writeCompletedAt : null),
    latencyOrigin: Number.isFinite(responseCompletedAtEpochMs) ? 'MCP response completion epoch timestamp; negative values mean DOM rendered before response completed' : 'unavailable without response-completion epoch timestamp',
    latencySemantics: 'response-to-DOM-render; viewport timing is reported only when the marker intersects the viewport and is hit-test visible at its center',
    domRenderLatency: summarize(renderedSamples),
    viewportVisibleLatency: summarize(viewportSamples),
    viewportVisibleClients: observations.filter((item) => item.viewportVisibleAtCenter).length,
    offscreenClients: observations.filter((item) => item.status === 'measured' && !item.viewportIntersecting).length,
    clients: observations
  }
  if (probe.clients[0]) {
    probe.clients[0].remoteVisibilitySamples ||= []
    probe.clients[0].remoteVisibilitySamples.push(result)
  }
  return result
}

/** Close every isolated browser context and persist the collected metrics. */
export async function closeBrowserClients(state) {
  if (!state?.browser || !Array.isArray(state.clients)) throw new TypeError('browser client state is invalid')
  const internal = sessions.get(state)
  if (!internal || internal.closed) return

  for (const client of state.clients) {
    if (!client?.page || client.page.isClosed()) continue
    try {
      const values = await client.page.evaluate(() => ({
        perf: window.__mcpBaselinePerf || null
      }))
      const load = state.loadMetrics.clients.find((item) => item.clientId === client.id)
      if (load && values.perf && client.navigation.status === 'loaded') {
        load.lcpStatus = values.perf.lcpMs === null
          ? (values.perf.lcpUnsupported ? 'unsupported' : 'no-entry')
          : 'measured'
        load.lcpMs = values.perf.lcpMs
        load.lcpEntries = values.perf.lcpEntries
        load.longTasksSupported = values.perf.longTasksSupported
        load.longTaskCount = values.perf.longTaskCount
        load.longTaskTotalMs = values.perf.longTaskTotalMs
        load.longTaskMaxMs = values.perf.longTaskMaxMs
      }
      const socket = state.websocketMetrics.clients.find((item) => item.clientId === client.id)
      const socketCounters = socketCounterSnapshot(client)
      if (socket && socketCounters && client.navigation.status === 'loaded') Object.assign(socket, socketCounters)
    } catch (_) {
      // A closed or crashed renderer remains explicitly unavailable in the report.
    }
  }

  const lcpSamples = state.loadMetrics.clients.map((item) => item.lcpMs)
  state.loadMetrics.summary = {
    ...state.loadMetrics.summary,
    lcp: summarize(lcpSamples),
    lcpUnavailableClients: state.loadMetrics.clients.filter((item) => item.lcpStatus !== 'measured').map((item) => ({ clientId: item.clientId, status: item.lcpStatus }))
  }
  const socketKeys = ['opened', 'successfulOpens', 'closed', 'framesSent', 'framesReceived', 'opEventsReceived', 'gapEvents', 'resnapshotEvents', 'retryEvents', 'reconnects']
  state.websocketMetrics.totals = Object.fromEntries(socketKeys.map((key) => [key, state.websocketMetrics.clients.reduce((sum, item) => sum + (Number.isFinite(item[key]) ? item[key] : 0), 0)]))
  state.websocketMetrics.instrumentedClients = state.websocketMetrics.clients.filter((item) => item.instrumentationSupported).length

  const artifact = {
    runId: state.loadMetrics.runId,
    roomKey: state.loadMetrics.roomKey,
    generatedAt: new Date().toISOString(),
    loadMetrics: state.loadMetrics,
    websocketMetrics: state.websocketMetrics,
    interactions: state.clients.flatMap((client) => client.interactions),
    writeLoadObserverWindows: state.clients.flatMap((client) => client.writeLoadObserverWindows || []),
    remoteVisibility: state.clients.flatMap((client) => client.remoteVisibilitySamples || []),
    pageErrorCounts: state.clients.map((client) => ({ clientId: client.id, count: client.pageErrors.length, types: client.pageErrors.reduce((counts, item) => ({ ...counts, [item.type]: (counts[item.type] || 0) + 1 }), {}) }))
  }

  try {
    await mkdir(internal.outputDir, { recursive: true })
    await writeFile(join(internal.outputDir, `${state.loadMetrics.runId}-browser-metrics.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  } finally {
    internal.closed = true
    await state.browser.close().catch(() => {})
  }
}
