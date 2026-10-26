'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const mindApiPath = path.join(__dirname, '..', 'simple-mind-map', 'bin', 'mindApi.js')
const mindApiSource = fs.readFileSync(mindApiPath, 'utf8')
const helperMatch = mindApiSource.match(
  /^function serializeMapOperationError\(err\) \{\r?\n[\s\S]*?^\}/m
)
assert.ok(helperMatch, 'mindApi.js must define serializeMapOperationError')

const serializeMapOperationError = vm.runInNewContext(`(${helperMatch[0]})`)
const plain = value => JSON.parse(JSON.stringify(value))

const eventBridgeError = plain(serializeMapOperationError({
  message: 'MCP Direct 批量写入不可用',
  statusCode: 503,
  code: 'MCP_DIRECT_UNAVAILABLE',
  retryAfterMs: 250,
  details: {
    fallbackReason: 'event_bridge_disabled',
    secret: 'must-not-leak',
    internalTrace: { host: 'private' }
  }
}))
assert.equal(eventBridgeError.status, 503)
assert.deepEqual(eventBridgeError.body, {
  error: 'MCP Direct 批量写入不可用',
  code: 'MCP_DIRECT_UNAVAILABLE',
  retryAfterMs: 250,
  details: { fallbackReason: 'event_bridge_disabled' }
})

const policyError = plain(serializeMapOperationError({
  message: 'unsupported batch shape',
  statusCode: 400,
  code: 'MCP_DIRECT_UNAVAILABLE',
  details: { fallbackReason: 'direct_policy_unsupported' }
}))
assert.equal(policyError.status, 400)
assert.deepEqual(policyError.body.details, {
  fallbackReason: 'direct_policy_unsupported'
})

const unknownReason = plain(serializeMapOperationError({
  message: 'untrusted reason',
  statusCode: 503,
  code: 'MCP_DIRECT_UNAVAILABLE',
  details: { fallbackReason: 'arbitrary-secret', privateField: 'must-not-leak' }
}))
assert.equal(unknownReason.status, 503)
assert.equal(Object.hasOwn(unknownReason.body, 'details'), false)

const unrelatedError = plain(serializeMapOperationError({
  message: 'unrelated error',
  statusCode: 409,
  code: 'OTHER_ERROR',
  details: { fallbackReason: 'event_bridge_disabled', privateField: 'must-not-leak' }
}))
assert.equal(unrelatedError.status, 409)
assert.equal(unrelatedError.body.code, 'OTHER_ERROR')
assert.equal(Object.hasOwn(unrelatedError.body, 'details'), false)

const defaultError = plain(serializeMapOperationError({}))
assert.equal(defaultError.status, 400)
assert.deepEqual(defaultError.body, {
  error: 'bad request',
  code: 'OPERATION_REJECTED'
})

console.log('mcp-batch-error.unit.cjs: 5 cases passed')
