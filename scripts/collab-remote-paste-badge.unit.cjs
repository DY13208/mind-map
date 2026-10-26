'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm')
const src = fs.readFileSync('simple-mind-map/src/core/render/node/nodeExpandBtn.js', 'utf8').replace(/\r\n/g, '\n')
const start = src.indexOf('function updateExpandBtnNode() {'), end = src.indexOf('\n}\n', start) + 2
const ctx = { nodeDescendantCount: { getDescendantCount: n => n.count },
  getCountBadgeSide: () => 'right', getCountBadgeColor: () => '#888',
  getCountBadgeGeometry: () => ({ width: 20, height: 16, inset: 1, strokeWidth: 1, fontSize: 10 }) }
vm.runInNewContext(src.slice(start, end) + ';this.fn=updateExpandBtnNode', ctx)
const chain = () => { const o = { attr: () => o, fill: () => o, text: t => { o.t = t; return o }, stroke: () => o, size: () => o, radius: () => o, x: () => o, y: () => o }; return o }
const node = { count: 16, mindMap: { opt: { isShowExpandNum: true } }, expandBtnSize: 20,
  getData() { return { expand: false } }, getExpandBtnCount: c => c,
  createExpandNodeContent() { if (!this._openExpandNode) { this._openExpandNode = chain(); this._closeExpandNode = chain(); this._fillExpandNode = chain() } } }
// 远端插入时按钮组尚未挂载：不能写缓存
ctx.fn.call(node)
assert.equal(node._lastExpandBtnCount, undefined, 'unmounted button must not cache badge key')
// renderExpandBtn 新建按钮组后必须真正写入数字
const added = []
node._expandBtn = { clear() { added.length = 0 }, add(x) { added.push(x); return this } }
ctx.fn.call(node)
assert.equal(node._openExpandNode.t, '16')
assert.equal(added.length, 2, 'badge fill + text mounted')
// 计数未变时保持原元素不重绘；计数变化时更新
ctx.fn.call(node); assert.equal(added.length, 2)
node.count = 17; ctx.fn.call(node); assert.equal(node._openExpandNode.t, '17')
console.log('PASS collapsed badge renders count after button mounts; unchanged badge not redrawn')
