'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('history-notifications', [
  { id: 'R07', name: 'real V2 edits notify consumers without copying and recounting loaded tree',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(90)
      mm.updateConfig({ addHistoryTime: 0, createNewNodeBehavior: 'NOT_ACTIVE' })
      await f.waitRender(mm, () => mm.setData(data))
      const v2 = await f.connectV2(mm, data)
      const count = f.mount(f.Count, { mindMap: mm }), countSpy = f.spy(count.component, 'walk'), copySpy = f.spy(mm.command, 'getCopyData')
      const textScanSpy = f.spy(v2.co, 'hasUnsyncedLocalText')
      const stringify = JSON.stringify; let fullSerializations = 0, notifications = 0
      JSON.stringify = function (value, ...args) { if (value && value.data && value.data.uid === 'root' && Array.isArray(value.children)) fullSerializations++; return stringify(value, ...args) }
      mm.on('data_change', () => notifications++)
      const r = mm.renderer
      const actions = [
        ['text', () => r.findNodeByUid('n0').setText('Text changed', false)],
        ['style', () => mm.execCommand('SET_NODE_STYLE', r.findNodeByUid('n0'), 'color', '#ff0000')],
        ['insert', () => { const parent = r.findNodeByUid('n0'); parent.active(); mm.execCommand('INSERT_CHILD_NODE', false, parent, { uid: 'inserted-child', text: 'Inserted' }) }],
        ['move', () => mm.execCommand('MOVE_NODE_TO', r.findNodeByUid('inserted-child'), r.findNodeByUid('n1'))],
        ['paste', async () => { r.root.active(); await r.paste({ text: 'Pasted label' }) }],
        ['delete', () => mm.execCommand('REMOVE_NODE', r.findNodeByUid('inserted-child'))]
      ]
      const applied = []
      for (const [name, action] of actions) {
        await action(); await f.pause(350); await v2.co.flushHttpTextNow(); await f.pause(80)
        applied.push(name)
      }
      JSON.stringify = stringify
      const server = await f.requestMemory('state', { roomKey: v2.roomKey })
      const state = { copyCalls: copySpy.calls.length, fullSerializations, countVisits: countSpy.calls.length,
        textScanVisits: textScanSpy.calls.length,
        notifications, applied, statsNodes: count.component.num, actualNodes: Object.keys(mm.renderer.nodeCache).length,
        serverOps: server.operations.length, serverText: server.nodes.n0.data.text,
        insertedDeleted: !server.nodes['inserted-child'] || !!server.nodes['inserted-child'].deleted }
      await v2.adapter.disconnect(); f.unmount(count); f.unmount(editor)
      return state
    }), checks: [
      { name: 'effective edits still notify stats and reach actual V2 engine', assert: (x, a) => { a.ok(x.notifications >= 6); a.equal(x.statsNodes, x.actualNodes); a.equal(x.serverText, 'Text changed'); a.ok(x.serverOps >= 6); a.equal(x.applied.length, 6) } },
      { name: 'normal V2 notification chain avoids loaded-tree snapshots', assert: (x, a) => { a.equal(x.copyCalls, 0); a.equal(x.fullSerializations, 0) } },
      { name: 'stats work depends on six affected ranges', assert: (x, a) => a.ok(x.countVisits <= 40, 'six edits traversed ' + x.countVisits + ' count nodes') }
      ,{ name: 'V2 pending-text work depends on affected identifiers', assert: (x, a) => a.ok(x.textScanVisits <= 80, 'six edits inspected ' + x.textScanVisits + ' unrelated pending-text candidates') }
    ] },
  { id: 'R08', name: 'personal view commands skip content undo while exit saves original room final draft',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editorA = await f.mountEditor('room-A'), mm = editorA.component.mindMap, data = f.tree(5)
      data.children[0].children = [{ data: { uid: 'leaf', text: 'Leaf' }, children: [] }]
      mm.updateConfig({ addHistoryTime: 0 })
      await f.waitRender(mm, () => mm.setData(data))
      const v2 = await f.connectV2(mm, data, 'room-A')
      const baseline = mm.command.history.length
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', mm.renderer.findNodeByUid('n0'), false))
      mm.execCommand('SET_NODE_ACTIVE', mm.renderer.findNodeByUid('n1'), true)
      const personalUnchanged = mm.command.history.length === baseline
      mm.command.pause(); mm.command.recovery()
      const draftWrites = [], outboxWrites = [], original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.transaction.db.name === 'mind-map-local' && this.name === 'drafts' && typeof key === 'string' && key.startsWith('room:')) {
          draftWrites.push({ key, text: value.root && value.root.children && value.root.children[1] && value.root.children[1].data.text })
        } else if (this.transaction.db.name === 'mind-map-collab-v2' && this.name === 'outbox') {
          outboxWrites.push({ opId: value.opId, status: value.status || 'pending' })
        }
        return original.call(this, value, key)
      }
      for (let i = 0; i < 4; i++) { mm.renderer.findNodeByUid('n1').setText('Final A ' + i, false); await f.pause(150) }
      // Real browser navigation changes location before Vue destroys the old view.
      history.replaceState({}, '', '/?room=room-B'); f.unmount(editorA)
      await f.pause(3200)
      IDBObjectStore.prototype.put = original
      await v2.adapter.disconnect()
      return { personalUnchanged, draftWrites, outboxWrites, bounded: draftWrites.length <= 2,
        finalA: draftWrites.some(write => write.key === 'room:room-A' && write.text === 'Final A 3'),
        wrongB: draftWrites.some(write => write.key === 'room:room-B' && String(write.text).startsWith('Final A')) }
    }), checks: [
      { name: 'view state stays out of content history and physical draft writes are bounded (outbox reported separately)', assert: (x, a) => { a.equal(x.personalUnchanged, true); a.equal(x.bounded, true) } },
      { name: 'exit tail backup uses captured A key and latest data', assert: (x, a) => { a.equal(x.finalA, true); a.equal(x.wrongB, false) } }
    ] },
  { id: 'R07-load', name: 'already-mounted Count follows a full V2 room load without history snapshots',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor('load-room'), mm = editor.component.mindMap, data = f.tree(40)
      const count = f.mount(f.Count, { mindMap: mm }), initial = count.component.num
      const v2 = await f.connectV2(mm, data, 'load-room'), copies = f.spy(mm.command, 'getCopyData')
      await f.waitRender(mm, () => mm.setData(data)); await f.pause(100)
      const server = await f.requestMemory('state', { roomKey: v2.roomKey })
      const result = { initial, num: count.component.num, words: count.component.words, expectedWords: data.data.text.length + data.children.reduce((sum,node) => sum + node.data.text.length, 0), copies: copies.calls.length, ops: server.operations.length }
      await v2.adapter.disconnect(); f.unmount(count); f.unmount(editor)
      return result
    }), checks: [
      { name: 'full load replaces placeholder statistics in an existing consumer', assert: (x,a) => { a.equal(x.initial, 1); a.equal(x.num, 41); a.equal(x.words, x.expectedWords) } },
      { name: 'authoritative load does not create snapshots or local operations', assert: (x,a) => { a.equal(x.copies, 0); a.equal(x.ops, 0) } }
    ] },
  { id: 'R07-hydrate', name: 'Count adds a real hydrated range without an entire loaded-tree recount',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, partial = f.tree(20), full = f.tree(20)
      partial.children[0].data.childCount = 1; partial.children[0].data.expand = false
      full.children[0].children = [{ data: { uid: 'server-hydrated-child', text: 'Server child' }, children: [] }]
      await f.waitRender(mm, () => mm.setData(partial)); await f.pause(100)
      const v2 = await f.connectV2(mm, full), count = f.mount(f.Count, { mindMap: mm })
      v2.co.httpFetchSubtree = async uid => {
        const state = await f.requestMemory('state', { roomKey: v2.roomKey }), row = state.nodes[uid]
        return { children: row.children.map(id => ({ data: state.nodes[id].data, children: [] })), total: row.children.length, version: state.revision, has_more: false }
      }
      const visits = f.spy(count.component, 'walk'), copies = f.spy(mm.command, 'getCopyData')
      await v2.co.hydrateFromHttp(mm.renderer.findNodeByUid('n0')); await f.pause(100)
      const state = await f.requestMemory('state', { roomKey: v2.roomKey })
      const result = { num: count.component.num, visits: visits.calls.length, copies: copies.calls.length, ops: state.operations.length,
        loaded: mm.renderer.findNodeByUid('n0').nodeData.children.some(node => node.data.uid === 'server-hydrated-child') }
      await v2.adapter.disconnect(); f.unmount(count); f.unmount(editor)
      return result
    }), checks: [
      { name: 'hydrated ordinary child is reflected in existing statistics', assert: (x,a) => { a.equal(x.loaded, true); a.equal(x.num, 22) } },
      { name: 'authoritative range load has bounded count work and no echo/snapshot', assert: (x,a) => { a.ok(x.visits <= 3); a.equal(x.copies, 0); a.equal(x.ops, 0) } }
    ] },
  { id: 'R07-image-work', name: 'V2 image edit does not scan every loaded node to maintain image storage',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(200)
      await f.waitRender(mm, () => mm.setData(data)); await f.pause(100)
      const v2 = await f.connectV2(mm, data), storage = mm.nodeBase64ImageStorage
      const original = storage.onBeforeAddHistory
      let inside = false, reads = 0
      storage.onBeforeAddHistory = function(...args) { inside = true; try { return original.apply(this, args) } finally { inside = false } }
      for (const node of [mm.renderer.renderTree, ...mm.renderer.renderTree.children]) {
        const descriptor = Object.getOwnPropertyDescriptor(node.data, 'image'), current = node.data.image
        let value = current
        Object.defineProperty(node.data, 'image', { configurable: true, enumerable: true,
          get() { if (inside) reads++; return descriptor && descriptor.get ? descriptor.get.call(this) : value },
          set(next) { if (descriptor && descriptor.set) descriptor.set.call(this, next); else value = next }
        })
      }
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
      const image = canvas.toDataURL()
      mm.execCommand('SET_NODE_IMAGE', mm.renderer.findNodeByUid('n0'), { url: image, width: 24, height: 24 })
      await f.pause(500); await v2.co.flushHttpTextNow()
      const server = await f.requestMemory('state', { roomKey: v2.roomKey })
      const result = { reads, saved: server.nodes.n0.data.image === image, resolved: mm.renderer.findNodeByUid('n0').getImageUrl() === image }
      await v2.adapter.disconnect(); f.unmount(editor)
      return result
    }), checks: [
      { name: 'actual image bookkeeping touches only its affected range', assert: (x,a) => { a.equal(x.saved, true); a.equal(x.resolved, true); a.ok(x.reads <= 5, 'one V2 image edit read ' + x.reads + ' images in the full-tree history hook') } }
    ] },
  { id: 'R07-shared-image', name: 'shared image references survive release, delete and native undo/redo',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.tree(3))
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
      const image = canvas.toDataURL()
      for (const uid of ['n0', 'n1']) { mm.execCommand('SET_NODE_IMAGE', mm.renderer.findNodeByUid(uid), { url: image, width: 24, height: 24 }); await f.pause(30) }
      const root = () => mm.renderer.renderTree.data, byUid = uid => mm.renderer.findNodeByUid(uid)
      const shared = byUid('n0').getData('image') === byUid('n1').getData('image') && Object.keys(root().imgMap).length === 1
      mm.execCommand('SET_NODE_IMAGE', byUid('n0'), {}); await f.pause(30)
      const firstRelease = byUid('n1').getImageUrl() === image && Object.keys(root().imgMap).length === 1
      await f.waitRender(mm, () => mm.execCommand('REMOVE_NODE', byUid('n1'))); await f.pause(50)
      const lastRelease = Object.keys(root().imgMap).length === 0
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      const restored = byUid('n1').getImageUrl() === image && Object.keys(root().imgMap).length === 1
      await f.waitRender(mm, () => mm.execCommand('FORWARD'))
      return { shared, firstRelease, lastRelease, restored, redone: !byUid('n1') && Object.keys(root().imgMap).length === 0 }
    }), checks: [
      { name: 'actual image keys remain shared until the final live reference is removed', assert: (x,a) => { a.equal(x.shared, true); a.equal(x.firstRelease, true); a.equal(x.lastRelease, true) } },
      { name: 'serialized native history restores the referenced content after deletion', assert: (x,a) => { a.equal(x.restored, true); a.equal(x.redone, true) } }
    ] },
  { id: 'R07-consumers', name: 'actual lazy Outline and Search consume V2 changes with no snapshot',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(30)
      await f.waitRender(mm, () => mm.setData(data))
      const v2 = await f.connectV2(mm, data), outline = f.mount(f.Outline, { mindMap: mm })
      await f.pause(150)
      mm.search.search('Node 0'); await f.pause(30)
      const initiallyFound = mm.search.matchNodeList.length > 0
      const copies = f.spy(mm.command, 'getCopyData')
      mm.renderer.findNodeByUid('n0').setText('Consumer changed', false)
      await f.pause(200)
      const resetSearch = mm.search.searchText === ''
      mm.search.search('Consumer changed'); await f.pause(30)
      const foundChanged = mm.search.matchNodeList.some(node => (node.uid || node.data?.uid) === 'n0')
      const result = { initiallyFound, resetSearch, foundChanged, outlineText: outline.root.$el.textContent,
        rootUid: outline.component.data[0].uid, copies: copies.calls.length }
      await v2.adapter.disconnect(); f.unmount(outline); f.unmount(editor)
      return result
    }), checks: [
      { name: 'real Outline label and Search state follow effective content changes', assert: (x,a) => { a.equal(x.initiallyFound, true); a.equal(x.resetSearch, true); a.equal(x.foundChanged, true); a.equal(x.rootUid, 'root'); a.ok(x.outlineText.includes('Consumer changed')) } },
      { name: 'ordinary consumer refresh does not request a full snapshot', assert: (x,a) => a.equal(x.copies, 0) }
    ] },
  { id: 'R07-payload', name: 'incremental event keeps serializable tree access and explicit operation metadata',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.summaryFixture(10)), data = mm.command.getCopyData()
      const v2 = await f.connectV2(mm, data)
      let tree, change
      mm.on('data_change', (next, meta) => { tree = next; change = meta })
      mm.renderer.findNodeByUid('n0').active()
      mm.renderer.findNodeByUid('n0').setText('Payload changed', false)
      await f.pause(100)
      let parsed = null, error = null
      try { parsed = JSON.parse(JSON.stringify(tree)) } catch (err) { error = err.message }
      let metadataError = null
      try { JSON.stringify(change) } catch (err) { metadataError = err.message }
      await v2.adapter.disconnect()
      return { serializable: !error, error, metadataSerializable: !metadataError, metadataError, childCount: parsed && parsed.children.length,
        nested: parsed && parsed.children[0].data.generalization[0].children[0].data.generalization[0].children[0].data.uid,
        active: parsed && parsed.children[0].data.isActive, metadata: change && { commands: change.commands, affectedUids: change.affectedUids, contentRevision: change.contentRevision, source: change.source } }
    }), checks: [
      { name: 'legacy tree payload is serializable with summaries and inactive saved state', assert: (x,a) => { a.equal(x.serializable, true, x.error); a.equal(x.childCount, 10); a.equal(x.nested, 'nested-child'); a.equal(x.active, false) } },
      { name: 'public delta payload does not expose renderer cycles', assert: (x,a) => a.equal(x.metadataSerializable, true, x.metadataError) },
      { name: 'delta identifies its command, affected UID, content version and source', assert: (x,a) => { a.ok(x.metadata && Array.isArray(x.metadata.commands), 'command metadata is missing'); a.ok(x.metadata.commands.includes('SET_NODE_TEXT')); a.ok(Array.isArray(x.metadata.affectedUids)); a.ok(x.metadata.affectedUids.includes('n0')); a.ok(x.metadata.contentRevision > 0); a.equal(x.metadata.source, 'local') } }
    ] },
  { id: 'R07-remote', name: 'actual remote update/insert/delete notify Count without local echo',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(80)
      await f.waitRender(mm, () => mm.setData(data))
      const v2 = await f.connectV2(mm, data), count = f.mount(f.Count, { mindMap: mm })
      const spy = f.spy(mm.command, 'getCopyData'), visits = f.spy(count.component, 'walk')
      const submit = async (type, payload) => {
        const result = await f.requestMemory('emit', { event: 'op', payload: { opId: crypto.randomUUID(), clientId: 'remote-client', roomKey: v2.roomKey, type, payload } })
        await v2.co.applyV2RemoteOperation(result.operation); await f.pause(200)
      }
      await submit('node.update', { uid: 'n0', patch: { text: 'Remote changed' } })
      const afterText = count.component.words, expectedText = mm.command.getCopyData().children.reduce((sum, node) => sum + node.data.text.length, data.data.text.length)
      await submit('node.insert', { parentUid: 'n1', uid: 'remote-child', data: { text: 'Remote child' } })
      const afterInsert = count.component.num
      await submit('node.delete', { uid: 'remote-child' })
      await f.pause(800); await v2.co.flushHttpTextNow()
      const state = await f.requestMemory('state', { roomKey: v2.roomKey })
      const result = { afterText, expectedText, afterInsert, afterDelete: count.component.num, ops: state.operations.length,
        copies: spy.calls.length - 1, visits: visits.calls.length, text: mm.renderer.findNodeByUid('n0').getData('text') }
      await v2.adapter.disconnect(); f.unmount(count); f.unmount(editor)
      return result
    }), checks: [
      { name: 'all remote deltas reach existing Count and visible models', assert: (x,a) => { a.equal(x.afterText, x.expectedText); a.equal(x.afterInsert, 82); a.equal(x.afterDelete, 81); a.equal(x.text, 'Remote changed') } },
      { name: 'remote notifications avoid snapshots, full recount and echo', assert: (x,a) => { a.equal(x.copies, 0); a.ok(x.visits <= 5); a.equal(x.ops, 3) } }
    ] },
  { id: 'R09-matrix', name: 'real rich text/note/image/attachment/summary operations retain server undo authority',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap, data = f.tree(4)
      editor.component.addRichTextPlugin()
      await f.waitRender(mm, () => mm.setData(data)); await f.pause(100)
      const baseline = mm.command.getCopyData(), v2 = await f.connectV2(mm, baseline)
      const count = f.mount(f.Count, { mindMap: mm }), rows = []
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
      canvas.getContext('2d').fillRect(0, 0, 2, 2)
      const image = canvas.toDataURL()
      const cases = [
        ['richText', 'n0', ['text', 'richText'], () => mm.renderer.findNodeByUid('n0').setText('<p>丰富<b>文字</b></p>', true)],
        ['note', 'n0', ['note'], () => mm.execCommand('SET_NODE_NOTE', mm.renderer.findNodeByUid('n0'), 'Note preserved')],
        ['image', 'n0', ['image', 'imageSize'], () => mm.execCommand('SET_NODE_IMAGE', mm.renderer.findNodeByUid('n0'), { url: image, title: 'Local image', width: 24, height: 24 })],
        ['attachment', 'n0', ['attachmentUrl', 'attachmentName', 'attachmentId'], () => mm.execCommand('SET_NODE_ATTACHMENT', mm.renderer.findNodeByUid('n0'), '/synthetic-attachment.pdf', 'attachment.pdf', { attachmentId: 'fixture-attachment', attachmentStatus: 'ready', attachmentMimeType: 'application/pdf' })],
        ['summary', 'n1', ['generalization'], () => mm.execCommand('ADD_GENERALIZATION', { text: '<p>Summary text</p>', richText: true, expand: true, children: [{ data: { uid: 'summary-matrix-child', text: '<p>Summary child</p>', richText: true, expand: true, isActive: false }, children: [] }] }, false, [mm.renderer.findNodeByUid('n1')])]
      ]
      const state = () => f.requestMemory('state', { roomKey: v2.roomKey })
      const canonical = value => JSON.parse(JSON.stringify(value, (key, item) =>
        ['isActive', 'inserting', 'resetRichText', 'expand'].includes(key) || (key === 'range' && item == null) ? undefined : item))
      const pick = (node, keys) => canonical(Object.fromEntries(keys.map(key => {
        const value = key === 'image' && node.getImageUrl ? node.getImageUrl() : node.data[key]
        return [key, value == null || value === '' ? null : value]
      })))
      for (const [name, uid, keys, action] of cases) {
        const before = pick((await state()).nodes[uid], keys)
        await action(); await f.pause(500); await v2.co.flushHttpTextNow(); await f.pause(80)
        const saved = await state(), after = pick(saved.nodes[uid], keys)
        const visibleAfter = pick({ data: mm.renderer.findNodeByUid(uid).getData(), getImageUrl: mm.renderer.findNodeByUid(uid).getImageUrl.bind(mm.renderer.findNodeByUid(uid)) }, keys)
        mm.execCommand('BACK'); await v2.co._v2HistoryQueue; await f.pause(200)
        const undo = pick((await state()).nodes[uid], keys), visibleUndo = pick({ data: mm.renderer.findNodeByUid(uid).getData(), getImageUrl: mm.renderer.findNodeByUid(uid).getImageUrl.bind(mm.renderer.findNodeByUid(uid)) }, keys)
        mm.execCommand('FORWARD'); await v2.co._v2HistoryQueue; await f.pause(200)
        const redo = pick((await state()).nodes[uid], keys), visibleRedo = pick({ data: mm.renderer.findNodeByUid(uid).getData(), getImageUrl: mm.renderer.findNodeByUid(uid).getImageUrl.bind(mm.renderer.findNodeByUid(uid)) }, keys)
        rows.push({ name, changed: JSON.stringify(after) !== JSON.stringify(before), before, after, undo, redo, visibleAfter, visibleUndo, visibleRedo,
          operations: name === 'summary' ? saved.operations.slice(-3) : undefined })
      }
      const result = { rows, ordinaryCount: count.component.num, nativeSnapshots: mm.command.history.length, words: count.component.words }
      await v2.adapter.disconnect(); f.unmount(count); f.unmount(editor)
      return result
    }), checks: [
      { name: 'all five real feature edits persist and server inverse restores their visible values', assert: (x,a) => x.rows.forEach(row => { a.equal(row.changed, true, row.name + ' did not persist'); a.deepEqual(row.visibleAfter, row.after, row.name + ' visible commit'); a.deepEqual(row.undo, row.before, row.name + ' server undo'); a.deepEqual(row.visibleUndo, row.before, row.name + ' visible undo'); a.deepEqual(row.redo, row.after, row.name + ' server redo'); a.deepEqual(row.visibleRedo, row.after, row.name + ' visible redo') }) },
      { name: 'summary children keep original statistics scope and V2 has no local snapshots', assert: (x,a) => { a.equal(x.ordinaryCount, 5); a.equal(x.nativeSnapshots, 0); a.ok(x.words > 0) } }
    ] },
  { id: 'R09-native-mixed', name: 'native move/delete undo retains summaries and attachments within default budgets',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.tree(4)), n0 = mm.renderer.findNodeByUid('n0')
      mm.execCommand('SET_NODE_ATTACHMENT', n0, '/synthetic.pdf', 'synthetic.pdf', { attachmentId: 'native-att', attachmentStatus: 'ready' })
      await f.pause(50)
      mm.execCommand('SET_NODE_DATA', mm.renderer.findNodeByUid('n1'), { generalization: [{ uid: 'native-summary', text: 'Native summary', children: [] }] })
      await f.waitRender(mm, () => mm.render())
      await f.waitRender(mm, () => mm.execCommand('MOVE_NODE_TO', mm.renderer.findNodeByUid('n2'), mm.renderer.findNodeByUid('n1')))
      const moved = mm.renderer.findNodeByUid('n2').parent.uid
      await f.waitRender(mm, () => mm.execCommand('REMOVE_NODE', mm.renderer.findNodeByUid('n2')))
      const deleted = !mm.renderer.findNodeByUid('n2')
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      const restoredParent = mm.renderer.findNodeByUid('n2')?.parent.uid
      const attachment = mm.renderer.findNodeByUid('n0').getData('attachmentId')
      const summary = mm.renderer.findNodeByUid('native-summary')?.getData('text')
      await f.waitRender(mm, () => mm.execCommand('FORWARD'))
      const redoneDeleted = !mm.renderer.findNodeByUid('n2')
      return { moved, deleted, restoredParent, attachment, summary, redoneDeleted,
        maxCount: mm.opt.maxHistoryCount, maxBytes: mm.opt.maxHistoryBytes, historyBytes: mm.command.historyBytes }
    }), checks: [
      { name: 'native inverse restores move location with unrelated structured features', assert: (x,a) => { a.equal(x.moved, 'n1'); a.equal(x.deleted, true); a.equal(x.restoredParent, 'n1'); a.equal(x.attachment, 'native-att'); a.equal(x.summary, 'Native summary'); a.equal(x.redoneDeleted, true) } },
      { name: 'default count and serialized byte caps are active', assert: (x,a) => { a.equal(x.maxCount, 100); a.equal(x.maxBytes, 32 * 1024 * 1024); a.ok(x.historyBytes <= x.maxBytes) } }
    ] },
  { id: 'R09-budget-ui', name: 'real native toolbar explains the retained undo range after budget eviction',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.tree(2), { maxHistoryBytes: 1024 }), toolbar = f.mount(f.ToolbarNodeBtnList, { list: ['back', 'forward'] })
      let lastStatus
      mm.on('back_forward', (index, length, status) => { lastStatus = status; f.bus.$emit('back_forward', index, length, status) })
      mm.renderer.findNodeByUid('n0').setText('Large current state ' + 'x'.repeat(2000), false); await f.pause(80); await f.Vue.nextTick()
      const result = { status: lastStatus || null, title: toolbar.root.$el.querySelector('.toolbarBtn').title,
        canUndo: !toolbar.component.backEnd, entries: mm.command.history.length, bytes: mm.command.historyBytes }
      f.unmount(toolbar); mm.destroy()
      return result
    }), checks: [
      { name: 'oversized current baseline remains available and reports a zero-step range', assert: (x,a) => { a.equal(x.entries, 1); a.ok(x.bytes > 1024); a.equal(x.status && x.status.undoSteps, 0); a.equal(x.status && x.status.limited, true); a.equal(x.canUndo, false) } },
      { name: 'actual Undo button exposes the limited available range', assert: (x,a) => { a.ok(x.title.includes('toolbar.undoRangeLimited')); a.ok(x.title.includes('0')) } }
    ] },
  { id: 'R09', name: 'native back/forward and real adapter plus engine V2 undo/redo remain usable',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.tree(6)), local = mm.renderer.findNodeByUid('n0')
      local.setText('Local edit', false); await f.pause(50)
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      const localUndo = mm.renderer.findNodeByUid('n0').getData('text') === 'Node 0'
      await f.waitRender(mm, () => mm.execCommand('FORWARD'))
      const localRedo = mm.renderer.findNodeByUid('n0').getData('text') === 'Local edit'
      const data = f.tree(6)
      await f.waitRender(mm, () => mm.setData(data))
      const v2 = await f.connectV2(mm, data)
      mm.renderer.findNodeByUid('n0').setText('V2 edit', false)
      await f.pause(350); await v2.co.flushHttpTextNow(); await f.pause(50)
      const submitted = await f.requestMemory('state', { roomKey: v2.roomKey })
      mm.execCommand('BACK'); await v2.co._v2HistoryQueue; await f.pause(100)
      const undo = await f.requestMemory('state', { roomKey: v2.roomKey })
      const visibleUndo = mm.renderer.findNodeByUid('n0').getData('text')
      mm.execCommand('FORWARD'); await v2.co._v2HistoryQueue; await f.pause(100)
      const redo = await f.requestMemory('state', { roomKey: v2.roomKey })
      const visibleRedo = mm.renderer.findNodeByUid('n0').getData('text')
      await v2.adapter.disconnect()
      // Budget behavior is exercised through the actual Command implementation,
      // not by fabricating a replacement history stack.
      mm.cooperate.setCollabV2Adapter(null); mm.cooperate.httpCollabMode = false
      mm.updateConfig({ maxHistoryBytes: 1024, maxHistoryCount: 100 })
      for (let i = 0; i < 15; i++) { mm.renderer.findNodeByUid('n1').setText('Long text ' + 'x'.repeat(250) + i, false); await f.pause(5) }
      const historyBytes = mm.command.history.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0)
      const currentBytes = new TextEncoder().encode(mm.command.history[mm.command.activeHistoryIndex] || '').length
      return { localUndo, localRedo, submitted: submitted.nodes.n0.data.text, undo: undo.nodes.n0.data.text,
        redo: redo.nodes.n0.data.text, visibleUndo, visibleRedo, historyBytes, currentBytes,
        historyCount: mm.command.history.length }
    }), checks: [
      { name: 'native and V2 visible/server undo and redo remain correct', assert: (x, a) => { a.equal(x.localUndo, true); a.equal(x.localRedo, true); a.equal(x.submitted, 'V2 edit'); a.equal(x.undo, 'Node 0'); a.equal(x.visibleUndo, 'Node 0'); a.equal(x.redo, 'V2 edit'); a.equal(x.visibleRedo, 'V2 edit') } },
      { name: 'native byte budget retains only current baseline when one snapshot exceeds budget', assert: (x, a) => { a.ok(x.historyBytes <= Math.max(1024, x.currentBytes), 'history bytes ' + x.historyBytes + ', baseline ' + x.currentBytes); a.ok(x.historyCount >= 1) } }
    ] }
])
