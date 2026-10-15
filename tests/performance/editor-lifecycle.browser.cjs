'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('editor-lifecycle', [
  { id: 'R06-cache', name: 'real V2 baseline and tombstone caches release on Edit exit',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor('cache-exit'), mm = editor.component.mindMap, data = f.tree(4)
      await f.waitRender(mm, () => mm.setData(data))
      const { co } = await f.connectV2(mm, data, 'cache-exit')
      // Production baseline/forget/intent methods populate these caches; the
      // test retains the retired plugin solely to inspect its cleanup contract.
      co.tombstoneDeletedUid('n1')
      co.setGenIntent('n2', [{ uid: 'cache-exit-summary', text: 'summary' }])
      const counts = () => ({ acked: co.ackedUids.size, deleted: co.deletedUids.size,
        abandoned: co.abandonedInsertUids.size, recentDeleted: co.recentHttpDeleted.size,
        genIntent: co.pendingGenIntent.size, lastPushed: Object.keys(co.lastPushed).length })
      const before = counts()
      f.unmount(editor)
      await f.pause(50)
      return { before, after: counts(), disposed: co._disposed }
    }), checks: [
      { name: 'actual collaboration paths populated baseline and tombstone state', assert: (x,a) => {
        a.ok(x.before.acked > 0); a.ok(x.before.lastPushed > 0)
        a.equal(x.before.deleted, 1); a.equal(x.before.abandoned, 1)
        a.equal(x.before.recentDeleted, 1); a.equal(x.before.genIntent, 1)
      } },
      { name: 'disposed plugin releases every populated UID and payload cache', assert: (x,a) => {
        a.equal(x.disposed, true)
        a.deepEqual(x.after, { acked: 0, deleted: 0, abandoned: 0, recentDeleted: 0, genIntent: 0, lastPushed: 0 })
      } }
    ] },
  { id: 'R04', name: 'ten real Edit mounts/unmounts release only their two save listeners',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, external = () => {}
      f.bus.$on('data_change', external); f.bus.$on('view_data_change', external)
      const count = name => (f.bus._events[name] || []).length
      const before = { data: count('data_change'), view: count('view_data_change') }, rounds = []
      for (let i = 0; i < 10; i++) {
        const editor = await f.mountEditor(); f.unmount(editor)
        rounds.push({ data: count('data_change'), view: count('view_data_change') })
      }
      return { before, rounds, externalPreserved: f.bus._events.data_change.includes(external) && f.bus._events.view_data_change.includes(external) }
    }), checks: [
      { name: 'component listener counts return to original baseline', assert: (x, a) => x.rounds.forEach((row, i) => a.deepEqual(row, x.before, 'listeners after real exit ' + (i + 1))) },
      { name: 'unrelated listeners stay registered', assert: (x, a) => a.equal(x.externalPreserved, true) }
    ] },
  { id: 'R05', name: 'events after real destruction cannot reschedule old save/config callbacks',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, old = await f.mountEditor(), oldComponent = old.component
      const oldMM = oldComponent.mindMap, oldRoot = oldMM.renderer.renderTree
      await f.pause(1100); f.unmount(old)
      const retiredState = { treeReleased: !oldMM.renderer.renderTree, historyReleased: oldMM.command.history.length === 0,
        cacheReleased: Object.keys(oldMM.renderer.nodeCache).length === 0 }
      const current = await f.mountEditor(); await f.pause(1100)
      const writes = [], original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (data, key) { writes.push({ key, text: data.root && data.root.data.text }); return original.call(this, data, key) }
      const next = f.tree(3); next.data.text = 'Current marker'
      f.bus.$emit('data_change', next)
      const oldDataScheduled = !!oldComponent.storeDataTimer
      await f.pause(1100)
      f.bus.$emit('view_data_change', current.component.mindMap.view.getTransformData())
      const oldScheduled = oldDataScheduled || !!oldComponent.storeConfigTimer
      IDBObjectStore.prototype.put = original
      const result = { oldScheduled, writes: writes.length, retiredState, oldTreeStillRetained: oldMM.renderer.renderTree === oldRoot }
      f.unmount(current)
      return result
    }), checks: [
      { name: 'destroyed Edit cannot schedule callbacks', assert: (x, a) => a.equal(x.oldScheduled, false) },
      { name: 'destroyed engine releases tree/history/cache references', assert: (x, a) => { a.equal(x.retiredState.treeReleased, true); a.equal(x.retiredState.historyReleased, true); a.equal(x.retiredState.cacheReleased, true) } },
      { name: 'current data and view save is at most one coalesced physical write', assert: (x, a) => a.ok(x.writes <= 1, 'physical draft writes=' + x.writes) }
    ] },
  { id: 'R06-hydrate', name: 'late actual HTTP hydration cannot mutate a destroyed editor tree',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(2)
      data.children[0].data.childCount = 1; data.children[0].data.expand = false
      await f.waitRender(mm, () => mm.setData(data)); await f.pause(1100)
      const co = mm.cooperate, node = mm.renderer.findNodeByUid('n0'), retiredData = node.nodeData
      co.setHttpCollab({ roomKey: 'hydrate-exit', nodeCount: 4, version: 1 })
      let deliver
      co.httpFetchSubtree = () => new Promise(resolve => { deliver = resolve })
      const pending = co.hydrateFromHttp(node)
      if (!deliver) throw new Error('production HTTP hydrate did not start')
      const container = mm.el
      f.unmount(editor)
      deliver({ children: [{ data: { uid: 'late-child', text: 'Late hydrate' }, children: [] }], total: 1, version: 2, has_more: false })
      let error = null
      try { await pending } catch (err) { error = String(err.message || err) }
      await f.pause(100)
      return { oldChildren: retiredData.children.length, error, detached: !container.isConnected, oldNodes: container.querySelectorAll('.smm-node').length }
    }), checks: [
      { name: 'late hydrate does not mutate retired data or throw', assert: (x, a) => { a.equal(x.oldChildren, 0); a.equal(x.error, null) } },
      { name: 'old DOM remains detached and empty after hydrate', assert: (x, a) => { a.equal(x.detached, true); a.equal(x.oldNodes, 0) } }
    ] },
  { id: 'R06-hydrate-raw', name: 'late raw-tree hydration cannot mutate a destroyed editor tree',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(2)
      data.children[0].data.childCount = 1; data.children[0].data.expand = false
      await f.waitRender(mm, () => mm.setData(data)); await f.pause(100)
      const co = mm.cooperate, retiredData = mm.renderer.findNodeByUid('n0').nodeData
      co.setHttpCollab({ roomKey: 'raw-hydrate-exit', nodeCount: 4, version: 1 })
      let deliver
      co.httpFetchSubtree = () => new Promise(resolve => { deliver = resolve })
      const pending = co.hydrateNodeData(retiredData)
      if (!deliver) throw new Error('production raw HTTP hydrate did not start')
      const container = mm.el
      f.unmount(editor)
      deliver({ children: [{ data: { uid: 'late-raw-child', text: 'Late raw hydrate' }, children: [] }], total: 1, version: 2, has_more: false })
      let error = null
      try { await pending } catch (err) { error = String(err.message || err) }
      await f.pause(50)
      return { oldChildren: retiredData.children.length, error, detached: !container.isConnected, oldNodes: container.querySelectorAll('.smm-node').length }
    }), checks: [
      { name: 'late raw hydration does not mutate retired data or throw', assert: (x,a) => { a.equal(x.oldChildren, 0); a.equal(x.error, null) } },
      { name: 'destroyed DOM remains empty', assert: (x,a) => { a.equal(x.detached, true); a.equal(x.oldNodes, 0) } }
    ] },
  { id: 'R06-offline', name: 'real offline browser exit saves its final room draft once',
    observe: async page => {
      await page.evaluate(async () => {
        const f = window.perfFrontend, editor = await f.mountEditor('offline-A'), mm = editor.component.mindMap, data = f.tree(2)
        await f.waitRender(mm, () => mm.setData(data)); await f.pause(100)
        const v2 = await f.connectV2(mm, data, 'offline-A')
        const node = mm.renderer.findNodeByUid('n0'), textEdit = mm.renderer.textEdit
        await textEdit.show({ node, forceEdit: true })
        textEdit.textEditNode.innerText = 'Offline final text'
        textEdit.textEditNode.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Offline final text' }))
        const writes = [], original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function(value, key) { if (key === 'room:offline-A') writes.push({ key, text: value.root.children[0].data.text }); return original.call(this, value, key) }
        window.__offlineExit = { editor, mm, v2, writes, original, container: mm.el }
      })
      await page.context().setOffline(true)
      try {
        return await page.evaluate(async () => {
          const f = window.perfFrontend, state = window.__offlineExit
          f.unmount(state.editor); await f.pause(1500)
          IDBObjectStore.prototype.put = state.original
          return { offline: !navigator.onLine, writes: state.writes,
            pendingAfterExit: state.v2.co.pendingUids.size,
            empty: state.container.querySelectorAll('.smm-node').length === 0, detached: !state.container.isConnected }
        })
      } finally { await page.context().setOffline(false) }
    }, checks: [
      { name: 'offline final content is physically stored once under captured room key', assert: (x,a) => { a.equal(x.offline, true); a.deepEqual(x.writes, [{ key: 'room:offline-A', text: 'Offline final text' }]); a.equal(x.empty, true); a.equal(x.detached, true) } },
      { name: 'disposed offline plugin releases its optimistic pending UID cache', assert: (x,a) => a.equal(x.pendingAfterExit, 0) }
    ] },
  { id: 'R06', name: 'exit commits pending actual text edit once and cannot revive old DOM',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), vm = editor.component, mm = vm.mindMap
      await f.waitRender(mm, () => mm.setData(f.tree(2)))
      await f.pause(1100)
      const node = mm.renderer.findNodeByUid('n0'), textEdit = mm.renderer.textEdit
      await textEdit.show({ node, forceEdit: true })
      const input = textEdit.textEditNode
      if (!input) throw new Error('real text editor failed to open')
      input.innerText = 'Unfinished final text'
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Unfinished final text' }))
      const writes = [], original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (data, key) { writes.push({ key, tree: structuredClone(data.root) }); return original.call(this, data, key) }
      const container = mm.el
      f.unmount(editor); await f.pause(1500)
      IDBObjectStore.prototype.put = original
      const finalWritten = writes.some(write => write.tree && write.tree.children.some(child => String(child.data.text).includes('Unfinished final text')))
      return { writes: writes.length, finalWritten, detached: !container.isConnected,
        oldNodes: container.querySelectorAll('.smm-node').length, viewTimerReleased: vm.storeConfigTimer == null }
    }), checks: [
      { name: 'last current edit reaches one final backup', assert: (x, a) => { a.equal(x.finalWritten, true); a.equal(x.writes, 1) } },
      { name: 'old canvas stays empty/detached', assert: (x, a) => { a.equal(x.detached, true); a.equal(x.oldNodes, 0); a.equal(x.viewTimerReleased, true) } }
    ] }
])
