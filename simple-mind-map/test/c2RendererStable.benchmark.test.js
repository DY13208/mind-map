'use strict'

/**
 * Repeatable full-tree renderer benchmark for C2.
 *
 * The product editor intentionally safe-loads large maps. This benchmark opens
 * that real editor, fetches one authoritative full-tree fixture per size, then
 * applies a fresh clone to the same SimpleMindMap instance for every sample.
 * Clone/HTTP time is outside the measured interval.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { bushTree } = require('./fixtures/largeMapFixtures')

const ORIGIN = String(
  process.env.C2_BROWSER_ORIGIN || process.env.COLLAB_TEST_BASE_URL || ''
).replace(/\/$/, '')
const SIZES = String(process.env.C2_RENDER_SIZES || '1000,5000,10000')
  .split(',')
  .map(Number)
  .filter(Boolean)
const WARMUPS = Number(process.env.C2_RENDER_WARMUPS || 2)
const FORMAL_RUNS = Number(process.env.C2_RENDER_RUNS || 5)
const DEV_KEY = process.env.AUTH_DEV_BYPASS_KEY || readDevKeyFromEnvFile()

function readDevKeyFromEnvFile() {
  try {
    const line = fs
      .readFileSync(path.resolve(__dirname, '../../.env'), 'utf8')
      .split(/\r?\n/)
      .find(row => row.startsWith('AUTH_DEV_BYPASS_KEY='))
    return line ? line.slice('AUTH_DEV_BYPASS_KEY='.length).trim() : ''
  } catch (_) {
    return ''
  }
}

function command(name, args = []) {
  try {
    return execFileSync(name, args, { encoding: 'utf8' }).trim()
  } catch (_) {
    return null
  }
}

function quantile(values, q) {
  const a = values.slice().sort((x, y) => x - y)
  if (!a.length) return null
  const pos = (a.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return Number(a[lo].toFixed(2))
  return Number((a[lo] + (a[hi] - a[lo]) * (pos - lo)).toFixed(2))
}

function distribution(rows, field) {
  const values = rows.map(row => Number(row[field])).filter(Number.isFinite)
  return {
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    min: values.length ? Number(Math.min(...values).toFixed(2)) : null,
    max: values.length ? Number(Math.max(...values).toFixed(2)) : null
  }
}

async function playwrightModule() {
  try {
    return require('playwright')
  } catch (_) {
    return require('@playwright/test')
  }
}

async function login(page) {
  await page.goto(ORIGIN + '/files', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })
  const result = await page.evaluate(
    async ({ origin, key }) => {
      const me = await fetch(origin + '/api/auth/me', { credentials: 'include' })
        .then(res => res.json())
        .catch(() => ({}))
      if (me.authenticated) return { ok: true, via: 'session' }
      const res = await fetch(origin + '/api/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok && !!data.authenticated, status: res.status }
    },
    { origin: ORIGIN, key: DEV_KEY }
  )
  assert.ok(result.ok, 'developer login failed: ' + JSON.stringify(result))
}

async function seedRoom(request, size) {
  const { tree } = bushTree(size, 'c2s' + size + '-')
  const roomKey = 'c2-render-stable-' + size + '-' + Date.now()
  const clientId = 'c2-render-stable-' + size
  const create = await request.post(ORIGIN + '/api/files', {
    data: {
      room_key: roomKey,
      title: 'C2 Stable Renderer ' + size,
      clientId,
      tree: { data: { uid: 'root', text: 'Root', isRoot: true }, children: [] }
    },
    timeout: 120000
  })
  assert.ok(create.ok() || create.status() === 409, 'room create failed')
  const replace = await request.post(
    ORIGIN + '/api/files/' + encodeURIComponent(roomKey) + '/replace',
    {
      data: {
        tree,
        allowFullTree: true,
        source: 'c2-render-stable',
        clientId,
        type: 'map.replace'
      },
      timeout: 300000
    }
  )
  assert.ok(replace.ok(), 'room replace failed: ' + replace.status())
  return roomKey
}

async function openEditor(page, roomKey) {
  await page.goto(ORIGIN + '/?room=' + encodeURIComponent(roomKey), {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  })
  await page.waitForSelector('#mindMapContainer', { timeout: 60000 })
  await page.waitForFunction(
    () => {
      let el = document.querySelector('#mindMapContainer')
      while (el) {
        if (el.__vue__ && el.__vue__.mindMap) {
          window.__C2_STABLE_MM__ = el.__vue__.mindMap
          return true
        }
        el = el.parentElement
      }
      return false
    },
    { timeout: 120000 }
  )
  await page.waitForFunction(
    () => {
      const mm = window.__C2_STABLE_MM__
      return !!(
        mm &&
        mm.renderer &&
        mm.renderer.root &&
        !mm.renderer.isRendering &&
        typeof mm.renderer.root.getSize === 'function'
      )
    },
    { timeout: 120000 }
  )
  await page.waitForTimeout(250)
}

async function fetchTree(page, roomKey, size) {
  return page.evaluate(
    async ({ origin, roomKey, size }) => {
      const res = await fetch(
        origin +
          '/api/files/' +
          encodeURIComponent(roomKey) +
          '?format=full&max_nodes=' +
          size,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      )
      if (!res.ok) throw new Error('full tree HTTP ' + res.status)
      const data = await res.json()
      return data.tree
    },
    { origin: ORIGIN, roomKey, size }
  )
}

async function measureOnce(page, sourceTree, size, phase, index) {
  return page.evaluate(
    async ({ sourceTree, size, phase, index }) => {
      const mm = window.__C2_STABLE_MM__
      if (!mm) throw new Error('mind map unavailable')
      const tree = JSON.parse(JSON.stringify(sourceTree))
      const sampleNode =
        mm.renderer.root ||
        Object.values(mm.renderer.nodeCache || {})[0] ||
        Object.values(mm.renderer.lastNodeCache || {})[0]
      const rootProto = sampleNode && Object.getPrototypeOf(sampleNode)
      if (!rootProto || typeof rootProto.getSize !== 'function') {
        throw new Error('MindMapNode.getSize unavailable')
      }

      const profile = {
        getSize: [],
        types: {},
        textPaths: { plainCompatible: 0, rich: 0, normal: 0 },
        addHistoryCalls: 0
      }
      const caches = mm.commonCaches || {}
      if (caches.plainTextMeasureCache) caches.plainTextMeasureCache.clear()
      if (caches.plainTextMeasureCacheStats) {
        caches.plainTextMeasureCacheStats.hits = 0
        caches.plainTextMeasureCacheStats.misses = 0
      }
      const originalGetSize = rootProto.getSize
      const originalCreateTextNode = rootProto.createTextNode
      const originalCreateRichTextNode = rootProto.createRichTextNode
      const originalAddHistory = mm.command.addHistory

      const classify = node => {
        const data = (node && node.nodeData && node.nodeData.data) || {}
        if (data.image) return 'image'
        if (data.icon && data.icon.length) return 'icon'
        if (data.tag && data.tag.length) return 'tag'
        if (String(data.text || '').includes('ql-formula')) return 'formula'
        if (data.hyperlink) return 'hyperlink'
        if (data.richText) {
          const value = String(data.text == null ? '' : data.text).trim()
          const plainCompatible =
            (!!data.resetRichText && !/[<>\n\r]/.test(value)) ||
            /^<p>(?:[^<]|<br\s*\/?\s*>)*<\/p>$/i.test(value)
          if (mm.renderer.usePlainTextFastPath && plainCompatible) {
            return 'plain_compatible'
          }
          return 'rich_text'
        }
        return 'plain_text'
      }
      rootProto.getSize = function profiledGetSize(...args) {
        const t0 = performance.now()
        try {
          return originalGetSize.apply(this, args)
        } finally {
          const duration = performance.now() - t0
          profile.getSize.push(duration)
          const type = classify(this)
          const current = profile.types[type] || { count: 0, totalMs: 0 }
          current.count += 1
          current.totalMs += duration
          profile.types[type] = current
        }
      }
      rootProto.createTextNode = function profiledCreateTextNode(...args) {
        const data = (this.nodeData && this.nodeData.data) || {}
        if (args[1] === true) profile.textPaths.plainCompatible += 1
        else if (!data.richText) profile.textPaths.normal += 1
        return originalCreateTextNode.apply(this, args)
      }
      rootProto.createRichTextNode = function profiledCreateRichTextNode(...args) {
        profile.textPaths.rich += 1
        return originalCreateRichTextNode.apply(this, args)
      }
      mm.command.addHistory = function profiledAddHistory(...args) {
        profile.addHistoryCalls += 1
        return originalAddHistory.apply(this, args)
      }

      const longTasks = []
      const observer = new PerformanceObserver(list => {
        list.getEntries().forEach(entry => {
          longTasks.push({ start: entry.startTime, duration: entry.duration })
        })
      })
      try {
        observer.observe({ type: 'longtask', buffered: false })
      } catch (_) {
        /* unsupported browser */
      }

      if (typeof window.gc === 'function') window.gc()
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      const started = performance.now()
      let renderStarted = null
      let renderEnded = null
      let firstVisible = null
      const renderPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('render timeout')), 300000)
        const onStart = () => {
          if (renderStarted == null) renderStarted = performance.now()
        }
        const done = () => {
          if (renderStarted == null) return
          clearTimeout(timeout)
          renderEnded = performance.now()
          if (typeof mm.off === 'function') {
            mm.off('node_tree_render_start', onStart)
          }
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          resolve()
        }
        mm.on('node_tree_render_start', onStart)
        mm.on('node_tree_render_end', done)
      })
      requestAnimationFrame(() => {
        firstVisible = performance.now()
      })
      const callStart = performance.now()
      mm.setData(tree)
      const setDataReturned = performance.now()
      await renderPromise
      await new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
      const interactive = await new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(performance.now()), { timeout: 1000 })
        } else {
          setTimeout(() => resolve(performance.now()), 0)
        }
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      observer.disconnect()

      rootProto.getSize = originalGetSize
      rootProto.createTextNode = originalCreateTextNode
      rootProto.createRichTextNode = originalCreateRichTextNode
      mm.command.addHistory = originalAddHistory

      const relevantLongTasks = longTasks.filter(
        task => task.start >= started - 1 && task.start <= interactive
      )
      const getSizeSorted = profile.getSize.slice().sort((a, b) => a - b)
      const getSizeTotal = profile.getSize.reduce((sum, value) => sum + value, 0)
      const getSizeMedian = getSizeSorted.length
        ? getSizeSorted[Math.floor(getSizeSorted.length / 2)]
        : 0
      const measureStats = caches.plainTextMeasureCacheStats || {
        hits: 0,
        misses: 0
      }
      const measureTotal = measureStats.hits + measureStats.misses
      Object.keys(profile.types).forEach(type => {
        profile.types[type].totalMs = Number(profile.types[type].totalMs.toFixed(2))
      })
      return {
        size,
        phase,
        index,
        SETDATA: Number((setDataReturned - callStart).toFixed(2)),
        TIME_TO_FIRST_VISIBLE: Number(
          ((firstVisible || interactive) - started).toFixed(2)
        ),
        TIME_TO_INTERACTIVE: Number((interactive - started).toFixed(2)),
        TIME_TO_FULL_RENDER: Number((renderEnded - started).toFixed(2)),
        MAX_LONG_TASK: Number(
          Math.max(0, ...relevantLongTasks.map(task => task.duration)).toFixed(2)
        ),
        LONG_TASK_COUNT: relevantLongTasks.length,
        GET_SIZE_CALL_COUNT: profile.getSize.length,
        GET_SIZE_TOTAL_MS: Number(getSizeTotal.toFixed(2)),
        GET_SIZE_MEDIAN_MS: Number(getSizeMedian.toFixed(4)),
        GET_SIZE_BY_TYPE: profile.types,
        TEXT_PATHS: profile.textPaths,
        ADD_HISTORY_CALL_COUNT: profile.addHistoryCalls,
        MEASURE_CACHE_HIT_RATE: measureTotal
          ? Number(((measureStats.hits / measureTotal) * 100).toFixed(2))
          : 0,
        DOM_COUNT: document.querySelectorAll('#mindMapContainer *').length,
        deviceScaleFactor: window.devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight }
      }
    },
    { sourceTree, size, phase, index }
  )
}

async function main() {
  assert.ok(ORIGIN, 'C2_BROWSER_ORIGIN is required')
  assert.ok(DEV_KEY, 'AUTH_DEV_BYPASS_KEY is required')
  const pw = await playwrightModule()
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--js-flags=--expose-gc']
  })
  const version = browser.version()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  const report = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    environment: {
      cpu: os.cpus()[0] && os.cpus()[0].model,
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      platform: os.platform() + ' ' + os.release() + ' ' + os.arch(),
      node: process.version,
      browser: version,
      deviceScaleFactor: 1,
      viewport: { width: 1440, height: 900 },
      baseCommit: command('git', ['rev-parse', 'HEAD'])
    },
    config: { sizes: SIZES, warmups: WARMUPS, formalRuns: FORMAL_RUNS },
    sizes: {}
  }

  try {
    await login(page)
    for (const size of SIZES) {
      console.log('[c2-stable] seed', size)
      const roomKey = await seedRoom(context.request, size)
      const rows = []
      for (let i = 0; i < WARMUPS + FORMAL_RUNS; i++) {
        const phase = i < WARMUPS ? 'warmup' : 'formal'
        const index = i < WARMUPS ? i + 1 : i - WARMUPS + 1
        console.log('[c2-stable]', size, phase, index)
        const samplePage = await context.newPage()
        samplePage.setDefaultTimeout(120000)
        let row
        try {
          await openEditor(samplePage, roomKey)
          const tree = await fetchTree(samplePage, roomKey, size)
          row = await measureOnce(samplePage, tree, size, phase, index)
          rows.push(row)
        } finally {
          await samplePage.close()
        }
        console.log(
          '[c2-stable] result',
          size,
          phase,
          index,
          'full=',
          row.TIME_TO_FULL_RENDER,
          'getSize=',
          row.GET_SIZE_TOTAL_MS,
          'historyCalls=',
          row.ADD_HISTORY_CALL_COUNT
        )
      }
      const formal = rows.filter(row => row.phase === 'formal')
      const metrics = {}
      ;[
        'SETDATA',
        'TIME_TO_FIRST_VISIBLE',
        'TIME_TO_INTERACTIVE',
        'TIME_TO_FULL_RENDER',
        'MAX_LONG_TASK',
        'LONG_TASK_COUNT',
        'GET_SIZE_CALL_COUNT',
        'GET_SIZE_TOTAL_MS',
        'GET_SIZE_MEDIAN_MS',
        'ADD_HISTORY_CALL_COUNT',
        'MEASURE_CACHE_HIT_RATE'
      ].forEach(field => {
        metrics[field] = distribution(formal, field)
      })
      const full = metrics.TIME_TO_FULL_RENDER
      report.sizes[size] = {
        roomKey,
        rows,
        metrics,
        varianceRatio:
          full.min > 0 ? Number((full.max / full.min).toFixed(3)) : null,
        getSizeByType: formal[formal.length - 1].GET_SIZE_BY_TYPE,
        textPaths: formal[formal.length - 1].TEXT_PATHS
      }
    }
  } finally {
    await browser.close()
  }

  const outDir = path.join(__dirname, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const label = process.env.C2_RENDER_LABEL || 'current'
  const outPath = path.join(outDir, 'c2-renderer-stable-' + label + '.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log('[c2-stable] wrote', outPath)
  Object.keys(report.sizes).forEach(size => {
    const row = report.sizes[size]
    console.log(
      '[c2-stable] summary',
      size,
      JSON.stringify({
        full: row.metrics.TIME_TO_FULL_RENDER,
        maxLongTask: row.metrics.MAX_LONG_TASK,
        varianceRatio: row.varianceRatio,
        getSize: row.metrics.GET_SIZE_TOTAL_MS,
        textPaths: row.textPaths
      })
    )
  })
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = {
  playwrightModule,
  login,
  seedRoom,
  openEditor,
  fetchTree
}
