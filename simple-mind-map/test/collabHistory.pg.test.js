const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')
assertHistoryPgTestEnvironment()

const assert = require('assert')
const { randomUUID } = require('crypto')
const h = require('./collabV2.pgHarness')
const {
  createHistoryEngine,
  createPgHistoryStore,
  handleHistoryApi
} = require('../bin/collabHistory')
const storage = require('../bin/storage')
const { migrateHistorySchema, stableUuid } = require('../bin/collabHistory/migrate')
const { historyChecksum, toBusinessTree } = require('../bin/collabHistory/canonical')

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

async function insertReplayOperation(pool, archived, row) {
  const table = archived ? 'room_operations_archive' : 'room_operations'
  await pool.query(
    `insert into ${table}
       (room_key, version, operation_id, actor_id, client_id, operation_type,
        payload, event, inverse_payload, created_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,'{}'::jsonb,$8::jsonb,now())`,
    [
      row.roomKey,
      row.version,
      row.id,
      'history-pg-user',
      'history-pg-client',
      row.type,
      JSON.stringify(row.payload || {}),
      row.inversePayload ? JSON.stringify(row.inversePayload) : null
    ]
  )
}

async function main() {
  const api = await h.tryPg()
  if (api.error) {
    throw api.error
  }
  const pool = api.getPool()
  const first = await migrateHistorySchema(pool)
  const second = await migrateHistorySchema(pool)
  assert.strictEqual(first.ok, true)
  assert.strictEqual(second.ok, true)

  const roomKey = 'hist-pg-' + randomUUID()
  await pool.query(
    `insert into rooms(room_key, title, cos_key, nodes, version)
     values ($1,$2,$3,'{}'::jsonb, 0)`,
    [roomKey, 'history pg', 'test/' + roomKey]
  )
  await pool.query(
    `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
     values ($1,'root',null,'00000000',$2::jsonb,true,0)`,
    [roomKey, JSON.stringify({ uid: 'root', text: 'Root' })]
  )

  const snapshots = []
  for (let i = 0; i < 4; i++) {
    const version = 1000 + i
    const nodes = {
      root: {
        isRoot: true,
        data: { uid: 'root', text: 'Snap ' + i },
        children: []
      }
    }
    snapshots.push({ version, nodes })
    await pool.query(
      `insert into room_snapshots(room_key, version, nodes, created_at)
       values ($1,$2,$3::jsonb, now() - ($4 || ' minutes')::interval)
       on conflict do nothing`,
      [roomKey, version, JSON.stringify(nodes), String(4 - i)]
    ).catch(async () => {
      await pool.query(
        `create table if not exists room_snapshots (
           room_key text not null,
           version bigint not null,
           nodes jsonb not null default '{}'::jsonb,
           created_at timestamptz not null default now(),
           primary key (room_key, version)
         )`
      )
      await pool.query(
        `insert into room_snapshots(room_key, version, nodes, created_at)
         values ($1,$2,$3::jsonb, now())
         on conflict do nothing`,
        [roomKey, version, JSON.stringify(nodes)]
      )
    })
  }

  const migrated = await migrateHistorySchema(pool)
  assert.strictEqual(migrated.ok, true)
  const mapped = await pool.query(
    `select count(*)::int as count from room_version_legacy_map where room_key = $1`,
    [roomKey]
  )
  assert.ok(Number(mapped.rows[0].count) >= 4, 'expected 4 legacy snapshots')
  const ids = snapshots.map(item =>
    stableUuid(['room_snapshots', roomKey, String(item.version)])
  )
  const remapped = await migrateHistorySchema(pool)
  const mapped2 = await pool.query(
    `select version_id::text as id from room_version_legacy_map
     where room_key = $1 order by old_pk`,
    [roomKey]
  )
  assert.strictEqual(Number((await pool.query(
    `select count(*)::int as count from room_version_legacy_map where room_key = $1`,
    [roomKey]
  )).rows[0].count), Number(mapped.rows[0].count))
  ids.forEach(id => {
    assert.ok(mapped2.rows.some(row => row.id === id), 'stable uuid ' + id)
  })

  const store = createPgHistoryStore(pool)
  const engine = createHistoryEngine({
    store,
    config: {
      checkpointEvery: 200,
      autoVersionOnCheckpoint: false,
      autoVersionIdleMs: 1,
      autoVersionMinMs: 60 * 60 * 1000
    }
  })

  // Undo and redo can reference operations on either side of the active/archive
  // boundary. Replaying from revision 3 forces getOperation to use its fallback
  // lookup for both targets.
  const replayRoomKey = 'hist-replay-' + randomUUID()
  const operationSchema = await pool.query(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = current_schema()
       and table_name in ('room_operations', 'room_operations_archive')
     order by table_name, ordinal_position`
  )
  const activeOperationColumns = operationSchema.rows
    .filter(row => row.table_name === 'room_operations')
    .map(row => row.column_name)
  const archivedOperationColumns = operationSchema.rows
    .filter(row => row.table_name === 'room_operations_archive')
    .map(row => row.column_name)
  assert.ok(activeOperationColumns.length && archivedOperationColumns.length)
  assert.notDeepStrictEqual(
    activeOperationColumns,
    archivedOperationColumns,
    'active and archived operation schemas must exercise differing UNION projections'
  )
  assert.ok(activeOperationColumns.includes('client_seq'))
  assert.ok(activeOperationColumns.includes('target_id'))
  assert.ok(archivedOperationColumns.includes('archived_at'))
  const checkpointTree = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Archived target', expand: false },
      children: ['child']
    },
    child: {
      isRoot: false,
      data: { uid: 'child', text: 'Active target' },
      children: []
    }
  }
  await pool.query(
    `insert into rooms(room_key, title, cos_key, nodes, metadata, version)
     values ($1,$2,$3,$4::jsonb,'{}'::jsonb,7)`,
    [replayRoomKey, 'cross checkpoint replay', 'test/' + replayRoomKey, JSON.stringify(checkpointTree)]
  )
  await storage.replaceRoomNodes(replayRoomKey, checkpointTree, 7)

  const archivedTargetId = randomUUID()
  const activeTargetId = randomUUID()
  const missingTargetId = randomUUID()
  await insertReplayOperation(pool, true, {
    roomKey: replayRoomKey,
    version: 1,
    id: archivedTargetId,
    type: 'node.update',
    payload: { uid: 'root', text: 'Archived target' },
    inversePayload: { type: 'node.update', payload: { uid: 'root', text: 'Root' } }
  })
  await insertReplayOperation(pool, false, {
    roomKey: replayRoomKey,
    version: 2,
    id: activeTargetId,
    type: 'node.update',
    payload: { uid: 'child', text: 'Active target' },
    inversePayload: { type: 'node.update', payload: { uid: 'child', text: 'Child' } }
  })
  await insertReplayOperation(pool, false, {
    roomKey: replayRoomKey,
    version: 3,
    id: randomUUID(),
    type: 'node.update',
    payload: { uid: 'root', expand: false },
    inversePayload: { type: 'node.update', payload: { uid: 'root', expand: true } }
  })
  await store.insertCheckpoint({
    room_key: replayRoomKey,
    revision: 3,
    tree_snapshot: checkpointTree,
    metadata_snapshot: {},
    reason: 'THRESHOLD',
    snapshot_version: 1,
    checksum: historyChecksum(checkpointTree, {}),
    node_count: 2
  })
  const replayOperations = [
    { version: 4, type: 'operation.undo', targetOperationId: archivedTargetId },
    { version: 5, type: 'operation.redo', targetOperationId: archivedTargetId },
    { version: 6, type: 'operation.undo', targetOperationId: activeTargetId },
    { version: 7, type: 'operation.redo', targetOperationId: activeTargetId },
    {
      version: 8,
      type: 'operation.undo',
      targetOperationId: missingTargetId,
      diagnosticMarker: 'private-node-body-marker'
    }
  ]
  for (const operation of replayOperations) {
    await insertReplayOperation(pool, false, {
      roomKey: replayRoomKey,
      version: operation.version,
      id: randomUUID(),
      type: operation.type,
      payload: {
        targetOperationId: operation.targetOperationId,
        diagnosticMarker: operation.diagnosticMarker
      }
    })
  }

  const archivedTarget = await store.getOperation(replayRoomKey, archivedTargetId)
  const activeTarget = await store.getOperation(replayRoomKey, activeTargetId)
  assert.ok(archivedTarget, 'target lookup finds archived operations')
  assert.ok(activeTarget, 'target lookup finds active operations')

  const replayVersionId = randomUUID()
  await store.insertVersion({
    id: replayVersionId,
    room_key: replayRoomKey,
    revision: 7,
    checkpoint_revision: 3,
    name: 'cross checkpoint replay',
    type: 'RESTORE',
    created_by: 'history-pg-user',
    source: 'pg-test',
    summary_status: 'na',
    availability: 'readable'
  })
  const replayedVersion = await engine.getVersionTree(replayRoomKey, replayVersionId)
  assert.strictEqual(replayedVersion.tree.root.data.text, 'Archived target')
  assert.strictEqual(replayedVersion.tree.child.data.text, 'Active target')

  await pool.query(
    `update rooms set version = 8 where room_key = $1`,
    [replayRoomKey]
  )
  await storage.replaceRoomNodes(replayRoomKey, checkpointTree, 8)
  const missingTargetOperation = replayOperations[4]
  const missingTargetOperationRow = await pool.query(
    `select operation_id::text as id from room_operations
     where room_key = $1 and version = 8`,
    [replayRoomKey]
  )
  const missingVersionId = randomUUID()
  await store.insertVersion({
    id: missingVersionId,
    room_key: replayRoomKey,
    revision: 8,
    checkpoint_revision: 3,
    name: 'missing undo target',
    type: 'RESTORE',
    created_by: 'history-pg-user',
    source: 'pg-test',
    summary_status: 'na',
    availability: 'readable'
  })
  let replayError
  try {
    await engine.getVersionTree(replayRoomKey, missingVersionId)
  } catch (error) {
    replayError = error
  }
  assert.ok(replayError, 'missing undo target rejects reconstruction')
  assert.strictEqual(replayError.code, 'HISTORY_REPLAY_FAILED')
  assert.strictEqual(replayError.cause && replayError.cause.code, 'NOT_FOUND')
  assert.strictEqual(replayError.details.revision, 8)
  assert.strictEqual(replayError.details.operationId, missingTargetOperationRow.rows[0].id)
  assert.strictEqual(replayError.details.targetOperationId, missingTargetOperation.targetOperationId)

  const loggedDiagnostics = []
  const originalConsoleError = console.error
  console.error = (...args) => loggedDiagnostics.push(args)
  const unavailableRes = mockRes()
  try {
    await handleHistoryApi(
      {
        method: 'GET',
        url: `/api/files/${replayRoomKey}/versions/${missingVersionId}/tree`,
        roomAccess: { userId: 'u', canView: true }
      },
      unavailableRes,
      { engine }
    )
  } finally {
    console.error = originalConsoleError
  }
  assert.strictEqual(unavailableRes.code, 409)
  assert.strictEqual(unavailableRes.body.error, '该历史版本不完整，无法预览')
  assert.ok(!JSON.stringify(unavailableRes.body).includes('NOT_FOUND'))
  assert.ok(!JSON.stringify(loggedDiagnostics).includes('private-node-body-marker'))
  assert.strictEqual(Object.prototype.hasOwnProperty.call(unavailableRes.body, 'cause'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(unavailableRes.body, 'details'), false)
  assert.strictEqual(loggedDiagnostics[0][1].causeCode, 'NOT_FOUND')
  assert.strictEqual(loggedDiagnostics[0][1].revision, 8)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(loggedDiagnostics[0][1], 'causeMessage'), false)

  // A duplicate AUTO version is an expected concurrent outcome. The unique
  // index conflict must not abort the caller's transaction.
  const autoClient = await pool.connect()
  let firstAuto
  let secondAuto
  try {
    await autoClient.query('begin')
    const txStore = createPgHistoryStore(autoClient)
    firstAuto = await txStore.insertVersion({
      id: randomUUID(),
      room_key: replayRoomKey,
      revision: 7,
      checkpoint_revision: 3,
      name: 'auto duplicate first',
      type: 'AUTO',
      created_by: 'history-pg-user',
      source: 'pg-test',
      availability: 'readable'
    })
    secondAuto = await txStore.insertVersion({
      id: randomUUID(),
      room_key: replayRoomKey,
      revision: 7,
      checkpoint_revision: 3,
      name: 'auto duplicate second',
      type: 'AUTO',
      created_by: 'history-pg-user',
      source: 'pg-test',
      availability: 'readable'
    })
    const transactionStillUsable = await autoClient.query('select 1 as ok')
    assert.strictEqual(transactionStillUsable.rows[0].ok, 1)
    await autoClient.query('commit')
  } catch (error) {
    await autoClient.query('rollback').catch(() => {})
    throw error
  } finally {
    autoClient.release()
  }
  assert.strictEqual(secondAuto.id, firstAuto.id)

  // A full import must capture both sides in the same transaction as its room
  // operation. Seed a room without any history baseline to cover legacy rooms.
  const importRoomKey = 'hist-import-' + randomUUID()
  const beforeImport = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: '导入前' },
      children: []
    }
  }
  const afterImport = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: '导入后' },
      children: ['added']
    },
    added: {
      isRoot: false,
      data: { uid: 'added', text: '新节点' },
      children: []
    }
  }
  await pool.query(
    `insert into rooms(room_key, title, cos_key, nodes, metadata, version)
     values ($1,$2,$3,$4::jsonb,'{}'::jsonb,7)`,
    [importRoomKey, 'map replace history', 'test/' + importRoomKey, JSON.stringify(beforeImport)]
  )
  await storage.replaceRoomNodes(importRoomKey, beforeImport, 7)
  const importOperationId = randomUUID()
  const importCommand = {
    operationId: importOperationId,
    mapId: importRoomKey,
    actorId: 'import-user',
    clientId: 'history-test',
    baseVersion: 7,
    type: 'map.replace',
    payload: { resnapshot: true }
  }
  const imported = await storage.commitRoomOperation(
    importRoomKey,
    importCommand,
    async () => ({
      nodes: afterImport,
      inversePayload: { type: 'resnapshot' },
      event: { type: 'map.replaced', payload: { resnapshot: true } }
    })
  )
  assert.strictEqual(imported.operation.version, 8)
  const importVersions = await engine.listVersions(importRoomKey, { limit: 20 })
  const preImportVersion = importVersions.versions.find(
    row => row.type === 'PRE_IMPORT'
  )
  const postImportVersion = importVersions.versions.find(
    row => row.type === 'IMPORT'
  )
  assert.ok(preImportVersion, 'legacy room gets a pre-import version')
  assert.ok(postImportVersion, 'import gets a post-import version')
  assert.strictEqual(Number(preImportVersion.revision), 7)
  assert.strictEqual(Number(postImportVersion.revision), 8)
  const restoredPreImport = await engine.getVersionTree(
    importRoomKey,
    preImportVersion.id
  )
  const restoredPostImport = await engine.getVersionTree(
    importRoomKey,
    postImportVersion.id
  )
  assert.strictEqual(restoredPreImport.tree.root.data.text, '导入前')
  assert.strictEqual(restoredPostImport.tree.root.data.text, '导入后')
  assert.strictEqual(restoredPostImport.tree.added.data.text, '新节点')

  const storedImportOperation = await storage.getRoomOperation(
    importRoomKey,
    importOperationId
  )
  assert.strictEqual(storedImportOperation.payload.reason, 'IMPORT')
  assert.ok(!storedImportOperation.payload.tree)
  assert.ok(!storedImportOperation.payload.nodes)
  const historyCountsBeforeDuplicate = await pool.query(
    `select
       (select count(*)::int from room_checkpoints where room_key = $1) as checkpoints,
       (select count(*)::int from room_versions where room_key = $1) as versions`,
    [importRoomKey]
  )
  const replayedImport = await storage.commitRoomOperation(
    importRoomKey,
    importCommand,
    async () => {
      throw new Error('duplicate operation must not apply again')
    }
  )
  assert.strictEqual(replayedImport.duplicate, true)
  await engine.maybeCheckpointAfterOp(importRoomKey, storedImportOperation)
  const historyCountsAfterDuplicate = await pool.query(
    `select
       (select count(*)::int from room_checkpoints where room_key = $1) as checkpoints,
       (select count(*)::int from room_versions where room_key = $1) as versions`,
    [importRoomKey]
  )
  assert.deepStrictEqual(
    historyCountsAfterDuplicate.rows[0],
    historyCountsBeforeDuplicate.rows[0],
    'duplicate operation and async history event do not create duplicate history'
  )
  await pool.query(
    `update rooms set restore_epoch_revision = 8 where room_key = $1`,
    [importRoomKey]
  )
  await assert.rejects(
    storage.commitRoomOperation(
      importRoomKey,
      {
        ...importCommand,
        operationId: randomUUID(),
        baseVersion: 7,
        payload: { reason: 'VERSION_RESTORE' }
      },
      async () => ({ nodes: afterImport })
    ),
    error => error && error.code === 'STALE_AFTER_VERSION_RESTORE'
  )

  const failedImportRoomKey = 'hist-import-rollback-' + randomUUID()
  await pool.query(
    `insert into rooms(room_key, title, cos_key, nodes, metadata, version)
     values ($1,$2,$3,$4::jsonb,'{}'::jsonb,3)`,
    [failedImportRoomKey, 'map replace rollback', 'test/' + failedImportRoomKey, JSON.stringify(beforeImport)]
  )
  await storage.replaceRoomNodes(failedImportRoomKey, beforeImport, 3)
  await assert.rejects(
    storage.commitRoomOperation(
      failedImportRoomKey,
      {
        ...importCommand,
        operationId: randomUUID(),
        mapId: failedImportRoomKey,
        baseVersion: 3
      },
      async () => ({
        nodes: { broken: { isRoot: false, data: { uid: 'broken' }, children: [] } },
        inversePayload: { type: 'resnapshot' },
        event: { type: 'map.replaced', payload: { resnapshot: true } }
      })
    ),
    /历史树校验失败/
  )
  const failedImportState = await pool.query(
    `select r.version,
       (select count(*)::int from room_operations o where o.room_key = r.room_key) as operations,
       (select count(*)::int from room_checkpoints c where c.room_key = r.room_key) as checkpoints,
       (select count(*)::int from room_versions v where v.room_key = r.room_key) as versions
     from rooms r where r.room_key = $1`,
    [failedImportRoomKey]
  )
  assert.deepStrictEqual(failedImportState.rows[0], {
    version: '3',
    operations: 0,
    checkpoints: 0,
    versions: 0
  })
  const baseline = await engine.ensureHistoryBaseline(roomKey)
  assert.ok(baseline)
  const listed = await engine.listVersions(roomKey, { limit: 20 })
  assert.ok(listed.versions.some(row => String(row.type).toUpperCase() === 'LEGACY'))
  const legacy = listed.versions.find(row => String(row.type).toUpperCase() === 'LEGACY')
  assert.strictEqual(legacy.revision, null)
  const tree = await engine.getVersionTree(roomKey, legacy.id)
  assert.ok(tree.tree.root || Object.keys(tree.tree).length)
  assert.ok(tree.readOnly)

  const live = await store.getLiveState(roomKey)
  const restored = await engine.restoreVersion(roomKey, {
    versionId: legacy.id,
    expectedCurrentRevision: live.revision,
    userId: 'owner-1',
    idempotencyKey: 'pg-' + roomKey
  })
  assert.ok(restored.newRevision > live.revision)
  const again = await engine.restoreVersion(roomKey, {
    versionId: legacy.id,
    expectedCurrentRevision: 0,
    userId: 'owner-1',
    idempotencyKey: 'pg-' + roomKey
  })
  assert.strictEqual(again.newRevision, restored.newRevision)

  const epoch = await pool.query(
    `select coalesce(restore_epoch_revision,0)::bigint as epoch, version
     from rooms where room_key = $1`,
    [roomKey]
  )
  assert.strictEqual(Number(epoch.rows[0].epoch), restored.newRevision)

  const hideRes = mockRes()
  const hidden = await engine.createVersion(roomKey, {
    name: 'hide-me',
    type: 'MANUAL',
    createdBy: 'owner-1'
  })
  await engine.hideVersion(roomKey, hidden.id, 'owner-1')
  await handleHistoryApi(
    {
      method: 'GET',
      url: `/api/files/${roomKey}/versions/${hidden.id}`,
      roomAccess: { userId: 'u', canView: true, canManage: true }
    },
    hideRes,
    { engine }
  )
  assert.strictEqual(hideRes.code, 404)

  const checksum = historyChecksum(toBusinessTree(tree.tree), tree.metadata || {})
  assert.ok(checksum)

  await pool.query(`delete from rooms where room_key = $1`, [roomKey])
  await pool.query(`delete from rooms where room_key = $1`, [replayRoomKey])
  await pool.query(`delete from rooms where room_key in ($1, $2)`, [importRoomKey, failedImportRoomKey])
  console.log('collabHistory.pg.test.js ok')
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
