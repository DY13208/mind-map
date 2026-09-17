const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

// Load the real layout method without requiring the browser side ESM loader.
const source = fs
  .readFileSync(require.resolve('../src/layouts/Base.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export default Base', 'module.exports = Base')

function walk(tree, parent, visit, after, isRoot, layerIndex, ancestors) {
  visit(tree, parent, !!isRoot, layerIndex || 0, 0, ancestors || [])
  ;(tree.children || []).forEach((child, index) => {
    walk(child, tree, visit, after, false, (layerIndex || 0) + 1, [])
    if (after) after(child, tree, false, (layerIndex || 0) + 1)
  })
  if (after) after(tree, parent, !!isRoot, layerIndex || 0)
}

const sandbox = {
  module: { exports: {} },
  CONSTANTS: { LAYOUT: { ORGANIZATION_STRUCTURE: 'organization' } },
  initRootNodePositionMap: () => ({}),
  Lru: function () {},
  createUid: (() => {
    let index = 0
    return () => `generated-${++index}`
  })(),
  walk
}
vm.runInNewContext(source, sandbox)
const Base = sandbox.module.exports
const nodeSource = fs.readFileSync(require.resolve('../src/core/render/node/MindMapNode.js'), 'utf8')
const removeSource = nodeSource.match(/  remove\(\) \{[\s\S]*?\r?\n  \}/)[0]
const removeNode = vm.runInNewContext(`({ ${removeSource} }).remove`)
const attachedGroups = new Set()

function data(uid, children = [], expand = true) {
  return { data: { uid, expand }, children }
}

function renderedNode(uid, parent) {
  const node = {
    uid,
    parent,
    children: [],
    width: 20,
    height: 10,
    removed: false,
    remove: removeNode,
    removeLine() {},
    removeGeneralization() {},
    getData(key) {
      if (key === 'uid') return this.uid
      if (key === 'expand') return true
      return undefined
    }
  }
  node.group = { remove() { node.removed = true; attachedGroups.delete(node.group) } }
  attachedGroups.add(node.group)
  return node
}

function createLayout() {
  const layout = Object.create(Base.prototype)
  layout.getMarginY = () => 5
  layout.createNode = (item, parent) => {
    const node = renderedNode(item.data.uid, parent)
    item._node = node
    parent._node.children.push(node)
    return node
  }
  return layout
}

function createGeneralizationRoot(tree) {
  return {
    nodeData: tree,
    children: [],
    childrenAreaHeight: 0,
    layerIndex: 1,
    getData(key) {
      if (key === 'expand') return this.nodeData.data.expand
      if (key === 'uid') return this.nodeData.data.uid
      return this.nodeData.data[key]
    }
  }
}

const layout = createLayout()
const old = renderedNode('old')
const oldGrandchild = renderedNode('old-grandchild', old)
old.children.push(oldGrandchild)
const tree = data('summary', [data('child-1')])
const root = createGeneralizationRoot(tree)
root.children.push(old)
layout.createGeneralizationChildNodes(root)
assert.strictEqual(old.removed, true, 'rebuilding removes the old SVG group')
assert.strictEqual(attachedGroups.has(old.group), false)
assert.strictEqual(attachedGroups.has(oldGrandchild.group), false, 'real remove recursively detaches descendants')
assert.strictEqual(root.children.length, 1)
assert.strictEqual(root.children[0].uid, 'child-1')

const first = root.children[0]
tree.children.push(data('child-2'))
layout.createGeneralizationChildNodes(root)
assert.strictEqual(first.removed, true, 'a second rebuild removes the prior group')
assert.strictEqual(root.children.length, 2)
assert.strictEqual(root.children[0].uid, 'child-1')
assert.strictEqual(root.children[1].uid, 'child-2')
assert.strictEqual(attachedGroups.size, 2, 'only current groups can receive pointer events')
root.children.forEach(node => assert.ok(attachedGroups.has(node.group)))

tree.children = []
layout.createGeneralizationChildNodes(root)
assert.strictEqual(root.children.length, 0, 'empty summaries have no child groups')
assert.strictEqual(root.childrenAreaHeight, 0)
assert.strictEqual(attachedGroups.size, 0, 'empty summaries must detach all old groups')

const collapsed = data('collapsed', [data('hidden')], false)
const collapsedRoot = createGeneralizationRoot(collapsed)
const hidden = renderedNode('hidden-old')
collapsedRoot.children.push(hidden)
layout.createGeneralizationChildNodes(collapsedRoot)
assert.strictEqual(hidden.removed, true, 'collapsing removes hidden child groups')
assert.strictEqual(collapsedRoot.children.length, 0)
assert.strictEqual(collapsedRoot.childrenAreaHeight, 0)

console.log('generalization child lifecycle tests passed')
