const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const test = require('node:test')
const source = fs.readFileSync(require.resolve('../src/plugins/Cooperate.js'), 'utf8')
function method(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
}
const methods = vm.runInNewContext(`({
${method('  findTreeNode(root, uid) {', '  expandTreeNode(node) {')},
${method('  expandTreeNode(node) {', '  async ensureHttpNodePath(')},
${method('  async ensureHttpNodePath(', '  async syncHttpDirtySubtrees(treeNodeIndex) {')},
${method('  applyHttpRemoteNodeFields(node, next = {}, merged = {}) {', '  syncGeneralizationChildStubs(')}
})`, {
  console,
  FV_KEY: '_fv',
  checkIsNodeStyleDataKey: () => false,
  collabNodeFeatures: {
    recreateTypesFromPatch: () => [],
    needsGeometryRefresh: () => true
  }
})

test('passive path hydration keeps collapsed ancestors; explicit reveal expands them', async () => {
  const root = { data: { uid: 'r', expand: false }, children: [] }
  const context = {
    ...methods,
    mindMap: { renderer: { renderTree: root } },
    isTombstonedUid: () => false,
    httpFetchLocate: async () => ({ ancestors: ['r', 'p'], nodes: {
      p: { data: { uid: 'p', expand: false }, children: [] }
    } }),
    mergeHttpChildren: (parent, kids) => parent.children.push(...kids),
    hydrateNodeData: async parent => {
      if (parent.data.uid === 'p') parent.children.push({ data: { uid: 'n' }, children: [] })
    },
    hydratedUids: new Set(), dirtySubtrees: new Map()
  }
  await context.ensureHttpNodePath('n', undefined, { expand: false })
  assert.equal(root.data.expand, false)
  assert.equal(root.children[0].data.expand, false)
  root.children = []
  await context.ensureHttpNodePath('n')
  assert.equal(root.data.expand, true)
  assert.equal(root.children[0].data.expand, true)
})

test('unchanged HTTP records do not recreate nodes; changed batch defers layout', () => {
  let redraws = 0
  let layouts = 0
  const data = { uid: 'n', text: 'old', note: '', tag: ['tag'] }
  const node = { nodeData: { data }, getData: () => data, reRender: () => redraws++ }
  const context = {
    ...methods,
    httpRefreshing: true,
    mindMap: { renderer: {}, render: () => layouts++ }
  }
  assert.equal(context.applyHttpRemoteNodeFields(node, { ...data, tag: ['tag'] }), false)
  assert.equal(redraws, 0)
  assert.equal(context.applyHttpRemoteNodeFields(node, { text: 'new' }), true)
  assert.equal(data.text, 'new')
  assert.equal(redraws, 1)
  assert.equal(layouts, 0)
  context.httpRefreshing = false
  context.applyHttpRemoteNodeFields(node, { text: 'newer' })
  assert.equal(layouts, 1)
})
