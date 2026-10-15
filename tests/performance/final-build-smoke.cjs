// Minimal executable smoke for the final-build E2E foundation.
// Validates: default (optimized-OFF) backend, real distinct-actor ACL, native
// product room load, and both-direction V2 collaboration on a small rich room.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, modelSnapshot, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const fixture = await startFinalFixture({ instances: 1, profile: 'default' })
  const frames = []
  let browser
  const clients = []
  const evidence = { startedAt: Date.now(), runId, profile: fixture.profile, bundleHashes: fixture.bundleHashes }
  try {
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    evidence.seed = seed
    console.log('seeded', JSON.stringify(seed))
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async (page, ctx) => {
        observe.observeWire(page, clients.length, frames)
        await observe.installStartupObserver(page)
      } })
      clients.push(client)
      console.log('opened', actor, 'readyMs', client.readyMs)
    }
    await Promise.all(clients.map(settled))
    const snaps = []
    for (const c of clients) snaps.push(await modelSnapshot(c))
    evidence.initial = snaps
    console.log('initial model counts', snaps.map(s => ({ actor: s.actor, total: s.total, unique: s.unique, rich: s.richCount, attached: s.attached, openPerformance: s.openPerformance })))
    for (const s of snaps) assert.equal(s.total, seed.count, 'native load yields full small room model')
    // both-direction edit
    await clients[0].page.evaluate(() => {
      const mm = __onlineMM
      mm.execCommand('SET_NODE_TEXT', mm.renderer.root, '<p>Owner edit A</p>')
    })
    await clients[1].page.waitForFunction(() => __onlineMM.renderer.root.getData('text') === '<p>Owner edit A</p>', null, { timeout: 60000 })
    await settled(clients[0])
    await clients[1].page.evaluate(() => {
      const mm = __onlineMM
      const leaf = mm.renderer.findNodeByUid('leaf-0-0')
      mm.execCommand('SET_NODE_TEXT', leaf, '<p>Editor B reply</p>')
    })
    await clients[0].page.waitForFunction(() => __onlineMM.renderer.findNodeByUid('leaf-0-0').getData('text') === '<p>Editor B reply</p>', null, { timeout: 60000 })
    await settled(clients[1])
    const pg = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    evidence.pg = pg
    console.log('pg', JSON.stringify({ revision: pg.revision, count: pg.count, root: pg.root_text }))
    assert.equal(pg.root_text, '<p>Owner edit A</p>')
    const raw = await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })
    const rawLeaf = raw.rows.find(row => row.uid === 'leaf-0-0')
    assert.equal(rawLeaf.data.text, '<p>Editor B reply</p>')
    assert.deepEqual(rawLeaf.data.customMeta, { kind: 'leaf', i: 0, j: 0 })
    const rawRoot = raw.rows.find(row => row.is_root)
    assert.deepEqual(rawRoot.data.customMeta, { kind: 'root', flag: 'keep' })
    evidence.rawNodes = { count: raw.rows.length, sample: raw.rows.slice(0, 3) }
    evidence.status = 'SMOKE_OK'
    fs.writeFileSync(path.join(OUT, 'smoke-foundation.json'), JSON.stringify(evidence, null, 2))
    console.log('SMOKE_OK')
  } catch (error) {
    evidence.status = 'SMOKE_FAILED'
    evidence.error = error.message
    evidence.frames = frames
    fs.writeFileSync(path.join(OUT, 'smoke-foundation.json'), JSON.stringify(evidence, null, 2))
    throw error
  } finally {
    fs.writeFileSync(path.join(OUT, 'smoke-native-frames.json'), JSON.stringify(frames, null, 2))
    const cleanup = await closeOwnedFixture(browser, clients, fixture)
    fs.writeFileSync(path.join(OUT, 'smoke-cleanup.json'), JSON.stringify(cleanup, null, 2))
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
