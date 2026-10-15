// RED/GREEN regression: a single real MOVE_NODE_TO must not leave a redundant
// position/style write that a single Undo (BACK) later targets instead of the
// move. Contract: exactly one BACK returns the moved node to its original parent.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const MOVED = 'branch-3'
const TARGET = 'branch-0'

async function parentOf (client, uid) {
  return client.page.evaluate(uid => {
    const node = window.__onlineMM.renderer.findNodeByUid(uid)
    return node && node.parent ? node.parent.getData('uid') : null
  }, uid)
}
async function pgParent (fixture, roomKey, uid) {
  const raw = await fixture.apps[0].control('rawNodes', { roomKey })
  const row = raw.rows.find(r => r.uid === uid && !r.deleted_at)
  return row ? row.parent_uid : null
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'move-undo', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString() }
  let fixture, browser, clients = []
  const frames = []
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    fixture.roomKey = seed.roomKey
    evidence.roomKey = seed.roomKey
    assert.equal(await pgParent(fixture, seed.roomKey, MOVED), 'root', 'fixture starts under root')
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const client = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: seed.roomKey, onPage: async page => {
      observe.observeWire(page, 0, frames)
    } })
    clients = [client]
    await settled(client)

    const moveStart = frames.length
    await client.page.evaluate(({ moved, target }) => {
      const mm = window.__onlineMM
      mm.execCommand('MOVE_NODE_TO', mm.renderer.findNodeByUid(moved), mm.renderer.findNodeByUid(target))
    }, { moved: MOVED, target: TARGET })
    await client.page.waitForFunction(({ moved, target }) => {
      const n = window.__onlineMM.renderer.findNodeByUid(moved)
      return n && n.parent && n.parent.getData('uid') === target
    }, { moved: MOVED, target: TARGET }, { timeout: 60000 })

    // Wait for the move op ACK and its durable PG parent change.
    let moveAck = null
    const ackDeadline = Date.now() + 30000
    while (Date.now() < ackDeadline) {
      const sent = frames.slice(moveStart).find(f => f.direction === 'sent' && f.event === 'op' && f.body.type === 'node.move' && JSON.stringify(f.body.payload).includes(MOVED))
      moveAck = sent && frames.slice(moveStart).find(f => f.direction === 'received' && f.kind === 'ack' && f.body.opId === sent.body.opId && f.body.ok)
      if (moveAck && await pgParent(fixture, seed.roomKey, MOVED) === TARGET) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(moveAck, 'move ACK received')
    const moveAckRevision = Number(moveAck.body.serverRevision)
    evidence.moveAck = { opId: moveAck.body.opId, serverRevision: moveAckRevision }
    // Let the post-move flush settle (bounded), then inspect for a redundant
    // position/style write after the move ACK.
    await new Promise(resolve => setTimeout(resolve, 3000))
    await settled(client)
    const afterMove = frames.slice(moveStart)
    const PROTOCOL_META = new Set(['uid', 'traceId', 'clientSeq', 'baseRevision', '__fv'])
    const STYLE_KEYS = new Set(['isFloating', 'customLeft', 'customTop'])
    const redundant = afterMove.filter(f => {
      if (f.direction !== 'sent' || f.event !== 'op') return false
      if (!JSON.stringify(f.body.payload || {}).includes(MOVED)) return false
      const type = f.body.type
      if (type !== 'node.update' && type !== 'node.updated') return false
      const raw = f.body.payload || {}
      const patch = raw.patch || raw.data || raw
      const keys = Object.keys(patch).filter(key => !PROTOCOL_META.has(key))
      return keys.length > 0 && keys.every(key => STYLE_KEYS.has(key))
    })
    evidence.redundantPositionWrites = redundant.map(f => ({ opId: f.body.opId, type: f.body.type, patch: f.body.payload && f.body.payload.patch }))
    assert.equal(redundant.length, 0, 'no redundant position/style write after the move ACK')

    // Exactly one BACK must return the node to its original parent.
    await client.page.evaluate(async () => {
      const mm = window.__onlineMM
      mm.execCommand('BACK')
      if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue
    })
    let restored = null
    const backDeadline = Date.now() + 30000
    while (Date.now() < backDeadline) {
      restored = { model: await parentOf(client, MOVED), pg: await pgParent(fixture, seed.roomKey, MOVED) }
      if (restored.model === 'root' && restored.pg === 'root') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    evidence.afterOneBack = restored
    assert.equal(restored.pg, 'root', 'one BACK restores the original parent in PG')
    assert.equal(restored.model, 'root', 'one BACK restores the original parent in the model')
    evidence.status = 'GREEN'
    evidence.nativeFrames = frames
    evidence.artifact = { env: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', path: fixture.artifact,
      servedAssets: fixture.servedAssets ? fixture.servedAssets() : null, bundleHashes: fixture.bundleHashes }
    write('result.json', evidence)
    write('native-frames.json', frames)
    console.log('MOVE_UNDO_GREEN')
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('MOVE_UNDO_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
