const { expect } = require('@playwright/test')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')

function graphHash(nodes) {
  const keys = Object.keys(nodes || {})
    .filter(uid => nodes[uid] && !nodes[uid].deleted)
    .sort()
  const parts = keys.map(uid => {
    const node = nodes[uid]
    const children = (node.children || []).slice().sort()
    return [
      uid,
      children.join(','),
      (node.data && node.data.text) || '',
      (node.data && node.data.note) || '',
      node.position || ''
    ].join('|')
  })
  let hash = 0
  const text = parts.join(';')
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  return { hash: hash.toString(16), count: keys.length }
}

function envPath() {
  return path.join(__dirname, '.runtime.json')
}

function readRuntime() {
  return JSON.parse(fs.readFileSync(envPath(), 'utf8'))
}

function writeRuntime(data) {
  fs.writeFileSync(envPath(), JSON.stringify(data, null, 2))
}

function roomKey(prefix = 'e2e') {
  return (prefix + '-' + randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9._-]/g, '-')
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'api failed')
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function defaultTree(title = 'E2E Root') {
  return {
    data: { uid: 'root', text: title },
    children: [
      { data: { uid: 'alpha', text: 'Alpha' }, children: [] },
      { data: { uid: 'beta', text: 'Beta' }, children: [] },
      {
        data: { uid: 'gamma', text: 'Gamma' },
        children: [{ data: { uid: 'delta', text: 'Delta' }, children: [] }]
      }
    ]
  }
}

async function createRoom(api, options = {}) {
  const key = options.roomKey || roomKey(options.prefix || 'e2e')
  const title = options.title || key
  await apiJson(api + '/api/files', {
    method: 'POST',
    headers: options.headers || {},
    body: JSON.stringify({
      room_key: key,
      title,
      tree: options.tree || defaultTree(title)
    })
  })
  return key
}

function hashFromFlat(list) {
  const nodes = {}
  ;(list || []).forEach(item => {
    if (!item || item.deleted) return
    nodes[item.uid] = {
      data: { text: item.text || '', note: item.note || '' },
      children: item.children || [],
      position: item.position || '',
      deleted: false
    }
  })
  return graphHash(nodes)
}

async function pgHash(api, room, headers = {}) {
  const data = await apiJson(
    api + '/api/files/' + encodeURIComponent(room) + '?format=nodes',
    { headers }
  )
  return hashFromFlat(data.nodes || [])
}

async function attachConsole(page) {
  const errors = []
  page.on('pageerror', err => {
    errors.push({ type: 'pageerror', text: String(err && err.message ? err.message : err) })
  })
  page.on('console', msg => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (/UNDO_CONFLICT|REDO_CONFLICT|REPLACE_CONFLICT|FORBIDDEN|403/.test(text)) return
    if (/__presence|\/collab\//.test(text)) return
    if (/502 \(Bad Gateway\)/.test(text)) return
    if (/Download the Vue Devtools/.test(text)) return
    errors.push({ type: 'console', text })
  })
  page.on('requestfailed', req => {
    const url = req.url()
    if (/\/collab-v2|\/socket\.io/.test(url) && /ERR_INTERNET_DISCONNECTED|NS_ERROR_FAILURE/.test(String(req.failure() && req.failure().errorText))) {
      return
    }
  })
  return errors
}

function assertCleanConsole(errors) {
  const serious = (errors || []).filter(item => {
    const text = item.text || ''
    return !/UNDO_CONFLICT|REDO_CONFLICT|REPLACE_CONFLICT|FORBIDDEN|ResizeObserver|__presence|\/collab\/|502 \(Bad Gateway\)/.test(
      text
    )
  })
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([])
}

async function assertServerAlive(runtime) {
  const api = runtime && runtime.api
  if (!api) throw new Error('E2E runtime missing; server never started')
  let res
  try {
    res = await fetch(api + '/api/health')
  } catch (err) {
    throw new Error(
      'COLLAB SERVER DOWN — stop suite: ' + (err && err.message)
    )
  }
  if (!res.ok) {
    throw new Error('COLLAB SERVER DOWN — health ' + res.status)
  }
  return res.json().catch(() => ({}))
}

function trackSockets(page) {
  const sockets = []
  page.on('websocket', ws => {
    sockets.push(ws.url())
  })
  return sockets
}

function assertNoV1Presence(sockets) {
  const v1 = (sockets || []).filter(url =>
    /\/collab\/|__presence/.test(String(url))
  )
  expect(v1, 'V2 must not open V1 /collab or __presence sockets').toEqual([])
}

async function waitForCollab(page) {
  await page.waitForSelector('[data-testid="mindmap-canvas"], #mindMapContainer', {
    timeout: 30000
  })
  await page.waitForSelector('.smm-node', { timeout: 30000 })
  try {
    await page.waitForFunction(() => {
      const state = window.__COLLAB_V2_STATE__
      const fn = window.__COLLAB_V2_STATUS__
      const snap = state || (typeof fn === 'function' ? fn() : null)
      return !!(snap && (snap.status === 'live' || snap.phase === 'LIVE'))
    }, null, { timeout: 30000 })
  } catch (err) {
    const snap = await page.evaluate(() => {
      return {
        state: window.__COLLAB_V2_STATE__ || null,
        status:
          typeof window.__COLLAB_V2_STATUS__ === 'function'
            ? window.__COLLAB_V2_STATUS__()
            : null,
        cooperating: !!document.querySelector(
          '[data-testid="collab-status"].cooperating'
        ),
        bootError: window.__COLLAB_V2_BOOT_ERROR__ || null,
        join: window.__COLLAB_V2_JOIN__ || null,
        apply: window.__COLLAB_V2_APPLY__ || null,
        runtime: window.__MIND_MAP_RUNTIME__ || null
      }
    })
    err.message += '\nV2 status=' + JSON.stringify(snap)
    throw err
  }
}

async function openRoom(page, origin, room, extraQuery = '') {
  const url = origin + '/#/?room=' + encodeURIComponent(room) + extraQuery
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForCollab(page)
}

async function focusBody(page) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.blur) active.blur()
    document.body.focus()
  })
}

async function prepareCanvasShortcut(page, stayOn) {
  if (stayOn) {
    const box = await stayOn.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }
  }
  await page.evaluate(() => {
    const svg = document.querySelector('#mindMapContainer svg, [data-testid="mindmap-canvas"] svg')
    if (svg) {
      svg.dispatchEvent(
        new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window })
      )
    }
    const active = document.activeElement
    if (active && active !== document.body && active.blur) active.blur()
    document.body.focus()
  })
}

async function hoverCanvas(page) {
  const selected = page
    .locator('[data-testid="mindmap-canvas"] .smm-node.active, #mindMapContainer .smm-node.active')
    .first()
  if (await selected.count()) {
    await prepareCanvasShortcut(page, selected)
    return
  }
  const any = page.locator('#mindMapContainer .smm-node, #mindMapContainer p').first()
  await prepareCanvasShortcut(page, (await any.count()) ? any : null)
}

async function clickNode(page, text) {
  const node = page
    .locator('[data-testid="mindmap-canvas"], #mindMapContainer')
    .getByText(text, { exact: true })
    .first()
  await expect(node).toBeVisible({ timeout: 15000 })
  const box = await node.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  } else {
    await node.click()
  }
  await prepareCanvasShortcut(page, node)
  return node
}

async function nodeTexts(page) {
  return page.locator('#mindMapContainer').evaluate(el => {
    const nodes = el.querySelectorAll(
      '.smm-text-node-wrap, .smm-richtext-node-wrap, .smm-node-text, p'
    )
    return Array.from(nodes)
      .map(node => (node.innerText || node.textContent || '').trim())
      .filter(Boolean)
  })
}

function canvasText(page, text) {
  return page
    .locator('[data-testid="mindmap-canvas"], #mindMapContainer')
    .getByText(text, { exact: true })
}

async function waitForText(page, text, timeout = 15000) {
  try {
    await expect(canvasText(page, text).first()).toBeVisible({ timeout })
  } catch (err) {
    const texts = await nodeTexts(page)
    err.message += '\nvisible texts: ' + JSON.stringify(texts)
    throw err
  }
}

async function waitForNoText(page, text, timeout = 15000) {
  await expect(canvasText(page, text)).toHaveCount(0, { timeout })
}

async function pressOnCanvas(page, key) {
  await prepareCanvasShortcut(page)
  await page.keyboard.press(key)
}

async function finishEdit(page) {
  const editor = page.locator('.smm-node-edit-wrap')
  if (await editor.count()) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
  }
  await page.locator('#mindMapContainer').click({ position: { x: 8, y: 8 } })
}

async function renameActive(page, text) {
  await pressOnCanvas(page, 'F2')
  const editor = page.locator('.smm-node-edit-wrap, [contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await finishEdit(page)
}

function walkMindMap() {
  return ({
    theme,
    layout,
    transform,
    selection,
    texts,
    readonly
  } = {})
}

async function uiState(page) {
  return page.evaluate(() => {
    function walk(vm, seen = new Set()) {
      if (!vm || seen.has(vm)) return null
      seen.add(vm)
      if (vm.mindMap && vm.mindMap.getTheme) return vm.mindMap
      for (const child of vm.$children || []) {
        const found = walk(child, seen)
        if (found) return found
      }
      return null
    }
    const root = document.querySelector('#app') && document.querySelector('#app').__vue__
    const mindMap = walk(root)
    if (!mindMap) return null
    const view = mindMap.view || {}
    const transform =
      (view.getTransform && view.getTransform()) ||
      view.transformData ||
      {}
    const texts = []
    const walkNode = node => {
      if (!node) return
      const text = node.getData && node.getData('text')
      if (text) texts.push(String(text).replace(/<[^>]+>/g, '').trim())
      ;(node.children || []).forEach(walkNode)
    }
    walkNode(mindMap.renderer && mindMap.renderer.root)
    return {
      theme: mindMap.getTheme && mindMap.getTheme(),
      layout: mindMap.getLayout && mindMap.getLayout(),
      scale: transform.scale || transform.zoom || 1,
      x: transform.state ? transform.state.x : transform.x || 0,
      y: transform.state ? transform.state.y : transform.y || 0,
      selection: (mindMap.renderer.activeNodeList || [])
        .map(node => node.getData && String(node.getData('text') || '').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean),
      texts,
      readonly: !!(mindMap.opt && mindMap.opt.readonly),
      searchOpen: !!document.querySelector('.searchContainer.show')
    }
  })
}

async function uiHash(page) {
  const state = await uiState(page)
  const texts = ((state && state.texts) || []).slice().sort()
  let hash = 0
  const raw = texts.join('|')
  for (let i = 0; i < raw.length; i++) hash = (hash * 33 + raw.charCodeAt(i)) >>> 0
  return { hash: hash.toString(16), count: texts.length, texts }
}

async function idbPending(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('mind-map-collab-v2', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!db.objectStoreNames.contains('outbox')) return []
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly')
      const req = tx.objectStore('outbox').getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    return rows.filter(item => item && item.status !== 'acknowledged')
  })
}

const TOOLBAR_TESTIDS = {
  同级节点: 'add-sibling',
  子节点: 'add-child',
  删除节点: 'delete-node',
  搜索: 'search',
  替换: 'replace',
  分享: 'share',
  导入: 'import',
  协同: 'cooperate',
  主题: 'theme',
  结构: 'layout',
  布局: 'layout',
  概要: 'generalization',
  外框: 'outer-frame',
  关联线: 'associative-line',
  备注: 'note',
  标签: 'tag',
  超链接: 'hyperlink',
  图片: 'image'
}

async function clickTestId(page, id) {
  const btn = page.locator('[data-testid="' + id + '"]:visible').first()
  await expect(btn).toBeVisible()
  await btn.click()
}

async function clickToolbar(page, label) {
  const id = TOOLBAR_TESTIDS[label] || label
  const byTestId = page.locator('[data-testid="' + id + '"]:visible').first()
  if (await byTestId.count()) {
    await expect(byTestId).toBeVisible()
    await byTestId.click()
    return
  }
  const btn = page
    .locator('.toolbarBtn:visible:not(.disabled)')
    .filter({ hasText: label })
    .first()
  await expect(btn).toBeVisible()
  await btn.click()
}

async function openCooperate(page) {
  await clickToolbar(page, '协同')
  await expect(page.locator('.cooperateDialog')).toBeVisible()
}

async function saveStatusText(page) {
  const visible = await page.locator('.cooperateDialog .saveState').count()
  if (!visible) await openCooperate(page)
  return page.locator('.cooperateDialog .saveState').innerText()
}

async function clickSidebar(page, name) {
  const id = TOOLBAR_TESTIDS[name] || name
  const byTestId = page.locator('[data-testid="' + id + '"]:visible').first()
  if (await byTestId.count()) {
    await byTestId.click()
    return
  }
  const item = page.locator('.triggerItem').filter({ hasText: name }).first()
  await expect(item).toBeVisible()
  await item.click()
}

async function lastSyncStatus(page) {
  return page.evaluate(() => {
    if (typeof window.__COLLAB_V2_STATUS__ === 'function') {
      return window.__COLLAB_V2_STATUS__()
    }
    return null
  })
}

async function waitForBuildStamp(page) {
  return page.evaluate(() => window.__MIND_MAP_BUILD__ || null)
}

async function setCookie(context, origin, token) {
  const parsed = new URL(origin)
  await context.addCookies([
    {
      name: 'mind_map_session',
      value: String(token || ''),
      domain: parsed.hostname,
      path: '/',
      httpOnly: true
    }
  ])
}

async function createIdentity(api, user) {
  return apiJson(api + '/api/auth/e2e-identity', {
    method: 'POST',
    body: JSON.stringify(user)
  })
}

async function postOp(page, roomKey, type, payload) {
  return page.evaluate(
    async ({ roomKey, type, payload }) => {
      const res = await fetch('/api/collab-v2/op', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          opId: crypto.randomUUID(),
          roomKey,
          type,
          payload
        })
      })
      return res.json()
    },
    { roomKey, type, payload }
  )
}

async function seedInserts(page, roomKey, count, prefix = 'gap-') {
  return page.evaluate(
    async ({ roomKey, count, prefix }) => {
      let failed = 0
      for (let i = 0; i < count; i++) {
        const res = await fetch('/api/collab-v2/op', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            opId: crypto.randomUUID(),
            roomKey,
            type: 'node.insert',
            payload: { parentUid: 'root', uid: prefix + i, text: 'Gap-' + i }
          })
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.ok === false) failed += 1
      }
      return { count, failed }
    },
    { roomKey, count, prefix }
  )
}

async function waitHashesMatch(api, room, pageA, pageB, timeout = 20000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    const [pg, a, b] = await Promise.all([
      pgHash(api, room),
      uiHash(pageA),
      uiHash(pageB)
    ])
    last = { pg, a, b }
    if (a.count === pg.count && b.count === pg.count && a.hash && b.hash) {
      if (a.count === b.count) return last
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return last
}

module.exports = {
  envPath,
  readRuntime,
  writeRuntime,
  roomKey,
  apiJson,
  defaultTree,
  createRoom,
  pgHash,
  hashFromFlat,
  attachConsole,
  assertCleanConsole,
  assertServerAlive,
  apiJson,
  trackSockets,
  assertNoV1Presence,
  waitForCollab,
  openRoom,
  hoverCanvas,
  clickNode,
  nodeTexts,
  waitForText,
  waitForNoText,
  pressOnCanvas,
  finishEdit,
  renameActive,
  uiState,
  uiHash,
  idbPending,
  clickToolbar,
  clickTestId,
  openCooperate,
  saveStatusText,
  clickSidebar,
  lastSyncStatus,
  waitForBuildStamp,
  setCookie,
  createIdentity,
  postOp,
  seedInserts,
  waitHashesMatch,
  walkMindMap,
  TOOLBAR_TESTIDS
}
