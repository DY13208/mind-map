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
    actor_id: 'u1',
    client_id: 'c1',
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

  console.log('collabHistory.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
