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
const CONSTANTS = {
  LAYOUT: {
    LOGICAL_STRUCTURE: 'logicalStructure',
    LOGICAL_STRUCTURE_LEFT: 'logicalStructureLeft',
    COMPACT_STRUCTURE: 'compactStructure',
    MIND_MAP: 'mindMap'
  },
  LAYOUT_GROW_DIR: { LEFT: 'left', RIGHT: 'right' }
}
const sandbox = { module: { exports: {} }, nodeDescendantCount, CONSTANTS,
  isUndef: value => value === undefined }
vm.runInNewContext(source, sandbox)
const { updateExpandBtnNode, getExpandBtnCount, getExpandBtnOuterWidth } = sandbox.module.exports
let clears = 0
let label = ''
const fillState = {}
const fill = {}
;['stroke', 'size', 'radius', 'x', 'y'].forEach(key => {
  fill[key] = (...args) => { fillState[key] = args; return fill }
})
const textState = {}
const node = {
  nodeData: { data: { expand: false, childCount: 9, descendantCount: 254 }, children: [] },
  getData(key) { return key === undefined ? this.nodeData.data : this.nodeData.data[key] },
  mindMap: { opt: {
    layout: 'compactStructure',
    isShowExpandNum: true,
    expandBtnStyle: { color: '#5a6b7b', strokeColor: '#333', fontSize: 13 }
  } },
  expandBtnSize: 20,
  getChildrenLength() { return 9 },
  getExpandBtnCount,
  createExpandNodeContent() {},
  _expandBtn: { clear() { clears++ }, add() { return this } },
  _openExpandNode: {
    plain(value) { label = value },
    length() { return Array.from(label).length * 7 },
    attr(value) { Object.assign(textState, value) },
    fill(value) { textState.fill = value.color }
  },
  _fillExpandNode: fill
}
updateExpandBtnNode.call(node)
assert.strictEqual(label, '254')
assert.strictEqual(clears, 1)
// Built-in add/collapse icons draw their ring 31.232/1024 in, 74/1024 thick.
const ringWidth = 20 * 74 / 1024
const inset = 20 * 31.232 / 1024 + ringWidth / 2
const close = (a, b) => Math.abs(a - b) < 1e-9
assert.ok(close(fillState.x[0], inset), 'badge starts where the add button ring starts')
assert.ok(close(fillState.size[1], 20 - inset * 2), 'badge height equals the add button ring')
assert.ok(close(fillState.stroke[0].width, ringWidth), 'badge ring is as thick as the icon ring')
assert.strictEqual(fillState.stroke[0].color, '#5a6b7b', 'badge uses the button color')
assert.strictEqual(textState.fill, '#5a6b7b')
assert.ok(fillState.size[0] > fillState.size[1], 'three-digit counts stretch into a pill')
updateExpandBtnNode.call(node)
assert.strictEqual(clears, 1, 'hover must not detach the target of the next click')
node.nodeData.data.descendantCount = 253
updateExpandBtnNode.call(node)
assert.strictEqual(label, '253', 'a folded badge refreshes without toggling expand')
assert.strictEqual(clears, 2)

node.mindMap.opt.layout = 'logicalStructureLeft'
updateExpandBtnNode.call(node)
assert.strictEqual(clears, 3, 'layout change refreshes badge placement')
const [width] = fillState.size
assert.ok(close(fillState.x[0] + width, node.expandBtnSize - inset),
  'left layouts grow the badge away from the node')

for (const count of [1, 9, 10, 38, 72, 99, 100, 254, 1000, 99999]) {
  node.nodeData.data.descendantCount = count
  updateExpandBtnNode.call(node)
  assert.strictEqual(label, String(count), 'badge keeps every digit')
  const [badgeWidth, badgeHeight] = fillState.size
  const textWidth = node._openExpandNode.length()
  if (count >= 10) {
    assert.ok(badgeWidth > badgeHeight, 'two or more digits use a pill, not a fixed circle')
    assert.ok(badgeWidth >= textWidth + 11, 'text has horizontal padding inside the ring')
  }
  assert.ok(close(textState.x, fillState.x[0] + badgeWidth / 2), 'label is centered')
  assert.ok(getExpandBtnOuterWidth.call(node) >= badgeWidth + inset * 2,
    'layout reserves the full visible badge width')
}

// Custom formatters can be wider than the default digit estimate.
node.mindMap.opt.expandBtnNumHandler = () => '99+'
node._openExpandNode.length = () => 42
node.nodeData.data.descendantCount = 99
updateExpandBtnNode.call(node)
assert.strictEqual(label, '99+')
assert.ok(fillState.size[0] >= 42 + 11, 'measured glyph width is not truncated')
assert.ok(getExpandBtnOuterWidth.call(node) >= fillState.size[0] + inset * 2)
node.mindMap.opt.expandBtnNumHandler = () => '全部'
updateExpandBtnNode.call(node)
assert.strictEqual(label, '全部', 'formatter changes refresh even with the same count')
node.mindMap.opt.expandBtnStyle.fontSize = 8
updateExpandBtnNode.call(node)
assert.strictEqual(textState['font-size'], '8px', 'style changes refresh geometry')
node._openExpandNode.length = () => { throw new Error('detached SVG') }
node.nodeData.data.descendantCount = 1000
node.mindMap.opt.expandBtnNumHandler = null
updateExpandBtnNode.call(node)
assert.strictEqual(label, '1000', 'export/detached measurement failure keeps all digits')
assert.ok(fillState.size[0] > fillState.size[1], 'fallback still reserves a pill')
const stableClears = clears
node._openExpandNode.length = () => { throw new Error('unchanged badge should not be measured') }
updateExpandBtnNode.call(node)
assert.strictEqual(clears, stableClears, 'hover skips measurement and preserves mounted content')
console.log('badge refresh and stable click target tests passed')
