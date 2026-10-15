// Deterministic delayed-ACK regression for the self-ACK convergence fix.
//
// Real compiled App + real backend. A browser-side gate holds the native ACK
// frame for the first same-UID write (v1) while the server has really committed
// it. A newer same-UID local edit (v2) is then queued. Releasing v1's ACK must
// not overwrite v2, and v2 must reach real PG. This is protection that must pass
// on final18 and on the fixed build.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
        if (gate.armed && !gate.released && /^43\d*\[/.test(raw)) {
          gate.held.push({ dispatch, event })
          return
        }
        if (handler) handler.call(socket, event)
      }
      if (desc && desc.set) desc.set.call(socket, dispatch)
      Object.defineProperty(socket, 'onmessage', {
        configurable: true,
        get () { return handler },
        set (fn) { handler = fn }
      })
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

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'ackgate-newer-intent', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString() }
  let fixture, browser, clients = []
  const uid = 'leaf-1-0'
  const v1 = '<p>ackgate-v1</p>'
  const v2 = '<p>ackgate-v2</p>'
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const client = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: seed.roomKey, onPage: async page => {
      await page.addInitScript(GATE_INIT)
    } })
    clients = [client]
    await client.page.waitForFunction(() => {
      const status = window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__()
      return status && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending
    }, null, { timeout: 120000 })

    // Arm the gate, then make the first real write.
    await client.page.evaluate(() => { window.__ackGate.armed = true; window.__ackGate.released = false; window.__ackGate.held.length = 0 })
    await client.page.evaluate(({ uid, v1 }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), v1) }, { uid, v1 })

    // v1 must be really committed in PG while its ACK is held.
    let v1Committed = false
    const commitDeadline = Date.now() + 30000
    while (Date.now() < commitDeadline) {
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      v1Committed = raw.rows.find(row => row.uid === uid && !row.deleted_at).data.text === v1
      if (v1Committed) break
      await sleep(200)
    }
    assert.equal(v1Committed, true, 'v1 committed in real PG while its ACK is held')
    const heldStatus = await client.page.evaluate(() => ({ status: window.__onlineMM.cooperate.collabV2Adapter.getStatus(), held: window.__ackGate.held.length }))
    assert.equal(heldStatus.held >= 1, true, 'the v1 native ACK frame is held (not delivered)')
    evidence.v1 = { committed: true, heldFrames: heldStatus.held, adapterPending: heldStatus.status.pendingCount }

    // Newer same-UID local intent while v1 ACK is still pending.
    await client.page.evaluate(({ uid, v2 }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), v2) }, { uid, v2 })
    let newerQueued = false
    const queueDeadline = Date.now() + 20000
    while (Date.now() < queueDeadline) {
      const status = await client.page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus())
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      const pgText = raw.rows.find(row => row.uid === uid && !row.deleted_at).data.text
      if (status.outboxPending >= 1 && pgText === v1) { newerQueued = true; break }
      await sleep(200)
    }
    assert.equal(newerQueued, true, 'a newer same-UID local edit is queued while v1 ACK is held (PG still v1)')
    const preRelease = await client.page.evaluate(uid => window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), uid)
    assert.equal(preRelease, v2, 'local model shows the newer value before v1 ACK is released')
    evidence.preRelease = { modelText: preRelease }

    // Release the held v1 ACK and let the newer intent reach PG.
    await client.page.evaluate(() => window.__ackGate.release())
    let converged = null
    const convergedDeadline = Date.now() + 60000
    while (Date.now() < convergedDeadline) {
      const status = await client.page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus())
      const modelText = await client.page.evaluate(uid => window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), uid)
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      const pgText = raw.rows.find(row => row.uid === uid && !row.deleted_at).data.text
      converged = { modelText, pgText, phase: status.phase, saveState: status.saveState, outboxPending: status.outboxPending, pendingCount: status.pendingCount }
      if (modelText === v2 && pgText === v2 && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending) break
      await sleep(250)
    }
    evidence.afterRelease = converged
    assert.equal(converged.modelText, v2, 'v1 ACK must not overwrite the newer local value v2')
    assert.equal(converged.pgText, v2, 'newer local value v2 is durably saved in real PG')
    evidence.status = 'GREEN'
    write('result.json', evidence)
    console.log('ACKGATE_GREEN')
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    console.error('ACKGATE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
