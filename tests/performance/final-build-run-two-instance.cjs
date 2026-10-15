// Final-build E2E: two actual backend instances sharing isolated PG.
// DEFAULT profile (event bridge OFF): prove cross-instance consistency via real
// PG ops + native rejoin/resync catch-up, distinct actors, native ACK<->PG opId,
// manual save, clean reopen and cold restart on the persisted room.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function rows (client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    const out = []
    const walk = (node, parentUid) => { out.push({ uid: node.data.uid, parentUid, data: { ...node.data }, children: (node.children || []).map(c => c.data.uid) }); for (const c of node.children || []) walk(c, node.data.uid) }
    walk(mm.renderer.renderTree, null)
    return out
  })
}
function waitAck (frames, opId) {
  return frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId && f.body.ok)
}
async function waitText (client, uid, text) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const v = await client.page.evaluate(uid => { const n = window.__onlineMM.renderer.findNodeByUid(uid); return n ? n.getData('text') : null }, uid)
    if (v === text) return true
    await sleep(500)
  }
  return false
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'run-' + runId, 'two-instance')
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), profile: 'default', instances: 2 }
  let fixture, browser, clients = []
  const frames = []
  try {
    fixture = await startFinalFixture({ instances: 2, profile: 'default' })
    evidence.instancePids = fixture.apps.map(app => app.pid)
    evidence.instanceRuntimes = fixture.apps.map(app => app.runtime)
    assert.equal(new Set(fixture.apps.map(app => app.pid)).size, 2, 'two distinct backend processes')
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    const expected = fx.buildSmallGraph()
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    // owner on instance 0 front, editor-a on instance 1 front.
    clients.push(await openActorEditor(browser, fixture, { actor: 'owner', roomKey: seed.roomKey, frontIndex: 0, onPage: async page => observe.observeWire(page, 0, frames) }))
    clients.push(await openActorEditor(browser, fixture, { actor: 'editor-a', roomKey: seed.roomKey, frontIndex: 1, onPage: async page => observe.observeWire(page, 1, frames) }))
    await Promise.all(clients.map(settled))
    const identities = await Promise.all(clients.map(c => c.page.evaluate(() => {
      const a = window.__onlineMM.cooperate.collabV2Adapter
      return { userId: a.getStatus().userId, clientId: a.getClientId() }
    })))
    evidence.identities = identities
    assert.equal(identities[0].userId, 'e2e-owner')
    assert.equal(identities[1].userId, 'e2e-editor-a')
    assert.notEqual(identities[0].clientId, identities[1].clientId)
    evidence.instanceBases = fixture.fronts.map(f => f.base)

    // Instance 0 edit -> real PG; instance 1 catches up via native resync (bridge OFF).
    const ownerText = '<p>two-inst owner</p>'
    await clients[0].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), t) }, ownerText)
    await settled(clients[0])
    const ownerSent = frames.find(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(ownerText))
    assert.ok(ownerSent && waitAck(frames, ownerSent.body.opId), 'instance-0 edit has native ACK')
    await clients[1].page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.resync({ reason: 'cross-instance-verify' }))
    assert.equal(await waitText(clients[1], 'root', ownerText), true, 'instance-1 catches up to instance-0 via PG resync (bridge OFF)')

    // Instance 1 edit -> real PG; instance 0 catches up via resync.
    const peerText = '<p>two-inst peer</p>'
    await clients[1].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-0-0'), t) }, peerText)
    await settled(clients[1])
    const peerSent = frames.find(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(peerText))
    assert.ok(peerSent && waitAck(frames, peerSent.body.opId), 'instance-1 edit has native ACK')
    await clients[0].page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.resync({ reason: 'cross-instance-verify' }))
    assert.equal(await waitText(clients[0], 'leaf-0-0', peerText), true, 'instance-0 catches up to instance-1 via PG resync (bridge OFF)')

    const state = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.ok(state.operations.some(op => op.operation_id === ownerSent.body.opId), 'instance-0 opId durable in shared PG')
    assert.ok(state.operations.some(op => op.operation_id === peerSent.body.opId), 'instance-1 opId durable in shared PG')
    expected.root.data.text = ownerText
    expected['leaf-0-0'].data.text = peerText
    const expectedBrowser = fx.canonicalGraph(expected, { browserLeafExpand: true })
    const expectedPg = fx.canonicalGraph(expected)
    evidence.crossInstance = { ownerOpId: ownerSent.body.opId, peerOpId: peerSent.body.opId }
    // Full canonical comparison on BOTH active actors after the cross-instance
    // catch-up edits.
    for (const [i, c] of clients.entries()) {
      const problems = fx.compareCanonical(expectedBrowser, fx.projectBrowserModel(await rows(c)), 'two-inst-active-' + i)
      assert.equal(problems.length, 0, 'active actor ' + i + ' canonical after cross-instance edits')
    }

    // Manual save + flush proof on instance 0.
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
    assert.equal(save.status.pendingCount, 0)
    assert.equal(save.status.saveState, 'saved')

    // Clean reopen in a brand-new browser context on instance 1.
    for (const c of clients) await c.context.close(); clients = []
    await browser.close(); browser = null
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const fresh = await openActorEditor(browser, fixture, { actor: 'editor-b', roomKey: seed.roomKey, frontIndex: 1 })
    clients = [fresh]
    await settled(fresh)
    const modelProblems = fx.compareCanonical(expectedBrowser, fx.projectBrowserModel(await rows(fresh)), 'two-inst-reopen')
    evidence.modelProblems = modelProblems.slice(0, 20)
    assert.equal(modelProblems.length, 0, 'clean reopen on instance 1 matches canonical model')
    const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
    const pgProblems = fx.rawIntegrityProblems(raw.rows).concat(fx.compareCanonical(expectedPg, fx.projectRawRows(raw.rows), 'two-inst-pg'))
    assert.equal(pgProblems.length, 0, 'shared PG matches canonical data with integrity')

    // Cold restart both owned instances reusing the same PG room (no reseed).
    await fresh.context.close(); clients = []
    await browser.close(); browser = null
    const ownedRoom = seed.roomKey
    await fixture.close({ preserveRooms: true }); fixture = null
    const restarted = await startFinalFixture({ instances: 2, profile: 'default' })
    fixture = restarted
    const adopted = await fixture.apps[0].control('adoptRooms', { runId })
    assert.ok(adopted.adopted.includes(ownedRoom))
    await fixture.apps[1].control('adoptRooms', { runId })
    const restartState = await fixture.apps[0].control('state', { roomKey: ownedRoom })
    assert.equal(Number(restartState.revision), Number(state.revision), 'cold restart preserves revision')
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const afterRestart = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: ownedRoom, frontIndex: 1 })
    clients = [afterRestart]
    await settled(afterRestart)
    const restartProblems = fx.compareCanonical(expectedBrowser, fx.projectBrowserModel(await rows(afterRestart)), 'two-inst-restart')
    assert.equal(restartProblems.length, 0, 'cold restart model matches canonical data')
    const restartRaw = await fixture.apps[0].control('rawNodes', { roomKey: ownedRoom })
    assert.equal(fx.rawIntegrityProblems(restartRaw.rows).concat(fx.compareCanonical(expectedPg, fx.projectRawRows(restartRaw.rows), 'two-inst-restart-pg')).length, 0, 'cold restart PG canonical')

    evidence.status = 'GREEN'
    evidence.nativeFrames = frames
    evidence.artifact = { env: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', path: fixture.artifact,
      servedAssets: fixture.servedAssets ? fixture.servedAssets() : null, bundleHashes: fixture.bundleHashes }
    write('result.json', evidence)
    console.log('TWO_INSTANCE_GREEN ' + JSON.stringify({ ownerOpId: ownerSent.body.opId, peerOpId: peerSent.body.opId }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    evidence.stack = error.stack
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('TWO_INSTANCE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
