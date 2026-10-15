'use strict'

// Independent acceptance of real App commands, native transport, and PG state.
// The owning wrapper supplies a fresh guarded DB, synthetic login key, and the
// compiled final build. This child never reads .env or changes product code.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { chromium } = require('../../simple-mind-map/node_modules/@playwright/test')
const { Pool } = require('../../simple-mind-map/node_modules/pg')
const { observeWire } = require('./online-browser-observation.cjs')
const { cleanupAll } = require('./safeload-cleanup.cjs')

const TIMEOUT = 30000
const ORIGIN = String(process.env.C2_BROWSER_ORIGIN || '').replace(/\/$/, '')
const RUN_DIR = process.env.PERF_SAFE_RUN_DIR
const runId = crypto.randomBytes(8).toString('hex')
const roomKey = 'safeload-strong-' + runId
const newUid = name => 'safe-' + runId + '-' + name
const ids = { append: newUid('append'), sibling: newUid('sibling'),
  d4: newUid('d4'), d5: newUid('d5'), d6: newUid('d6') }
const text = Object.fromEntries(Object.keys(ids).map(key => [key, 'SAFE_' + runId + '_' + key.toUpperCase()]))
const frames = []
const report = { runId, roomKey, status: 'RUNNING', startedAt: new Date().toISOString(),
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  steps: [], snapshots: {} }
const secrets = ['AUTH_DEV_BYPASS_KEY', 'AUTH_SESSION_SECRET', 'MCP_TOKEN', 'WECOM_SECRET', 'PGPASSWORD']
  .map(key => process.env[key]).filter(Boolean)
const clean = value => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), String(value))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checkpoint = () => fs.writeFileSync(path.join(RUN_DIR, 'strengthened-report.json'),
  clean(JSON.stringify(report, null, 2)) + '\n')

function bounded(job, label, ms = TIMEOUT) {
  let timer
  return Promise.race([job, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ': deadline exceeded')), ms)
    timer.unref()
  })]).finally(() => clearTimeout(timer))
}
async function poll(label, read, accept = Boolean, ms = TIMEOUT) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await bounded(Promise.resolve().then(read), label, Math.max(1, end - Date.now()))
    if (accept(last)) return last
    await sleep(60)
  }
  report.snapshots['timeout-' + label] = last
  checkpoint()
  throw new Error(label + ': condition not met')
}
function fixtureTree() {
  const root = { data: { uid: 'root', text: 'SAFE_ROOT', isRoot: true, richText: false }, children: [] }
  const l1 = { data: { uid: 'a_l1', text: 'L1', richText: false }, children: [] }
  const l2 = { data: { uid: 'a_l2', text: 'L2', richText: false }, children: [] }
  root.children.push(l1); l1.children.push(l2)
  let count = 3
  for (const n of [5, 20, 50, 100]) {
    const uid = 'parent_' + n
    const parent = { data: { uid, text: 'PARENT_' + n, richText: false }, children: [] }
    l2.children.push(parent); count++
    for (let i = 0; i < n; i++) {
      parent.children.push({ data: { uid: uid + '_c' + i, text: uid + '_C' + i, richText: false }, children: [] })
      count++
    }
  }
  const fill = { data: { uid: 'fill_hub', text: 'FILL_HUB', richText: false }, children: [] }
  l2.children.push(fill); count++
  for (let i = 0; count < 450; i++, count++) {
    fill.children.push({ data: { uid: 'fill_' + i, text: 'FILL_' + i, richText: false }, children: [] })
  }
  assert.equal(count, 450)
  return root
}

async function main() {
  assert.ok(RUN_DIR, 'wrapper evidence directory is required')
  const origin = new URL(ORIGIN)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'loopback fixture is required')
  assert.match(process.env.PGDATABASE || '', /^safeload_acceptance_[a-f0-9]{16}$/, 'fresh isolated DB is required')
  assert.ok(process.env.AUTH_DEV_BYPASS_KEY, 'wrapper temporary login key is required')
  let browser, context, page
  const pool = new Pool({ statement_timeout: TIMEOUT, connectionTimeoutMillis: 5000, max: 2 })
  const subtreeRequests = []
  const ownPageErrors = []
  let stage = 'setup'
  const writeStep = (name, evidence) => {
    report.steps.push({ name, status: 'PASS', at: new Date().toISOString(), ...evidence })
    checkpoint()
    console.log('SAFE_STRENGTHENED_STEP ' + name)
  }
  async function pgChildren(parentUid) {
    return (await pool.query(`select uid, parent_uid, data, position from room_nodes
      where room_key=$1 and parent_uid=$2 and deleted_at is null order by position,uid`, [roomKey, parentUid])).rows
  }
  async function pgNode(uid) {
    return (await pool.query(`select uid,parent_uid,data,position from room_nodes
      where room_key=$1 and uid=$2 and deleted_at is null`, [roomKey, uid])).rows[0] || null
  }
  async function nodeState(uid) {
    return page.evaluate(uid => {
      const mm = window.__safeMM, r = mm && mm.renderer
      const node = r && r.findNodeByUid(uid)
      if (!node) return null
      const el = node.group && node.group.node
      const bounds = el && el.isConnected ? el.getBoundingClientRect() : null
      return { uid: node.getData('uid'), parentUid: node.parent && node.parent.getData('uid'),
        text: node.getData('text'), expand: node.getData('expand'),
        childCount: Number(node.getData('childCount') || 0),
        children: ((node.nodeData && node.nodeData.children) || []).map(n => n.data.uid),
        needsHydrate: !!mm.cooperate.nodeNeedsHydrate(node),
        dom: { attached: !!(el && el.isConnected), text: el && el.textContent,
          visible: !!(bounds && bounds.width > 0 && bounds.height > 0 &&
            bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight) } }
    }, uid)
  }
  async function waitStable(label = 'stable') {
    return poll(label, () => page.evaluate(() => {
      const mm = window.__safeMM, r = mm && mm.renderer, c = mm && mm.cooperate
      const s = c && c.collabV2Adapter && c.collabV2Adapter.getStatus()
      return { ready: !!(s && s.phase === 'LIVE' && !s.pendingCount && !s.outboxPending &&
        r.root && !r.isRendering && !r.renderTimer && !r.hasWaitRendering && !r._lazyCommandPending &&
        !c.previewApplied && !c.httpHydrating && !c.isApplyingRemote && !c.httpReplacing &&
        !c.isSetData && !c.hydratingCurrentData && !c.httpInsertPromise &&
        !c.httpTextTimer && !c.httpStructureTimer && Date.now() >= (c.suppressLocalUntil || 0)),
      status: s && { phase: s.phase, pendingCount: s.pendingCount, outboxPending: s.outboxPending,
        revision: s.lastServerRevision }, rendering: r && !!r.isRendering }
    }), value => value.ready)
  }
  async function bind() {
    await poll('bind-editor', () => page.evaluate(() => {
      let el = document.querySelector('#mindMapContainer')
      while (el) {
        const vue = el.__vue__
        if (vue && vue.mindMap && vue.mindMap.renderer && vue.mindMap.cooperate) {
          // Read-only references for observation; no state or methods replaced.
          window.__safeMM = vue.mindMap
          window.__C2_MINDMAP__ = vue.mindMap
          return true
        }
        el = el.parentElement
      }
      return false
    }))
    await waitStable('editor-live')
  }
  async function open(reload = false) {
    if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    else await page.goto(ORIGIN + '/?room=' + encodeURIComponent(roomKey), { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await bind()
  }
  async function expand(uid) {
    await waitStable('before-expand-' + uid)
    await poll('expand-target-' + uid, () => nodeState(uid))
    // Also issue the real command for an already-expanded ancestor, so the
    // automatic-reopen scenario has an explicitly persisted personal choice.
    await page.evaluate(uid => {
      const mm = window.__safeMM, node = mm.renderer.findNodeByUid(uid)
      if (!node) throw new Error('expansion target disappeared')
      mm.execCommand('SET_NODE_EXPAND', node, true)
    }, uid)
    await poll('expanded-complete-' + uid, () => nodeState(uid),
      state => state && state.expand !== false && !state.needsHydrate && state.children.length >= state.childCount)
    await waitStable('after-expand-' + uid)
  }
  async function navigateAncestors() {
    for (const uid of ['root', 'a_l1', 'a_l2']) await expand(uid)
  }
  async function readView() {
    const response = await context.request.get(ORIGIN + '/api/files/' + encodeURIComponent(roomKey) + '/view-state', { timeout: TIMEOUT })
    assert.equal(response.ok(), true, 'read personal view returned success')
    const value = await response.json()
    assert.equal(value.ok, true, 'read personal view is valid')
    return value.state || {}
  }
  async function saveExpandCommand(uid, expanded) {
    await waitStable('before-personal-expand-' + uid)
    const [response] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/api/files/' + encodeURIComponent(roomKey) + '/view-state' &&
          response.request().method() === 'PATCH'
      }, { timeout: TIMEOUT }),
      page.evaluate(({ uid, expanded }) => {
        const mm = window.__safeMM, node = mm.renderer.findNodeByUid(uid)
        if (!node) throw new Error('personal expansion target missing')
        mm.execCommand('SET_NODE_EXPAND', node, expanded)
      }, { uid, expanded })
    ])
    assert.equal(response.ok(), true, 'actual personal view PATCH succeeded')
    const state = await poll('persist-personal-expand-' + uid, readView,
      state => !!state.expand && state.expand[uid] === expanded)
    await waitStable('personal-expand-stable-' + uid)
    return { expand: state.expand }
  }
  function innerOps(op) {
    if (op && op.type === 'node.batch') return ((op.payload && op.payload.ops) || []).flatMap(innerOps)
    return [op]
  }
  async function committed(label, start, type, uid, kind) {
    const value = await poll('native-commit-' + label, async () => {
      const sent = frames.slice(start).find(frame => frame.direction === 'sent' && frame.event === 'op' &&
        innerOps(frame.body).some(op => op && op.type === type &&
          JSON.stringify(op.payload || {}).includes(uid) && (!kind || op.payload.kind === kind)))
      if (!sent) return null
      const ack = frames.slice(start).find(frame => frame.direction === 'received' && frame.kind === 'ack' &&
        frame.body && frame.body.opId === sent.body.opId && frame.body.ok === true)
      if (!ack) return null
      const rows = (await pool.query(`select version,operation_id,operation_type from room_operations
        where room_key=$1 and operation_id=$2`, [roomKey, sent.body.opId])).rows
      if (!rows.length) return null
      assert.equal(rows.length, 1, label + ': native op is durable exactly once')
      assert.equal(Number(rows[0].version), Number(ack.body.serverRevision), label + ': ACK revision matches PG operation')
      return { opId: sent.body.opId, type, kind: kind || null, revision: Number(ack.body.serverRevision),
        sentAt: sent.at, ackAt: ack.at, durableRows: rows.length }
    })
    await waitStable('after-native-commit-' + label)
    return value
  }
  async function insertChild(parentUid, uid, value) {
    await waitStable('before-child-' + uid)
    const start = frames.length
    const selection = await page.evaluate(({ parentUid, uid, value }) => {
      const mm = window.__safeMM, parent = mm.renderer.findNodeByUid(parentUid)
      if (!parent) throw new Error('insert parent missing')
      parent.active()
      const activeUids = mm.renderer.activeNodeList.map(node => node.getData('uid'))
      if (!activeUids.includes(parentUid)) throw new Error('real UI insert parent was not selected')
      const selected = { activeUids, children: parent.nodeData.children.map(node => node.data.uid),
        childCount: Number(parent.getData('childCount') || 0), needsHydrate: mm.cooperate.nodeNeedsHydrate(parent) }
      if (parentUid === 'parent_50' && uid.endsWith('-append') &&
        !(selected.children.length < selected.childCount && selected.needsHydrate)) {
        throw new Error('real parent selection consumed the partial insertion precondition')
      }
      mm.execCommand('INSERT_CHILD_NODE', false, [parent], { uid, text: value, richText: false })
      return selected
    }, { parentUid, uid, value })
    const operation = await committed(uid, start, 'node.insert', uid)
    const row = await pgNode(uid)
    assert.ok(row, 'inserted node persisted')
    assert.equal(row.parent_uid, parentUid, 'inserted parent persisted')
    assert.equal(row.data.text, value, 'inserted text persisted')
    const state = await poll('inserted-model-' + uid, () => nodeState(uid), n => n && n.text === value && n.parentUid === parentUid)
    return { operation, selection, node: state }
  }
  async function exactChildren(uid, expected, label) {
    const rows = await poll('pg-children-' + label, () => pgChildren(uid),
      rows => JSON.stringify(rows.map(row => row.uid)) === JSON.stringify(expected))
    assert.deepEqual(rows.map(row => row.uid), expected, label + ': exact PG sibling sequence')
    assert.equal(new Set(rows.map(row => row.uid)).size, rows.length, label + ': no duplicate children')
    await poll('model-children-' + label, () => nodeState(uid),
      state => state && JSON.stringify(state.children) === JSON.stringify(expected))
    return { parentUid: uid, children: expected.slice() }
  }

  try {
    const identity = (await pool.query('select identity from safeload_test_identity where singleton')).rows
    assert.equal(identity.length, 1, 'owned temporary DB sentinel exists')
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    page.setDefaultTimeout(TIMEOUT)
    observeWire(page, 0, frames)
    page.on('pageerror', error => ownPageErrors.push(clean(error.message)))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === '/api/files/' + encodeURIComponent(roomKey) + '/subtree') {
        subtreeRequests.push({ uid: url.searchParams.get('uid'), deep: url.searchParams.get('deep'), at: Date.now() })
      }
    })
    const login = await context.request.post(ORIGIN + '/api/auth/dev-login', {
      data: { key: process.env.AUTH_DEV_BYPASS_KEY }, timeout: TIMEOUT })
    assert.equal(login.ok(), true, 'synthetic dev login succeeded')
    assert.equal((await login.json()).authenticated, true, 'real dev-login authenticated')
    const created = await context.request.post(ORIGIN + '/api/files', {
      data: { room_key: roomKey, title: 'SafeLoad strengthened synthetic fixture', clientId: newUid('seed'),
        tree: { data: { uid: 'root', text: 'Root', isRoot: true }, children: [] } }, timeout: TIMEOUT })
    assert.equal(created.ok(), true, 'new isolated room created')
    const replaced = await context.request.post(ORIGIN + '/api/files/' + encodeURIComponent(roomKey) + '/replace', {
      data: { tree: fixtureTree(), allowFullTree: true, source: 'safeload-strengthened-acceptance',
        clientId: newUid('seed'), type: 'map.replace' }, timeout: TIMEOUT })
    assert.equal(replaced.ok(), true, 'synthetic fixture persisted through real replace API')
    const pgTotal = Number((await pool.query('select count(*)::int as count from room_nodes where room_key=$1 and deleted_at is null', [roomKey])).rows[0].count)
    assert.equal(pgTotal, 450, '450-node seed reached PG')
    await open()
    await navigateAncestors()
    writeStep('setup-and-normal-ancestor-navigation', { seedNodes: pgTotal })

    stage = 'partial-insert'
    const original50 = (await pgChildren('parent_50')).map(row => row.uid)
    assert.equal(original50.length, 50)
    const collapsedView = await saveExpandCommand('parent_50', false)
    report.snapshots.collapsedView = collapsedView
    checkpoint()
    await open(true)
    await navigateAncestors()
    const partial = await nodeState('parent_50')
    report.snapshots.partialBeforeInsert = partial
    checkpoint()
    assert.ok(partial, 'P50 is naturally reachable after reload')
    assert.equal(partial.expand, false, 'real personal collapsed view restored')
    assert.equal(partial.childCount, 50, 'P50 metadata retains PG authoritative total')
    assert.ok(partial.children.length < 50, 'natural partial fixture required before insertion')
    assert.equal(partial.needsHydrate, true, 'product recognizes natural partial parent')
    const append = await insertChild('parent_50', ids.append, text.append)
    const afterAppend = original50.concat(ids.append)
    const appendOrder = await exactChildren('parent_50', afterAppend, 'partial-append')
    writeStep(stage, { before: partial, ...append, ...appendOrder })

    stage = 'singleflight-real-subtree'
    const p20Before = await nodeState('parent_20')
    report.snapshots.p20BeforeSingleflight = p20Before
    checkpoint()
    assert.ok(p20Before, 'P20 stub is reachable')
    assert.equal(p20Before.children.length, 0, 'P20 natural zero-child partial fixture required')
    assert.equal(p20Before.childCount, 20, 'P20 authoritative child total is 20')
    assert.equal(p20Before.needsHydrate, true)
    const requestStart = subtreeRequests.length
    await bounded(page.evaluate(async () => {
      const mm = window.__safeMM, node = mm.renderer.findNodeByUid('parent_20')
      if (!node) throw new Error('singleflight target missing')
      await Promise.all([mm.cooperate.hydrateFromHttp(node), mm.cooperate.hydrateFromHttp(node)])
    }), 'two real concurrent subtree hydration calls')
    const actual = subtreeRequests.slice(requestStart).filter(request => request.uid === 'parent_20')
    assert.equal(actual.length, 1, 'concurrent real hydration sends exactly one HTTP subtree request')
    const p20Rows = await pgChildren('parent_20'), p20After = await nodeState('parent_20')
    assert.deepEqual(p20After.children, p20Rows.map(row => row.uid), 'singleflight result exactly matches real PG children')
    assert.equal(p20After.needsHydrate, false)
    writeStep(stage, { before: p20Before, after: p20After, subtreeRequests: actual })

    stage = 'sibling-insert'
    await waitStable('before-sibling-insert')
    const siblingStart = frames.length, anchorUid = 'parent_50_c2'
    await page.evaluate(({ anchorUid, uid, value }) => {
      const mm = window.__safeMM, node = mm.renderer.findNodeByUid(anchorUid)
      if (!node) throw new Error('sibling insertion anchor missing')
      node.active()
      if (!mm.renderer.activeNodeList.includes(node)) throw new Error('sibling source was not selected')
      mm.execCommand('INSERT_NODE', false, [node], { uid, text: value, richText: false })
    }, { anchorUid, uid: ids.sibling, value: text.sibling })
    const siblingOp = await committed(stage, siblingStart, 'node.insert', ids.sibling)
    const siblingExpected = afterAppend.slice()
    const anchorIndex = siblingExpected.indexOf(anchorUid)
    assert.ok(anchorIndex >= 0)
    siblingExpected.splice(anchorIndex + 1, 0, ids.sibling)
    const siblingOrder = await exactChildren('parent_50', siblingExpected, stage)
    const siblingRow = await pgNode(ids.sibling)
    assert.equal(siblingRow.data.text, text.sibling)
    assert.equal(siblingRow.parent_uid, 'parent_50')
    writeStep(stage, { operation: siblingOp, anchorUid, ...siblingOrder })

    stage = 'native-down-reorder'
    await waitStable('before-native-down')
    const downUid = 'parent_50_c0', downStart = frames.length
    await page.evaluate(uid => {
      const mm = window.__safeMM, node = mm.renderer.findNodeByUid(uid)
      if (!node) throw new Error('reorder source missing')
      node.active()
      if (!mm.renderer.activeNodeList.includes(node)) throw new Error('reorder source was not selected')
      mm.execCommand('DOWN_NODE', node)
    }, downUid)
    const downOp = await committed(stage, downStart, 'node.move', downUid, 'reorder')
    const downExpected = siblingExpected.slice(), downIndex = downExpected.indexOf(downUid)
    assert.ok(downIndex >= 0 && downIndex < downExpected.length - 1)
    ;[downExpected[downIndex], downExpected[downIndex + 1]] = [downExpected[downIndex + 1], downExpected[downIndex]]
    const downOrder = await exactChildren('parent_50', downExpected, stage)
    writeStep(stage, { operation: downOp, ...downOrder })

    stage = 'native-cross-parent-move'
    await expand('parent_20')
    const oldTarget = (await pgChildren('parent_20')).map(row => row.uid)
    const movingUid = 'parent_50_c3', movingBefore = await pgNode(movingUid)
    assert.equal(movingBefore.parent_uid, 'parent_50')
    assert.notEqual(movingBefore.parent_uid, 'parent_20', 'actual cross-parent move precondition')
    const moveStart = frames.length
    await page.evaluate(uid => {
      const mm = window.__safeMM, source = mm.renderer.findNodeByUid(uid), target = mm.renderer.findNodeByUid('parent_20')
      if (!source || !target) throw new Error('cross-parent move target missing')
      source.active()
      if (!mm.renderer.activeNodeList.includes(source)) throw new Error('move source was not selected')
      mm.execCommand('MOVE_NODE_TO', source, target)
    }, movingUid)
    const moveOp = await committed(stage, moveStart, 'node.move', movingUid, 'move')
    const final50 = downExpected.filter(uid => uid !== movingUid), final20 = oldTarget.concat(movingUid)
    assert.equal(final50.length, 51); assert.equal(final20.length, 21)
    const sourceOrder = await exactChildren('parent_50', final50, 'cross-parent-source')
    const targetOrder = await exactChildren('parent_20', final20, 'cross-parent-target')
    assert.equal((await pgNode(movingUid)).parent_uid, 'parent_20')
    writeStep(stage, { operation: moveOp, source: sourceOrder, target: targetOrder })

    stage = 'natural-expanded-auto-hydrate-after-reload'
    await expand('parent_50')
    const expandedView = await saveExpandCommand('parent_50', true)
    for (const uid of ['root', 'a_l1', 'a_l2', 'parent_50']) {
      assert.equal(expandedView.expand[uid], true, 'ancestor/P50 personal expansion saved: ' + uid)
    }
    report.snapshots.expandedView = expandedView
    checkpoint()
    await open(true)
    // Deliberately no navigation or hydration after this reload: the real
    // product must restore the saved ancestor/P50 view and load all children.
    const restored = await poll('automatic-personal-expanded-P50', () => nodeState('parent_50'), n =>
      n && n.expand !== false && !n.needsHydrate && JSON.stringify(n.children) === JSON.stringify(final50))
    await waitStable('automatic-personal-expanded-stable')
    await exactChildren('parent_50', final50, 'natural-expanded-reload')
    writeStep(stage, { automatic: true, restored, expectedChildren: final50 })

    stage = 'natural-depth-four-five-six'
    await navigateAncestors()
    await expand('parent_5')
    const createdDepth = []
    for (const [parentUid, key] of [['parent_5', 'd4'], [ids.d4, 'd5'], [ids.d5, 'd6']]) {
      createdDepth.push({ key, ...await insertChild(parentUid, ids[key], text[key]) })
    }
    report.snapshots.createdDepth = createdDepth
    report.snapshots.viewBeforeDepthReload = await readView()
    checkpoint()
    await open(true)
    // Newly inserted parents expand through an internal setData, which need
    // not persist their personal expansion. Use only normal public expansion
    // after F5, rather than confusing a folded view with missing persistence.
    for (const uid of ['root', 'a_l1', 'a_l2', 'parent_5', ids.d4, ids.d5]) await expand(uid)
    const depth = []
    for (const [parentUid, key] of [['parent_5', 'd4'], [ids.d4, 'd5'], [ids.d5, 'd6']]) {
      const uid = ids[key], row = await pgNode(uid)
      assert.ok(row, key + ': canonical node survives F5')
      assert.equal(row.parent_uid, parentUid, key + ': canonical parent survives F5')
      assert.equal(row.data.text, text[key], key + ': canonical text survives F5')
      const beforeFocus = await nodeState(uid)
      assert.ok(beforeFocus, key + ': normal ancestor expansion makes node reachable')
      assert.equal(beforeFocus.parentUid, parentUid)
      assert.equal(beforeFocus.text, text[key])
      await page.evaluate(uid => { window.__safeMM.execCommand('GO_TARGET_NODE', uid) }, uid)
      const focused = await poll('focused-visible-' + key, () => nodeState(uid), state =>
        state && state.dom.attached && state.dom.visible && state.dom.text.includes(text[key]))
      assert.equal(focused.parentUid, parentUid)
      depth.push({ key, uid, parentUid, text: row.data.text, focused })
    }
    const pgChain = (await pool.query(`with recursive chain as (
      select uid,parent_uid,0 as distance from room_nodes where room_key=$1 and uid=$2 and deleted_at is null
      union all select n.uid,n.parent_uid,c.distance+1 from room_nodes n join chain c
        on n.uid=c.parent_uid and n.room_key=$1 and n.deleted_at is null where c.distance<10
      ) select uid,parent_uid,distance from chain order by distance`, [roomKey, ids.d6])).rows
    assert.deepEqual(pgChain.map(row => row.uid), [ids.d6, ids.d5, ids.d4, 'parent_5', 'a_l2', 'a_l1', 'root'], 'PG authoritative F5 depth chain is exact')
    writeStep(stage, { depth, pgChain })
    assert.deepEqual(ownPageErrors, [], 'no browser page errors during strengthened acceptance')
    await waitStable('final-stable')
    report.status = 'PASS'
    report.finishedAt = new Date().toISOString()
    checkpoint()
    console.log('SAFE_STRENGTHENED_PASS')
  } catch (error) {
    report.status = 'FAIL'
    report.failedStage = stage
    report.error = clean(error.message)
    report.finishedAt = new Date().toISOString()
    if (page && !page.isClosed()) {
      try {
        report.snapshots.failure = await bounded(page.evaluate(() => {
          const mm = window.__safeMM, c = mm && mm.cooperate, r = mm && mm.renderer
          const s = c && c.collabV2Adapter && c.collabV2Adapter.getStatus()
          return { hasMM: !!mm, rendering: r && !!r.isRendering,
            status: s && { phase: s.phase, pending: s.pendingCount, outbox: s.outboxPending, revision: s.lastServerRevision },
            loadFailed: !!document.querySelector('.roomLoadFailed') }
        }), 'failure snapshot', 3000)
      } catch (snapshotError) { report.snapshots.failureSnapshotError = clean(snapshotError.message) }
    }
    checkpoint()
    console.error('SAFE_STRENGTHENED_FAIL ' + stage)
    process.exitCode = 1
  } finally {
    const operationFrames = frames.filter(frame => frame.event === 'op' || frame.event === 'op:event' ||
      (frame.kind === 'ack' && frame.body && frame.body.opId))
    report.pageErrors = ownPageErrors
    report.subtreeRequests = subtreeRequests
    const cleanupErrors = []
    try {
      await cleanupAll([
        () => fs.writeFileSync(path.join(RUN_DIR, 'strengthened-native-operations.json'), clean(JSON.stringify(operationFrames, null, 2)) + '\n'),
        async () => { if (browser) { try { await bounded(browser.close(), 'browser close', 10000) } catch (error) { cleanupErrors.push(clean(error.message)) } } },
        async () => { try { await bounded(pool.end(), 'PG pool close', 10000) } catch (error) { cleanupErrors.push(clean(error.message)) } }
      ])
    } catch (error) { cleanupErrors.push(clean(error.message)) }
    report.cleanup = { browserClosed: !!browser && !browser.isConnected(), poolEnded: pool.ended === true, errors: cleanupErrors }
    if (cleanupErrors.length) { report.status = 'FAIL'; process.exitCode = 1 }
    checkpoint()
  }
}

main().catch(error => {
  // Setup errors remain failures too; do not print request bodies or secrets.
  report.status = 'FAIL'
  report.failedStage = report.failedStage || 'setup'
  report.error = clean(error.message)
  if (RUN_DIR) checkpoint()
  console.error('SAFE_STRENGTHENED_FAIL setup')
  process.exitCode = 1
})
