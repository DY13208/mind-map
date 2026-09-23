const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadMethods(file) {
  const source = fs.readFileSync(path.join(__dirname, '../src/core/render/node', file), 'utf8')
    .replace(/^import .*\r?\n/gm, '')
    .replace('export default {', 'module.exports = {')
  const sandbox = { module: { exports: {} } }
  vm.runInNewContext(source, sandbox)
  return sandbox.module.exports
}

const { updateExpandBtnPos } = loadMethods('nodeExpandBtn.js')
const { showQuickCreateChildBtn } = loadMethods('quickCreateChildBtn.js')

const btn = {
  x: 0,
  y: 0,
  transform() { return { translateX: this.x, translateY: this.y } },
  translate(dx, dy) { this.x += dx; this.y += dy }
}
let layoutCalls = 0
const parent = {
  width: 80,
  height: 30,
  expandBtnSize: 20,
  expand: true,
  _expandBtn: btn,
  getData(key) { return key === 'expand' ? this.expand : null },
  renderer: { layout: { renderExpandBtn() { layoutCalls++ } } }
}
updateExpandBtnPos.call(parent)
assert.deepEqual([btn.x, btn.y], [30, -16], 'expanded collapse control is centered above the node')
updateExpandBtnPos.call(parent)
assert.deepEqual([btn.x, btn.y], [30, -16], 'rerender does not drift the control')
parent.expand = false
updateExpandBtnPos.call(parent)
assert.equal(layoutCalls, 1, 'collapsed badge retains the layout trailing position')

const group = { add() {} }
const quickBtn = { parent() { return group } }
let quickLayoutCalls = 0
const quickParent = {
  isGeneralization: false,
  mindMap: { opt: { readonly: false } },
  group,
  _quickCreateChildBtn: quickBtn,
  _showQuickCreateChildBtn: false,
  renderer: { layout: { renderExpandBtn() { quickLayoutCalls++ } } },
  getChildrenLength() { return 1 },
  getData(key) { return key === 'expand' ? this.expand : null },
  expand: true
}
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, 1, 'selected expanded parent shows add-child at trailing edge')
quickParent.expand = false
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, 1, 'collapsed parent does not overlap its count badge')
quickParent.expand = true
quickParent.mindMap.opt.readonly = true
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, 1, 'read-only nodes do not expose an edit action')

console.log('node control placement tests passed')
