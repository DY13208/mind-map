'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('uid-selection', [
  { id: 'R10', name: 'production UID query resolves summaries without unrelated tree scans',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.summaryFixture(160))
      const renderer = mm.renderer
      const expected = ['root', 'n0', 'n159', 'summary', 'summary-child', 'nested-summary', 'nested-child']
      const found = expected.map(uid => !!renderer.findNodeByUid(uid))
      const proto = Object.getPrototypeOf(renderer.root), original = proto.getData
      let uidReads = 0
      proto.getData = function (key, ...args) { if (key === 'uid') uidReads++; return original.call(this, key, ...args) }
      const first = renderer.findNodeByUid('n0'), missing = renderer.findNodeByUid('absent')
      proto.getData = original
      return { expected, found, uidReads, first: first && first.uid, missing: !missing }
    }), checks: [
      { name: 'real nested summaries and ordinary nodes resolve', assert: (x, a) => a.deepEqual(x.found, x.expected.map(() => true)) },
      { name: 'missing and present query avoids unrelated branches', assert: (x, a) => { a.equal(x.first, 'n0'); a.equal(x.missing, true); a.ok(x.uidReads <= 12, 'two UID queries read ' + x.uidReads + ' node identifiers') } }
    ] },
  { id: 'R11', name: 'selection cache uses current instances after retirement and bounded UID work',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(200)
      data.children[0].children = [{ data: { uid: 'deep-child', text: 'Deep child' }, children: [] }]
      const mm = await f.createEngine(data), r = mm.renderer, selected = ['n2', 'n3', 'n4', 'n5', 'n6']
      const old = r.findNodeByUid('deep-child')
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', r.findNodeByUid('n0'), false))
      const collapsedMissing = !r.findNodeByUid('deep-child')
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', r.findNodeByUid('n0'), true))
      const expandedPresent = !!r.findNodeByUid('deep-child')
      mm.select.lastMultiSelectUids = selected
      mm.select.lastMultiSelectList = selected.map(uid => r.findNodeByUid(uid))
      const proto = Object.getPrototypeOf(r.root), original = proto.getData
      let uidReads = 0
      proto.getData = function (key, ...args) { if (key === 'uid') uidReads++; return original.call(this, key, ...args) }
      const cache = mm.select.getMultiSelectCache()
      proto.getData = original
      const current = cache.every((node, i) => node === r.findNodeByUid(selected[i]))
      await f.waitRender(mm, () => mm.execCommand('REMOVE_NODE', r.findNodeByUid('n2')))
      const deletionAbsent = !r.findNodeByUid('n2')
      await f.waitRender(mm, () => mm.setLayout('mindMap'))
      return { collapsedMissing, expandedPresent, current, uidReads, selected: selected.length,
        cacheSize: cache.length, deletionAbsent, retiredAbsent: old !== r.findNodeByUid('n2') }
    }), checks: [
      { name: 'fold expand delete and switch preserve lookup semantics', assert: (x, a) => { a.equal(x.collapsedMissing, true); a.equal(x.expandedPresent, true); a.equal(x.deletionAbsent, true); a.equal(x.current, true); a.equal(x.cacheSize, x.selected) } },
      { name: 'M selection queries have bounded relationship reads', assert: (x, a) => a.ok(x.uidReads <= x.selected * 4, 'selection read ' + x.uidReads + ' node identifiers for ' + x.selected + ' UIDs') }
    ] },
  { id: 'R12', name: 'real all/box selection is duplicate-free without quadratic list lookup',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.summaryFixture(120)), r = mm.renderer
      const proto = Object.getPrototypeOf(r.root), original = proto.getData
      let uidReads = 0, notifications = 0
      mm.on('node_active', () => notifications++)
      proto.getData = function (key, ...args) { if (key === 'uid') uidReads++; return original.call(this, key, ...args) }
      mm.execCommand('SELECT_ALL')
      proto.getData = original
      await f.pause(20)
      const uids = r.activeNodeList.map(node => node.getData('uid'))
      const unique = new Set(uids).size === uids.length
      const summaries = ['summary', 'summary-child', 'nested-summary', 'nested-child'].every(uid => uids.includes(uid))
      let cancelReads = 0
      proto.getData = function (key, ...args) { if (key === 'uid') cancelReads++; return original.call(this, key, ...args) }
      r.cancelActiveMultiNode(r.activeNodeList.slice())
      proto.getData = original
      const cancelledAll = r.activeNodeList.length === 0
      mm.execCommand('CLEAR_ACTIVE_NODE'); await f.pause(20)
      const select = mm.select
      select.isMousedown = true; select.isSelecting = true
      select.mouseDownX = -100000; select.mouseDownY = -100000
      select.mouseMoveX = 100000; select.mouseMoveY = 100000
      select.checkInNodes(); select.onMouseup(); await f.pause(20)
      const boxUids = r.activeNodeList.map(node => node.getData('uid'))
      mm.execCommand('CLEAR_ACTIVE_NODE'); await f.pause(20)
      const target = r.findNodeByUid('n0')
      target.active(); await f.pause(20)
      target.group.node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 2 }))
      return { count: uids.length, unique, summaries, uidReads, notifications, cancelReads, cancelledAll,
        boxIncludesSummaries: ['summary', 'nested-child'].every(uid => boxUids.includes(uid)),
        currentSingle: r.activeNodeList.length === 1 && r.activeNodeList[0] === target }
    }), checks: [
      { name: 'all/box summary selection and current single remain correct', assert: (x, a) => { a.equal(x.unique, true); a.equal(x.summaries, true); a.equal(x.boxIncludesSummaries, true); a.equal(x.currentSingle, true) } },
      { name: 'full selection identifier work is linear', assert: (x, a) => a.ok(x.uidReads <= x.count * 12, 'selecting ' + x.count + ' nodes read ' + x.uidReads + ' identifiers') },
      { name: 'batch cancellation preserves order with linear work', assert: (x, a) => { a.equal(x.cancelledAll, true); a.ok(x.cancelReads <= x.count * 12, 'cancelling ' + x.count + ' nodes read ' + x.cancelReads + ' identifiers') } },
      { name: 'actual active events are batched', assert: (x, a) => a.ok(x.notifications <= 8, 'selection emitted ' + x.notifications + ' events') }
    ] },
  { id: 'R11-summary', name: 'summary instances and multiselect survive viewport detach/reentry',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.summaryFixture(4), { openPerformance: true }), r = mm.renderer
      // The nested summary starts at x=1234 in this real layout. Move it into
      // the 1100px viewport before observing its model/selection lifetime.
      mm.view.translateXTo(-400); await f.pause(350)
      const ids = ['summary-child', 'nested-child'], before = ids.map(uid => r.findNodeByUid(uid))
      if (before.some(node => !node || !node.group)) throw new Error('summary viewport fixture is not initially visible')
      r.activeMultiNode(before); await f.pause(20)
      const originalX = mm.view.getTransformData().state.x
      mm.view.translateXTo(100000); await f.pause(350)
      const detachedSame = ids.every((uid, index) => r.findNodeByUid(uid) === before[index])
      const detachedSelection = mm.select.getMultiSelectCache().map(node => node.uid)
      mm.view.translateXTo(originalX); await f.pause(350)
      const returnedSame = ids.every((uid, index) => r.findNodeByUid(uid) === before[index])
      const returnedConnected = ids.every(uid => r.findNodeByUid(uid)?.group?.node.isConnected)
      const summaries = [r.findNodeByUid('summary'), r.findNodeByUid('nested-summary')]
      const linesConnected = summaries.every(node => node && node.generalizationBelongNode._generalizationList.some(item => item.generalizationNode === node && item.generalizationLine?.node.isConnected))
      return { ids, detachedSame, detachedSelection, returnedSame, returnedConnected, linesConnected }
    }), checks: [
      { name: 'viewport removal keeps current models and selection', assert: (x, a) => { a.equal(x.detachedSame, true); a.deepEqual(x.detachedSelection, x.ids) } },
      { name: 'same summary groups and bracket lines reattach on return', assert: (x, a) => { a.equal(x.returnedSame, true); a.equal(x.returnedConnected, true); a.equal(x.linesConnected, true) } }
    ] }
])
