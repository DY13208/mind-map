const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
const start = source.indexOf('    async applyPreview(preview, silent, attemptId) {')
const end = source.indexOf('    async promptSopConfirmation(', start)
assert.ok(start >= 0 && end > start)

const actions = []
const listeners = new Map()
let renderOutcome = 'render_complete'
const cooperate = {
  safeLoadMode: false,
  setPreviewApplied(value, options) { actions.push(['preview', value, options]) },
  hydrateRoomMetadata() { actions.push(['metadata']) },
  markTreeUids() {}, seedPreviewHydration() {},
  hydrateExpandedPartialParents() { actions.push(['hydrate']); return Promise.resolve() },
  scheduleHttpStructureSync() {}
}
const mindMap = {
  cooperate,
  renderer: { renderTree: null, cancelRender() { actions.push(['cancel']) } },
  view: { reset() { actions.push(['reset']) }, fit() { actions.push(['fit']) } },
  on(event, callback) { listeners.set(event, callback) },
  off(event, callback) { if (listeners.get(event) === callback) listeners.delete(event) }
}
const sandbox = {
  window: {}, console, setTimeout, clearTimeout,
  countNodes(root) { return 1 + (root.children || []).length },
  stubImportedTree(root, options) {
    actions.push(['stub', options.maxChildren])
    root.children = root.children.slice(0, options.maxChildren)
    root.children.forEach(child => { child.data.expand = false; child.children = [] })
  },
  getRuntimeConfig() { return { collabV2: false } }
}
const applyPreview = vm.runInNewContext('({' + source.slice(start, end) + '})', sandbox).applyPreview
const editSource = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/Edit.vue'), 'utf8')
const loadingStart = editSource.indexOf('    handleShowLoading(text, durationOrOptions) {')
const loadingEnd = editSource.indexOf('    updateImportProgress(', loadingStart)
assert.ok(loadingStart >= 0 && loadingEnd > loadingStart)
let loadingCalls = 0
const handleShowLoading = vm.runInNewContext('({' + editSource.slice(loadingStart, loadingEnd) + '})', {
  showLoading() { loadingCalls++ }, setTimeout() { return 1 }, clearTimeout
}).handleShowLoading
const importSource = fs.readFileSync(path.join(__dirname, '../src/utils/importTree.js'), 'utf8')
const importRuntime = {
  nodeDescendantCount: require('../../simple-mind-map/src/utils/nodeDescendantCount'),
  treeTask() {}
}
vm.runInNewContext(importSource.replace(/^import .*$/gm, '').replace(/^export /gm, ''), importRuntime)

async function main() {
  const loadingHost = { enableShowLoading: false, loadingSafetyTimer: null }
  handleShowLoading.call(loadingHost)
  assert.equal(loadingCalls, 0, 'empty appearance events must not show an overlay')
  handleShowLoading.call(loadingHost, '正在导入')
  assert.equal(loadingCalls, 1, 'explicit import progress remains available')
  const component = {
    _openAttemptId: 1, mindMap, roomName: 'room', $route: { query: {} },
    $bus: { $emit(event, tree) {
      assert.equal(event, 'setData')
      actions.push(['setData', tree.children.length])
      mindMap.renderer.renderTree = tree
      setTimeout(() => listeners.get(renderOutcome)?.(), 0)
    } },
    $nextTick: async () => {}, $message: { success() {} },
    useCollabV2: () => false, applyAccess() {},
    enableHttpCollab() {}, markHttpConnected() {}, loadMembers() {},
    afterMapOpened: async () => {}, setCooperateStatus() {}
  }
  const tree = { data: { uid: 'root', expand: false }, children: Array.from({ length: 80 }, (_, i) => ({ data: { uid: 'n' + i, expand: true }, children: [{}] })) }
  const result = await applyPreview.call(component, { tree, safe_load: true }, true, 1)
  assert.equal(result, true)
  assert.equal(component.largeMapInitialOverview, true)
  assert.equal(tree.data.expand, true)
  assert.equal(tree.children.length, 24)
  assert.ok(actions.findIndex(item => item[0] === 'metadata') < actions.findIndex(item => item[0] === 'setData'))
  assert.ok(actions.some(item => item[0] === 'fit'))
  assert.ok(!actions.some(item => item[0] === 'hydrate'))
  assert.equal(actions.find(item => item[0] === 'preview' && item[1] === true)[2].hydrateExpanded, false)
  const local = { data: { uid: 'local' }, children: Array.from({ length: 10000 }, (_, i) => ({ data: { uid: 'l' + i }, children: [] })) }
  importRuntime.prepareImportedTree({ root: local })
  assert.equal(local.children.length, 24)
  assert.equal(importRuntime.countNodes(local), 10001, 'hidden siblings remain in the complete local tree')
  const staleStart = actions.length
  component._openAttemptId = 2
  const stale = applyPreview.call(component, { tree: { data: { uid: 'stale' }, children: [] }, safe_load: true }, true, 2)
  component._openAttemptId = 3
  assert.equal(await stale, false)
  assert.ok(!actions.slice(staleStart).some(item => item[0] === 'fit'))

  renderOutcome = 'render_error'
  await assert.rejects(
    applyPreview.call(component, { tree: { data: { uid: 'failed' }, children: [] }, safe_load: true }, true, 3),
    /概览绘制失败/
  )
  assert.ok(actions.some(item => item[0] === 'cancel'))
  console.log('PASS: large room opens from a shallow, fitted overview without automatic hydration')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
