const assert = require('assert')
const { requireClientId, isValidClientId } = require('../bin/collabV2/protocol')

// Mirrors mcpServer.mjs client-id resolution + mindApi normalizeCommand header pickup.
function resolveMcpClientId(envValue, fallbackFactory) {
  return (
    String(envValue || '')
      .trim()
      .slice(0, 160) || fallbackFactory()
  )
}

function clientIdFromRequest(body, headers) {
  return String(
    (body && (body.clientId || body.client_id)) ||
      (headers && (headers['x-client-id'] || headers['x-collab-client'])) ||
      ''
  )
    .trim()
    .slice(0, 160)
}

assert.throws(() => requireClientId(''), /clientId 不能为空/)
assert.throws(() => requireClientId('   '), /clientId 不能为空/)
assert.strictEqual(requireClientId('mcp-abc'), 'mcp-abc')

const fromEnv = resolveMcpClientId('  mcp-fixed-id  ', () => 'mcp-fallback')
assert.strictEqual(fromEnv, 'mcp-fixed-id')
assert.ok(isValidClientId(fromEnv))

const generated = resolveMcpClientId('', () => 'mcp-generated-id')
assert.strictEqual(generated, 'mcp-generated-id')
assert.ok(isValidClientId(generated))

assert.throws(
  () => requireClientId(clientIdFromRequest({ text: 'node' }, {})),
  /clientId 不能为空/
)
assert.strictEqual(
  requireClientId(
    clientIdFromRequest({ text: 'node' }, { 'x-client-id': generated })
  ),
  generated
)

console.log('mcpClientId tests passed')
