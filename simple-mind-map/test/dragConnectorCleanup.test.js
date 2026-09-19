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
    assert.deepEqual(old.children, [sibling])
    assert.deepEqual(old.nodeData.children, [sibling.nodeData])
    assert.equal(target.children.indexOf(a), command === 'insertBefore' ? 0 : 1)
    assert.equal(target.nodeData.children.indexOf(a.nodeData), command === 'insertBefore' ? 0 : 1)
  })
}
