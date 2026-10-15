'use strict'
const assert = require('node:assert/strict')
const { createOperationEventBridge } = require('../simple-mind-map/bin/collabV2/operationEventBridge')
const { fromCommitted } = require('../simple-mind-map/bin/collabV2/protocol')

async function check(children, expectedSnapshot) {
  const emissions = []
  let listener
  const row = { operation_id: '11111111-2222-4333-8444-555555555555',
    room_key: 'batch-room', version: 1, operation_type: 'node.batch',
    payload: { ops: [{ type: 'node.update', payload: { uid: 'failed-node' } }] },
    event: { type: 'batch.applied', payload: { events: children, resnapshot: false } } }
  const bridge = createOperationEventBridge({
    bus: { subscribe(fn) { listener = fn; return () => { listener = null } }, status: () => ({ ok: true }) },
    io: { to: () => ({ emit: (name, data) => emissions.push({ name, data }) }) },
    getActiveRoomKeys: () => ['batch-room'],
    listActiveRoomHeads: async () => [{ roomKey: 'batch-room', headVersion: 1 }],
    listRoomOperationsContiguous: async (_, after) => ({ ok: true, fromVersion: after,
      toVersion: 1, currentRevision: 1, hasMore: false, operations: after < 1 ? [row] : [] })
  })
  try {
    await bridge.start()
    bridge.activateRoom('batch-room', 0)
    for (let attempt = 0; attempt < 30 && !emissions.length; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(emissions.length, 1)
    assert.equal(emissions[0].name, expectedSnapshot ? 'sync:resnapshot-required' : 'op:event')
    if (!expectedSnapshot) {
      assert.equal(emissions[0].data.type, 'batch.applied')
      assert.deepEqual(emissions[0].data.payload.events, children)
      assert.equal(bridge.status().resnapshotRequests, 0)
      listener({ roomKey: 'batch-room', version: 1, operationId: row.operation_id })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(emissions.length, 1)
    }
  } finally { await bridge.stop() }
}

async function main() {
  const safe = fromCommitted({ payload: { __mcpResult: { items: ['private-result'] },
    __mcpRequest: { digest: 'private-digest' }, requestDigest: 'private-digest' },
    event: { type: 'node.updated', payload: { uid: 'leaf' } } })
  assert.equal('__mcpResult' in safe.payload, false)
  assert.equal('__mcpRequest' in safe.payload, false)
  assert.equal('requestDigest' in safe.payload, false)
  await check([{ type: 'node.updated', payload: { uid: 'successful-node', data: { text: 'new' } } }], false)
  await check([{ type: 'batch.applied', payload: { events: [{ type: 'node.deleted', payload: { uid: 'leaf' } }] } }], false)
  await check([{ type: 'unsupported.event', payload: {} }], true)
  await check([{ type: 'node.updated', payload: { resnapshot: true } }], true)
  console.log('批次增量事件、嵌套事件、安全回退和重复唤醒检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
