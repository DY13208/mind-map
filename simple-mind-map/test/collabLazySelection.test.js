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
