// Supplementary read-only full-App structural evidence. This is a separate
// fresh13-context audit, never a backfill of missing200-command observations.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { mountPersistedTree, settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const { closeOwnedFixture } = require('./online-cleanup.cjs')

function topology(tree) {
  const rows = [], seen = new Set(), stack = [{ node: tree, parent: null }]
  while (stack.length) {
    const { node, parent } = stack.pop(), uid = node.data.uid
    assert.ok(!seen.has(uid), 'Actual PG tree UID is unique')
    seen.add(uid)
    rows.push({ uid, parent, children: (node.children || []).map(child => child.data.uid) })
    for (const child of node.children || []) stack.push({ node: child, parent: uid })
  }
  return rows.sort((a, b) => a.uid.localeCompare(b.uid))
}

async function main() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'before'
  const fixture = await startFixture({ phase, instances: 2 })
  const label = 'read-only-uid-audit-' + randomUUID()
  const output = path.join(repo, 'work/performance-tdd', phase, 'online/ordinary-logical', label)
  fs.mkdirSync(output, { recursive: true })
  const write = (file, value) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2))
  const clients = [], audited = [], resources = []
  let browser
  try {
    const tree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    const initial = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    const expected = topology(tree)
    assert.equal(expected.length, 6001)
    assert.equal(Number(initial.revision), 0)
    assert.equal(initial.operations.length, 0)
    write('actual-PG-topology.json', { count: 6001, roomKey: fixture.roomKey, initial, rows: expected })
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (let i = 0; i < 13; i++) {
      const client = await openEditor(browser, fixture, i, { setupTimeoutMs: 300000, liveTimeoutMs: 300000,
        onPage: page => observe.installStartupObserver(page) })
      clients.push(client)
      const mount = await mountPersistedTree(client, tree, initial)
      await settled(client)
      const actual = await client.page.evaluate(() => {
        const mm = __onlineMM, rows = [], stack = [{ node: mm.renderer.renderTree, parent: null }]
        while (stack.length) {
          const { node, parent } = stack.pop(), uid = node.data.uid
          const instance = mm.renderer.nodeCache[uid]
          if (!instance || instance.getData('uid') !== uid) throw new Error('Current rendered model UID mismatch: ' + uid)
          rows.push({ uid, parent, children: (node.children || []).map(child => child.data.uid),
            renderedParent: instance.parent ? instance.parent.getData('uid') : null,
            renderedChildren: instance.children.map(child => child.getData('uid')) })
          for (const child of node.children || []) stack.push({ node: child, parent: uid })
        }
        rows.sort((a, b) => a.uid.localeCompare(b.uid))
        return { rows, cacheCount: Object.keys(mm.renderer.nodeCache).length, status: mm.cooperate.collabV2Adapter.getStatus(),
          layout: mm.getLayout(), compactLayout: mm.opt.compactLayout }
      })
      assert.equal(actual.layout, 'logicalStructure')
      assert.equal(actual.compactLayout, false)
      assert.equal(actual.cacheCount, 6001)
      assert.equal(actual.rows.length, 6001)
      assert.deepEqual(actual.rows.map(({ uid, parent, children }) => ({ uid, parent, children })), expected)
      assert.deepEqual(actual.rows.map(({ uid, renderedParent, renderedChildren }) => ({ uid, parent: renderedParent, children: renderedChildren })), expected)
      audited.push({ client: i, currentModels: 6001, currentRendererInstances: 6001,
        actualUidParentChildOrderSha256: createHash('sha256').update(JSON.stringify(actual.rows)).digest('hex'),
        samples: actual.rows.filter(row => ['root', 'branch-0', 'branch-149', 'leaf-0-0', 'leaf-149-38'].includes(row.uid)),
        mount, layout: actual.layout, compactLayout: actual.compactLayout, status: actual.status })
      resources.push(await observe.resourceSnapshot(client))
      write('progress.json', { completedContexts: audited.length, audited, resources })
    }
    assert.equal(new Set(audited.map(client => client.status.clientId)).size, 13)
    const final = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(Number(final.revision), 0)
    assert.equal(final.operations.length, 0, 'Read-only audit never edits or normalizes the room')
    assert.equal(final.count, 6001)
    const finalStatuses = await Promise.all(clients.map(client => client.page.evaluate(() => __onlineMM.cooperate.collabV2Adapter.getStatus())))
    assert.equal(new Set(finalStatuses.map(status => status.clientId)).size, 13)
    for (let i = 0; i < finalStatuses.length; i++) {
      const status = finalStatuses[i]
      assert.equal(status.phase, 'LIVE')
      assert.equal(status.socketConnected, true)
      assert.equal(status.pendingCount, 0)
      assert.equal(status.outboxPending, 0)
      assert.equal(Number(status.lastServerRevision), 0)
      assert.equal(status.peers.length, i % 2 === 0 ? 7 : 6)
    }
    const errors = clients.flatMap(client => client.errors)
    assert.equal(errors.length, 0)
    write('result.json', { status: 'SUPPLEMENTARY_UID_AUDIT_COMPLETED', phase, label,
      actualContexts: 13, actualAppInstances: 2, audited, resources, initial, final, finalStatuses,
      bundleHashes: fixture.bundleHashes, browser: browser.version(), errors,
      fixtureBoundaries: fixture.fixtureBoundaries,
      boundary: 'Separate fresh nonce read-only audit of every current model/renderer UID,parent and ordered children against actual room_nodes SQL. Sequential safe-load plus manual complete PG-tree mounting in ordinary logicalStructure compactLayout=false. It supplies no missing earlier200-command listener/cache/timing fields and no enterprise OAuth or simultaneous cold-start claim.' })
  } catch (error) {
    write('failure.json', { message: error.message, stack: error.stack, audited, resources })
    throw error
  } finally {
    write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main, topology }
