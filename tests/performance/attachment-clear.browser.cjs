'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('attachment-clear', [false, true].map(v2 => ({
  id: v2 ? 'R09-attachment-ui-clear-v2' : 'R09-attachment-ui-clear-native',
  name: 'actual high-level attachment clear command removes visible root icon and undo/redo preserves metadata (' + (v2 ? 'V2' : 'native') + ')',
  observe: page => page.evaluate(async v2 => {
    const f = window.perfFrontend, fields = ['attachmentUrl', 'attachmentName', 'attachmentId', 'attachmentMimeType', 'attachmentStatus']
    const attachment = { attachmentUrl: '/metadata-only.pdf', attachmentName: 'Metadata only.pdf',
      attachmentId: 'metadata-only-attachment', attachmentMimeType: 'application/pdf', attachmentStatus: 'ready' }
    const data = f.tree(24, { customLeft: 450, customTop: 300, ...attachment })
    const mm = await f.createEngine(data, { fit: false, openPerformance: true })
    const connection = v2 ? await f.connectV2(mm, data) : null
    await f.pause(100)
    const inspect = () => {
      const node = mm.renderer.findNodeByUid('root'), raw = node.nodeData.data
      const icon = node.group?.node.querySelector('.smm-attachment-icon')
      const bounds = node.group?.node.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
      return { values: Object.fromEntries(fields.map(k => [k, raw[k] == null ? null : raw[k]])),
        emptyKeysPresent: fields.every(k => Object.prototype.hasOwnProperty.call(raw, k) && (raw[k] === null || raw[k] === '')),
        groupConnected: !!node.group?.node.isConnected, visible: !!bounds && bounds.right >= canvas.left && bounds.left <= canvas.right && bounds.bottom >= canvas.top && bounds.top <= canvas.bottom,
        iconConnected: !!icon?.isConnected, cachedIconConnected: !!node._attachmentData?.node.node.isConnected,
        isRendering: mm.renderer.isRendering, renderTimer: !!mm.renderer.renderTimer, hasWaitRendering: !!mm.renderer.hasWaitRendering }
    }
    const initial = inspect(), copies = f.spy(mm.command, 'getCopyData'), renders = f.spy(mm.renderer.root, 'reRender')
    const stringify = JSON.stringify
    let fullSerializations = 0
    JSON.stringify = function(value, ...args) { if (value?.data?.uid === 'root' && Array.isArray(value.children)) fullSerializations++; return stringify.call(this, value, ...args) }
    let cleared, undo, redo, undoAfterRedo, serverClear = null, clearOperations = null, workAfterClear, workAfterHistory
    try {
      // The production attachment UI uses this high-level command for pointer
      // removal. SET_NODE_DATA intentionally only changes raw node data.
      mm.execCommand('SET_NODE_ATTACHMENT', mm.renderer.root, '', '', {
        attachmentId: '', attachmentMimeType: '', attachmentStatus: '',
        attachmentError: '', attachmentExtractedText: '', attachmentProgress: 0
      })
      await f.pause(400)
      if (v2) {
        const deadline = Date.now() + 5000
        while (true) {
          const server = await f.requestMemory('state', { roomKey: connection.roomKey })
          if (server.operations.length && !connection.adapter.getStatus().pendingCount && !connection.co.httpTextFlushPromise && !connection.co.httpTextTimer) {
            serverClear = server.nodes.root.data; clearOperations = server.operations.length; break
          }
          if (Date.now() > deadline) throw new Error('actual scheduled V2 clear did not settle')
          await f.pause(20)
        }
      }
      cleared = inspect()
      workAfterClear = { copies: copies.calls.length, fullSerializations, reRenders: renders.calls.length }
      if (v2) { mm.execCommand('BACK'); await connection.co._v2HistoryQueue; await f.pause(200) }
      else { await f.waitRender(mm, () => mm.execCommand('BACK')); await f.pause(50) }
      undo = inspect()
      if (v2) { mm.execCommand('FORWARD'); await connection.co._v2HistoryQueue; await f.pause(200) }
      else { await f.waitRender(mm, () => mm.execCommand('FORWARD')); await f.pause(50) }
      redo = inspect()
      workAfterHistory = { copies: copies.calls.length, fullSerializations }
      // Wait out the debounced notification window, then a single BACK must
      // restore the attachment. A phantom notification delta would otherwise
      // push a no-op undo step and leave the node cleared.
      await f.pause(700)
      if (v2) { mm.execCommand('BACK'); await connection.co._v2HistoryQueue; await f.pause(250) }
      else { await f.waitRender(mm, () => mm.execCommand('BACK')); await f.pause(50) }
      undoAfterRedo = inspect()
    } finally { JSON.stringify = stringify; copies.restore(); renders.restore() }
    if (v2) await connection.adapter.disconnect()
    mm.destroy()
    return { v2, attachment, initial, cleared, undo, redo, undoAfterRedo, clearOperations,
      serverCleared: !v2 || fields.every(k => serverClear[k] == null || serverClear[k] === ''), workAfterClear, workAfterHistory }
  }, v2),
  checks: [
    { name: 'fixture starts with an actual visible connected root attachment icon', assert: (x, a) => { a.equal(x.initial.groupConnected, true); a.equal(x.initial.visible, true); a.equal(x.initial.iconConnected, true); a.equal(x.initial.cachedIconConnected, true) } },
    { name: 'clear updates actual metadata and removes stale icon while renderer is idle', assert: (x, a) => { a.equal(x.serverCleared, true); a.equal(x.cleared.emptyKeysPresent, true); a.equal(x.cleared.groupConnected, true); a.equal(x.cleared.visible, true); a.equal(x.cleared.isRendering, false); a.equal(x.cleared.renderTimer, false); a.equal(x.cleared.hasWaitRendering, false); a.equal(x.cleared.iconConnected, false); a.equal(x.cleared.cachedIconConnected, false); if (x.v2) a.equal(x.clearOperations, 1) } },
    { name: 'real Undo restores metadata/icon and Redo removes them again', assert: (x, a) => { a.deepEqual(x.undo.values, x.attachment); a.equal(x.undo.iconConnected, true); a.ok(Object.values(x.redo.values).every(value => value === null || value === '')); a.equal(x.redo.iconConnected, false); a.equal(x.redo.cachedIconConnected, false) } },
    { name: 'one Undo after a settled Redo restores the attachment instead of an empty step', assert: (x, a) => { a.deepEqual(x.undoAfterRedo.values, x.attachment); a.equal(x.undoAfterRedo.iconConnected, true) } },
    { name: 'ordinary V2 clear and history never snapshot or serialize the loaded tree', assert: (x, a) => { if (x.v2) { a.equal(x.workAfterClear.copies, 0); a.equal(x.workAfterClear.fullSerializations, 0); a.equal(x.workAfterHistory.copies, 0); a.equal(x.workAfterHistory.fullSerializations, 0) } } }
  ]
})))
