const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const nodeDescendantCount = require('../src/utils/nodeDescendantCount')

// Exercise the real badge update method with an SVG adapter. Mouseover calls
// it before click, so unchanged badges must retain their existing elements.
const source = fs.readFileSync(require.resolve(
  '../src/core/render/node/nodeExpandBtn.js'
), 'utf8').replace(/^import .*\r?\n/gm, '')
  .replace('export default {', 'module.exports = {')
const sandbox = { module: { exports: {} }, nodeDescendantCount,
  isUndef: value => value === undefined }
vm.runInNewContext(source, sandbox)
const { updateExpandBtnNode } = sandbox.module.exports
let clears = 0
let label = ''
const fill = {}
;['stroke', 'size', 'radius', 'x', 'y'].forEach(key => {
  fill[key] = () => fill
})
const node = {
  nodeData: { data: { expand: false, childCount: 9, descendantCount: 254 }, children: [] },
  getData() { return this.nodeData.data },
  mindMap: { opt: { isShowExpandNum: true, expandBtnStyle: { strokeColor: '#333' } } },
  expandBtnSize: 20,
  createExpandNodeContent() {},
  _expandBtn: { clear() { clears++ }, add() { return this } },
  _openExpandNode: { text(value) { label = value } },
  _fillExpandNode: fill
}
updateExpandBtnNode.call(node)
assert.strictEqual(label, '254')
assert.strictEqual(clears, 1)
updateExpandBtnNode.call(node)
assert.strictEqual(clears, 1, 'hover must not detach the target of the next click')
node.nodeData.data.descendantCount = 253
updateExpandBtnNode.call(node)
assert.strictEqual(label, '253', 'a folded badge refreshes without toggling expand')
assert.strictEqual(clears, 2)
console.log('badge refresh and stable click target tests passed')
