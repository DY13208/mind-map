const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomUUID } = require('node:crypto')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')

async function fixture(t, sync, extra = {}) {
  const applied = []
  const socket = {
    connected: true, on() {}, disconnect() {},
    emit(event, payload, callback) {
      if (event === 'join') callback({ ok: true, serverRevision: 4014 })
      if (event === 'sync') callback(sync(payload))
    }
  }
  const adapter = createCollaborationAdapter({
    memory: true, clientId: randomUUID(), socket,
    onRemoteOperation: async op => applied.push(op.serverRevision),
    ...extra
  })
  t.after(() => adapter.disconnect())
  await adapter.connect({ roomKey: 'room-gap-test', userId: 'tester', lastServerRevision: 4014 })
  return { adapter, applied }
}

const operation = rev => ({
  opId: randomUUID(), clientId: randomUUID(), serverRevision: rev,
  type: 'node.update', payload: { uid: 'root', text: String(rev) }
})

test('missing revision is applied before the later operation and the error clears', async t => {
  const ops = [operation(4015), operation(4016)]
  const { adapter, applied } = await fixture(t, payload => {
    assert.equal(payload.afterRevision, 4014)
    return { ok: true, operations: ops, serverRevision: 4016 }
  })
  await adapter.applyRemoteOperation(ops[1])
  assert.deepEqual(applied, [4015, 4016])
  const status = adapter.getStatus()
  assert.equal(status.lastServerRevision, 4016)
  assert.equal(status.currentError, null)
  assert.equal(status.lastError.code, 'REVISION_GAP')
  assert.equal(status.lastErrorRecovered, true)
  assert.equal(status.saveState, 'saved')
})

test('failed recovery keeps the gap error and does not advance revision', async t => {
  const { adapter, applied } = await fixture(t, () => ({ ok: false, code: 'REVISION_GAP', error: 'sync failed' }))
  await assert.rejects(adapter.applyRemoteOperation(operation(4016)), /sync failed/)
  assert.deepEqual(applied, [])
  const status = adapter.getStatus()
  assert.equal(status.lastServerRevision, 4014)
  assert.equal(status.currentError.code, 'REVISION_GAP')
  assert.equal(status.lastErrorRecovered, false)
  assert.equal(status.saveState, 'error')
})

test('snapshot recovery clears the error only after the snapshot callback finishes', async t => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { adapter } = await fixture(t, () => ({ ok: true, reload: true, serverRevision: 4016 }), {
    onReloadRequired: () => pending
  })
  const recovery = adapter.applyRemoteOperation(operation(4016))
  await Promise.resolve()
  assert.equal(adapter.getStatus().currentError.code, 'REVISION_GAP')
  assert.equal(adapter.getStatus().lastErrorRecovered, false)
  release()
  await recovery
  assert.equal(adapter.getStatus().currentError, null)
  assert.equal(adapter.getStatus().lastErrorRecovered, true)
})
