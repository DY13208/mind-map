"use strict"
const { runCases } = require('./frontend-runner.cjs')

async function renderWindowScenario(mode) {
  const f = window.perfFrontend
  const editor = await f.mountEditor()
  const mm = editor.component.mindMap
  mm.updateConfig({ openPerformance: false, compactLayout: false })
  const data = f.tree(200)
  await f.waitRender(mm, () => mm.setData(data))
  const v2 = await f.connectV2(mm, data)
  const co = v2.co, renderer = mm.renderer
  const sent = [], flushes = []
  const originalSubmit = v2.adapter.submitOperation.bind(v2.adapter)
  v2.adapter.submitOperation = async op => {
    sent.push({ type: op.type, uid: op.payload && op.payload.uid, text: op.payload && op.payload.text, disposedAtSubmit: !!co._disposed })
    return originalSubmit(op)
  }
  const originalFlush = co.flushHttpTextNow.bind(co)
  co.flushHttpTextNow = async (...args) => {
    const sample = { rendering: renderer.isRendering, rootMissing: !renderer.root,
      before: Array.from(co._pendingTextUids || []), settling: co.httpSettlingAfterReplace || Date.now() < co.suppressLocalUntil }
    const result = await originalFlush(...args)
    sample.after = Array.from(co._pendingTextUids || [])
    flushes.push(sample)
    return result
  }
  let destroyed = false, windowFlush = null, ends = 0
  const hookErrors = []
  const onEnd = () => { ends++ }
  mm.on('node_tree_render_end', onEnd)
  await f.pause(50)
  if (mode === 'settle') {
    const reply = await f.requestMemory('emit', { event: 'op', payload: {
      opId: crypto.randomUUID(), roomKey: v2.roomKey, clientId: 'remote-settle-peer',
      type: 'node.update', payload: { uid: 'n0', text: 'Remote settle edit' }
    } })
    await v2.adapter.applyRemoteOperation(reply.operation)
  }
  mm.execCommand('SET_NODE_TEXT', renderer.findNodeByUid('root'), '<p>Automatic deferred edit</p>')
  const pendingAfterEdit = Array.from(co._pendingTextUids || [])
  const onStart = () => {
    Promise.resolve().then(async () => {
      if (windowFlush || renderer.root) return
      // Consume the edit's debounce, then run its actual product flush in the
      // real layout window. There is deliberately no manual post-render flush.
      clearTimeout(co.httpTextTimer)
      co.httpTextTimer = null
      windowFlush = { rendering: renderer.isRendering, rootMissing: !renderer.root }
      if (mode === 'cancel') renderer.cancelRender()
      await co.flushHttpTextNow()
      windowFlush.pending = Array.from(co._pendingTextUids || [])
      if (mode === 'destroy') { f.unmount(editor); destroyed = true }
    }).catch(error => hookErrors.push(error.stack || String(error)))
  }
  mm.on('node_tree_render_start', onStart)
  try {
    mm.render()
    const deadline = Date.now() + 10000
    while (!windowFlush || !windowFlush.pending) {
      if (hookErrors.length) throw new Error('render-window hook failed: ' + hookErrors.join('\n'))
      if (Date.now() > deadline) throw new Error('real render-window flush was not observed')
      await f.pause(5)
    }
    if (mode === 'cancel') {
      const beforeRestart = sent.length
      await f.pause(350)
      windowFlush.sentDuringCancelledIdle = sent.length - beforeRestart
      await f.waitRender(mm, () => mm.render())
    }
    if (mode !== 'destroy') {
      while (renderer.isRendering || renderer.renderTimer || renderer.hasWaitRendering) {
        if (Date.now() > deadline) throw new Error('real renderer did not settle')
        await f.pause(10)
      }
    }
    const sendDeadline = Date.now() + 1200
    while (mode !== 'destroy' && !sent.some(op => op.uid === 'root') && Date.now() < sendDeadline) await f.pause(10)
    // Another real completed render must not produce a duplicate operation.
    if (mode !== 'destroy') await f.waitRender(mm, () => mm.render())
    await f.pause(350)
    const canonical = await f.requestMemory('state', { roomKey: v2.roomKey })
    return { mode, hookErrors, pendingAfterEdit, windowFlush: structuredClone(windowFlush), flushes: structuredClone(flushes), sent: structuredClone(sent), ends,
      canonicalText: canonical.nodes.root.data.text,
      pending: Array.from(co._pendingTextUids || []),
      timerActive: !!co.httpTextTimer, disposed: !!co._disposed }
  } finally {
    mm.off('node_tree_render_start', onStart)
    mm.off('node_tree_render_end', onEnd)
    co.flushHttpTextNow = originalFlush
    try { if (!destroyed) f.unmount(editor) } finally { await v2.adapter.disconnect() }
  }
}

async function deletedScenario() {
  const f = window.perfFrontend
  const editor = await f.mountEditor(), mm = editor.component.mindMap
  const data = f.tree(4)
  await f.waitRender(mm, () => mm.setData(data))
  const v2 = await f.connectV2(mm, data), co = v2.co, renderer = mm.renderer
  const sent = [], originalSubmit = v2.adapter.submitOperation.bind(v2.adapter)
  v2.adapter.submitOperation = async op => {
    sent.push({ type: op.type, uid: op.payload && op.payload.uid })
    return originalSubmit(op)
  }
  try {
    await f.pause(50)
    const leaf = renderer.findNodeByUid('n0')
    mm.execCommand('SET_NODE_TEXT', leaf, 'Delete this pending leaf')
    clearTimeout(co.httpTextTimer); co.httpTextTimer = null
    await f.waitRender(mm, () => mm.execCommand('REMOVE_NODE', leaf))
    const before = Array.from(co._pendingTextUids || [])
    const missingReady = !renderer.findNodeByUid('n0') && !!renderer.root && !renderer.isRendering
    await co.flushHttpTextNow()
    await f.pause(350)
    return { before, missingReady, after: Array.from(co._pendingTextUids || []), sent, timerActive: !!co.httpTextTimer }
  } finally { try { f.unmount(editor) } finally { await v2.adapter.disconnect() } }
}

const retained = { name: 'the window preserves the real queued edit', assert: (x, a) => {
  a.deepEqual(x.hookErrors, [])
  a.deepEqual(x.pendingAfterEdit, ['root'])
  a.equal(x.windowFlush.rootMissing, true)
  a.equal(x.windowFlush.rendering, true)
  a.deepEqual(x.windowFlush.pending, ['root'])
} }
const delivered = { name: 'a real completed render automatically delivers exactly one canonical operation', assert: (x, a) => {
  a.ok(x.ends > 0)
  a.equal(x.sent.filter(op => op.uid === 'root' && op.type === 'node.update').length, 1, JSON.stringify(x.sent))
  a.equal(x.canonicalText, '<p>Automatic deferred edit</p>')
  a.equal(x.timerActive, false)
} }
runCases('cooperate-pending-text-lifecycle', [
  { id: 'R23-auto-after-render', name: 'a consumed flush in a real layout window retries automatically after render completion',
    observe: page => page.evaluate(renderWindowScenario, 'auto'), checks: [retained, delivered] },
  { id: 'R23-auto-during-remote-settle', name: 'an explicitly queued local edit during the actual remote settle window retries after render completion',
    observe: page => page.evaluate(renderWindowScenario, 'settle'), checks: [retained, delivered,
      { name: 'the window flush actually used the post-remote settling collector', assert: (x, a) => a.ok(x.flushes.some(flush => flush.rootMissing && flush.settling)) }] },
  { id: 'R23-cancel-then-render', name: 'cancelled layout keeps pending intent without spinning and a later real render delivers it',
    observe: page => page.evaluate(renderWindowScenario, 'cancel'), checks: [retained, delivered,
      { name: 'cancelled idle does not schedule a repeating flush', assert: (x, a) => a.equal(x.windowFlush.sentDuringCancelledIdle, 0) }] },
  { id: 'R23-destroy-in-window', name: 'destroy clears pending state and no render-deferred operation runs afterward',
    observe: page => page.evaluate(renderWindowScenario, 'destroy'), checks: [
      { name: 'the real render window was entered', assert: (x, a) => a.equal(x.windowFlush.rootMissing, true) },
      { name: 'teardown leaves no pending timer or late send', assert: (x, a) => {
        a.equal(x.disposed, true); a.equal(x.timerActive, false); a.deepEqual(x.pending, [])
        a.ok(!x.sent.some(op => op.disposedAtSubmit), JSON.stringify(x.sent))
      } }] },
  { id: 'R23-deleted-ready-uid', name: 'a real deleted node is removed from the pending queue once the renderer is ready',
    observe: page => page.evaluate(deletedScenario), checks: [
      { name: 'the deleted pending uid is really missing in a ready renderer', assert: (x, a) => { a.ok(x.before.includes('n0')); a.equal(x.missingReady, true) } },
      { name: 'it is cleaned without ghost content writes or repeating timers', assert: (x, a) => {
        a.ok(!x.after.includes('n0')); a.equal(x.timerActive, false)
        a.ok(!x.sent.some(op => op.type === 'node.update' && op.uid === 'n0'), JSON.stringify(x.sent))
      } }] }
])
