'use strict'
// Deterministic regressions for the collaborate text-flush settle window.
// A remote/undo/redo apply sets suppressLocalUntil for a short window; during it
// flushHttpTextOnce used to collect only the current selection, so a queued
// local edit on an unselected node could be dropped on a fast exit.
const { runCases } = require('./frontend-runner.cjs')

runCases('settle-window-flush', [{
  id: 'R08-settle-window-unselected-pending-flush',
  name: 'a locally edited unselected node is flushed during the post-remote settle window',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const data = f.tree(12)
    const mm = await f.createEngine(data, { fit: false, openPerformance: true })
    const connection = await f.connectV2(mm, data)
    await f.pause(80)
    const renderer = mm.renderer
    renderer.clearActiveNodeList()
    const target = renderer.findNodeByUid('n0')
    const uid = target.getData('uid')
    mm.execCommand('SET_NODE_TEXT', target, 'settle-window-edit')
    const queued = Array.from(mm.cooperate._pendingTextUids || [])
    mm.cooperate.suppressLocalUntil = Date.now() + 10000
    await mm.cooperate.flushHttpText()
    await f.pause(150)
    const state = await f.requestMemory('state', { roomKey: connection.roomKey })
    const active = (renderer.activeNodeList || []).map(node => node.getData('uid'))
    const serverText = state.nodes[uid] && state.nodes[uid].data && state.nodes[uid].data.text
    await connection.adapter.disconnect(); mm.destroy()
    return { uid, queued, active, serverText }
  }),
  checks: [
    { name: 'the edited node is queued and not the active selection', assert: (x, a) => { a.ok(x.queued.includes(x.uid), 'queued=' + JSON.stringify(x.queued)); a.equal(x.active.includes(x.uid), false) } },
    { name: 'the queued unselected edit is flushed during the settle window', assert: (x, a) => { a.ok(String(x.serverText).includes('settle-window-edit'), 'serverText=' + x.serverText) } }
  ]
}, {
  id: 'R08-settle-window-generalization-owner-dedup',
  name: 'a queued generalization uid plus its active owner collect one owner, not a duplicate',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const data = f.summaryFixture(8)
    const mm = await f.createEngine(data, { fit: false, openPerformance: true })
    const connection = await f.connectV2(mm, data)
    await f.pause(80)
    const renderer = mm.renderer
    const owner = renderer.findNodeByUid('n0')
    const summary = renderer.findNodeByUid('summary')
    const summaryResolvesToOwner = !!(summary && mm.cooperate.resolveHttpPatchNode(summary) === owner)
    if (typeof renderer.activeMultiNode === 'function' && owner) renderer.activeMultiNode([owner])
    const active = (renderer.activeNodeList || []).map(node => node.getData('uid'))
    // A real unsynced local edit on the owner makes hasUnsyncedLocalText(summary)
    // true too, because it resolves to that owner.
    mm.execCommand('SET_NODE_TEXT', owner, 'owner-settle-edit')
    const summaryResolvesUnsynced = !!(summary && mm.cooperate.hasUnsyncedLocalText(summary))
    if (!mm.cooperate._pendingTextUids) mm.cooperate._pendingTextUids = new Set()
    mm.cooperate._pendingTextUids.add('summary')
    mm.cooperate.suppressLocalUntil = Date.now() + 10000
    const collectedUids = mm.cooperate.collectActivePendingText().map(node => node.getData('uid'))
    const pendingUids = Array.from(mm.cooperate._pendingTextUids || [])
    await connection.adapter.disconnect(); mm.destroy()
    return { summaryExists: !!summary, summaryResolvesToOwner, summaryResolvesUnsynced, summaryIsOwnerInstance: summary === owner, pendingUids, active, collectedUids }
  }),
  checks: [
    { name: 'the queued summary instance exists and resolves to the owner', assert: (x, a) => { a.equal(x.summaryExists, true, 'summary instance missing from the renderer index'); a.equal(x.summaryResolvesToOwner, true) } },
    { name: 'the queued summary uid resolves to the owner real unsynced edit', assert: (x, a) => { a.equal(x.summaryResolvesUnsynced, true) } },
    { name: 'the edited owner is the active selection', assert: (x, a) => { a.ok(x.active.includes('n0'), 'active=' + JSON.stringify(x.active)) } },
    { name: 'the resolved owner appears exactly once despite a queued generalization uid', assert: (x, a) => { a.equal(x.collectedUids.filter(uid => uid === 'n0').length, 1, 'collected=' + JSON.stringify(x.collectedUids)) } }
  ]
}, {
  id: 'R08-settle-window-remote-delta-no-echo',
  name: 'a remote-only delta during the settle window is not echoed back as a local operation',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const data = f.tree(12)
    const mm = await f.createEngine(data, { fit: false, openPerformance: true })
    const connection = await f.connectV2(mm, data)
    await f.pause(80)
    const before = await f.requestMemory('state', { roomKey: connection.roomKey })
    const remoteUid = 'n3'
    await mm.cooperate.applyV2RemoteOperation({
      clientId: 'peer-client', serverRevision: 5,
      event: { type: 'node.updated', mapId: connection.roomKey, actorId: 'peer', version: 5, operationId: 'peer-op-1',
        payload: { uid: remoteUid, data: { uid: remoteUid, text: 'remote-only-text' }, text: 'remote-only-text', patch: { text: 'remote-only-text' } } }
    })
    mm.cooperate.suppressLocalUntil = Date.now() + 10000
    const remoteApplied = mm.renderer.findNodeByUid(remoteUid).getData('text')
    await mm.cooperate.flushHttpText()
    await f.pause(150)
    const after = await f.requestMemory('state', { roomKey: connection.roomKey })
    await connection.adapter.disconnect(); mm.destroy()
    return { beforeOps: before.operations.length, afterOps: after.operations.length, remoteApplied }
  }),
  checks: [
    { name: 'the remote text was actually applied before the flush', assert: (x, a) => { a.equal(x.remoteApplied, 'remote-only-text') } },
    { name: 'the remote delta does not generate a local echo operation', assert: (x, a) => { a.equal(x.afterOps, x.beforeOps, 'ops ' + x.beforeOps + ' -> ' + x.afterOps) } }
  ]
}, {
  id: 'R08-exit-second-edit-during-pending-flush',
  name: 'actual Edit exit durably hands off a second local edit while the first flush awaits its ACK',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const editor = await f.mountEditor('exit-schedule-A')
    const mm = editor.component.mindMap, data = f.tree(8)
    await f.waitRender(mm, () => mm.setData(data))
    const v2 = await f.connectV2(mm, data, 'exit-schedule-A'), co = v2.co
    const socket = v2.socket
    const originalEmit = socket.emit.bind(socket)
    const held = []
    const hold = true
    socket.emit = function (event, payload, callback) {
      if (hold && (event === 'op' || event === 'op:batch')) { held.push({ event, payload, callback }); return socket }
      return originalEmit(event, payload, callback)
    }
    const outboxWrites = []
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox' && value.roomKey === 'exit-schedule-A') {
        outboxWrites.push({ opId: value.opId, text: value.payload && value.payload.text, status: value.status || 'pending' })
      }
      return originalPut.call(this, value, key)
    }
    const readOutbox = () => new Promise((resolve, reject) => {
      const open = indexedDB.open('mind-map-collab-v2', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('outbox', 'readonly'), req = tx.objectStore('outbox').getAll()
        req.onerror = () => reject(req.error)
        req.onsuccess = () => { const rows = req.result || []; tx.oncomplete = () => { db.close(); resolve(rows.filter(r => r.roomKey === 'exit-schedule-A').map(r => ({ opId: r.opId, status: r.status, text: r.payload && r.payload.text }))) } }
      }
    })
    let result
    try {
      co.suppressLocalUntil = Date.now() + 10000
      mm.execCommand('SET_NODE_TEXT', mm.renderer.findNodeByUid('n0'), 'first-edit')
      await co.flushHttpText()
      await f.pause(30)
      const firstHeld = held.length
      const firstFlushPending = !!co.httpTextFlushPromise
      const secondNode = mm.renderer.findNodeByUid('n1')
      mm.execCommand('SET_NODE_TEXT', secondNode, 'second-edit')
      const secondModelText = secondNode.getData('text')
      const secondPendingDelta = !!co.nodePatchPayload(secondNode, { onlyChanged: true })
      await f.pause(30)
      // Actual Edit exit while the first ACK is still held.
      f.unmount(editor)
      await f.pause(150)
      const rowsAtExit = await readOutbox()
      // Only now allow the transport to settle.
      for (const item of held.splice(0)) originalEmit(item.event, item.payload, item.callback)
      await f.pause(150)
      const rowsAfterTeardown = await readOutbox()
      result = { firstHeld, firstFlushPending, secondModelText, secondPendingDelta, outboxWrites, rowsAtExit, rowsAfterTeardown }
    } finally { IDBObjectStore.prototype.put = originalPut; await v2.adapter.disconnect() }
    return result
  }),
  checks: [
    { name: 'the first flush was withheld at an ACK boundary', assert: (x, a) => { a.ok(x.firstHeld >= 1, 'held=' + x.firstHeld); a.equal(x.firstFlushPending, true) } },
    { name: 'the second edit reached the model with an unsynced delta before exit', assert: (x, a) => { a.equal(x.secondModelText, 'second-edit'); a.equal(x.secondPendingDelta, true) } },
    { name: 'the latest edit is durably queued at actual exit, never only a draft', assert: (x, a) => { a.ok(x.rowsAtExit.some(r => String(r.text).includes('second-edit')), 'rowsAtExit=' + JSON.stringify(x.rowsAtExit).slice(0, 400)) } },
    { name: 'the latest edit stays durable after the transport settles', assert: (x, a) => { a.ok(x.rowsAfterTeardown.some(r => String(r.text).includes('second-edit')), 'rowsAfter=' + JSON.stringify(x.rowsAfterTeardown).slice(0, 400)) } }
  ]
}, {
  id: 'R08-exit-second-edit-same-uid-during-pending-flush',
  name: 'actual Edit exit overwrites the same uid with only the latest delta while the first flush awaits its ACK',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const editor = await f.mountEditor('exit-schedule-B')
    const mm = editor.component.mindMap, data = f.tree(8)
    await f.waitRender(mm, () => mm.setData(data))
    const v2 = await f.connectV2(mm, data, 'exit-schedule-B'), co = v2.co
    const socket = v2.socket
    const originalEmit = socket.emit.bind(socket)
    const held = []
    const hold = true
    socket.emit = function (event, payload, callback) {
      if (hold && (event === 'op' || event === 'op:batch')) { held.push({ event, payload, callback }); return socket }
      return originalEmit(event, payload, callback)
    }
    const outboxWrites = []
    const txCompletions = []
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox' && value.roomKey === 'exit-schedule-B') {
        outboxWrites.push({ opId: value.opId, text: value.payload && value.payload.text, status: value.status || 'pending' })
        this.transaction.addEventListener('complete', () => txCompletions.push(value.opId))
      }
      return originalPut.call(this, value, key)
    }
    const readOutbox = () => new Promise((resolve, reject) => {
      const open = indexedDB.open('mind-map-collab-v2', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('outbox', 'readonly'), req = tx.objectStore('outbox').getAll()
        req.onerror = () => reject(req.error)
        req.onsuccess = () => { const rows = req.result || []; tx.oncomplete = () => { db.close(); resolve(rows.filter(r => r.roomKey === 'exit-schedule-B').map(r => ({ opId: r.opId, status: r.status, text: r.payload && r.payload.text }))) } }
      }
    })
    let result
    try {
      co.suppressLocalUntil = Date.now() + 10000
      const node = mm.renderer.findNodeByUid('n0')
      mm.execCommand('SET_NODE_TEXT', node, 'first-edit')
      await co.flushHttpText()
      await f.pause(30)
      const firstHeld = held.length
      mm.execCommand('SET_NODE_TEXT', node, 'second-edit')
      const secondModelText = node.getData('text')
      const secondPendingDelta = !!co.nodePatchPayload(node, { onlyChanged: true })
      await f.pause(30)
      f.unmount(editor)
      await f.pause(150)
      const rowsAtExit = await readOutbox()
      for (const item of held.splice(0)) originalEmit(item.event, item.payload, item.callback)
      await f.pause(500)
      const rowsAfterTeardown = await readOutbox()
      const server = await f.requestMemory('state', { roomKey: 'exit-schedule-B' })
      result = { firstHeld, secondModelText, secondPendingDelta, outboxWrites, txCompletions, rowsAtExit, rowsAfterTeardown,
        serverText: server.nodes && server.nodes.n0 && server.nodes.n0.data && server.nodes.n0.data.text }
    } finally { IDBObjectStore.prototype.put = originalPut; await v2.adapter.disconnect() }
    return result
  }),
  checks: [
    { name: 'the first flush was withheld at an ACK boundary', assert: (x, a) => { a.ok(x.firstHeld >= 1) } },
    { name: 'the same-uid second edit reached the model with an unsynced delta', assert: (x, a) => { a.equal(x.secondModelText, 'second-edit'); a.equal(x.secondPendingDelta, true) } },
    { name: 'the latest same-uid delta is durably queued at exit and its IDB transaction completes', assert: (x, a) => {
      const latest = x.rowsAtExit.filter(r => String(r.text).includes('second-edit'))
      a.equal(latest.length, 1, 'rowsAtExit=' + JSON.stringify(x.rowsAtExit))
      a.ok(x.txCompletions.includes(latest[0].opId), 'tx completions=' + JSON.stringify(x.txCompletions)) } },
    { name: 'only the latest same-uid content is durable, and the server either ends at it or retains it in the outbox', assert: (x, a) => {
      const durable = x.rowsAfterTeardown.some(r => String(r.text).includes('second-edit'))
      const acked = String(x.serverText).includes('second-edit')
      a.ok(durable || acked, 'neither durable nor acked: rows=' + JSON.stringify(x.rowsAfterTeardown).slice(0, 300) + ' server=' + x.serverText)
      a.ok(!x.outboxWrites.some(w => String(w.text).includes('second-edit') && w.opId === x.outboxWrites[0].opId), 'latest reused the first payload/opId') } }
  ]
}, {
  id: 'R08-exit-second-edit-same-uid-active-during-pending-flush',
  name: 'an active same-uid node is not re-submitted unchanged on exit while its first payload is in flight',
  observe: page => page.evaluate(async () => {
    const f = window.perfFrontend
    const editor = await f.mountEditor('exit-schedule-C')
    const mm = editor.component.mindMap, data = f.tree(8)
    await f.waitRender(mm, () => mm.setData(data))
    const v2 = await f.connectV2(mm, data, 'exit-schedule-C'), co = v2.co
    const socket = v2.socket
    const originalEmit = socket.emit.bind(socket)
    const held = []
    const hold = true
    socket.emit = function (event, payload, callback) {
      if (hold && (event === 'op' || event === 'op:batch')) { held.push({ event, payload, callback }); return socket }
      return originalEmit(event, payload, callback)
    }
    const outboxWrites = []
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox' && value.roomKey === 'exit-schedule-C') {
        outboxWrites.push({ opId: value.opId, text: value.payload && value.payload.text, status: value.status || 'pending' })
      }
      return originalPut.call(this, value, key)
    }
    const readOutbox = () => new Promise((resolve, reject) => {
      const open = indexedDB.open('mind-map-collab-v2', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('outbox', 'readonly'), req = tx.objectStore('outbox').getAll()
        req.onerror = () => reject(req.error)
        req.onsuccess = () => { const rows = req.result || []; tx.oncomplete = () => { db.close(); resolve(rows.filter(r => r.roomKey === 'exit-schedule-C').map(r => ({ opId: r.opId, status: r.status, text: r.payload && r.payload.text }))) } }
      }
    })
    let result
    try {
      const node = mm.renderer.findNodeByUid('n0')
      // The first in-flight node is the current selection.
      if (typeof mm.renderer.activeMultiNode === 'function') mm.renderer.activeMultiNode([node])
      const activeUids = (mm.renderer.activeNodeList || []).map(n => n.getData('uid'))
      co.suppressLocalUntil = Date.now() + 10000
      mm.execCommand('SET_NODE_TEXT', node, 'first-edit')
      await co.flushHttpText()
      await f.pause(30)
      const firstHeld = held.length
      mm.execCommand('SET_NODE_TEXT', node, 'second-edit')
      await f.pause(30)
      f.unmount(editor)
      await f.pause(150)
      const rowsAtExit = await readOutbox()
      for (const item of held.splice(0)) originalEmit(item.event, item.payload, item.callback)
      await f.pause(400)
      const rowsAfterTeardown = await readOutbox()
      const firstPayloadSends = outboxWrites.filter(w => String(w.text).includes('first-edit'))
      const firstOpIds = Array.from(new Set(firstPayloadSends.map(w => w.opId)))
      result = { activeUids, firstHeld, rowsAtExit, rowsAfterTeardown, firstOpIds }
    } finally { IDBObjectStore.prototype.put = originalPut; await v2.adapter.disconnect() }
    return result
  }),
  checks: [
    { name: 'the first in-flight node is the active selection', assert: (x, a) => { a.ok(x.activeUids.includes('n0')) } },
    { name: 'the unchanged first in-flight payload is not submitted again', assert: (x, a) => { a.equal(x.firstOpIds.length, 1, 'first opIds=' + JSON.stringify(x.firstOpIds)) } },
    { name: 'the latest same-uid edit is durably queued at exit', assert: (x, a) => { a.ok(x.rowsAtExit.some(r => String(r.text).includes('second-edit')), 'rowsAtExit=' + JSON.stringify(x.rowsAtExit)) } }
  ]
}])
