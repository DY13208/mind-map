// Bounded same-node divergence follow-up: is the stale model self-healed by
// the product's own resync / subsequent operations?
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e/diag-samenode')

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const fixture = await startFinalFixture({ instances: 1, profile: 'default' })
  const seed = await fixture.apps[0].control('seedSmall', { runId })
  const frames = []
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const clients = []
  const out = { runId, roomKey: seed.roomKey, stages: [] }
  const snap = async label => {
    const per = await Promise.all(clients.map(c => c.page.evaluate(() => {
      const mm = window.__onlineMM, co = mm.cooperate, a = co.collabV2Adapter
      const node = mm.renderer.findNodeByUid('leaf-3-0')
      let patch = null
      try { patch = co.nodePatchPayload(node, { onlyChanged: true }) } catch (e) { patch = 'ERR' }
      return { userId: a.getStatus().userId, text: node.getData('text'), phase: a.getStatus().phase,
        saveState: a.getStatus().saveState, pendingCount: a.getStatus().pendingCount, outboxPending: a.getStatus().outboxPending,
        lastServerRevision: a.getStatus().lastServerRevision,
        pendingTextUids: co._pendingTextUids ? Array.from(co._pendingTextUids) : null,
        lastPushedText: co.lastPushed && co.lastPushed['leaf-3-0'] && co.lastPushed['leaf-3-0'].text,
        patch: patch === null ? null : JSON.stringify(patch).slice(0, 120), isRendering: mm.renderer.isRendering }
    })))
    const pgText = (await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })).rows.find(r => r.uid === 'leaf-3-0').data.text
    out.stages.push({ label, at: Date.now(), per, pgText })
    return { per, pgText }
  }
  try {
    for (const actor of ['owner', 'editor-a']) {
      const c = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => observe.observeWire(page, clients.length, frames) })
      clients.push(c)
    }
    await Promise.all(clients.map(settled))
    await Promise.all([
      clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-3-0'), '<p>Same node A</p>') }),
      clients[1].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-3-0'), '<p>Same node B</p>') })
    ])
    for (let i = 0; i < 20 && frames.filter(f => f.kind === 'ack' && ['leaf-3-0'].some(() => true)).length < 2; i++) await sleep(500)
    // wait for both same-node ACKs explicitly
    for (let i = 0; i < 40; i++) {
      const acks = frames.filter(f => f.kind === 'ack' && f.direction === 'received' && f.body && f.body.ok && String(JSON.stringify(f.body)).includes('leaf-3-0'))
      if (acks.length >= 2) break
      await sleep(500)
    }
    await sleep(1500)
    await snap('post-race')
    // Product self-heal path: adapter resync.
    await clients[1].page.evaluate(() => __onlineMM.cooperate.collabV2Adapter.resync({ reason: 'diagnostic' })).catch(e => String(e))
    await sleep(4000)
    await snap('after-resync-client1')
    // Subsequent operation by client0: does client1 reconcile the same node?
    await clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-0-1'), '<p>Later edit</p>') })
    await sleep(4000)
    await snap('after-later-edit')
    out.frames = frames
    fs.writeFileSync(path.join(OUT, 'diag2-' + runId + '.json'), JSON.stringify(out, null, 2))
    console.log(JSON.stringify(out.stages.map(s => ({ label: s.label, pgText: s.pgText, per: s.per.map(p => ({ userId: p.userId, text: p.text, phase: p.phase, saveState: p.saveState, pendingTextUids: p.pendingTextUids, lastPushedText: p.lastPushedText, patch: p.patch })) })), null, 1))
  } finally {
    await closeOwnedFixture(browser, clients, fixture)
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
