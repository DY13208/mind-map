const assert = require('assert')
const { spawnSync } = require('child_process')
const { randomUUID } = require('crypto')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { dependsOnBlockedOp, isTerminalError } = require('../bin/collabReliability')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(rows = [], onOp) {
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
  const adapter = createCollaborationAdapter({ socket, outbox: box, clientId, memory: true })
  await adapter.connect({ roomKey, userId: 'dev-local' })
  return { adapter, box, sent, rows: () => box.list(clientId, roomKey) }
}

const cases = {
  async blockedQueueYieldsAndResumes() {
    const f = await fixture([
      { type: 'node.insert', clientSeq: 1, status: 'failed', payload: { uid: 'missing', parent: 'root' } },
      { type: 'node.update', clientSeq: 2, status: 'pending', payload: { uid: 'missing', text: 'dependent' } }
    ])
    try {
      await wait(30) // Must run even when all pending work is blocked.
      assert.strictEqual(f.sent.length, 0)
      await f.adapter.submitOperation({ type: 'node.update', payload: { uid: 'independent', text: 'ok' } })
      assert.deepStrictEqual(f.sent.map(op => op.payload.uid), ['independent'])
      assert.strictEqual((await f.rows()).find(row => row.clientSeq === 2).status, 'pending')
    } finally { await f.adapter.disconnect() }
  },
  async cycleRejectionDoesNotBlockDelete() {
    const f = await fixture([], op => op.type === 'node.move'
      ? { ok: false, code: 'CYCLE_REJECTED', error: 'cycle' } : null)
    try {
      await assert.rejects(f.adapter.submitOperation({ type: 'node.move', payload: { uid: 'a', parent: 'b' } }),
        error => error.code === 'CYCLE_REJECTED')
      await f.adapter.submitOperation({ type: 'node.delete', payload: { uid: 'b' } })
      await f.adapter.submitOperation({ type: 'node.delete', payload: { uid: 'a' } })
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
    const f = await fixture([
      { type: 'node.update', clientSeq: 1, status: 'quarantined', errorCode: 'SOP_CONFIRM_REQUIRED', payload: { uid: 'sop' } },
      { type: 'node.update', clientSeq: 2, status: 'pending', payload: { uid: 'sop', text: 'unconfirmed' } }
    ])
    try {
      await wait(30)
      assert.strictEqual(f.sent.length, 0)
      assert.deepStrictEqual((await f.rows()).map(row => row.status), ['quarantined', 'pending'])
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
    assert.strictEqual(dependsOnBlockedOp({ clientSeq: 3, payload: { uid: 'b', parent: 'root' } }, blocked), false)
    assert.strictEqual(dependsOnBlockedOp({ clientSeq: 3, payload: { uid: 'b', parent: 'a' } }, blocked), true)
    assert.strictEqual(dependsOnBlockedOp({ clientSeq: 1, payload: { uid: 'a' } }, blocked), false)
    assert.strictEqual(dependsOnBlockedOp({ clientSeq: 2, payload: { uid: 'a' } }, blocked), false)
    assert.strictEqual(dependsOnBlockedOp({ payload: { uid: 'a' } }, blocked), true)
    assert.strictEqual(dependsOnBlockedOp({ clientSeq: 3, payload: { uid: 'a' } },
      { type: 'node.batch', clientSeq: 2, payload: { ops: [blocked] } }), true)
  },
  async ackSettlesWhenCounterRefreshFails() {
    const f = await fixture()
    const remove = f.box.remove
    f.box.remove = async opId => {
      await remove(opId)
      f.box.list = async () => { throw new Error('counter read failed') }
    }
    try {
      const ack = await f.adapter.submitOperation({ type: 'node.update', payload: { uid: 'a', text: 'saved' } })
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
      await assert.rejects(f.adapter.submitOperation({ type: 'node.update', payload: { uid: 'sop', text: 'new' } }),
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
