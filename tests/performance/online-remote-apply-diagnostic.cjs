// Functional reproduction under explicit peer CPU throttling, not a latency
// benchmark or a replacement for the thirteen-context 200-command matrix.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { mountPersistedTree, settled } = require('./online-browser-matrix.cjs')
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const sourceManifest = require('./online-source-manifest.cjs')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')

async function installTimeline(client) {
  await client.page.evaluate(() => {
    const mm = __onlineMM, c = mm.cooperate
    window.__COLLAB_V2_TRACE__ = true
    const rows = []
    const snapshot = (stage, op) => {
      const r = mm.renderer, root = r.root, indexed = r.findNodeByUid('root')
      const current = c.currentData && c.currentData.root
      const item = { at: performance.timeOrigin + performance.now(), stage,
        opId: op && (op.opId || op.operationId), type: op && (op.type || op.event && op.event.type),
        version: op && op.serverRevision,
        eventPayload: op && (op.event && op.event.payload || op.payload),
        rootData: root && root.getData(), renderedRootData: r.renderTree && r.renderTree.data,
        indexedRootData: indexed && indexed.getData(), rootLookupCurrent: indexed === root,
        currentRootData: current && current.data, lastPushedRoot: c.lastPushed.root,
        renderGeneration: r._renderGeneration, isRendering: r.isRendering,
        isApplyingRemote: c.isApplyingRemote, lastAppliedVersion: c.lastAppliedVersion,
        adapterStatus: c.collabV2Adapter.getStatus(), pendingCandidates: Array.from(c._pendingTextUids || []) }
      // Freeze values at the observation boundary; retaining live data objects
      // would let later patches silently rewrite earlier timeline entries.
      const observed = JSON.parse(JSON.stringify(item))
      rows.push(observed)
      if (rows.length > 400) rows.shift()
      return observed
    }
    // Every original return value/Promise and original argument is preserved.
    // These read-only call-through snapshots do not supply or alter operations.
    for (const name of ['applyV2RemoteOperation', 'applyV2PayloadUpdate']) {
      const original = c[name]
      assertFunction(original, name)
      c[name] = function (...args) {
        snapshot(name + ':before', args[0])
        const result = original.apply(this, args)
        if (result && typeof result.then === 'function') {
          result.then(() => snapshot(name + ':resolved', args[0]), () => snapshot(name + ':rejected', args[0]))
        } else snapshot(name + ':returned', args[0])
        return result
      }
    }
    function assertFunction(fn, name) { if (typeof fn !== 'function') throw new Error('Actual method unavailable: ' + name) }
    mm.on('node_tree_render_end', info => snapshot('render_end:' + (info && info.reason)))
    window.__onlineRemoteApplyDiagnostic = { rows, snapshot }
    snapshot('installed')
  })
}

async function main() {
  const cpuRate = Number(process.env.PERF_TDD_REMOTE_CPU_RATE || 8)
  const count = Number(process.env.PERF_TDD_REMOTE_COMMANDS || 32)
  assert.ok(Number.isFinite(cpuRate) && cpuRate >= 1 && cpuRate <= 12)
  assert.ok(Number.isInteger(count) && count > 0 && count <= 100)
  const output = onlineOutputDirectory('after', 'remote-apply-diagnostic-' + crypto.randomUUID())
  fs.mkdirSync(output, { recursive: true })
  sourceManifest.capture('after', output)
  const write = (name, body) => fs.writeFileSync(path.join(output, name), JSON.stringify(body, null, 2))
  const fixture = await startFixture({ phase: 'after', instances: 2 })
  const frames = [], clients = [], commands = []
  let browser, peerCdp, failed
  const capture = async stage => {
    const states = await Promise.all(clients.map(client => client.page.evaluate(stage => ({
      latest: __onlineRemoteApplyDiagnostic.snapshot(stage), timeline: __onlineRemoteApplyDiagnostic.rows,
      records: __onlineObservation.records, native: __onlineNativeEvents, trace: window.__V2_TRACE_LOG__ || []
    }), stage).catch(error => ({ error: error.message }))))
    write('snapshots.json', { stage, observedAt: Date.now(), states })
    write('native-frames.json', frames)
    write('commands.json', commands)
    write('persisted.json', await fixture.apps[0].control('state', { roomKey: fixture.roomKey }))
    return states
  }
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
      await installTimeline(client)
    }
    peerCdp = await clients[1].page.context().newCDPSession(clients[1].page)
    await peerCdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
    write('manifest.json', { status: 'DIAGNOSTIC_ONLY', contexts: 2, instances: 2, models: 6001,
      peerCpuRate: cpuRate, commands: count, bundleHashes: fixture.bundleHashes, browser: browser.version(),
      runtime: process.version, appRuntimes: fixture.apps.map(app => app.runtime),
      harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
      fixtureBoundaries: fixture.fixtureBoundaries,
      scope: 'Actual native commands, ACKs, PG, Socket and full App. Explicit CDP peer CPU throttling exposes asynchronous overlap; no performance comparison or fabricated transport. Read-only actual-method call-through tracing.' })
    for (let iteration = 1; iteration <= count; iteration++) {
      const text = 'Update-' + String(8000 + iteration)
      commands.push(await clients[0].page.evaluate(text => __onlineObservation.command(text), text))
      await Promise.all(clients.map(client => client.page.waitForFunction(text => {
        const item = __onlineObservation.records[text]
        return item && item.modelAt && item.domAt && item.frameAt
      }, text, { timeout: 15000 })))
      observe.assertWireSample(frames, text, 2)
      await settled(clients[0])
      console.log(JSON.stringify({ stage: 'command-visible', iteration, text }))
    }
    await capture('completed')
    write('result.json', { status: 'DIAGNOSTIC_ONLY', completed: commands.length, error: null, browser: browser.version(), runtime: process.version })
  } catch (error) {
    failed = error
    await capture('failed').catch(captureError => write('capture-error.json', { message: captureError.message }))
    write('failure.json', { message: error.message, stack: error.stack, commandsStarted: commands.length,
      boundary: 'A genuine remote model/DOM mismatch must be distinguished from environment or instrument failures by the recorded actual state/PG/native frames' })
    throw error
  } finally {
    if (peerCdp) { await peerCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {}); await peerCdp.detach().catch(() => {}) }
    write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
    console.log(JSON.stringify({ output, failed: !!failed }))
  }
}
module.exports = { main }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
