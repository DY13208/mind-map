const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

const source = fs
  .readFileSync(require.resolve('../src/plugins/Select.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export default Select', 'module.exports = Select')
const sandbox = {
  module: { exports: {} },
  AutoMove: function () {},
  console
}
vm.runInNewContext(source, sandbox)
const Select = sandbox.module.exports

const node = uid => ({ uid, getData: key => key === 'uid' ? uid : ({ uid }) })
const select = Object.create(Select.prototype)
select.lastMultiSelectUids = ['a', 'b']
select.lastMultiSelectList = [node('a'), node('b')]
select.mindMap = {
  renderer: {
    findNodeByUid: uid => (uid === 'a' ? node('a') : null)
  }
}

assert.strictEqual(
  select.getMultiSelectCache().length,
  0,
  'detached selection instances must not be returned to the context menu'
)

select.mindMap.renderer.findNodeByUid = uid => node(uid)
assert.strictEqual(select.getMultiSelectCache().length, 2,
  'live multi-selection must remain available')
assert.strictEqual(select.getMultiSelectCache()[0].uid, 'a')
assert.strictEqual(select.getMultiSelectCache()[1].uid, 'b')

console.log('select stale cache tests passed')
