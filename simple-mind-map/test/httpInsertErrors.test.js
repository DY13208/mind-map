const test = require('node:test')
const assert = require('node:assert/strict')

function isPermanentNodeError(err) {
  const msg = String((err && err.message) || err || '')
  const code = String((err && err.code) || '')
  return (
    code === 'PARENT_DELETED' ||
    code === 'NODE_DELETED' ||
    code === 'MOVE_CONFLICT' ||
    code === 'UID_REUSED' ||
    /父节点已删除|PARENT_DELETED|missing parent/i.test(msg) ||
    /节点已删除或不存在|NODE_DELETED|MOVE_CONFLICT|UID_REUSED|禁止复用已删除节点/i.test(
      msg
    )
  )
}

test('isPermanentNodeError detects parent deleted conflicts', () => {
  assert.equal(
    isPermanentNodeError(new Error('父节点已删除或不存在: abc')),
    true
  )
  assert.equal(isPermanentNodeError({ code: 'PARENT_DELETED' }), true)
  assert.equal(isPermanentNodeError(new Error('missing parent for insert')), true)
  assert.equal(isPermanentNodeError(new Error('network timeout')), false)
})

test('isPermanentNodeError detects node deleted conflicts', () => {
  assert.equal(
    isPermanentNodeError(
      new Error('节点已删除或不存在: b84da512-3bb2-4494-8cac-ea2728dee2e3')
    ),
    true
  )
  assert.equal(isPermanentNodeError({ code: 'NODE_DELETED' }), true)
  assert.equal(isPermanentNodeError({ code: 'MOVE_CONFLICT' }), true)
})
