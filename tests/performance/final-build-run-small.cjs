// Final-build E2E: primary DEFAULT-flag (optimized switches OFF) acceptance.
//
// Real compiled App + real backend/business handlers, distinct actors
// authorized via real room_members, two clean contexts, both-direction
// propagation, concurrent non-overlapping edits, same-node convergence,
// add/delete/move + undo/redo integrity, explicit product save/flush, route
// exit, close-all + brand-new clean context reopen, read-only PG proof, and an
// app-process restart that recovers from DB without reseeding.
//
// Expected state derives from the intended fixture graph plus intended command
// deltas and is compared with the strict canonical oracle (unique UIDs, exact
// parents, exact ordered children, exact full business data).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, openActorEditor, repo, chromium } = require('./final-build-app.cjs')
const { settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const fx = require('./final-build-fixtures.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e')
const nowIso = () => new Date().toISOString()

function applyText(graph, uid, text) { graph[uid].data.text = text }
function applyAdd(graph, parentUid, data) {
  const uid = data.uid
  graph[uid] = { data: { ...data }, children: [] }
  graph[parentUid].children.push(uid)
}
function applyRemove(graph, uid) {
  const parent = Object.values(graph).find(node => (node.children || []).includes(uid))
  if (parent) parent.children = parent.children.filter(child => child !== uid)
  delete graph[uid]
}
function applyMove(graph, uid, newParentUid, floating = 'false') {
  const parent = Object.values(graph).find(node => (node.children || []).includes(uid))
  if (parent) parent.children = parent.children.filter(child => child !== uid)
  graph[newParentUid].children.push(uid)
  // A forward move persists isFloating:false; an Undo restores the pre-move
  // absence of the field (observed in real PG).
  if (floating === 'unset') delete graph[uid].data.isFloating
  else graph[uid].data.isFloating = floating === 'true'
}

async function browserRows(client) {
  return client.page.evaluate(() => {
    const mm = window.__onlineMM
    const rows = []
    const walk = (node, parentUid) => {
      rows.push({ uid: node.data.uid, parentUid, data: { ...node.data }, children: (node.children || []).map(child => child.data.uid) })
      for (const child of node.children || []) walk(child, node.data.uid)
    }
    walk(mm.renderer.renderTree, null)
    return rows
  })
}
async function waitNodeText(clients, uid, text, timeout = 120000) {
  await Promise.all(clients.map(client => client.page.waitForFunction(({ uid, text }) => {
    const mm = window.__onlineMM
    const node = mm.renderer.findNodeByUid(uid)
    return !!node && node.getData('text') === text
  }, { uid, text }, { timeout })))
}
async function saveAndFlush(client) {
  return client.page.evaluate(async () => {
    const mm = window.__onlineMM, cooperate = mm.cooperate, adapter = cooperate.collabV2Adapter
    let editor
    const components = [document.querySelector('#app').__vue__]
    while (components.length) {
      const vm = components.pop()
      if (vm.mindMap === mm && typeof vm.manualSave === 'function') { editor = vm; break }
      components.push(...(vm.$children || []))
    }
    if (editor) editor.manualSave()
    if (cooperate.flushHttpTextNow) await cooperate.flushHttpTextNow()
    if (adapter.waitForOutboxDurable) await adapter.waitForOutboxDurable({ timeoutMs: 30000 })
    return { saveLabel: (document.querySelector('.saveChip') || {}).textContent || '', status: adapter.getStatus(), hasEditorSaveEntry: !!editor }
  })
}
async function routeExit(client) {
  return client.page.evaluate(async () => {
    const app = document.querySelector('#app').__vue__
    window.__onlineMM = null
    await app.$router.push('/files')
    return { at: Date.now() }
  })
}

async function main() {
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const runDir = path.join(OUT, 'run-' + runId, 'small-default')
  fs.mkdirSync(runDir, { recursive: true })
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2))
  const checks = [], phases = [], frames = []
  const evidence = { runId, phase: 'small-default', startedAt: nowIso(), profile: 'default',
    boundary: 'Real compiled final18 App (served bytes hashed), real native backend/PG/socket under isolation; optimized switches left at code defaults (OFF); distinct actors via real room_members; no post-open data injection.' }
  let fixture, browser, clients = [], expected
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); return true }
    catch (error) { checks.push({ name, ok: false, error: error.message }); throw error }
  }
  const compareBrowser = async (client, label) => fx.compareCanonical(fx.canonicalGraph(expected, { browserLeafExpand: true }), fx.projectBrowserModel(await browserRows(client)), label)
  const comparePg = async (label) => {
    const raw = await fixture.apps[0].control('rawNodes', { roomKey: evidence.roomKey })
    const integrity = fx.rawIntegrityProblems(raw.rows)
    return integrity.concat(fx.compareCanonical(fx.canonicalGraph(expected), fx.projectRawRows(raw.rows), label))
  }
  try {
    const selfTest = fx.selfTest()
    evidence.oracleSelfTest = selfTest
    check('oracle-selftest', () => assert.deepEqual(selfTest.filter(item => !item.rejected), []))

    fixture = await startFinalFixture({ instances: 1, profile: 'default' })
    const seed = await fixture.apps[0].control('seedSmall', { runId })
    evidence.roomKey = seed.roomKey
    evidence.seed = seed
    evidence.fixtureStartingState = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    expected = fx.buildSmallGraph()
    check('seed-count-matches-intended', () => assert.equal(seed.count, fx.canonicalGraph(expected).length))

    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    for (const actor of ['owner', 'editor-a']) {
      const client = await openActorEditor(browser, fixture, { actor, roomKey: seed.roomKey, onPage: async (page, ctx) => {
        observe.observeWire(page, clients.length, frames)
        await observe.installStartupObserver(page)
      } })
      clients.push(client)
    }
    await Promise.all(clients.map(settled))

    // Phase 1: native load fidelity.
    for (const client of clients) {
      const problems = await compareBrowser(client, 'native-load-' + client.actor)
      check('native-load-model-' + client.actor, () => assert.deepEqual(problems, []))
    }
    {
      const problems = await comparePg('native-load-pg')
      check('native-load-pg', () => assert.deepEqual(problems, []))
    }
    phases.push({ name: 'native-load', count: fx.canonicalGraph(expected).length })

    // Phase 2: both-direction propagation.
    await clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), '<p>Owner edit A</p>') })
    applyText(expected, 'root', '<p>Owner edit A</p>')
    await waitNodeText([clients[1]], 'root', '<p>Owner edit A</p>')
    await settled(clients[0]); await settled(clients[1])
    await clients[1].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-0-0'), '<p>Editor reply B</p>') })
    applyText(expected, 'leaf-0-0', '<p>Editor reply B</p>')
    await waitNodeText([clients[0]], 'leaf-0-0', '<p>Editor reply B</p>')
    await settled(clients[0]); await settled(clients[1])
    for (const client of clients) {
      const problems = await compareBrowser(client, 'propagation-' + client.actor)
      check('propagation-model-' + client.actor, () => assert.deepEqual(problems, []))
    }
    phases.push({ name: 'both-direction' })

    // Phase 3: concurrent non-overlapping edits.
    await Promise.all([
      clients[0].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-1-0'), '<p>Concurrent A</p>') }),
      clients[1].page.evaluate(() => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('leaf-2-0'), '<p>Concurrent B</p>') })
    ])
    applyText(expected, 'leaf-1-0', '<p>Concurrent A</p>')
    applyText(expected, 'leaf-2-0', '<p>Concurrent B</p>')
    await waitNodeText([clients[0]], 'leaf-2-0', '<p>Concurrent B</p>')
    await waitNodeText([clients[1]], 'leaf-1-0', '<p>Concurrent A</p>')
    await settled(clients[0]); await settled(clients[1])
    for (const client of clients) {
      const problems = await compareBrowser(client, 'concurrent-' + client.actor)
      check('concurrent-nonoverlap-' + client.actor, () => assert.deepEqual(problems, []))
    }
    phases.push({ name: 'concurrent-nonoverlapping' })

    // Phase 4: same-node concurrent convergence.
    const sameNode = 'leaf-3-0', candidateA = '<p>Same node A</p>', candidateB = '<p>Same node B</p>'
    await Promise.all([
      clients[0].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: sameNode, text: candidateA }),
      clients[1].page.evaluate(({ uid, text }) => { const mm = window.__onlineMM; mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid(uid), text) }, { uid: sameNode, text: candidateB })
    ])
    await settled(clients[0]); await settled(clients[1])
    const convergedTexts = await Promise.all(clients.map(async client => (await browserRows(client)).find(row => row.uid === sameNode).data.text))
    const convergedPg = (await fixture.apps[0].control('rawNodes', { roomKey: seed.roomKey })).rows.find(row => row.uid === sameNode)
    check('same-node-one-legitimate-winner', () => {
      assert.ok([candidateA, candidateB].includes(convergedTexts[0]))
      assert.equal(convergedTexts[0], convergedTexts[1], 'both actors converge to the same value')
      assert.equal(convergedTexts[0], convergedPg.data.text, 'PG converges to the same value')
    })
    for (const client of clients) {
      const row = (await browserRows(client)).find(item => item.uid === sameNode)
      check('same-node-preserves-other-fields-' + client.actor, () => {
        assert.deepEqual(row.data.customMeta, { kind: 'leaf', i: 3, j: 0 })
        assert.equal(row.data.richText, true)
      })
    }
    applyText(expected, sameNode, convergedTexts[0])
    phases.push({ name: 'same-node-convergence', winner: convergedTexts[0] })

    // Phase 5: move + undo/redo (same native renderer command used by drag/drop).
    await clients[0].page.evaluate(() => {
      const mm = window.__onlineMM
      mm.execCommand('MOVE_NODE_TO', mm.renderer.findNodeByUid('branch-3'), mm.renderer.findNodeByUid('branch-0'))
    })
    applyMove(expected, 'branch-3', 'branch-0')
    await clients[1].page.waitForFunction(() => {
      const n = window.__onlineMM.renderer.findNodeByUid('branch-3')
      return n && n.parent && n.parent.getData('uid') === 'branch-0'
    }, null, { timeout: 120000 })
    await settled(clients[0]); await settled(clients[1])
    for (const client of clients) {
      const problems = await compareBrowser(client, 'move-' + client.actor)
      check('move-browser-' + client.actor, () => assert.deepEqual(problems, []))
    }
    { const problems = await comparePg('move-pg'); check('move-pg', () => assert.deepEqual(problems, [])) }

    await clients[0].page.evaluate(async () => { const mm = window.__onlineMM; mm.execCommand('BACK'); if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue })
    applyMove(expected, 'branch-3', 'root', 'unset')
    await clients[1].page.waitForFunction(() => {
      const n = window.__onlineMM.renderer.findNodeByUid('branch-3')
      return n && n.parent && n.parent.getData('uid') === 'root'
    }, null, { timeout: 120000 })
    await settled(clients[0]); await settled(clients[1])
    { const problems = await comparePg('move-undo-pg'); check('move-undo-pg', () => assert.deepEqual(problems, [])) }
    await clients[0].page.evaluate(async () => { const mm = window.__onlineMM; mm.execCommand('FORWARD'); if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue })
    applyMove(expected, 'branch-3', 'branch-0')
    await clients[1].page.waitForFunction(() => {
      const n = window.__onlineMM.renderer.findNodeByUid('branch-3')
      return n && n.parent && n.parent.getData('uid') === 'branch-0'
    }, null, { timeout: 120000 })
    await settled(clients[0]); await settled(clients[1])
    { const problems = await comparePg('move-redo-pg'); check('move-redo-pg', () => assert.deepEqual(problems, [])) }
    phases.push({ name: 'move-undo-redo' })

    // Phase 6 (structural add/delete): covered by the existing reusable C2
    // correctness scenario (real App insert/delete/move + undo/redo) in the
    // matrix run (online-browser-correctness.cjs against the same artifact).
    // The confirmed-fix matrix here focuses on same-node/unsent-intent/move plus
    // save/persistence/reopen/restart.
    phases.push({ name: 'structural-add-delete-delegated-to-c2-correctness' })

    // Phase 7: explicit product save/flush + ACK/PG proof, then route exit.
    const flush = await saveAndFlush(clients[0])
    await settled(clients[0])
    const savedPg = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    check('product-save-flush-ack-pg', () => {
      assert.equal(flush.hasEditorSaveEntry, true, 'real product manualSave entry found')
      assert.equal(flush.status.outboxPending, 0, 'no pending outbox rows')
      assert.equal(flush.status.pendingCount, 0, 'no pending ACKs')
      assert.equal(flush.status.saveState, 'saved', 'product save state is saved')
      assert.equal(Number(flush.status.serverRevision), Number(savedPg.revision), 'adapter serverRevision equals PG revision')
    })
    evidence.productSaveFlush = { flush, pgRevision: savedPg.revision }
    const finalProjectionBeforeExit = fx.canonicalGraph(expected)
    { const problems = await comparePg('save-final-pg'); check('save-final-pg', () => assert.deepEqual(problems, [])) }

    await routeExit(clients[0])
    await clients[0].page.waitForFunction(() => !document.querySelector('#mindMapContainer'), null, { timeout: 30000 })
    phases.push({ name: 'explicit-save-flush-route-exit' })

    // Phase 8: close ALL original contexts, reopen in a brand-new clean browser
    // context with no reused IDB/localStorage.
    const expectedProjection = fx.canonicalGraph(expected, { browserLeafExpand: true })
    for (const client of clients) await client.context.close()
    clients = []
    await browser.close()
    browser = null
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const freshClient = await openActorEditor(browser, fixture, { actor: 'editor-b', roomKey: seed.roomKey })
    clients = [freshClient]
    await settled(freshClient)
    {
      const rows = await browserRows(freshClient)
      const problems = fx.compareCanonical(expectedProjection, fx.projectBrowserModel(rows), 'fresh-reopen')
      check('fresh-context-reopen-model', () => assert.deepEqual(problems, []))
      check('fresh-context-no-duplicate-ids', () => assert.equal(new Set(rows.map(row => row.uid)).size, rows.length))
    }
    { const problems = await comparePg('fresh-reopen-pg'); check('fresh-reopen-pg', () => assert.deepEqual(problems, [])) }
    evidence.freshReopen = { browserVersion: browser.version(), rows: (await browserRows(freshClient)).length }
    await freshClient.context.close()
    clients = []
    await browser.close()
    browser = null
    phases.push({ name: 'fresh-context-reopen' })

    // Phase 9: app process restart WITHOUT reseed; adopt owned room; reopen from DB.
    const ownedRoom = seed.roomKey
    await fixture.close({ preserveRooms: true })
    fixture = null
    const restarted = await startFinalFixture({ instances: 1, profile: 'default' })
    fixture = restarted
    const adopted = await fixture.apps[0].control('adoptRooms', { runId })
    check('cold-restart-adopted-existing-room', () => assert.deepEqual(adopted.adopted, [ownedRoom]))
    const restartedState = await fixture.apps[0].control('state', { roomKey: ownedRoom })
    check('cold-restart-revision-preserved', () => assert.equal(Number(restartedState.revision), Number(savedPg.revision)))
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const afterRestart = await openActorEditor(browser, fixture, { actor: 'owner', roomKey: ownedRoom })
    clients = [afterRestart]
    await settled(afterRestart)
    {
      const rows = await browserRows(afterRestart)
      const problems = fx.compareCanonical(expectedProjection, fx.projectBrowserModel(rows), 'restart-reopen')
      check('cold-restart-reopen-model', () => assert.deepEqual(problems, []))
    }
    { const problems = await comparePg('cold-restart-pg'); check('cold-restart-pg', () => assert.deepEqual(problems, [])) }
    evidence.appRestart = { adopted, revisionBefore: savedPg.revision, revisionAfter: restartedState.revision }
    phases.push({ name: 'app-process-restart' })

    evidence.checks = checks
    evidence.phases = phases
    evidence.status = 'PASS'
    evidence.completedAt = nowIso()
    evidence.expectedUidSetSha256 = crypto.createHash('sha256').update(expectedProjection.map(row => row.uid).sort().join('\n')).digest('hex')
    evidence.servedAssets = fixture.servedAssets()
    evidence.bundleHashes = fixture.bundleHashes
    evidence.roomKeyPreservedForIndependentRerun = ownedRoom
    write('result.json', evidence)
    console.log('SMALL_DEFAULT_PASS ' + JSON.stringify({ roomKey: ownedRoom, checks: checks.length, rows: expectedProjection.length }))
    return evidence
  } catch (error) {
    evidence.checks = checks
    evidence.phases = phases
    evidence.status = 'FAIL'
    evidence.error = error.message
    evidence.stack = error.stack
    evidence.completedAt = nowIso()
    try { evidence.servedAssets = fixture && fixture.servedAssets ? fixture.servedAssets() : null } catch (_) {}
    write('failure.json', evidence)
    throw error
  } finally {
    try { fs.writeFileSync(path.join(runDir, 'native-frames.json'), JSON.stringify(frames, null, 2)) } catch (_) {}
    try {
      if (fixture) write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
    } catch (cleanupError) { try { write('cleanup-error.json', { message: cleanupError.message }) } catch (_) {} }
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
