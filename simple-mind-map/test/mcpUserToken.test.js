const assert = require('assert')
const { issueMcpUserToken, verifyMcpUserToken } = require('../bin/mcpUserToken')

const secret = 'test-mcp-token-with-more-than-32-characters'
const alice = issueMcpUserToken('alice', secret)
const bob = issueMcpUserToken('bob', secret)

assert.notStrictEqual(alice, bob)
assert.deepStrictEqual(verifyMcpUserToken(alice, secret), { userId: 'alice' })
assert.deepStrictEqual(verifyMcpUserToken(bob, secret), { userId: 'bob' })
assert.strictEqual(verifyMcpUserToken(`${alice}x`, secret), null)
assert.strictEqual(verifyMcpUserToken(alice, `${secret}x`), null)

console.log('mcpUserToken tests passed')
