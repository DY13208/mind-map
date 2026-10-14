const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/core/render/node/nodeExpandBtn.js'), 'utf8')
const jobs = []
const from = source.indexOf('function renderExpandBtn()')
const to = source.indexOf('// 隐藏展开收起按钮', from)
const methods = vm.runInNewContext(`${source.slice(from, to)}; ({renderExpandBtn, showExpandBtn})`, {
  setTimeout: fn => jobs.push(fn), G: class { constructor() { throw new Error('stale SVG created') } }
})
let draws = 0
const node = { ...methods, group: { add() { draws++ } }, _expandBtn: {},
  mindMap: { opt: {} }, getChildrenLength: () => 1,
  getData: () => ({ isActive: true, expand: true }),
  updateExpandBtnNode() {}, updateExpandBtnPos() {} }
node.showExpandBtn()
node.group = null
assert.doesNotThrow(() => jobs.shift()())
assert.doesNotThrow(() => node.renderExpandBtn())
assert.equal(draws, 0)
node.group = { add() { draws++ } }
node.showExpandBtn()
node.group = { add() { draws++ } }
jobs.shift()()
assert.equal(draws, 0, 'old callback must not render into a recreated group')
node.showExpandBtn()
jobs.shift()()
assert.equal(draws, 1, 'live nodes still display their expand button')
console.log('expand button lifecycle: destroyed/recreated callbacks ignored; live rendering passed')
