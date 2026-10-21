'use strict'
const assert = require('node:assert/strict')
const { isTerminalError, isRetryableError, shouldQuarantineError, hasProtectedContentMutation } = require('../simple-mind-map/src/utils/collabReliability')
const { memoryOutbox } = require('../simple-mind-map/bin/collabV2/outbox')

async function main() {
  for (const code of ['PRECONDITION_REQUIRED', 'PRECONDITION_INVALID', 'PRECONDITION_UNSUPPORTED', 'REPLACE_CONFLICT', 'TARGET_DELETED', 'NODE_DELETED', 'PARENT_DELETED']) {
    assert.equal(isTerminalError(code), true, code)
    assert.equal(isRetryableError(code), false, code)
    assert.equal(shouldQuarantineError(code, { type: 'node.update' }), true, code)
  }
  const original = { opId: 'guard-replay', clientId: 'old-client', roomKey: 'test-room', baseRevision: 4,
    type: 'node.update', payload: { uid: 'n', patch: { text: '未保存草稿' }, expected: { uid: 'n', '__fv.text': 3 } } }
  assert.equal(hasProtectedContentMutation(original), true)
  assert.equal(hasProtectedContentMutation({ type: 'node.batch', payload: { ops: [original] } }), true)
  assert.equal(hasProtectedContentMutation({ type: 'node.update', payload: { uid: 'n', patch: { customLeft: 3 } } }), false)
  assert.equal(hasProtectedContentMutation({ type: 'node.insert', payload: { uid: 'n', text: '新增' } }), false)
  const outbox = memoryOutbox()
  await outbox.put(original)
  await outbox.update(original.opId, { status: 'quarantined', errorCode: 'REPLACE_CONFLICT' })
  const recovered = (await outbox.list(original.clientId, original.roomKey))[0]
  assert.deepEqual(recovered.payload, original.payload)
  assert.equal(recovered.baseRevision, original.baseRevision)
  assert.equal(recovered.status, 'quarantined')
  console.log('PASS guarded errors are terminal; protected offline drafts retain original payload and baseline')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
