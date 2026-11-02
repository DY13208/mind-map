const assert = require('assert')
const { randomUUID } = require('crypto')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const {
  createHistoryEngine,
  createMemoryHistoryStore,
  handleHistoryApi
} = require('../bin/collabHistory')
const { historyChecksum } = require('../bin/collabHistory/canonical')
const { normalizeHistoryGraph } = require('../src/utils/historyTreeCounts')

const ROOM = 'history-counts-engine-test'

function seedRoom(options = {}) {
  const childCount = options.childCount == null ? 1 : options.childCount
  const descendantCount = options.descendantCount == null ? 1 : options.descendantCount
  const hasMore = options.hasMore == null ? false : options.hasMore
  return {
    roomKey: ROOM,
    revision: 1,
    nodes: {
      root: {
        isRoot: true,
        data: { uid: 'root', text: '根', childCount: 1, descendantCount: 2 },
        children: ['parent']
      },
      parent: {
        data: {
          uid: 'parent',
          text: '父节点',
          childCount,
          descendantCount,
          hasMore,
          expand: false,
          note: '保留备注',
          __fv: { childCount: 9 }
        },
        children: ['leaf']
      },
      leaf: {
        data: { uid: 'leaf', text: '叶子' },
        children: []
      }
    },
    metadata: { theme: 'classic', layout: 'mindMap' }
  }
}

function makeEngine(options = {}) {
  const store = createMemoryHistoryStore({ room: seedRoom(options) })
  const engine = createHistoryEngine({ store, config: { checkpointEvery: 99 } })
  return { store, engine }
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(String(body || '{}')) }
  }
}

function multiBranchGraph() {
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text: '根', childCount: 2, descendantCount: 4 },
      children: ['box', 'destination']
    },
    box: {
      data: { uid: 'box', text: '容器', childCount: 2, descendantCount: 2 },
      children: ['child', 'sibling']
    },
    destination: {
      data: { uid: 'destination', text: '目标', childCount: 0, descendantCount: 0 },
      children: []
    },
    child: { data: { uid: 'child', text: '子节点' }, children: [] },
    sibling: { data: { uid: 'sibling', text: '同级' }, children: [] }
  }
}

async function replayDirectOperations(rows, initialNodes = multiBranchGraph()) {
  const store = createMemoryHistoryStore({
    room: {
      roomKey: ROOM,
      revision: 1,
      nodes: initialNodes,
      metadata: { theme: 'classic', layout: 'mindMap' }
    }
  })
  const engine = createHistoryEngine({ store, config: { checkpointEvery: 99 } })
  await engine.createCheckpoint(ROOM, { revision: 1, reason: 'INITIAL' })

  let liveGraph = initialNodes
  for (const row of rows) {
    if (row.applyDirect) {
      const direct = createMemoryStore(liveGraph)
      const applied = await applyDirect(
        direct,
        { type: row.operation_type, payload: row.payload },
        { version: row.version, skipWritePreconditions: true }
      )
      liveGraph = direct.graph
      row.event = applied.event
      if (applied.inversePayload) row.inverse_payload = applied.inversePayload
    }
    await store.appendOperation({
      room_key: ROOM,
      version: row.version,
      operation_id: row.operation_id,
      actor_id: 'history-counts-test',
      client_id: 'history-counts-test',
      operation_type: row.operation_type,
      payload: row.payload,
      event: row.event || {},
      inverse_payload: row.inverse_payload || null
    })
  }
  await store.setLiveState(ROOM, {
    revision: rows[rows.length - 1].version,
    nodes: liveGraph,
    metadata: { theme: 'classic', layout: 'mindMap' }
  })
  const version = await engine.createVersion(ROOM, {
    revision: rows[rows.length - 1].version,
    type: 'MANUAL',
    name: '结构操作后',
    skipEnsure: true
  })
  return { store, engine, version }
}

async function deleteOnlyLeafAndCreateVersion(engine, store) {
  await engine.createCheckpoint(ROOM, { revision: 1, reason: 'INITIAL' })
  const live = await store.getLiveState(ROOM)
  const direct = createMemoryStore(live.nodes)
  direct.setMeta(live.metadata)
  const applied = await applyDirect(
    direct,
    { type: 'node.delete', payload: { uid: 'leaf' } },
    { version: 2, skipWritePreconditions: true }
  )
  const nodes = direct.graph
  await store.setLiveState(ROOM, { revision: 2, nodes, metadata: direct.getMeta() })
  await store.appendOperation({
    room_key: ROOM,
    version: 2,
    operation_id: randomUUID(),
    operation_type: 'node.delete',
    payload: { uid: 'leaf' },
    event: applied.event,
    inverse_payload: applied.inversePayload
  })
  const version = await engine.createVersion(ROOM, {
    revision: 2,
    type: 'AUTO',
    name: '删除后',
    skipEnsure: true
  })
  return version
}

async function main() {
  // Regression: previously this historical preview kept the stale count.
  const repro = makeEngine({ hasMore: true })
  const reproVersion = await deleteOnlyLeafAndCreateVersion(repro.engine, repro.store)
  const reproTree = await repro.engine.getVersionTree(ROOM, reproVersion.id)
  assert.strictEqual(reproTree.tree.parent.data.childCount, 0)
  assert.strictEqual(reproTree.tree.parent.data.descendantCount, 0)
  assert.strictEqual(reproTree.tree.parent.data.hasMore, undefined)

  const hasMoreFalse = makeEngine({ hasMore: false })
  const falseVersion = await deleteOnlyLeafAndCreateVersion(hasMoreFalse.engine, hasMoreFalse.store)
  const falseTree = await hasMoreFalse.engine.getVersionTree(ROOM, falseVersion.id)
  assert.strictEqual(falseTree.tree.parent.data.descendantCount, 0)

  const pristine = makeEngine({ hasMore: true })
  const originalCheckpoint = await pristine.engine.createCheckpoint(ROOM, {
    revision: 1,
    reason: 'INITIAL'
  })
  const originalChecksum = originalCheckpoint.checksum
  const originalStoredParent = JSON.parse(JSON.stringify(originalCheckpoint.tree_snapshot.parent.data))
  const oldState = await pristine.engine.getRoomStateAtRevision(ROOM, 1)
  assert.strictEqual(oldState.checksum, originalChecksum)
  assert.strictEqual(oldState.tree.parent.data.childCount, 1)
  assert.deepStrictEqual(originalCheckpoint.tree_snapshot.parent.data, originalStoredParent)

  const fullVersion = await pristine.engine.createVersion(ROOM, {
    revision: 1,
    type: 'MANUAL',
    name: '完整树',
    skipEnsure: true
  })
  const fullA = await pristine.engine.getVersionTree(ROOM, fullVersion.id)
  const fullB = await pristine.engine.getVersionTree(ROOM, fullVersion.id)
  assert.strictEqual(fullA.tree.parent.data.childCount, 1)
  assert.strictEqual(fullA.tree.parent.data.descendantCount, 1)
  assert.strictEqual(fullA.tree.parent.data.hasMore, undefined)
  assert.strictEqual(fullA.tree.parent.data.expand, false)
  assert.strictEqual(fullA.tree.parent.data.note, '保留备注')
  assert.deepStrictEqual(fullA.tree.parent.data.__fv, { childCount: 9 })
  assert.strictEqual(fullA.checksum, historyChecksum(fullA.tree, fullA.metadata))
  assert.strictEqual(fullA.checksum, fullB.checksum)
  assert.notStrictEqual(fullA.tree, fullB.tree)
  assert.ok(fullA.summary && typeof fullA.summary === 'object')
  fullA.tree.parent.data.text = '污染缓存'
  fullA.metadata.theme = '污染缓存'
  fullA.summary.cacheSentinel = '污染摘要'
  const fullC = await pristine.engine.getVersionTree(ROOM, fullVersion.id)
  assert.strictEqual(fullC.tree.parent.data.text, '父节点')
  assert.strictEqual(fullC.metadata.theme, 'classic')
  assert.strictEqual(fullC.summary.cacheSentinel, undefined)
  assert.strictEqual(pristine.store.checkpoints[0].checksum, originalChecksum)
  assert.deepStrictEqual(pristine.store.checkpoints[0].tree_snapshot.parent.data, originalStoredParent)

  const apiRes = response()
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${ROOM}/versions/${reproVersion.id}/tree`,
      roomAccess: { userId: 'viewer' }
    },
    apiRes,
    { engine: repro.engine }
  )
  assert.strictEqual(apiRes.status, 200)
  assert.strictEqual(apiRes.body.tree.parent.data.childCount, 0)
  assert.strictEqual(apiRes.body.tree.parent.data.descendantCount, 0)
  assert.strictEqual(apiRes.body.version.availability, reproVersion.availability)

  const restoreRoom = makeEngine({ hasMore: true })
  const staleVersion = await deleteOnlyLeafAndCreateVersion(restoreRoom.engine, restoreRoom.store)
  const restored = await restoreRoom.engine.restoreVersion(ROOM, {
    versionId: staleVersion.id,
    expectedCurrentRevision: 2,
    userId: 'owner'
  })
  const liveAfterRestore = await restoreRoom.store.getLiveState(ROOM)
  assert.deepStrictEqual(
    normalizeHistoryGraph(liveAfterRestore.nodes),
    restored.tree
  )
  assert.strictEqual(liveAfterRestore.nodes.parent.data.childCount, 0)
  assert.strictEqual(restored.tree.parent.data.childCount, 0)
  assert.strictEqual(restored.tree.parent.data.descendantCount, 0)
  assert.strictEqual(restored.tree.parent.data.hasMore, undefined)

  const legacy = makeEngine({ hasMore: true })
  legacy.store.legacyMaps.push({
    room_key: ROOM,
    version_id: 'legacy-counts',
    tree_snapshot: seedRoom({ hasMore: true }).nodes,
    metadata_snapshot: { theme: 'classic', layout: 'mindMap' }
  })
  const legacyRow = await legacy.store.insertVersion({
    room_key: ROOM,
    id: 'legacy-counts',
    type: 'LEGACY',
    revision: null,
    name: '旧版快照',
    availability: 'partial'
  })
  const legacyTree = await legacy.engine.getVersionTree(ROOM, legacyRow.id)
  assert.strictEqual(legacyTree.tree.parent.data.childCount, 1)
  assert.strictEqual(legacyTree.tree.parent.data.descendantCount, 1)
  assert.strictEqual(legacyTree.tree.parent.data.hasMore, undefined)
  assert.strictEqual(legacyTree.version.availability, 'partial')

  const corrupted = makeEngine()
  const corruptedCheckpoint = await corrupted.engine.createCheckpoint(ROOM, {
    revision: 1,
    reason: 'INITIAL'
  })
  const corruptedVersion = await corrupted.engine.createVersion(ROOM, {
    revision: 1,
    type: 'MANUAL',
    name: '损坏校验测试',
    skipEnsure: true
  })
  corrupted.store.checkpoints.find(item => item.id === corruptedCheckpoint.id).checksum = 'invalid-checksum'
  await assert.rejects(
    corrupted.engine.getVersionTree(ROOM, corruptedVersion.id),
    error => error && error.code === 'CHECKPOINT_CORRUPTED'
  )

  const keepChildren = await replayDirectOperations([{
    version: 2,
    operation_id: 'keep-children',
    operation_type: 'node.delete',
    payload: { uid: 'box', keepChildren: true },
    applyDirect: true
  }])
  const keptTree = await keepChildren.engine.getVersionTree(ROOM, keepChildren.version.id)
  assert.deepStrictEqual(keptTree.tree.root.children, ['child', 'destination', 'sibling'])
  assert.strictEqual(keptTree.tree.root.data.childCount, 3)
  assert.strictEqual(keptTree.tree.root.data.descendantCount, 3)

  const moved = await replayDirectOperations([{
    version: 2,
    operation_id: 'move-child',
    operation_type: 'node.move',
    payload: { uid: 'child', parent: 'destination', index: 0 },
    applyDirect: true
  }])
  const movedTree = await moved.engine.getVersionTree(ROOM, moved.version.id)
  assert.strictEqual(movedTree.tree.box.data.childCount, 1)
  assert.strictEqual(movedTree.tree.box.data.descendantCount, 1)
  assert.strictEqual(movedTree.tree.destination.data.childCount, 1)
  assert.strictEqual(movedTree.tree.destination.data.descendantCount, 1)

  const batched = await replayDirectOperations([{
    version: 2,
    operation_id: 'batch-delete',
    operation_type: 'node.batch',
    payload: {
      ops: [
        { type: 'node.delete', payload: { uid: 'child' } },
        { type: 'node.delete', payload: { uid: 'sibling' } }
      ]
    },
    applyDirect: true
  }])
  const batchTree = await batched.engine.getVersionTree(ROOM, batched.version.id)
  assert.strictEqual(batchTree.tree.box.data.childCount, 0)
  assert.strictEqual(batchTree.tree.box.data.descendantCount, 0)

  const undoRedo = await replayDirectOperations([
    {
      version: 2,
      operation_id: 'delete-for-undo-redo',
      operation_type: 'node.delete',
      payload: { uid: 'child' },
      applyDirect: true
    },
    {
      version: 3,
      operation_id: 'undo-delete',
      operation_type: 'operation.undo',
      payload: { targetOperationId: 'delete-for-undo-redo' }
    },
    {
      version: 4,
      operation_id: 'redo-delete',
      operation_type: 'operation.redo',
      payload: { targetOperationId: 'delete-for-undo-redo' }
    }
  ])
  const undoRedoTree = await undoRedo.engine.getVersionTree(ROOM, undoRedo.version.id)
  assert.strictEqual(undoRedoTree.tree.box.data.childCount, 1)
  assert.strictEqual(undoRedoTree.tree.box.data.descendantCount, 1)

  process.stdout.write('PASS: history read/cache/http/restore projects counts without changing stored checkpoint hashes\n')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
