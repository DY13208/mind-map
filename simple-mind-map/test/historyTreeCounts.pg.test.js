const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')
assertHistoryPgTestEnvironment()
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const storage = require('../bin/storage')
const { createHistoryEngine, createPgHistoryStore, handleHistoryApi } = require('../bin/collabHistory')
const { migrateHistorySchema } = require('../bin/collabHistory/migrate')
const { historyChecksum } = require('../bin/collabHistory/canonical')
const { createPgStore } = require('../bin/collabV2/directStore')
const { applyDirect } = require('../bin/collabV2/directApplier')

async function readHttp(engine, roomKey, versionId) {
  let status, body
  const handled = await handleHistoryApi({
    method: 'GET', url: `/api/files/${roomKey}/versions/${versionId}/tree`,
    roomAccess: { userId: 'counts-pg-test', canView: true, canManage: true }
  }, {
    writeHead(code) { status = code },
    end(value) { body = JSON.parse(String(value)) }
  }, { engine })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.equal(body.checksum, historyChecksum(body.tree, body.metadata))
  return body
}

async function main() {
  await storage.initSchema()
  const pool = storage.getPool()
  await migrateHistorySchema(pool)
  const rooms = []
  const results = []
  try {
    for (const hasMore of [false, true]) {
      const roomKey = 'history-counts-pg-' + randomUUID()
      rooms.push(roomKey)
      await pool.query(`insert into rooms(room_key,title,cos_key,nodes,version)
        values ($1,'历史计数独立测试',$2,'{}'::jsonb,1)`, [roomKey, 'test/' + roomKey])
      const store = createPgHistoryStore(pool)
      const graph = {
        root: { isRoot: true, data: { uid: 'root', text: 'Root', childCount: 1, descendantCount: 2 }, children: ['parent'] },
        parent: { data: { uid: 'parent', text: '须确认', childCount: 1, descendantCount: 1, hasMore, expand: false, note: '保留备注', __fv: { text: 1 } }, children: ['leaf'] },
        leaf: { data: { uid: 'leaf', text: '真实子节点', attachmentId: 'fixture-only' }, children: [] }
      }
      await store.withRoomLock(roomKey, tx => tx.setLiveState(roomKey, { revision: 1, nodes: graph, metadata: { layout: 'logicalStructure' } }))
      const engine = createHistoryEngine({ store, config: { checkpointEvery: 10000, autoVersionOnCheckpoint: false } })
      await engine.createCheckpoint(roomKey, { revision: 1, reason: 'TEST_BASELINE' })
      const beforeVersion = await engine.createVersion(roomKey, { revision: 1, type: 'MANUAL', name: '删除前', skipEnsure: true })
      const storedBefore = await store.latestCheckpointAt(roomKey, 1)
      const rawBefore = JSON.stringify(storedBefore)
      const before = await readHttp(engine, roomKey, beforeVersion.id)
      assert.deepEqual(before.tree.parent.children, ['leaf'])
      assert.equal(before.tree.parent.data.childCount, 1)
      assert.equal(before.tree.parent.data.descendantCount, 1)
      assert.equal(before.tree.parent.data.hasMore, undefined)

      // Commit a real durable PG delete, without a synthetic parent-count update.
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select room_key from rooms where room_key=$1 for update', [roomKey])
        const applied = await applyDirect(createPgStore(client, roomKey), { type: 'node.delete', payload: { uid: 'leaf' } }, { version: 2, skipWritePreconditions: true })
        await client.query(`insert into room_operations(room_key,version,operation_id,actor_id,client_id,operation_type,payload,event,inverse_payload)
          values ($1,2,$2,'counts-pg-test','counts-pg-test','node.delete',$3::jsonb,$4::jsonb,$5::jsonb)`,
        [roomKey, randomUUID(), JSON.stringify({ uid: 'leaf' }), JSON.stringify(applied.event), JSON.stringify(applied.inversePayload)])
        await client.query('update rooms set version=2 where room_key=$1', [roomKey])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally { client.release() }

      const replayVersion = await engine.createVersion(roomKey, { revision: 2, type: 'MANUAL', name: '删除后回放', skipEnsure: true })
      const replay = await readHttp(engine, roomKey, replayVersion.id)
      assert.deepEqual(replay.tree.parent.children, [])
      assert.equal(replay.tree.parent.data.childCount, 0)
      assert.equal(replay.tree.parent.data.descendantCount, 0)
      assert.equal(replay.tree.parent.data.hasMore, undefined)
      assert.equal(replay.tree.root.data.descendantCount, 1)
      assert.equal(replay.tree.parent.data.note, '保留备注')
      assert.deepEqual(replay.tree.parent.data.__fv, { text: 1 })
      assert.equal(replay.tree.parent.data.expand, false)
      assert.equal(JSON.stringify(await store.latestCheckpointAt(roomKey, 1)), rawBefore, 'old checkpoint must remain unchanged')

      // A raw new checkpoint containing stale stored counts must also read correctly.
      await engine.createCheckpoint(roomKey, { revision: 2, reason: 'TEST_STALE_CHECKPOINT' })
      const rawAfter = JSON.stringify(await store.latestCheckpointAt(roomKey, 2))
      const freshEngine = createHistoryEngine({ store })
      const checkpointRead = await readHttp(freshEngine, roomKey, replayVersion.id)
      assert.equal(checkpointRead.tree.parent.data.childCount, 0)
      const restored = await freshEngine.restoreVersion(roomKey, { versionId: replayVersion.id, expectedCurrentRevision: 2, idempotencyKey: 'counts-restore', userId: 'counts-pg-test' })
      assert.equal(restored.tree.parent.data.childCount, 0)
      assert.equal(restored.tree.parent.data.descendantCount, 0)
      assert.equal(restored.tree.parent.data.hasMore, undefined)
      assert.equal(JSON.stringify(await store.latestCheckpointAt(roomKey, 2)), rawAfter, 'restore must not rewrite source checkpoint')
      const live = await store.getLiveState(roomKey)
      assert.equal(live.nodes.parent.data.childCount, 0)
      assert.deepEqual(live.nodes.parent.children, [])
      const repeated = await freshEngine.restoreVersion(roomKey, { versionId: replayVersion.id, expectedCurrentRevision: 2, idempotencyKey: 'counts-restore', userId: 'counts-pg-test' })
      assert.equal(repeated.newRevision, restored.newRevision)
      await assert.rejects(() => freshEngine.restoreVersion(roomKey, { versionId: beforeVersion.id, expectedCurrentRevision: 2, userId: 'counts-pg-test' }), error => error.code === 'RESTORE_CONFLICT')
      const readRestored = await readHttp(freshEngine, roomKey, restored.restoreVersionId)
      assert.equal(readRestored.tree.parent.data.childCount, 0)
      results.push({ hasMore, completeRead: true, deleteReplay: true, rawCheckpointPreserved: true, staleCheckpointRead: true, restoredLiveCounts: true, idempotencyAndConflict: true })
    }
    console.log(JSON.stringify({ database: process.env.PGDATABASE, results }, null, 2))
    console.log('PASS: isolated PG historical counts, raw checksums, replay, HTTP and restore')
  } finally {
    for (const roomKey of rooms) await pool.query('delete from rooms where room_key=$1', [roomKey])
    await pool.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
