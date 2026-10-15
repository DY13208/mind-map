'use strict'
const { runCases } = require('./frontend-runner.cjs')

// Deterministic RED: a local pending edit is dropped inside a real full-render window.
//
// Source chain (reviewer-confirmed): Render._render emits node_tree_render_start,
// then sets renderer.root = null and clears nodeCache for the sliced layout
// (LogicalStructure still asyncRun setTimeout(0) with openPerformance false);
// the layout callback later assigns root/index. During that window
// renderer.findNodeByUid(uid) is undefined. Cooperate.collectNodesWithPendingText
// DELETES every pending uid whose node is not found, so a REAL flush
// (flushHttpTextNow) landing in the window drops the local edit before it is sent.
// onNodeTreeRenderEnd only handles presence and does not re-flush pending text.
//
// The scenario hooks the REAL product flush and calls it during the real window.
async function scenario () {
  const f = window.perfFrontend
  const editor = await f.mountEditor()
  const mm = editor.component.mindMap
  mm.updateConfig({ openPerformance: false, compactLayout: false })
  const data = f.tree(200)
  await f.waitRender(mm, () => mm.setData(data))
  const v2 = await f.connectV2(mm, data)
  const co = v2.co
  const renderer = mm.renderer
  const uid = 'root'
  const sent = []
  const flushes = []
  const originalSubmit = v2.adapter.submitOperation.bind(v2.adapter)
  v2.adapter.submitOperation = async op => {
    sent.push({ type: op && op.type, uid: op && op.payload && op.payload.uid, text: op && op.payload && op.payload.text })
    return originalSubmit(op)
  }
  const originalFlush = co.flushHttpTextNow.bind(co)
  co.flushHttpTextNow = async (...args) => {
    const before = Array.from(co._pendingTextUids || [])
    const sample = { rendering: renderer.isRendering, rootMissing: !renderer.root,
      nodeMissing: !renderer.findNodeByUid(uid), before, sentBefore: sent.length }
    const result = await originalFlush(...args)
    sample.after = Array.from(co._pendingTextUids || [])
    sample.sentOps = sent.slice(sample.sentBefore)
    flushes.push(sample)
    return result
  }
  await f.pause(50)
  mm.execCommand('SET_NODE_TEXT', renderer.findNodeByUid(uid), '<p>Pending window edit</p>')
  const pendingAfterEdit = Array.from(co._pendingTextUids || [])
  let windowObserved = null
  const onStart = () => {
    // The emit precedes root = null; observe and flush in the real root-null phase.
    Promise.resolve().then(async () => {
      if (windowObserved || renderer.root) return
      windowObserved = { rendering: renderer.isRendering, rootMissing: !renderer.root,
        nodeMissing: !renderer.findNodeByUid(uid) }
      await co.flushHttpTextNow().catch(() => {})
    })
  }
  mm.on('node_tree_render_start', onStart)
  try {
    mm.render()
    const windowDeadline = Date.now() + 20000
    while (!windowObserved && Date.now() < windowDeadline) await f.pause(5)
    await f.pause(20)
    const settleDeadline = Date.now() + 20000
    while ((renderer.isRendering || renderer.renderTimer) && Date.now() < settleDeadline) await f.pause(10)
    // The next real flush, after the render completed, must deliver the edit.
    await co.flushHttpTextNow().catch(() => {})
    await f.pause(50)
    return { pendingAfterEdit, windowObserved, flushes, sent, pendingAfterFlush: Array.from(co._pendingTextUids || []) }
  } finally {
    mm.off('node_tree_render_start', onStart)
    co.flushHttpTextNow = originalFlush
    try { f.unmount(editor) } catch (_) {}
    try { await v2.adapter.disconnect() } catch (_) {}
  }
}

runCases('cooperate-pending-text-window', [
  { id: 'R23-pending-text-window', name: 'a local pending edit survives a real full-render flush window and is still delivered',
    observe: page => page.evaluate(scenario), checks: [
      { name: 'the local edit is registered as pending text', assert: (x, a) => a.deepEqual(x.pendingAfterEdit, ['root']) },
      { name: 'a real flush ran inside the real full-render window with the node missing', assert: (x, a) => {
        a.equal(x.windowObserved && x.windowObserved.rendering, true)
        a.equal(x.windowObserved && x.windowObserved.rootMissing, true)
        a.equal(x.windowObserved && x.windowObserved.nodeMissing, true)
        a.ok(x.flushes.some(flush => flush.rendering && flush.nodeMissing && flush.before.includes('root')), JSON.stringify(x.flushes))
      } },
      { name: 'that real flush must not drop the pending uid', assert: (x, a) => {
        const windowFlush = x.flushes.find(flush => flush.nodeMissing && flush.before.includes('root'))
        a.ok(windowFlush, 'window flush was not captured')
        a.deepEqual(windowFlush.after, ['root'])
      } },
      { name: 'the retained edit is delivered by the next flush after the render completes', assert: (x, a) => a.ok(
        x.sent.some(op => op.uid === 'root' && /Pending window edit/.test(op.text || '')), JSON.stringify(x.sent)) }
    ] }
])
