const assert = require('assert')

const { createOperationId, isOperationId } = require('../src/utils/operationId')

const originalRandomUuid = crypto.randomUUID
crypto.randomUUID = undefined

const id = createOperationId()
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
assert.strictEqual(isOperationId(id), true)
assert.strictEqual(isOperationId('op-123-abc'), false)

crypto.randomUUID = originalRandomUuid

console.log('operationId tests passed')
