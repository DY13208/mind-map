// Final-build E2E: 10,000-node rich-text, openPerformance=false, two actors.
// Real compiled App + real backend; native product lazy load (EXPAND_ALL), no
// injected SQL tree. Full canonical comparison of model/order/business data and
// real PG, attached-render count, native ACK<->PG opId, manual save, clean
// reopen and cold backend restart.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const fx = require('./final-build-fixtures.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const TOTAL = 10000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function rows (client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    const out = []
    const walk = (node, parentUid) => {
      out.push({ uid: node.data.uid, parentUid, data: { ...node.data }, children: (node.children || []).map(c => c.data.uid) })
      for (const c of node.children || []) walk(c, node.data.uid)
    }
    walk(mm.renderer.renderTree, null)
    return out
  })
}
async function stats (client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    let total = 0
    const stack = [mm.renderer.renderTree]
    while (stack.length) { const n = stack.pop(); if (!n) continue; total++; stack.push(...(n.children || [])) }
    const draw = mm.nodeDraw && mm.nodeDraw.node
    return { total, attached: draw ? draw.querySelectorAll('g.smm-node').length : null,
      openPerformance: mm.opt.openPerformance, layout: mm.getLayout() }
  })
}
async function loadFull (client) {
  await client.page.evaluate(() => window.__onlineMM.updateConfig({ openPerformance: false }))
  // Trigger the real product entry exactly once and await its progressive
  // expansion promise (re-issuing EXPAND_ALL would cancel the previous token).
  await client.page.evaluate(async () => {
    const r = window.__onlineMM.renderer
    if (typeof r.expandAllNode === 'function') await r.expandAllNode('')
    else window.__onlineMM.execCommand('EXPAND_ALL')
  })
  let s = await stats(client)
  const deadline = Date.now() + 180000
  while (s.total < TOTAL && Date.now() < deadline) { await sleep(3000); s = await stats(client) }
  await settled(client)
  const finalStats = await stats(client)
  if (finalStats.total < TOTAL) {
    const diag = await client.page.evaluate(() => ({ total: window.__onlineMM.renderer.nodeIndex ? window.__onlineMM.renderer.nodeIndex.size : null, expandToken: window.__onlineMM.renderer._expandAllToken, isRendering: window.__onlineMM.renderer.isRendering }))
    throw new Error('expand did not reach 10k: ' + JSON.stringify({ finalStats, diag }))
  }
  return finalStats
}
async function captureState (client, uid) {
  return client.page.evaluate(uid => {
    const mm = window.__onlineMM, c = mm.cooperate, a = c.collabV2Adapter
    let modelText = null, domText = null
    try { const n = mm.renderer.findNodeByUid(uid); modelText = n && n.getData('text'); domText = n && n.group && n.group.node && n.group.node.textContent } catch (e) {}
    return { modelText, domText, isRendering: mm.renderer.isRendering, suppressMsLeft: (c.suppressLocalUntil || 0) - Date.now(),
      pendingTextUids: c._pendingTextUids ? Array.from(c._pendingTextUids) : null,
      lastPushedText: c.lastPushed && c.lastPushed[uid] && c.lastPushed[uid].text,
      pendingCount: a.getStatus().pendingCount, outboxPending: a.getStatus().outboxPending, phase: a.getStatus().phase }
  }, uid)
}
async function waitText (client, uid, text) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const v = await client.page.evaluate(uid => { const n = window.__onlineMM.renderer.findNodeByUid(uid); return n ? n.getData('text') : null }, uid)
    if (v === text) return true
    await sleep(500)
  }
  return false
}
function waitAck (frames, opId) {
  return frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId && f.body.ok)
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'run-' + runId, '10k')
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), total: TOTAL }
  let fixture, browser, clients = []
  const frames = []
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedLarge', { runId, nodes: TOTAL })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    assert.equal(seed.count, TOTAL)
    const expected = fx.buildLargeGraph(TOTAL)
    const expectedProjection = fx.canonicalGraph(expected, { browserLeafExpand: true })
    const expectedPg = fx.canonicalGraph(expected)

    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, openPerformance: false,
        setupTimeoutMs: 300000, liveTimeoutMs: 300000, onPage: async page => observe.observeWire(page, clients.length, frames) })
      clients.push(client)
    }
    await Promise.all(clients.map(settled))
    const identities = await Promise.all(clients.map(c => c.page.evaluate(() => {
      const s = window.__onlineMM.cooperate.collabV2Adapter.getStatus()
      return { userId: s.userId, clientId: window.__onlineMM.cooperate.collabV2Adapter.getClientId() }
    })))
    evidence.identities = identities
    assert.equal(identities[0].userId, 'e2e-owner')
    assert.equal(identities[1].userId, 'e2e-editor-a')
    assert.notEqual(identities[0].clientId, identities[1].clientId)

    // Real product expand + lazy load to the full 10k model on BOTH actors.
    const loadStart = Date.now()
    const s0 = await loadFull(clients[0])
    const s1 = await loadFull(clients[1])
    evidence.loadMs = Date.now() - loadStart
    evidence.loaded = { owner: s0, peer: s1 }
    for (const [i, st] of [s0, s1].entries()) {
      assert.equal(st.openPerformance, false, 'actor ' + i + ' keeps openPerformance=false')
      assert.equal(st.total, TOTAL, 'actor ' + i + ' reaches the full 10k model')
      assert.equal(st.attached, TOTAL, 'actor ' + i + ' attaches exactly 10k nodes')
      const problems = fx.compareCanonical(expectedProjection, fx.projectBrowserModel(await rows(clients[i])), 'model-10k-' + i)
      if (i === 0) evidence.modelProblems = problems.slice(0, 20)
      assert.equal(problems.length, 0, 'actor ' + i + ' 10k model matches canonical UID/parent/order/business data')
    }
    write('progress-after-load.json', evidence)
    const richCount = await clients[0].page.evaluate(() => {
      let n = 0; const stack = [window.__onlineMM.renderer.renderTree]
      while (stack.length) { const x = stack.pop(); if (x.data.richText) n++; stack.push(...(x.children || [])) }
      return n
    })
    assert.equal(richCount, TOTAL, 'every 10k node keeps rich text')
    assert.deepEqual(await clients[0].page.evaluate(() => window.__onlineMM.renderer.findNodeByUid('root').getData('customMeta')), { kind: 'large-root' })

    // Two-actor propagation with native ACK <-> PG opId.
    const editText = '<p>10k owner edit</p>'
    await clients[0].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), t) }, editText)
    if (!await waitText(clients[1], 'root', editText)) {
      evidence.editFailure = { stage: 'owner-edit-to-peer', owner: await captureState(clients[0], 'root'), peer: await captureState(clients[1], 'root'), frames: frames.slice(-40) }
      write('edit-propagation-failure.json', evidence)
      throw new Error('owner root edit did not propagate to peer within 30s')
    }
    const leafEdit = '<p>10k peer edit</p>'
    await clients[1].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('e2e-0'), t) }, leafEdit)
    if (!await waitText(clients[0], 'e2e-0', leafEdit)) {
      evidence.editFailure = { stage: 'peer-edit-to-owner', owner: await captureState(clients[0], 'e2e-0'), peer: await captureState(clients[1], 'e2e-0'), frames: frames.slice(-40) }
      write('edit-propagation-failure.json', evidence)
      throw new Error('peer leaf edit did not propagate to owner within 30s')
    }
    await settled(clients[0]); await settled(clients[1])
    const rootSent = frames.filter(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(editText))[0]
    const leafSent = frames.filter(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(leafEdit))[0]
    assert.ok(rootSent && waitAck(frames, rootSent.body.opId), 'owner edit has a native ACK')
    assert.ok(leafSent && waitAck(frames, leafSent.body.opId), 'peer edit has a native ACK')
    const midState = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.ok(midState.operations.some(o => o.operation_id === rootSent.body.opId), 'owner edit opId durable in PG')
    assert.ok(midState.operations.some(o => o.operation_id === leafSent.body.opId), 'peer edit opId durable in PG')
    fx.canonicalGraph(expected) // expected already independent; apply deltas
    expected.root.data.text = editText
    expected['e2e-0'].data.text = leafEdit
    const expectedAfter = fx.canonicalGraph(expected, { browserLeafExpand: true })
    const expectedPgAfter = fx.canonicalGraph(expected)
    // Full canonical comparison on BOTH still-active actors before closing them.
    for (const [i, c] of clients.entries()) {
      const problems = fx.compareCanonical(expectedAfter, fx.projectBrowserModel(await rows(c)), 'active-10k-' + i)
      assert.equal(problems.length, 0, 'active actor ' + i + ' 10k canonical after edits')
    }

    // Explicit product manual save + flush + PG proof.
    const save = await clients[0].page.evaluate(async () => {
      const mm = window.__onlineMM, c = mm.cooperate
      let editor
      const comps = [document.querySelector('#app').__vue__]
      while (comps.length) { const vm = comps.pop(); if (vm.mindMap === mm && typeof vm.manualSave === 'function') { editor = vm; break } comps.push(...(vm.$children || [])) }
      if (editor) editor.manualSave()
      if (c.flushHttpTextNow) await c.flushHttpTextNow()
      if (c.collabV2Adapter.waitForOutboxDurable) await c.collabV2Adapter.waitForOutboxDurable({ timeoutMs: 60000 })
      return { hasManualSave: !!editor, status: c.collabV2Adapter.getStatus() }
    })
    evidence.manualSave = save
    assert.equal(save.hasManualSave, true)
    assert.equal(save.status.outboxPending, 0)
    assert.equal(save.status.pendingCount, 0, 'no pending ACKs after manual save')
    assert.equal(save.status.saveState, 'saved', 'product save state is saved')
    const savedState = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.equal(Number(save.status.serverRevision), Number(savedState.revision), 'adapter revision equals PG')

    // Clean-context reopen: verify DB-backed model recovery.
    for (const c of clients) await c.context.close()
    clients = []
    await browser.close(); browser = null
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const fresh = await openActorEditor(browser, fixture, { actor: 'editor-b', roomKey: seed.roomKey, openPerformance: false, setupTimeoutMs: 300000, liveTimeoutMs: 300000 })
    clients = [fresh]
    await settled(fresh)
    const fs2 = await loadFull(fresh)
    evidence.freshReopen = fs2
    assert.equal(fs2.total, TOTAL, 'clean context recovers the full 10k model from DB')
    assert.equal(fs2.attached, TOTAL, 'clean context attaches exactly 10k nodes')
    assert.equal(fs2.openPerformance, false, 'clean context keeps openPerformance=false')
    const reopenProblems = fx.compareCanonical(expectedAfter, fx.projectBrowserModel(await rows(fresh)), 'fresh-10k')
    evidence.reopenProblems = reopenProblems.slice(0, 20)
    assert.equal(reopenProblems.length, 0, 'reopened model matches canonical data')
    const freshRaw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
    const pgProblems = fx.rawIntegrityProblems(freshRaw.rows).concat(fx.compareCanonical(expectedPgAfter, fx.projectRawRows(freshRaw.rows), 'pg-10k'))
    evidence.pgProblems = pgProblems.slice(0, 20)
    assert.equal(pgProblems.length, 0, 'real PG matches canonical data with integrity')

    // Cold backend restart reusing the existing owned room (no reseed).
    await fresh.context.close(); clients = []
    await browser.close(); browser = null
    const ownedRoom = seed.roomKey
    await fixture.close({ preserveRooms: true }); fixture = null
    const restarted = await startFinalFixture({ instances: 1, profile: 'default' })
    fixture = restarted
    const adopted = await fixture.apps[0].control('adoptRooms', { runId })
    assert.deepEqual(adopted.adopted, [ownedRoom])
    const restartState = await fixture.apps[0].control('state', { roomKey: ownedRoom })
    assert.equal(Number(restartState.revision), Number(savedState.revision), 'cold restart preserves revision')
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const after = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: ownedRoom, openPerformance: false, setupTimeoutMs: 300000, liveTimeoutMs: 300000 })
    clients = [after]
    const rs = await loadFull(after)
    evidence.coldRestartOpen = rs
    assert.equal(rs.total, TOTAL, 'cold restart recovers the full 10k model')
    assert.equal(rs.attached, TOTAL, 'cold restart attaches exactly 10k nodes')
    assert.equal(rs.openPerformance, false, 'cold restart keeps openPerformance=false')
    const restartProblems = fx.compareCanonical(expectedAfter, fx.projectBrowserModel(await rows(after)), 'restart-10k')
    evidence.restartProblems = restartProblems.slice(0, 20)
    assert.equal(restartProblems.length, 0, 'cold restart browser model matches canonical data')
    const restartRaw = await fixture.apps[0].control('rawNodes', { roomKey: ownedRoom })
    const restartPg = fx.rawIntegrityProblems(restartRaw.rows).concat(fx.compareCanonical(expectedPgAfter, fx.projectRawRows(restartRaw.rows), 'restart-pg'))
    assert.equal(restartPg.length, 0, 'cold restart PG still canonical with integrity')
    evidence.coldRestart = { adopted, revision: restartState.revision }

    evidence.status = 'GREEN'
    evidence.nativeFrames = frames
    evidence.artifact = { env: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', path: fixture.artifact,
      servedAssets: fixture.servedAssets ? fixture.servedAssets() : null, bundleHashes: fixture.bundleHashes }
    evidence.actors = ['owner', 'editor-a', 'editor-b']
    write('result.json', evidence)
    console.log('RUN_10K_GREEN ' + JSON.stringify({ total: fs2.total, attached: s0.attached, openPerformance: fs2.openPerformance }))

  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('RUN_10K_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
