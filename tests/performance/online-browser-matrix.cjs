const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const sourceManifest = require('./online-source-manifest.cjs')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')

function quantile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]
}
function distribution(values) {
  return { samples: values.length, min: Math.min(...values), p50: quantile(values, .5), p95: quantile(values, .95), max: Math.max(...values) }
}
async function mountPersistedTree(client, tree, persisted) {
  return client.page.evaluate(async ({ tree, persisted }) => {
    const started = performance.timeOrigin + performance.now()
    const mm = __onlineMM
    await new Promise(resolve => {
      const done = () => { mm.off('node_tree_render_end', done); resolve() }
      mm.on('node_tree_render_end', done)
      mm.setData(tree)
    })
    mm.cooperate.afterHttpReplace({ version: persisted.revision, updated_at: persisted.updated_at }, tree)
    return { startedAt: started, completedAt: performance.timeOrigin + performance.now(), source: 'owned child real room_nodes SQL' }
  }, { tree, persisted })
}
async function settled(client) {
  await client.page.waitForFunction(() => {
    const mm = __onlineMM
    const cooperate = mm.cooperate
    const state = cooperate.collabV2Adapter.getStatus()
    // This set is a candidate worklist, not the transport's pending queue:
    // a committed UID can stay here until the next comparison. Require no
    // actual changed patch rather than imposing an undocumented empty-set
    // invariant on an already ACKed operation.
    const noChangedCandidates = !cooperate._pendingTextUids || Array.from(cooperate._pendingTextUids).every(uid => {
      if (typeof mm.renderer.findNodeByUid !== 'function' || typeof cooperate.nodePatchPayload !== 'function') return false
      const node = mm.renderer.findNodeByUid(uid)
      return !!node && !cooperate.nodePatchPayload(node, { onlyChanged: true })
    })
    return state.phase === 'LIVE' && !state.outboxPending && !state.pendingCount && !mm.renderer.isRendering &&
      !mm.renderer.renderTimer && !mm.renderer.hasWaitRendering &&
      !cooperate.httpTextTimer && !cooperate.httpStructureTimer && noChangedCandidates
  }, null, { timeout: 300000 })
}

async function sampleModel(client) {
  return client.page.evaluate(() => {
    const wanted = new Set(['root', 'branch-0', 'leaf-0-0', 'branch-149', 'leaf-149-38'])
    const all = new Set(), samples = []
    const stack = [{ node: __onlineMM.renderer.renderTree, parentUid: null }]
    while (stack.length) {
      const { node, parentUid } = stack.pop()
      const uid = node.data.uid
      all.add(uid)
      if (wanted.has(uid)) samples.push({ uid, parentUid, text: node.data.text, children: (node.children || []).map(item => item.data.uid) })
      for (const child of node.children || []) stack.push({ node: child, parentUid: uid })
    }
    return { uniqueUids: all.size, samples: samples.sort((a, b) => a.uid.localeCompare(b.uid)) }
  })
}
function persistedSamples(tree) {
  const wanted = new Set(['root', 'branch-0', 'leaf-0-0', 'branch-149', 'leaf-149-38'])
  const all = new Set(), samples = [], stack = [{ node: tree, parentUid: null }]
  while (stack.length) {
    const { node, parentUid } = stack.pop(); const uid = node.data.uid; all.add(uid)
    if (wanted.has(uid)) samples.push({ uid, parentUid, text: node.data.text, children: (node.children || []).map(item => item.data.uid) })
    for (const child of node.children || []) stack.push({ node: child, parentUid: uid })
  }
  return { uniqueUids: all.size, samples: samples.sort((a, b) => a.uid.localeCompare(b.uid)) }
}

async function run() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'before'
  const instances = Number(process.env.PERF_TDD_ONLINE_INSTANCES || 1)
  const peers = Number(process.env.PERF_TDD_ONLINE_PEERS || 13)
  const count = Number(process.env.PERF_TDD_ONLINE_SAMPLES || 200)
  const diagnostic = process.env.PERF_TDD_ONLINE_DIAGNOSTIC === '1'
  const operationTimeout = Number(process.env.PERF_TDD_ONLINE_OPERATION_TIMEOUT || (phase === 'before' ? 300000 : 60000))
  assert.ok(diagnostic || (peers === 13 && count >= 200), 'Acceptance matrix needs 13 real contexts and >=200 operations')
  const output = onlineOutputDirectory(phase, `${instances}-instance${diagnostic ? '-diagnostic-' + Date.now() : ''}`)
  fs.mkdirSync(output, { recursive: true })
  if (!diagnostic && ['samples.json', 'result.json', 'failure.json'].some(file => fs.existsSync(path.join(output, file)))) throw new Error('REFUSE_OVERWRITE: preserve previous formal run evidence')
  const write = (file, body) => fs.writeFileSync(path.join(output, file), JSON.stringify(body, null, 2))
  write('harness-manifest.json', { startedAt: Date.now(), orchestrator: process.version,
    files: ['online-browser-matrix.cjs','online-browser-observation.cjs','online-browser-smoke.cjs','online-web-fixture.cjs','online-server-child.cjs','online-cleanup.cjs','online-source-manifest.cjs','online-output-directory.cjs','isolation.cjs']
      .map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex') })) })
  sourceManifest.capture(phase, output)
  const progress = body => { fs.appendFileSync(path.join(output, 'progress.ndjson'), JSON.stringify({ at: Date.now(), ...body }) + '\n'); console.log(JSON.stringify(body)) }
  const fixture = await startFixture({ phase, instances })
  const frames = [], clients = [], samples = [], resources = [], mounts = []
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const tree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    for (let index = 0; index < peers; index++) {
      const client = await openEditor(browser, fixture, index, { setupTimeoutMs: operationTimeout, liveTimeoutMs: operationTimeout, onPage: async page => {
        observe.observeWire(page, index, frames)
        await observe.installStartupObserver(page)
      } })
      clients.push(client)
      const persisted = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
      mounts.push({ client: index, safeLoadReadyMs: client.readyMs,
        fullPersistedTree: await mountPersistedTree(client, tree, persisted) })
      await settled(client)
      progress({ stage: 'client-full-tree-live', client: index, safeLoadReadyMs: client.readyMs })
      write('setup.json', { mounts, roomKey: fixture.roomKey, persistedCount: fixture.count })
    }
    await Promise.all(clients.map(settled))
    const identities = await Promise.all(clients.map(client => client.page.evaluate(() => __onlineMM.cooperate.collabV2Adapter.getStatus())))
    assert.equal(new Set(identities.map(item => item.clientId)).size, peers)
    for (let index = 0; index < clients.length; index++) {
      const client = clients[index]
      const localPeers = clients.filter((_, i) => i % instances === index % instances).length
      await client.page.waitForFunction(count => __onlineMM.cooperate.collabV2Adapter.getStatus().peers.length === count, localPeers, { timeout: operationTimeout })
      await observe.installEditorObserver(client.page)
    }
    for (let index = 0; index < clients.length; index++) resources.push({ stage: 'mounted', client: index, ...await observe.resourceSnapshot(clients[index]) })
    assert.ok(resources.every(item => item.app.models === 6001), 'All contexts hold the complete real persisted model')
    const initialModelSamples = await Promise.all(clients.map(sampleModel))
    initialModelSamples.forEach(actual => assert.deepEqual(actual, persistedSamples(tree)))
    write('model-samples-initial.json', initialModelSamples)
    write('identities.json', identities)
    progress({ stage: 'all-peers-ready', contexts: peers, instances })
    const profilers = diagnostic ? await Promise.all(clients.map(async (client, index) => {
      const session = await client.page.context().newCDPSession(client.page)
      await session.send('Profiler.enable'); await session.send('Profiler.start')
      const stop = async () => { const profile = await session.send('Profiler.stop').catch(() => null); if (profile) write('native-cpu-profile-' + index + '.json', profile) }
      setTimeout(stop, 10000).unref()
      return session
    })) : []
    for (let iteration = 1; iteration <= count; iteration++) {
      // Test scheduling only; event loop and real HTTP/WS proxy remain live.
      const pauseFile = path.join(repo, 'work/performance-tdd/online-pause.json')
      while (fs.existsSync(pauseFile)) {
        const pause = JSON.parse(fs.readFileSync(pauseFile, 'utf8'))
        if (!(Number(pause.untilEpoch) > Date.now())) break
        write('checkpoint.json', { started: iteration - 1, completed: samples.length, at: Date.now(), status: 'WAITING_SAMPLING_WINDOW', reason: pause.reason })
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const text = 'Update-' + String(iteration).padStart(4, '0')
      write('checkpoint.json', { started: iteration, completed: samples.length, at: Date.now(), status: 'RUNNING' })
      const command = await clients[0].page.evaluate(text => __onlineObservation.command(text), text)
      if (diagnostic) write('command-' + iteration + '.json', command)
      await Promise.all(clients.map(client => client.page.waitForFunction(text => {
        const record = __onlineObservation.records[text]
        return record && record.modelAt && record.domAt && record.frameAt
      }, text, { timeout: operationTimeout })))
      await settled(clients[0])
      const records = await Promise.all(clients.map(client => client.page.evaluate(text => __onlineObservation.records[text], text)))
      const wire = observe.assertWireSample(frames, text, peers)
      const browserNativeEvents = await Promise.all(clients.map(client => client.page.evaluate(opId => __onlineNativeEvents && __onlineNativeEvents[opId], wire.opId)))
      samples.push({ iteration, text, command, wire, records, browserNativeEvents,
        durations: { commandMs: command.returnedAt - command.startedAt, ackMs: wire.ackAt - command.startedAt,
          remoteModelMs: Math.max(...records.slice(1).map(item => item.modelAt - command.startedAt)),
          remoteDomMs: Math.max(...records.slice(1).map(item => item.domAt - command.startedAt)),
          remoteViewportFrameMs: Math.max(...records.slice(1).map(item => item.frameAt - command.startedAt)) } })
      const nativeCoverage = { ack: !!(browserNativeEvents[0] && browserNativeEvents[0].ackAt),
        remoteEvents: browserNativeEvents.slice(1).filter(item => item && item.eventAt).length, expectedRemoteEvents: peers - 1 }
      samples.at(-1).nativeBrowserCoverage = nativeCoverage
      if (nativeCoverage.ack && nativeCoverage.remoteEvents === nativeCoverage.expectedRemoteEvents) {
        samples.at(-1).browserStageDurations = { ackMessageMs: browserNativeEvents[0].ackAt - command.startedAt,
          remoteEventToModelMs: records.slice(1).map((record, i) => record.modelAt - browserNativeEvents[i + 1].eventAt),
          renderEndPresent: records.map(record => !!record.renderEndAt) }
        assert.ok(samples.at(-1).browserStageDurations.remoteEventToModelMs.every(value => value >= 0), 'Native browser event timestamp precedes each remote model update')
      } else {
        samples.at(-1).browserStageStatus = 'STAGE_NOT_OBSERVED'
      }
      write('samples.json', samples)
      write('checkpoint.json', { started: iteration, completed: samples.length, at: Date.now(), status: 'RUNNING', last: samples.at(-1).durations })
      write('native-frames.json', frames)
      if (iteration === 1 || iteration % 25 === 0) {
        for (let index = 0; index < clients.length; index++) resources.push({ stage: 'operation-' + iteration, client: index, ...await observe.resourceSnapshot(clients[index]) })
        write('resources.json', resources)
      }
      if (iteration === 1 || iteration % 25 === 0) progress({ stage: 'operation', iteration, durations: samples.at(-1).durations })
    }
    const persisted = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(persisted.root_text, samples.at(-1).command.payload)
    assert.equal(persisted.count, 6001)
    const finalPgTree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    const finalModelSamples = await Promise.all(clients.map(sampleModel))
    finalModelSamples.forEach(actual => assert.deepEqual(actual, persistedSamples(finalPgTree)))
    write('model-samples-final.json', finalModelSamples)
    for (let index = 0; index < clients.length; index++) resources.push({ stage: 'after-operations', client: index, ...await observe.resourceSnapshot(clients[index]) })
    const result = { phase, status: diagnostic ? 'DIAGNOSTIC_ONLY' : 'MEASURED', layout: 'logicalStructure', compactLayout: false,
      contexts: peers, instances, sampleCount: count, seedNodes: 6001,
      authentication: 'Explicit synthetic owner authentication; actual ACL/PG/business HTTP/Socket/webpack App, with the separately declared fixture bootstrap controls',
      fixtureBoundaries: fixture.fixtureBoundaries,
      networking: 'Owned loopback HTTP and native WebSocket only; all external HTTP/WS blocked',
      setup: 'Contexts started sequentially; initial safe load and manual complete PG-tree mount measured separately; not simultaneous cold starts',
      presence: instances === 1 ? 'Native room presence contains all 13 peers' : 'Existing presenceHub is per process: local 6/7 peers only; unique native connected clients and cross-process operations cover all13, global online roster is not implemented',
      timing: 'Common endpoint definitions use browser command epoch vs host Playwright observed ACK Date.now and remote browser model/DOM/RAF; host callback delay means op:event(host)→model cannot be inferred. Separate native-browser message observations use one browser epoch; RAF proves visible DOM readiness, not hardware display latency; optional renderEnd is reported separately.',
      comparisonPolicy: phase === 'after' ? { originalRecordedBrowser: '154.0.8037.98', actualCandidateBrowser: browser.version(),
        sameEnvironmentPairClaim: false, decision: 'Root accepted independent final candidate200-command native records after installed Chrome auto-updated to155. Preserve original154 raw separately; no same-environment native speedup division. The separate backend same-environment>=40% and fixedM/C/S<=2 gates remain unchanged.' } : null,
      browser: browser.version(), runtime: fixture.apps.map(item => item.runtime), bundleHashes: fixture.bundleHashes,
      summaries: Object.fromEntries(Object.keys(samples[0].durations).map(key => [key, distribution(samples.map(item => item.durations[key]))])),
      identities, mounts, resources, persisted, errors: clients.flatMap(item => item.errors), protection: 'Reconnect/Undo/Redo/10-map entry-exit still pending' }
    result.perRemoteClient = Array.from({ length: peers - 1 }, (_, offset) => {
      const client = offset + 1
      return { client, model: distribution(samples.map(item => item.records[client].modelAt - item.command.startedAt)),
        dom: distribution(samples.map(item => item.records[client].domAt - item.command.startedAt)),
        viewportFrame: distribution(samples.map(item => item.records[client].frameAt - item.command.startedAt)) }
    })
    result.nativeBrowserTiming = { completeSamples: samples.filter(item => item.browserStageDurations).length,
      expectedSamples: count, status: samples.every(item => item.browserStageDurations) ? 'OBSERVED' : 'STAGE_NOT_OBSERVED',
      renderEndObservations: Array.from({ length: peers }, (_, index) => ({ client: index,
        present: samples.filter(item => item.records[index].renderEndAt).length, expected: count })) }
    const clockSamples = samples.filter(item => item.browserStageDurations)
    result.nativeBrowserTiming.ackMessageMs = clockSamples.length ? distribution(clockSamples.map(item => item.browserStageDurations.ackMessageMs)) : null
    result.nativeBrowserTiming.remoteEventToModelMs = clockSamples.length ? Array.from({ length: peers - 1 }, (_, offset) => ({ client: offset + 1,
      distribution: distribution(clockSamples.map(item => item.browserStageDurations.remoteEventToModelMs[offset])) })) : []
    assert.equal(result.errors.length, 0)
    write('result.json', result)
    progress({ stage: 'operations-complete', summaries: result.summaries })
    return result
  } catch (error) {
    write('failure-persisted-state.json', await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
      .catch(error => ({ error: error.message })))
    write('runtime-diagnostics.json', await Promise.all(clients.map(client => client.page.evaluate(() => ({
      records: __onlineObservation && __onlineObservation.records, status: __onlineMM.cooperate.collabV2Adapter.getStatus(),
      rootText: __onlineMM.renderer.root.getData('text'), modelsText: __onlineMM.renderer.renderTree.data.text,
      readonly: __onlineMM.opt.readonly, compactLayout: __onlineMM.opt.compactLayout,
      rootRect: __onlineMM.renderer.root.group.node.getBoundingClientRect().toJSON(),
      rootConnected: __onlineMM.renderer.root.group.node.isConnected,
      rootDomText: __onlineMM.renderer.root.group.node.textContent,
      rendererIsRendering: __onlineMM.renderer.isRendering,
      rootUidLookupExists: !!__onlineMM.renderer.findNodeByUid('root'),
      rootUidLookupCurrent: __onlineMM.renderer.findNodeByUid('root') === __onlineMM.renderer.root,
      rootData: __onlineMM.renderer.root.getData(),
      lastPushedRoot: __onlineMM.cooperate.lastPushed.root,
      currentDataRoot: __onlineMM.cooperate.currentData && __onlineMM.cooperate.currentData.root,
      renderGeneration: __onlineMM.renderer._renderGeneration,
      viewportNodes: __onlineMM.renderer._visibleViewportNodes && __onlineMM.renderer._visibleViewportNodes.size,
      rootCoordinates: { left: __onlineMM.renderer.root.left, top: __onlineMM.renderer.root.top,
        width: __onlineMM.renderer.root.width, height: __onlineMM.renderer.root.height },
      connectedMindMapNodes: document.querySelectorAll('#mindMapContainer .smm-node').length,
      native: __onlineNativeEvents,
      cooperate: { isSetData: __onlineMM.cooperate.isSetData, isApplyingRemote: __onlineMM.cooperate.isApplyingRemote,
        pendingTextUids: __onlineMM.cooperate._pendingTextUids && Array.from(__onlineMM.cooperate._pendingTextUids),
        httpSettlingAfterReplace: __onlineMM.cooperate.httpSettlingAfterReplace }
    })).catch(error => ({ message: error.message })))))
    write('failure.json', { message: error.message, stack: error.stack, sampleCount: samples.length,
      stage: 'Diagnostic setup failures are not automatically business RED', errorAt: Date.now() })
    throw error
  } finally {
    write('native-frames.json', frames)
    write('resources.json', resources)
    write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
  }
}
module.exports = { run, mountPersistedTree, settled, distribution }
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
