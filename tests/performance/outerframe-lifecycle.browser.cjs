'use strict'
const { runCases } = require('./frontend-runner.cjs')
const retirementCases = ['destroy', 'remove'].map(action => ({
  id: 'R38-frame-retire-' + action,
  name: 'actual engine ' + action + ' releases plugin-owned model and DOM references',
  observe: page => page.evaluate(async action => {
    const f = window.perfFrontend, data = f.tree(4)
    data.children[0].data.outerFrame = { groupId: 'one', text: 'Retired frame' }
    const mm = await f.createEngine(data), plugin = mm.outerFrame, Plugin = plugin.constructor
    const root = mm.renderer.root, frame = plugin.outerFrameElList[0], text = plugin.textNodeList[0], drawing = plugin.draw
    frame.node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    text.node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const before = { rootHeld: plugin._frameRoot === root, owners: plugin._frameOwners.length,
      candidates: plugin._frameCandidates.length, frames: plugin.outerFrameElList.length,
      texts: plugin.textNodeList.length, active: !!plugin.activeOuterFrame, editing: plugin.showTextEdit }
    if (action === 'destroy') mm.destroy()
    else mm.removePlugin(Plugin)
    await f.pause(30)
    const after = { rootReleased: plugin._frameRoot == null, owners: (plugin._frameOwners || []).length,
      candidates: plugin._frameCandidates.length, frames: plugin.outerFrameElList.length,
      texts: plugin.textNodeList.length, active: !!plugin.activeOuterFrame,
      drawingReleased: plugin.draw == null, signatureReleased: plugin._frameSignature == null,
      editElementReleased: plugin.textEditNode == null, editing: plugin.showTextEdit,
      frameConnected: frame.node.isConnected, textConnected: text.node.isConnected, drawingConnected: drawing.node.isConnected,
      pluginDetached: !mm.outerFrame }
    if (action === 'remove') {
      await f.waitRender(mm, () => mm.render())
      after.noLateRevival = plugin.outerFrameElList.length === 0 && plugin.textNodeList.length === 0 && plugin._frameRoot == null
      mm.destroy()
      f.MindMap.usePlugin(Plugin)
    }
    return { action, before, after }
  }, action),
  checks: [
    { name: 'fixture contains real rendered and active plugin owners', assert: (x, a) => { a.equal(x.before.rootHeld, true); a.equal(x.before.owners, 1); a.equal(x.before.candidates, 1); a.equal(x.before.frames, 1); a.equal(x.before.texts, 1); a.equal(x.before.active, true); a.equal(x.before.editing, true) } },
    { name: 'retirement clears plugin-owned trees, owners, drawing and text references', assert: (x, a) => { a.equal(x.after.rootReleased, true); a.equal(x.after.owners, 0); a.equal(x.after.candidates, 0); a.equal(x.after.frames, 0); a.equal(x.after.texts, 0); a.equal(x.after.active, false); a.equal(x.after.drawingReleased, true); a.equal(x.after.signatureReleased, true); a.equal(x.after.editElementReleased, true); a.equal(x.after.editing, false) } },
    { name: 'native removal detaches frame DOM and callbacks cannot revive retired plugin', assert: (x, a) => { a.equal(x.after.pluginDetached, true); a.equal(x.after.frameConnected, false); a.equal(x.after.textConnected, false); a.equal(x.after.drawingConnected, false); if (x.action === 'remove') a.equal(x.after.noLateRevival, true) } }
  ]
}))
const viewportCases = [false, true].map(mixed => ({
  id: mixed ? 'R40-viewport-mixed' : 'R40-viewport-empty',
  name: 'actual navigation renders an initially offscreen frame and restores reentry' + (mixed ? ' with another visible frame' : ' from an empty frame cache'),
  observe: page => page.evaluate(async mixed => {
    const f = window.perfFrontend, data = f.tree(1000, { customLeft: 4000, customTop: 4000 })
    data.children.forEach((node, i) => Object.assign(node.data, { customLeft: 10000 + i, customTop: 10000 + i }))
    Object.assign(data.children[0].data, { customLeft: 150, customTop: 300 })
    Object.assign(data.children[1].data, { customLeft: 6000, customTop: 4500,
      outerFrame: { groupId: 'offscreen-b', text: 'Frame B' } })
    if (mixed) data.children[0].data.outerFrame = { groupId: 'visible-a', text: 'Frame A' }
    const mm = await f.createEngine(data, { fit: false, openPerformance: true }), plugin = mm.outerFrame
    const target = mm.renderer.findNodeByUid('n1'), root = mm.renderer.root, epoch = mm.renderer._layoutEpoch
    const initial = { targetConnected: !!target.group?.node.isConnected, frames: plugin.outerFrameElList.length, text: plugin.draw.node.textContent }
    const proto = Object.getPrototypeOf(root), originalGetData = proto.getData, originalLayout = mm.renderer.layout.doLayout
    let frameReads = 0, layouts = 0
    proto.getData = function(key, ...args) { if (key === 'outerFrame') frameReads++; return originalGetData.call(this, key, ...args) }
    mm.renderer.layout.doLayout = function(...args) { layouts++; return originalLayout.apply(this, args) }
    const navigate = uid => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('actual GO_TARGET_NODE viewport render timeout')) }, 10000)
      const done = event => { if (event?.reason !== 'view') return; clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
      mm.on('node_tree_render_end', done)
      mm.execCommand('GO_TARGET_NODE', uid)
    })
    const observe = () => {
      let nodeBox = null
      if (target.group?.node.isConnected) nodeBox = target.group.findOne('.smm-node-shape').rbox()
      const view = mm.el.getBoundingClientRect()
      const frameBoxes = plugin.outerFrameElList.map(el => ({ connected: el.node.isConnected, box: el.rbox() }))
      return { targetConnected: !!target.group?.node.isConnected,
        visible: !!nodeBox && nodeBox.x + nodeBox.width >= view.left && nodeBox.x <= view.right && nodeBox.y + nodeBox.height >= view.top && nodeBox.y <= view.bottom,
        finiteNode: !!nodeBox && [nodeBox.x, nodeBox.y, nodeBox.width, nodeBox.height].every(Number.isFinite),
        frames: frameBoxes.length, text: plugin.draw.node.textContent,
        finiteFrames: frameBoxes.every(({ connected, box }) => connected && [box.x, box.y, box.width, box.height].every(Number.isFinite)),
        containsTarget: !!nodeBox && frameBoxes.some(({ box }) => box.x <= nodeBox.x && box.y <= nodeBox.y && box.x + box.width >= nodeBox.x + nodeBox.width && box.y + box.height >= nodeBox.y + nodeBox.height) }
    }
    let entered, left, reentered
    try { await navigate('n1'); entered = observe(); await navigate('n0'); left = observe(); await navigate('n1'); reentered = observe() }
    finally { proto.getData = originalGetData; mm.renderer.layout.doLayout = originalLayout }
    const result = { mixed, initial, entered, left, reentered, frameReads, layouts,
      sameRoot: root === mm.renderer.root, sameEpoch: epoch === mm.renderer._layoutEpoch, nodes: mm.renderer.nodeIndex.size }
    mm.destroy()
    return result
  }, mixed),
  checks: [
    { name: 'fixture starts with the framed target actually detached', assert: (x, a) => { a.equal(x.initial.targetConnected, false); a.equal(x.initial.frames, x.mixed ? 1 : 0); a.equal(x.nodes, 1001) } },
    { name: 'actual viewport entry and reentry display finite frame around target', assert: (x, a) => {
      for (const view of [x.entered, x.reentered]) { a.equal(view.targetConnected, true); a.equal(view.visible, true); a.equal(view.finiteNode, true); a.equal(view.frames, 1); a.ok(view.text.includes('Frame B'), 'visible Frame B missing: ' + view.text); a.equal(view.finiteFrames, true); a.equal(view.containsTarget, true) }
      a.equal(x.left.targetConnected, false)
    } },
    { name: 'navigation reuses frame candidates without a loaded-tree frame scan or layout', assert: (x, a) => { a.equal(x.sameRoot, true); a.equal(x.sameEpoch, true); a.equal(x.layouts, 0); a.ok(x.frameReads <= 12, 'viewport frame reads scanned ' + x.frameReads + ' nodes') } }
  ]
}))
runCases('outerframe', [
  { id: 'R38', name: 'real OuterFrame releases removed text references across 100 renders',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(8)
      for (let i = 0; i < 4; i++) data.children[i].data.outerFrame = { groupId: 'frame-' + i, text: 'Frame ' + i }
      const mm = await f.createEngine(data), plugin = mm.outerFrame
      for (let i = 0; i < 100; i++) plugin.renderOuterFrames()
      const active = plugin.outerFrameElList.length, retained = plugin.textNodeList.length
      const dom = plugin.draw.node.querySelectorAll('rect').length
      mm.renderer.root.children.forEach(node => { delete node.nodeData.data.outerFrame })
      plugin.renderOuterFrames()
      return { active, retained, dom, emptyRetained: plugin.textNodeList.length, emptyDom: plugin.draw.node.children.length }
    }), checks: [
      { name: 'retained references equal current frames', assert: (x, a) => a.equal(x.retained, x.active) },
      { name: 'all removal releases references', assert: (x, a) => a.equal(x.emptyRetained, 0) },
      { name: 'current frame and text-background DOM is bounded and clears', assert: (x, a) => { a.equal(x.active, 4); a.ok(x.dom <= x.active * 3); a.equal(x.emptyDom, 0) } }
    ] },
  { id: 'R39', name: 'same version render and data events do not rebuild frames twice',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(4)
      data.children[0].data.outerFrame = { groupId: 'one', text: 'Before' }
      const mm = await f.createEngine(data), plugin = mm.outerFrame
      const spy = f.spy(plugin, 'createOuterFrameEl')
      mm.emit('node_tree_render_end'); mm.emit('data_change', mm.renderer.renderTree)
      const created = spy.calls.length
      const child = mm.renderer.findNodeByUid('n0')
      mm.execCommand('SET_NODE_DATA', child, { outerFrame: { groupId: 'one', text: 'After', strokeColor: '#ff0000' } })
      await f.waitRender(mm, () => mm.render())
      await f.pause(120)
      return { created, current: plugin.outerFrameElList.length, text: plugin.draw.node.textContent, dataText: child.getData('outerFrame').text }
    }), checks: [
      { name: 'duplicate same-version events commit at most one frame rebuild', assert: (x, a) => a.ok(x.created <= 1, 'two events rebuilt ' + x.created + ' frames') },
      { name: 'actual changed text is displayed', assert: (x, a) => { a.equal(x.current, 1); a.equal(x.dataText, 'After'); a.ok(x.text.includes('After')) } }
    ] },
  { id: 'R39-scan', name: 'stable view events reuse frame specs without a full tree scan',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(300)
      data.children[0].data.outerFrame = { groupId: 'one', text: 'Frame' }
      const mm = await f.createEngine(data), proto = Object.getPrototypeOf(mm.renderer.root), original = proto.getData
      let visits = 0
      proto.getData = function(key, ...args) { if (key === 'outerFrame') visits++; return original.call(this, key, ...args) }
      for (let i = 0; i < 5; i++) mm.emit('node_tree_render_end', { reason: 'view' })
      proto.getData = original
      return { visits, frames: mm.outerFrame.outerFrameElList.length }
    }), checks: [
      { name: 'view-only notifications avoid loaded-tree frame reads', assert: (x, a) => { a.equal(x.frames, 1); a.ok(x.visits <= 5, 'stable view notifications read outerFrame ' + x.visits + ' times') } }
    ] },
  { id: 'R40', name: 'frame click edit delete undo and layout switch preserve real DOM geometry',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(4)
      data.children[0].data.outerFrame = { groupId: 'one', text: 'Before' }
      const mm = await f.createEngine(data), plugin = mm.outerFrame
      const first = plugin.outerFrameElList[0]
      first.node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const selected = plugin.activeOuterFrame && plugin.activeOuterFrame.el === first
      plugin.updateActiveOuterFrame({ text: 'Edited', strokeColor: '#00ff00' })
      await f.pause(150)
      const edited = mm.renderer.findNodeByUid('n0').getData('outerFrame').text
      // Select the current live frame before deleting; data notifications may recreate it.
      const current = plugin.outerFrameElList[0]
      current.node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      plugin.removeActiveOuterFrame(); await f.pause(150)
      const deleted = plugin.outerFrameElList.length === 0
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      const restored = mm.renderer.findNodeByUid('n0').getData('outerFrame')
      await f.waitRender(mm, () => mm.setLayout('organizationStructure'))
      const rect = plugin.outerFrameElList[0] && plugin.outerFrameElList[0].bbox()
      return { selected: !!selected, edited, deleted, restored: !!restored,
        finite: !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite),
        liveActive: !plugin.activeOuterFrame || plugin.outerFrameElList.includes(plugin.activeOuterFrame.el) }
    }), checks: [
      { name: 'frame selection/edit/delete/undo remain functional', assert: (x, a) => { a.equal(x.selected, true); a.equal(x.edited, 'Edited'); a.equal(x.deleted, true); a.equal(x.restored, true) } },
      { name: 'layout geometry finite and active reference live', assert: (x, a) => { a.equal(x.finite, true); a.equal(x.liveActive, true) } }
    ] },
  ...viewportCases,
  ...retirementCases
])
