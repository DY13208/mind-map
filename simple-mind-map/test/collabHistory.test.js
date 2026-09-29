const assert = require('assert')
const { randomUUID } = require('crypto')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyMapReplace } = require('../bin/collabV2/slowPath')
const {
  createHistoryEngine,
  createMemoryHistoryStore,
  handleHistoryApi,
  planPendingAfterRestore,
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent
} = require('../bin/collabHistory')
const { historyChecksum, toBusinessTree, canonicalMetadata } = require('../bin/collabHistory/canonical')
const { replayOperations } = require('../bin/collabHistory/replayer')
const { isTerminalError } = require('../src/utils/collabReliability')

const ROOM = 'room-history-1'

function seed() {
  return {
    room: {
      roomKey: ROOM,
      revision: 0,
      nodes: {
        root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
      },
      metadata: { theme: 'classic', layout: 'mindMap' }
    }
  }
}

function engineWith(config) {
  const store = createMemoryHistoryStore(seed())
  const engine = createHistoryEngine({
    store,
    config: {
      checkpointEvery: 3,
      autoVersionMinMs: 60 * 60 * 1000,
      autoVersionOnCheckpoint: false,
      ...config
    }
  })
  return { store, engine }
}

async function commit(engine, raw) {
  const store = engine.store
  const live = await store.getLiveState(ROOM)
  const mem = createMemoryStore(live.nodes)
  mem.setMeta(live.metadata)
  const nextRev = live.revision + 1
  let nodes = mem.graph
  let event = { type: raw.type, payload: raw.payload || {} }
  if (raw.type === 'map.replace') {
    const replaced = applyMapReplace(mem.graph, raw, { payload: raw.payload })
    nodes = replaced.nodes
    event = replaced.event
    mem.setMeta(live.metadata)
  } else {
    const applied = await applyDirect(mem, raw, { version: nextRev })
    nodes = mem.graph
    event = applied.event
  }
  await store.setLiveState(ROOM, {
    revision: nextRev,
    nodes,
    metadata: mem.getMeta()
  })
  const op = {
    room_key: ROOM,
    version: nextRev,
    operation_id: randomUUID(),
    actor_id: raw.actor_id || 'u1',
    client_id: raw.client_id || 'c1',
    operation_type: raw.type,
    payload: raw.payload || {},
    event,
    inverse_payload: null
  }
  await store.appendOperation(op)
  await engine.onCommitted({
    roomKey: ROOM,
    version: nextRev,
    operation: op,
    nodes,
    metadata: mem.getMeta()
  })
  return op
}

function mockRes() {
  return {
    code: 0,
    body: null,
    writeHead(code) {
      this.code = code
    },
    end(buf) {
      this.body = JSON.parse(String(buf || '{}'))
    }
  }
}

;(async () => {
  const { engine, store } = engineWith()

  const cp0 = await engine.createCheckpoint(ROOM, { reason: 'INITIAL', createdBy: 'u1' })
  assert.ok(cp0.checksum)
  assert.ok(cp0.tree_snapshot.root)
  assert.strictEqual(cp0.metadata_snapshot.theme, 'classic')

  const at0 = await engine.getRoomStateAtRevision(ROOM, 0)
  assert.strictEqual(at0.checksum, cp0.checksum)
  assert.strictEqual(at0.readOnly, true)

  await commit(engine, { type: 'node.insert', payload: { uid: 'a', parent: 'root', text: 'A' } })
  await commit(engine, { type: 'node.update', payload: { uid: 'a', text: 'A1' } })
  await commit(engine, {
    type: 'node.insert',
    payload: { uid: 'b', parent: 'root', text: 'B' }
  })
  await commit(engine, { type: 'node.move', payload: { uid: 'b', parent: 'a', index: 0 } })
  await commit(engine, {
    type: 'node.batch',
    payload: {
      ops: [
        { type: 'node.insert', payload: { uid: 'c', parent: 'root', text: 'C' } },
        { type: 'node.update', payload: { uid: 'c', text: 'C1' } }
      ]
    }
  })
  await commit(engine, {
    type: 'map.meta.update',
    payload: { theme: 'dark', layout: 'logicalStructure' }
  })
  await commit(engine, { type: 'node.delete', payload: { uid: 'c' } })

  const live = await store.getLiveState(ROOM)
  const hist = await engine.getRoomStateAtRevision(ROOM, live.revision)
  assert.strictEqual(hist.tree.a.data.text, 'A1')
  assert.ok(hist.tree.a.children.includes('b'))
  assert.ok(!hist.tree.c || hist.tree.c.deleted)
  assert.strictEqual(hist.metadata.theme, 'dark')
  const hashes = []
  for (let i = 0; i < 8; i++) {
    const again = await engine.getRoomStateAtRevision(ROOM, live.revision)
    hashes.push(again.checksum)
  }
  assert.ok(hashes.every(h => h === hist.checksum))

  const before = JSON.stringify(await store.getLiveState(ROOM))
  await engine.getRoomStateAtRevision(ROOM, 1)
  assert.strictEqual(JSON.stringify(await store.getLiveState(ROOM)), before)

  const restoreReplay = await replayOperations(
    {
      root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
    },
    {},
    [
      {
        version: 1,
        operation_type: 'node.insert',
        payload: { uid: 'd', parent: 'root', text: 'D' }
      },
      { version: 2, operation_type: 'node.delete', payload: { uid: 'd' } },
      { version: 3, operation_type: 'node.restore', payload: { uid: 'd' } }
    ]
  )
  assert.ok(restoreReplay.tree.d)

  const undoReplayRows = [
    {
      version: 1,
      operation_id: 'history-update-root',
      actor_id: 'u1',
      operation_type: 'node.update',
      payload: { uid: 'root', text: 'History changed' },
      inverse_payload: {
        type: 'node.update',
        payload: { uid: 'root', text: 'Root' }
      }
    },
    {
      version: 2,
      operation_id: 'history-undo-a',
      actor_id: 'u1',
      operation_type: 'operation.undo',
      payload: { targetOperationId: 'history-update-root' }
    },
    {
      version: 3,
      operation_id: 'history-redo-a',
      actor_id: 'u1',
      operation_type: 'operation.redo',
      payload: { targetOperationId: 'history-update-root' }
    }
  ]
  const undoneReplay = await replayOperations(
    {
      root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
    },
    {},
    undoReplayRows.slice(0, 2),
    { requireContinuous: true, fromRevision: 0 }
  )
  assert.strictEqual(undoneReplay.tree.root.data.text, 'Root')
  const redoneReplay = await replayOperations(
    {
      root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
    },
    {},
    undoReplayRows,
    { requireContinuous: true, fromRevision: 0 }
  )
  assert.strictEqual(redoneReplay.tree.root.data.text, 'History changed')

  const importTree = {
    data: { uid: 'root', text: 'Imported' },
    children: [{ data: { uid: 'x', text: 'X', generalization: [{ uid: 'g1', text: '概要' }] }, children: [] }]
  }
  await commit(engine, {
    type: 'map.replace',
    payload: { tree: importTree, reason: 'IMPORT' }
  })
  const afterImport = await store.getLiveState(ROOM)
  const importCp = await store.latestCheckpointAt(ROOM, afterImport.revision)
  assert.ok(importCp)
  assert.strictEqual(importCp.reason, 'IMPORT')
  const reconstructedImport = await engine.getRoomStateAtRevision(ROOM, afterImport.revision)
  assert.strictEqual(reconstructedImport.checkpointRevision, afterImport.revision)
  assert.strictEqual(reconstructedImport.operationCount, 0)
  const owner = Object.values(reconstructedImport.tree).find(
    node => node.data && Array.isArray(node.data.generalization)
  )
  assert.ok(owner)
  assert.ok(!reconstructedImport.tree.g1)

  await commit(engine, {
    type: 'node.update',
    payload: {
      uid: owner.data.uid,
      outerFrame: { stroke: '#333' },
      associativeLineTargets: ['root']
    }
  })

  const manual = await engine.createVersion(ROOM, {
    name: '上线前',
    description: '2026 Q4 SOP',
    createdBy: 'owner-1',
    type: 'MANUAL'
  })
  assert.strictEqual(manual.type, 'MANUAL')
  const listed = await engine.listVersions(ROOM, { limit: 10 })
  assert.ok(listed.versions.every(row => row.tree_snapshot == null))
  const detail = await engine.getVersion(ROOM, manual.id)
  assert.strictEqual(detail.name, '上线前')
  assert.ok(!detail.tree_snapshot)

  const autoEngine = engineWith({
    checkpointEvery: 2,
    autoVersionOnCheckpoint: true,
    autoVersionMinMs: 1
  })
  await autoEngine.engine.createCheckpoint(ROOM, { reason: 'INITIAL' })
  await commit(autoEngine.engine, {
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: '1' }
  })
  await commit(autoEngine.engine, {
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: '2' }
  })
  const autos = await autoEngine.engine.listVersions(ROOM, { type: 'AUTO' })
  assert.ok(autos.versions.length >= 1)

  const summary = await engine.summarizeRange(ROOM, 0, (await store.getLiveState(ROOM)).revision)
  assert.ok(summary.inserted >= 1)
  assert.ok(summary.updated >= 1)
  assert.ok(summary.deleted >= 1)
  assert.ok(summary.moved >= 1)
  assert.strictEqual(summary.metadataChanged, true)
  assert.strictEqual(summary.replaced, true)

  // 结构补水（childCount）和“普通文本 -> 等价富文本”的自动规范化不是用户修改。
  const classification = engineWith()
  await classification.store.appendOperation({
    room_key: ROOM,
    version: 1,
    operation_id: randomUUID(),
    operation_type: 'node.update',
    payload: { uid: 'a', childCount: 1 },
    inverse_payload: { payload: { uid: 'a', childCount: 0 } }
  })
  await classification.store.appendOperation({
    room_key: ROOM,
    version: 2,
    operation_id: randomUUID(),
    operation_type: 'node.batch',
    payload: {
      ops: [
        {
          type: 'node.update',
          payload: { uid: 'a', text: '<p>A</p>', richText: true }
        },
        { type: 'node.update', payload: { uid: 'b', text: '<p>B2</p>', richText: true } }
      ]
    },
    inverse_payload: {
      payload: {
        ops: [
          { type: 'node.update', payload: { uid: 'b', text: 'B', richText: null } },
          { type: 'node.update', payload: { uid: 'a', text: 'A', richText: null } }
        ]
      }
    }
  })
  const classified = await classification.engine.summarizeRange(ROOM, 0, 2)
  assert.strictEqual(classified.updated, 1)

  // 有固定区间的旧摘要会在列表响应中按新规则重算，但不写回历史记录。
  await classification.store.setLiveState(ROOM, {
    revision: 2,
    nodes: (await classification.store.getLiveState(ROOM)).nodes,
    metadata: (await classification.store.getLiveState(ROOM)).metadata
  })
  const legacySummary = await classification.engine.createVersion(ROOM, {
    revision: 2,
    type: 'AUTO',
    name: '旧统计版本',
    skipEnsure: true
  })
  await classification.store.updateVersionMeta(ROOM, legacySummary.id, {
    summary: {
      kind: 'edits',
      inserted: 0,
      updated: 5,
      deleted: 0,
      moved: 0,
      fromRevision: 0,
      toRevision: 2
    },
    summary_status: 'ready'
  })
  const refreshedList = await classification.engine.listVersions(ROOM, { limit: 10 })
  const refreshed = refreshedList.versions.find(row => row.id === legacySummary.id)
  assert.strictEqual(refreshed.summary.updated, 1)
  assert.strictEqual(refreshed.summary.algorithmVersion, 2)
  const legacyStoredSummary = await classification.store.getVersion(ROOM, legacySummary.id)
  assert.strictEqual(legacyStoredSummary.summary.updated, 5)
  assert.strictEqual(legacyStoredSummary.summary.algorithmVersion, undefined)

  const currentBefore = await store.getLiveState(ROOM)
  const targetRev = 3
  const restored = await engine.restoreVersion(ROOM, {
    targetRevision: targetRev,
    expectedCurrentRevision: currentBefore.revision,
    userId: 'owner-1'
  })
  assert.strictEqual(restored.newRevision, currentBefore.revision + 1)
  assert.ok(restored.newRevision > currentBefore.revision)
  const liveAfter = await store.getLiveState(ROOM)
  assert.strictEqual(liveAfter.revision, restored.newRevision)
  const histTarget = await engine.getRoomStateAtRevision(ROOM, targetRev)
  assert.strictEqual(historyChecksum(liveAfter.nodes, liveAfter.metadata), histTarget.checksum)
  const stillHaveOld = await engine.getRoomStateAtRevision(ROOM, currentBefore.revision)
  assert.ok(stillHaveOld.checksum)
  const pre = await engine.getVersion(ROOM, restored.preRestoreVersionId)
  assert.strictEqual(Number(pre.revision), currentBefore.revision)

  store.setFailNextRestore(true)
  const beforeFail = await store.getLiveState(ROOM)
  let rolled = false
  try {
    await engine.restoreVersion(ROOM, {
      targetRevision: 1,
      expectedCurrentRevision: beforeFail.revision,
      userId: 'owner-1'
    })
  } catch (err) {
    rolled = err.code === 'RESTORE_INJECTED_FAIL'
  }
  store.setFailNextRestore(false)
  assert.strictEqual(rolled, true)
  const afterFail = await store.getLiveState(ROOM)
  assert.strictEqual(afterFail.revision, beforeFail.revision)

  const expected = (await store.getLiveState(ROOM)).revision
  const r1 = engine.restoreVersion(ROOM, {
    targetRevision: 2,
    expectedCurrentRevision: expected,
    userId: 'o1'
  })
  const r2 = engine.restoreVersion(ROOM, {
    targetRevision: 2,
    expectedCurrentRevision: expected,
    userId: 'o2'
  })
  const settled = await Promise.allSettled([r1, r2])
  const rejected = settled.filter(item => item.status === 'rejected')
  assert.ok(rejected.length >= 1)
  assert.ok(rejected.some(item => item.reason && item.reason.code === 'RESTORE_CONFLICT'))

  const audit = await engine.listAudit(ROOM)
  assert.ok(audit.some(item => item.action === 'VERSION_RESTORE'))
  assert.ok(audit.some(item => item.action === 'VERSION_CREATE'))

  const bad = engineWith()
  await bad.engine.createCheckpoint(ROOM, { reason: 'INITIAL' })
  bad.store.checkpoints[0].checksum = 'deadbeef'
  let corrupt = ''
  try {
    await bad.engine.getRoomStateAtRevision(ROOM, 0)
  } catch (err) {
    corrupt = err.code
  }
  assert.strictEqual(corrupt, 'CHECKPOINT_CORRUPTED')

  assert.strictEqual(isTerminalError(STALE_AFTER_VERSION_RESTORE), true)
  const planned = planPendingAfterRestore([
    { opId: '1', status: 'pending' },
    { opId: '2', status: 'acked' }
  ])
  assert.strictEqual(planned.length, 1)
  assert.strictEqual(planned[0].errorCode, STALE_AFTER_VERSION_RESTORE)
  assert.strictEqual(
    isVersionRestoreEvent({
      type: 'map.replaced',
      payload: { reason: 'VERSION_RESTORE' }
    }),
    true
  )

  const httpEngine = engineWith().engine
  await httpEngine.createCheckpoint(ROOM, { reason: 'INITIAL' })
  await commit(httpEngine, {
    type: 'node.insert',
    payload: { uid: 'z', parent: 'root', text: 'Z' }
  })
  const created = await httpEngine.createVersion(ROOM, { name: 'v1', createdBy: 'owner' })
  const res = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions/${created.id}/tree`,
      roomAccess: { userId: 'viewer' }
    },
    res,
    { engine: httpEngine }
  )
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.viewingHistory, true)
  assert.strictEqual(res.body.mutable, false)
  assert.ok(res.body.tree)
  const liveHttp = await httpEngine.store.getLiveState(ROOM)
  const resRestore = mockRes()
  await handleHistoryApi(
    {
      method: 'POST',
      url: `/api/files/${ROOM}/versions/${created.id}/restore`,
      roomAccess: { userId: 'owner' }
    },
    resRestore,
    {
      engine: httpEngine,
      body: { expectedCurrentRevision: liveHttp.revision }
    }
  )
  assert.strictEqual(resRestore.code, 200)
  assert.ok(resRestore.body.newRevision > liveHttp.revision)
  assert.strictEqual(resRestore.body.fullTreeReason, 'VERSION_RESTORE')

  const legacyNodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  }
  for (let i = 0; i < 100; i++) {
    const uid = 'n' + i
    legacyNodes[uid] = { data: { uid, text: 'N' + i }, children: [] }
    legacyNodes.root.children.push(uid)
  }
  const legacyMeta = { theme: 'classic', layout: 'mindMap' }
  const legacyStore = createMemoryHistoryStore({
    room: {
      roomKey: ROOM,
      revision: 654,
      nodes: legacyNodes,
      metadata: legacyMeta
    }
  })
  for (let v = 650; v <= 654; v++) {
    legacyStore.ops.push({
      room_key: ROOM,
      version: v,
      operation_id: 'partial-' + v,
      operation_type: 'node.update',
      payload: { uid: 'n0', text: 'x' }
    })
  }
  const legacyEngine = createHistoryEngine({
    store: legacyStore,
    config: { checkpointEvery: 100000, autoVersionOnCheckpoint: false }
  })
  const bootAudit = await legacyEngine.auditHistoryCoverage(ROOM)
  assert.strictEqual(bootAudit.roomKey, ROOM)
  assert.strictEqual(bootAudit.currentRevision, 654)
  assert.strictEqual(bootAudit.operationMinRevision, 650)
  assert.strictEqual(bootAudit.operationMaxRevision, 654)
  assert.strictEqual(bootAudit.operationCount, 5)
  assert.strictEqual(bootAudit.hasCheckpoint, false)
  assert.strictEqual(bootAudit.operationHistoryCompleteFromGenesis, false)

  const baseline = await legacyEngine.ensureHistoryBaseline(ROOM)
  assert.strictEqual(baseline.reason, 'HISTORY_BOOTSTRAP')
  assert.strictEqual(Number(baseline.revision), 654)
  assert.strictEqual(
    baseline.checksum,
    historyChecksum(toBusinessTree(legacyNodes), canonicalMetadata(legacyMeta))
  )
  assert.deepStrictEqual(baseline.metadata_snapshot.theme, 'classic')
  assert.ok(baseline.node_count >= 101)
  const idem = await legacyEngine.ensureHistoryBaseline(ROOM)
  assert.strictEqual(Number(idem.revision), 654)
  assert.strictEqual(
    legacyStore.checkpoints.filter(item => item.reason === 'HISTORY_BOOTSTRAP').length,
    1
  )

  const atBaseline = await legacyEngine.getRoomStateAtRevision(ROOM, 654)
  assert.strictEqual(atBaseline.checksum, baseline.checksum)
  assert.strictEqual(atBaseline.checkpointRevision, 654)
  let unavailable = ''
  try {
    await legacyEngine.getRoomStateAtRevision(ROOM, 100)
  } catch (err) {
    unavailable = err.code
  }
  assert.strictEqual(unavailable, 'HISTORY_REVISION_UNAVAILABLE')
  const coverage = await legacyEngine.getHistoryCoverage(ROOM)
  assert.strictEqual(coverage.earliestAvailableRevision, 654)
  assert.strictEqual(coverage.completeFromRevision, 654)

  let restoreUnavailable = ''
  try {
    await legacyEngine.restoreVersion(ROOM, {
      targetRevision: 100,
      expectedCurrentRevision: 654,
      userId: 'owner-1'
    })
  } catch (err) {
    restoreUnavailable = err.code
  }
  assert.strictEqual(restoreUnavailable, 'HISTORY_REVISION_UNAVAILABLE')

  // A legacy room can have continuous revision numbers while its earliest
  // operation still references nodes that existed before Collab V2 logging.
  // It must open history from a current-state bootstrap instead of failing.
  const incompatibleReplayStore = createMemoryHistoryStore({
    room: {
      roomKey: ROOM,
      revision: 2,
      nodes: {
        root: {
          isRoot: true,
          data: { uid: 'root', text: 'Root' },
          children: ['legacy']
        },
        legacy: {
          data: { uid: 'legacy', text: 'Current legacy node' },
          children: []
        }
      },
      metadata: { theme: 'classic' }
    }
  })
  incompatibleReplayStore.ops.push(
    {
      room_key: ROOM,
      version: 1,
      operation_id: 'legacy-update-1',
      operation_type: 'node.update',
      payload: { uid: 'legacy', text: 'Older text' }
    },
    {
      room_key: ROOM,
      version: 2,
      operation_id: 'legacy-update-2',
      operation_type: 'node.update',
      payload: { uid: 'legacy', text: 'Current legacy node' }
    }
  )
  const incompatibleReplayEngine = createHistoryEngine({
    store: incompatibleReplayStore,
    config: { checkpointEvery: 100000, autoVersionOnCheckpoint: false }
  })
  const incompatibleBaseline = await incompatibleReplayEngine.ensureHistoryBaseline(ROOM)
  assert.strictEqual(incompatibleBaseline.reason, 'HISTORY_BOOTSTRAP')
  assert.strictEqual(Number(incompatibleBaseline.revision), 2)
  const incompatibleCurrent = await incompatibleReplayEngine.getRoomStateAtRevision(ROOM, 2)
  assert.strictEqual(incompatibleCurrent.tree.legacy.data.text, 'Current legacy node')
  const incompatibleOpen = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions`,
      roomAccess: { userId: 'u1', canEdit: true }
    },
    incompatibleOpen,
    { engine: incompatibleReplayEngine }
  )
  assert.strictEqual(incompatibleOpen.code, 200)
  assert.ok((incompatibleOpen.body.versions || []).length > 0)

  const concurrentStore = createMemoryHistoryStore({
    room: {
      roomKey: ROOM,
      revision: 654,
      nodes: legacyNodes,
      metadata: legacyMeta
    }
  })
  const concurrentEngine = createHistoryEngine({
    store: concurrentStore,
    config: { checkpointEvery: 100000, autoVersionOnCheckpoint: false }
  })
  const settledBoot = await Promise.all([
    concurrentEngine.ensureHistoryBaseline(ROOM),
    concurrentEngine.ensureHistoryBaseline(ROOM)
  ])
  assert.strictEqual(Number(settledBoot[0].revision), 654)
  assert.strictEqual(Number(settledBoot[1].revision), 654)
  assert.strictEqual(
    concurrentStore.checkpoints.filter(item => Number(item.revision) === 654).length,
    1
  )

  const newRoom = engineWith({ checkpointEvery: 100000, autoVersionOnCheckpoint: false })
  const initial = await newRoom.engine.ensureHistoryBaseline(ROOM)
  assert.strictEqual(initial.reason, 'ROOM_INITIAL')
  assert.strictEqual(Number(initial.revision), 0)
  const afterImportBaseline = await newRoom.engine.ensureHistoryBaseline(ROOM)
  await commit(newRoom.engine, {
    type: 'map.replace',
    payload: {
      tree: {
        data: { uid: 'root', text: 'Imported-2' },
        children: [{ data: { uid: 'imp', text: 'I' }, children: [] }]
      },
      reason: 'IMPORT'
    }
  })
  const liveImp = await newRoom.store.getLiveState(ROOM)
  const reconImp = await newRoom.engine.getRoomStateAtRevision(ROOM, liveImp.revision)
  assert.strictEqual(reconImp.tree.root.data.text, 'Imported-2')
  assert.ok(reconImp.tree.imp)
  assert.strictEqual(afterImportBaseline.reason, 'ROOM_INITIAL')

  const listRes = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions`,
      roomAccess: { userId: 'viewer' }
    },
    listRes,
    { engine: legacyEngine }
  )
  assert.strictEqual(listRes.code, 200)
  assert.strictEqual(listRes.body.earliestAvailableRevision, 654)
  assert.strictEqual(listRes.body.currentRevision, 654)
  assert.strictEqual(listRes.body.completeFromRevision, 654)

  const flow = engineWith({
    checkpointEvery: 100000,
    autoVersionOnCheckpoint: false,
    autoVersionIdleMs: 1,
    autoVersionMinMs: 60 * 60 * 1000
  })
  const boot = await flow.engine.ensureHistoryBaseline(ROOM)
  assert.strictEqual(boot.reason, 'ROOM_INITIAL')
  const initialList = await flow.engine.listVersions(ROOM, { limit: 20 })
  assert.ok(initialList.versions.some(row => row.source_kind === 'room_initial'))
  await commit(flow.engine, {
    type: 'node.insert',
    payload: { uid: 'idle-a', parent: 'root', text: 'idle' }
  })
  await commit(flow.engine, {
    type: 'node.update',
    payload: { uid: 'idle-a', text: 'idle-2' }
  })
  const autosBefore = (await flow.engine.listVersions(ROOM, { type: 'AUTO' })).versions
    .length
  const due = await flow.engine.processDueAutoJobs(Date.now() + 50)
  assert.ok(due.length >= 1)
  const autosAfter = await flow.engine.listVersions(ROOM, { type: 'AUTO' })
  assert.ok(autosAfter.versions.length > autosBefore)
  assert.ok(
    autosAfter.versions.some(row => row.summary_status === 'ready' || row.summary)
  )

  const sameAuto = await flow.engine.createVersion(ROOM, {
    type: 'AUTO',
    revision: due[0].revision,
    name: 'dup',
    createdBy: 'u1'
  })
  assert.strictEqual(sameAuto.id, due[0].id)

  const snap = engineWith({
    checkpointEvery: 100000,
    autoVersionOnCheckpoint: false,
    autoVersionIdleMs: 60 * 60 * 1000,
    autoVersionMinMs: 60 * 60 * 1000
  })
  await snap.engine.ensureHistoryBaseline(ROOM)
  await commit(snap.engine, {
    type: 'node.insert',
    payload: { uid: 'now-a', parent: 'root', text: 'now' }
  })
  const beforeOpen = await snap.engine.listVersions(ROOM, { limit: 20 })
  assert.ok(
    !beforeOpen.versions.some(
      row => String(row.type).toUpperCase() === 'AUTO' && Number(row.revision) > 0
    )
  )
  const openRes = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions`,
      roomAccess: { userId: 'u1', canEdit: true, canManage: true }
    },
    openRes,
    { engine: snap.engine }
  )
  assert.strictEqual(openRes.code, 200)
  assert.ok(
    (openRes.body.versions || []).some(
      row => String(row.type).toUpperCase() === 'AUTO' && Number(row.revision) > 0
    ),
    'opening history should snapshot current edits'
  )
  const openAgain = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions`,
      roomAccess: { userId: 'u1', canEdit: true }
    },
    openAgain,
    { engine: snap.engine }
  )
  const flushedAutos = (openAgain.body.versions || []).filter(
    row => String(row.type).toUpperCase() === 'AUTO' && Number(row.revision) > 0
  )
  assert.strictEqual(flushedAutos.length, 1)

  for (let i = 0; i < 21; i++) {
    await flow.engine.createVersion(ROOM, {
      name: 'page-' + i,
      type: 'MANUAL',
      createdBy: 'u1'
    })
  }
  const page1 = await flow.engine.listVersions(ROOM, { limit: 20 })
  assert.strictEqual(page1.versions.length, 20)
  assert.ok(page1.nextCursor)
  const page2 = await flow.engine.listVersions(ROOM, {
    limit: 20,
    cursor: page1.nextCursor
  })
  assert.ok(page2.versions.length >= 1)
  assert.notStrictEqual(page2.versions[0].id, page1.versions[0].id)

  const hidden = await flow.engine.createVersion(ROOM, {
    name: 'hidden-one',
    type: 'MANUAL',
    createdBy: 'u1'
  })
  await flow.engine.hideVersion(ROOM, hidden.id, 'owner-1')
  assert.strictEqual(await flow.engine.getVersion(ROOM, hidden.id), null)
  const hideRes = mockRes()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions/${hidden.id}/tree`,
      roomAccess: { userId: 'viewer', canView: true }
    },
    hideRes,
    { engine: flow.engine }
  )
  assert.strictEqual(hideRes.code, 404)

  const target = (await flow.engine.listVersions(ROOM, { type: 'MANUAL', limit: 1 }))
    .versions[0]
  const liveNow = await flow.store.getLiveState(ROOM)
  const key = 'idem-' + randomUUID()
  const firstRestore = await flow.engine.restoreVersion(ROOM, {
    versionId: target.id,
    expectedCurrentRevision: liveNow.revision,
    userId: 'owner-1',
    idempotencyKey: key
  })
  const secondRestore = await flow.engine.restoreVersion(ROOM, {
    versionId: target.id,
    expectedCurrentRevision: 0,
    userId: 'owner-1',
    idempotencyKey: key
  })
  assert.strictEqual(firstRestore.newRevision, secondRestore.newRevision)
  assert.strictEqual(
    Number((await flow.store.getLiveState(ROOM)).restoreEpochRevision),
    firstRestore.newRevision
  )

  const createRes = mockRes()
  await handleHistoryApi(
    {
      method: 'POST',
      url: `/api/files/${ROOM}/versions`,
      roomAccess: { userId: 'editor', canEdit: true }
    },
    createRes,
    {
      engine: flow.engine,
      body: { name: 'manual-now', type: 'AUTO', revision: 0 }
    }
  )
  assert.strictEqual(createRes.code, 201)
  assert.strictEqual(createRes.body.version.type, 'MANUAL')
  assert.notStrictEqual(createRes.body.version.revision, 0)
  assert.ok(createRes.body.version.capabilities)
  assert.ok(createRes.body.version.summaryText)

  let gapCode = ''
  try {
    await replayOperations(
      { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } },
      {},
      [
        { version: 1, operation_type: 'node.insert', payload: { uid: 'z', parent: 'root', text: 'Z' } },
        { version: 3, operation_type: 'node.update', payload: { uid: 'z', text: 'Z2' } }
      ],
      { requireContinuous: true, fromRevision: 0 }
    )
  } catch (err) {
    gapCode = err.code
  }
  assert.strictEqual(gapCode, 'HISTORY_OPS_GAP')

  let unsupported = ''
  try {
    await replayOperations(
      { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } },
      {},
      [{ version: 1, operation_type: 'node.explode', payload: {} }],
      { requireContinuous: true, fromRevision: 0 }
    )
  } catch (err) {
    unsupported = err.code
  }
  assert.strictEqual(unsupported, 'HISTORY_REPLAY_UNSUPPORTED')

  const preview = await flow.engine.getVersionTree(ROOM, target.id)
  assert.ok(preview.tree)
  assert.ok(preview.readOnly)
  const previewAgain = await flow.engine.getVersionTree(ROOM, target.id)
  assert.strictEqual(previewAgain.checksum, preview.checksum)
  assert.ok(flow.engine.treeCache.size >= 1)

  await flow.store.upsertAutoJob({
    room_key: ROOM,
    last_revision: 1,
    due_at: new Date(Date.now() - 1000).toISOString(),
    editors: ['a']
  })
  const claimed = await flow.store.claimDueAutoJobs(Date.now(), 8, 'w1', 5)
  assert.ok(claimed.length >= 1)
  await flow.store.upsertAutoJob({
    room_key: ROOM,
    last_revision: 99,
    due_at: new Date(Date.now() + 1000).toISOString(),
    editors: ['b']
  })
  await flow.store.completeAutoJob(ROOM, 1)
  const leftover = await flow.store.claimDueAutoJobs(Date.now() + 5000, 8, 'w2', 5)
  assert.ok(leftover.some(job => Number(job.last_revision) === 99))

  const roomA = engineWith()
  const roomB = engineWith()
  roomB.store.roomOf(ROOM + '-b')
  const aLive = await roomA.store.getLiveState(ROOM)
  const bKey = ROOM + '-b'
  await roomB.store.setLiveState(bKey, {
    revision: 0,
    nodes: aLive.nodes,
    metadata: aLive.metadata
  })
  await roomA.engine.ensureHistoryBaseline(ROOM)
  await roomB.engine.ensureHistoryBaseline(bKey)
  const aVer = await roomA.engine.createVersion(ROOM, { name: 'a', type: 'MANUAL' })
  const bVer = await roomB.engine.createVersion(bKey, { name: 'b', type: 'MANUAL' })
  const [ra, rb] = await Promise.all([
    roomA.engine.restoreVersion(ROOM, {
      versionId: aVer.id,
      expectedCurrentRevision: (await roomA.store.getLiveState(ROOM)).revision,
      userId: 'o'
    }),
    roomB.engine.restoreVersion(bKey, {
      versionId: bVer.id,
      expectedCurrentRevision: (await roomB.store.getLiveState(bKey)).revision,
      userId: 'o'
    })
  ])
  assert.ok(ra.newRevision)
  assert.ok(rb.newRevision)

  // A successful pre-insert history flush is a hard summary boundary: pending
  // edits remain visible in their own AUTO version instead of being reported
  // as modifications alongside the following node creation.
  const boundary = engineWith()
  await boundary.engine.ensureHistoryBaseline(ROOM)
  await commit(boundary.engine, {
    type: 'node.update',
    payload: { uid: 'root', text: 'Root updated before insert' }
  })
  const updates = await boundary.engine.flushPendingAutoVersion(ROOM, {
    userId: 'u1',
    source: 'pre_insert'
  })
  assert.strictEqual(updates.summary.updated, 1)
  assert.strictEqual(updates.summary.inserted, 0)
  // previousVisibleVersion uses creation order for same-revision manual
  // snapshots; ensure this follow-up AUTO version has a later timestamp.
  await new Promise(resolve => setTimeout(resolve, 20))
  await commit(boundary.engine, {
    type: 'node.insert',
    payload: { uid: 'boundary-node', parent: 'root', text: 'New node' }
  })
  const inserts = await boundary.engine.flushPendingAutoVersion(ROOM, {
    userId: 'u1',
    source: 'history_open'
  })
  assert.strictEqual(inserts.summary.inserted, 1)
  assert.strictEqual(inserts.summary.updated, 0)

  // Auto and manual editor attribution comes from the exact operation interval,
  // while createdBy remains the actor who triggered the version request.
  const attribution = engineWith({ checkpointEvery: 100000 })
  await attribution.engine.ensureHistoryBaseline(ROOM)
  await commit(attribution.engine, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Root by Chen' }
  })
  await commit(attribution.engine, {
    type: 'node.update',
    actor_id: 'alex',
    payload: { uid: 'root', note: 'Alex note' }
  })
  const attributedAuto = await attribution.engine.flushPendingAutoVersion(ROOM, {
    userId: 'history-viewer',
    editors: ['history-viewer'],
    source: 'history_open'
  })
  assert.deepStrictEqual(attributedAuto.editors, ['alex', 'chen'])
  assert.strictEqual(attributedAuto.created_by, 'history-viewer')
  assert.strictEqual(attributedAuto.summary.fromRevision, 0)
  assert.strictEqual(attributedAuto.summary.toRevision, 2)
  const autoAudit = (await attribution.store.listAudit(ROOM)).find(
    row => row.version_id === attributedAuto.id
  )
  assert.strictEqual(autoAudit.user_id, 'history-viewer')

  await commit(attribution.engine, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Root by Chen again' }
  })
  const attributedManual = await attribution.engine.createVersion(ROOM, {
    type: 'MANUAL',
    name: 'manual attribution',
    createdBy: 'manual-requester',
    editors: ['wrong-editor']
  })
  assert.deepStrictEqual(attributedManual.editors, ['chen'])
  assert.strictEqual(attributedManual.created_by, 'manual-requester')
  assert.strictEqual(attributedManual.summary.fromRevision, 2)
  assert.strictEqual(attributedManual.summary.toRevision, 3)

  // Existing rows are corrected for display from reliable operation ranges,
  // without persisting corrected attribution back into history metadata.
  const oldAttribution = engineWith({ checkpointEvery: 100000 })
  await oldAttribution.engine.ensureHistoryBaseline(ROOM)
  await commit(oldAttribution.engine, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Root changed' }
  })
  const oldAuto = await oldAttribution.store.insertVersion({
    room_key: ROOM,
    revision: 1,
    type: 'AUTO',
    name: 'legacy auto attribution',
    created_by: 'history-viewer',
    created_at: new Date(Date.now() + 1000).toISOString(),
    editors: ['history-viewer'],
    source_kind: 'auto',
    summary: { kind: 'edits', updated: 1, algorithmVersion: 2 },
    summary_status: 'ready'
  })
  const oldList = await oldAttribution.engine.listVersions(ROOM, { type: 'AUTO' })
  const oldPresented = oldList.versions.find(row => row.id === oldAuto.id)
  assert.deepStrictEqual(oldPresented.editors.map(item => item.userId), ['chen'])
  assert.strictEqual(oldPresented.created_by, 'history-viewer')
  assert.strictEqual(oldPresented.summary.fromRevision, 0)
  assert.strictEqual(oldPresented.summary.toRevision, 1)
  const oldStoredAfter = await oldAttribution.store.getVersion(ROOM, oldAuto.id)
  assert.deepStrictEqual(oldStoredAfter.editors, ['history-viewer'])

  // Hidden or missing predecessors make old ranges uncertain, so display no
  // editors instead of guessing from createdBy or the earliest checkpoint.
  const hiddenPredecessor = engineWith({ checkpointEvery: 100000 })
  const hiddenBaseline = await hiddenPredecessor.engine.ensureHistoryBaseline(ROOM)
  const baselineVersion = (await hiddenPredecessor.engine.listVersions(ROOM, {}))
    .versions.find(row => row.source_kind === 'room_initial')
  assert.ok(hiddenBaseline)
  assert.ok(baselineVersion)
  await hiddenPredecessor.engine.hideVersion(ROOM, baselineVersion.id, 'owner')
  await commit(hiddenPredecessor.engine, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Root changed under hidden base' }
  })
  const hiddenOld = await hiddenPredecessor.store.insertVersion({
    room_key: ROOM,
    revision: 1,
    type: 'AUTO',
    name: 'hidden predecessor range',
    created_by: 'history-viewer',
    created_at: new Date(Date.now() + 1000).toISOString(),
    editors: ['history-viewer'],
    source_kind: 'auto',
    summary: { kind: 'edits', updated: 1, algorithmVersion: 2 },
    summary_status: 'ready'
  })
  const hiddenRows = await hiddenPredecessor.engine.listVersions(ROOM, { type: 'AUTO' })
  const hiddenPresented = hiddenRows.versions.find(row => row.id === hiddenOld.id)
  assert.deepStrictEqual(hiddenPresented.editors, [])

  const missingPredecessor = engineWith({ checkpointEvery: 100000 })
  await missingPredecessor.engine.ensureHistoryBaseline(ROOM)
  await commit(missingPredecessor.engine, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Root changed without earlier version row' }
  })
  const noPredecessorOld = await missingPredecessor.store.insertVersion({
    room_key: ROOM,
    revision: 1,
    type: 'AUTO',
    name: 'missing predecessor range',
    created_by: 'history-viewer',
    created_at: '2000-01-01T00:00:00.000Z',
    editors: ['history-viewer'],
    source_kind: 'auto',
    summary: { kind: 'edits', updated: 1, algorithmVersion: 2 },
    summary_status: 'ready'
  })
  const noPredecessorRows = await missingPredecessor.engine.listVersions(ROOM, {
    type: 'AUTO'
  })
  const noPredecessorPresented = noPredecessorRows.versions.find(
    row => row.id === noPredecessorOld.id
  )
  assert.deepStrictEqual(noPredecessorPresented.editors, [])

  const noRevision = await missingPredecessor.store.insertVersion({
    room_key: ROOM,
    revision: null,
    type: 'AUTO',
    name: 'null revision attribution',
    created_by: 'history-viewer',
    editors: ['history-viewer'],
    source_kind: 'auto',
    summary: { kind: 'edits', updated: 1, algorithmVersion: 2 },
    summary_status: 'ready'
  })
  const noRevisionRows = await missingPredecessor.engine.listVersions(ROOM, {
    type: 'AUTO'
  })
  const noRevisionPresented = noRevisionRows.versions.find(
    row => row.id === noRevision.id
  )
  assert.deepStrictEqual(noRevisionPresented.editors, [])

  const actorStore = createMemoryHistoryStore(seed())
  await actorStore.appendOperation({ room_key: ROOM, version: 1, actor_id: 'z' })
  await actorStore.appendOperation({ room_key: ROOM, version: 3, actor_id: 'a' })
  const incompleteActors = await actorStore.listOperationActors(ROOM, [
    { id: 'gap', fromRevision: 0, toRevision: 3 }
  ])
  assert.deepStrictEqual(incompleteActors, [
    { id: 'gap', editors: [], complete: false }
  ])
  const hiddenTimelineStore = createMemoryHistoryStore(seed())
  const hiddenRow = await hiddenTimelineStore.insertVersion({
    room_key: ROOM,
    revision: 0,
    type: 'AUTO',
    created_at: '2026-01-01T00:00:00.000Z'
  })
  await hiddenTimelineStore.hideVersion(ROOM, hiddenRow.id)
  const afterHidden = await hiddenTimelineStore.insertVersion({
    room_key: ROOM,
    revision: 1,
    type: 'AUTO',
    created_at: '2026-01-01T00:00:01.000Z'
  })
  const previousHidden = await hiddenTimelineStore.listVersionPredecessors(ROOM, [
    afterHidden
  ])
  assert.strictEqual(previousHidden[0].previous.id, hiddenRow.id)

  // Separate engine instances share the store's room lock, preventing duplicate
  // auto versions when two history requests flush the same revision.
  const sharedStore = createMemoryHistoryStore(seed())
  const sharedEngineA = createHistoryEngine({ store: sharedStore })
  const sharedEngineB = createHistoryEngine({ store: sharedStore })
  await sharedEngineA.ensureHistoryBaseline(ROOM)
  await commit(sharedEngineA, {
    type: 'node.update',
    actor_id: 'chen',
    payload: { uid: 'root', text: 'Concurrent flush' }
  })
  await Promise.all([
    sharedEngineA.flushPendingAutoVersion(ROOM, { userId: 'viewer-a' }),
    sharedEngineB.flushPendingAutoVersion(ROOM, { userId: 'viewer-b' })
  ])
  const sharedAutos = (await sharedStore.listVersions(ROOM, { type: 'AUTO' })).versions
  assert.strictEqual(sharedAutos.filter(row => Number(row.revision) === 1).length, 1)

  // A worker claimed at revision 1 must not absorb a later edit committed before
  // it obtains the room lock; the follow-up job gets its own version boundary.
  const workerStore = createMemoryHistoryStore(seed())
  const workerEngineA = createHistoryEngine({
    store: workerStore,
    config: { autoVersionIdleMs: 1, checkpointEvery: 100000 }
  })
  const workerEngineB = createHistoryEngine({ store: workerStore })
  await workerEngineA.ensureHistoryBaseline(ROOM)
  await commit(workerEngineA, {
    type: 'node.update',
    actor_id: 'alpha',
    payload: { uid: 'root', text: 'Version one' }
  })
  const baseClaim = workerStore.claimDueAutoJobs.bind(workerStore)
  let claimedResolve
  let releaseClaimResolve
  const claimedSignal = new Promise(resolve => { claimedResolve = resolve })
  const claimGate = new Promise(resolve => { releaseClaimResolve = resolve })
  let pauseClaim = true
  workerStore.claimDueAutoJobs = async (...args) => {
    const jobs = await baseClaim(...args)
    if (pauseClaim && jobs.length) {
      pauseClaim = false
      claimedResolve()
      await claimGate
    }
    return jobs
  }
  const workerRun = workerEngineB.processDueAutoJobs(Date.now() + 5000)
  await claimedSignal
  await commit(workerEngineA, {
    type: 'node.update',
    actor_id: 'beta',
    payload: { uid: 'root', text: 'Version two' }
  })
  releaseClaimResolve()
  const workerFirst = await workerRun
  assert.strictEqual(workerFirst.length, 1)
  assert.strictEqual(Number(workerFirst[0].revision), 1)
  assert.deepStrictEqual(workerFirst[0].editors, ['alpha'])
  const workerSecond = await workerEngineA.processDueAutoJobs(Date.now() + 10000)
  assert.strictEqual(workerSecond.length, 1)
  assert.strictEqual(Number(workerSecond[0].revision), 2)
  assert.deepStrictEqual(workerSecond[0].editors, ['beta'])

  // Same-millisecond snapshots must follow the room revision, not UUID order.
  const tied = createMemoryHistoryStore(seed())
  const createdAt = '2026-01-01T00:00:00.000Z'
  await tied.insertVersion({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    room_key: ROOM,
    revision: 0,
    type: 'AUTO',
    created_at: createdAt
  })
  const newer = await tied.insertVersion({
    id: '00000000-0000-4000-8000-000000000000',
    room_key: ROOM,
    revision: 1,
    type: 'AUTO',
    created_at: createdAt
  })
  const latest = await tied.insertVersion({
    id: '11111111-1111-4111-8111-111111111111',
    room_key: ROOM,
    revision: 2,
    type: 'AUTO',
    created_at: '2026-01-01T00:00:00.001Z'
  })
  assert.strictEqual((await tied.previousVisibleVersion(ROOM, latest)).id, newer.id)

  console.log('collabHistory.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
