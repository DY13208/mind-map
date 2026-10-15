// Native structural acceptance on the compiled final build: add, delete, move,
// undo/redo with two real actors + real PG. Selection uses the real node.active()
// API (not SET_NODE_ACTIVE), and the model tree is observed via nodeData.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const PARENT = 'branch-1'

async function modelChildren (client, uid) {
  // Observe the rendered model tree (TreeNode.children), not nodeData, which can
  // be a lazy stub. Wait for a render end so the inserted node is present.
  await client.page.evaluate(() => new Promise(resolve => {
    const mm = window.__onlineMM
    const done = () => { mm.off('node_tree_render_end', done); resolve() }
    mm.on('node_tree_render_end', done)
    setTimeout(() => { mm.off('node_tree_render_end', done); resolve() }, 3000)
  }))
  return client.page.evaluate(uid => {
    const mm = window.__onlineMM
    const stack = [mm.renderer.renderTree]
    while (stack.length) {
      const n = stack.pop()
      if (!n || !n.data) continue
      if (n.data.uid === uid) return (n.children || []).map(c => c.data.uid)
      stack.push(...(n.children || []))
    }
    return null
  }, uid)
}
async function pgChildren (fixture, roomKey, uid) {
  const raw = await fixture.apps[0].control('rawNodes', { roomKey })
  return raw.rows.filter(r => !r.deleted_at && r.parent_uid === uid).map(r => r.uid)
}
async function pgActive (fixture, roomKey) {
  const raw = await fixture.apps[0].control('rawNodes', { roomKey })
  return raw.rows.filter(r => !r.deleted_at).map(r => r.uid)
}
function sentOps (frames, uidSubstring) {
  return frames.filter(f => f.direction === 'sent' && f.event === 'op' && JSON.stringify(f.body.payload || {}).includes(uidSubstring))
}
function ackOf (frames, opId) {
  return frames.find(f => f.direction === 'received' && f.kind === 'ack' && f.body && f.body.opId === opId && f.body.ok)
}

async function main () {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'structural-native', runId)
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
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => observe.observeWire(page, clients.length, frames) })
      clients.push(client)
    }
    await Promise.all(clients.map(settled))
    const before = await modelChildren(clients[0], PARENT)
    evidence.beforeChildren = before

    // Real selection: node.active() maintains renderer.activeNodeList.
    const selection = await clients[0].page.evaluate(parent => {
      const mm = window.__onlineMM
      mm.renderer.clearActiveNodeList && mm.renderer.clearActiveNodeList()
      const node = mm.renderer.findNodeByUid(parent)
      node.active()
      return { activeUids: (mm.renderer.activeNodeList || []).map(n => n.getData('uid')) }
    }, PARENT)
    evidence.selection = selection
    assert.ok(selection.activeUids.includes(PARENT), 'node.active() selects the target (real active list)')

    // Native insert via the active-node UI flow.
    await clients[0].page.evaluate(() => { window.__onlineMM.execCommand('INSERT_CHILD_NODE', false) })
    let addedUid = null
    const addDeadline = Date.now() + 10000
    while (Date.now() < addDeadline) {
      const children = await modelChildren(clients[0], PARENT)
      addedUid = (children || []).find(uid => !before.includes(uid)) || null
      if (addedUid) break
      await sleep(200)
    }
    assert.ok(addedUid, 'native INSERT_CHILD_NODE created a new model child within 10s')
    evidence.addedUid = addedUid

    // Native op + ACK + PG opId correspondence.
    let addAck = null
    const opDeadline = Date.now() + 30000
    while (Date.now() < opDeadline) {
      const sent = sentOps(frames, addedUid)[0]
      addAck = sent && ackOf(frames, sent.body.opId)
      if (addAck && (await pgActive(fixture, seed.roomKey)).includes(addedUid)) break
      await sleep(150)
    }
    assert.ok(addAck, 'insert produced a native op with a successful ACK')
    const state = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.ok(state.operations.some(op => op.operation_id === addAck.body.opId), 'insert ACK opId is durable in PG')
    evidence.addOp = { opId: addAck.body.opId, revision: addAck.body.serverRevision }

    // Peer + PG observe the insert.
    await clients[1].page.waitForFunction(({ parent, uid }) => {
      const mm = window.__onlineMM
      let target = null
      const stack = [mm.renderer.renderTree]
      while (stack.length) { const n = stack.pop(); if (!n || !n.data) continue; if (n.data.uid === parent) { target = n; break } stack.push(...(n.children || [])) }
      return !!target && ((target.children || []).some(c => c && c.data && c.data.uid === uid))
    }, { parent: PARENT, uid: addedUid }, { timeout: 60000 })
    await settled(clients[0]); await settled(clients[1])
    assert.ok((await pgChildren(fixture, seed.roomKey, PARENT)).includes(addedUid), 'PG has the added node under the target')

    // Delete -> gone on peer and PG (no stale resurrection).
    await clients[0].page.evaluate(uid => { const mm = window.__onlineMM; mm.execCommand('REMOVE_NODE', [mm.renderer.findNodeByUid(uid)]) }, addedUid)
    await clients[1].page.waitForFunction(uid => {
      const mm = window.__onlineMM
      const stack = [mm.renderer.renderTree]
      while (stack.length) { const n = stack.pop(); if (!n || !n.data) continue; if (n.data.uid === uid) return false; stack.push(...(n.children || [])) }
      return true
    }, addedUid, { timeout: 60000 })
    await settled(clients[0]); await settled(clients[1])
    assert.ok(!(await pgActive(fixture, seed.roomKey)).includes(addedUid), 'deleted node absent from active PG rows')
    assert.ok(!(await modelChildren(clients[0], PARENT)).includes(addedUid), 'deleted node removed from the model')

    // Undo restores, redo deletes (one step each).
    await clients[0].page.evaluate(async () => { const mm = window.__onlineMM; mm.execCommand('BACK'); if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue })
    await clients[1].page.waitForFunction(uid => {
      const mm = window.__onlineMM
      const stack = [mm.renderer.renderTree]
      while (stack.length) { const n = stack.pop(); if (!n || !n.data) continue; if (n.data.uid === uid) return true; stack.push(...(n.children || [])) }
      return false
    }, addedUid, { timeout: 60000 })
    await settled(clients[0]); await settled(clients[1])
    assert.ok((await pgActive(fixture, seed.roomKey)).includes(addedUid), 'undo restores the node in PG')
    await clients[0].page.evaluate(async () => { const mm = window.__onlineMM; mm.execCommand('FORWARD'); if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue })
    await clients[1].page.waitForFunction(uid => {
      const mm = window.__onlineMM
      const stack = [mm.renderer.renderTree]
      while (stack.length) { const n = stack.pop(); if (!n || !n.data) continue; if (n.data.uid === uid) return false; stack.push(...(n.children || [])) }
      return true
    }, addedUid, { timeout: 60000 })
    await settled(clients[0]); await settled(clients[1])
    assert.ok(!(await pgActive(fixture, seed.roomKey)).includes(addedUid), 'redo deletes the node in PG')

    evidence.status = 'GREEN'
    evidence.nativeFrames = frames
    evidence.artifact = { env: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web', path: fixture.artifact,
      servedAssets: fixture.servedAssets ? fixture.servedAssets() : null, bundleHashes: fixture.bundleHashes }
    evidence.actors = clients.map(c => c.actor)
    write('result.json', evidence)
    console.log('STRUCTURAL_NATIVE_GREEN ' + JSON.stringify({ addedUid }))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = error.message
    write('failure.json', evidence)
    write('native-frames.json', frames)
    console.error('STRUCTURAL_NATIVE_RED:', error.message)
    throw error
  } finally {
    try { if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture)) } catch (cleanupError) { write('cleanup-error.json', { message: cleanupError.message }) }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
