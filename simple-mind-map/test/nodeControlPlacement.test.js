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

const { updateExpandBtnPos, renderExpandBtn, removeExpandBtn } = loadMethods('nodeExpandBtn.js')
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
assert.equal(layoutCalls, 1, 'expanded collapse control uses the branch junction')
updateExpandBtnPos.call(parent)
assert.equal(layoutCalls, 2, 'rerender keeps the layout-owned position')
parent.expand = false
updateExpandBtnPos.call(parent)
assert.equal(layoutCalls, 3, 'collapsed badge retains the layout trailing position')

let removed = 0
const activeParent = {
  isGeneralization: false,
  isRoot: false,
  mindMap: { opt: { isShowCreateChildBtnIcon: true, readonly: false, alwaysShowExpandBtn: false } },
  _expandBtn: { remove() { removed++ } },
  _showExpandBtn: true,
  getChildrenLength() { return 2 },
  getData(key) { return key === 'isActive' ? true : key === 'expand' ? true : null },
  removeExpandBtn
}
renderExpandBtn.call(activeParent)
assert.equal(removed, 1, 'selected expanded parent shows only add-child at the junction')
assert.equal(activeParent._showExpandBtn, false)
activeParent.mindMap.opt.alwaysShowExpandBtn = true
activeParent._showExpandBtn = true
renderExpandBtn.call(activeParent)
assert.equal(removed, 2, 'always-show preference still avoids overlapping actions')

const group = { add() {} }
const quickBtn = {
  x: 0,
  y: 0,
  parent() { return group },
  transform() { return { translateX: this.x, translateY: this.y } },
  translate(dx, dy) { this.x += dx; this.y += dy }
}
let quickLayoutCalls = 0
const quickParent = {
  isGeneralization: false,
  isRoot: false,
  width: 80,
  height: 30,
  expandBtnSize: 20,
  canonical: [80, 15],
  mindMap: { opt: { readonly: false } },
  group,
  _quickCreateChildBtn: quickBtn,
  _showQuickCreateChildBtn: false,
  renderer: { layout: { renderExpandBtn(node, button) {
    quickLayoutCalls++
    button.translate(node.canonical[0] - button.x, node.canonical[1] - button.y)
  } } },
  getChildrenLength() { return 1 },
  getData(key) { return key === 'expand' ? this.expand : null },
  expand: true
}
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, 1, 'selected expanded parent shows add-child at trailing edge')
assert.deepEqual([quickBtn.x, quickBtn.y], [80, 15], 'add-child occupies the branch junction')
showQuickCreateChildBtn.call(quickParent)
assert.deepEqual([quickBtn.x, quickBtn.y], [80, 15], 'rerender does not drift add-child')
quickParent.canonical = [-20, 15]
showQuickCreateChildBtn.call(quickParent)
assert.deepEqual([quickBtn.x, quickBtn.y], [-20, 15], 'left branches use their own junction')
quickParent.canonical = [30, 40]
showQuickCreateChildBtn.call(quickParent)
assert.deepEqual([quickBtn.x, quickBtn.y], [30, 40], 'vertical branches use their own junction')
const placedCalls = quickLayoutCalls
quickParent.expand = false
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, placedCalls, 'collapsed parent does not overlap its count badge')
quickParent.expand = true
quickParent.mindMap.opt.readonly = true
showQuickCreateChildBtn.call(quickParent)
assert.equal(quickLayoutCalls, placedCalls, 'read-only nodes do not expose an edit action')

console.log('node control placement tests passed')
