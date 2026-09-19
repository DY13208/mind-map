const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../src/core/render/Render.js'), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
  .replace('export default Render', 'module.exports = Render')
const moduleMock = { exports: {} }
let nextId = 0
vm.runInNewContext(source, {
  module: moduleMock, console, CONSTANTS: { LAYOUT: {} },
  LogicalStructure: class {}, MindMap: class {}, CatalogOrganization: class {},
  OrganizationStructure: class {}, Timeline: class {}, VerticalTimeline: class {}, Fishbone: class {},
  formatDataToArray: x => Array.isArray(x) ? x : [x],
  addDataToAppointNodes: x => x, createUidForAppointNodes: x => x,
  simpleDeepClone: x => JSON.parse(JSON.stringify(x)), createUid: () => 'new-' + ++nextId
})
function node(uid) {
  const data = { uid }
  return { nodeData: { data, children: [] }, getData: key => data[key], setData: x => Object.assign(data, x) }
}
function fixture() {
  const original = node('a')
  const other = node('b')
  const nodes = new Map([['a', original], ['b', other]])
  const renderer = Object.assign(Object.create(moduleMock.exports.prototype), {
    activeNodeList: [original], findNodeByUid: uid => nodes.get(uid),
    textEdit: { hideEditTextBox() {} }, hasRichTextPlugin: () => false,
    getNewNodeBehavior: () => ({ focusNewNode: false, inserting: false }),
    mindMap: { opt: {}, render() {} }
  })
  return { original, other, nodes, renderer }
}
test('inserts into replacement node rather than detached original', () => {
  const { original, nodes, renderer } = fixture()
  const replacement = node('a')
  nodes.set('a', replacement)
  renderer.insertChildNode(false, [original])
  assert.equal(original.nodeData.children.length, 0)
  assert.equal(replacement.nodeData.children.length, 1)
})
test('does not resurrect a deleted target or insert into another active node', () => {
  const { original, other, nodes, renderer } = fixture()
  nodes.delete('a')
  renderer.activeNodeList = [other]
  renderer.insertChildNode(false, [original])
  assert.equal(original.nodeData.children.length, 0)
  assert.equal(other.nodeData.children.length, 0)
})
for (const deleted of [false, true]) {
  test('hydration preserves target across selection change; deleted=' + deleted, async () => {
    const { original, other, nodes, renderer } = fixture()
    let finish
    const hydrated = new Promise(resolve => { finish = resolve })
    const replacement = node('a')
    renderer.mindMap.cooperate = {
      nodeNeedsHydrate: n => n === original,
      ensurePlacementParent: () => hydrated
    }
    renderer.insertChildNode(false)
    renderer.activeNodeList = [other]
    if (deleted) nodes.delete('a')
    else nodes.set('a', replacement)
    finish()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(original.nodeData.children.length, 0)
    assert.equal(other.nodeData.children.length, 0)
    assert.equal(replacement.nodeData.children.length, deleted ? 0 : 1)
    assert.equal(renderer._lazyCommandPending, false)
  })
}
