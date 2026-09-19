const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

// Load production class methods without constructing the browser-only editor.
function loadClass(file, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/export default (\w+)/, 'module.exports = $1')
  const module = { exports: {} }
  vm.runInNewContext(source, { module, ...globals }, { filename: file })
  return module.exports
}

const Node = loadClass('core/render/node/MindMapNode.js')
const Render = loadClass('core/render/Render.js', {
  CONSTANTS: { LAYOUT: {} },
  LogicalStructure: class {}, MindMap: class {}, CatalogOrganization: class {},
  OrganizationStructure: class {}, Timeline: class {}, VerticalTimeline: class {}, Fishbone: class {},
  formatDataToArray: value => Array.isArray(value) ? value : [value],
  getNodeIndexInNodeList: (node, nodes) => nodes.indexOf(node),
  removeFromParentNodeData: node => {
    const siblings = node.parent.nodeData.children
    siblings.splice(siblings.indexOf(node.nodeData), 1)
  }
})

function node(uid, children = []) {
  const data = { uid, expand: true }
  const result = Object.assign(Object.create(Node.prototype), {
    children, _lines: [], nodeData: { data, children: children.map(n => n.nodeData) },
    getData: key => data[key],
    setData: patch => Object.assign(data, patch)
  })
  children.forEach(child => { child.parent = result })
  return result
}

function connector(owner) {
  const line = { removed: false, remove() { this.removed = true } }
  owner._lines.push(line)
  return line
}

test('collapsed render removes old outgoing connectors but keeps the incoming edge', () => {
  const parent = node('parent')
  const old = node('old')
  const incoming = connector(parent)
  const outgoing = connector(old)
  old.parent = parent
  old.setData({ expand: false, childCount: 1 })
  old.renderLine()
  assert.equal(outgoing.removed, true)
  assert.equal(old._lines.length, 0)
  assert.equal(incoming.removed, false)
})

for (const command of ['moveNodeTo', 'insertBefore', 'insertAfter']) {
  test(command + ' clears old connectors before the deferred render without changing siblings', () => {
    const a = node('a')
    a.customLeft = 100
    a.customTop = 200
    a.setData({ customLeft: 100, customTop: 200 })
    const sibling = node('sibling')
    const old = node('old', [a, sibling])
    const b = node('b')
    const target = node('target', [b])
    const stale = connector(old)
    const remaining = connector(old)
    let renderCalls = 0
    const renderer = Object.assign(Object.create(Render.prototype), {
      runAfterHydrate: () => false,
      removeNodeFromActiveList: () => {},
      emitNodeActiveEvent: () => {},
      mindMap: { render() {
        renderCalls++
        assert.equal(stale.removed, true)
        assert.equal(remaining.removed, true)
      } }
    })
    renderer[command](a, command === 'moveNodeTo' ? target : b)
    assert.equal(renderCalls, 1)
    assert.equal(a.parent, target)
    assert.equal(a.customLeft, undefined)
    assert.equal(a.customTop, undefined)
    assert.equal(a.getData('customLeft'), null)
    assert.equal(a.getData('customTop'), null)
    assert.deepEqual(old.children, [sibling])
    assert.deepEqual(old.nodeData.children, [sibling.nodeData])
    assert.equal(target.children.indexOf(a), command === 'insertBefore' ? 0 : 1)
    assert.equal(target.nodeData.children.indexOf(a.nodeData), command === 'insertBefore' ? 0 : 1)
  })
}

test('retiring an old node does not erase its live parents connectors', () => {
  const parent = node('parent')
  const old = node('old')
  old.parent = parent
  const liveLine = connector(parent)
  const oldLine = connector(old)
  old.destroy()
  assert.equal(oldLine.removed, true)
  assert.equal(liveLine.removed, false)
})

test('a replaced node cannot recreate connectors from a delayed callback', () => {
  const old = node('parent', [node('child')])
  const oldLine = connector(old)
  old.renderer = { nodeCache: { parent: node('parent') } }
  old.renderLine(true)
  assert.equal(oldLine.removed, true)
  assert.equal(old._lines.length, 0)
})

test('unused connector slots are removed when lazy data and visible children differ', () => {
  const parent = node('parent', [node('visible')])
  parent.nodeData.children.push({ data: { uid: 'lazy' }, children: [] })
  const keep = connector(parent)
  const stale = connector(parent)
  const layout = { renderLine(n, lines) { assert.equal(lines.length, n.children.length) } }
  parent.renderer = { nodeCache: { parent }, layout }
  parent.mindMap = { renderer: parent.renderer }
  parent.style = { getStyle: () => 'straight' }
  parent.renderLine()
  assert.equal(stale.removed, true)
  assert.equal(keep.removed, false)
})

for (const command of ['insertBefore', 'insertAfter']) {
  test(command + ' uses UIDs when lazy data order differs from rendered siblings', () => {
    const a = node('a')
    const other = node('other')
    const old = node('old', [a, other])
    const unloaded = { data: { uid: 'unloaded' }, children: [] }
    old.nodeData.children.unshift(unloaded)
    const b = node('b')
    const target = node('target', [b])
    const targetUnloaded = { data: { uid: 'target-unloaded' }, children: [] }
    target.nodeData.children.unshift(targetUnloaded)
    const renderer = Object.assign(Object.create(Render.prototype), {
      runAfterHydrate: () => false, mindMap: { render() {} }
    })
    renderer[command](a, b)
    assert.deepEqual(old.nodeData.children.map(n => n.data.uid), ['unloaded', 'other'])
    assert.deepEqual(target.nodeData.children.map(n => n.data.uid), command === 'insertBefore'
      ? ['target-unloaded', 'a', 'b'] : ['target-unloaded', 'b', 'a'])
  })
}

for (const command of ['moveNodeTo', 'insertBefore', 'insertAfter']) {
  test(command + ' rejects moving an ancestor into its descendant without touching lines or order', () => {
    const b = node('b')
    const middle = node('middle', [b])
    const a = node('a', [middle])
    const root = node('root', [a])
    const line = connector(root)
    const renderer = Object.assign(Object.create(Render.prototype), {
      runAfterHydrate: () => { throw new Error('invalid move must not hydrate') },
      mindMap: { render() { throw new Error('invalid move must not render') } }
    })
    renderer[command](a, b)
    assert.equal(a.parent, root)
    assert.deepEqual(root.children, [a])
    assert.deepEqual(a.children, [middle])
    assert.equal(line.removed, false)
  })
}

test('normal render cleanup removes only orphan node groups and tree connectors', () => {
  const artifact = (className) => ({ removed: false, hasClass: name => name === className, remove() { this.removed = true } })
  const liveGroup = artifact('smm-node'), oldGroup = artifact('smm-node')
  const summaryGroup = artifact('smm-node'), summaryChildGroup = artifact('smm-node')
  const liveLine = artifact('smm-tree-connector'), oldLine = artifact('smm-tree-connector')
  const summaryLine = artifact('generalization'), otherOverlay = artifact('other')
  const renderer = Object.assign(Object.create(Render.prototype), {
    nodeCache: { a: { group: liveGroup, _lines: [liveLine], _generalizationList: [
      { generalizationNode: { group: summaryGroup, children: [{ group: summaryChildGroup }] } }
    ] } },
    mindMap: { nodeDraw: { children: () => [liveGroup, oldGroup, summaryGroup, summaryChildGroup, otherOverlay] },
      lineDraw: { children: () => [liveLine, oldLine, summaryLine] } }
  })
  renderer.sweepOrphanNodeGroups()
  assert.equal(oldGroup.removed, true)
  assert.equal(oldLine.removed, true)
  for (const item of [liveGroup, summaryGroup, summaryChildGroup, otherOverlay, liveLine, summaryLine]) assert.equal(item.removed, false)
})
