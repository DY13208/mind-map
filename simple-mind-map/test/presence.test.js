const assert = require('assert')
const { scanFinished } = require('../bin/presence')

// node-redis v4 returns a numeric cursor; older clients may return a string.
// Both zero representations must terminate a SCAN loop.
assert.strictEqual(scanFinished(0), true)
assert.strictEqual(scanFinished('0'), true)
assert.strictEqual(scanFinished(1), false)
assert.strictEqual(scanFinished('12'), false)

console.log('presence tests passed')
