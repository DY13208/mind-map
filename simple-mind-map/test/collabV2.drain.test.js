const assert = require('assert')
const { spawnSync } = require('child_process')
const { randomUUID } = require('crypto')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { dependsOnBlockedOp, isTerminalError } = require('../bin/collabReliability')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const textUpdate = (uid, text) => ({ uid, text, expected: { uid, '__fv.text': 0 } })
const deletePayload = uid => ({ uid, expected: { uid, subtree_token: 'fixture-token' } })

async function fixture(rows = [], onOp, onRejected) {
  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  const roomKey = 'drain-regression'
  const sent = []
  let revision = 0
  for (const row of rows) {
    await box.put({ opId: randomUUID(), clientId, roomKey, ...row })
  }
  const socket = {
    connected: true,
    on() {},
    disconnect() { this.connected = false },
    emit(event, op, ack) {
      if (event === 'join') {
        ack({ ok: true, canEdit: true, role: 'editor', serverRevision: revision })
      } else if (event === 'sync') {
        ack({ ok: true, operations: [], hasMore: false, serverRevision: revision })
      } else if (event === 'op') {
        sent.push(op)
        const error = onOp && onOp(op)
        ack(error || { ok: true, opId: op.opId, serverRevision: ++revision })
      }
    }
  }
  const adapter = createCollaborationAdapter({ socket, outbox: box, clientId, memory: true, onRejected })
  await adapter.connect({ roomKey, userId: 'dev-local' })
  return { adapter, box, sent, rows: () => box.list(clientId, roomKey) }
}

const cases = {
  async staleAnchorConflictSettlesDependentWrites() {
    const rejected = []
    const f = await fixture([], op => op.payload.uid === 'new-parent'
      ? { ok: false, code: 'ANCHOR_CONFLICT', statusCode: 409 } : null,
    (op, error) => rejected.push([op.payload.uid, error.code]))
    try {
      const writes = [
        { uid: 'new-parent', parent: 'root', anchorUid: 'deleted' },
        { uid: 'child', parent: 'new-parent' },
        { uid: 'grandchild', parent: 'child' }
      ].map(payload => f.adapter.submitOperation({ type: 'node.insert', payload }))
      const results = await Promise.allSettled(writes)
      assert.deepStrictEqual(results.map(result => result.reason && result.reason.code),
        ['ANCHOR_CONFLICT', 'BLOCKED_BY_TERMINAL_CREATE', 'BLOCKED_BY_TERMINAL_CREATE'])
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['new-parent'])
      assert.deepStrictEqual(rejected.map(([uid]) => uid), ['new-parent', 'child', 'grandchild'])
      assert.strictEqual(f.adapter.getStatus().outboxPending, 0)
      assert.strictEqual(f.adapter.getStatus().pendingCount, 0)
      assert.strictEqual(f.adapter.getStatus().saveState, 'error')
      await f.adapter.submitOperation({ type: 'node.insert', payload: {
        uid: 'independent', parent: 'existing-parent', anchorUid: 'new-parent',
        index: 1, allowStaleAnchorFallback: true
      } })
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['new-parent', 'independent'])
      assert.strictEqual(f.adapter.getStatus().saveState, 'saved')
      assert.deepStrictEqual((await f.rows()).map(row => [row.payload.uid, row.status]),
        ['new-parent', 'child', 'grandchild'].map(uid => [uid, 'quarantined']))
    } finally { await f.adapter.disconnect() }
  },
  async rejoinQuarantinesLegacyAnchorDependents() {
    const f = await fixture([
      { type: 'node.insert', clientSeq: 1, status: 'failed', errorCode: 'ANCHOR_CONFLICT',
        payload: { uid: 'new-parent', parent: 'root', anchorUid: 'moved', text: 'retained' } },
      { type: 'node.insert', clientSeq: 2, status: 'sending',
        payload: { uid: 'child', parent: 'new-parent' } },
      { type: 'node.insert', clientSeq: 3, status: 'pending',
        payload: { uid: 'sibling', parent: 'root', anchorUid: 'new-parent' } }
    ])
    try {
      await f.adapter.retryPending()
      assert.strictEqual(f.sent.length, 0)
      const rows = await f.rows()
      assert.strictEqual(rows[0].payload.text, 'retained')
      assert.deepStrictEqual(rows.map(row => row.errorCode),
        ['ANCHOR_CONFLICT', 'BLOCKED_BY_TERMINAL_CREATE', 'BLOCKED_BY_TERMINAL_CREATE'])
      assert.ok(rows.every(row => row.status === 'quarantined'))
      assert.strictEqual(f.adapter.getStatus().outboxPending, 0)
      assert.strictEqual(f.adapter.getStatus().saveState, 'error')
    } finally { await f.adapter.disconnect() }
  },
  async blockedQueueYieldsAndResumes() {
    const f = await fixture([
      { type: 'node.insert', clientSeq: 1, status: 'failed', payload: { uid: 'missing', parent: 'root' } },
      { type: 'node.update', clientSeq: 2, status: 'pending', payload: { uid: 'missing', text: 'dependent' } }
    ])
    try {
      await wait(80)
      const kicksAfterIdle = f.adapter.getStatus().drainKickCount
      await wait(80)
      assert.strictEqual(
        f.adapter.getStatus().drainKickCount,
        kicksAfterIdle,
        'DRAIN_BLOCKED_NO_BUSY_LOOP: blocked pending must not reschedule drain'
      )
      assert.ok(kicksAfterIdle <= 3, 'drain must yield instead of spinning')
      assert.strictEqual(f.sent.length, 0)
      await f.adapter.submitOperation({ type: 'node.update', payload: textUpdate('independent', 'ok') })
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['independent'])
      const dependent = (await f.rows()).find(row => row.clientSeq === 2)
      assert.ok(dependent)
      assert.strictEqual(dependent.status, 'pending')
      assert.ok(f.adapter.getStatus().drainKickCount <= kicksAfterIdle + 2)
    } finally { await f.adapter.disconnect() }
  },
  async cycleRejectionDoesNotBlockDelete() {
    const f = await fixture([], op => op.type === 'node.move'
      ? { ok: false, code: 'CYCLE_REJECTED', error: 'cycle' } : null)
    try {
      await assert.rejects(f.adapter.submitOperation({ type: 'node.move', payload: {
        uid: 'a', parent: 'b', expected: { uid: 'a', parent_uid: 'root', position: 'a0' }
      } }),
        error => error.code === 'CYCLE_REJECTED')
      await f.adapter.submitOperation({ type: 'node.delete', payload: deletePayload('b') })
      await f.adapter.submitOperation({ type: 'node.delete', payload: deletePayload('a') })
      assert.deepStrictEqual(f.sent.map(op => op.type), ['node.move', 'node.delete', 'node.delete'])
      assert.strictEqual(isTerminalError('CYCLE_REJECTED'), true)
      const rows = await f.rows()
      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0].status, 'quarantined')
      await f.adapter.retryPending()
      await wait(20)
      assert.strictEqual(f.sent.length, 3, 'terminal move must never retry')
    } finally { await f.adapter.disconnect() }
  },
  async sopDependenciesRemainQuarantined() {
    const f = await fixture([], op => op.type === 'node.insert'
      ? { ok: false, code: 'SOP_CONFIRM_REQUIRED', error: 'confirm' }
      : null)
    try {
      await assert.rejects(
        f.adapter.submitOperation({ type: 'node.insert', payload: { uid: 'n', parent: 'root' } }),
        error => error.code === 'SOP_CONFIRM_REQUIRED'
      )
      await assert.rejects(
        f.adapter.submitOperation({ type: 'node.update', payload: { uid: 'n', text: 'later' } }),
        error => error.code === 'BLOCKED_BY_TERMINAL_CREATE'
      )
      await assert.rejects(
        f.adapter.submitOperation({ type: 'node.move', payload: { uid: 'n', parent: 'root' } }),
        error => error.code === 'BLOCKED_BY_TERMINAL_CREATE'
      )
      await assert.rejects(
        f.adapter.submitOperation({ type: 'node.delete', payload: { uid: 'n' } }),
        error => error.code === 'BLOCKED_BY_TERMINAL_CREATE'
      )
      assert.deepStrictEqual(f.sent.map(op => op.type), ['node.insert'])
      const rows = await f.rows()
      assert.ok(rows.length >= 4)
      assert.ok(rows.every(row => row.status === 'quarantined'))
      const dependents = rows.filter(row => row.type !== 'node.insert')
      assert.ok(dependents.every(row => row.errorCode === 'BLOCKED_BY_TERMINAL_CREATE'))
    } finally { await f.adapter.disconnect() }
  },
  async terminalMutationDoesNotBlockExistingNode() {
    const f = await fixture([
      { type: 'node.update', clientSeq: 1, status: 'quarantined', errorCode: 'SOP_CONFIRM_REQUIRED', payload: { uid: 'sop' } },
      { type: 'node.update', clientSeq: 2, status: 'pending', payload: textUpdate('sop', 'unconfirmed') }
    ])
    try {
      await wait(30)
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['sop'])
      assert.deepStrictEqual(
        (await f.rows()).map(row => row.status),
        ['quarantined']
      )
    } finally { await f.adapter.disconnect() }
  },
  async forbiddenStopsAutomaticDrain() {
    const f = await fixture([
      { type: 'node.update', clientSeq: 1, status: 'pending', payload: { uid: 'a' } },
      { type: 'node.update', clientSeq: 2, status: 'pending', payload: { uid: 'b' } }
    ], () => ({ ok: false, code: 'FORBIDDEN', error: 'denied' }))
    try {
      await wait(30)
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['a'])
      assert.deepStrictEqual((await f.rows()).map(row => row.status), ['quarantined', 'pending'])
    } finally { await f.adapter.disconnect() }
  },
  async dependencyDirectionAndSequence() {
    const blocked = { type: 'node.insert', clientSeq: 2, payload: { uid: 'a', parent: 'root' } }
    assert.strictEqual(
      dependsOnBlockedOp({ clientSeq: 3, payload: { uid: 'b', parent: 'root' } }, blocked),
      false
    )
    assert.strictEqual(
      dependsOnBlockedOp({ clientSeq: 3, payload: { uid: 'b', parent: 'a' } }, blocked),
      true
    )
    assert.strictEqual(
      dependsOnBlockedOp({ clientSeq: 1, payload: { uid: 'a' } }, blocked),
      true
    )
    assert.strictEqual(
      dependsOnBlockedOp({ payload: { uid: 'a' } }, blocked),
      true
    )
    assert.strictEqual(
      dependsOnBlockedOp(
        { clientSeq: 3, payload: { uid: 'a' } },
        { type: 'node.batch', clientSeq: 2, payload: { ops: [blocked] } }
      ),
      true
    )
    assert.strictEqual(
      dependsOnBlockedOp(
        { type: 'node.delete', payload: { uid: 'a' } },
        { type: 'node.move', errorCode: 'CYCLE_REJECTED', payload: { uid: 'a', parent: 'b' } }
      ),
      false
    )
    assert.strictEqual(
      dependsOnBlockedOp(
        { type: 'node.update', payload: { uid: 'a' } },
        { type: 'node.update', errorCode: 'SOP_CONFIRM_REQUIRED', payload: { uid: 'a' } }
      ),
      false
    )
  },
  async ackSettlesWhenCounterRefreshFails() {
    const f = await fixture()
    const remove = f.box.remove
    f.box.remove = async opId => {
      await remove(opId)
      f.box.list = async () => { throw new Error('counter read failed') }
    }
    try {
      const ack = await f.adapter.submitOperation({ type: 'node.update', payload: textUpdate('a', 'saved') })
      assert.ok(ack.serverRevision)
      assert.strictEqual(f.adapter.getStatus().saveState, 'saved')
    } finally { await f.adapter.disconnect() }
  },
  async rejectionSettlesWhenCounterRefreshFails() {
    const f = await fixture([], () => ({ ok: false, code: 'SOP_CONFIRM_REQUIRED', error: 'confirm' }))
    const update = f.box.update
    f.box.update = async (opId, patch) => {
      const result = await update(opId, patch)
      if (patch.status === 'quarantined') {
        f.box.list = async () => { throw new Error('counter read failed') }
      }
      return result
    }
    try {
      await assert.rejects(f.adapter.submitOperation({ type: 'node.update', payload: textUpdate('sop', 'new') }),
        error => error.code === 'SOP_CONFIRM_REQUIRED')
      assert.strictEqual(f.adapter.getStatus().saveState, 'requires_confirmation')
    } finally { await f.adapter.disconnect() }
  }
}

if (process.argv[2]) {
  Promise.resolve().then(() => cases[process.argv[2]]()).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  // External watchdog also catches a microtask loop that starves JS timers.
  for (const name of Object.keys(cases)) {
    const result = spawnSync(process.execPath, [__filename, name], {
      timeout: 4000, encoding: 'utf8', maxBuffer: 1024 * 1024
    })
    assert.strictEqual(result.status, 0,
      `TEST_HANG_TRACE ${name}: ${result.error || result.stderr || result.stdout}`)
    console.log(`PASS ${name}`)
  }
}
