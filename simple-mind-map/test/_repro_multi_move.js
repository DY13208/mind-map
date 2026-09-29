const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function loadClass(file, globals = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/export default (\w+)/, 'module.exports = $1')
  const module = { exports: {} }
  vm.runInNewContext(source, { module, ...globals }, { filename: file })
  return module.exports
}

const Node = loadClass('core/render/node/MindMapNode.js')

function removeFromParentNodeDataBroken(node) {
  if (!node || !node.parent) return
  const index = node.parent.nodeData.children.findIndex(item => {
    return item.data.uid === node.uid
  })
  if (index === -1) return
  node.parent.nodeData.children.splice(index, 1)
}

function removeFromParentNodeDataFixed(node) {
  if (!node || !node.parent) return
  const uid = (node.getData && node.getData('uid')) || node.uid
  const index = node.parent.nodeData.children.findIndex(item => {
    return item && item.data && item.data.uid === uid
  })
  if (index === -1) return
  node.parent.nodeData.children.splice(index, 1)
}

function makeRender(removeFromParentNodeData) {
  return loadClass('core/render/Render.js', {
    CONSTANTS: { LAYOUT: {} },
    LogicalStructure: class {},
    MindMap: class {},
    CatalogOrganization: class {},
    OrganizationStructure: class {},
    Timeline: class {},
    VerticalTimeline: class {},
    Fishbone: class {},
    formatDataToArray: value => (Array.isArray(value) ? value : [value]),
    getNodeIndexInNodeList: (node, nodeList) =>
      nodeList.findIndex(item => item.uid === node.uid),
    removeFromParentNodeData
  })
}

function node(uid, children = []) {
  const data = { uid, expand: true, text: uid }
  const result = Object.assign(Object.create(Node.prototype), {
    children,
    _lines: [],
    nodeData: { data, children: children.map(n => n.nodeData) },
    getData: key => (key ? data[key] : data),
    setData: patch => Object.assign(data, patch),
    removeLine() {
      this._lines.forEach(l => l.remove && l.remove())
      this._lines = []
    },
    uid
  })
  children.forEach(child => {
    child.parent = result
  })
  return result
}

function walkCount(data) {
  let n = 0
  const walk = d => {
    if (!d) return
    n++
    ;(d.children || []).forEach(walk)
  }
  walk(data)
  return n
}

function setup() {
  const a = node('a')
  const b = node('b')
  const c = node('c')
  const old = node('old', [a, b, c])
  const target = node('target')
  const root = node('root', [old, target])
  root.nodeData.children = [old.nodeData, target.nodeData]
  old.nodeData.children = [a.nodeData, b.nodeData, c.nodeData]
  target.nodeData.children = []
  return { a, b, c, old, target, root }
}

function bind(renderer) {
  return Object.assign(Object.create(renderer.prototype || renderer), {
    runAfterHydrate: () => false,
    removeNodeFromActiveList: () => {},
    emitNodeActiveEvent: () => {},
    isInvalidMoveTarget: renderer.prototype
      ? renderer.prototype.isInvalidMoveTarget
      : renderer.isInvalidMoveTarget,
    resetMovedNodePosition: renderer.prototype
      ? renderer.prototype.resetMovedNodePosition
      : renderer.resetMovedNodePosition,
    insertTo: renderer.prototype ? renderer.prototype.insertTo : renderer.insertTo,
    insertAfter: renderer.prototype
      ? renderer.prototype.insertAfter
      : renderer.insertAfter,
    insertBefore: renderer.prototype
      ? renderer.prototype.insertBefore
      : renderer.insertBefore,
    moveNodeTo: renderer.prototype
      ? renderer.prototype.moveNodeTo
      : renderer.moveNodeTo,
    mindMap: { render() {} }
  })
}

const RenderBroken = makeRender(removeFromParentNodeDataBroken)
const RenderFixed = makeRender(removeFromParentNodeDataFixed)

for (const [label, Render] of [
  ['broken-uid-index', RenderBroken],
  ['fixed-getData-uid', RenderFixed]
]) {
  const { a, b, c, old, target, root } = setup()
  const renderer = bind(Render)
  renderer.moveNodeTo([a, b], target)
  console.log(
    label,
    'MOVE_NODE_TO',
    JSON.stringify({
      oldLive: old.children.map(n => n.uid),
      oldData: old.nodeData.children.map(n => n.data.uid),
      targetLive: target.children.map(n => n.uid),
      targetData: target.nodeData.children.map(n => n.data.uid),
      count: walkCount(root.nodeData),
      expectedCount: 6
    })
  )
}

for (const [label, Render] of [
  ['broken-uid-index', RenderBroken],
  ['fixed-getData-uid', RenderFixed]
]) {
  const { a, b, c, old, target, root } = setup()
  const anchor = node('anchor')
  anchor.parent = target
  target.children = [anchor]
  target.nodeData.children = [anchor.nodeData]
  const renderer = bind(Render)
  renderer.insertAfter([a, b], anchor)
  console.log(
    label,
    'INSERT_AFTER',
    JSON.stringify({
      oldLive: old.children.map(n => n.uid),
      oldData: old.nodeData.children.map(n => n.data.uid),
      targetLive: target.children.map(n => n.uid),
      targetData: target.nodeData.children.map(n => n.data.uid),
      count: walkCount(root.nodeData),
      expectedCount: 7
    })
  )
}

// Simulate layout reuse when same nodeData appears under two parents
{
  const a = node('a')
  const old = node('old', [a])
  const neu = node('new')
  // BUG: a.nodeData still under old AND pushed under new
  neu.nodeData.children = [a.nodeData]
  old.nodeData.children = [a.nodeData]
  // layout-like: first attach under old, then reuse under new without scrubbing old.children
  old.children = [a]
  a.parent = old
  const prevParent = a.parent
  a.parent = neu
  neu.children = [a]
  // stale
  assert.strictEqual(prevParent.children.includes(a), true)
  console.log('stale-parent-children-demo', {
    oldLive: old.children.map(n => n.uid),
    aParent: a.parent.uid,
    wouldDrawExtraLine: old.children.length === 1 && a.parent !== old
  })
}
