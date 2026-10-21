const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')

function method(start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing source method: ${start}`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `missing source boundary: ${end}`)
  return source.slice(from, to).trim()
}

function normalizeAppliedUpdatePayload(input = {}) {
  const event = input.event || input
  const payload = event.payload || input.payload || {}
  return {
    uid: payload.uid || payload.nodeUid || '',
    patch: payload.patch || payload.data || {}
  }
}

function loadMethods() {
  const methods = [
    method('  getV2RevisionScope() {', '\n  isV2RevisionScopeCurrent('),
    method('  isV2RevisionScopeCurrent(scope) {', '\n  clearV2RevisionCompletions('),
    method('  clearV2RevisionCompletions() {', '\n  async replayV2AckCompletion('),
    method('  async replayV2AckCompletion(completion, scope, context) {', '\n  // Must be called from the serialized V2 apply/reconcile task'),
    method('  async markV2RevisionComplete(version, scope = this.getV2RevisionScope(), completion = null, context = null) {', '\n  // On a successful local ACK'),
    method('  reconcileAckedLocalOperation(result, capturedIntentEpochs, originalScope, type, payload) {', '\n  acknowledgeLocalNodeCreation('),
    method('  acknowledgeLocalNodeCreation(event, revision) {', '\n  submitV2('),
    method('  editSessionOperationFingerprint(uid, patch, expected) {', '\n  updateEditSessionDraft('),
    method('  submitV2(type, payload) {', '\n  cancelV2RemoteApply()'),
    method('  cancelV2RemoteApply() {', '\n  isV2RemoteApplyScopeCurrent('),
    method('  isV2RemoteApplyScopeCurrent(context) {', '\n  isV2RemoteApplyCurrent('),
    method('  isV2RemoteApplyCurrent(context) {', '\n  rebaseV2RemoteApplyContext('),
    method('  rebaseV2RemoteApplyContext(context) {', '\n  waitV2RendererReady('),
    method('  async applyV2RemoteOperation(op, meta = {}) {', '\n  async applyV2RemoteOperationNow('),
    method('  async applyV2RemoteOperationNow(op, meta = {}, context) {', '\n  async applyV2RemoteBatchEvents('),
    method('  onBeforeSetData() {', '\n  // 监听思维导图数据的重新设置事件'),
    method('  setCollabV2Adapter(adapter) {', '\n  establishV2HistoryBaseline('),
    method('  bumpAuthoritativeUidRev(uid, revision) {', '\n  // One authoritative per-command local intent epoch'),
    method('  acknowledgeLocalVersion(version, extra = {}) {', '\n  async recoverHttpCollab(')
  ]
  const sandbox = {
    v2Trace() {},
    collabTrace() {},
    createTraceId: () => 'trace-test',
    uidsFromPayload(type, payload = {}) { return payload.uid ? [payload.uid] : [] },
    payloadParentUid(payload = {}) { return payload.parentUid || payload.parent_uid || payload.parent || '' },
    applyCollabEvent(data) { return data },
    transformTreeDataToObject() { return {} },
    collabNodeFeatures: {
      normalizeAppliedUpdatePayload,
      guardFeatureStructuralMutation(payload) { return { hit: [], payload } }
    },
    collabSpecialObjects: {
      assertStructuredCloneSafeOperation() {},
      buildMapReplacePayload(tree, extra) { return { ...(extra || {}), tree } }
    },
    setTimeout,
    clearTimeout
  }
  return vm.runInNewContext(`({${methods.join(',\n')}})`, sandbox)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createContext({ version = 1, data = { text: 'optimistic-v3', note: 'note0' }, adapter: adapterOverride } = {}) {
  const methods = loadMethods()
  const nodes = new Map()
  const tree = { uid: 'root', children: [] }
  for (const [uid, nodeData] of Object.entries(data)) {
    // The default data object is the node payload; object-valued overrides can
    // provide additional loaded nodes for batch ACK cases.
    if (uid === 'text' || uid === 'note') continue
    nodes.set(uid, createNode(uid, nodeData))
  }
  if (!nodes.has('n')) nodes.set('n', createNode('n', { text: data.text, note: data.note }))
  const renderer = {
    renderTree: tree,
    root: { nodeData: tree },
    isRendering: false,
    renderTimer: null,
    hasWaitRendering: false,
    beginCount: 0,
    endCount: 0,
    beginRemoteRenderBatch() { this.beginCount += 1 },
    endRemoteRenderBatch() { this.endCount += 1 },
    findNodeByUid(uid) { return nodes.get(uid) || null }
  }
  const adapter = adapterOverride || {
    getStatus() { return { lastServerRevision: 500 } },
    getClientId() { return 'local-client' },
    submitOperation: async () => ({})
  }
  const context = {
    ...methods,
    guardWritePayload(type, payload) { return payload },
    observeGuardedIntentEvent() {},
    expectedFieldVersions(uid) { return { uid, '__fv.text': 0, '__fv.note': 0 } },
    httpRoomKey: 'room-a',
    httpCollabMode: true,
    collabV2Adapter: adapter,
    _v2RemoteApplyEpoch: 4,
    _v2RemoteApplyQueue: Promise.resolve(),
    _v2RendererWaiters: new Set(),
    lastAppliedVersion: version,
    collabStore: { versions: [], setLastAppliedVersion(next) { this.versions.push(next) } },
    localUndoStack: [],
    localRedoStack: [],
    pendingUids: new Set(),
    _pendingEditSessionByFingerprint: new Map(),
    dirtySubtrees: new Map(),
    _authoritativeRevByUid: new Map(),
    mindMap: { _destroyed: false, renderer },
    waitV2RendererReady: async () => true,
    currentData: null,
    scheduleRemoteRecoverCalls: [],
    scheduleRemoteRecover(next) { this.scheduleRemoteRecoverCalls.push(next) },
    markAckedFromPayload(type, payload) {
      if (payload && payload.uid) this.pendingUids.delete(payload.uid)
    },
    localIntentEpochOf() { return 1 },
    applyV2PayloadUpdate(payload = {}) {
      const node = renderer.findNodeByUid(payload.uid)
      if (!node) return false
      Object.assign(node.data, payload.patch || {})
      return true
    },
    applyV2PayloadInsert() { return true },
    applyV2PayloadMove() { return true },
    applyV2PayloadDelete() { return true },
    applyV2PayloadRestore() { return true },
    notifyV2ContentChange() {},
    notifySearchInvalidate() {},
    findTreeNode(root, uid) { return renderer.findNodeByUid(uid) },
    deferUnloadedRemote() { return false },
    syncHttpRemoteOperations() { return false },
    markRemoteDirty() {}
  }
  context.getNode = uid => renderer.findNodeByUid(uid)
  context.setNodes = rows => rows.forEach(([uid, row]) => nodes.set(uid, createNode(uid, row)))
  return context
}

function createNode(uid, data) {
  return {
    data: { uid, ...(data || {}) },
    getData(key) { return this.data[key] }
  }
}

async function testFutureAckWaitsForEarlierRemoteAndThenDrains() {
  const gate = deferred()
  const started = deferred()
  const context = createContext()
  let holdFirst = true
  context.waitV2RendererReady = async function (applyContext) {
    if (holdFirst) {
      holdFirst = false
      started.resolve()
      await gate.promise
    }
    return true
  }
  context.collabV2Adapter.submitOperation = async ({ type, payload }) => ({
    serverRevision: 3,
    opId: 'ack-3',
    operation: { type, payload: { ...payload }, serverRevision: 3 }
  })

  const remote2 = context.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'stale-v2' } } },
    serverRevision: 2
  })
  await started.promise
  let ackSettled = false
  const ack3 = context.submitV2('node.update', { uid: 'n', patch: { text: 'canonical-v3' } })
    .then(value => { ackSettled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ackSettled, false, 'ACK reconcile must wait behind the in-flight remote revision')
  assert.equal(context.getNode('n').data.text, 'optimistic-v3')
  assert.equal(context.lastAppliedVersion, 1)

  gate.resolve()
  assert.equal(await remote2, true)
  const ackResult = await ack3
  assert.equal(ackResult.version, 3)
  assert.equal(context.getNode('n').data.text, 'canonical-v3')
  assert.equal(context.lastAppliedVersion, 3)
  assert.deepEqual(context.collabStore.versions, [2, 3])

  assert.equal(await context.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'final-v4' } } },
    serverRevision: 4
  }), true)
  assert.equal(context.getNode('n').data.text, 'final-v4')
  assert.equal(context.lastAppliedVersion, 4)
  assert.deepEqual(context.collabStore.versions, [2, 3, 4])
}

async function testBatchAckRequiresEveryCanonicalChild() {
  const context = createContext({ data: { text: 'old-good', note: 'old-note' } })
  context.setNodes([['good', { text: 'old-good' }]])
  context.collabV2Adapter.submitOperation = async () => ({
    serverRevision: 3,
    opId: 'batch-ack',
    operation: {
      type: 'batch.applied',
      serverRevision: 3,
      payload: { events: [
        { type: 'node.updated', payload: { uid: 'good', patch: { text: 'new-good' } } },
        { type: 'node.updated', payload: { uid: 'missing', patch: { text: 'new-missing' } } }
      ] }
    }
  })
  const calls = []
  context.applyV2RemoteOperationNow = async op => {
    const normalized = normalizeAppliedUpdatePayload(op.event || op)
    calls.push(normalized.uid)
    if (normalized.uid === 'missing') return false
    Object.assign(context.getNode('good').data, normalized.patch)
    return true
  }
  const result = await context.submitV2('node.batch', { ops: [] })
  assert.equal(result.version, 3, 'committed server ACK remains successful when local reconcile needs recovery')
  assert.deepEqual(calls, ['good', 'missing'], 'all children must be checked before the batch revision is complete')
  assert.equal(context.getNode('good').data.text, 'new-good')
  assert.equal(context.lastAppliedVersion, 1)
  assert.deepEqual(context.scheduleRemoteRecoverCalls, [3])
}

async function testThrownReconcileDoesNotAdvanceWatermark() {
  const context = createContext()
  context.collabV2Adapter.submitOperation = async ({ type, payload }) => ({
    serverRevision: 2,
    opId: 'ack-2',
    operation: { type, payload, serverRevision: 2 }
  })
  context.applyV2RemoteOperationNow = async () => { throw new Error('apply failed') }
  const result = await context.submitV2('node.update', { uid: 'n', patch: { text: 'canonical-v2' } })
  assert.equal(result.version, 2)
  assert.equal(context.lastAppliedVersion, 1)
  assert.deepEqual(context.scheduleRemoteRecoverCalls, [2])
}

async function testFutureAckCanonicalPatchReplaysAfterGap() {
  const sameField = createContext({ version: 1, data: { text: 'optimistic-v3', note: 'note0' } })
  sameField.collabV2Adapter.submitOperation = async ({ type, payload }) => ({
    serverRevision: 3,
    opId: 'ack-3-same-field',
    operation: { type, payload: { ...payload, patch: { ...payload.patch } }, serverRevision: 3 }
  })

  const ack = await sameField.submitV2('node.update', { uid: 'n', patch: { text: 'canonical-v3' } })
  assert.equal(sameField.getNode('n').data.text, 'canonical-v3')
  assert.equal(sameField.lastAppliedVersion, 1, 'future ACK is retained without skipping the missing revision')
  assert.equal(sameField._v2RevisionCompletions.has(3), true)
  // The adapter caller may mutate its returned object; the queued canonical
  // replay must use the JSON snapshot captured before returning the ACK.
  ack.operation.payload.patch.text = 'mutated-after-return'

  assert.equal(await sameField.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'stale-v2' } } },
    serverRevision: 2
  }), true)
  assert.equal(sameField.getNode('n').data.text, 'canonical-v3', 'future ACK repairs an earlier same-field overwrite')
  assert.equal(sameField.lastAppliedVersion, 3)
  assert.equal(sameField._v2RevisionCompletions.size, 0)

  const differentField = createContext({ version: 1, data: { text: 'optimistic-v3', note: 'note0' } })
  differentField.collabV2Adapter.submitOperation = async ({ type, payload }) => ({
    serverRevision: 3,
    opId: 'ack-3-different-field',
    operation: { type, payload: { ...payload, patch: { ...payload.patch } }, serverRevision: 3 }
  })
  await differentField.submitV2('node.update', { uid: 'n', patch: { text: 'canonical-v3' } })
  assert.equal(await differentField.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { note: 'remote-note-v2' } } },
    serverRevision: 2
  }), true)
  assert.equal(differentField.getNode('n').data.text, 'canonical-v3', 'ACK replay restores only its canonical field')
  assert.equal(differentField.getNode('n').data.note, 'remote-note-v2', 'different-field revision remains applied')
  assert.equal(differentField.lastAppliedVersion, 3)
}

async function testFailedFutureAckReplayPreservesPrefixAndCanRetry() {
  for (const failureMode of ['false', 'throw']) {
    const context = createContext({ version: 1, data: { text: 'optimistic-v3', note: 'note0' } })
    context.collabV2Adapter.submitOperation = async ({ type, payload }) => ({
      serverRevision: 3,
      opId: `ack-3-${failureMode}`,
      operation: { type, payload: { ...payload, patch: { ...payload.patch } }, serverRevision: 3 }
    })
    await context.submitV2('node.update', { uid: 'n', patch: { text: 'canonical-v3' } })

    const applyNow = context.applyV2RemoteOperationNow
    let failReplay = true
    context.applyV2RemoteOperationNow = async function (op, meta, applyContext) {
      if (failReplay && meta && meta.fromAck) {
        if (failureMode === 'throw') throw new Error('transient canonical replay failure')
        return false
      }
      return applyNow.call(this, op, meta, applyContext)
    }

    assert.equal(await context.applyV2RemoteOperation({
      event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'stale-v2' } } },
      serverRevision: 2
    }), true)
    assert.equal(context.lastAppliedVersion, 2, 'a failed future ACK replay must not erase the successfully applied prefix')
    assert.equal(context._v2RevisionCompletions.has(3), true, 'failed canonical ACK remains available for retry')
    assert.deepEqual(context.collabStore.versions, [2])
    assert.deepEqual(context.scheduleRemoteRecoverCalls, [3])

    failReplay = false
    assert.equal(await context.markV2RevisionComplete(2, context.getV2RevisionScope()), true,
      'a duplicate completion retries draining the retained canonical ACK')
    assert.equal(context.getNode('n').data.text, 'canonical-v3')
    assert.equal(context.lastAppliedVersion, 3)
    assert.equal(context._v2RevisionCompletions.size, 0)
    assert.deepEqual(context.collabStore.versions, [2, 3])
  }
}

async function testFullCompletionBufferKeepsBlockedAckAgainstSameRevisionEcho() {
  const context = createContext({ version: 1, data: { text: 'stale', note: 'note0' } })
  const scope = context.getV2RevisionScope()
  for (let version = 10000; version < 12000; version += 1) {
    assert.equal(await context.markV2RevisionComplete(version, scope), true)
  }
  const completion = {
    kind: 'ack',
    snapshotValid: true,
    events: [{ type: 'node.updated', payload: { uid: 'n', patch: { text: 'canonical-v2' } }, serverRevision: 2 }],
    originalScope: { roomKey: scope.roomKey, adapter: scope.adapter, remoteApplyEpoch: scope.epoch },
    capturedIntentEpochs: new Map([['n', 1]])
  }
  const applyNow = context.applyV2RemoteOperationNow
  let failReplay = true
  context.applyV2RemoteOperationNow = async function (op, meta, applyContext) {
    if (failReplay && meta && meta.fromAck) return false
    return applyNow.call(this, op, meta, applyContext)
  }

  assert.equal(await context.markV2RevisionComplete(2, scope, completion), false)
  assert.equal(context._v2RevisionBlockedCompletion.record.kind, 'ack')
  assert.equal(context.lastAppliedVersion, 1)

  assert.equal(await context.markV2RevisionComplete(2, scope), false,
    'same-revision remote/self-echo cannot replace a blocked canonical ACK')
  assert.equal(context._v2RevisionBlockedCompletion.record.kind, 'ack')
  assert.equal(context.lastAppliedVersion, 1)
  assert.equal(context._v2RevisionCompletions.size, 2000)

  failReplay = false
  assert.equal(await context.markV2RevisionComplete(2, scope), true)
  assert.equal(context.getNode('n').data.text, 'canonical-v2')
  assert.equal(context.lastAppliedVersion, 2)
  assert.equal(context._v2RevisionBlockedCompletion, null)
  assert.equal(context._v2RevisionCompletions.size, 2000)
}

async function testScopeChangeDuringAckReplayDoesNotReinsertOldCompletion() {
  for (const scopeChange of ['cancel', 'room-switch']) {
    const context = createContext({ version: 1, data: { text: 'stale', note: 'note0' } })
    const scope = context.getV2RevisionScope()
    const started = deferred()
    const release = deferred()
    context.applyV2RemoteOperationNow = async () => {
      started.resolve()
      await release.promise
      return true
    }
    const completion = {
      kind: 'ack',
      snapshotValid: true,
      events: [{ type: 'node.updated', payload: { uid: 'n', patch: { text: 'canonical-v2' } }, serverRevision: 2 }],
      originalScope: { roomKey: scope.roomKey, adapter: scope.adapter, remoteApplyEpoch: scope.epoch },
      capturedIntentEpochs: new Map([['n', 1]])
    }

    const completing = context.markV2RevisionComplete(2, scope, completion)
    await started.promise
    if (scopeChange === 'room-switch') context.httpRoomKey = 'room-b'
    context.cancelV2RemoteApply()
    release.resolve()
    assert.equal(await completing, false)
    assert.equal(context.lastAppliedVersion, 1)
    assert.equal(context._v2RevisionCompletions.size, 0, 'cancel/scope change clears the completion buffer')
    assert.equal(context._v2RevisionBlockedCompletion, null, 'old ACK is not reinserted after the scope invalidates')
    assert.deepEqual(context.scheduleRemoteRecoverCalls, [], 'recovery is not scheduled into a newer editor scope')
  }
}

async function testCompletionOrderingScopeAndOverflow() {
  const context = createContext({ version: 1 })
  const scope = context.getV2RevisionScope()
  assert.equal(await context.markV2RevisionComplete(3, scope), true)
  assert.equal(context.lastAppliedVersion, 1)
  assert.equal(context._v2RevisionCompletions.size, 1)
  assert.equal(await context.markV2RevisionComplete(2, scope), true)
  assert.equal(context.lastAppliedVersion, 3)
  assert.deepEqual(context.collabStore.versions, [2, 3], 'each successfully applied prefix revision is published')
  assert.equal(context._v2RevisionCompletions.size, 0)

  assert.equal(await context.markV2RevisionComplete(5, scope), true)
  context.onBeforeSetData()
  assert.equal(context._v2RevisionCompletions.size, 0, 'snapshot/reset invalidates queued future completions')
  assert.equal(await context.markV2RevisionComplete(4, scope), false, 'old apply epoch cannot complete a revision')
  assert.equal(context.lastAppliedVersion, 3)

  const current = context.getV2RevisionScope()
  let recoveryAtOverflow
  context.scheduleRemoteRecover = version => { recoveryAtOverflow = version }
  for (let version = 10000; version < 12000; version += 1) {
    assert.equal(await context.markV2RevisionComplete(version, current), true)
  }
  assert.equal(context._v2RevisionCompletions.size, 2000)
  assert.equal(await context.markV2RevisionComplete(12000, current), false)
  assert.equal(context.lastAppliedVersion, 3, 'overflow schedules recovery and never jumps the head')
  assert.equal(recoveryAtOverflow, 12000)
}

async function testRemoteCompletionUsesRebasedSameRoomEpochOnly() {
  const gate = deferred()
  const started = deferred()
  const context = createContext({ version: 1, data: { text: 'before-snapshot', note: 'note0' } })
  let firstWait = true
  context.waitV2RendererReady = async () => {
    if (firstWait) {
      firstWait = false
      started.resolve()
      await gate.promise
    }
    return true
  }
  const applying = context.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'remote-v2' } } },
    serverRevision: 2
  })
  await started.promise
  context.onBeforeSetData()
  gate.resolve()
  assert.equal(await applying, true)
  assert.equal(context.getNode('n').data.text, 'remote-v2')
  assert.equal(context.lastAppliedVersion, 2, 'successfully reapplied same-room work completes under the new epoch')

  const adapterGate = deferred()
  const adapterStarted = deferred()
  const oldAdapterContext = createContext({ version: 1 })
  let adapterFirstWait = true
  oldAdapterContext.waitV2RendererReady = async () => {
    if (adapterFirstWait) {
      adapterFirstWait = false
      adapterStarted.resolve()
      await adapterGate.promise
    }
    return true
  }
  const stale = oldAdapterContext.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'old-adapter' } } },
    serverRevision: 2
  })
  await adapterStarted.promise
  oldAdapterContext.setCollabV2Adapter({
    getStatus() { return { lastServerRevision: 2 } },
    getClientId() { return 'new-client' }
  })
  adapterGate.resolve()
  assert.equal(await stale, false)
  assert.equal(oldAdapterContext.getNode('n').data.text, 'optimistic-v3')
  assert.equal(oldAdapterContext.lastAppliedVersion, 1)
  assert.equal(oldAdapterContext._v2RevisionCompletions.size, 0)
}

async function testAdapterHeadIsNotAnAppliedWatermark() {
  const context = createContext({ version: 5, data: { text: 'current', note: 'current-note' } })
  let updates = 0
  const originalUpdate = context.applyV2PayloadUpdate
  context.applyV2PayloadUpdate = payload => { updates += 1; return originalUpdate.call(context, payload) }
  const scope = context.getV2RevisionScope()
  const contextArg = {
    epoch: scope.epoch,
    tree: context.mindMap.renderer.renderTree,
    room: scope.roomKey,
    adapter: scope.adapter,
    revision: 5
  }
  assert.equal(await context.applyV2RemoteOperationNow({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { text: 'older' } } },
    serverRevision: 4
  }, {}, contextArg), true)
  assert.equal(updates, 0, 'snapshot watermark is completion evidence')
  assert.deepEqual(context.scheduleRemoteRecoverCalls, [])

  const delayed = createContext({ version: 1, data: { text: 'current-text', note: 'current-note' } })
  delayed._authoritativeRevByUid.set('n', 3)
  assert.equal(await delayed.applyV2RemoteOperation({
    event: { type: 'node.updated', payload: { uid: 'n', patch: { note: 'older-note' } } },
    serverRevision: 2
  }), true)
  assert.equal(delayed.getNode('n').data.note, 'older-note', 'same UID older operation for another field must still apply')
  assert.equal(delayed.getNode('n').data.text, 'current-text')
}

async function main() {
  await testFutureAckWaitsForEarlierRemoteAndThenDrains()
  await testBatchAckRequiresEveryCanonicalChild()
  await testThrownReconcileDoesNotAdvanceWatermark()
  await testFutureAckCanonicalPatchReplaysAfterGap()
  await testFailedFutureAckReplayPreservesPrefixAndCanRetry()
  await testFullCompletionBufferKeepsBlockedAckAgainstSameRevisionEcho()
  await testScopeChangeDuringAckReplayDoesNotReinsertOldCompletion()
  await testCompletionOrderingScopeAndOverflow()
  await testRemoteCompletionUsesRebasedSameRoomEpochOnly()
  await testAdapterHeadIsNotAnAppliedWatermark()
  console.log('collaboration ACK queue, completion watermark, scope, and stale-head checks passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
