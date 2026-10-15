// Supplementary cross-instance LIVE collaboration: two real backend processes
// with the existing COLLAB_V2_EVENT_BRIDGE=1 enabled by test config only (the
// product default stays OFF). No test-initiated resync: actors must receive the
// native op:event across instances and converge, with full canonical checks.
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
function waitAck (frames, opId) { return frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId && f.body.ok) }
function eventFor (frames, opId, client) { return frames.find(f => f.client === client && f.direction === 'received' && f.event === 'op:event' && f.body && f.body.opId === opId) }
async function waitText (client, uid, text) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const v = await client.page.evaluate(uid => { const n = window.__onlineMM.renderer.findNodeByUid(uid); return n ? n.getData('text') : null }, uid)
    if (v === text) return true
    await sleep(300)
  }
  return false
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'run-' + runId, 'two-instance-live')
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), profile: 'bridge', bridge: true }
  let fixture, browser, clients = []
  const frames = []
  try {
    fixture = await startFinalFixture({ instances: 2, profile: 'bridge' })
    evidence.instancePids = fixture.apps.map(app => app.pid)
    evidence.instanceBases = fixture.apps.map(app => app.base)
    assert.equal(new Set(fixture.apps.map(app => app.pid)).size, 2, 'two distinct backend PIDs')
    assert.equal(new Set(fixture.apps.map(app => new URL(app.base).port)).size, 2, 'two distinct backend ports')
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    const expected = fx.buildSmallGraph()
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    clients.push(await openActorEditor(browser, fixture, { actor: 'owner', roomKey: seed.roomKey, frontIndex: 0, onPage: async page => observe.observeWire(page, 0, frames) }))
    clients.push(await openActorEditor(browser, fixture, { actor: 'editor-a', roomKey: seed.roomKey, frontIndex: 1, onPage: async page => observe.observeWire(page, 1, frames) }))
    await Promise.all(clients.map(settled))
    const identities = await Promise.all(clients.map(c => c.page.evaluate(() => { const a = window.__onlineMM.cooperate.collabV2Adapter; return { userId: a.getStatus().userId, clientId: a.getClientId() } })))
    evidence.identities = identities
    assert.equal(identities[0].userId, 'e2e-owner')
    assert.equal(identities[1].userId, 'e2e-editor-a')
    assert.notEqual(identities[0].clientId, identities[1].clientId)

    // Instance-0 edit -> instance-1 must receive native op:event and converge
    // with NO test-initiated resync.
    const ownerText = '<p>live owner</p>'
    await clients[0].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), t) }, ownerText)
    assert.equal(await waitText(clients[1], 'root', ownerText), true, 'instance-1 converges from the live op:event (no resync)')
    const ownerSent = frames.find(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(ownerText))
    assert.ok(ownerSent && waitAck(frames, ownerSent.body.opId), 'instance-0 edit ACKed')
    const ownerEvent = eventFor(frames, ownerSent.body.opId, 1)
    assert.ok(ownerEvent, 'instance-1 received the native op:event for the instance-0 edit')

    // Instance-1 edit -> instance-0 live.
    const peerText = '<p>live peer</p>'
    await clients[1].page.evaluate(t => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-0-0'), t) }, peerText)
    assert.equal(await waitText(clients[0], 'leaf-0-0', peerText), true, 'instance-0 converges from the live op:event (no resync)')
    const peerSent = frames.find(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(peerText))
    assert.ok(peerSent && waitAck(frames, peerSent.body.opId), 'instance-1 edit ACKed')
    assert.ok(eventFor(frames, peerSent.body.opId, 0), 'instance-0 received the native op:event for the instance-1 edit')
    await settled(clients[0]); await settled(clients[1])

    const state = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.ok(state.operations.some(op => op.operation_id === ownerSent.body.opId) && state.operations.some(op => op.operation_id === peerSent.body.opId), 'both cross-instance opIds durable in shared PG')
    expected.root.data.text = ownerText
    expected['leaf-0-0'].data.text = peerText
    const expectedBrowser = fx.canonicalGraph(expected, { browserLeafExpand: true })
    const expectedPg = fx.canonicalGraph(expected)
    for (const [i, c] of clients.entries()) {
      const problems = fx.compareCanonical(expectedBrowser, fx.projectBrowserModel(await rows(c)), 'live-actor-' + i)
      assert.equal(problems.length, 0, 'actor ' + i + ' canonical after bidirectional live edits')
    }
    const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
    assert.equal(fx.rawIntegrityProblems(raw.rows).concat(fx.compareCanonical(expectedPg, fx.projectRawRows(raw.rows), 'live-pg')).length, 0, 'shared PG canonical')

    evidence.status = 'GREEN'
    evidence.nativeFrames = frames
    evidence.artifact = { env: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', path: fixture.artifact,
      servedAssets: fixture.servedAssets ? fixture.servedAssets() : null, bundleHashes: fixture.bundleHashes }
    write('result.json', evidence)
    console.log('TWO_INSTANCE_LIVE_GREEN ' + JSON.stringify({ ownerPid: fixture.apps[0].pid, peerPid: fixture.apps[1].pid }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    evidence.stack = error.stack
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('TWO_INSTANCE_LIVE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
