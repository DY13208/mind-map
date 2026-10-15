const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomUUID } = require('node:crypto')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')

async function fixture(t, sync, extra = {}) {
  const applied = []
  const handlers = new Map()
  const socket = {
    connected: true,
    on(event, handler) { handlers.set(event, handler) },
    disconnect() {},
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
  return { adapter, applied, handlers }
}

const operation = rev => ({
  opId: randomUUID(), clientId: randomUUID(), serverRevision: rev,
  type: 'node.updated', payload: { uid: 'root', patch: { text: String(rev) } }
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
    onReloadRequired: async () => {
      await pending
      return { applied: true, version: 4016 }
    }
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

test('a rejected local apply replays the operation log before advancing revision', async t => {
  const op = operation(4015)
  let adapterRef
  let attempts = 0
  const observedRevisions = []
  const { adapter } = await fixture(t, payload => ({
    ok: true,
    fromRevision: 4014,
    toRevision: 4015,
    currentRevision: 4015,
    operations: [op],
    hasMore: false
  }), {
    onRemoteOperation: async () => {
      attempts += 1
      observedRevisions.push(adapterRef.getStatus().lastServerRevision)
      return attempts > 1
    }
  })
  adapterRef = adapter

  await adapter.applyRemoteOperation(op)
  assert.equal(attempts, 2)
  assert.deepEqual(observedRevisions, [4014, 4014])
  assert.equal(adapter.getStatus().lastServerRevision, 4015)
  assert.equal(adapter.getStatus().snapshotRecoveryCount, 0)
  assert.equal(adapter.getStatus().gapRecoveredOps, 1)
})

test('a failed operation-log apply leaves the watermark unchanged without snapshotting', async t => {
  const op = operation(4015)
  const { adapter } = await fixture(t, () => ({
    ok: true,
    fromRevision: 4014,
    toRevision: 4015,
    currentRevision: 4015,
    operations: [op],
    hasMore: false
  }), {
    onRemoteOperation: async () => false
  })

  await assert.rejects(adapter.applyRemoteOperation(op), /not applied/)
  const status = adapter.getStatus()
  assert.equal(status.lastServerRevision, 4014)
  assert.equal(status.snapshotRecoveryCount, 0)
  assert.equal(status.gapRecoveredOps, 0)
  assert.equal(status.currentError.code, 'REMOTE_APPLY_FAILED')
})

test('socket remote callbacks stay serialized in server revision order', async t => {
  let releaseFirst
  let enteredFirst
  const firstStarted = new Promise(resolve => { enteredFirst = resolve })
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const calls = []
  const { adapter, handlers } = await fixture(t, () => ({ ok: true }), {
    onRemoteOperation: async op => {
      calls.push('start:' + op.serverRevision)
      if (op.serverRevision === 4015) {
        enteredFirst()
        await firstGate
      }
      calls.push('end:' + op.serverRevision)
    }
  })

  const receive = handlers.get('op:event')
  receive(operation(4015))
  receive(operation(4016))
  await firstStarted
  assert.deepEqual(calls, ['start:4015'])
  releaseFirst()
  for (let i = 0; i < 10 && adapter.getStatus().lastServerRevision < 4016; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.deepEqual(calls, ['start:4015', 'end:4015', 'start:4016', 'end:4016'])
  assert.equal(adapter.getStatus().lastServerRevision, 4016)
})

test('batch.applied is replayable as an incremental event', async t => {
  const applied = []
  const batch = {
    opId: randomUUID(), clientId: randomUUID(), serverRevision: 4015,
    type: 'batch.applied',
    payload: { events: [
      { type: 'node.updated', payload: { uid: 'a', patch: { text: 'one' } } },
      { type: 'node.moved', payload: { uid: 'b', parentUid: 'root', index: 0 } }
    ] }
  }
  const { adapter } = await fixture(t, payload => ({
    ok: true,
    fromRevision: 4014,
    toRevision: 4015,
    currentRevision: 4015,
    operations: [batch],
    hasMore: false
  }), {
    onRemoteOperation: async op => applied.push(op.type)
  })
  await adapter.applyRemoteOperation(operation(4016))
  assert.deepEqual(applied, ['batch.applied', 'node.updated'])
  assert.equal(adapter.getStatus().lastServerRevision, 4016)
  assert.equal(adapter.getStatus().snapshotRecoveryCount, 0)
})
