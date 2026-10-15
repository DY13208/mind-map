"use strict"
const { runCases } = require('./frontend-runner.cjs')

async function scenario(mode) {
  const f = window.perfFrontend, room = 'window-exit-' + crypto.randomUUID()
  const editor = await f.mountEditor(room), mm = editor.component.mindMap
  const data = f.tree(200)
  mm.updateConfig({ openPerformance: false, compactLayout: false })
  await f.waitRender(mm, () => mm.setData(data))
  const v2 = await f.connectV2(mm, data, room), co = v2.co, renderer = mm.renderer
  const uid = mode === 'deleted' ? 'n0' : 'root', target = 'Final edit inside render window'
  const writes = [], submits = [], transactions = []
  const originalPut = IDBObjectStore.prototype.put
  const originalSubmit = v2.adapter.submitOperation.bind(v2.adapter)
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox' && value.roomKey === room) {
      const row = { opId: value.opId, uid: value.payload && value.payload.uid, text: value.payload && value.payload.text }
      writes.push(row)
      transactions.push(new Promise(resolve => this.transaction.addEventListener('complete', resolve)))
    }
    return originalPut.call(this, value, key)
  }
  v2.adapter.submitOperation = function(op) {
    submits.push({ disposedAtCall: !!co._disposed, type: op.type, uid: op.payload && op.payload.uid, text: op.payload && op.payload.text })
    return originalSubmit(op)
  }
  let entered = null, destroyed = false
  const hookErrors = []
  const onStart = () => {
    Promise.resolve().then(() => {
      if (entered || renderer.root) return
      clearTimeout(co.httpTextTimer); co.httpTextTimer = null
      entered = { rootMissing: !renderer.root, rendering: renderer.isRendering,
        pending: Array.from(co._pendingTextUids || []),
        currentText: renderer.renderTree.data.text, settling: Date.now() < co.suppressLocalUntil,
        activeCount: renderer.activeNodeList.length }
      v2.socket.disconnect()
      // This invokes the real Edit handoff before the real engine teardown.
      f.unmount(editor); destroyed = true
    }).catch(error => hookErrors.push(error.stack || String(error)))
  }
  try {
    await f.pause(50)
    if (mode === 'active-replaced' || mode === 'immediate-active-replaced') {
      mm.execCommand('SET_NODE_ACTIVE', renderer.findNodeByUid('root'), true)
      const result = await f.requestMemory('emit', { event: 'op', payload: {
        opId: crypto.randomUUID(), roomKey: room, clientId: 'remote-settling-peer',
        type: 'node.update', payload: { uid: 'n1', text: 'Real remote settle' }
      } })
      await v2.adapter.applyRemoteOperation(result.operation)
    }
    mm.execCommand('SET_NODE_TEXT', renderer.findNodeByUid(uid), target)
    clearTimeout(co.httpTextTimer); co.httpTextTimer = null
    if (mode === 'deleted') {
      mm.execCommand('REMOVE_NODE', renderer.findNodeByUid(uid))
      // Confirm the real delete commits before exit, so this protection does
      // not confuse an unfinished delete's teardown error with a clean case.
      const deleteDeadline = Date.now() + 4000
      while ((await f.requestMemory('state', { roomKey: room })).revision < 1) {
        if (Date.now() > deleteDeadline) throw new Error('actual delete did not commit before exit window')
        await f.pause(5)
      }
    }
    if (['replaced', 'active-replaced', 'immediate-replaced', 'immediate-active-replaced'].includes(mode)) {
      const next = f.tree(200)
      next.data.text = 'Authoritative replacement snapshot'
      const result = await f.requestMemory('emit', { event: 'op', payload: {
        opId: crypto.randomUUID(), roomKey: room, clientId: 'snapshot-source',
        type: 'node.update', payload: { uid: 'root', text: next.data.text }
      } })
      // Public snapshot refresh replaces objects but deliberately reuses UIDs.
      if (mode.startsWith('immediate') || mode === 'active-replaced') mm.updateData(next)
      else mm.setData(next)
      co.resyncHttpBaseline(next)
      v2.adapter.setLastServerRevision(result.serverRevision)
    }
    if (mode.startsWith('immediate')) {
      entered = { rootMissing: !renderer.root, rootMismatch: renderer.root.nodeData !== renderer.renderTree,
        timerActive: !!renderer.renderTimer, rendering: renderer.isRendering,
        pending: Array.from(co._pendingTextUids || []), currentText: renderer.renderTree.data.text,
        settling: Date.now() < co.suppressLocalUntil, activeCount: renderer.activeNodeList.length }
      v2.socket.disconnect()
      f.unmount(editor); destroyed = true
    } else {
      mm.on('node_tree_render_start', onStart)
      mm.render()
    }
    const deadline = Date.now() + 5000
    while (!destroyed && Date.now() < deadline) {
      if (hookErrors.length) throw new Error('exit-window hook failed: ' + hookErrors.join('\n'))
      await f.pause(5)
    }
    if (!destroyed) throw new Error('real exit in root-null window was not observed')
    await f.pause(350)
    await Promise.all(transactions)
    const rows = await new Promise((resolve, reject) => {
      const open = indexedDB.open('mind-map-collab-v2', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('outbox', 'readonly'), req = tx.objectStore('outbox').getAll()
        req.onerror = () => reject(req.error)
        req.onsuccess = () => { resolve(req.result.filter(row => row.roomKey === room).map(row => ({
          opId: row.opId, uid: row.payload && row.payload.uid, text: row.payload && row.payload.text, status: row.status
        }))); db.close() }
      }
    })
    const canonical = await f.requestMemory('state', { roomKey: room })
    return { mode, hookErrors, target, uid, entered, writes: structuredClone(writes), submits: structuredClone(submits), rows,
      canonicalText: canonical.nodes.root.data.text,
      disposed: !!co._disposed, pending: Array.from(co._pendingTextUids || []), timerActive: !!co.httpTextTimer }
  } finally {
    IDBObjectStore.prototype.put = originalPut
    mm.off('node_tree_render_start', onStart)
    try { if (!destroyed) f.unmount(editor) } finally { await v2.adapter.disconnect() }
  }
}

runCases('cooperate-immediate-snapshot-exit', ['immediate-replaced', 'immediate-active-replaced'].map(mode => ({
  id: 'R23-' + mode, name: 'actual updateData followed immediately by exit cannot write retired same-UID text: ' + mode,
  observe: page => page.evaluate(scenario, mode), checks: [
    { name: 'the real pre-layout exit still has an old root and a new authoritative raw snapshot', assert: (x, a) => {
      a.deepEqual(x.hookErrors, []); a.equal(x.entered.rootMissing, false); a.equal(x.entered.rootMismatch, true)
      a.equal(x.entered.timerActive, true); a.equal(x.entered.currentText, 'Authoritative replacement snapshot')
      a.equal(x.canonicalText, 'Authoritative replacement snapshot')
      if (x.mode === 'immediate-active-replaced') { a.equal(x.entered.settling, true); a.ok(x.entered.activeCount > 0) }
    } },
    { name: 'no retired root edit is submitted or durably queued', assert: (x, a) => {
      a.ok(!x.submits.some(op => op.uid === 'root'), JSON.stringify(x.submits)); a.deepEqual(x.rows, [])
    } }
  ]
})))
