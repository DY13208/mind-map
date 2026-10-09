const test = require('node:test')
const assert = require('node:assert/strict')
test('internal identity cannot be forged, reused past expiry or minted without independent secret', () => {
  const { issueIdentity, verifyIdentity } = require('./access')
  const env = { WIKI_COMPILER_INTERNAL_SECRET: 'a'.repeat(64) }
  const token = issueIdentity('alice', env, 1000)
  assert.equal(verifyIdentity(token, env, 1001), 'alice')
  assert.throws(() => verifyIdentity(token, env, 1031), /unauthorized/)
  assert.throws(() => verifyIdentity(token + 'x', env, 1001), /unauthorized/)
  assert.throws(() => issueIdentity('alice', { DOCMOST_APP_SECRET: 'test' }), /unconfigured/)
})
