// BLOCKING dual-actor ACK-gate race regression.
//
// Two actors race the SAME UID; both writes really commit to PG. The later
// committed actor has committedRevision > its own sendBase + 1, so its ACK
// exercises the adapter's commit-gap self-apply branch. With that ACK held, the
// actor types a newer same-UID value v2 that is still only a local unsent intent
// (no v2 durable outbox row yet); releasing the held ACK must not overwrite v2,
// and v2 must still reach real PG.
//
// final19 is expected RED here; the fix must make it GREEN without touching the
// frozen samenode regression.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const UID = 'leaf-2-0'
const RACE_A = '<p>race-A</p>'
const RACE_B = '<p>race-B</p>'
const V2 = '<p>unsent-v2</p>'

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

function opFrames (frames, uid, text) {
  const sent = frames.filter(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(uid) && JSON.stringify(f.body.payload || {}).includes(text))
  return sent
}
function ackFor (frames, opId) {
  return frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId)
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'dual-ackgate-race', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), uid: UID }
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
        const index = clients.length
        observe.observeWire(page, index, frames)
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
    const pgBefore = (await fixture.apps[0].control('state', { roomKey: seed.roomKey })).operations.length

    // Arm both gates, then race the same UID.
    await Promise.all(clients.map(client => client.page.evaluate(() => { window.__ackGate.armed = true; window.__ackGate.released = false; window.__ackGate.held.length = 0 })))
    await Promise.all([
      clients[0].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: UID, text: RACE_A }),
      clients[1].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: UID, text: RACE_B })
    ])

    // Both writes must really commit and both ACKs must be observed on the wire
    // (held in-browser but visible to the raw Playwright transport observer).
    let race = null
    const raceDeadline = Date.now() + 60000
    while (Date.now() < raceDeadline) {
      const sentA = opFrames(frames, UID, 'race-A')[0]
      const sentB = opFrames(frames, UID, 'race-B')[0]
      const ackA = sentA && ackFor(frames, sentA.body.opId)
      const ackB = sentB && ackFor(frames, sentB.body.opId)
      const state = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
      const opsOk = ackA && ackA.body && ackA.body.ok === true && ackB && ackB.body && ackB.body.ok === true
      const pgHasBoth = sentA && sentB && state.operations.some(op => op.operation_id === sentA.body.opId) && state.operations.some(op => op.operation_id === sentB.body.opId)
      if (sentA && sentB && opsOk && pgHasBoth) { race = { sentA, sentB, ackA, ackB, state }; break }
      await sleep(200)
    }
    assert.ok(race, 'both same-UID writes committed and both ACKs ok registered the same opIds')
    assert.equal(race.ackA.body.ok, true, 'first ACK is ok')
    assert.equal(race.ackB.body.ok, true, 'second ACK is ok')
    assert.ok(race.state.operations.some(op => op.operation_id === race.sentA.body.opId), 'first opId is durable in PG')
    assert.ok(race.state.operations.some(op => op.operation_id === race.sentB.body.opId), 'second opId is durable in PG')
    assert.notEqual(race.sentA.body.opId, race.sentB.body.opId, 'distinct opIds')
    assert.notEqual(race.sentA.body.clientId, race.sentB.body.clientId, 'distinct clientIds')
    assert.notEqual(race.sentA.body.userId, race.sentB.body.userId, 'distinct userIds')
    evidence.race = {
      commits: race.state.operations.slice(-2),
      ops: [ { opId: race.sentA.body.opId, client: race.sentA.client, sendBase: race.sentA.body.payload.baseRevision, ackRevision: race.ackA.body.serverRevision },
        { opId: race.sentB.body.opId, client: race.sentB.client, sendBase: race.sentB.body.payload.baseRevision, ackRevision: race.ackB.body.serverRevision } ]
    }
    const infoA = evidence.race.ops[0], infoB = evidence.race.ops[1]
    const later = Number(infoA.ackRevision) >= Number(infoB.ackRevision) ? infoA : infoB
    assert.ok(Number(later.ackRevision) > Number(later.sendBase) + 1, 'later committed actor has a real commit gap (rev > sendBase + 1)')
    evidence.later = later
    const laterClient = clients[later.client]

    // Held ACK for the later actor?
    const heldBefore = await laterClient.page.evaluate(() => window.__ackGate.held.length)
    assert.ok(heldBefore >= 1, 'the later actor ACK frame is held, not delivered')

    // Type v2 and release the held ACK immediately, capturing whether v2 already
    // has a durable outbox row at release time (it must not, to prove this branch).
    const releaseObservation = await laterClient.page.evaluate(async ({ uid, v2 }) => {
      const mm = window.__onlineMM
      const adapter = mm.cooperate.collabV2Adapter
      mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), v2)
      const modelTextAtRelease = mm.renderer.findNodeByUid(uid).getData('text')
      const pendingTextUids = mm.cooperate._pendingTextUids ? Array.from(mm.cooperate._pendingTextUids) : null
      const statusAtRelease = adapter.getStatus()
      const inspectAtRelease = (statusAtRelease.outboxInspect || []).slice()
      // Read the real native IDB outbox while the ACK is still held. Errors are
      // NOT swallowed: an unreadable outbox invalidates the boundary proof.
      const readStartedAt = Date.now()
      const rows = await new Promise((resolve, reject) => {
        const open = indexedDB.open('mind-map-collab-v2', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('outbox', 'readonly')
          const request = tx.objectStore('outbox').getAll()
          request.onerror = () => reject(request.error)
          request.onsuccess = () => { const all = request.result || []; tx.oncomplete = () => db.close(); resolve(all) }
        }
      })
      const readCompletedAt = Date.now()
      const v2RowsAtRelease = rows.filter(row => JSON.stringify((row && row.payload) || {}).includes('unsent-v2'))
        .map(row => ({ opId: row.opId, status: row.status, clientSeq: row.clientSeq }))
      const releasedAt = Date.now()
      window.__ackGate.release()
      return { modelTextAtRelease, pendingTextUids, outboxPendingAtRelease: statusAtRelease.outboxPending,
        pendingCountAtRelease: statusAtRelease.pendingCount, inspectAtRelease, idbRowCount: rows.length,
        v2RowsAtRelease, readStartedAt, readCompletedAt, releasedAt, releasedFrames: window.__ackGate.releasedFrames }
    }, { uid: UID, v2: V2 })
    evidence.releaseObservation = releaseObservation
    // Boundary proof: the newer v2 intent had no durable outbox row when the
    // held ACK was released; it was only an in-memory local intent.
    assert.equal(releaseObservation.v2RowsAtRelease.length, 0, 'no durable v2 outbox row existed while the ACK was held')
    assert.ok(releaseObservation.releasedAt >= releaseObservation.readCompletedAt, 'ACK released only after the IDB boundary read')

    // v2 must survive the held-ACK release and persist to real PG.
    let converged = null
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const modelText = await laterClient.page.evaluate(uid => window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), UID)
      const status = await laterClient.page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus())
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      const pgText = raw.rows.find(row => row.uid === UID && !row.deleted_at).data.text
      converged = { modelText, pgText, phase: status.phase, saveState: status.saveState, pendingCount: status.pendingCount, outboxPending: status.outboxPending }
      if (modelText === V2 && pgText === V2 && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending) break
      await sleep(250)
    }
    evidence.converged = converged
    // Persistence is the primary contract; report the release-time durability
    // observation as branch evidence.
    assert.equal(converged.pgText, V2, 'newer unsent intent v2 is durably saved in real PG')
    assert.equal(converged.modelText, V2, 'held-ACK self apply must not overwrite the newer unsent intent v2')
    evidence.status = 'GREEN'
    write('result.json', evidence)
    console.log('DUAL_ACKGATE_GREEN ' + JSON.stringify({ later, releaseObservation }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('DUAL_ACKGATE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
