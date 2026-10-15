// BLOCKING variant 2: a different-UID authoritative op advances the global
// revision between a same-UID race and the later actor's held ACK. A global
// currentRevision > ackRevision guard would permanently skip repairing the
// raced UID. The per-UID authoritative revision must still repair it while a
// genuinely newer authoritative value for the SAME UID must still win.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const UID0 = 'leaf-0-2'
const UID1 = 'leaf-1-2'
const RACE_A = '<p>race2-A</p>'
const RACE_B = '<p>race2-B</p>'
const OTHER = '<p>other-uid-rev3</p>'

const GATE_INIT = () => {
  const Prior = window.WebSocket
  window.__ackGate = { armed: false, released: false, held: [], releasedFrames: 0 }
  window.WebSocket = new Proxy(Prior, {
    construct (target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget)
      const desc = Object.getOwnPropertyDescriptor(Prior.prototype, 'onmessage')
      let handler = null
      const dispatch = event => {
        const raw = typeof event.data === 'string' ? event.data : ''
        const gate = window.__ackGate
        if (gate.armed && !gate.released && /^43\d*\[/.test(raw)) { gate.held.push({ dispatch, event }); return }
        if (handler) handler.call(socket, event)
      }
      if (desc && desc.set) desc.set.call(socket, dispatch)
      Object.defineProperty(socket, 'onmessage', { configurable: true, get () { return handler }, set (fn) { handler = fn } })
      return socket
    }
  })
  window.__ackGate.release = () => {
    const gate = window.__ackGate
    gate.released = true
    const held = gate.held.splice(0)
    gate.releasedFrames = held.length
    for (const item of held) item.dispatch(item.event)
  }
}
const opFrames = (frames, uid, text) => frames.filter(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(uid) && JSON.stringify(f.body.payload || {}).includes(text))
const ackFor = (frames, opId) => frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId)

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'dual-ackgate-race2', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), uid0: UID0, uid1: UID1 }
  let fixture, browser, clients = []
  const frames = []
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => {
        observe.observeWire(page, clients.length, frames)
        await page.addInitScript(GATE_INIT)
      } })
      clients.push(client)
    }
    for (const client of clients) {
      await client.page.waitForFunction(() => {
        const status = window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__()
        return status && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending
      }, null, { timeout: 120000 })
    }
    await Promise.all(clients.map(client => client.page.evaluate(() => { window.__ackGate.armed = true; window.__ackGate.released = false; window.__ackGate.held.length = 0 })))
    await Promise.all([
      clients[0].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: UID0, text: RACE_A }),
      clients[1].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: UID0, text: RACE_B })
    ])
    let race = null
    const raceDeadline = Date.now() + 60000
    while (Date.now() < raceDeadline) {
      const sentA = opFrames(frames, UID0, 'race2-A')[0]
      const sentB = opFrames(frames, UID0, 'race2-B')[0]
      const ackA = sentA && ackFor(frames, sentA.body.opId)
      const ackB = sentB && ackFor(frames, sentB.body.opId)
      const state = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
      const ok = ackA && ackA.body.ok && ackB && ackB.body.ok
      const pgBoth = sentA && sentB && state.operations.some(o => o.operation_id === sentA.body.opId) && state.operations.some(o => o.operation_id === sentB.body.opId)
      if (ok && pgBoth) { race = { sentA, sentB, ackA, ackB, state }; break }
      await sleep(200)
    }
    assert.ok(race, 'both race writes committed')
    const infoA = { client: race.sentA.client, opId: race.sentA.body.opId, sendBase: race.sentA.body.payload.baseRevision, ackRevision: race.ackA.body.serverRevision, text: RACE_A }
    const infoB = { client: race.sentB.client, opId: race.sentB.body.opId, sendBase: race.sentB.body.payload.baseRevision, ackRevision: race.ackB.body.serverRevision, text: RACE_B }
    const earlier = Number(infoA.ackRevision) < Number(infoB.ackRevision) ? infoA : infoB
    const later = earlier === infoA ? infoB : infoA
    assert.ok(Number(later.ackRevision) > Number(later.sendBase) + 1, 'later actor has a commit gap')
    evidence.later = later
    evidence.earlier = earlier
    const laterClient = clients[later.client]
    const earlierClient = clients[earlier.client]

    // Observe whether the earlier committed op reaches the later actor's model
    // while its own ACK is held (bounded diagnostic, no long wait).
    let overwriteObserved = false
    const overwriteDeadline = Date.now() + 8000
    while (Date.now() < overwriteDeadline) {
      const snapshot = await laterClient.page.evaluate(uid => ({ text: window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), status: window.__onlineMM.cooperate.collabV2Adapter.getStatus() }), UID0)
      if (snapshot.text === earlier.text) { overwriteObserved = true; break }
      await sleep(200)
    }
    evidence.overwriteObserved = overwriteObserved
    evidence.laterSnapshotAfterRace = await laterClient.page.evaluate(uid => ({ text: window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), status: window.__onlineMM.cooperate.collabV2Adapter.getStatus() }), UID0)
    assert.equal(overwriteObserved, true, 'precondition: the earlier authoritative op overwrote the later actor model while its ACK was held')
    evidence.laterModelAfterOverwrite = earlier.text

    // Free the earlier actor (its first ACK was held): release it and wait for
    // an idle adapter before it performs the different-UID write, otherwise its
    // serialized flush blocks.
    await earlierClient.page.evaluate(() => window.__ackGate.release())
    await earlierClient.page.waitForFunction(() => {
      const status = window.__onlineMM.cooperate.collabV2Adapter.getStatus()
      return status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending
    }, null, { timeout: 60000 })

    // A different-UID write advances the authoritative global revision to 3.
    await earlierClient.page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: UID1, text: OTHER })
    await laterClient.page.waitForFunction(({ uid, text }) => window.__onlineMM.renderer.findNodeByUid(uid).getData('text') === text, { uid: UID1, text: OTHER }, { timeout: 30000 })
    const globalRev = await laterClient.page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus().lastServerRevision)
    assert.ok(Number(globalRev) >= 3, 'a different-UID authoritative op advanced the global revision before the raced ACK release')
    evidence.globalRevBeforeRelease = globalRev

    // Release the later actor's held raced ACK. The raced UID must repair to its
    // authoritative committed value even though a different UID advanced the head.
    await laterClient.page.evaluate(() => window.__ackGate.release())
    let converged = null
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const modelText = await laterClient.page.evaluate(uid => window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), UID0)
      const status = await laterClient.page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus())
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      const pgText = raw.rows.find(row => row.uid === UID0 && !row.deleted_at).data.text
      converged = { modelText, pgText, phase: status.phase, pendingCount: status.pendingCount, outboxPending: status.outboxPending }
      if (modelText === later.text && pgText === later.text && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending) break
      await sleep(250)
    }
    evidence.converged = converged
    assert.equal(converged.pgText, later.text, 'raced UID authoritative value is durable in PG')
    assert.equal(converged.modelText, later.text, 'raced UID repairs to its authoritative value despite a different-UID head advance')
    evidence.status = 'GREEN'
    write('result.json', evidence)
    console.log('DUAL_ACKGATE2_GREEN ' + JSON.stringify({ later, globalRev }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('DUAL_ACKGATE2_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
