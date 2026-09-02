const test = require('node:test')
const assert = require('node:assert/strict')

function isPermanentInsertError(err) {
  const msg = String((err && err.message) || err || '')
  const code = String((err && err.code) || '')
  return (
    code === 'PARENT_DELETED' ||
    /父节点已删除|PARENT_DELETED|missing parent/i.test(msg)
  )
}

test('isPermanentInsertError detects parent deleted conflicts', () => {
  assert.equal(
    isPermanentInsertError(new Error('父节点已删除或不存在: abc')),
    true
  )
  assert.equal(isPermanentInsertError({ code: 'PARENT_DELETED' }), true)
  assert.equal(isPermanentInsertError(new Error('missing parent for insert')), true)
  assert.equal(isPermanentInsertError(new Error('network timeout')), false)
})
