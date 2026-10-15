'use strict'

const assert = require('node:assert/strict')
const {
  missingSchemaError,
  resultForReceipt
} = require('../bin/mcpOperationReceipt')
const { digestMcpOperation } = require('../bin/mcpOperationIdentity')

const roomKey = 'receipt-unit-room'
const principalId = 'receipt-unit-principal'
const payload = { ops: [{ type: 'node.delete', payload: { uid: 'missing-node' } }] }
const mcpRequest = {
  v: 1,
  principalId,
  digest: digestMcpOperation({ roomKey, principalId, type: 'node.batch', payload })
}
const result = {
  count: 0,
  failed: 1,
  items: [{ index: 0, status: 'failed', type: 'node.delete', code: 'NODE_NOT_FOUND' }]
}
const receipt = {
  operation_id: '00000000-0000-4000-8000-000000000001',
  principal_id: principalId,
  request_digest: mcpRequest.digest,
  result,
  current_revision: '7'
}

assert.deepEqual(resultForReceipt(receipt, mcpRequest), {
  result,
  currentRevision: 7
})
assert.equal(
  missingSchemaError({ code: '42P01' }).code,
  'MCP_OPERATION_RECEIPT_SCHEMA_MISSING'
)
assert.equal(
  missingSchemaError({ code: '42703' }).code,
  'MCP_OPERATION_RECEIPT_SCHEMA_MISSING'
)
assert.equal(missingSchemaError({ code: '23505' }), null)

assert.throws(
  () => resultForReceipt(receipt, { ...mcpRequest, principalId: 'other' }),
  error => error.code === 'OPERATION_ID_CONFLICT'
)
assert.throws(
  () => resultForReceipt(receipt, { ...mcpRequest, digest: 'sha256:' + '0'.repeat(64) }),
  error => error.code === 'OPERATION_ID_CONFLICT'
)
assert.throws(
  () => resultForReceipt({ ...receipt, current_revision: '-1' }, mcpRequest),
  error => error.code === 'OPERATION_ID_UNVERIFIABLE'
)
assert.throws(
  () => resultForReceipt({ ...receipt, result: [] }, mcpRequest),
  error => error.code === 'OPERATION_ID_UNVERIFIABLE'
)

console.log('PASS MCP terminal receipt identity, replay version and missing-schema mapping')
