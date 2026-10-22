const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { assertOperationPreconditions } = require('../simple-mind-map/bin/nodeWritePreflight')
const { createCollaborationAdapter } = require('../simple-mind-map/bin/collabV2/adapter')
const { memoryOutbox } = require('../simple-mind-map/bin/collabV2/outbox')
const update = (expected) => ({ type: 'node.update', payload: { uid: 'n', patch: { text: 'draft' }, ...(expected ? { expected } : {}) } })
async function main() {
  for (const op of [update(), { type: 'node.move', payload: { uid: 'n', parentUid: 'p' } }, { type: 'node.delete', payload: { uid: 'n' } }]) {
    assert.throws(() => assertOperationPreconditions(op), error => error.code === 'PRECONDITION_REQUIRED' && error.details.expectedPresent === false)
  }
  assertOperationPreconditions(update({ uid: 'n', '__fv.text': 0 }))
  assertOperationPreconditions({ type: 'node.batch', payload: { ops: [
    { type: 'node.create', payload: { uid: 'n', text: 'new' } }, update()
  ] } })
  assert.throws(() => assertOperationPreconditions({ type: 'node.batch', payload: { ops: [update()] } }), error => error.details.operationIndex === 0)
  const sent = [], rejected = [], outbox = memoryOutbox(), clientId = randomUUID()
  let revision = 0
  const socket = {
    connected: true, id: 'test', on() {}, off() {}, disconnect() { this.connected = false },
    emit(event, payload, ack) {
      if (event === 'join') ack({ ok: true, canEdit: true, role: 'editor', serverRevision: revision, peers: [], sync: { ops: [], currentRevision: revision } })
      else if (event === 'op') {
        sent.push(payload)
        ack({ ok: true, opId: payload.opId, serverRevision: ++revision, operation: { ...payload, serverRevision: revision } })
      } else if (ack) ack({ ok: true, ops: [], currentRevision: revision })
    }
  }
  const adapter = createCollaborationAdapter({ socket, memory: true, outbox, clientId, timeoutMs: 300, onRejected: (op, error) => rejected.push({ op, error }) })
  try {
    await adapter.connect({ roomKey: 'preflight-test', userId: 'test' })
    await assert.rejects(adapter.submitOperation(update()), error => error.code === 'PRECONDITION_REQUIRED')
    // settleAck resolves the caller before the diagnostic callback finishes.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sent.length, 0, 'unguarded write must never reach transport')
    const rows = await outbox.list(clientId, 'preflight-test')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'quarantined')
    assert.deepEqual(rows[0].payload.patch, { text: 'draft' })
    assert.equal(rejected.length, 1)
    assert.equal(adapter.getDebugState().lastError.stage, 'client_preflight')
    assert.equal(adapter.getDebugState().lastError.details.nodeUid, 'n')
    for (const type of ['node.move', 'node.delete']) {
      await assert.rejects(adapter.submitOperation({ type, payload: { uid: type, parentUid: 'p' } }), error => error.code === 'PRECONDITION_REQUIRED')
    }
    await new Promise(resolve => setImmediate(resolve))
    await adapter.retryPending()
    assert.equal(sent.length, 0, 'retry must not resend quarantined operations')
    assert.equal((await outbox.list(clientId, 'preflight-test')).filter(row => row.status === 'quarantined').length, 3)
    await adapter.submitOperation(update({ uid: 'n', '__fv.text': 0 }))
    assert.equal(sent.length, 1, 'guarded writes still proceed')
    assert.equal(sent[0].payload.expected['__fv.text'], 0, 'never replace the original baseline')
  } finally { await adapter.disconnect() }
  console.log('PASS shared preflight, batch inserts, no transport on missing guards, durable quarantine, diagnostic stage and subsequent guarded write')
}
main().catch(error => { console.error(error); process.exitCode = 1 })

