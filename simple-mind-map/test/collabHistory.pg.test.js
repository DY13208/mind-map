const assert = require('assert')
const { randomUUID } = require('crypto')
const h = require('./collabV2.pgHarness')
const {
  createHistoryEngine,
  createPgHistoryStore,
  handleHistoryApi
} = require('../bin/collabHistory')
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

async function main() {
  const api = await h.tryPg()
  if (api.error) {
    console.log('collabHistory.pg.test.js skipped:', api.error.message)
    process.exit(0)
    return
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
  console.log('collabHistory.pg.test.js ok')
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
