const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8'
)
const helper = source.slice(
  source.indexOf('function clearHydratedSelection(root) {'),
  source.indexOf('\nconst INSERT_COMMANDS')
)
const method = source.slice(
  source.indexOf('  mergeHttpChildren(data, incoming) {'),
  source.indexOf('\n  markUidPushed(', source.indexOf('  mergeHttpChildren(data, incoming) {'))
)
const moduleMock = { exports: {} }
vm.runInNewContext(`${helper}\nclass Hydrator {\n${method}\n}\nmodule.exports = Hydrator`, {
  module: moduleMock
})

test('revealing lazy children does not select them or their descendants', () => {
  const hydrator = new moduleMock.exports()
  hydrator.isTombstonedUid = () => false
  hydrator.markUidPushed = () => {}
  const parent = { data: { uid: 'parent', isActive: true }, children: [] }
  const incoming = [{
    data: { uid: 'child', isActive: true },
    children: [{ data: { uid: 'grandchild', isActive: true }, children: [] }]
  }]
  hydrator.mergeHttpChildren(parent, incoming)
  assert.equal(parent.data.isActive, true)
  assert.equal(parent.children[0].data.isActive, false)
  assert.equal(parent.children[0].children[0].data.isActive, false)
})


const activeMethod = source.slice(
  source.indexOf('  onNodeActive(node, nodeList) {'),
  source.indexOf('\n  ensureActiveSelection()', source.indexOf('  onNodeActive(node, nodeList) {'))
)
const expandMethod = source.slice(
  source.indexOf('  onExpandBtnClick(node) {'),
  source.indexOf('\n  async repairEmptyExpand(', source.indexOf('  onExpandBtnClick(node) {'))
)
const hooksModule = { exports: {} }
vm.runInNewContext(`class SelectionHooks {
${activeMethod}
${expandMethod}
}
module.exports = SelectionHooks`, {
  module: hooksModule
})

test('selecting a lazy collapsed node only updates presence and keeps children collapsed', () => {
  const hooks = new hooksModule.exports()
  const data = { uid: 'parent', expand: false, childCount: 3, isActive: true }
  const node = { uid: 'parent', nodeData: { data, children: [] }, getData: key => data[key] }
  let presence
  hooks.setLocalPresence = value => { presence = value }
  hooks.repairEmptyExpand = () => assert.fail('selecting must not load or expand children')
  hooks.onNodeActive(node, [node])
  assert.equal(data.expand, false)
  assert.equal(node.nodeData.children.length, 0)
  assert.deepEqual(Array.from(presence.selectedUids), ['parent'])
  assert.deepEqual(Array.from(hooks.lastActiveUids), ['parent'])
})

test('clicking the child count badge still requests lazy children', () => {
  const hooks = new hooksModule.exports()
  const data = { uid: 'parent', expand: false, childCount: 3 }
  const node = { nodeData: { data, children: [] }, getData: key => data[key] }
  let repaired
  hooks.repairEmptyExpand = target => { repaired = target }
  hooks.onExpandBtnClick(node)
  assert.equal(repaired, node)
  repaired = null
  node.nodeData.children = [{ data: { uid: 'child' }, children: [] }]
  hooks.onExpandBtnClick(node)
  assert.equal(repaired, null, 'loaded children do not need another fetch')
})
