const assert = require('assert')
const { randomUUID } = require('crypto')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { inspectSopChange } = require('../src/utils/collabSopGuard')
const {
  isTerminalError,
  isRetryableError,
  dependsOnBlockedOp,
  canClaimOrphan,
  writeClientHeartbeat
} = require('../src/utils/collabReliability')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { createOpId } = require('../bin/collabV2/protocol')

function sopGraph() {
  return {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['sop'] },
    sop: { data: { uid: 'sop', text: 'SOP' }, children: ['child'] },
    child: { data: { uid: 'child', text: '普通节点' }, children: [] }
  }
}

function fakeJoinSocket(sent, opts = {}) {
  return {
    id: 'sock-rel',
    connected: true,
    on() {},
    emit(ev, payload, cb) {
      sent.push({ ev, payload })
      if (ev === 'join') {
        cb({
          ok: true,
          role: opts.role || 'editor',
          canEdit: opts.canEdit !== false,
          canView: true,
          peers: [],
          serverRevision: opts.serverRevision != null ? opts.serverRevision : 654
        })
        return
      }
      if (ev === 'sync') {
        cb({
          ok: true,
          serverRevision: opts.serverRevision != null ? opts.serverRevision : 654,
          operations: opts.gapOps || [],
          hasMore: false
        })
        return
      }
      if (typeof opts.onOp === 'function') {
        cb(opts.onOp(payload))
        return
      }
      cb({
        ok: true,
        opId: payload && payload.opId,
        serverRevision: (opts.serverRevision || 654) + 1
      })
    },
    disconnect() {
      this.connected = false
    }
  }
}

async function testOrdinaryUpdateDoesNotTripSop() {
  const store = createMemoryStore(sopGraph())
  const applied = await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'child', text: 'A-edit' } },
    { version: 2 }
  )
  assert.strictEqual(applied.event.type, 'node.updated')
  assert.strictEqual(inspectSopChange({
    type: 'node.update',
    payload: { uid: 'child', text: 'A-edit' },
    nodes: sopGraph(),
    targetUid: 'child'
  }).required, false)
}

async function testOrdinaryImportDoesNotTripSop() {
  const current = sopGraph()
  const next = { ...current, extra: { data: { uid: 'extra', text: 'x' }, children: [] } }
  next.root = { ...current.root, children: ['sop', 'extra'] }
  const trace = inspectSopChange({
    type: 'map.replace',
    payload: {},
    currentNodes: current,
    nextNodes: next
  })
  assert.strictEqual(trace.required, false)
}

async function testRealSopRenameRequiresConfirm() {
  const store = createMemoryStore(sopGraph())
  let code = ''
  try {
    await applyDirect(
      store,
      { type: 'node.update', payload: { uid: 'sop', text: '流程' } },
      { version: 3 }
    )
  } catch (err) {
    code = err.code
  }
  assert.strictEqual(code, 'SOP_CONFIRM_REQUIRED')
  const ok = await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'sop', text: '流程', confirm_sop_change: true }
    },
    { version: 4 }
  )
  assert.strictEqual(ok.event.type, 'node.updated')
}

async function testTerminalSets() {
  assert.strictEqual(isTerminalError('SOP_CONFIRM_REQUIRED'), true)
  assert.strictEqual(isTerminalError('CYCLE_REJECTED'), true)
  assert.strictEqual(isTerminalError('STALE_AFTER_VERSION_RESTORE'), true)
  assert.strictEqual(isTerminalError('FORBIDDEN'), true)
  assert.strictEqual(isRetryableError('ACK_TIMEOUT'), true)
  assert.strictEqual(isRetryableError('SOP_CONFIRM_REQUIRED'), false)
}

async function testSopQuarantineNoRetry() {
  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  const roomKey = 'room-vybh2lxq'
  await box.put({
    opId: '753eb6d8-3241-4e00-94dd-a7907dbd5454',
    clientId,
    roomKey,
    clientSeq: 2,
    type: 'node.update',
    status: 'pending',
    errorCode: 'SOP_CONFIRM_REQUIRED',
    payload: { uid: 'child', text: 'x', baseRevision: 383 },
    originalBaseRevision: 383
  })
  const sent = []
  const adapter = createCollaborationAdapter({
    clientId,
    memory: true,
    outbox: box,
    socket: fakeJoinSocket(sent),
    timeoutMs: 400
  })
  await adapter.connect({ roomKey, userId: 'dev-local', lastServerRevision: 654 })
  await new Promise(resolve => setTimeout(resolve, 40))
  const left = await box.list(clientId, roomKey)
  const sop = left.find(item => item.opId === '753eb6d8-3241-4e00-94dd-a7907dbd5454')
  assert.ok(sop)
  assert.strictEqual(sop.status, 'quarantined')
  assert.ok(!sent.some(item => item.ev === 'op' && item.payload && item.payload.opId === sop.opId))
}

async function testIndependentOpsContinue() {
  assert.strictEqual(
    dependsOnBlockedOp(
      { type: 'node.update', payload: { uid: 'b' }, clientSeq: 3 },
      { type: 'node.update', payload: { uid: 'a' }, clientSeq: 2 }
    ),
    false
  )
  assert.strictEqual(
    dependsOnBlockedOp(
      { type: 'node.update', payload: { uid: 'a', text: 'later' }, clientSeq: 3 },
      { type: 'node.update', payload: { uid: 'a' }, clientSeq: 2 }
    ),
    false
  )
  assert.strictEqual(
    dependsOnBlockedOp(
      { type: 'node.update', payload: { uid: 'a', text: 'later' }, clientSeq: 3 },
      { type: 'node.insert', payload: { uid: 'a' }, clientSeq: 2 }
    ),
    true
  )
  assert.strictEqual(
    dependsOnBlockedOp(
      { type: 'node.delete', payload: { uid: 'n3' }, clientSeq: 5 },
      { type: 'node.move', payload: { uid: 'n1', parent: 'n3' }, clientSeq: 4 }
    ),
    false
  )
}

async function testSendRebasesOldBaseRevision() {
  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  const roomKey = 'r-rebase'
  await box.put({
    opId: createOpId(),
    clientId,
    roomKey,
    userId: 'u1',
    clientSeq: 1,
    type: 'node.update',
    status: 'pending',
    baseRevision: 383,
    observedRevision: 383,
    originalBaseRevision: 383,
    payload: { uid: 'n1', text: 'Hello', baseRevision: 383 }
  })
  const sent = []
  const adapter = createCollaborationAdapter({
    clientId,
    memory: true,
    outbox: box,
    socket: fakeJoinSocket(sent, { serverRevision: 654 }),
    timeoutMs: 400
  })
  await adapter.connect({ roomKey, userId: 'u1', lastServerRevision: 654 })
  await new Promise(resolve => setTimeout(resolve, 50))
  const opSend = sent.find(item => item.ev === 'op')
  assert.ok(opSend)
  assert.strictEqual(Number(opSend.payload.baseRevision), 654)
  assert.strictEqual(Number(opSend.payload.payload.baseRevision), 654)
}

async function testClaimOrphanClientId() {
  const storage = {
    data: {},
    getItem(key) {
      return this.data[key] || null
    },
    setItem(key, value) {
      this.data[key] = String(value)
    }
  }
  writeClientHeartbeat(storage, 'alive', Date.now())
  assert.strictEqual(
    canClaimOrphan(
      { clientId: 'alive', userId: 'u', roomKey: 'r', status: 'pending' },
      { clientId: 'new', userId: 'u', roomKey: 'r' },
      storage
    ),
    false
  )
  assert.strictEqual(
    canClaimOrphan(
      { clientId: 'dead', userId: 'u', roomKey: 'r', status: 'pending' },
      { clientId: 'new', userId: 'u', roomKey: 'r' },
      storage
    ),
    true
  )
}

async function testInsertThenUpdateOrder() {
  const store = createMemoryStore(sopGraph())
  await applyDirect(
    store,
    { type: 'node.insert', payload: { uid: 'n', parent: 'child', text: '新节点' } },
    { version: 5 }
  )
  await applyDirect(
    store,
    { type: 'node.update', payload: { uid: 'n', text: 'Hello' } },
    { version: 6 }
  )
  assert.strictEqual(store.graph.n.data.text, 'Hello')
}

async function testInsertThenDelete() {
  const store = createMemoryStore(sopGraph())
  await applyDirect(
    store,
    { type: 'node.insert', payload: { uid: 'gone', parent: 'child', text: 'x' } },
    { version: 7 }
  )
  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'gone' } },
    { version: 8 }
  )
  assert.ok(!store.graph.gone || store.graph.gone.deleted)
}

async function testViewerForbidden() {
  const sent = []
  const adapter = createCollaborationAdapter({
    clientId: randomUUID(),
    memory: true,
    socket: fakeJoinSocket(sent, { role: 'viewer', canEdit: false }),
    timeoutMs: 400
  })
  await adapter.connect({ roomKey: 'r-view', userId: 'v1', lastServerRevision: 1 })
  let code = ''
  try {
    await adapter.submitOperation({
      type: 'node.update',
      payload: { uid: 'child', text: 'no' }
    })
  } catch (err) {
    code = err.code
  }
  assert.strictEqual(code, 'FORBIDDEN')
}

async function testOfflineSaveState() {
  const adapter = createCollaborationAdapter({
    clientId: randomUUID(),
    memory: true,
    socket: fakeJoinSocket([]),
    timeoutMs: 400
  })
  await adapter.connect({ roomKey: 'r-off', userId: 'u1', lastServerRevision: 1 })
  adapter.getStatus()
  assert.ok(['saved', 'idle', 'saving'].includes(adapter.getStatus().saveState))
}

;(async () => {
  await testOrdinaryUpdateDoesNotTripSop()
  await testOrdinaryImportDoesNotTripSop()
  await testRealSopRenameRequiresConfirm()
  await testTerminalSets()
  await testSopQuarantineNoRetry()
  await testIndependentOpsContinue()
  await testSendRebasesOldBaseRevision()
  await testClaimOrphanClientId()
  await testInsertThenUpdateOrder()
  await testInsertThenDelete()
  await testViewerForbidden()
  await testOfflineSaveState()
  console.log('collabReliability.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
