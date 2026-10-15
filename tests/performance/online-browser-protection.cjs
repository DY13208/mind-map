const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { mountPersistedTree, settled } = require('./online-browser-matrix.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const sourceManifest = require('./online-source-manifest.cjs')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')

async function installDraftProbe(page) {
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put
    const records = []
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args)
      if (this.transaction.db.name === 'mind-map-local' && this.name === 'drafts') {
        const record = { at: performance.timeOrigin + performance.now(), key: args[1], rootText: args[0]?.root?.data?.text, completed: false }
        records.push(record)
        this.transaction.addEventListener('complete', () => { record.completed = true; record.completedAt = performance.timeOrigin + performance.now() }, { once: true })
      }
      return request
    }
    window.__onlineDraftProbe = { records, restore() { IDBObjectStore.prototype.put = originalPut } }
  })
}

async function readActualDraft(client, roomKey) {
  return client.page.evaluate(roomKey => new Promise((resolve, reject) => {
    const open = indexedDB.open('mind-map-local', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('drafts', 'readonly')
      const request = tx.objectStore('drafts').get('room:' + roomKey)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const draft = request.result
        let count = 0
        const stack = draft && draft.root ? [draft.root] : []
        while (stack.length) { const node = stack.pop(); count++; stack.push(...(node.children || [])) }
        resolve({ exists: !!draft, key: 'room:' + roomKey, rootText: draft && draft.root && draft.root.data.text, nodes: count })
      }
      tx.oncomplete = () => db.close()
    }
  }), roomKey)
}

async function readActualOutbox(client, roomKey) {
  // Read the real native IDB transaction, including completed writes whose
  // originating adapter may already have been collected. No product hook or
  // manually-created operation is needed to discover the durable opId.
  return client.page.evaluate(roomKey => new Promise((resolve, reject) => {
    const open = indexedDB.open('mind-map-collab-v2', 1)
    open.onupgradeneeded = () => { open.transaction.abort(); reject(new Error('Actual native outbox database was not initialized')) }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('outbox', 'readonly')
      const request = tx.objectStore('outbox').getAll()
      let rows
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        rows = (request.result || []).filter(row => row.roomKey === roomKey && row.status !== 'acknowledged')
          .map(row => ({ opId: row.opId, roomKey: row.roomKey, clientId: row.clientId, clientSeq: row.clientSeq,
            type: row.type, status: row.status, text: row.payload && (row.payload.text || row.payload.data && row.payload.data.text) }))
      }
      tx.oncomplete = () => { db.close(); resolve({ roomKey, driver: 'indexeddb', rows }) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }), roomKey)
}

async function waitCommittedText(frames, text, timeout = 300000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const sent = frames.find(frame => frame.client === 0 && frame.direction === 'sent' && frame.event === 'op' && JSON.stringify(frame.body.payload).includes(text))
    const ack = sent && frames.find(frame => frame.client === 0 && frame.direction === 'received' && frame.kind === 'ack' && frame.body.opId === sent.body.opId && frame.body.ok)
    if (ack) return { sent, ack }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Native committed text ACK deadline: ' + text)
}

async function rememberRetiredEditor(client, tag) {
  return client.page.evaluate(tag => {
    const mm = __onlineMM
    let element = document.querySelector('#mindMapContainer'), editor
    while (element) {
      if (element.__vue__ && element.__vue__.mindMap === mm) { editor = element.__vue__; break }
      element = element.parentElement
    }
    if (!editor || typeof WeakRef !== 'function') throw new Error('Actual editor/WeakRef fixture unavailable')
    const appVm = document.querySelector('#app').__vue__, components = [appVm]
    let demonstrate
    while (components.length) {
      const vm = components.pop()
      if (vm.mindMap === mm && vm.$options._componentTag === 'Demonstrate') demonstrate = vm
      components.push(...(vm.$children || []))
    }
    if (!demonstrate) throw new Error('HARNESS_FIXTURE: actual complete App Demonstrate owner not found')
    const renderer = mm.renderer, cooperate = mm.cooperate
    const nativeDestroy = mm.destroy
    window.__onlineDestroyWitnesses = window.__onlineDestroyWitnesses || Object.create(null)
    // Read-only call-through capture at the actual native destroy boundary.
    // Only scalar values survive in the witness; no old editor/model is rooted.
    mm.destroy = function (...args) {
      const result = nativeDestroy.apply(this, args)
      __onlineDestroyWitnesses[tag] = {
        tag, at: performance.timeOrigin + performance.now(),
        rendererDestroyed: renderer._destroyed === true,
        rendererRootCleared: renderer.root === null, rendererTreeCleared: renderer.renderTree === null,
        nodeCache: Object.keys(renderer.nodeCache || {}).length,
        nodeIndex: renderer.nodeIndex ? renderer.nodeIndex.size : null,
        activeNodeList: (renderer.activeNodeList || []).length,
        activeIndexList: (renderer._activeIndexList || []).length,
        inputDataCleared: mm.opt.data === null,
        historyLength: Array.isArray(mm.command.history) ? mm.command.history.length : null,
        cooperateDisposed: cooperate._disposed === true,
        lastPushed: Object.keys(cooperate.lastPushed || {}).length,
        pendingTextUids: cooperate._pendingTextUids ? cooperate._pendingTextUids.size : null,
        pendingUids: cooperate.pendingUids ? cooperate.pendingUids.size : null,
        ackedUids: cooperate.ackedUids ? cooperate.ackedUids.size : null,
        deletedUids: cooperate.deletedUids ? cooperate.deletedUids.size : null,
        abandonedInsertUids: cooperate.abandonedInsertUids ? cooperate.abandonedInsertUids.size : null,
        recentHttpDeleted: cooperate.recentHttpDeleted ? cooperate.recentHttpDeleted.size : null,
        pendingGenIntent: cooperate.pendingGenIntent ? cooperate.pendingGenIntent.size : null,
        rendererWaiters: cooperate._v2RendererWaiters ? cooperate._v2RendererWaiters.size : null,
        pendingRemoteUids: cooperate.pendingRemoteUids ? cooperate.pendingRemoteUids.size : null,
        pendingRemoteAdded: cooperate.pendingRemoteAdded ? cooperate.pendingRemoteAdded.size : null,
        pendingRemoteDeleted: cooperate.pendingRemoteDeleted ? cooperate.pendingRemoteDeleted.size : null,
        pendingRemoteTreeCleared: cooperate.pendingRemoteTree == null,
        httpTextTimer: !!cooperate.httpTextTimer, httpStructureTimer: !!cooperate.httpStructureTimer
      }
      return result
    }
    // Tags and WeakRefs retain neither the editor nor its 6001-node tree.
    mm.__onlineRetiredEditorTag = tag
    window.__onlineRetiredEditors = window.__onlineRetiredEditors || []
    __onlineRetiredEditors.push({ tag, mm: new WeakRef(mm), renderer: new WeakRef(mm.renderer), editor: new WeakRef(editor),
      cooperate: new WeakRef(mm.cooperate), adapter: new WeakRef(mm.cooperate.collabV2Adapter),
      demonstrate: new WeakRef(demonstrate),
      selectedNodes: (mm.renderer.activeNodeList || []).map(node => new WeakRef(node)) })
    return { tag, roomKey: mm.cooperate.collabV2Adapter.getStatus().roomKey }
  }, tag)
}

async function retiredEditorSnapshot(client) {
  return client.page.evaluate(() => (window.__onlineRetiredEditors || []).map(item => {
    const mm = item.mm.deref(), renderer = item.renderer.deref(), editor = item.editor.deref()
    const cooperate = item.cooperate.deref(), adapter = item.adapter.deref()
    const demonstrate = item.demonstrate && item.demonstrate.deref()
    const appVm = document.querySelector('#app').__vue__, bus = appVm.$bus
    const isBound = (event, handler) => (bus._events[event] || []).some(fn => fn === handler || fn.fn === handler)
    const events = mm && mm.event && mm.event.eventNames ? mm.event.eventNames() : null
    const selectedNodes = (item.selectedNodes || []).map(ref => {
      const node = ref.deref()
      if (!node) return { collected: true }
      const seen = new Set(), stack = node.nodeData ? [node.nodeData] : []
      while (stack.length) {
        const current = stack.pop()
        if (!current || seen.has(current)) continue
        seen.add(current)
        stack.push(...(current.children || []))
      }
      return { collected: false, uid: node.nodeData && node.nodeData.data ? node.nodeData.data.uid : node.uid,
        nodeBelongsToRetiredMM: node.mindMap === mm,
        attached: !!(node.group && node.group.node.isConnected), actualRetainedInputSubtreeNodes: seen.size,
        directRendererChildren: (node.children || []).length }
    })
    return { tag: item.tag, collected: { mm: !mm, renderer: !renderer, editor: !editor, cooperate: !cooperate, adapter: !adapter },
      selectedNodes,
      actualDemonstrateOwner: demonstrate ? { tag: demonstrate.$options._componentTag, destroyed: demonstrate._isDestroyed === true,
        currentMindMapIsRetired: demonstrate.mindMap === mm, jumpStillOnActualAppBus: isBound('demonstrate_jump', demonstrate.onJump),
        exitStillOnActualAppBus: isBound('exit_demonstrate', demonstrate.onExit), curStepIndex: demonstrate.curStepIndex, totalStep: demonstrate.totalStep } : { collected: true },
      actualState: { editorDisposed: editor ? editor._editorDisposed === true : null, editorMindMapCleared: editor ? editor.mindMap === null : null,
        editorSaveTimer: editor ? !!editor.storeDataTimer : null, editorConfigTimer: editor ? !!editor.storeConfigTimer : null,
        rendererDestroyed: renderer ? renderer._destroyed === true : null,
        rendererRootCleared: renderer ? renderer.root === null : null,
        rendererTreeCleared: renderer ? renderer.renderTree === null : null,
        nodeCache: renderer ? Object.keys(renderer.nodeCache || {}).length : null,
        nodeIndex: renderer && renderer.nodeIndex ? renderer.nodeIndex.size : null,
        activeIndexList: renderer && renderer._activeIndexList ? renderer._activeIndexList.length : null,
        activeIndexRetiredNodes: renderer && renderer._activeIndexList ? renderer._activeIndexList.map(node => ({ uid: node.getData('uid'),
          nodeBelongsToRetiredMM: node.mindMap === mm, connected: !!(node.group && node.group.node.isConnected) })) : null,
        optDataCleared: mm && mm.opt && Object.hasOwn(mm.opt, 'data') ? mm.opt.data === null : null,
        nativeHistory: mm && mm.command && Array.isArray(mm.command.history) ? mm.command.history.length : null,
        cooperateDisposed: cooperate ? cooperate._disposed === true : null,
        lastPushed: cooperate && cooperate.lastPushed && typeof cooperate.lastPushed === 'object' ? Object.keys(cooperate.lastPushed).length : null,
        ackedUids: cooperate && cooperate.ackedUids ? cooperate.ackedUids.size : null,
        pendingUids: cooperate && cooperate.pendingUids ? cooperate.pendingUids.size : null,
        deletedUids: cooperate && cooperate.deletedUids ? cooperate.deletedUids.size : null,
        abandonedInsertUids: cooperate && cooperate.abandonedInsertUids ? cooperate.abandonedInsertUids.size : null,
        recentHttpDeleted: cooperate && cooperate.recentHttpDeleted ? cooperate.recentHttpDeleted.size : null,
        pendingGenIntent: cooperate && cooperate.pendingGenIntent ? cooperate.pendingGenIntent.size : null,
        pendingTextUids: cooperate && cooperate._pendingTextUids ? cooperate._pendingTextUids.size : null,
        httpTextFlushPromise: cooperate ? !!cooperate.httpTextFlushPromise : null,
        httpTextTimerHandle: cooperate ? !!cooperate.httpTextTimer : null,
        adapterState: adapter ? adapter.getStatus() : null,
        listeners: events ? events.reduce((sum, name) => sum + mm.event.listenerCount(name), 0) : null }
    }
  }))
}

async function exitToFiles(client, pendingDraft = null) {
  const exitTiming = await route(client, { path: '/files' }, pendingDraft)
  await client.page.waitForFunction(() => !document.querySelector('#mindMapContainer'), null, { timeout: 30000 })
  const beforeExplicitGC = { witnesses: await client.page.evaluate(() => window.__onlineDestroyWitnesses || {}),
    retiredEditors: await retiredEditorSnapshot(client) }
  const cdp = await client.page.context().newCDPSession(client.page)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.detach()
  return { ...await observe.resourceSnapshot(client), exitTiming, beforeExplicitGC, retiredEditors: await retiredEditorSnapshot(client) }
}

function assertDestroyWitnesses(exit) {
  const witnesses = Object.values(exit.beforeExplicitGC.witnesses)
  assert.ok(witnesses.length > 0, 'Actual native destroy was observed before forced GC')
  for (const item of witnesses) {
    for (const key of ['rendererDestroyed', 'rendererRootCleared', 'rendererTreeCleared', 'inputDataCleared', 'cooperateDisposed', 'pendingRemoteTreeCleared']) {
      assert.equal(item[key], true, item.tag + ' native destroy ' + key)
    }
    for (const key of ['nodeCache', 'nodeIndex', 'activeNodeList', 'activeIndexList', 'historyLength', 'lastPushed',
      'pendingTextUids', 'ackedUids', 'deletedUids', 'abandonedInsertUids', 'recentHttpDeleted', 'pendingGenIntent',
      'rendererWaiters', 'pendingRemoteUids', 'pendingRemoteAdded', 'pendingRemoteDeleted']) {
      if (item[key] !== null) assert.equal(item[key], 0, item.tag + ' native destroy ' + key)
    }
    // A cleared numeric timer handle is not an active timer. Pending in-flight
    // ACK work is inspected after Vue exit and the IDB transaction below.
  }
}

async function currentText(client, text, timeout = 300000) {
  await client.page.waitForFunction(text => {
    const root = __onlineMM.renderer.root
    if (!root) return false // A real async layout temporarily has no current root.
    const html = '<p>' + text + '</p>'
    const group = root.group && root.group.node
    const rect = group && group.getBoundingClientRect()
    return root.getData('text') === html && __onlineMM.renderer.renderTree.data.text === html && group && group.isConnected &&
      group.textContent.includes(text) && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
  }, text, { timeout })
}

async function route(client, target, pendingDraft = null) {
  return client.page.evaluate(async ({ target, pendingDraft }) => {
    const app = document.querySelector('#app').__vue__
    if (pendingDraft && __onlineDraftProbe.records.some(item => item.key === 'room:' + pendingDraft.roomKey && String(item.rootText).includes(pendingDraft.text))) {
      throw new Error('HARNESS_FIXTURE: final edit was already saved before actual Vue exit began')
    }
    const startedAt = performance.timeOrigin + performance.now()
    if (window.__onlineObservation) __onlineObservation.cleanup()
    delete window.__onlineObservation
    window.__onlineMM = null // Release only the harness reference before real Vue teardown.
    await app.$router.push(target)
    return { startedAt, completedAt: performance.timeOrigin + performance.now() }
  }, { target, pendingDraft })
}

async function existingEditor(client, roomKey) {
  await client.page.waitForFunction(roomKey => {
    let element = document.querySelector('#mindMapContainer')
    while (element) {
      if (element.__vue__ && element.__vue__.mindMap) {
        const mm = element.__vue__.mindMap
        const status = mm.cooperate && mm.cooperate.collabV2Adapter && mm.cooperate.collabV2Adapter.getStatus()
        if (status && status.roomKey === roomKey && status.phase === 'LIVE' && !mm.renderer.isRendering) {
          window.__onlineMM = mm
          return true
        }
      }
      element = element.parentElement
    }
    return false
  }, roomKey, { timeout: 300000 })
  await client.page.evaluate(() => __onlineMM.updateConfig({ compactLayout: false }))
}

async function runProtection() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'after'
  const collectBusErrors = process.env.PERF_TDD_ONLINE_COLLECT_BUS_ERRORS === '1'
  const output = onlineOutputDirectory(phase, 'protection')
  fs.mkdirSync(output, { recursive: true })
  if (['result.json', 'failure.json'].some(name => fs.existsSync(path.join(output, name)))) throw new Error('REFUSE_OVERWRITE: preserve previous complete-App protection evidence')
  sourceManifest.capture(phase, output)
  fs.writeFileSync(path.join(output, 'harness-manifest.json'), JSON.stringify({ capturedAt: Date.now(), runtime: process.version,
    files: ['online-browser-protection.cjs','online-browser-matrix.cjs','online-browser-smoke.cjs','online-browser-observation.cjs',
      'online-web-fixture.cjs','online-server-child.cjs','online-cleanup.cjs','online-output-directory.cjs','isolation.cjs']
      .map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex') })) }, null, 2))
  const fixture = await startFixture({ phase, instances: 2 })
  const write = (file, value) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2))
  const frames = [], clients = [], checks = [], lifecycle = [], busErrors = []
  const checkBusExit = (exit, iteration, baseline) => {
    const stale = exit.retiredEditors.filter(item => item.actualDemonstrateOwner &&
      (item.actualDemonstrateOwner.jumpStillOnActualAppBus || item.actualDemonstrateOwner.exitStillOnActualAppBus))
    const mismatch = baseline !== undefined && exit.app.appBusListeners !== baseline
    if (collectBusErrors && (stale.length || mismatch)) {
      busErrors.push({ iteration, observedAt: Date.now(), expectedBaseline: baseline ?? null, actualListeners: exit.app.appBusListeners,
        actualEvents: exit.app.appBusListenerEvents, staleDestroyedOwners: stale.map(item => ({ tag: item.tag, owner: item.actualDemonstrateOwner })) })
      write('bus-errors.json', { status: 'DIAGNOSTIC_BUS_ASSERTIONS_FAILED', diagnosticOnly: true, rows: busErrors })
      return
    }
    if (baseline !== undefined) assert.equal(exit.app.appBusListeners, baseline, 'Actual App bus listeners return to exit baseline')
    assert.equal(stale.length, 0, 'Actual destroyed Demonstrate callbacks are absent from the live App bus')
  }
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const tree = await fixture.apps[0].control('tree', { roomKey: fixture.roomKey })
    for (let i = 0; i < 2; i++) {
      const client = await openEditor(browser, fixture, i, { setupTimeoutMs: 300000, liveTimeoutMs: 300000,
        onPage: async page => { observe.observeWire(page, i, frames); await observe.installStartupObserver(page); if (i === 0) await installDraftProbe(page) } })
      clients.push(client)
      await mountPersistedTree(client, tree, await fixture.apps[0].control('state', { roomKey: fixture.roomKey }))
      await settled(client)
      await observe.installEditorObserver(client.page)
    }
    await clients[0].page.evaluate(() => __onlineObservation.command('Update-9000'))
    await Promise.all(clients.map(client => currentText(client, 'Update-9000')))
    await waitCommittedText(frames, 'Update-9000')
    await settled(clients[0])
    checks.push({ name: 'baseline-native-edit', wire: observe.assertWireSample(frames, 'Update-9000', 2) })
    const disconnectedId = await clients[1].page.evaluate(() => __onlineMM.cooperate.collabV2Adapter.getClientId())
    await clients[1].context.setOffline(true)
    await fixture.apps[1].control('dropTransport', { roomKey: fixture.roomKey, clientId: disconnectedId })
    await clients[1].page.waitForFunction(() => !__onlineMM.cooperate.collabV2Adapter.getStatus().socketConnected, null, { timeout: 30000 })
    await clients[0].page.evaluate(() => __onlineObservation.command('Update-9001'))
    await currentText(clients[0], 'Update-9001')
    const missedCommit = await waitCommittedText(frames, 'Update-9001')
    await settled(clients[0])
    const fixedHead = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(fixedHead.root_text, '<p>Update-9001</p>')
    assert.equal(Number(fixedHead.revision), Number(missedCommit.ack.body.serverRevision))
    const missedOperation = missedCommit.sent
    assert.ok(fixedHead.operations.some(operation => operation.operation_id === missedOperation.body.opId), 'Missing operation really committed while peer remained offline')
    const offlineState = await clients[1].page.evaluate(() => ({ text: __onlineMM.renderer.root.getData('text'), status: __onlineMM.cooperate.collabV2Adapter.getStatus() }))
    assert.equal(offlineState.text, '<p>Update-9000</p>')
    const restartedAt = Date.now()
    const reconnectStart = frames.length
    await clients[1].context.setOffline(false)
    await settled(clients[1])
    await currentText(clients[1], 'Update-9001')
    const recovered = await clients[1].page.evaluate(() => __onlineMM.cooperate.collabV2Adapter.getStatus())
    assert.equal(recovered.clientId, disconnectedId)
    assert.equal(Number(recovered.lastServerRevision), Number(fixedHead.revision))
    // Manager retry and explicit resync counters do not cover a deliberate
    // server disconnect followed by a normal join. The actual new join/ACK and
    // its missing operation below are the transport/catch-up evidence.
    assert.equal(recovered.socketConnected, true)
    const rejoined = frames.slice(reconnectStart).find(frame => frame.client === 1 && frame.kind === 'ack' && frame.body.ok && frame.body.roomKey === fixture.roomKey && frame.body.sync)
    assert.ok(rejoined && Number(rejoined.body.serverRevision) === Number(fixedHead.revision), 'Real rejoin ACK uses the captured committed head')
    assert.ok(rejoined.body.sync.operations.some(operation => (operation.opId || operation.operationId) === missedOperation.body.opId), 'Native rejoin sync contains the operation missed offline')
    checks.push({ name: 'real-transport-reconnect-and-fixed-head-catchup', restartedAt, completedAt: Date.now(), offlineState, recovered,
      fixedHead, missingOpId: missedOperation.body.opId, rejoined })

    for (const [name, expected] of [['BACK', 'Update-9000'], ['FORWARD', 'Update-9001']]) {
      const start = frames.length
      await clients[0].page.evaluate(async name => {
        __onlineMM.execCommand(name)
        if (__onlineMM.cooperate._v2HistoryQueue) await __onlineMM.cooperate._v2HistoryQueue
      }, name)
      await Promise.all(clients.map(client => currentText(client, expected)))
      await settled(clients[0])
      const relevant = frames.slice(start)
      const sent = relevant.find(frame => frame.direction === 'sent' && frame.event === 'op' && frame.body.type === (name === 'BACK' ? 'operation.undo' : 'operation.redo'))
      assert.ok(sent, 'Undo/Redo uses the real native operation path')
      const ack = relevant.find(frame => frame.kind === 'ack' && frame.body.opId === sent.body.opId && frame.body.ok)
      const remote = relevant.find(frame => frame.client === 1 && frame.event === 'op:event' && frame.body.opId === sent.body.opId)
      assert.ok(ack && remote, 'Undo/Redo committed and reached the actual remote App')
      const history = await clients[0].page.evaluate(() => ({ nativeHistory: __onlineMM.command.history.length,
        adapter: __onlineMM.cooperate.collabV2Adapter.getStatus() }))
      if (phase === 'after') assert.equal(history.nativeHistory, 0)
      const durable = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
      assert.equal(durable.root_text, '<p>' + expected + '</p>')
      assert.equal(durable.count, 6001)
      assert.equal(Number(durable.revision), Number(ack.body.serverRevision))
      assert.ok(durable.operations.some(operation => operation.operation_id === sent.body.opId), 'Undo/Redo operation remains in real PG log')
      checks.push({ name, expected, opId: sent.body.opId, ack, remote, history, durable })
    }
    const persisted = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(persisted.count, 6001)
    assert.equal(persisted.root_text, '<p>Update-9001</p>')
    write('checks.json', { checks, persisted })

    // Same browser context and live Vue SPA: no reload is used to hide retention.
    // The actual router-view has no room key; leave to /files before entering
    // another room so Vue really creates a different editor component.
    const finalDraftText = 'Final A pending edit ' + fixture.roomKey
    await clients[0].page.evaluate(() => __onlineMM.renderer.textEdit.show({ node: __onlineMM.renderer.root, forceEdit: true }))
    await clients[0].page.locator('.smm-richtext-node-edit-wrap .ql-editor[contenteditable="true"]').fill(finalDraftText)
    assert.equal(await clients[0].page.evaluate(() => __onlineMM.renderer.textEdit.isShowTextEdit()), true, 'Exit begins with the real rich editor still open')
    await rememberRetiredEditor(clients[0], 'protection-initial-editor')
    const exitBaseline = await exitToFiles(clients[0], { roomKey: fixture.roomKey, text: finalDraftText })
    write('initial-exit-observations.json', exitBaseline)
    assert.ok(Number.isInteger(exitBaseline.app.appBusListeners), 'Actual App bus listener count is observable')
    await clients[0].page.waitForFunction(({ roomKey, text, exitStartedAt }) => __onlineDraftProbe.records.filter(item => item.key === 'room:' + roomKey &&
      String(item.rootText).includes(text) && item.at >= exitStartedAt && item.completed).length === 1,
      { roomKey: fixture.roomKey, text: finalDraftText, exitStartedAt: exitBaseline.exitTiming.startedAt }, { timeout: 30000 })
    const finalDraft = await readActualDraft(clients[0], fixture.roomKey)
    assert.ok(finalDraft.exists && finalDraft.rootText.includes(finalDraftText))
    assert.equal(finalDraft.nodes, 6001)
    checks.push({ name: 'real-Vue-exit-commits-open-rich-editor-to-original-room-IDB', finalDraftText, finalDraft,
      boundary: 'Actual open editor/input + real beforeDestroy + native IDB put/read; local recovery backup, not a claim of remote PG commit for the unacknowledged exit edit' })
    await clients[0].page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
    const postExitAsync = { boundary: 'Actual Vue route completed, original-room final draft IDB transaction completed, then a separate250ms browser task; no later editor entered and no GC-based leak verdict',
      observedAt: Date.now(), retiredEditors: await retiredEditorSnapshot(clients[0]), finalDraft }
    write('post-exit-async-observations.json', postExitAsync)
    const durableExitOutbox = await readActualOutbox(clients[0], fixture.roomKey)
    write('durable-exit-outbox.json', durableExitOutbox)
    const exitOperations = durableExitOutbox.rows.filter(row => String(row.text || '').includes(finalDraftText))
    assert.equal(exitOperations.length, 1, 'The actual exit edit remains durably queued exactly once for room A')
    const originalExitOpId = exitOperations[0].opId
    checks.push({ name: 'actual-room-A-IDB-outbox-preserved-after-exit', originalExitOpId, durableExitOutbox })
    write('drafts-partial.json', { finalDraft, draftWrites: await clients[0].page.evaluate(() => __onlineDraftProbe.records) })
    write('checks.json', { checks, persisted })
    if (phase === 'after') {
      assertDestroyWitnesses(exitBaseline)
      for (const old of postExitAsync.retiredEditors) {
        if (!old.collected.cooperate) assert.equal(old.actualState.pendingUids, 0, old.tag + ' actual exited editor pending UID work settled')
        if (!old.collected.adapter) assert.equal(old.actualState.adapterState.pendingCount, 0, old.tag + ' disconnected transient ACK promises released')
      }
      checkBusExit(exitBaseline, 0)
    }
    lifecycle.push({ iteration: 0, state: 'exit-baseline-after-explicit-GC', ...exitBaseline })
    const otherRooms = []
    for (let i = 0; i < 10; i++) {
      const seed = await fixture.apps[0].control('seed')
      const persistedTree = await fixture.apps[0].control('tree', { roomKey: seed.roomKey })
      await route(clients[0], { path: '/', query: { room: seed.roomKey } })
      await existingEditor(clients[0], seed.roomKey)
      await mountPersistedTree(clients[0], persistedTree, await fixture.apps[0].control('state', { roomKey: seed.roomKey }))
      await settled(clients[0])
      const entered = await observe.resourceSnapshot(clients[0])
      const enteredContent = await clients[0].page.evaluate(text => {
        const stack = [__onlineMM.renderer.renderTree]
        let containsRoomAFinalText = false
        while (stack.length) {
          const node = stack.pop()
          if (String(node.data.text || '').includes(text)) containsRoomAFinalText = true
          stack.push(...(node.children || []))
        }
        return { containsRoomAFinalText, rootText: __onlineMM.renderer.root.getData('text') }
      }, finalDraftText)
      assert.equal(enteredContent.containsRoomAFinalText, false, 'Room B current complete model never receives room A final edit')
      const enteredPg = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
      assert.equal(Number(enteredPg.revision), 0)
      assert.equal(enteredPg.operations.length, 0)
      assert.ok(!String(enteredPg.root_text).includes(finalDraftText))
      otherRooms.push({ roomKey: seed.roomKey, enteredContent, initialPgHead: Number(enteredPg.revision) })
      assert.equal(entered.app.models, 6001, 'Each different actual App editor has its complete persisted model')
      assert.equal(entered.app.status.roomKey, seed.roomKey)
      assert.ok(Number.isInteger(entered.app.listeners) && Number.isInteger(entered.app.appBusListeners), 'Entered actual editor/App listeners are observable')
      await clients[0].page.evaluate(() => __onlineMM.execCommand('GO_TARGET_NODE', 'root'))
      await clients[0].page.waitForFunction(() => __onlineMM.renderer.activeNodeList.some(node => node.getData('uid') === 'root'), null, { timeout: 30000 })
      lifecycle.push({ iteration: i + 1, state: 'entered-full6001', roomKey: seed.roomKey, enteredContent, ...entered })
      await rememberRetiredEditor(clients[0], 'protection-editor-' + (i + 1))
      const exited = await exitToFiles(clients[0])
      write('latest-exit-observations.json', { iteration: i + 1, ...exited })
      lifecycle.push({ iteration: i + 1, state: 'exited-SPA-after-explicit-GC', ...exited })
      write('lifecycle.json', lifecycle)
      assert.equal(exited.app.connectedMindMapNodes, 0, 'Actual connected mind-map DOM is empty after Vue exit')
      if (phase === 'after') {
        assertDestroyWitnesses(exited)
        checkBusExit(exited, i + 1, exitBaseline.app.appBusListeners)
        for (const old of exited.retiredEditors) {
          if (!old.collected.mm) {
            if (old.actualState.optDataCleared !== null) assert.equal(old.actualState.optDataCleared, true, old.tag + ' MindMap input model released')
            if (old.actualState.nativeHistory !== null) assert.equal(old.actualState.nativeHistory, 0, old.tag + ' native history released')
          }
          if (!old.collected.cooperate) {
            assert.equal(old.actualState.cooperateDisposed, true, old.tag + ' Cooperate disposed')
            if (old.actualState.lastPushed !== null) assert.equal(old.actualState.lastPushed, 0, old.tag + ' Cooperate pushed cache released')
            if (old.actualState.pendingTextUids !== null) assert.equal(old.actualState.pendingTextUids, 0, old.tag + ' Cooperate pending UID work released')
            for (const key of ['ackedUids', 'pendingUids', 'deletedUids', 'abandonedInsertUids', 'recentHttpDeleted', 'pendingGenIntent']) {
              if (old.actualState[key] !== null) assert.equal(old.actualState[key], 0, old.tag + ' Cooperate ' + key + ' cache released')
            }
          }
          if (!old.collected.editor) {
            assert.equal(old.actualState.editorDisposed, true, old.tag + ' editor disposed')
            assert.equal(old.actualState.editorMindMapCleared, true, old.tag + ' editor reference cleared')
            assert.equal(old.actualState.editorSaveTimer, false, old.tag + ' save timer cleared')
            assert.equal(old.actualState.editorConfigTimer, false, old.tag + ' config timer cleared')
          }
          if (!old.collected.renderer) {
            assert.equal(old.actualState.rendererDestroyed, true, old.tag + ' renderer destroyed')
            assert.equal(old.actualState.rendererRootCleared, true, old.tag + ' root released')
            assert.equal(old.actualState.rendererTreeCleared, true, old.tag + ' model released')
            assert.equal(old.actualState.nodeCache, 0, old.tag + ' cache cleared')
            assert.equal(old.actualState.nodeIndex, 0, old.tag + ' UID index cleared')
            assert.equal(old.actualState.activeIndexList, 0, old.tag + ' active index list releases selected node/data references')
          }
        }
      }
      const roomDraft = await readActualDraft(clients[0], seed.roomKey)
      if (roomDraft.exists) assert.ok(!String(roomDraft.rootText || '').includes(finalDraftText), 'Room B never receives room A final edit')
      write('lifecycle.json', lifecycle)
    }
    const draftWrites = await clients[0].page.evaluate(() => __onlineDraftProbe.records)
    assert.equal(draftWrites.filter(item => item.key === 'room:' + fixture.roomKey && String(item.rootText).includes(finalDraftText)).length, 1,
      'Old editor final physical draft is written exactly once and no later retired timer writes it again')
    assert.ok((await readActualDraft(clients[0], fixture.roomKey)).rootText.includes(finalDraftText), 'Original room final draft survives entry/exit of ten other maps')
    write('drafts.json', { finalDraft, draftWrites })
    const beforeReturnToA = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(Number(beforeReturnToA.revision), Number(persisted.revision), 'Disconnected editor A does not silently commit in a later B room')
    assert.equal(beforeReturnToA.operations.filter(row => row.operation_id === originalExitOpId).length, 0)
    for (const other of otherRooms) {
      const actual = await fixture.apps[0].control('state', { roomKey: other.roomKey })
      assert.equal(Number(actual.revision), 0, 'Room B has no late room-A operation')
      assert.equal(actual.operations.length, 0)
      assert.ok(!String(actual.root_text).includes(finalDraftText))
    }
    // Re-enter through the real App, without replacing its loaded model. Its
    // new native adapter reads and replays the original durable operation.
    const returnStart = frames.length
    await route(clients[0], { path: '/', query: { room: fixture.roomKey } })
    await existingEditor(clients[0], fixture.roomKey)
    const freshAdapter = await clients[0].page.evaluate(() => {
      const old = __onlineRetiredEditors.find(item => item.tag === 'protection-initial-editor')
      return { isNewAdapter: !old || old.adapter.deref() !== __onlineMM.cooperate.collabV2Adapter,
        isNewMindMap: !__onlineMM.__onlineRetiredEditorTag, status: __onlineMM.cooperate.collabV2Adapter.getStatus() }
    })
    assert.ok(freshAdapter.isNewAdapter && freshAdapter.isNewMindMap, 'A distinct actual App editor/adapter owns room-A recovery')
    await clients[0].page.evaluate(() => __onlineMM.execCommand('GO_TARGET_NODE', 'root'))
    await currentText(clients[0], finalDraftText)
    await settled(clients[0])
    const replayFrames = frames.slice(returnStart)
    const replaySent = replayFrames.find(frame => frame.client === 0 && frame.direction === 'sent' && frame.event === 'op' && frame.body.opId === originalExitOpId)
    const replayAck = replayFrames.find(frame => frame.client === 0 && frame.direction === 'received' && frame.kind === 'ack' && frame.body.opId === originalExitOpId && frame.body.ok)
    const replayRemote = replayFrames.find(frame => frame.client === 1 && frame.direction === 'received' && frame.event === 'op:event' && frame.body.opId === originalExitOpId)
    assert.ok(replaySent && replayAck, 'Native room-A recovery sent and ACKed the original actual IDB opId')
    assert.ok(replayRemote, 'Room-A recovery reached the actual other-process peer')
    await currentText(clients[1], finalDraftText)
    assert.equal(replaySent.body.roomKey, fixture.roomKey)
    const replayedPg = await fixture.apps[0].control('state', { roomKey: fixture.roomKey })
    assert.equal(replayedPg.operations.filter(row => row.operation_id === originalExitOpId).length, 1, 'Original room-A exit operation has exactly one real PG commit')
    assert.equal(replayedPg.operations.length, beforeReturnToA.operations.length + 1, 'Recovery adds no hidden echo/duplicate operation')
    assert.equal(Number(replayedPg.revision), Number(beforeReturnToA.revision) + 1)
    assert.equal(replayedPg.root_text, '<p>' + finalDraftText + '</p>')
    assert.equal(replayedPg.count, 6001)
    const returnedDraft = await readActualDraft(clients[0], fixture.roomKey)
    assert.ok(returnedDraft.exists && String(returnedDraft.rootText).includes(finalDraftText))
    const returnedOutbox = await readActualOutbox(clients[0], fixture.roomKey)
    assert.equal(returnedOutbox.rows.filter(row => row.opId === originalExitOpId).length, 0, 'ACK removed the actual replayed outbox row')
    checks.push({ name: 'actual-new-App-return-to-A-replays-original-IDB-opId-once', originalExitOpId,
      freshAdapter, replaySent, replayAck, replayRemote, beforeHead: Number(beforeReturnToA.revision), afterHead: Number(replayedPg.revision),
      pgOperationCount: replayedPg.operations.length, returnedDraft, returnedOutbox, otherRooms,
      boundary: 'Real App route/new adapter/native IDB outbox replay + native SEND/ACK and PG. The returning editor uses its native safe-load model; no manual setData or fabricated operation/ACK is used.' })
    await rememberRetiredEditor(clients[0], 'protection-returned-A-editor')
    const returnedExit = await exitToFiles(clients[0])
    if (phase === 'after') { assertDestroyWitnesses(returnedExit); checkBusExit(returnedExit, 'returned-A', exitBaseline.app.appBusListeners) }
    lifecycle.push({ state: 'returned-A-exited-after-actual-durable-replay', ...returnedExit })
    write('lifecycle.json', lifecycle)
    write('checks.json', { checks, persisted, replayedPg })
    const result = { phase, status: collectBusErrors ? (busErrors.length ? 'DIAGNOSTIC_WITH_BUS_FAILURES' : 'DIAGNOSTIC_ONLY_COMPLETED') : 'PROTECTION_MEASURED', actualAppContexts: 2, actualAppInstances: 2,
      layout: 'logicalStructure', compactLayout: false, checks, persisted, replayedPg, lifecycle, finalDraft, draftWrites,
      originalExitOpId, durableExitOutbox, returnedDraft, returnedOutbox,
      diagnosticOnly: collectBusErrors, busErrors,
      resourceBoundary: '10 different real PG maps entered/exited in the same full-App SPA context; explicit GC only after exit; actual selected nodes are also held only through WeakRefs. An uncollected WeakRef alone is not a leak verdict; retained input subtrees or product retainer paths require separate diagnosis. Natural 13-context operation curves are in the separate200-command matrix',
      authentication: 'Synthetic authentication transport identity; actual room ACL and all native PG/socket/Vue components',
      fixtureBoundaries: fixture.fixtureBoundaries,
      bundleHashes: fixture.bundleHashes, browser: browser.version(), runtime: process.version, appRuntimes: fixture.apps.map(app => app.runtime),
      errors: clients.flatMap(client => client.errors) }
    assert.equal(result.errors.length, 0)
    write('result.json', result)
    if (busErrors.length) throw new Error('DIAGNOSTIC_BUS_ASSERTIONS_FAILED: preserved failed bus exits; independent recovery checks do not make this run pass')
    return result
  } catch (error) {
    const activeState = await Promise.all(clients.map(client => client.page.evaluate(() => {
      const mm = __onlineMM
      if (!mm) return { page: 'files', activeMindMap: false }
      const c = mm.cooperate, r = mm.renderer
      return { activeMindMap: true, rootText: r.root && r.root.getData('text'), modelText: r.renderTree && r.renderTree.data.text,
        rootDomText: r.root && r.root.group && r.root.group.node.textContent, isRendering: r.isRendering,
        renderTimer: !!r.renderTimer, hasWaitRendering: r.hasWaitRendering,
        status: c.collabV2Adapter && c.collabV2Adapter.getStatus(), lastAppliedVersion: c.lastAppliedVersion }
    }).catch(captureError => ({ captureError: captureError.message }))))
    write('failure.json', { message: error.message, stack: error.stack, checks, lifecycle, busErrors, diagnosticOnly: collectBusErrors, activeState,
      actualPgState: await fixture.apps[0].control('state', { roomKey: fixture.roomKey }).catch(captureError => ({ captureError: captureError.message })) })
    throw error
  } finally {
    if (clients[0]) await clients[0].page.evaluate(() => window.__onlineDraftProbe && __onlineDraftProbe.restore()).catch(() => {})
    write('native-frames.json', frames)
    write('cleanup.json', await closeOwnedFixture(browser, clients, fixture))
  }
}
module.exports = { runProtection, currentText, route, existingEditor }
if (require.main === module) runProtection().catch(error => { console.error(error); process.exitCode = 1 })
