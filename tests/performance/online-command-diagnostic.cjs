// Separate functional diagnosis, never one of the 200 performance samples.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { mountPersistedTree, settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))

async function main() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'after'
  const label = 'command-diagnostic-' + crypto.randomUUID()
  const output = path.join(repo, 'work/performance-tdd', phase, 'online', 'ordinary-logical', label)
  fs.mkdirSync(output, { recursive: true })
  const write = (file, body) => fs.writeFileSync(path.join(output, file), JSON.stringify(body, null, 2))
  const fixture = await startFixture({ phase, instances: 2 })
  const frames = [], clients = []
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const tree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    for (let index = 0; index < 2; index++) {
      const client = await openEditor(browser, fixture, index, { onPage: async page => {
        observe.observeWire(page, index, frames)
        await observe.installStartupObserver(page)
      } })
      clients.push(client)
      await mountPersistedTree(client, tree, await fixture.apps[0].control('state', { roomKey: fixture.roomKey }))
      await settled(client)
      await observe.installEditorObserver(client.page)
    }
    const command = await clients[0].page.evaluate(() => __onlineObservation.command('Update-9000'))
    await Promise.all(clients.map(client => client.page.waitForFunction(() => {
      const item = __onlineObservation.records['Update-9000']
      return item && item.modelAt && item.domAt && item.frameAt
    }, null, { timeout: 60000 })))
    const wire = observe.assertWireSample(frames, 'Update-9000', 2)
    const snapshots = await Promise.all(clients.map(client => client.page.evaluate(() => {
      const mm = __onlineMM, c = mm.cooperate, r = mm.renderer
      return { records: __onlineObservation.records, native: __onlineNativeEvents,
        status: c.collabV2Adapter.getStatus(), isRendering: r.isRendering,
        httpTextTimer: !!c.httpTextTimer, httpStructureTimer: !!c.httpStructureTimer,
        pendingTextUids: c._pendingTextUids && Array.from(c._pendingTextUids),
        pendingRootPatch: c.nodePatchPayload(r.root, { onlyChanged: true }),
        rootText: r.root.getData('text'), modelRootText: r.renderTree.data.text,
        rootConnected: r.root.group.node.isConnected, rootRect: r.root.group.node.getBoundingClientRect().toJSON() }
    })))
    write('result.json', { status: 'DIAGNOSTIC_ONLY', command, wire, snapshots,
      persisted: await fixture.apps[0].control('state', { roomKey: fixture.roomKey }),
      fixtureBoundaries: fixture.fixtureBoundaries, output })
    console.log(JSON.stringify({ output, snapshots: snapshots.map(item => ({
      phase: item.status.phase, pendingCount: item.status.pendingCount,
      outboxPending: item.status.outboxPending, isRendering: item.isRendering,
      httpTextTimer: item.httpTextTimer, httpStructureTimer: item.httpStructureTimer,
      pendingTextUids: item.pendingTextUids, pendingRootPatch: item.pendingRootPatch })) }))
  } finally {
    write('native-frames.json', frames)
    write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
