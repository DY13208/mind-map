const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const presence = require('../bin/collabV2/mcpPresence')
const room = 'presence-test'
presence.touch(room, { id: 'alice', name: 'Alice' }, 100)
presence.touch(room, { id: 'alice', name: 'Alice' }, 200)
presence.touch(room, { id: 'bob', name: 'Bob' }, 200)
assert.equal(presence.list(room, 201).length, 2)
assert.equal(presence.list('other-room', 201).length, 0)
assert.equal(presence.list(room, 200 + presence.TTL_MS).length, 0)
function observe(statusCode, verified = true) {
  const res = new EventEmitter()
  res.statusCode = statusCode
  presence.observe({ verifiedMcpSource: verified ? { kind: 'user' } : null,
    authUser: { id: 'carol', name: 'Carol' } }, res, '/api/files/auth-test/subtree')
  res.emit('finish')
}
observe(403)
observe(200, false)
assert.equal(presence.list('auth-test').length, 0)
observe(200)
assert.equal(presence.list('auth-test').length, 1)
assert.equal(presence.list('auth-test')[0].source, 'mcp')
presence.prune(Date.now() + presence.TTL_MS)
console.log('MCP presence: deduplication, isolation, expiry and successful verified calls passed')
