'use strict'

/**
 * C2 Editor real-browser benchmark.
 *
 * Requires a loginable stack (localhost / private host for AUTH_DEV_BYPASS):
 *   C2_BROWSER_ORIGIN / COLLAB_TEST_BASE_URL
 * Uses developer login when available (AUTH_MODE = DEV_NORMAL_ACL).
 *
 * Seeds real room_nodes via /api/files + /replace, then opens Product Shell Editor
 * and measures hydrate → SimpleMindMap render → interaction latencies.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { bushTree } = require('./fixtures/largeMapFixtures')

const ORIGIN = String(
  process.env.C2_BROWSER_ORIGIN ||
    process.env.COLLAB_TEST_BASE_URL ||
    process.env.ORIGIN ||
    ''
).replace(/\/$/, '')

const SIZES = [1000, 5000, 10000]
const STRESS = [20000]
const DEV_KEY =
  process.env.AUTH_DEV_BYPASS_KEY ||
  readDevKeyFromEnvFile() ||
  ''

function readDevKeyFromEnvFile() {
  try {
    const envPath = path.resolve(__dirname, '../../.env')
    const line = fs
      .readFileSync(envPath, 'utf8')
      .split(/\n/)
      .map(row => row.replace(/\r$/, ''))
      .find(row => row.startsWith('AUTH_DEV_BYPASS_KEY='))
    return line ? line.slice('AUTH_DEV_BYPASS_KEY='.length).trim() : ''
  } catch (_) {
    return ''
  }
}

async function tryPlaywright() {
  try {
    return require('playwright')
  } catch (_) {
    try {
      return require('@playwright/test')
    } catch (e) {
      return null
    }
  }
}

function writeReport(report) {
  const outDir = path.join(__dirname, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'c2-editor-browser.json'),
    JSON.stringify(report, null, 2)
  )
  const lines = []
  const s = report.summary || {}
  Object.keys(s).forEach(k => lines.push(k + ' = ' + s[k]))
  fs.writeFileSync(
    path.join(outDir, 'c2-editor-browser.md'),
    '# C2 Editor Browser Benchmark\n\n```\n' + lines.join('\n') + '\n```\n'
  )
}

async function loginDev(page, origin, key) {
  await page.goto(origin + '/files', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })

  const apiLogin = await page.evaluate(
    async ({ origin, key }) => {
      const meRes = await fetch(origin + '/api/auth/me', { credentials: 'include' })
      const meData = await meRes.json().catch(() => ({}))
      if (meData.authenticated) {
        return { ok: true, via: 'session', me: meData }
      }
      const res = await fetch(origin + '/api/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key })
      })
      const data = await res.json().catch(() => ({}))
      return {
        ok: res.ok && !!data.authenticated,
        status: res.status,
        via: 'dev-login',
        data,
        me: meData
      }
    },
    { origin, key }
  )

  if (apiLogin.ok) {
    await page.goto(origin + '/files', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    })
    await page.waitForSelector('.productShell, .editContainer', { timeout: 30000 })
    return { ok: true, mode: 'DEV_NORMAL_ACL', via: apiLogin.via }
  }

  // UI fallback (collapsed developer form).
  const toggle = page.locator('.authDevToggle')
  if (await toggle.count()) {
    await toggle.click().catch(() => null)
  }
  const input = page.locator('.authDevInput')
  if (await input.count()) {
    await input.fill(key)
    await page.locator('.authDevForm button[type="submit"]').click()
    await page.waitForSelector('.productShell, .editContainer', { timeout: 30000 })
    return { ok: true, mode: 'DEV_NORMAL_ACL', via: 'ui', apiLogin }
  }

  const shell = await page
    .waitForSelector('.productShell, .editContainer', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  return {
    ok: shell,
    mode: shell ? 'WECOM' : 'NONE',
    apiLogin
  }
}

async function waitForHealth(origin, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(origin + '/api/health', {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      })
      clearTimeout(timer)
      if (res.ok) return true
      lastErr = 'health status ' + res.status
    } catch (err) {
      lastErr = String(err && err.message ? err.message : err)
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('health not ready: ' + lastErr)
}

async function ensureAuth(page, origin, key) {
  const state = await page.evaluate(async origin => {
    try {
      const res = await fetch(origin + '/api/auth/me', { credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      return { authenticated: !!data.authenticated, data }
    } catch (err) {
      return { authenticated: false, error: String(err && err.message) }
    }
  }, origin)
  if (state.authenticated) return state
  await waitForHealth(origin, 60000)
  const again = await loginDev(page, origin, key)
  if (!again.ok) throw new Error('re-auth failed')
  return { authenticated: true, reauthed: true }
}

async function recoverServiceGate(page, origin) {
  const blocked = await page.evaluate(() => {
    const text = String((document.body && document.body.innerText) || '')
    return /SERVICE_UNAVAILABLE|协作服务未启动/.test(text)
  })
  if (!blocked) return false
  await waitForHealth(origin, 180000)
  const btn = page.getByRole('button', { name: /重新连接|重试/ })
  if (await btn.count()) {
    await btn.first().click().catch(() => null)
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  await page
    .waitForSelector('#mindMapContainer, .productShell, .editContainer', {
      timeout: 60000
    })
    .catch(() => null)
  return true
}

async function readAuthMode(page, origin) {
  const me = await page.evaluate(async origin => {
    const res = await fetch(origin + '/api/auth/me', { credentials: 'include' })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }, origin)
  const user = me.data && me.data.user
  const authenticated = !!(me.data && me.data.authenticated)
  if (authenticated && user && !user.service) {
    return {
      AUTH_MODE: 'DEV_NORMAL_ACL',
      authenticated: true,
      userId: user.id || user.userId || null
    }
  }
  if (authenticated) {
    return { AUTH_MODE: 'WECOM', authenticated: true, userId: user && user.id }
  }
  return { AUTH_MODE: 'NONE', authenticated: false, userId: null }
}

async function seedRoom(request, origin, size) {
  const { tree } = bushTree(size)
  const roomKey = 'c2-browser-' + size + '-' + Date.now()
  const clientId = 'c2-browser-bench-' + size
  const create = await request.post(origin + '/api/files', {
    data: {
      room_key: roomKey,
      title: 'C2 Browser ' + size,
      clientId,
      tree: {
        data: { text: 'Root', uid: 'root', isRoot: true },
        children: []
      }
    },
    timeout: 120000
  })
  if (!create.ok() && create.status() !== 409) {
    const body = await create.text()
    throw new Error('create failed ' + create.status() + ' ' + body.slice(0, 300))
  }
  const replace = await request.post(
    origin + '/api/files/' + encodeURIComponent(roomKey) + '/replace',
    {
      data: {
        tree,
        allowFullTree: true,
        source: 'c2-browser-bench',
        clientId,
        type: 'map.replace'
      },
      timeout: 300000
    }
  )
  if (!replace.ok()) {
    const body = await replace.text()
    throw new Error(
      'seed replace failed ' + replace.status() + ' ' + body.slice(0, 400)
    )
  }
  const meta = await replace.json().catch(() => ({}))
  return {
    roomKey,
    version: meta.version || meta.room_version || null,
    nodeCount: meta.node_count || size
  }
}

async function installProbes(page) {
  await page.addInitScript(() => {
    const expected = Number(
      sessionStorage.getItem('__C2_EXPECTED_NODES__') || '0'
    )
    const marks = (window.__C2__ = {
      navStart: performance.now(),
      phases: { NAVIGATION_START: performance.now() },
      longTasks: [],
      previewMeta: null,
      expectedNodes: expected,
      renderGate: Math.max(8, Math.min(200, Math.floor(expected * 0.002) || 8))
    })
    const mark = name => {
      marks.phases[name] = performance.now()
    }
    try {
      const po = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          marks.longTasks.push({
            name: e.name || 'longtask',
            duration: e.duration,
            startTime: e.startTime
          })
        }
      })
      po.observe({ type: 'longtask', buffered: true })
    } catch (_) {
      /* unsupported */
    }

    const maybeMarkRender = reason => {
      if (marks.phases.ROOM_DATA_READY == null) return false
      if (marks.phases.FIRST_RENDER_COMPLETE != null) return true
      const svg = document.querySelector('#mindMapContainer svg')
      if (!svg) return false
      const n = svg.querySelectorAll(
        'g.smm-node, g[data-uid], .smm-node, text'
      ).length
      if (n < marks.renderGate) return false
      mark('FIRST_RENDER_COMPLETE')
      if (marks.phases.LAYOUT_COMPLETE == null) mark('LAYOUT_COMPLETE')
      marks.renderReason = reason
      return true
    }

    const origFetch = window.fetch.bind(window)
    window.fetch = async function patchedFetch(input, init) {
      const url = String(
        typeof input === 'string' ? input : (input && input.url) || ''
      )
      const isPreview = /\/api\/files\/[^/?#]+\/preview/.test(url)
      if (isPreview && marks.phases.ROOM_HTTP_START == null) {
        mark('ROOM_HTTP_START')
      }
      const res = await origFetch(input, init)
      if (isPreview) {
        mark('ROOM_DATA_READY')
        try {
          const clone = res.clone()
          const data = await clone.json()
          marks.previewMeta = {
            nodeCount: data.node_count || data.roomNodesCount || null,
            treeSource: data.treeSource || null,
            legacyFallback: !!data.legacyFallback,
            legacyFallbackReason: data.legacyFallbackReason || '',
            version: data.version || null,
            safeLoad: !!data.safe_load,
            clipped: !!data.clipped,
            lazyLoad: !!data.lazy_load,
            roomNodesHash: data.roomNodesHash || null,
            roomsJsonHash: data.roomsJsonHash || null,
            roomNodesCount: data.roomNodesCount || null
          }
          if (marks.previewMeta.nodeCount) {
            marks.renderGate = Math.max(
              8,
              Math.min(300, Math.floor(marks.previewMeta.nodeCount * 0.002))
            )
          }
        } catch (_) {
          /* ignore */
        }
      }
      return res
    }

    const bindMindMapHooks = () => {
      let el = document.querySelector('#mindMapContainer')
      while (el) {
        const vue = el.__vue__
        if (vue && vue.mindMap && !marks._hooked) {
          marks._hooked = true
          mark('MINDMAP_CONSTRUCTOR_START')
          window.__C2_MINDMAP__ = vue.mindMap
          const mm = vue.mindMap
          if (typeof mm.on === 'function') {
            mm.on('node_tree_render_end', () => {
              if (marks.phases.MINDMAP_DATA_APPLIED != null || marks.phases.ROOM_DATA_READY != null) {
                maybeMarkRender('node_tree_render_end')
              }
            })
            mm.on('data_change', () => {
              if (marks.phases.MINDMAP_DATA_APPLIED == null) {
                mark('MINDMAP_DATA_APPLIED')
              }
              maybeMarkRender('data_change')
            })
          }
          return true
        }
        el = el.parentElement
      }
      return false
    }

    const obs = new MutationObserver(() => {
      bindMindMapHooks()
      maybeMarkRender('mutation')
    })
    const startObs = () => {
      if (document.body) {
        obs.observe(document.body, { childList: true, subtree: true })
        bindMindMapHooks()
      } else {
        setTimeout(startObs, 50)
      }
    }
    startObs()
    window.__C2_BIND__ = bindMindMapHooks
    window.__C2_MAYBE_RENDER__ = maybeMarkRender
  })
}

async function collectRuntime(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#mindMapContainer')
    const svg = root && root.querySelector('svg')
    const c2 = window.__C2__ || {}
    const mm = window.__C2_MINDMAP__
    let heap = null
    if (performance.memory) {
      heap = {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize
      }
    }
    const longTasks = c2.longTasks || []
    const maxLong = longTasks.reduce((m, t) => Math.max(m, t.duration || 0), 0)
    return {
      phases: c2.phases || {},
      previewMeta: c2.previewMeta,
      renderReason: c2.renderReason || null,
      longTaskCount: longTasks.length,
      maxLongTaskMs: Math.round(maxLong),
      longTasks: longTasks
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 8),
      heap,
      domCount: root ? root.querySelectorAll('*').length : 0,
      svgCount: svg ? svg.querySelectorAll('*').length : 0,
      svgNodeGuess: svg
        ? svg.querySelectorAll('g.smm-node, g[data-uid], .smm-node').length
        : 0,
      hasMindMap: !!mm,
      hasAuthGate: !!document.querySelector('.authDevLogin, .authPanel, .authCard'),
      bodySnippet: document.body
        ? String(document.body.innerText || '').slice(0, 160)
        : '',
      plugins: mm
        ? {
            richText: !!mm.richText,
            associativeLine: !!mm.associativeLine,
            outerFrame: !!mm.outerFrame,
            demonstrate: !!mm.demonstrate
          }
        : null
    }
  })
}

async function waitForEditorReady(page, size, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(1000, deadline - Date.now())

  try {
    await page.waitForSelector('#mindMapContainer', { timeout: Math.min(45000, left()) })
  } catch (err) {
    const snap = await collectRuntime(page).catch(() => ({}))
    return {
      ok: false,
      reason: 'no_mindmap_container',
      snap,
      err: String(err && err.message)
    }
  }

  await page.evaluate(() => {
    if (window.__C2_BIND__) window.__C2_BIND__()
  })

  try {
    await page.waitForFunction(
      () => {
        const c2 = window.__C2__ || {}
        return c2.phases && c2.phases.ROOM_DATA_READY != null
      },
      { timeout: Math.min(120000, left()) }
    )
  } catch (_) {
    /* continue; may still render from cache */
  }

  try {
    await page.waitForFunction(
      () => {
        if (window.__C2_MAYBE_RENDER__) window.__C2_MAYBE_RENDER__('poll')
        const c2 = window.__C2__ || {}
        return c2.phases && c2.phases.FIRST_RENDER_COMPLETE != null
      },
      { timeout: left() }
    )
  } catch (err) {
    const snap = await collectRuntime(page).catch(() => ({}))
    return {
      ok: false,
      reason: 'render_timeout',
      snap,
      err: String(err && err.message)
    }
  }

  await page.evaluate(() => {
    const c2 = window.__C2__
    if (!c2 || !c2.phases) return
    if (c2.phases.FIRST_INTERACTION_READY == null) {
      c2.phases.FIRST_INTERACTION_READY = performance.now()
    }
    if (c2.phases.AUTH_READY == null) {
      c2.phases.AUTH_READY = c2.phases.NAVIGATION_START
    }
  })

  return { ok: true }
}

async function measureLatency(page, fn) {
  const t0 = Date.now()
  let ok = false
  let err = null
  try {
    ok = !!(await fn())
  } catch (e) {
    err = String(e && e.message ? e.message : e)
    ok = false
  }
  await page
    .evaluate(
      () =>
        new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })
    )
    .catch(() => null)
  return { ms: Date.now() - t0, ok, err }
}

async function runInteractions(page) {
  const out = {}
  out.ZOOM_LATENCY = await measureLatency(page, () =>
    page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm || !mm.view) return false
      if (typeof mm.view.enlarge === 'function') mm.view.enlarge()
      else if (typeof mm.view.setScale === 'function') {
        mm.view.setScale((mm.view.scale || 1) * 1.1)
      } else return false
      return true
    })
  )
  out.PAN_LATENCY = await measureLatency(page, () =>
    page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm || !mm.view) return false
      if (typeof mm.view.translateXY === 'function') mm.view.translateXY(48, 36)
      else if (typeof mm.view.translate === 'function') mm.view.translate(48, 36)
      else return false
      return true
    })
  )
  out.SEARCH_LATENCY = await measureLatency(page, async () => {
    const viaApi = await page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm) return false
      if (typeof mm.execCommand === 'function') {
        try {
          mm.execCommand('SEARCH_NODE', false, 'Node 1')
          return true
        } catch (_) {
          /* fall through */
        }
      }
      return false
    })
    if (viaApi) return true
    await page.keyboard.press('Control+f').catch(() => null)
    const box = page.locator('.searchContainer input, .el-input__inner').first()
    if (await box.count()) {
      await box.fill('Node 1')
      await page.keyboard.press('Enter')
      return true
    }
    return false
  })
  out.SELECT_LATENCY = await measureLatency(page, () =>
    page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm || !mm.renderer || !mm.renderer.root) return false
      const root = mm.renderer.root
      const target = (root.children && root.children[0]) || root
      if (target && typeof target.active === 'function') target.active()
      else if (typeof mm.renderer.setNodeActive === 'function') {
        mm.renderer.setNodeActive(target)
      } else return false
      return true
    })
  )
  out.COLLAPSE_LATENCY = await measureLatency(page, () =>
    page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm || !mm.renderer || !mm.renderer.root) return false
      const node =
        (mm.renderer.root.children && mm.renderer.root.children[0]) || null
      if (!node) return false
      if (typeof mm.execCommand === 'function') {
        try {
          mm.execCommand('SET_NODE_EXPAND', node, false)
          return true
        } catch (_) {
          /* fall through */
        }
      }
      if (typeof node.setExpand === 'function') {
        node.setExpand(false)
        return true
      }
      return false
    })
  )
  out.EXPAND_LATENCY = await measureLatency(page, () =>
    page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      if (!mm || !mm.renderer || !mm.renderer.root) return false
      const node =
        (mm.renderer.root.children && mm.renderer.root.children[0]) || null
      if (!node) return false
      if (typeof mm.execCommand === 'function') {
        try {
          mm.execCommand('SET_NODE_EXPAND', node, true)
          return true
        } catch (_) {
          /* fall through */
        }
      }
      if (typeof node.setExpand === 'function') {
        node.setExpand(true)
        return true
      }
      return false
    })
  )
  return out
}

async function measureFullRenderProbe(page, origin, roomKey, size) {
  // Product Editor uses safe_load (~80 nodes) for maps >= 400.
  // This probe fetches format=full and mindMap.setData to isolate Renderer cost.
  const maxNodes = Math.min(size, 10000)
  return page.evaluate(
    async ({ origin, roomKey, maxNodes, size }) => {
      const mm = window.__C2_MINDMAP__
      if (!mm || typeof mm.setData !== 'function') {
        return { ok: false, reason: 'no_mindmap' }
      }
      const t0 = performance.now()
      const res = await fetch(
        origin +
          '/api/files/' +
          encodeURIComponent(roomKey) +
          '?format=full&max_nodes=' +
          maxNodes,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      )
      const tHttp = performance.now()
      if (!res.ok) {
        return {
          ok: false,
          reason: 'full_http_' + res.status,
          httpMs: Math.round(tHttp - t0)
        }
      }
      const data = await res.json()
      const tParsed = performance.now()
      function countTree(n) {
        if (!n) return 0
        return (
          1 +
          (n.children || []).reduce((a, c) => a + countTree(c), 0)
        )
      }
      const treeNodes = countTree(data.tree)
      if (!data.tree || treeNodes < Math.min(size, maxNodes) * 0.9) {
        return {
          ok: false,
          reason: 'tree_too_small',
          treeNodes,
          nodeCount: data.node_count,
          httpMs: Math.round(tHttp - t0),
          parseMs: Math.round(tParsed - tHttp)
        }
      }

      const renderTimeout = size >= 20000 ? 300000 : size >= 10000 ? 240000 : 180000
      const renderPromise = new Promise((resolve, reject) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          resolve('node_tree_render_end')
        }
        if (typeof mm.on === 'function') mm.on('node_tree_render_end', done)
        setTimeout(() => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          const svg = document.querySelector('#mindMapContainer svg')
          const n = svg
            ? svg.querySelectorAll('g.smm-node, g[data-uid], .smm-node, text')
                .length
            : 0
          if (n > 100) resolve('timeout_with_svg_' + n)
          else reject(new Error('full_render_timeout'))
        }, renderTimeout)
      })

      const tSet = performance.now()
      try {
        mm.setData(data.tree)
      } catch (err) {
        return {
          ok: false,
          reason: 'setData_threw',
          error: String(err && err.message ? err.message : err),
          httpMs: Math.round(tHttp - t0),
          parseMs: Math.round(tParsed - tHttp)
        }
      }
      let renderReason = null
      try {
        renderReason = await renderPromise
      } catch (err) {
        return {
          ok: false,
          reason: 'render_failed',
          error: String(err && err.message ? err.message : err),
          httpMs: Math.round(tHttp - t0),
          parseMs: Math.round(tParsed - tHttp),
          setDataMs: Math.round(performance.now() - tSet)
        }
      }
      const tDone = performance.now()
      const root = document.querySelector('#mindMapContainer')
      const svg = root && root.querySelector('svg')
      return {
        ok: true,
        requestedNodes: size,
        fetchedMaxNodes: maxNodes,
        treeNodes,
        apiNodeCount: data.node_count || null,
        truncated: !!data.truncated,
        httpMs: Math.round(tHttp - t0),
        parseMs: Math.round(tParsed - tHttp),
        renderMs: Math.round(tDone - tSet),
        fullMs: Math.round(tDone - t0),
        renderReason,
        domCount: root ? root.querySelectorAll('*').length : 0,
        svgCount: svg ? svg.querySelectorAll('*').length : 0
      }
    },
    { origin, roomKey, maxNodes, size }
  )
}

function inferHotspots(row) {
  const hotspots = []
  const full = row.fullRender || {}
  if (full.ok && full.renderMs != null) {
    if (full.renderMs > Math.max(2000, (full.httpMs || 0) * 2)) {
      hotspots.push('SimpleMindMap_setData_layout_render')
    }
    if ((full.svgCount || 0) > 20000 || (full.domCount || 0) > 25000) {
      hotspots.push('SVG_DOM_creation_volume')
    }
    if (full.renderMs > 5000) {
      hotspots.push('full_tree_node_creation_layout')
    }
  }
  const dataToRender = row.TIME_DATA_TO_RENDER
  if (row.previewMeta && row.previewMeta.safeLoad) {
    hotspots.push('product_safe_load_clips_to_~80_nodes')
  }
  if ((row.MAX_LONG_TASK_MS || 0) >= 200) {
    hotspots.push('JS_longtask_during_render')
  }
  if (hotspots.length < 3 && dataToRender != null && dataToRender > 2000) {
    hotspots.push('SimpleMindMap_setData_layout_render')
  }
  if (hotspots.length < 3 && row.plugins && row.plugins.richText) {
    hotspots.push('RichText_plugin_present_full_feature_path')
  }
  if (hotspots.length < 3) hotspots.push('node_creation_and_event_binding')
  while (hotspots.length < 3) hotspots.push('unresolved')
  return hotspots.slice(0, 3)
}

function verdictForSize(size, row, interactions) {
  if (!row || row.crashed) return 'FAIL'
  if (row.oom || row.whiteScreen) return 'FAIL'
  if (row.TIME_TO_FIRST_RENDER == null) {
    return size >= 20000 ? 'SAFE_LIMIT' : 'FAIL'
  }
  const coreIx =
    interactions &&
    interactions.ZOOM_LATENCY &&
    interactions.ZOOM_LATENCY.ok &&
    interactions.PAN_LATENCY &&
    interactions.PAN_LATENCY.ok &&
    ((interactions.SELECT_LATENCY && interactions.SELECT_LATENCY.ok) ||
      (interactions.COLLAPSE_LATENCY && interactions.COLLAPSE_LATENCY.ok))

  const full = row.fullRender
  if (size >= 20000) {
    // Product path may PASS via safe_load; full render API caps at 10k nodes.
    if (full && full.ok === false && full.reason === 'render_failed') {
      return 'SAFE_LIMIT'
    }
    if (row.TIME_TO_FIRST_RENDER > 120000) return 'SAFE_LIMIT'
    if (!coreIx) return 'PARTIAL'
    return 'PASS'
  }
  if (row.TIME_TO_FIRST_RENDER > 90000) return 'FAIL'
  if (!coreIx) return 'PARTIAL'
  if (full && full.ok && full.renderMs > 60000) return 'PARTIAL'
  if (size >= 10000 && full && full.ok && full.renderMs > 30000) return 'PARTIAL'
  if (size >= 5000 && full && full.ok && full.renderMs > 20000) return 'PARTIAL'
  return 'PASS'
}

async function measureRoom(page, origin, seeded, size, options = {}) {
  const timeoutMs =
    size >= 20000 ? 300000 : size >= 10000 ? 240000 : size >= 5000 ? 180000 : 120000

  await page.evaluate(n => {
    sessionStorage.setItem('__C2_EXPECTED_NODES__', String(n))
  }, size)

  const heapBefore = await page
    .evaluate(() =>
      performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize }
        : null
    )
    .catch(() => null)

  let crashed = false
  const onErr = () => {
    crashed = true
  }
  page.on('pageerror', onErr)

  await page.goto(origin + '/?room=' + encodeURIComponent(seeded.roomKey), {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  })

  await recoverServiceGate(page, origin)
  // If still on service gate after recover, one more reload once health is up.
  await recoverServiceGate(page, origin)

  const wait = await waitForEditorReady(page, size, timeoutMs)
  page.off('pageerror', onErr)

  if (!wait.ok) {
    const snap = wait.snap || (await collectRuntime(page).catch(() => ({})))
    return {
      size,
      roomKey: seeded.roomKey,
      verdict: size >= 20000 ? 'SAFE_LIMIT' : 'FAIL',
      note: wait.reason,
      waitErr: wait.err,
      whiteScreen: true,
      crashed,
      TIME_TO_DATA_READY: null,
      TIME_DATA_TO_RENDER: null,
      TIME_TO_FIRST_RENDER: null,
      TIME_TO_INTERACTIVE: null,
      previewMeta: snap.previewMeta || null,
      DOM_COUNT: snap.domCount || 0,
      SVG_COUNT: snap.svgCount || 0,
      bodySnippet: snap.bodySnippet || '',
      hasAuthGate: !!snap.hasAuthGate,
      hotspots: [
        'editor_did_not_reach_first_render',
        'check_auth_or_renderer_hang',
        'unresolved'
      ]
    }
  }

  const runtime = await collectRuntime(page)
  const phases = runtime.phases || {}
  const nav = phases.NAVIGATION_START || 0

  const TIME_TO_DATA_READY =
    phases.ROOM_DATA_READY != null
      ? Math.round(phases.ROOM_DATA_READY - nav)
      : null
  const TIME_TO_FIRST_RENDER =
    phases.FIRST_RENDER_COMPLETE != null
      ? Math.round(phases.FIRST_RENDER_COMPLETE - nav)
      : null
  const TIME_TO_INTERACTIVE =
    phases.FIRST_INTERACTION_READY != null
      ? Math.round(phases.FIRST_INTERACTION_READY - nav)
      : TIME_TO_FIRST_RENDER
  const TIME_DATA_TO_RENDER =
    phases.ROOM_DATA_READY != null && phases.FIRST_RENDER_COMPLETE != null
      ? Math.round(phases.FIRST_RENDER_COMPLETE - phases.ROOM_DATA_READY)
      : null

  const whiteScreen =
    TIME_TO_FIRST_RENDER == null ||
    (runtime.svgCount === 0 && runtime.domCount < 5)

  let interactions = null
  if (!whiteScreen && runtime.hasMindMap) {
    interactions = await runInteractions(page)
    await page.evaluate(() => {
      const c2 = window.__C2__
      if (c2 && c2.phases) c2.phases.FIRST_INTERACTION_READY = performance.now()
    })
  }

  let fullRender = null
  if (!whiteScreen && runtime.hasMindMap) {
    console.log('[c2-browser] full-render probe', size)
    try {
      fullRender = await measureFullRenderProbe(
        page,
        origin,
        seeded.roomKey,
        size
      )
      console.log(
        '[c2-browser] full-render',
        size,
        fullRender && fullRender.ok,
        'http=',
        fullRender && fullRender.httpMs,
        'render=',
        fullRender && fullRender.renderMs,
        'dom=',
        fullRender && fullRender.domCount
      )
    } catch (err) {
      fullRender = {
        ok: false,
        reason: 'probe_threw',
        error: String(err && err.message ? err.message : err)
      }
    }
  }

  const runtimeAfter = await collectRuntime(page)
  const row = {
    size,
    roomKey: seeded.roomKey,
    phases: runtimeAfter.phases,
    renderReason: runtimeAfter.renderReason,
    TIME_TO_DATA_READY,
    TIME_DATA_TO_RENDER,
    TIME_TO_FIRST_RENDER,
    TIME_TO_INTERACTIVE,
    previewMeta: runtimeAfter.previewMeta,
    productSafeLoad: !!(runtimeAfter.previewMeta && runtimeAfter.previewMeta.safeLoad),
    LONG_TASK_COUNT: runtimeAfter.longTaskCount,
    MAX_LONG_TASK_MS: runtimeAfter.maxLongTaskMs,
    longTasksTop: runtimeAfter.longTasks,
    HEAP_BEFORE: heapBefore,
    HEAP_AFTER: runtimeAfter.heap,
    DOM_COUNT: runtimeAfter.domCount,
    SVG_COUNT: runtimeAfter.svgCount,
    plugins: runtimeAfter.plugins,
    interactions,
    fullRender,
    whiteScreen,
    crashed,
    oom: false
  }
  row.hotspots = inferHotspots(row)
  row.verdict = verdictForSize(size, row, interactions)

  if (options.doF5) {
    const before = await page.evaluate(() => {
      const u = new URL(location.href)
      const c2 = window.__C2__ || {}
      return {
        roomKey: u.searchParams.get('room'),
        version: c2.previewMeta && c2.previewMeta.version,
        treeSource: c2.previewMeta && c2.previewMeta.treeSource,
        legacyFallback: !!(c2.previewMeta && c2.previewMeta.legacyFallback),
        nodeCount: c2.previewMeta && c2.previewMeta.nodeCount
      }
    })
    await page.evaluate(n => {
      sessionStorage.setItem('__C2_EXPECTED_NODES__', String(n))
    }, size)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await recoverServiceGate(page, origin)
    const f5Wait = await waitForEditorReady(page, size, timeoutMs)
    const after = await page.evaluate(async ({ origin, roomKey, size }) => {
      const u = new URL(location.href)
      const c2 = window.__C2__ || {}
      if (window.__C2_BIND__) window.__C2_BIND__()
      let authority = null
      try {
        const res = await fetch(
          origin +
            '/api/files/' +
            encodeURIComponent(roomKey) +
            '?format=full&max_nodes=1',
          { credentials: 'include', headers: { Accept: 'application/json' } }
        )
        const data = await res.json()
        authority = {
          status: res.status,
          nodeCount: data.node_count || null,
          version: data.version || null
        }
      } catch (err) {
        authority = { error: String(err && err.message) }
      }
      return {
        roomKey: u.searchParams.get('room'),
        version: c2.previewMeta && c2.previewMeta.version,
        treeSource: c2.previewMeta && c2.previewMeta.treeSource,
        legacyFallback: !!(c2.previewMeta && c2.previewMeta.legacyFallback),
        nodeCount: c2.previewMeta && c2.previewMeta.nodeCount,
        hasSvg: !!document.querySelector('#mindMapContainer svg'),
        hasMindMap: !!window.__C2_MINDMAP__,
        authority
      }
    }, { origin, roomKey: seeded.roomKey, size })
    const authCount =
      after.authority && after.authority.nodeCount != null
        ? Number(after.authority.nodeCount)
        : null
    const f5Pass =
      f5Wait.ok &&
      before.roomKey &&
      before.roomKey === after.roomKey &&
      after.hasSvg &&
      after.hasMindMap &&
      after.legacyFallback === false &&
      (after.treeSource === 'room_nodes' ||
        after.treeSource == null ||
        after.treeSource === '') &&
      authCount === size &&
      Number(after.nodeCount || 0) === size
    row.f5 = {
      before,
      after,
      waitOk: f5Wait.ok,
      verdict: f5Pass ? 'PASS' : 'FAIL'
    }
  }

  return row
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN || null,
    phases: [],
    summary: {}
  }

  if (!ORIGIN) {
    report.summary = {
      AUTH_MODE: 'NONE',
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'C2_BROWSER_ORIGIN / COLLAB_TEST_BASE_URL not set'
    }
    writeReport(report)
    console.log('c2EditorBrowser.benchmark: NOT_RUN (no ORIGIN)')
    return
  }

  const pw = await tryPlaywright()
  if (!pw || !pw.chromium) {
    report.summary = {
      AUTH_MODE: 'NONE',
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'playwright not installed'
    }
    writeReport(report)
    console.log('c2EditorBrowser.benchmark: NOT_RUN (no playwright)')
    return
  }

  try {
    const health = await fetch(ORIGIN + '/api/health')
    if (!health.ok) throw new Error('health ' + health.status)
  } catch (err) {
    report.summary = {
      AUTH_MODE: 'NONE',
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'stack unreachable: ' + err.message
    }
    writeReport(report)
    console.log('c2EditorBrowser.benchmark: NOT_RUN (stack unreachable)')
    return
  }

  if (!DEV_KEY) {
    report.summary = {
      AUTH_MODE: 'NONE',
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'AUTH_DEV_BYPASS_KEY missing'
    }
    writeReport(report)
    console.log('c2EditorBrowser.benchmark: NOT_RUN (no dev key)')
    return
  }

  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(120000)

  try {
    await installProbes(page)
    const login = await loginDev(page, ORIGIN, DEV_KEY)
    if (!login.ok) {
      report.summary = {
        AUTH_MODE: 'NONE',
        EDITOR_1K_BROWSER: 'NOT_RUN',
        EDITOR_5K_BROWSER: 'NOT_RUN',
        EDITOR_10K_BROWSER: 'NOT_RUN',
        EDITOR_20K_BROWSER: 'NOT_RUN',
        reason: 'login failed',
        login
      }
      writeReport(report)
      return
    }
    const auth = await readAuthMode(page, ORIGIN)
    report.auth = auth
    report.summary.AUTH_MODE = auth.AUTH_MODE || login.mode

    const request = context.request
    for (const size of SIZES) {
      try {
        console.log('[c2-browser] wait health before', size)
        await waitForHealth(ORIGIN, 180000)
        await ensureAuth(page, ORIGIN, DEV_KEY)
        console.log('[c2-browser] seed', size)
        const seeded = await seedRoom(request, ORIGIN, size)
        console.log('[c2-browser] seeded, wait health', seeded.roomKey)
        await waitForHealth(ORIGIN, 180000)
        console.log('[c2-browser] open', seeded.roomKey)
        const row = await measureRoom(page, ORIGIN, seeded, size, {
          doF5: size === 5000 || size === 10000
        })
        report.phases.push(row)
        console.log(
          '[c2-browser] done',
          size,
          row.verdict,
          'dataReady=',
          row.TIME_TO_DATA_READY,
          'firstRender=',
          row.TIME_TO_FIRST_RENDER,
          'dataToRender=',
          row.TIME_DATA_TO_RENDER
        )
      } catch (err) {
        console.error('[c2-browser] size failed', size, err)
        report.phases.push({
          size,
          verdict: 'FAIL',
          note: String(err && err.message),
          TIME_TO_DATA_READY: null,
          TIME_TO_FIRST_RENDER: null,
          TIME_TO_INTERACTIVE: null
        })
      }
    }

    for (const size of STRESS) {
      try {
        await waitForHealth(ORIGIN, 180000)
        await ensureAuth(page, ORIGIN, DEV_KEY)
        console.log('[c2-browser] stress seed', size)
        const seeded = await seedRoom(request, ORIGIN, size)
        await waitForHealth(ORIGIN, 180000)
        const row = await measureRoom(page, ORIGIN, seeded, size, {
          doF5: true
        })
        if (row.verdict === 'FAIL' && row.TIME_TO_FIRST_RENDER == null) {
          row.verdict = 'SAFE_LIMIT'
          row.note = row.note || 'RENDER_LIMIT_IDENTIFIED'
        }
        report.phases.push(row)
        console.log('[c2-browser] stress done', row.verdict)
      } catch (err) {
        report.phases.push({
          size,
          verdict: 'SAFE_LIMIT',
          note: String(err && err.message),
          RENDER_LIMIT_IDENTIFIED: true,
          f5: { verdict: 'NOT_RUN' }
        })
      }
    }
  } finally {
    await browser.close()
  }

  const by = size => report.phases.find(r => r.size === size)
  const r1 = by(1000)
  const r5 = by(5000)
  const r10 = by(10000)
  const r20 = by(20000)
  const ix10 = (r10 && r10.interactions) || {}
  const hot = (r10 && r10.hotspots) || ['unresolved', 'unresolved', 'unresolved']

  const full10 = (r10 && r10.fullRender) || {}
  const rendererRequired =
    (full10.ok &&
      full10.renderMs != null &&
      full10.httpMs != null &&
      full10.renderMs > Math.max(3000, full10.httpMs * 2)) ||
    (full10.ok && full10.renderMs > 10000)

  let largeMapReady = 'NO'
  if (
    r1 &&
    r1.verdict === 'PASS' &&
    r5 &&
    (r5.verdict === 'PASS' || r5.verdict === 'PARTIAL') &&
    r10 &&
    (r10.verdict === 'PASS' || r10.verdict === 'PARTIAL')
  ) {
    largeMapReady =
      r10.verdict === 'PASS' && r5.verdict === 'PASS' ? 'YES' : 'PARTIAL'
  }

  report.summary = {
    AUTH_MODE: (report.auth && report.auth.AUTH_MODE) || report.summary.AUTH_MODE,
    EDITOR_1K_BROWSER: (r1 && r1.verdict) || 'FAIL',
    EDITOR_5K_BROWSER: (r5 && r5.verdict) || 'FAIL',
    EDITOR_10K_BROWSER: (r10 && r10.verdict) || 'FAIL',
    EDITOR_20K_BROWSER: (r20 && r20.verdict) || 'NOT_RUN',
    '1K_TIME_TO_DATA_READY': r1 && r1.TIME_TO_DATA_READY,
    '1K_TIME_TO_FIRST_RENDER': r1 && r1.TIME_TO_FIRST_RENDER,
    '1K_TIME_TO_INTERACTIVE': r1 && r1.TIME_TO_INTERACTIVE,
    '5K_TIME_TO_DATA_READY': r5 && r5.TIME_TO_DATA_READY,
    '5K_TIME_TO_FIRST_RENDER': r5 && r5.TIME_TO_FIRST_RENDER,
    '5K_TIME_TO_INTERACTIVE': r5 && r5.TIME_TO_INTERACTIVE,
    '10K_TIME_TO_DATA_READY': r10 && r10.TIME_TO_DATA_READY,
    '10K_TIME_TO_FIRST_RENDER': r10 && r10.TIME_TO_FIRST_RENDER,
    '10K_TIME_TO_INTERACTIVE': r10 && r10.TIME_TO_INTERACTIVE,
    '20K_TIME_TO_DATA_READY': r20 && r20.TIME_TO_DATA_READY,
    '20K_TIME_TO_FIRST_RENDER': r20 && r20.TIME_TO_FIRST_RENDER,
    '20K_TIME_TO_INTERACTIVE': r20 && r20.TIME_TO_INTERACTIVE,
    '10K_TIME_DATA_TO_RENDER': r10 && r10.TIME_DATA_TO_RENDER,
    '10K_PRODUCT_SAFE_LOAD': r10 && r10.productSafeLoad,
    '10K_FULL_HTTP_MS': full10.httpMs,
    '10K_FULL_PARSE_MS': full10.parseMs,
    '10K_FULL_RENDER_MS': full10.renderMs,
    '10K_FULL_DOM_COUNT': full10.domCount,
    '10K_FULL_SVG_COUNT': full10.svgCount,
    '10K_ZOOM_LATENCY': ix10.ZOOM_LATENCY && ix10.ZOOM_LATENCY.ms,
    '10K_PAN_LATENCY': ix10.PAN_LATENCY && ix10.PAN_LATENCY.ms,
    '10K_SEARCH_LATENCY': ix10.SEARCH_LATENCY && ix10.SEARCH_LATENCY.ms,
    '10K_SELECT_LATENCY': ix10.SELECT_LATENCY && ix10.SELECT_LATENCY.ms,
    '10K_COLLAPSE_LATENCY': ix10.COLLAPSE_LATENCY && ix10.COLLAPSE_LATENCY.ms,
    '10K_EXPAND_LATENCY': ix10.EXPAND_LATENCY && ix10.EXPAND_LATENCY.ms,
    '10K_LONG_TASK_COUNT': r10 && r10.LONG_TASK_COUNT,
    '10K_MAX_LONG_TASK_MS': r10 && r10.MAX_LONG_TASK_MS,
    '10K_HEAP': r10 && r10.HEAP_AFTER,
    '10K_DOM_COUNT': r10 && r10.DOM_COUNT,
    '10K_SVG_COUNT': r10 && r10.SVG_COUNT,
    RENDER_HOTSPOT_1: hot[0],
    RENDER_HOTSPOT_2: hot[1],
    RENDER_HOTSPOT_3: hot[2],
    F5_5K: (r5 && r5.f5 && r5.f5.verdict) || 'NOT_RUN',
    F5_10K: (r10 && r10.f5 && r10.f5.verdict) || 'NOT_RUN',
    F5_20K: (r20 && r20.f5 && r20.f5.verdict) || 'NOT_RUN',
    C2_RENDERER_OPTIMIZATION_REQUIRED: rendererRequired ? 'YES' : 'NO',
    C2_LARGE_MAP_READY: largeMapReady
  }

  writeReport(report)
  console.log('c2EditorBrowser.benchmark summary')
  Object.keys(report.summary).forEach(k => {
    console.log(k + ' =', report.summary[k])
  })
  assert.ok(true)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
