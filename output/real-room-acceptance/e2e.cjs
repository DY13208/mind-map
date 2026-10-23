'use strict'
/**
 * Real browser + local docker backend E2E.
 * Uses existing isolated C2/p0 rooms. Does not create accounts or touch
 * production-titled rooms. Writes only personal view-state (expand).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require(path.join(
  __dirname,
  '../../simple-mind-map/node_modules/@playwright/test'
))

const ORIGIN = process.env.E2E_ORIGIN || 'http://127.0.0.1:8989'
const API = process.env.E2E_API || 'http://127.0.0.1:8990'
const ROOM_A = 'c2-profile-1000-1788764665084'
const ROOM_B = 'c2-profile-1000-1788764369215'
const ROOM_5K = 'c2-browser-5000-1788761408598'
const ROOM_10K = 'c2-browser-10000-1788761472060'
const FLAGS_ON =
  'scopedRemoteLineRender,canvasTextMeasure,scopedRemoteGeometry,deferDraftCopy,analyticEdgeBounds,lazyOffscreenPaint'
const OUT = path.join(__dirname, 'results.json')
const envPath = path.join(__dirname, '../../.env')

function loadEnv() {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (process.env[k] === undefined) process.env[k] = v
  }
}

function percentile(values, p) {
  const arr = values.filter(n => Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (!arr.length) return null
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))
  return Math.round(arr[idx] * 10) / 10
}

async function login(origin) {
  const key = process.env.AUTH_DEV_BYPASS_KEY
  const res = await fetch(origin + '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ key })
  })
  const body = await res.json()
  const raw = res.headers.get('set-cookie') || ''
  const cookie = raw.split(';')[0]
  if (!res.ok || !body.authenticated || !cookie) {
    throw new Error('dev-login failed: ' + res.status + ' ' + JSON.stringify({ authenticated: body.authenticated }))
  }
  return {
    cookie,
    userId: body.user && body.user.id,
    userName: body.user && body.user.name
  }
}

async function apiJson(origin, cookie, url, options = {}) {
  const res = await fetch(origin + url, {
    method: options.method || 'GET',
    headers: {
      cookie,
      Origin: origin,
      Accept: 'application/json',
      'content-type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function roomUrl(room, flags) {
  const q = new URLSearchParams({ room })
  if (flags) q.set('perfFlags', flags)
  return ORIGIN + '/?' + q.toString()
}

async function attachCookie(context, cookieHeader) {
  const [name, ...rest] = cookieHeader.split('=')
  const value = rest.join('=')
  const url = new URL(ORIGIN)
  await context.addCookies([
    {
      name,
      value,
      domain: url.hostname,
      path: '/',
      httpOnly: true
    }
  ])
}

function pageHelpers() {
  return {
    findVm(pred) {
      const root = document.querySelector('#app') && document.querySelector('#app').__vue__
      const stack = root ? [root] : []
      while (stack.length) {
        const vm = stack.pop()
        if (!vm) continue
        if (pred(vm)) return vm
        const kids = vm.$children || []
        for (let i = 0; i < kids.length; i++) stack.push(kids[i])
      }
      return null
    },
    getMindMap() {
      const vm = this.findVm(v => v.mindMap && v.mindMap.renderer)
      return vm && vm.mindMap
    },
    getCooperate() {
      return this.findVm(
        v =>
          v.personalExpandState != null ||
          v.personalExpandOverviewFrozen === true ||
          v.personalExpandOverviewFrozen === false
      )
    },
    walkExpand(node, out) {
      if (!node) return
      const data = node.data || (node.nodeData && node.nodeData.data)
      if (data && data.uid) out[data.uid] = data.expand !== false
      const children = node.children || []
      for (let i = 0; i < children.length; i++) this.walkExpand(children[i], out)
    },
    expandMap() {
      const mm = this.getMindMap()
      const out = {}
      if (mm && mm.renderer) this.walkExpand(mm.renderer.renderTree, out)
      return out
    },
    firstCollapsible() {
      const mm = this.getMindMap()
      let hit = null
      const walk = node => {
        if (hit || !node) return
        const data = node.data || (node.nodeData && node.nodeData.data)
        const children = node.children || []
        if (data && data.uid && data.uid !== 'root' && children.length) {
          hit = {
            uid: data.uid,
            text: String(data.text || ''),
            expand: data.expand !== false,
            childUid: children[0].data && children[0].data.uid,
            childText: String((children[0].data && children[0].data.text) || '')
          }
        }
        children.forEach(walk)
      }
      if (mm && mm.renderer) walk(mm.renderer.renderTree)
      return hit
    },
    nodeCount() {
      return Object.keys(this.expandMap()).length
    }
  }
}

async function waitReady(page, room, timeout = 240000) {
  await page.waitForFunction(
    expected => {
      const root = document.querySelector('#app') && document.querySelector('#app').__vue__
      if (!root) return false
      const stack = [root]
      let mm = null
      let coop = null
      while (stack.length) {
        const vm = stack.pop()
        if (!vm) continue
        if (vm.mindMap && vm.mindMap.renderer) mm = vm.mindMap
        if (Object.prototype.hasOwnProperty.call(vm, 'connected')) coop = vm
        const kids = vm.$children || []
        for (let i = 0; i < kids.length; i++) stack.push(kids[i])
      }
      if (!mm || !coop) return false
      if (expected && coop.roomName && coop.roomName !== expected) return false
      if (!coop.connected) return false
      if (coop.largeMapInitialOverview) return false
      if (coop.personalExpandOverviewFrozen) return false
      if (coop.personalExpandApplying) return false
      return !!(mm.renderer && mm.renderer.renderTree)
    },
    room || null,
    { timeout }
  )
  await page.waitForTimeout(600)
}

async function snapshot(page) {
  return page.evaluate(() => {
    const helpers = {
      findVm(pred) {
        const root = document.querySelector('#app') && document.querySelector('#app').__vue__
        const stack = root ? [root] : []
        while (stack.length) {
          const vm = stack.pop()
          if (!vm) continue
          if (pred(vm)) return vm
          const kids = vm.$children || []
          for (let i = 0; i < kids.length; i++) stack.push(kids[i])
        }
        return null
      }
    }
    const coop = helpers.findVm(
      v => Object.prototype.hasOwnProperty.call(v, 'personalExpandOverviewFrozen')
    )
    const edit = helpers.findVm(v => v.mindMap && v.mindMap.renderer)
    const mm = edit && edit.mindMap
    const expand = {}
    const walk = node => {
      if (!node) return
      const data = node.data || (node.nodeData && node.nodeData.data)
      if (data && data.uid) expand[data.uid] = data.expand !== false
      ;(node.children || []).forEach(walk)
    }
    if (mm && mm.renderer) walk(mm.renderer.renderTree)
    let collapsible = null
    const walk2 = node => {
      if (collapsible || !node) return
      const data = node.data || (node.nodeData && node.nodeData.data)
      const children = node.children || []
      const rootUid = mm.renderer.renderTree.data && mm.renderer.renderTree.data.uid
      if (
        data &&
        data.uid &&
        data.uid !== rootUid &&
        (children.length || data.hasMore || data._partial)
      ) {
        collapsible = {
          uid: data.uid,
          text: String(data.text || '').slice(0, 80),
          expand: data.expand !== false,
          childUid: children[0] && children[0].data && children[0].data.uid,
          childText: String((children[0] && children[0].data && children[0].data.text) || '').slice(0, 80)
        }
      }
      children.forEach(walk2)
    }
    if (mm && mm.renderer) walk2(mm.renderer.renderTree)
    if (!collapsible && mm.renderer && mm.renderer.renderTree && mm.renderer.renderTree.children) {
      const first = mm.renderer.renderTree.children[0]
      const data = first && (first.data || (first.nodeData && first.nodeData.data))
      if (data && data.uid) {
        collapsible = {
          uid: data.uid,
          text: String(data.text || '').slice(0, 80),
          expand: data.expand !== false,
          childUid: first.children && first.children[0] && first.children[0].data && first.children[0].data.uid,
          childText: String((first.children && first.children[0] && first.children[0].data && first.children[0].data.text) || '').slice(0, 80)
        }
      }
    }
    return {
      nodeCount: Object.keys(expand).length,
      expand,
      collapsible,
      overviewFrozen: !!(coop && coop.personalExpandOverviewFrozen),
      overviewActive: !!(coop && coop.largeMapInitialOverview),
      preference: (coop && coop.personalExpandState) || {},
      userId: coop && coop.userId,
      room: coop && coop.roomName
    }
  })
}

async function toggleExpand(page, uid, value) {
  return page.evaluate(
    ({ uid, value }) => {
      const root = document.querySelector('#app') && document.querySelector('#app').__vue__
      const stack = root ? [root] : []
      let mm = null
      while (stack.length) {
        const vm = stack.pop()
        if (vm && vm.mindMap && vm.mindMap.renderer) {
          mm = vm.mindMap
          break
        }
        ;(vm.$children || []).forEach(c => stack.push(c))
      }
      if (!mm) throw new Error('mindMap missing')
      let target =
        (mm.renderer.findNodeByUid && mm.renderer.findNodeByUid(uid)) || null
      if (!target || typeof target.getData !== 'function') {
        const walk = node => {
          if (target || !node) return
          if (node.getData && node.getData('uid') === uid) target = node
          ;(node.children || []).forEach(walk)
        }
        walk(mm.renderer.root)
      }
      if (!target || typeof target.getData !== 'function') {
        throw new Error('uid not mounted: ' + uid)
      }
      const started = performance.now()
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('expand timeout')), 60000)
        const done = () => {
          clearTimeout(t)
          mm.off('node_tree_render_end', done)
          mm.off('render_complete', done)
          resolve({ ms: performance.now() - started, uid, value })
        }
        mm.on('node_tree_render_end', done)
        mm.on('render_complete', done)
        mm.execCommand('SET_NODE_EXPAND', target, value)
      })
    },
    { uid, value }
  )
}

async function setNodeText(page, uid, text) {
  return page.evaluate(
    ({ uid, text }) => {
      const root = document.querySelector('#app') && document.querySelector('#app').__vue__
      const stack = root ? [root] : []
      let mm = null
      while (stack.length) {
        const vm = stack.pop()
        if (vm && vm.mindMap && vm.mindMap.renderer) {
          mm = vm.mindMap
          break
        }
        ;(vm.$children || []).forEach(c => stack.push(c))
      }
      let target =
        (mm.renderer.findNodeByUid && mm.renderer.findNodeByUid(uid)) || null
      if (!target) {
        const walk = node => {
          if (target || !node) return
          if (node.getData && node.getData('uid') === uid) target = node
          ;(node.children || []).forEach(walk)
        }
        walk(mm.renderer.root)
      }
      const started = performance.now()
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('text timeout')), 60000)
        const done = () => {
          clearTimeout(t)
          mm.off('node_tree_render_end', done)
          resolve({ ms: performance.now() - started })
        }
        mm.on('node_tree_render_end', done)
        mm.execCommand('SET_NODE_TEXT', target, text)
      })
    },
    { uid, text }
  )
}

async function searchText(page, text) {
  return page.evaluate(async text => {
    const root = document.querySelector('#app') && document.querySelector('#app').__vue__
    const stack = root ? [root] : []
    let mm = null
    while (stack.length) {
      const vm = stack.pop()
      if (vm && vm.mindMap && vm.mindMap.search) {
        mm = vm.mindMap
        break
      }
      ;(vm.$children || []).forEach(c => stack.push(c))
    }
    if (!mm) return { ok: false, reason: 'no search plugin' }
    const events = []
    const onChange = meta => events.push(meta || {})
    mm.on('personal_expand_change', onChange)
    try {
      if (typeof mm.search.search === 'function') {
        mm.search.search(text)
      } else if (typeof mm.search.searchNode === 'function') {
        mm.search.searchNode(text)
      }
      await new Promise(r => setTimeout(r, 800))
      return { ok: true, events }
    } finally {
      mm.off('personal_expand_change', onChange)
    }
  }, text)
}

async function openRoom(page, room, flags) {
  await page.goto(roomUrl(room, flags), { waitUntil: 'domcontentloaded', timeout: 120000 })
  await waitReady(page, room, 300000)
  return snapshot(page)
}

async function main() {
  loadEnv()
  const report = {
    kind: 'real-browser-server-e2e',
    startedAt: new Date().toISOString(),
    origin: ORIGIN,
    api: API,
    browser: 'Chromium via Playwright',
    cases: {},
    untested: [],
    blockers: []
  }

  const originLogin = await login(ORIGIN).catch(err => ({ error: err.message }))
  if (originLogin.error) {
    report.blockers.push('dev-login on current frontend failed: ' + originLogin.error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }
  report.user = { id: originLogin.userId, name: originLogin.userName }
  const cookie = originLogin.cookie

  const viewA0 = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/view-state`)
  const infoA = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/info`)
  report.rooms = {
    A: { key: ROOM_A, infoStatus: infoA.status, viewStatus: viewA0.status },
    B: { key: ROOM_B }
  }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await attachCookie(context, cookie)
  const page = await context.newPage()
  page.setDefaultTimeout(180000)

  try {
    // 1 + 6 + 7 on room A (1000, overview likely)
    const first = await openRoom(page, ROOM_A, '')
    report.cases.openA = {
      kind: 'real-e2e',
      nodeCount: first.nodeCount,
      overviewActive: first.overviewActive,
      overviewFrozen: first.overviewFrozen,
      collapsible: first.collapsible
    }
    saveReport(report)

    // Wait overview to finish if it started
    if (first.overviewActive || first.overviewFrozen) {
      await page.waitForFunction(() => {
        const root = document.querySelector('#app') && document.querySelector('#app').__vue__
        const stack = root ? [root] : []
        while (stack.length) {
          const vm = stack.pop()
          if (Object.prototype.hasOwnProperty.call(vm, 'largeMapInitialOverview')) {
            return vm.largeMapInitialOverview === false && vm.personalExpandOverviewFrozen === false
          }
          ;(vm.$children || []).forEach(c => stack.push(c))
        }
        return false
      }, null, { timeout: 180000 }).catch(() => {})
    }
    const afterOverview = await snapshot(page)
    report.cases.overviewExit = {
      kind: 'real-e2e',
      afterActive: afterOverview.overviewActive,
      afterFrozen: afterOverview.overviewFrozen,
      nodeCount: afterOverview.nodeCount
    }

    const target = afterOverview.collapsible
    if (!target) {
      report.cases.userExpand = { kind: 'real-e2e', ok: false, reason: 'no collapsible node' }
    } else {
      const want = !target.expand
      const timed = await toggleExpand(page, target.uid, want)
      await page.waitForTimeout(500)
      const mid = await snapshot(page)
      report.cases.userExpand = {
        kind: 'real-e2e',
        uid: target.uid,
        want,
        tree: mid.expand[target.uid],
        preference: mid.preference[target.uid],
        ms: timed.ms
      }

      // 1 F5
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitReady(page, ROOM_A, 300000)
      if (first.overviewActive || first.overviewFrozen) {
        await page.waitForTimeout(2000)
      }
      await page.waitForTimeout(1200)
      const afterF5 = await snapshot(page)
      const viewAfter = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/view-state`)
      report.cases.f5 = {
        kind: 'real-e2e',
        uid: target.uid,
        want,
        tree: afterF5.expand[target.uid],
        preference: afterF5.preference[target.uid],
        server: viewAfter.data && viewAfter.data.state && viewAfter.data.state.expand
          ? viewAfter.data.state.expand[target.uid]
          : undefined,
        ok: afterF5.expand[target.uid] === want || afterF5.preference[target.uid] === want
      }

      // 2 leave and re-enter
      await page.goto(ORIGIN + '/files', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(800)
      const reentered = await openRoom(page, ROOM_A, '')
      await page.waitForTimeout(1500)
      const afterReenter = await snapshot(page)
      report.cases.reenter = {
        kind: 'real-e2e',
        uid: target.uid,
        want,
        tree: afterReenter.expand[target.uid],
        preference: afterReenter.preference[target.uid],
        ok:
          afterReenter.expand[target.uid] === want ||
          afterReenter.preference[target.uid] === want
      }

      // 6 search reveal must not persist
      const beforeSearch = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/view-state`)
      const beforeMap =
        (beforeSearch.data && beforeSearch.data.state && beforeSearch.data.state.expand) || {}
      const snap = await snapshot(page)
      const searchWord = (snap.collapsible && snap.collapsible.childText) || target.childText
      const searchRes = await searchText(page, searchWord)
      await page.waitForTimeout(800)
      const afterSearchPref = await snapshot(page)
      const afterSearchView = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/view-state`)
      const afterMap =
        (afterSearchView.data && afterSearchView.data.state && afterSearchView.data.expand) ||
        (afterSearchView.data && afterSearchView.data.state && afterSearchView.data.state.expand) ||
        {}
      const revealOnly = (searchRes.events || []).every(
        e => !e || e.source === 'reveal' || e.source === 'overview'
      )
      report.cases.search = {
        kind: 'real-e2e',
        word: String(searchWord || '').slice(0, 40),
        events: searchRes.events,
        revealOnly,
        serverChanged: JSON.stringify(beforeMap) !== JSON.stringify(afterMap)
      }

      // user collapse during/after search
      const again = await snapshot(page)
      if (again.collapsible) {
        const collapseWant = false
        await toggleExpand(page, again.collapsible.uid, collapseWant)
        await page.waitForTimeout(500)
        const afterUser = await snapshot(page)
        report.cases.searchThenUser = {
          kind: 'real-e2e',
          uid: again.collapsible.uid,
          tree: afterUser.expand[again.collapsible.uid],
          preference: afterUser.preference[again.collapsible.uid],
          ok: afterUser.preference[again.collapsible.uid] === collapseWant
        }
      }
    }

    // 4 A→B→A
    const snapA = await snapshot(page)
    const uidA = snapA.collapsible && snapA.collapsible.uid
    const prefA = uidA ? snapA.preference[uidA] : null
    const openedB = await openRoom(page, ROOM_B, '')
    await page.waitForTimeout(1200)
    const snapB = await snapshot(page)
    const uidB = snapB.collapsible && snapB.collapsible.uid
    if (uidB) await toggleExpand(page, uidB, !(snapB.expand[uidB] === true))
    await page.waitForTimeout(600)
    const snapB2 = await snapshot(page)
    const backA = await openRoom(page, ROOM_A, '')
    await page.waitForTimeout(1500)
    const snapA2 = await snapshot(page)
    report.cases.roomSwitch = {
      kind: 'real-e2e',
      roomA: ROOM_A,
      roomB: ROOM_B,
      prefABefore: prefA,
      prefAAfter: uidA ? snapA2.preference[uidA] : null,
      roomBChanged: uidB ? snapB2.preference[uidB] : null,
      ok: uidA ? snapA2.preference[uidA] === prefA : false,
      counts: { A: snapA2.nodeCount, B: snapB2.nodeCount }
    }

    // 8 late GET: slow first GET, user expands before it returns
    await page.route('**/api/files/*/view-state', async route => {
      try {
        if (route.request().method() === 'GET') {
          await new Promise(r => setTimeout(r, 2500))
        }
        await route.continue()
      } catch (err) {
        if (!/already handled|intercepted/i.test(String(err && err.message))) throw err
      }
    })
    await page.goto(roomUrl(ROOM_A, ''), { waitUntil: 'domcontentloaded' })
    await waitReady(page, ROOM_A, 300000)
    const lateSnap = await snapshot(page)
    const lateUid = lateSnap.collapsible && lateSnap.collapsible.uid
    if (lateUid) {
      const want = !lateSnap.expand[lateUid]
      await toggleExpand(page, lateUid, want)
      await page.waitForTimeout(2800)
      const afterLate = await snapshot(page)
      report.cases.lateGet = {
        kind: 'real-e2e',
        uid: lateUid,
        want,
        preference: afterLate.preference[lateUid],
        tree: afterLate.expand[lateUid],
        ok: afterLate.preference[lateUid] === want
      }
    } else {
      report.cases.lateGet = { kind: 'real-e2e', ok: false, reason: 'no collapsible' }
    }
    await page.unroute('**/api/files/*/view-state')

    // 8 room-switch race: start open B then quickly open A
    const raceB = page.goto(roomUrl(ROOM_B, ''), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(80)
    await page.goto(roomUrl(ROOM_A, ''), { waitUntil: 'domcontentloaded' })
    await waitReady(page, ROOM_A, 300000)
    await page.waitForTimeout(1500)
    const raceSnap = await snapshot(page)
    report.cases.fastSwitch = {
      kind: 'real-e2e',
      landedRoom: raceSnap.room,
      ok: raceSnap.room === ROOM_A,
      nodeCount: raceSnap.nodeCount
    }
    await raceB.catch(() => {})

    // 9 two tabs
    const tab2 = await context.newPage()
    await openRoom(tab2, ROOM_A, '')
    await page.waitForTimeout(800)
    const t1 = await snapshot(page)
    const t2 = await snapshot(tab2)
    const sharedUid = (t1.collapsible && t1.collapsible.uid) || (t2.collapsible && t2.collapsible.uid)
    if (sharedUid) {
      await toggleExpand(page, sharedUid, true)
      await tab2.waitForTimeout(200)
      await toggleExpand(tab2, sharedUid, false)
      await page.waitForTimeout(800)
      const s1 = await snapshot(page)
      const s2 = await snapshot(tab2)
      const server = await apiJson(ORIGIN, cookie, `/api/files/${ROOM_A}/view-state`)
      report.cases.multiTab = {
        kind: 'real-e2e',
        uid: sharedUid,
        tab1: s1.preference[sharedUid],
        tab2: s2.preference[sharedUid],
        localStorageSame:
          (await page.evaluate(() => {
            const keys = Object.keys(localStorage).filter(k => k.includes('personal-expand'))
            return keys.map(k => localStorage.getItem(k))
          })).join('|') ===
          (await tab2.evaluate(() => {
            const keys = Object.keys(localStorage).filter(k => k.includes('personal-expand'))
            return keys.map(k => localStorage.getItem(k))
          })).join('|'),
        server:
          server.data && server.data.state && server.data.state.expand
            ? server.data.state.expand[sharedUid]
            : undefined,
        observed: 'same-origin localStorage is shared; last persist/PATCH wins'
      }
    }
    await tab2.close()

    // 10 flags off vs on: search + expand + undo text + export svg bytes
    async function featurePass(flags) {
      const snap0 = await openRoom(page, ROOM_A, flags)
      await page.waitForTimeout(1000)
      const col = (await snapshot(page)).collapsible
      let expandMs = null
      if (col) {
        const t = await toggleExpand(page, col.uid, !col.expand)
        expandMs = t.ms
      }
      const textUid = col && col.uid
      let textMs = null
      if (textUid) {
        const t = await setNodeText(page, textUid, 'e2e-temp-' + Date.now())
        textMs = t.ms
        await page.evaluate(() => {
          const root = document.querySelector('#app').__vue__
          const stack = [root]
          while (stack.length) {
            const vm = stack.pop()
            if (vm && vm.mindMap) {
              vm.mindMap.execCommand('BACK')
              return
            }
            ;(vm.$children || []).forEach(c => stack.push(c))
          }
        })
        await page.waitForTimeout(400)
      }
      const exportInfo = await page.evaluate(async () => {
        const root = document.querySelector('#app').__vue__
        const stack = [root]
        let mm = null
        while (stack.length) {
          const vm = stack.pop()
          if (vm && vm.mindMap) {
            mm = vm.mindMap
            break
          }
          ;(vm.$children || []).forEach(c => stack.push(c))
        }
        const exp = mm.doExport || mm.export || (mm.exportPlugin && mm.exportPlugin.export)
        if (!exp) return { ok: false, error: 'no export api' }
        try {
          const svg = await exp.call(mm, 'svg', false)
          const str = typeof svg === 'string' ? svg : String(svg)
          return { ok: true, svgBytes: str.length }
        } catch (err) {
          return { ok: false, error: String(err && err.message) }
        }
      })
      const hasMini = await page.evaluate(() => !!document.querySelector('svg'))
      return {
        nodeCount: snap0.nodeCount,
        expandMs,
        textMs,
        export: exportInfo,
        svgPresent: hasMini
      }
    }
    const off = await featurePass('')
    const on = await featurePass(FLAGS_ON)
    report.cases.flags = {
      kind: 'real-e2e',
      off,
      on,
      exportBytesEqual: off.export && on.export && off.export.svgBytes === on.export.svgBytes
    }

    // Performance on 5k / 10k (no exact 3k/6k rooms)
    async function perfRoom(room, flags, label) {
      const samples = { expand: [], text: [] }
      const t0 = Date.now()
      const opened = await openRoom(page, room, flags)
      const openMs = Date.now() - t0
      await page.waitForTimeout(1500)
      const snap = await snapshot(page)
      const uid = snap.collapsible && snap.collapsible.uid
      if (uid) {
        for (let i = 0; i < 4; i++) {
          const a = await toggleExpand(page, uid, i % 2 === 0)
          samples.expand.push(a.ms)
        }
        const original = snap.collapsible.text
        for (let i = 0; i < 3; i++) {
          const a = await setNodeText(page, uid, original + '-' + i)
          samples.text.push(a.ms)
        }
        await page.evaluate(() => {
          const root = document.querySelector('#app').__vue__
          const stack = [root]
          while (stack.length) {
            const vm = stack.pop()
            if (vm && vm.mindMap) {
              vm.mindMap.execCommand('BACK')
              vm.mindMap.execCommand('BACK')
              vm.mindMap.execCommand('BACK')
              return
            }
            ;(vm.$children || []).forEach(c => stack.push(c))
          }
        })
      }
      return {
        room,
        label,
        flags: flags || 'off',
        actualNodes: snap.nodeCount,
        openMs,
        overviewActiveOnOpen: opened.overviewActive,
        expandP50: percentile(samples.expand, 50),
        expandP95: percentile(samples.expand, 95),
        textP50: percentile(samples.text, 50),
        textP95: percentile(samples.text, 95),
        expandSamples: samples.expand.map(n => Math.round(n)),
        textSamples: samples.text.map(n => Math.round(n))
      }
    }

    report.cases.perf = {
      kind: 'real-e2e',
      note: 'No existing isolated 3000/6000 rooms; measured 1000/5000/10000 C2 rooms.',
      env: 'Playwright Chromium headless, Windows, current Vue frontend @8989 + docker API @8990',
      runs: []
    }
    report.cases.perf.runs.push(await perfRoom(ROOM_A, '', '1000-off'))
    report.cases.perf.runs.push(await perfRoom(ROOM_A, FLAGS_ON, '1000-p1ab'))
    report.cases.perf.runs.push(await perfRoom(ROOM_5K, '', '5000-off'))
    report.cases.perf.runs.push(await perfRoom(ROOM_5K, FLAGS_ON, '5000-p1ab'))
    try {
      report.cases.perf.runs.push(await perfRoom(ROOM_10K, '', '10000-off'))
      report.cases.perf.runs.push(await perfRoom(ROOM_10K, FLAGS_ON, '10000-p1ab'))
    } catch (err) {
      report.cases.perf.tenKError = String(err && err.message)
    }

    report.untested.push({
      id: 3,
      item: 'User A/B independent expand on same room',
      reason: 'Only one authorized login (AUTH_DEV_BYPASS → existing user). Did not create or impersonate a second account.'
    })
    report.untested.push({
      id: 5,
      item: 'Remote node insert then expand survives',
      reason: 'Would mutate shared C2 room node trees. Lazy-load/overview hydrate observed only.'
    })
    report.untested.push({
      id: 'perf-3000-6000',
      item: 'Exact 3000 and 6000 live rooms',
      reason: 'Those rooms do not exist; 5000 used as nearest isolated room.'
    })
    report.untested.push({
      id: 'drag-frames',
      item: 'Drag frame times',
      reason: 'Not instrumented in this pass (no rAF capture on real drag).'
    })
    report.untested.push({
      id: 'reconnect',
      item: 'True websocket disconnect/reconnect',
      reason: 'Did not kill docker/network. Fast room switch + delayed GET covered instead.'
    })
    report.untested.push({
      id: 'second-user',
      item: 'Two logged-in browsers as different people',
      reason: 'No second authorized test password/mobile used.'
    })
  } catch (err) {
    report.blockers.push(String((err && err.stack) || err))
  } finally {
    await browser.close()
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}

function saveReport(report) {
  report.updatedAt = new Date().toISOString()
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
