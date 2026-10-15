'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Client } = require('pg')

process.env.COLLAB_V2 = process.env.COLLAB_V2 || '1'
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
require('../bin/loadEnv')

const storage = require('../bin/storage')
const { createPgStore } = require('../bin/collabV2/directStore')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { digestMcpOperation } = require('../bin/mcpOperationIdentity')
const { generateNKeysBetween } = require('../bin/fractionalIndex')

const EXPECTED_DB = 'mcp_incremental_test'
const EXPECTED_USER = 'mcp_test'
const EXPECTED_PORT = 25492

function makeCommand(roomKey, operationId, baseVersion, ops) {
  const command = {
    roomKey,
    mapId: roomKey,
    operationId,
    actorId: 'mcp-writer-contract-test',
    clientId: 'mcp-writer-contract-test',
    baseVersion,
    type: 'node.batch',
    payload: { ops }
  }
  return {
    command,
    mcpRequest: {
      v: 1,
      principalId: 'mcp-writer-contract-test',
      digest: digestMcpOperation({
        roomKey,
        principalId: 'mcp-writer-contract-test',
        type: command.type,
        payload: command.payload
      })
    }
  }
}

async function execute(roomKey, command, mcpRequest, { failUid } = {}) {
  return storage.commitDirectRoomOperation(
    roomKey,
    command,
    async ({ client, room, currentVersion }) => {
      const store = createPgStore(client, roomKey)
      store.setMeta((room && room.metadata) || {})
      if (failUid) {
        const insert = store.insert.bind(store)
        store.insert = async row => {
          if (row.uid === failUid) throw new Error('simulated system failure')
          return insert(row)
        }
      }
      const applied = await applyDirect(
        store,
        { ...command, roomKey, targetId: '', opId: command.operationId },
        {
          version: currentVersion + 1,
          mcpPartial: true,
          operationId: command.operationId
        }
      )
      return { ...applied, queryStats: store.stats }
    },
    { mcpRequest }
  )
}

async function main() {
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(String(process.env.PGHOST || '').toLowerCase()),
    'refusing non-loopback PostgreSQL host'
  )
  assert.equal(process.env.PGPORT, String(EXPECTED_PORT), 'refusing non-isolated PostgreSQL port')
  assert.equal(process.env.PGDATABASE, EXPECTED_DB, 'refusing non-test database')
  assert.equal(process.env.PGUSER, EXPECTED_USER, 'refusing non-test database user')

  await storage.initSchema()
  const pool = storage.getPool()
  const identity = await pool.query(
    'select current_database() as database, current_user as username'
  )
  assert.deepEqual(identity.rows[0], {
    database: EXPECTED_DB,
    username: EXPECTED_USER
  })

  const runId = randomUUID()
  const roomKey = `mcp-writer-contract-${runId}`
  const ids = {
    parentA: `parent-a-${runId}`,
    parentB: `parent-b-${runId}`,
    move: `move-${runId}`,
    inserted: `inserted-${runId}`,
    child: `child-${runId}`,
    dependent: `dependent-${runId}`,
    explicitDependent: `explicit-dependent-${runId}`,
    failedParent: `failed-parent-${runId}`,
    failedInsert: `system-first-${runId}`,
    failureTrigger: `system-trigger-${runId}`,
    allFailedDelete: `all-failed-delete-${runId}`
  }
  const receiptMigration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '012_mcp_terminal_receipts.up.sql'),
    'utf8'
  )
  let roomCreated = false
  try {
    await pool.query(
      "insert into rooms(room_key,title,cos_key,nodes,version) values($1,$2,$3,'{}'::jsonb,0)",
      [roomKey, 'MCP writer contract test', `test/${roomKey}`]
    )
    roomCreated = true

    const receiptTable = await pool.query(
      "select to_regclass('public.mcp_terminal_receipts') as table_name"
    )
    if (!receiptTable.rows[0].table_name) {
      const beforeMigration = makeCommand(roomKey, randomUUID(), 0, [
        { type: 'node.delete', payload: { uid: `missing-before-migration-${runId}` } }
      ])
      await assert.rejects(
        execute(roomKey, beforeMigration.command, beforeMigration.mcpRequest),
        error => error.code === 'MCP_OPERATION_RECEIPT_SCHEMA_MISSING'
      )
      assert.equal(await storage.getRoomVersion(roomKey), 0)
      assert.equal(
        (await pool.query(
          'select 1 from room_operations where room_key=$1 and operation_id=$2',
          [roomKey, beforeMigration.command.operationId]
        )).rowCount,
        0,
        'missing migration must reject before applying batch items'
      )
    }
    // This DDL is deliberately part of this opt-in, fixed-identity isolated
    // contract harness; the application request path never applies migrations.
    await pool.query(receiptMigration)

    const positions = generateNKeysBetween(null, null, 3)
    const rows = [
      { uid: 'root', parent_uid: null, position: '', data: { uid: 'root', text: 'Root' }, is_root: true },
      { uid: ids.parentA, parent_uid: 'root', position: positions[0], data: { uid: ids.parentA, text: 'A' }, is_root: false },
      { uid: ids.parentB, parent_uid: 'root', position: positions[1], data: { uid: ids.parentB, text: 'B' }, is_root: false },
      { uid: ids.move, parent_uid: ids.parentA, position: positions[2], data: { uid: ids.move, text: 'Move me', hyperlink: 'https://old.example' }, is_root: false }
    ]
    await pool.query(
      `insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version)
       select $1,x.uid,x.parent_uid,x.position,x.data,x.is_root,0
       from jsonb_to_recordset($2::jsonb) as x(uid text,parent_uid text,position text,data jsonb,is_root boolean)`,
      [roomKey, JSON.stringify(rows)]
    )

    const batch = makeCommand(roomKey, randomUUID(), 0, [
      {
        type: 'node.insert',
        payload: { uid: ids.inserted, parentUid: ids.parentA, text: 'original', hyperlink: 'https://initial.example' }
      },
      {
        type: 'node.insert',
        payload: {
          uid: ids.failedParent,
          parentUid: `missing-parent-${runId}`,
          text: 'parent insert must fail'
        }
      },
      {
        type: 'node.insert',
        payload: { uid: ids.dependent, parentUid: ids.failedParent, text: 'implicit dependency' }
      },
      { type: 'node.move', payload: { uid: ids.move, parentUid: ids.parentB, index: 0 } },
      {
        type: 'node.update',
        depends_on: [0],
        payload: {
          uid: ids.inserted,
          patch: { text: 'updated', hyperlink: 'https://final.example', hyperlinkTitle: 'Final' }
        }
      },
      {
        type: 'node.insert',
        payload: { uid: ids.child, parentUid: ids.inserted, text: 'implicit successful dependency' }
      },
      {
        type: 'node.insert',
        depends_on: [1],
        payload: { uid: ids.explicitDependent, parentUid: ids.parentB, text: 'explicit dependency' }
      }
    ])
    const committed = await execute(roomKey, batch.command, batch.mcpRequest)
    assert.equal(committed.duplicate, false)
    assert.deepEqual(
      committed.result.items.map(item => item.status),
      [
        'applied',
        'failed',
        'dependency_failed',
        'applied',
        'applied',
        'applied',
        'dependency_failed'
      ]
    )
    assert.equal(committed.result.failed, 3)
    assert.equal(committed.result.items[2].code, 'MCP_BATCH_DEPENDENCY_FAILED')
    assert.equal(committed.result.items[2].depends_on[0], 1)
    assert.equal(committed.result.items[6].code, 'MCP_BATCH_DEPENDENCY_FAILED')
    assert.equal(await storage.getRoomVersion(roomKey), 1, 'a partial batch must add exactly one revision')

    const written = await pool.query(
      'select uid,parent_uid,data from room_nodes where room_key=$1 and uid=any($2::text[]) and deleted_at is null',
      [roomKey, [ids.inserted, ids.child, ids.move, ids.dependent, ids.explicitDependent]]
    )
    const inserted = written.rows.find(row => row.uid === ids.inserted)
    const child = written.rows.find(row => row.uid === ids.child)
    const moved = written.rows.find(row => row.uid === ids.move)
    assert.equal(inserted.parent_uid, ids.parentA)
    assert.equal(inserted.data.text, 'updated')
    assert.equal(inserted.data.hyperlink, 'https://final.example')
    assert.equal(inserted.data.hyperlinkTitle, 'Final')
    assert.equal(child.parent_uid, ids.inserted)
    assert.equal(moved.parent_uid, ids.parentB)
    assert.equal(written.rows.some(row => row.uid === ids.dependent), false)

    const rawOperation = await pool.query(
      'select payload,event from room_operations where room_key=$1 and operation_id=$2',
      [roomKey, batch.command.operationId]
    )
    assert.equal(rawOperation.rows.length, 1)
    assert.deepEqual(
      rawOperation.rows[0].payload.__mcpResult,
      JSON.parse(JSON.stringify(committed.result)),
      'stored JSONB replay metadata must preserve the wire-visible result'
    )
    assert.equal(JSON.stringify(rawOperation.rows[0].event).includes('__mcpResult'), false)
    const publicOperation = await storage.getRoomOperation(roomKey, batch.command.operationId)
    assert.equal(JSON.stringify(publicOperation).includes('__mcpResult'), false)

    const replay = await execute(roomKey, batch.command, batch.mcpRequest)
    assert.equal(replay.duplicate, true)
    assert.deepEqual(
      JSON.parse(JSON.stringify(replay.result)),
      JSON.parse(JSON.stringify(committed.result)),
      'same operation ID must replay the original wire-visible item results'
    )
    assert.equal(await storage.getRoomVersion(roomKey), 1)

    // Move the committed partial operation into the archive using the real
    // archive table shape. Keep this independent PG connection checked out
    // while the storage pool replays the MCP request, proving the duplicate
    // lookup crosses connection boundaries rather than relying on session state.
    const archiveClient = new Client({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      application_name: `mcp-writer-archive-test-${runId}`
    })
    await archiveClient.connect()
    try {
      const archivePid = Number(
        (await archiveClient.query('select pg_backend_pid() as pid')).rows[0].pid
      )
      const beforeArchive = await archiveClient.query(
        `select version, operation_type, payload
         from room_operations where room_key=$1 and operation_id=$2`,
        [roomKey, batch.command.operationId]
      )
      assert.equal(beforeArchive.rowCount, 1, 'partial operation must start in active storage')
      assert.equal(Number(beforeArchive.rows[0].version), 1)
      assert.equal(beforeArchive.rows[0].operation_type, 'node.batch')

      await archiveClient.query('begin')
      try {
        const archived = await archiveClient.query(
          `insert into room_operations_archive
           (room_key, version, operation_id, actor_id, client_id,
            operation_type, payload, event, inverse_payload, created_at, archived_at)
           select room_key, version, operation_id, actor_id, client_id,
                  operation_type, payload, event, inverse_payload, created_at, now()
           from room_operations
           where room_key=$1 and operation_id=$2
           returning version`,
          [roomKey, batch.command.operationId]
        )
        assert.equal(archived.rowCount, 1, 'one committed partial batch must be copied to archive')
        const removed = await archiveClient.query(
          'delete from room_operations where room_key=$1 and operation_id=$2 returning version',
          [roomKey, batch.command.operationId]
        )
        assert.equal(removed.rowCount, 1, 'archived operation must leave active storage')
        await archiveClient.query('commit')
      } catch (error) {
        await archiveClient.query('rollback').catch(() => {})
        throw error
      }

      const archivedRow = await archiveClient.query(
        `select version, operation_id, operation_type, payload
         from room_operations_archive where room_key=$1 and operation_id=$2`,
        [roomKey, batch.command.operationId]
      )
      assert.equal(archivedRow.rowCount, 1)
      assert.equal(Number(archivedRow.rows[0].version), 1)
      assert.equal(archivedRow.rows[0].operation_type, 'node.batch')
      assert.deepEqual(
        archivedRow.rows[0].payload.__mcpResult,
        JSON.parse(JSON.stringify(committed.result)),
        'archive row must retain the original wire-visible partial result'
      )
      assert.equal(
        (await archiveClient.query(
          'select 1 from room_operations where room_key=$1 and operation_id=$2',
          [roomKey, batch.command.operationId]
        )).rowCount,
        0,
        'partial operation must be absent from active storage after archival'
      )

      // Make a formerly missing parent available. Re-executing the original
      // failed insert would now succeed, so the replay must come from archive.
      const appearedParentUid = `missing-parent-${runId}`
      const parentPosition = generateNKeysBetween(null, null, 1)[0]
      await archiveClient.query(
        `insert into room_nodes
         (room_key,uid,parent_uid,position,data,is_root,node_version)
         values($1,$2,'root',$3,$4::jsonb,false,0)`,
        [
          roomKey,
          appearedParentUid,
          parentPosition,
          JSON.stringify({ uid: appearedParentUid, text: 'parent created after archival' })
        ]
      )

      const afterArchiveChange = makeCommand(roomKey, randomUUID(), 1, [
        { type: 'node.update', payload: { uid: ids.parentB, patch: { text: 'advanced after archive' } } }
      ])
      const advanced = await execute(
        roomKey,
        afterArchiveChange.command,
        afterArchiveChange.mcpRequest
      )
      assert.equal(advanced.duplicate, false)
      assert.equal(Number(advanced.operation.version), 2)
      assert.equal(await storage.getRoomVersion(roomKey), 2)

      const outboxBeforeReplay = await archiveClient.query(
        `select count(*)::int as count, coalesce(max(version),0)::int as max_version
         from room_outbox where room_key=$1`,
        [roomKey]
      )
      const storagePool = storage.getPool()
      const originalConnect = storagePool.connect
      let replayPid = null
      storagePool.connect = async function (...args) {
        const client = await originalConnect.apply(this, args)
        const pid = await client.query('select pg_backend_pid() as pid')
        replayPid = Number(pid.rows[0].pid)
        return client
      }
      let archivedReplay
      try {
        archivedReplay = await execute(roomKey, batch.command, batch.mcpRequest)
      } finally {
        storagePool.connect = originalConnect
      }
      assert.ok(Number.isInteger(replayPid), 'storage replay must acquire a PostgreSQL connection')
      assert.notEqual(replayPid, archivePid, 'archive write and MCP replay must use distinct PostgreSQL sessions')
      assert.equal(archivedReplay.duplicate, true)
      assert.equal(Number(archivedReplay.operation.version), 1, 'archive replay must retain the operation first version')
      assert.equal(archivedReplay.currentRevision, 2, 'archive replay must report the unchanged current room revision')
      assert.deepEqual(
        JSON.parse(JSON.stringify(archivedReplay.result)),
        JSON.parse(JSON.stringify(committed.result)),
        'archive replay must return the original per-item results and UIDs'
      )
      assert.equal(archivedReplay.result.items[0].result.uid, ids.inserted)
      assert.equal(
        (await archiveClient.query(
          'select 1 from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
          [roomKey, ids.failedParent]
        )).rowCount,
        0,
        'the formerly failed insert must not execute after its parent appears'
      )
      assert.equal(await storage.getRoomVersion(roomKey), 2, 'archive replay must not add a revision')
      const outboxAfterReplay = await archiveClient.query(
        `select count(*)::int as count, coalesce(max(version),0)::int as max_version
         from room_outbox where room_key=$1`,
        [roomKey]
      )
      assert.deepEqual(
        outboxAfterReplay.rows[0],
        outboxBeforeReplay.rows[0],
        'archive replay must not append a collaboration outbox event'
      )
      assert.equal(
        (await archiveClient.query(
          'select 1 from room_operations where room_key=$1 and operation_id=$2',
          [roomKey, batch.command.operationId]
        )).rowCount,
        0,
        'archive replay must not recreate the active operation row'
      )
    } finally {
      await archiveClient.end()
    }

    const allFailed = makeCommand(roomKey, randomUUID(), 1, [
      { type: 'node.delete', payload: { uid: ids.allFailedDelete } },
      {
        type: 'node.update',
        payload: {
          uid: `gone-b-${runId}`,
          patch: { text: 'SENTINEL_PRIVATE_BATCH_BODY' }
        }
      }
    ])
    const rejected = await execute(roomKey, allFailed.command, allFailed.mcpRequest)
    assert.equal(rejected.noop, true)
    assert.equal(rejected.operationId, allFailed.command.operationId)
    assert.equal(rejected.result.failed, 2)
    assert.equal(await storage.getRoomVersion(roomKey), 2, 'all-failed batch must not create a revision')
    assert.equal(
      (await pool.query('select 1 from room_operations where room_key=$1 and operation_id=$2', [roomKey, allFailed.command.operationId])).rowCount,
      0
    )
    assert.equal(
      (await pool.query(
        "select 1 from room_outbox where room_key=$1 and event->>'operationId'=$2",
        [roomKey, allFailed.command.operationId]
      )).rowCount,
      0,
      'all-failed batch must not enqueue a collaboration event'
    )
    const receiptRow = await pool.query(
      `select principal_id, request_digest, result, current_revision
       from mcp_terminal_receipts where room_key=$1 and operation_id=$2`,
      [roomKey, allFailed.command.operationId]
    )
    assert.equal(receiptRow.rowCount, 1)
    assert.equal(receiptRow.rows[0].principal_id, allFailed.mcpRequest.principalId)
    assert.equal(receiptRow.rows[0].request_digest, allFailed.mcpRequest.digest)
    assert.equal(Number(receiptRow.rows[0].current_revision), 2)
    assert.deepEqual(
      receiptRow.rows[0].result,
      JSON.parse(JSON.stringify(rejected.result)),
      'terminal receipt stores the first full per-item result'
    )
    assert.equal(
      JSON.stringify(receiptRow.rows[0].result).includes('SENTINEL_PRIVATE_BATCH_BODY'),
      false,
      'terminal receipt must not persist the original request body'
    )
    const receiptColumns = await pool.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='mcp_terminal_receipts'
       order by ordinal_position`
    )
    assert.deepEqual(
      receiptColumns.rows.map(row => row.column_name),
      [
        'room_key',
        'operation_id',
        'principal_id',
        'request_digest',
        'result',
        'current_revision',
        'created_at'
      ],
      'terminal receipt table must not include a stored request payload'
    )

    await assert.rejects(
      execute(roomKey, allFailed.command, {
        ...allFailed.mcpRequest,
        principalId: 'different-principal',
        digest: digestMcpOperation({
          roomKey,
          principalId: 'different-principal',
          type: allFailed.command.type,
          payload: allFailed.command.payload
        })
      }),
      error => error.code === 'OPERATION_ID_CONFLICT'
    )
    const changedPayload = makeCommand(
      roomKey,
      allFailed.command.operationId,
      1,
      [{ type: 'node.delete', payload: { uid: `different-${runId}` } }]
    )
    await assert.rejects(
      execute(roomKey, changedPayload.command, changedPayload.mcpRequest),
      error => error.code === 'OPERATION_ID_CONFLICT'
    )
    const reusedAsUpdate = {
      ...allFailed.command,
      type: 'node.update',
      payload: { uid: ids.parentA, patch: { text: 'must not be applied' } }
    }
    const reusedAsUpdateRequest = {
      v: 1,
      principalId: allFailed.mcpRequest.principalId,
      digest: digestMcpOperation({
        roomKey,
        principalId: allFailed.mcpRequest.principalId,
        type: reusedAsUpdate.type,
        payload: reusedAsUpdate.payload
      })
    }
    await assert.rejects(
      execute(roomKey, reusedAsUpdate, reusedAsUpdateRequest),
      error => error.code === 'OPERATION_ID_CONFLICT',
      'a terminal batch ID cannot be reused for a different MCP operation type'
    )
    const protectedNode = await pool.query(
      'select data from room_nodes where room_key=$1 and uid=$2',
      [roomKey, ids.parentA]
    )
    assert.equal(protectedNode.rows[0].data.text, 'A')

    // Change the node state after the first all-failed result. Replaying the
    // same operation ID must return the original response without deleting it.
    await pool.query(
      `insert into room_nodes
       (room_key,uid,parent_uid,position,data,is_root,node_version)
       values($1,$2,$3,$4,$5::jsonb,false,0)`,
      [
        roomKey,
        ids.allFailedDelete,
        ids.parentA,
        generateNKeysBetween(null, null, 1)[0],
        JSON.stringify({ uid: ids.allFailedDelete, text: 'appeared after terminal response' })
      ]
    )
    const allFailedReplay = await execute(roomKey, allFailed.command, allFailed.mcpRequest)
    assert.equal(allFailedReplay.noop, true)
    assert.equal(allFailedReplay.duplicate, true)
    assert.equal(allFailedReplay.currentRevision, 2)
    assert.deepEqual(
      JSON.parse(JSON.stringify(allFailedReplay.result)),
      JSON.parse(JSON.stringify(rejected.result)),
      'same operation ID must replay original result despite changed node state'
    )
    assert.equal(await storage.getRoomVersion(roomKey), 2)
    assert.equal(
      (await pool.query(
        'select 1 from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
        [roomKey, ids.allFailedDelete]
      )).rowCount,
      1,
      'replay must not execute the formerly failed delete'
    )

    const newIdRetry = makeCommand(roomKey, randomUUID(), 1, allFailed.command.payload.ops)
    const retriedWithNewId = await execute(
      roomKey,
      newIdRetry.command,
      newIdRetry.mcpRequest
    )
    assert.equal(retriedWithNewId.noop, undefined)
    assert.equal(retriedWithNewId.result.count, 1)
    assert.deepEqual(
      retriedWithNewId.result.items.map(item => item.status),
      ['applied', 'failed'],
      'new operation ID may process the now-applicable item'
    )
    assert.equal(await storage.getRoomVersion(roomKey), 3)

    const systemFailure = makeCommand(roomKey, randomUUID(), 3, [
      {
        type: 'node.insert',
        payload: { uid: ids.failedInsert, parentUid: ids.parentA, text: 'must roll back' }
      },
      {
        type: 'node.insert',
        payload: { uid: ids.failureTrigger, parentUid: ids.parentA, text: 'system error' }
      }
    ])
    await assert.rejects(
      execute(roomKey, systemFailure.command, systemFailure.mcpRequest, { failUid: ids.failureTrigger }),
      /simulated system failure/
    )
    assert.equal(await storage.getRoomVersion(roomKey), 3, 'system error must abort the whole transaction')
    assert.equal(
      (await pool.query('select 1 from room_nodes where room_key=$1 and uid=any($2::text[]) and deleted_at is null', [roomKey, [ids.failedInsert, ids.failureTrigger]])).rowCount,
      0,
      'items preceding a system error must roll back with the transaction'
    )
    assert.equal(
      (await pool.query('select 1 from room_operations where room_key=$1 and operation_id=$2', [roomKey, systemFailure.command.operationId])).rowCount,
      0
    )
    assert.equal(
      (await pool.query('select 1 from mcp_terminal_receipts where room_key=$1 and operation_id=$2', [roomKey, systemFailure.command.operationId])).rowCount,
      0,
      'system transaction failure must not leave a terminal receipt'
    )

    await pool.query('delete from room_outbox where room_key=$1', [roomKey])
    await pool.query('delete from room_operations where room_key=$1', [roomKey])
    await pool.query('delete from room_operations_archive where room_key=$1', [roomKey])
    await pool.query('delete from room_nodes where room_key=$1', [roomKey])
    await pool.query('delete from rooms where room_key=$1', [roomKey])
    roomCreated = false
    assert.equal(
      (await pool.query('select 1 from mcp_terminal_receipts where room_key=$1', [roomKey])).rowCount,
      0,
      'physical room deletion must cascade terminal receipts'
    )

    console.log('PASS MCP Direct PG partial, committed replay, terminal all-failed receipt, privacy, cascade and system rollback')
  } finally {
    if (roomCreated) {
      await pool.query('delete from room_outbox where room_key=$1', [roomKey]).catch(() => {})
      await pool.query('delete from room_operations where room_key=$1', [roomKey]).catch(() => {})
      await pool.query('delete from room_operations_archive where room_key=$1', [roomKey]).catch(() => {})
      await pool.query('delete from mcp_terminal_receipts where room_key=$1', [roomKey]).catch(() => {})
      await pool.query('delete from room_nodes where room_key=$1', [roomKey]).catch(() => {})
      await pool.query('delete from rooms where room_key=$1', [roomKey]).catch(() => {})
    }
    await pool.end()
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
