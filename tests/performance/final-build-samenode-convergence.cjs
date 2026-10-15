// Minimal deterministic regression: same-node concurrent edits must converge.
//
// Two real compiled-App actors in one room concurrently write the SAME node.
// The server serializes both (both must ACK with distinct opIds/clientIds and
// the real PG operation log must contain both). After both ACKs the live models
// must converge to the authoritative PG value and must not retain a changed
// unsent diff for the node. On final18 the later author keeps the earlier value
// while PG holds the later value, and a product resync does not heal it.
//
// This test is the immutable regression; assertions must not change when the
// production fix lands.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const fx = require('./final-build-fixtures.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function snapshot (fixture, clients, uid) {
  const per = await Promise.all(clients.map(client => client.page.evaluate(uid => {
    const mm = window.__onlineMM, cooperate = mm.cooperate, adapter = cooperate.collabV2Adapter
    const node = mm.renderer.findNodeByUid(uid)
    let patch = null
    try { patch = cooperate.nodePatchPayload(node, { onlyChanged: true }) } catch (error) { patch = { error: error.message } }
    return { userId: adapter.getStatus().userId, clientId: adapter.getClientId(),
      text: node ? node.getData('text') : null, phase: adapter.getStatus().phase,
      saveState: adapter.getStatus().saveState, pendingCount: adapter.getStatus().pendingCount,
      outboxPending: adapter.getStatus().outboxPending, lastServerRevision: adapter.getStatus().lastServerRevision,
      pendingTextUids: cooperate._pendingTextUids ? Array.from(cooperate._pendingTextUids) : null,
      lastPushedText: cooperate.lastPushed && cooperate.lastPushed[uid] && cooperate.lastPushed[uid].text,
      changedPatch: patch === null ? null : JSON.stringify(patch) }
  }, uid)))
  const raw = await fixture.apps[0].control('rawNodes', { roomKey: fixture.roomKey })
  const pgText = raw.rows.find(row => row.uid === uid && !row.deleted_at).data.text
  const state = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
  return { per, pgText, operations: state.operations }
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'red-samenode', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, test: 'final-build-samenode-convergence.cjs', testSha256: testSha, startedAt: new Date().toISOString() }
  const frames = []
  let fixture, browser, clients = []
  const uid = 'leaf-3-0'
  const candidateA = '<p>Same node A</p>'
  const candidateB = '<p>Same node B</p>'
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    evidence.seed = seed
    evidence.optimizedFlags = 'code defaults (OFF)'
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => {
        observe.observeWire(page, clients.length, frames)
      } })
      clients.push(client)
    }
    // Both actors reach LIVE and a clean baseline.
    for (const client of clients) {
      await client.page.waitForFunction(() => {
        const status = window.__COLLAB_V2_STATUS__ && window.__COLLAB_V2_STATUS__()
        const mm = window.__onlineMM
        return status && status.phase === 'LIVE' && !status.pendingCount && !status.outboxPending && mm && !mm.renderer.isRendering
      }, null, { timeout: 120000 })
    }
    evidence.baseline = await snapshot(fixture, clients, uid)
    assert.equal(evidence.baseline.per[0].userId, 'e2e-owner')
    assert.equal(evidence.baseline.per[1].userId, 'e2e-editor-a')
    assert.notEqual(evidence.baseline.per[0].clientId, evidence.baseline.per[1].clientId)

    // Concurrent same-node writes.
    await Promise.all([
      clients[0].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid, text: candidateA }),
      clients[1].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid, text: candidateB })
    ])

    // Wait until the real native transport ACKed both same-node writes.
    const deadline = Date.now() + 60000
    let sameNodeAcks = []
    while (Date.now() < deadline) {
      sameNodeAcks = frames.filter(frame => frame.direction === 'received' && frame.kind === 'ack' && frame.body && frame.body.ok &&
        JSON.stringify(frame.body).includes(uid))
      if (sameNodeAcks.length >= 2) break
      await sleep(200)
    }
    evidence.sent = frames.filter(frame => frame.direction === 'sent' && frame.event === 'op' && JSON.stringify(frame.body.payload || {}).includes(uid))
    evidence.acks = sameNodeAcks
    assert.equal(evidence.sent.length, 2, 'both intended writes were sent over the native socket')
    assert.equal(new Set(evidence.sent.map(frame => frame.body.opId)).size, 2, 'the two writes use distinct operation ids')
    assert.equal(new Set(evidence.sent.map(frame => frame.client)).size, 2, 'the two writes come from distinct actors')

    // Explicit postcondition: each sent opId has its own successful native ACK.
    const sentOpIds = evidence.sent.map(frame => frame.body.opId)
    let ackByOpId = {}
    const ackDeadline = Date.now() + 60000
    while (Date.now() < ackDeadline) {
      ackByOpId = {}
      for (const frame of frames) {
        if (frame.direction === 'received' && frame.kind === 'ack' && frame.body && frame.body.ok && sentOpIds.includes(frame.body.opId)) {
          ackByOpId[frame.body.opId] = frame
        }
      }
      if (Object.keys(ackByOpId).length === sentOpIds.length) break
      await sleep(200)
    }
    assert.equal(Object.keys(ackByOpId).length, sentOpIds.length, 'each sent opId received its own successful native ACK')
    for (const opId of sentOpIds) assert.ok(ackByOpId[opId], 'successful ACK present for ' + opId)
    evidence.acksByOpId = ackByOpId

    // Bounded convergence window for the live models to match authoritative PG.
    let observed
    const convergeDeadline = Date.now() + 30000
    while (Date.now() < convergeDeadline) {
      observed = await snapshot(fixture, clients, uid)
      const texts = observed.per.map(item => item.text)
      const converged = texts.every(text => text === observed.pgText) && new Set(texts).size === 1
      if (converged) break
      await sleep(500)
    }
    evidence.observed = observed
    evidence.pgOperations = observed.operations.map(operation => ({ operationId: operation.operation_id, version: operation.version }))

    const expectedOperationIds = new Set(evidence.sent.map(frame => frame.body.opId))
    const pgOperationIds = new Set(observed.operations.map(operation => operation.operation_id))
    assert.deepEqual([...expectedOperationIds].every(id => pgOperationIds.has(id)), true, 'both real PG operations are durable')
    assert.ok([candidateA, candidateB].includes(observed.pgText), 'authoritative PG winner is one of the two intended candidates: ' + observed.pgText)

    // Core acceptance: every actor's live model equals authoritative PG and no
    // actor retains a changed unsent diff for the raced node.
    const diverged = observed.per.filter(item => item.text !== observed.pgText)
    const staleWorklist = observed.per.filter(item => item.pendingTextUids && item.pendingTextUids.includes(uid) && item.changedPatch)
    write('observed.json', { ...evidence, diverged: diverged.map(item => ({ userId: item.userId, text: item.text, pgText: observed.pgText, changedPatch: item.changedPatch })), staleWorklist })

    assert.deepEqual(diverged.map(item => ({ userId: item.userId, text: item.text })), [], 'every actor model converges to the authoritative PG value')
    assert.deepEqual(staleWorklist.map(item => ({ userId: item.userId, changedPatch: item.changedPatch })), [], 'no actor retains a changed unsent diff after both ACKs')
    evidence.status = 'GREEN'
    write('result.json', evidence)
    console.log('SAMENODE_GREEN')
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('SAMENODE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(error => { process.exitCode = 1 })
module.exports = { main }
