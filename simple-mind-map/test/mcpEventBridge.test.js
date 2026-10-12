const assert = require('assert')
const { fromCommitted } = require('../bin/collabV2/protocol')

const PRIVATE_REQUEST_SUMMARY = 'private-mcp-request-summary-test-sentinel'

// These are the cross-module cases that the bridge and socket/client focused
// specs must cover as their interfaces land. Renderer application remains a
// real-browser case; this file only exercises the client's pure event reducer.
const BRIDGE_TEST_PLAN = [
  'one room drains committed versions in order and never overlaps its own drain',
  'out-of-order and duplicate wakeups converge from the contiguous operation log',
  'a missed wakeup is found by the active-room head reconciliation while idle',
  'unsupported snapshot/history events request an authoritative resnapshot and never silently advance',
  'ACK-before-event and event-before-ACK both apply one operation exactly once',
  'join sync pages through one fixed head before the new socket receives live events'
]

function createRootSnapshot() {
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Root' },
      children: []
    }
  }
}

function createGeneratedInsertFixture() {
  const requestPayload = {
    parent: 'root',
    index: 0,
    text: 'requested node text',
    position: 'client-position-is-not-authoritative'
  }
  const uid = 'server-generated-node-23'
  const canonicalPayload = {
    ...requestPayload,
    uid,
    parentUid: 'root',
    data: { uid, text: 'requested node text', expand: true, __fv: { text: 23 } },
    text: 'requested node text',
    position: 'a1',
    index: 0
  }
  const committed = {
    operationId: 'committed-op-23',
    roomKey: 'mcp-event-bridge-test',
    actorId: 'mcp-agent',
    clientId: 'mcp-test-client',
    client_seq: 9,
    version: 23,
    operationType: 'node.insert',
    // The idempotency digest is private operation metadata. It must not be
    // selected as the client patch when the canonical event is available.
    payload: { ...requestPayload, requestDigest: PRIVATE_REQUEST_SUMMARY },
    // This is the persisted DirectApplier event shape: unlike the MCP request,
    // it carries the server-generated UID, canonical row data, and position.
    event: {
      type: 'node.inserted',
      payload: canonicalPayload,
      affectedUids: ['root', uid]
    }
  }
  return { committed, canonicalPayload }
}

async function testFromCommittedUsesCanonicalEventPayload() {
  const { committed, canonicalPayload } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)

  assert.strictEqual(operation.type, 'node.inserted')
  assert.strictEqual(operation.payload.uid, canonicalPayload.uid)
  assert.strictEqual(operation.payload.parentUid, 'root')
  assert.strictEqual(operation.payload.position, canonicalPayload.position)
  assert.deepStrictEqual(operation.payload.data, canonicalPayload.data)
  assert.strictEqual(operation.clientSeq, 9)
}

async function testPrivateRequestSummaryDoesNotReachClientPatch() {
  const { committed } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)
  assert.ok(
    !JSON.stringify(operation).includes(PRIVATE_REQUEST_SUMMARY),
    'private request summary must not enter the client operation/patch'
  )
}

async function testGeneratedInsertAppliesThroughClientPureReducer() {
  const { committed, canonicalPayload } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)
  const { applyCollabEvent } = await import('../src/plugins/cooperateRecovery.js')
  const clientSnapshot = createRootSnapshot()

  const next = applyCollabEvent(clientSnapshot, operation)
  assert.deepStrictEqual(next.root.children, [canonicalPayload.uid])
  assert.strictEqual(next[canonicalPayload.uid].data.uid, canonicalPayload.uid)
  assert.deepStrictEqual(next[canonicalPayload.uid].data, canonicalPayload.data)
  assert.strictEqual(next[canonicalPayload.uid].position, canonicalPayload.position)
}

async function run() {
  const tests = [
    ['fromCommitted selects canonical event payload', testFromCommittedUsesCanonicalEventPayload],
    ['private request summary stays out of client patch', testPrivateRequestSummaryDoesNotReachClientPatch],
    ['generated insert applies through client pure reducer', testGeneratedInsertAppliesThroughClientPureReducer]
  ]
  let failures = 0
  for (const [name, test] of tests) {
    try {
      await test()
      console.log('ok - ' + name)
    } catch (err) {
      failures += 1
      console.error('not ok - ' + name)
      console.error(err && err.stack ? err.stack : err)
    }
  }
  if (failures) {
    console.error(`${failures} MCP event bridge contract test(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('MCP event bridge canonical payload tests ok')
  console.log('Bridge/socket focused scenarios reserved:')
  BRIDGE_TEST_PLAN.forEach(item => console.log('- ' + item))
}

if (require.main === module) {
  run().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
}

module.exports = { BRIDGE_TEST_PLAN }
