"use strict"
const path = require('node:path')
const { runCases } = require('./frontend-runner.cjs')

async function scenario(mode) {
  const f = window.perfFrontend, room = 'window-exit-replay-' + crypto.randomUUID()
  const clientId = crypto.randomUUID(), data = f.tree(200), target = 'Latest render-window A edit'
  await f.requestMemory('seed', { roomKey: room, tree: data })
  const old = await f.mountEditor(room), mm = old.component.mindMap
  mm.updateConfig({ openPerformance: false, compactLayout: false })
  await f.waitRender(mm, () => mm.setData(structuredClone(data)))
  const original = await f.connectStableV2(mm, data, room, clientId), outbox = f.createOutbox()
  const hookErrors = [], transactionRows = []
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox' && value.roomKey === room) {
      this.transaction.addEventListener('complete', () => transactionRows.push({
        opId: value.opId, clientId: value.clientId, text: value.payload.text
      }))
    }
    return originalPut.call(this, value, key)
  }
  let entered = null, destroyed = false, freshEditor, fresh, peerMM, peer
  const onStart = () => {
    Promise.resolve().then(() => {
      if (entered || mm.renderer.root) return
      clearTimeout(original.co.httpTextTimer); original.co.httpTextTimer = null
      entered = { rootMissing: !mm.renderer.root, rendering: mm.renderer.isRendering,
        pending: Array.from(original.co._pendingTextUids), text: mm.renderer.renderTree.data.text }
      f.unmount(old); destroyed = true
    }).catch(error => hookErrors.push(error.stack || String(error)))
  }
  try {
    original.socket.disconnect()
    mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('root'), target)
    clearTimeout(original.co.httpTextTimer); original.co.httpTextTimer = null
    mm.on('node_tree_render_start', onStart); mm.render()
    const deadline = Date.now() + 8000
    let rows = []
    while (!destroyed || !(rows = await outbox.list(clientId, room)).length || transactionRows.length !== 1) {
      if (hookErrors.length) throw new Error('actual exit hook failed: ' + hookErrors.join('\n'))
      if (Date.now() > deadline) throw new Error('actual render-window exit did not durably enqueue its edit')
      await f.pause(10)
    }
    const exitTransactionRows = structuredClone(transactionRows)
    IDBObjectStore.prototype.put = originalPut
    await original.adapter.disconnect()
    const queued = { opId: rows[0].opId, clientId: rows[0].clientId, roomKey: rows[0].roomKey,
      text: rows[0].payload.text, status: rows[0].status }
    const before = await f.requestMemory('state', { roomKey: room })
    peerMM = await f.createEngine(structuredClone(data))
    peer = await f.connectStableV2(peerMM, data, room, crypto.randomUUID())
    freshEditor = await f.mountEditor(room)
    const freshMM = freshEditor.component.mindMap
    await f.waitRender(freshMM, () => freshMM.setData(structuredClone(data)))
    const freshInitial = freshMM.renderer.findNodeByUid('root').getData('text')
    fresh = await f.connectStableV2(freshMM, data, room, clientId, mode)
    const settle = Date.now() + 8000, eventsExpected = mode === 'duplicates' ? 2 : 1
    while (fresh.ack.length !== 1 || fresh.events.length !== eventsExpected || peer.events.length !== eventsExpected ||
      fresh.adapter.getStatus().lastServerRevision !== 1 || (await outbox.list(clientId, room)).length ||
      freshMM.renderer.isRendering || peerMM.renderer.isRendering || fresh.co._remoteGeometryTimer || peer.co._remoteGeometryTimer) {
      if (Date.now() > settle) throw new Error('actual render-window replay ACK/model did not settle')
      await f.pause(20)
    }
    await f.pause(30)
    const state = await f.requestMemory('state', { roomKey: room })
    const describe = map => {
      const node = map.renderer.findNodeByUid('root'), text = node._textData.node.node
      return { model: node.getData('text'), raw: map.renderer.renderTree.data.text,
        dom: text.textContent, connected: text.isConnected }
    }
    return { mode, clientId, target, entered, hookErrors, transactionRows: exitTransactionRows, queued,
      before: { text: before.nodes.root.data.text, revision: before.revision, operations: before.operations.length }, freshInitial,
      after: { text: state.nodes.root.data.text, revision: state.revision, opIds: state.operations.map(op => op.opId) },
      actor: describe(freshMM), peer: describe(peerMM), freshClientId: fresh.adapter.getClientId(),
      freshAck: structuredClone(fresh.ack), freshEvents: structuredClone(fresh.events), peerEvents: structuredClone(peer.events),
      durableRemaining: (await outbox.list(clientId, room)).length,
      freshStatus: { head: fresh.adapter.getStatus().lastServerRevision, pending: fresh.adapter.getStatus().pendingCount,
        outbox: fresh.adapter.getStatus().outboxPending } }
  } finally {
    IDBObjectStore.prototype.put = originalPut
    mm.off('node_tree_render_start', onStart)
    try {
      if (!destroyed) f.unmount(old)
      if (freshEditor) f.unmount(freshEditor)
      if (peerMM) peerMM.destroy()
    } finally {
      await Promise.all([original.adapter.disconnect(), fresh && fresh.adapter.disconnect(), peer && peer.adapter.disconnect()])
    }
  }
}
runCases('cooperate-render-window-exit-replay', ['event-first', 'ack-first', 'duplicates'].map(mode => ({
  id: 'R23-window-exit-replay-' + mode,
  name: 'the actual render-window durable row replays once to a fresh same-client editor and a real peer: ' + mode,
  observe: page => page.evaluate(scenario, mode), checks: [
    { name: 'the original unsent edit came from real root-null exit and completed one actual IDB transaction', assert: (x, a) => {
      a.deepEqual(x.hookErrors, []); a.equal(x.entered.rootMissing, true); a.equal(x.entered.rendering, true)
      a.deepEqual(x.entered.pending, ['root']); a.equal(x.entered.text, x.target)
      a.equal(x.transactionRows.length, 1); a.equal(x.transactionRows[0].opId, x.queued.opId)
      a.equal(x.transactionRows[0].text, x.target); a.equal(x.queued.clientId, x.clientId); a.equal(x.queued.status, 'pending')
      a.equal(x.before.revision, 0); a.equal(x.before.operations, 0); a.equal(x.before.text, 'Root'); a.equal(x.freshInitial, 'Root')
    } },
    { name: 'the original durable opId commits once, ACKs once and leaves no pending row', assert: (x, a) => {
      a.deepEqual(x.after.opIds, [x.queued.opId]); a.equal(x.after.revision, 1); a.equal(x.after.text, x.target)
      a.equal(x.freshAck.length, 1); a.equal(x.freshAck[0].opId, x.queued.opId); a.equal(x.freshAck[0].duplicate, false)
      a.equal(x.freshClientId, x.clientId); a.equal(x.durableRemaining, 0); a.deepEqual(x.freshStatus, { head: 1, pending: 0, outbox: 0 })
    } },
    { name: 'fresh actor and real different-client peer current model/raw/attached DOM all have the persisted edit', assert: (x, a) => {
      for (const model of [x.actor, x.peer]) {
        a.equal(model.model, x.target); a.equal(model.raw, x.target); a.equal(model.dom, x.target); a.equal(model.connected, true)
      }
      a.equal(x.freshEvents.length, mode === 'duplicates' ? 2 : 1); a.equal(x.peerEvents.length, mode === 'duplicates' ? 2 : 1)
      a.ok(x.freshEvents.every(event => event.opId === x.queued.opId)); a.ok(x.peerEvents.every(event => event.opId === x.queued.opId))
    } }
  ]
})), { entry: path.join(__dirname, 'cooperate-replay-browser-entry.js') })
