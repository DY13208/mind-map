const assert = require('assert')
const {
  createCollaborationStore
} = require('../bin/collaborationStore')

function testPendingConfirmReject() {
  const store = createCollaborationStore({ timeoutMs: 60000 })
  store.reset('room-1', 3)
  assert.strictEqual(store.getSnapshot().lastAppliedVersion, 3)
  assert.strictEqual(store.getSnapshot().status, 'connecting')

  const pending = store.trackPending({
    operationId: 'op-1',
    type: 'node.update',
    payload: { uid: 'a' }
  })
  assert.strictEqual(pending.operationId, 'op-1')
  assert.strictEqual(store.getSnapshot().pendingCount, 1)

  store.confirmPending('op-1', 4)
  assert.strictEqual(store.getSnapshot().pendingCount, 0)
  assert.strictEqual(store.getSnapshot().lastAppliedVersion, 4)

  let rolled = false
  store.trackPending({
    operationId: 'op-2',
    type: 'node.insert',
    rollback: () => {
      rolled = true
    }
  })
  const rejected = store.rejectPending('op-2', new Error('boom'))
  assert.strictEqual(rejected.rejected, true)
  assert.strictEqual(rejected.rolledBack, true)
  assert.strictEqual(rolled, true)
  assert.strictEqual(store.getSnapshot().pendingCount, 0)
}

function testStrictEventBuffer() {
  const store = createCollaborationStore()
  store.reset('room-2', 10)
  store.setStatus('live')

  assert.deepStrictEqual(
    store.enqueueRemoteEvent({ version: 10, type: 'skip' }),
    { accepted: false, reason: 'duplicate_or_old' }
  )
  store.enqueueRemoteEvent({ version: 12, type: 'later' })
  store.enqueueRemoteEvent({ version: 11, type: 'next' })
  assert.strictEqual(store.hasGapBefore(12), false)

  const ready = store.drainReadyEvents()
  assert.strictEqual(ready.length, 2)
  assert.strictEqual(ready[0].version, 11)
  assert.strictEqual(ready[1].version, 12)
  assert.strictEqual(store.getSnapshot().lastAppliedVersion, 12)
  assert.deepStrictEqual(store.drainReadyEvents(), [])
}

function testGapDetection() {
  const store = createCollaborationStore()
  store.reset('room-3', 5)
  store.enqueueRemoteEvent({ version: 8, type: 'jump' })
  assert.strictEqual(store.hasGapBefore(8), true)
  assert.deepStrictEqual(store.drainReadyEvents(), [])
  assert.strictEqual(store.getSnapshot().lastAppliedVersion, 5)
}

function testSubscribe() {
  const store = createCollaborationStore()
  const seen = []
  const unsub = store.subscribe(snap => seen.push(snap.status))
  store.reset('room-4', 0)
  store.setStatus('live')
  unsub()
  store.setStatus('recovering')
  assert.ok(seen.includes('connecting'))
  assert.ok(seen.includes('live'))
  assert.ok(!seen.includes('recovering'))
}

testPendingConfirmReject()
testStrictEventBuffer()
testGapDetection()
testSubscribe()
console.log('collaborationStore tests passed')
