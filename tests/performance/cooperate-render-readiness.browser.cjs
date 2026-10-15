'use strict'
const { runCases } = require('./frontend-runner.cjs')

// Same node.updated shape as the real PG/socket failed event. This narrower
// browser regression uses actual Edit, adapter, Cooperate and async layout;
// MemoryEngine transport is the existing controlled auth/transport boundary.
// It generates no synthetic ACK and is not a full-App/PG acceptance matrix.
async function scenario({ mode }) {
  const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
  editor.component.addRichTextPlugin()
  mm.updateConfig({ openPerformance: true, compactLayout: false })
  const data = f.tree(6000)
  Object.assign(data.data, { text: '<p>Update-0023</p>', richText: true, fontFamily: 'monospace', __fv: { text: 23 } })
  await f.waitRender(mm, () => mm.setData(data))
  const readyDeadline = Date.now() + 30000
  while (!mm.renderer.root || mm.renderer.isRendering || Object.keys(mm.renderer.nodeCache).length !== 6001) {
    if (Date.now() > readyDeadline) throw new Error('actual 6001-node model did not become ready')
    await f.pause(10)
  }
  const v2 = await f.connectV2(mm, data), co = v2.co
  // Public adapter initial revision represents the already loaded snapshot.
  // The operation itself is delivered through actual applyRemoteOperation.
  v2.adapter.setLastServerRevision(23)
  await f.pause(350)
  let applyError = null
  if (mode === 'timeout') mm.updateConfig({ collabOperationTimeoutMs: 1 })
  const notices = [], trace = [], renderer = mm.renderer, retiredTree = renderer.renderTree, container = mm.el
  const snapshot = name => {
    const root = renderer.root
    trace.push({ name, rootAvailable: !!root, rendering: renderer.isRendering,
      generation: renderer._renderGeneration, rootText: root && root.getData('text'),
      treeText: renderer.renderTree && renderer.renderTree.data.text,
      revision: v2.adapter.getStatus().lastServerRevision })
  }
  const notice = (tree, change) => {
    if (change && change.source === 'remote') notices.push(tree.data.text)
  }
  mm.on('data_change', notice)
  const originalUpdate = co.applyV2PayloadUpdate
  co.applyV2PayloadUpdate = function (...args) {
    snapshot('apply-update-enter')
    const result = originalUpdate.apply(this, args)
    snapshot('apply-update-return-' + result)
    return result
  }
  const operation = revision => {
    const text = '<p>Update-' + String(revision).padStart(4, '0') + '</p>'
    const payload = { uid: 'root', text, patch: { text }, data: { uid: 'root', text,
      richText: true, fontFamily: 'monospace', __fv: { text: revision } } }
    return { opId: 'renderer-readiness-' + revision, roomKey: v2.roomKey,
      clientId: mode === 'replay-replace' ? v2.adapter.getClientId() : 'different-remote-client', type: 'node.updated', serverRevision: revision,
      event: { type: 'node.updated', payload, version: revision, affectedUids: ['root'] }, payload }
  }
  let entered, pendingFirst, pendingNewer, firstResolved = false, destroyed = false
  let completeLayout, rejectLayout
  const layoutFinished = new Promise((resolve, reject) => { completeLayout = resolve; rejectLayout = reject })
  const endTimer = setTimeout(() => rejectLayout(new Error('real layout completion timeout')), 30000)
  const onEnd = metadata => {
    if (!entered || (metadata && ['view', 'export'].includes(metadata.reason))) return
    if (renderer.isRendering || !renderer.root) return
    snapshot('layout-end')
    // Deliver newer op synchronously in the real end event, before the older
    // layout-wait Promise resumes. A naive wait without FIFO would rewind 25→24.
    if (mode === 'fifo' && !pendingNewer) pendingNewer = co.applyV2RemoteOperation(operation(25))
    completeLayout()
  }
  const onStart = () => {
    if (entered) return
    // Render emits start before assigning root=null, then begins its actual
    // sliced layout. A microtask observes that real phase without replacing
    // the renderer, forcing private fields, or stubbing a layout algorithm.
    Promise.resolve().then(() => {
      if (entered || renderer.root || !renderer.isRendering) return
      entered = { rootMissing: !renderer.root, rendering: renderer.isRendering, loadedNodes: Object.keys(renderer.lastNodeCache).length }
      snapshot('layout-start-before-remote')
      const apply = ['single', 'timeout', 'replace-old', 'update-old'].includes(mode) ? v2.adapter.applyRemoteOperation(operation(24)) : co.applyV2RemoteOperation(operation(24), mode === 'replay-replace' ? { applySelf: true, fromOutbox: true } : {})
      pendingFirst = Promise.resolve(apply).then(value => { firstResolved = true; snapshot('first-remote-resolved'); return value }, error => { applyError = { code: error.code, message: error.message }; firstResolved = true; return false })
      if (mode === 'dispose') Promise.resolve().then(() => { snapshot('before-dispose'); f.unmount(editor); destroyed = true; completeLayout() })
      if (['replace', 'replace-old', 'update-old', 'replay-replace'].includes(mode)) Promise.resolve().then(() => {
        const newer = f.tree(6000)
        Object.assign(newer.data, { text: '<p>Snapshot-0026</p>', richText: true, fontFamily: 'monospace', __fv: { text: 26 } })
        // Actual snapshot setter and public authoritative revision handoff;
        // neither a fabricated ACK nor a direct private root assignment.
        if (!['replace','replay-replace'].includes(mode)) newer.data.text = '<p>Update-0023</p>'
        if (mode === 'update-old') mm.updateData(newer)
        else mm.setData(newer)
        co.resyncHttpBaseline(newer)
        v2.adapter.setLastServerRevision(['replace','replay-replace'].includes(mode) ? 26 : 23)
      })
    }).catch(rejectLayout)
  }
  mm.on('node_tree_render_end', onEnd); mm.on('node_tree_render_start', onStart)
  try {
    co.scheduleRemoteGeometryRender()
    await layoutFinished
    if (!pendingFirst) throw new Error('real remote apply was not delivered')
    await pendingFirst
    if (pendingNewer) await pendingNewer
    const settleDeadline = Date.now() + 30000
    while (!destroyed && (!renderer.root || renderer.isRendering || co._remoteGeometryTimer)) {
      if (Date.now() > settleDeadline) throw new Error('actual remote geometry did not settle')
      await f.pause(20)
    }
    await f.pause(30)
    const root = renderer.root, textNode = root && root._textData && root._textData.node && root._textData.node.node
    return { mode, entered, firstResolved, applyError, notices, trace, disposed: co._disposed,
      rawText: renderer.renderTree && renderer.renderTree.data.text,
      currentText: root && root.getData('text'),
      visibleText: textNode && textNode.textContent, visibleConnected: !!(textNode && textNode.isConnected),
      revision: v2.adapter.getStatus().lastServerRevision,
      currentLookup: root ? renderer.findNodeByUid('root') === root : false,
      modelCount: Object.keys(renderer.nodeCache).length,
      retiredText: retiredTree.data.text, oldCanvasEmpty: container.querySelectorAll('.smm-node').length === 0,
      oldCanvasDetached: !container.isConnected,
      waitingCount: co._v2RendererWaiters ? co._v2RendererWaiters.size : 0 }
  } finally {
    clearTimeout(endTimer)
    mm.off('node_tree_render_end', onEnd); mm.off('node_tree_render_start', onStart); mm.off('data_change', notice)
    co.applyV2PayloadUpdate = originalUpdate
    if (!destroyed) f.unmount(editor)
    await v2.adapter.disconnect()
  }
}

async function insertScenario({ replace }) {
  const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
  const data = f.tree(1000)
  mm.updateConfig({ openPerformance: true, compactLayout: false })
  await f.waitRender(mm, () => mm.setData(data))
  const v2 = await f.connectV2(mm, data), co = v2.co, r = mm.renderer, notices = []
  v2.adapter.setLastServerRevision(23)
  const listener = (tree, change) => { if (change && change.source === 'remote') notices.push({ added: (change.added || []).map(node => node.tree.data.uid), nodes: (change.nodes || []).map(node => node.tree.data.uid) }) }
  mm.on('data_change', listener)
  const op = (type, version, payload) => ({ opId: 'insert-burst-' + version, roomKey: v2.roomKey, clientId: 'remote-peer', type, serverRevision: version, event: { type, payload, version }, payload })
  try {
    await v2.adapter.applyRemoteOperation(op('node.inserted', 24, { uid: 'remote-new', parentUid: 'root', index: 0, data: { uid: 'remote-new', text: 'Inserted' } }))
    const entered = { rootAvailable: !!r.root, rendering: r.isRendering, pendingRender: !!r.renderTimer, uidAvailable: !!r.findNodeByUid('remote-new') }
    if (replace) {
      const next = f.tree(1000)
      await f.waitRender(mm, () => mm.setData(next))
      co.resyncHttpBaseline(next)
    } else await v2.adapter.applyRemoteOperation(op('node.updated', 25, { uid: 'remote-new', patch: { text: 'Updated after insert' }, text: 'Updated after insert' }))
    const deadline = Date.now() + 30000
    while (!r.root || r.isRendering || r.renderTimer || co._remoteGeometryTimer) {
      if (Date.now() > deadline) throw new Error('insert burst did not settle')
      await f.pause(10)
    }
    await f.pause(20)
    const node = r.findNodeByUid('remote-new'), raw = r.renderTree.children.find(child => child.data.uid === 'remote-new')
    return { entered, notices, revision: v2.adapter.getStatus().lastServerRevision, nodeText: node && node.getData('text'), rawText: raw && raw.data.text, waitingCount: co._v2RendererWaiters ? co._v2RendererWaiters.size : 0 }
  } finally { mm.off('data_change', listener); f.unmount(editor); await v2.adapter.disconnect() }
}

runCases('cooperate-render-readiness', [
  { id: 'R07-render-readiness', name: 'real adapter remote event during async layout reaches current model and DOM before head acknowledgment',
    observe: page => page.evaluate(scenario, { mode: 'single' }), checks: [
      { name: 'delivered in an actual root-null 6001-node layout window', assert: (x,a) => { a.equal(x.entered.rootMissing,true); a.equal(x.entered.rendering,true); a.equal(x.entered.loadedNodes,6001); a.equal(x.firstResolved,true) } },
      { name: 'adapter head24 also has raw/current/visible update24', assert: (x,a) => { a.equal(x.revision,24); a.equal(x.rawText,'<p>Update-0024</p>'); a.equal(x.currentText,x.rawText); a.equal(x.visibleText,'Update-0024'); a.equal(x.visibleConnected,true); a.equal(x.currentLookup,true); a.equal(x.modelCount,6001) } },
      { name: 'remote content consumer sees the applied delta once', assert: (x,a) => a.deepEqual(x.notices,['<p>Update-0024</p>']) }
    ] },
  { id: 'R07-remote-fifo', name: 'newer event delivered at actual layout-end cannot overtake older blocked event',
    observe: page => page.evaluate(scenario, { mode: 'fifo' }), checks: [
      { name: 'both actual remote deltas apply FIFO without rewind', assert: (x,a) => { a.deepEqual(x.notices,['<p>Update-0024</p>','<p>Update-0025</p>']); a.equal(x.rawText,'<p>Update-0025</p>'); a.equal(x.currentText,x.rawText); a.equal(x.visibleText,'Update-0025'); a.equal(x.visibleConnected,true) } }
    ] },
  { id: 'R06-remote-dispose', name: 'disposing real editor during blocked remote apply settles without retired data or DOM revival',
    observe: page => page.evaluate(scenario, { mode: 'dispose' }), checks: [
      { name: 'disposed waiter finishes and releases its own callbacks', assert: (x,a) => { a.equal(x.firstResolved,true); a.equal(x.disposed,true); a.equal(x.waitingCount,0) } },
      { name: 'retired tree and detached empty canvas remain unchanged', assert: (x,a) => { a.equal(x.retiredText,'<p>Update-0023</p>'); a.equal(x.oldCanvasEmpty,true); a.equal(x.oldCanvasDetached,true); a.deepEqual(x.notices,[]) } }
    ] }
  ,{ id: 'R22-remote-snapshot', name: 'new authoritative snapshot cancels older renderer-waiting event without rewinding data or head',
    observe: page => page.evaluate(scenario, { mode: 'replace' }), checks: [
      { name: 'actual snapshot26 remains authoritative after old24 settles', assert: (x,a) => { a.equal(x.firstResolved,true); a.equal(x.revision,26); a.equal(x.rawText,'<p>Snapshot-0026</p>'); a.equal(x.currentText,x.rawText); a.equal(x.visibleText,'Snapshot-0026'); a.equal(x.visibleConnected,true); a.equal(x.currentLookup,true); a.equal(x.modelCount,6001); a.equal(x.waitingCount,0); a.deepEqual(x.notices,[]) } }
    ] }
  ,{ id: 'R22-replay-snapshot', name: 'same-client durable replay awaiting actual layout cannot overwrite newer authoritative snapshot',
    observe: page => page.evaluate(scenario, { mode: 'replay-replace' }), checks: [
      { name: 'applySelf replay24 still preserves actual snapshot26 model and DOM', assert: (x,a) => { a.equal(x.entered.rootMissing,true); a.equal(x.firstResolved,true); a.equal(x.revision,26); a.equal(x.rawText,'<p>Snapshot-0026</p>'); a.equal(x.currentText,x.rawText); a.equal(x.visibleText,'Snapshot-0026'); a.equal(x.currentLookup,true); a.equal(x.waitingCount,0); a.deepEqual(x.notices,[]) } }
    ] }

  ,...['replace-old', 'update-old', 'timeout'].map(mode => ({
    id: 'R07-remote-' + mode, name: 'blocked remote24 survives actual ' + mode + ' until current model is ready',
    observe: page => page.evaluate(scenario, { mode }), checks: [
      { name: 'actual adapter revision and current/raw/visible24 agree', assert: (x,a) => { a.equal(x.entered.rootMissing,true); a.equal(x.firstResolved,true); a.equal(x.applyError,null); a.equal(x.revision,24); a.equal(x.rawText,'<p>Update-0024</p>'); a.equal(x.currentText,x.rawText); a.equal(x.visibleText,'Update-0024'); a.equal(x.waitingCount,0); a.deepEqual(x.notices,['<p>Update-0024</p>']) } }
    ]
  }))
  ,{ id: 'R07-remote-insert-burst', name: 'actual scheduled layout admits inserted UID before following remote update',
    observe: page => page.evaluate(insertScenario, { replace: false }), checks: [
      { name: 'remote25 reaches newly inserted current model and delta consumers', assert: (x,a) => { a.equal(x.entered.rootAvailable,true); a.equal(x.entered.rendering,false); a.equal(x.entered.pendingRender,true); a.equal(x.entered.uidAvailable,false); a.equal(x.revision,25); a.equal(x.nodeText,'Updated after insert'); a.equal(x.rawText,x.nodeText); a.equal(x.waitingCount,0); a.deepEqual(x.notices,[{ added:['remote-new'], nodes:[] },{ added:[], nodes:['remote-new'] }]) } }
    ] }
  ,{ id: 'R06-remote-insert-notify-reset', name: 'same-room tree replacement releases pending insert notification without empty or retired delta',
    observe: page => page.evaluate(insertScenario, { replace: true }), checks: [
      { name: 'replacement has no old insertion or empty delayed delta', assert: (x,a) => { a.equal(x.entered.pendingRender,true); a.equal(x.nodeText,undefined); a.equal(x.rawText,undefined); a.equal(x.waitingCount,0); a.deepEqual(x.notices,[]) } }
    ] }

])
