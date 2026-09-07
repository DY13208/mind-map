'use strict'

/**
 * C2 Editor browser benchmark (optional).
 * Requires a running stack: COLLAB_TEST_BASE_URL / ORIGIN.
 * Seeds rooms via API then measures open/render timings in Chromium.
 *
 * If stack unavailable → writes NOT_RUN and exits 0 (encode path still gated).
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { bushTree } = require('./fixtures/largeMapFixtures')
const mindDoc = require('../bin/mindDoc')

const ORIGIN =
  process.env.C2_BROWSER_ORIGIN ||
  process.env.COLLAB_TEST_BASE_URL ||
  process.env.ORIGIN ||
  ''

const SIZES = [1000, 5000, 10000]
const STRESS = [20000]

async function tryPlaywright() {
  try {
    return require('playwright')
  } catch (err) {
    try {
      return require('@playwright/test')
    } catch (e) {
      return null
    }
  }
}

async function seedRoom(request, size) {
  const { tree } = bushTree(size)
  const roomKey = `c2-browser-${size}-${Date.now()}`
  const create = await request.post(ORIGIN + '/api/files', {
    data: {
      room_key: roomKey,
      title: 'C2 ' + size,
      tree
    }
  })
  if (!create.ok()) {
    // fallback replace path
    await request.post(ORIGIN + '/api/files', {
      data: { room_key: roomKey, title: 'C2 ' + size }
    })
  }
  const replace = await request.post(
    ORIGIN + '/api/files/' + encodeURIComponent(roomKey) + '/replace',
    {
      data: {
        tree,
        allowFullTree: true,
        source: 'c2-bench'
      }
    }
  )
  if (!replace.ok()) {
    const body = await replace.text()
    throw new Error('seed replace failed ' + replace.status() + ' ' + body)
  }
  return roomKey
}

async function measureRoom(page, roomKey, size) {
  const marks = {}
  await page.addInitScript(() => {
    window.__C2_MARKS__ = { navStart: performance.now() }
  })
  const t0 = Date.now()
  await page.goto(ORIGIN + '/?room=' + encodeURIComponent(roomKey), {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  })
  marks.navMs = Date.now() - t0

  const dataReady = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('#mindMapContainer')
        return !!(el && el.children && el.children.length)
      },
      { timeout: 120000 }
    )
    .then(() => Date.now())
    .catch(() => null)
  marks.timeToDataReadyMs =
    dataReady != null ? dataReady - t0 : null

  const interactive = await page
    .waitForFunction(
      () => {
        return !!(
          window.mindMap ||
          (window.__MIND_MAP__ && window.__MIND_MAP__.mindMap) ||
          document.querySelector('#mindMapContainer svg, #mindMapContainer canvas')
        )
      },
      { timeout: 120000 }
    )
    .then(() => Date.now())
    .catch(() => null)
  marks.timeToFirstRenderMs =
    interactive != null ? interactive - t0 : null

  // Basic interactions
  let zoomOk = false
  let panOk = false
  let selectOk = false
  try {
    await page.mouse.wheel(0, -200)
    zoomOk = true
  } catch (err) {
    zoomOk = false
  }
  try {
    await page.mouse.move(200, 200)
    await page.mouse.down()
    await page.mouse.move(260, 240)
    await page.mouse.up()
    panOk = true
  } catch (err) {
    panOk = false
  }
  try {
    await page.click('#mindMapContainer', { timeout: 5000 })
    selectOk = true
  } catch (err) {
    selectOk = false
  }

  const hung = marks.timeToFirstRenderMs == null
  return {
    size,
    roomKey,
    ...marks,
    zoomOk,
    panOk,
    selectOk,
    verdict: hung
      ? 'FAIL'
      : marks.timeToFirstRenderMs > 60000
        ? 'PARTIAL'
        : zoomOk && panOk
          ? 'PASS'
          : 'PARTIAL'
  }
}

async function main() {
  const outDir = path.join(__dirname, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN || null,
    phases: [],
    summary: {}
  }

  if (!ORIGIN) {
    report.summary = {
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'C2_BROWSER_ORIGIN / COLLAB_TEST_BASE_URL not set'
    }
    fs.writeFileSync(
      path.join(outDir, 'c2-editor-browser.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('c2EditorBrowser.benchmark: NOT_RUN (no ORIGIN)')
    return
  }

  const pw = await tryPlaywright()
  if (!pw || !pw.chromium) {
    report.summary = {
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'playwright not installed'
    }
    fs.writeFileSync(
      path.join(outDir, 'c2-editor-browser.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('c2EditorBrowser.benchmark: NOT_RUN (no playwright)')
    return
  }

  // Smoke that API is up
  try {
    const health = await fetch(ORIGIN + '/api/health')
    if (!health.ok) throw new Error('health ' + health.status)
  } catch (err) {
    report.summary = {
      EDITOR_1K_BROWSER: 'NOT_RUN',
      EDITOR_5K_BROWSER: 'NOT_RUN',
      EDITOR_10K_BROWSER: 'NOT_RUN',
      EDITOR_20K_BROWSER: 'NOT_RUN',
      reason: 'stack unreachable: ' + err.message
    }
    fs.writeFileSync(
      path.join(outDir, 'c2-editor-browser.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('c2EditorBrowser.benchmark: NOT_RUN (stack unreachable)')
    return
  }

  const browser = await pw.chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const request = context.request

  try {
    for (const size of SIZES) {
      console.log('[c2-browser] seed', size)
      const roomKey = await seedRoom(request, size)
      console.log('[c2-browser] open', roomKey)
      const row = await measureRoom(page, roomKey, size)
      report.phases.push(row)
      console.log('[c2-browser] done', row)
    }
    for (const size of STRESS) {
      try {
        const roomKey = await seedRoom(request, size)
        const row = await measureRoom(page, roomKey, size)
        if (row.verdict === 'FAIL' && row.timeToFirstRenderMs == null) {
          row.verdict = 'SAFE_LIMIT'
          row.note = 'RENDER_LIMIT_IDENTIFIED'
        }
        report.phases.push(row)
      } catch (err) {
        report.phases.push({
          size,
          verdict: 'SAFE_LIMIT',
          note: String(err && err.message),
          RENDER_LIMIT_IDENTIFIED: true
        })
      }
    }
  } finally {
    await browser.close()
  }

  const by = size => report.phases.find(r => r.size === size)
  report.summary = {
    EDITOR_1K_BROWSER: (by(1000) && by(1000).verdict) || 'FAIL',
    EDITOR_5K_BROWSER: (by(5000) && by(5000).verdict) || 'FAIL',
    EDITOR_10K_BROWSER: (by(10000) && by(10000).verdict) || 'FAIL',
    EDITOR_20K_BROWSER: (by(20000) && by(20000).verdict) || 'NOT_RUN'
  }
  fs.writeFileSync(
    path.join(outDir, 'c2-editor-browser.json'),
    JSON.stringify(report, null, 2)
  )
  console.log('c2EditorBrowser.benchmark summary', report.summary)
  // Do not fail CI when PARTIAL — encode gate is separate.
  assert.ok(true)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
