// Focused interleaving protection for the self-ACK convergence fix.
//
// Cases:
//  1. stale-ack-after-newer-server-op: a self ACK whose revision is older than
//     an already applied authoritative remote op must not rewind the model.
//  2. batch-stale: a stale self batch.applied must not bypass the authoritative
//     revision guard through its recursive children.
//  3. rapid-newer-intent-and-competition: a newer local same-UID edit plus a
//     competing remote edit must converge on every actor and in real PG.
//
// Cases 1 and 3 are RED on final18; case 2 is protection that must stay green.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'interleavings', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, cases: [], startedAt: new Date().toISOString() }
  let fixture, browser, clients = []
  const frames = []
  const check = (name, fn) => {
    try { fn(); evidence.cases.push({ name, ok: true }); return true }
    catch (error) { evidence.cases.push({ name, ok: false, error: error.message }); throw error }
  }
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => observe.observeWire(page, clients.length, frames) })
      clients.push(client)
    }
    await Promise.all(clients.map(settled))

    // Establish a non-zero server revision so revision guards are exercised.
    await clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), '<p>baseline-revision</p>') })
    await clients[0].page.waitForFunction(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus().lastServerRevision >= 1, null, { timeout: 60000 })
    await Promise.all(clients.map(settled))

    const applyRemote = (client, op, meta) => client.page.evaluate(({ op, meta }) => window.__onlineMM.cooperate.applyV2RemoteOperation(op, meta), { op, meta })
    const nodeText = (client, uid) => client.page.evaluate(uid => window.__onlineMM.renderer.findNodeByUid(uid).getData('text'), uid)

    // --- Case 1: stale self ACK after a newer authoritative server op ---
    const uid = 'leaf-0-1'
    const newer = '<p>authoritative-newer</p>'
    const stale = '<p>stale-self-ack</p>'
    const base = await clients[0].page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus().lastServerRevision)
    await applyRemote(clients[0], { opId: 'interleave-newer-1', type: 'node.updated', clientId: 'other-authoritative-client', serverRevision: base + 1, payload: { uid, patch: { text: newer } } })
    await clients[0].page.evaluate(value => window.__onlineMM.cooperate.collabV2Adapter.setLastServerRevision(value), base + 1)
    assert.equal(await nodeText(clients[0], uid), newer, 'authoritative remote op applied')
    await applyRemote(clients[0], { opId: 'interleave-stale-1', type: 'node.updated', clientId: await clients[0].page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getClientId()), serverRevision: base, payload: { uid, patch: { text: stale } } }, { applySelf: true, fromAck: true, capturedIntentEpochs: {} })
    const afterStale = await nodeText(clients[0], uid)
    check('stale-ack-does-not-rewind', () => assert.equal(afterStale, newer, 'stale self ACK must not rewind an authoritative newer op'))
    evidence.case1 = { uid, base, newer, stale, afterStale }

    // --- Case 2: stale self batch.applied must not bypass the revision guard ---
    const uid2 = 'leaf-1-1'
    const newer2 = '<p>batch-authoritative-newer</p>'
    const batchStale = '<p>batch-stale-self</p>'
    const base2 = await clients[0].page.evaluate(() => window.__onlineMM.cooperate.collabV2Adapter.getStatus().lastServerRevision)
    await applyRemote(clients[0], { opId: 'interleave-newer-2', type: 'node.updated', clientId: 'other-authoritative-client', serverRevision: base2 + 1, payload: { uid: uid2, patch: { text: newer2 } } })
    await clients[0].page.evaluate(value => window.__onlineMM.cooperate.collabV2Adapter.setLastServerRevision(value), base2 + 1)
    assert.equal(await nodeText(clients[0], uid2), newer2, 'batch authoritative remote op applied')
    await applyRemote(clients[0], {
      type: 'batch.applied',
      serverRevision: base2,
      payload: { events: [{ type: 'node.updated', payload: { uid: uid2, patch: { text: batchStale } } }] }
    }, { applySelf: true, fromAck: true, capturedIntentEpochs: {} })
    const afterBatch = await nodeText(clients[0], uid2)
    check('stale-batch-does-not-rewind', () => assert.equal(afterBatch, newer2, 'stale self batch must not rewind an authoritative newer op'))
    evidence.case2 = { uid: uid2, base: base2, newer: newer2, stale: batchStale, afterBatch }

    // --- Case 3: rapid newer same-UID intent + competing remote convergence ---
    const uid3 = 'leaf-2-1'
    await Promise.all([
      clients[0].page.evaluate(uid => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), '<p>intent-v1</p>'); mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), '<p>intent-v2</p>') }, uid3),
      clients[1].page.evaluate(uid => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), '<p>competing-w</p>') }, uid3)
    ])
    let observed
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const texts = await Promise.all(clients.map(client => nodeText(client, uid3)))
      const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
      const pgText = raw.rows.find(row => row.uid === uid3 && !row.deleted_at).data.text
      observed = { texts, pgText }
      if (new Set(texts).size === 1 && texts[0] === pgText) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    evidence.case3 = observed
    check('rapid-intent-competition-converges', () => {
      assert.equal(new Set(observed.texts).size, 1, 'all actor models converge to one value: ' + JSON.stringify(observed.texts))
      assert.equal(observed.texts[0], observed.pgText, 'converged value equals authoritative PG: ' + JSON.stringify(observed))
    })

    evidence.status = 'GREEN'
    write('result.json', evidence)
    console.log('INTERLEAVINGS_GREEN ' + JSON.stringify({ cases: evidence.cases.map(c => c.name) }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('INTERLEAVINGS_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
