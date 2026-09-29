const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')
assertHistoryPgTestEnvironment()
const assert = require('assert').strict
const { randomUUID } = require('crypto')
const h = require('./collabV2.pgHarness')
const { createPgHistoryStore, createHistoryEngine } = require('../bin/collabHistory')
const { migrateHistorySchema } = require('../bin/collabHistory/migrate')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function main() {
  const api = await h.tryPg()
  if (api.error) throw api.error
  const pool = api.getPool()
  const roomKey = 'hist-concurrency-' + randomUUID()
  try {
    await migrateHistorySchema(pool)
    await pool.query(`insert into rooms(room_key,title,cos_key,nodes,metadata,version)
      values ($1,'history concurrency',$2,'{}'::jsonb,'{}'::jsonb,0)`, [roomKey, 'test/' + roomKey])
    const store = createPgHistoryStore(pool)
    const config = { autoVersionOnCheckpoint: false, autoVersionIdleMs: 1 }
    const engine = createHistoryEngine({ store, config })
    const peer = createHistoryEngine({ store: createPgHistoryStore(pool), config })
    await store.setLiveState(roomKey, {
      revision: 0,
      nodes: { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } },
      metadata: {}
    })
    await engine.ensureHistoryBaseline(roomKey)
    async function edit(actor, text) {
      return store.withRoomLock(roomKey, async tx => {
        const state = await tx.getLiveState(roomKey)
        const oldText = state.nodes.root.data.text
        state.revision += 1
        state.nodes.root.data.text = text
        await tx.setLiveState(roomKey, state)
        const op = {
          room_key: roomKey, version: state.revision, operation_id: randomUUID(),
          actor_id: actor, client_id: 'client-' + actor, operation_type: 'node.update',
          payload: { uid: 'root', fields: { text } },
          event: { type: 'node.updated', payload: { uid: 'root', fields: { text } } },
          inverse_payload: { type: 'node.update', payload: { uid: 'root', fields: { text: oldText } } }
        }
        await tx.appendOperation(op)
        return op
      })
    }
    const firstOp = await edit('alice', 'First edit')
    await engine.scheduleAutoJob(roomKey, firstOp, Date.now() - 1000)
    await Promise.all([
      engine.flushPendingAutoVersion(roomKey, { userId: 'viewer-a', source: 'history_open' }),
      peer.flushPendingAutoVersion(roomKey, { userId: 'viewer-b', source: 'pre_insert' }),
      peer.processDueAutoJobs(Date.now() + 1000)
    ])
    let versions = await pool.query("select * from room_versions where room_key=$1 and type='AUTO' and revision>0 order by revision", [roomKey])
    assert.equal(versions.rows.length, 1, 'multiple engines must capture a revision only once')
    assert.deepEqual(versions.rows[0].editors, ['alice'])
    assert.equal(versions.rows[0].summary.fromRevision, 0)
    assert.equal(versions.rows[0].summary.toRevision, 1)
    assert.equal(Number((await pool.query("select count(*) from room_history_audit where room_key=$1 and action='VERSION_CREATE' and target_revision=1", [roomKey])).rows[0].count), 1)
    assert.equal(Number((await pool.query('select count(*) from room_history_auto_jobs where room_key=$1', [roomKey])).rows[0].count), 0)
    await edit('bob', 'Second edit')

    const entered = deferred()
    const release = deferred()
    const pausingStore = {
      ...store,
      withRoomLock(key, fn) {
        return store.withRoomLock(key, tx => fn({
          ...tx,
          async listOperations(...args) {
            entered.resolve()
            await release.promise
            return tx.listOperations(...args)
          }
        }))
      }
    }
    const pausingEngine = createHistoryEngine({ store: pausingStore, config })
    const flushing = pausingEngine.flushPendingAutoVersion(roomKey, { userId: 'viewer-c' })
    await entered.promise
    const continuingEdit = edit('carol', 'Third edit')
    release.resolve()
    await Promise.all([flushing, continuingEdit])
    await peer.flushPendingAutoVersion(roomKey, { userId: 'viewer-d' })
    versions = await pool.query("select * from room_versions where room_key=$1 and type='AUTO' and revision>0 order by revision", [roomKey])
    assert.deepEqual(versions.rows.map(row => Number(row.revision)), [1, 2, 3])
    assert.deepEqual(versions.rows.map(row => row.editors), [['alice'], ['bob'], ['carol']])
    assert.deepEqual(versions.rows.map(row => [row.summary.fromRevision, row.summary.toRevision]), [[0, 1], [1, 2], [2, 3]])
    const manual = await engine.createVersion(roomKey, { type: 'MANUAL', createdBy: 'marker', name: 'manual' })
    assert.equal(manual.created_by, 'marker')
    assert.deepEqual(manual.editors, [], 'an empty operation interval has no editors')
    console.log('PASS: PostgreSQL multi-engine flush/job concurrency preserves unique versions, actors and captured revision boundaries')
  } finally {
    await pool.query('delete from rooms where room_key=$1', [roomKey]).catch(() => {})
    await pool.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
