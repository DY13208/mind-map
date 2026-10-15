// Focused diagnostic: same-node concurrent edits. Classify harness vs product.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e/diag-samenode')

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const fixture = await startFinalFixture({ instances: 1, profile: 'default' })
  const seed = await fixture.apps[0].control('seedSmall', { runId })
  const frames = []
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const clients = []
  const out = { runId, roomKey: seed.roomKey, timeline: [] }
  try {
    for (const actor of ['owner', 'editor-a']) {
      const c = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async page => observe.observeWire(page, clients.length, frames) })
      clients.push(c)
    }
    await Promise.all(clients.map(settled))
    const snap = () => Promise.all(clients.map(c => c.page.evaluate(() => {
      const mm = window.__onlineMM, co = mm.cooperate, a = co.collabV2Adapter
      const node = mm.renderer.findNodeByUid('leaf-3-0')
      let patchLen = null
      try { patchLen = co.nodePatchPayload ? JSON.stringify(co.nodePatchPayload(node, { onlyChanged: true }) || null).length : null } catch (e) { patchLen = 'ERR ' + e.message }
      return { userId: a.getStatus().userId, text: node.getData('text'), status: a.getStatus(),
        pendingTextUids: co._pendingTextUids ? Array.from(co._pendingTextUids) : null,
        lastPushed: co.lastPushed && co.lastPushed['leaf-3-0'],
        patchLen, acked: co.ackedUids ? co.ackedUids.size : null, deleted: co.deletedUids ? co.deletedUids.size : null,
        recentHttpDeleted: co.recentHttpDeleted ? Array.from(co.recentHttpDeleted.keys()) : null,
        isRendering: mm.renderer.isRendering, renderTimer: !!mm.renderer.renderTimer, hasWaitRendering: !!mm.renderer.hasWaitRendering }
    })))
    out.initial = await snap()
    await Promise.all([
      clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-3-0'), '<p>Same node A</p>') }),
      clients[1].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-3-0'), '<p>Same node B</p>') })
    ])
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      const snapshots = await snap()
      out.timeline.push({ at: Date.now(), snapshots })
      const done = snapshots.every(s => s.status.phase === 'LIVE' && !s.status.outboxPending && !s.status.pendingCount && !s.isRendering && !s.renderTimer && !s.hasWaitRendering && (!s.pendingTextUids || s.pendingTextUids.length === 0))
      if (done) { out.settled = true; break }
      await new Promise(r => setTimeout(r, 2000))
    }
    if (!out.settled) out.settled = false
    out.final = await snap()
    const pg = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
    out.pgSameNode = pg.rows.find(r => r.uid === 'leaf-3-0').data.text
    out.pgOps = (await fixture.apps[0].control('state', { roomKey: seed.roomKey })).operations
    out.frames = frames
    // attempt close to see if context close hangs too
    fs.writeFileSync(path.join(OUT, 'diag-' + runId + '.json'), JSON.stringify(out, null, 2))
    console.log(JSON.stringify({ settled: out.settled, pgSameNode: out.pgSameNode, last: out.timeline.at(-1) ? out.timeline.at(-1).snapshots.map(s => ({ userId: s.userId, text: s.text, saveState: s.status.saveState, pendingCount: s.status.pendingCount, outboxPending: s.status.outboxPending, pendingTextUids: s.pendingTextUids, patchLen: s.patchLen, lastPushed: s.lastPushed })) : null }, null, 2))
  } finally {
    await closeOwnedFixture(browser, clients, fixture)
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
