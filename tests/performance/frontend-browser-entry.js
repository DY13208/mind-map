import Vue from '../../web/node_modules/vue/dist/vue.esm.js'
import store from '../../web/src/store.js'
import MindMap from '../../simple-mind-map/index.js'
import Edit from '../../web/src/pages/Edit/components/Edit.vue'
import Navigator from '../../web/src/pages/Edit/components/Navigator.vue'
import Count from '../../web/src/pages/Edit/components/Count.vue'
import Outline from '../../web/src/pages/Edit/components/Outline.vue'
import ToolbarNodeBtnList from '../../web/src/pages/Edit/components/ToolbarNodeBtnList.vue'
import ElTree from '../../web/node_modules/element-ui/lib/tree.js'
import { createCollaborationAdapter } from '../../simple-mind-map/bin/collabV2/adapter.js'
import { PDFDocument } from '../../simple-mind-map/node_modules/pdf-lib/es/index.js'

// These are external UI boundaries. Edit, Navigator, Count, the bus, IndexedDB,
// commands, plugins and renderer below are the real production implementations.
const bus = new Vue()
Vue.component('el-tree', ElTree)
Vue.prototype.$bus = bus
Vue.prototype.$t = (key, parameters) => key + (parameters ? JSON.stringify(parameters) : '')
Vue.prototype.$message = Object.assign(() => {}, { info() {}, warning() {}, error() {}, success() {} })
Vue.prototype.$confirm = () => Promise.resolve()
Vue.prototype.$route = { query: {} }
Vue.prototype.$router = { push() {}, replace() {} }
store.state.localConfig.enableAi = false
store.state.localConfig.isZenMode = true
store.state.localConfig.openNodeRichText = false
store.state.localConfig.showNavigator = false
store.state.localConfig.showNavigatorToolbar = false

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function tree(count = 80, extra = {}) {
  return { data: { uid: 'root', text: 'Root', expand: true, ...extra }, children:
    Array.from({ length: count }, (_, i) => ({ data: { uid: 'n' + i, text: 'Node ' + i, expand: true }, children: [] })) }
}
function waitRender(mm, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('production render timeout')) }, 15000)
    const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
    mm.on('node_tree_render_end', done)
    action()
  })
}
async function createEngine(data = tree(), options = {}) {
  const el = document.createElement('div')
  el.style.cssText = 'width:1100px;height:700px;position:relative'
  document.body.appendChild(el)
  const mm = new MindMap({ el, data, layout: 'logicalStructure', openPerformance: false,
    openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, createNewNodeBehavior: 'NOT_ACTIVE', ...options })
  await waitRender(mm, () => mm.render())
  await pause(20)
  return mm
}
function mount(Component, props = {}) {
  const root = new Vue({ store, render: h => h(Component, { props }) }).$mount()
  document.body.appendChild(root.$el)
  return { root, component: root.$children[0] }
}
async function mountEditor(room = '') {
  history.replaceState({}, '', room ? '/?room=' + encodeURIComponent(room) : '/')
  Vue.prototype.$route = { query: room ? { room } : {} }
  const components = {}
  Object.keys(Edit.components || {}).forEach(name => {
    components[name] = { name: 'TestBoundary' + name, render: h => h('span') }
  })
  // All actual Edit lifecycle/command/save methods remain intact. We stub only
  // unrelated child toolbars/dialogs; independent cases mount Count/Navigator.
  const MountedEdit = { ...Edit, components }
  const mounted = mount(MountedEdit)
  const deadline = Date.now() + 15000
  while (!mounted.component.mindMap || !mounted.component.mindMap.renderer.root || mounted.component.mindMap.renderer.isRendering) {
    if (Date.now() > deadline) throw new Error('real Edit mounted/init did not become ready: ' + JSON.stringify({
      mindMap: !!mounted.component.mindMap, data: !!mounted.component.mindMapData,
      root: !!mounted.component.mindMap?.renderer.root, rendering: mounted.component.mindMap?.renderer.isRendering,
      destroyed: mounted.component._isDestroyed, disposed: mounted.component._editorDisposed,
      dataUid: mounted.component.mindMapData?.root?.data?.uid
    }))
    await pause(20)
  }
  return mounted
}
function unmount(mounted) {
  mounted.root.$destroy()
  if (mounted.root.$el && mounted.root.$el.parentNode) mounted.root.$el.remove()
}
function spy(object, name) {
  const original = object[name]
  if (typeof original !== 'function') throw new Error('missing production method ' + name)
  const calls = []
  object[name] = function (...args) { calls.push(args); return original.apply(this, args) }
  return { calls, restore() { object[name] = original } }
}
function frames(mm) { return mm.outerFrame.outerFrameElList.length }
function summaryFixture(count = 80) {
  const data = tree(count)
  data.children[0].data.generalization = [{ uid: 'summary', text: 'Summary', expand: true, children: [
    { data: { uid: 'summary-child', text: 'Summary child', expand: true, generalization: [
      { uid: 'nested-summary', text: 'Nested summary', expand: true, children: [
        { data: { uid: 'nested-child', text: 'Nested child' }, children: [] }
      ] }
    ] }, children: [] }
  ] }]
  return data
}
async function requestMemory(path, data) {
  const response = await fetch('/perf-memory/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error(result.error || result.code), { code: result.code })
  return result
}
async function connectV2(mm, data, roomKey = 'frontend-' + crypto.randomUUID()) {
  await requestMemory('seed', { roomKey, tree: data })
  const handlers = new Map()
  const socket = {
    connected: true,
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return this },
    off(event, fn) { if (handlers.has(event)) handlers.get(event).delete(fn); return this },
    emit(event, payload, callback) { requestMemory('emit', { event, payload }).then(result => { if (callback) callback(result) }).catch(error => { if (callback) callback({ ok: false, code: error.code, error: error.message }) }); return this },
    disconnect() { this.connected = false }, connect() { this.connected = true }
  }
  const co = mm.cooperate
  const adapter = createCollaborationAdapter({ socket, clientId: 'perf-client-' + crypto.randomUUID(),
    timeoutMs: 4000, onRemoteOperation: op => co.applyV2RemoteOperation(op) })
  await adapter.connect({ roomKey, userId: 'perf-user', lastServerRevision: 0 })
  co.setCollabV2Adapter(adapter)
  co.setHttpCollab({ roomKey, version: 0, nodeCount: Object.keys(mm.renderer.nodeCache).length })
  // The production dialog establishes a server-loaded UID/content baseline.
  // Use its production baseline method so existing fixture nodes are not
  // mistaken for unacknowledged optimistic inserts by the text scanner.
  co.resyncHttpBaseline(mm.renderer.renderTree)
  co.establishV2HistoryBaseline()
  return { co, adapter, socket, roomKey }
}
window.perfFrontend = { Vue, store, bus, MindMap, Edit, Navigator, Count, Outline, ToolbarNodeBtnList, pause, tree, summaryFixture,
  waitRender, createEngine, mount, mountEditor, unmount, spy, frames, connectV2, requestMemory, PDFDocument }
