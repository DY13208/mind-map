const assert = require('assert')
const crypto = require('crypto')

// Pin this standalone integration test to the isolated local database before
// storage.js can load the repository's .env file.
Object.assign(process.env, {
  MIND_MAP_SKIP_ROOT_ENV: '1',
  PGHOST: '127.0.0.1',
  PGPORT: '25492',
  PGDATABASE: 'mcp_incremental_test',
  PGUSER: 'mcp_test',
  PGPASSWORD: 'mcp-incremental-test-db-password'
})
assert.strictEqual(process.env.MIND_MAP_SKIP_ROOT_ENV, '1')
assert.strictEqual(process.env.PGHOST, '127.0.0.1')
assert.strictEqual(process.env.PGPORT, '25492')
assert.strictEqual(process.env.PGDATABASE, 'mcp_incremental_test')
assert.strictEqual(process.env.PGUSER, 'mcp_test')

const storage = require('../bin/storage')
const { readRoomSubtree } = require('../bin/roomNodes')
const { resetRoomSubtreeCountsCache } = require('../bin/subtreeCountCache')

async function assertIsolatedDatabase(pool) {
  const result = await pool.query(
    `select current_database() as database,
            current_user as username`
  )
  const identity = result.rows[0] || {}
  assert.strictEqual(identity.database, 'mcp_incremental_test')
  assert.strictEqual(identity.username, 'mcp_test')
}

async function main() {
  const pool = storage.getPool()
  await assertIsolatedDatabase(pool)
  await storage.initSchema()
  const roomKey = `subtree-snapshot-${crypto.randomUUID()}`
  let roomCreated = false
  let mutateAfterVersion = true
  const sqlLog = []

  const snapshotPool = {
    query(text, params) { return pool.query(text, params) },
    async connect() {
      const client = await pool.connect()
      return {
        async query(text, params) {
          const sql = String(text).replace(/\s+/g, ' ').trim()
          sqlLog.push(sql)
          const result = await client.query(text, params)
          if (mutateAfterVersion && /^select version, updated_at from rooms\b/i.test(sql)) {
            mutateAfterVersion = false
            const writer = await pool.connect()
            try {
              await writer.query('BEGIN')
              await writer.query(
                `update room_nodes set deleted_at = now()
                 where room_key = $1 and uid = 'leaf'`,
                [roomKey]
              )
              await writer.query(
                `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
                 values ($1, 'b', 'root', 'a1', '{"uid":"b","text":"b"}'::jsonb, false, 2),
                        ($1, 'b-leaf', 'b', 'a0', '{"uid":"b-leaf","text":"b-leaf"}'::jsonb, false, 2)`,
                [roomKey]
              )
              await writer.query(
                'update rooms set version = 2, updated_at = now() where room_key = $1',
                [roomKey]
              )
              await writer.query('COMMIT')
            } catch (error) {
              await writer.query('ROLLBACK').catch(() => {})
              throw error
            } finally {
              writer.release()
            }
          }
          return result
        },
        release() { client.release() }
      }
    }
  }

  try {
    resetRoomSubtreeCountsCache()
    await pool.query(
      `insert into rooms(room_key, title, cos_key, nodes, version)
       values ($1, 'subtree snapshot test', $2, '{}'::jsonb, 1)`,
      [roomKey, `test/${roomKey}.json`]
    )
    roomCreated = true
    await pool.query(
      `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
       values ($1, 'root', null, 'a0', '{"uid":"root","text":"root"}'::jsonb, true, 1),
              ($1, 'a', 'root', 'a0', '{"uid":"a","text":"a"}'::jsonb, false, 1),
              ($1, 'leaf', 'a', 'a0', '{"uid":"leaf","text":"leaf"}'::jsonb, false, 1)`,
      [roomKey]
    )

    const oldSnapshot = await readRoomSubtree(snapshotPool, roomKey, 'root', { limit: 1 })
    assert.strictEqual(oldSnapshot.version, 1)
    assert.strictEqual(oldSnapshot.total, 1)
    assert.strictEqual(oldSnapshot.descendantCount, 2)
    assert.strictEqual(oldSnapshot.has_more, false)
    assert.strictEqual(oldSnapshot.children[0].data.childCount, 1)
    assert.ok(sqlLog.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
    assert.ok(sqlLog.includes('COMMIT'))

    const newSnapshot = await readRoomSubtree(snapshotPool, roomKey, 'root', { limit: 1 })
    assert.strictEqual(newSnapshot.version, 2)
    assert.strictEqual(newSnapshot.total, 2)
    assert.strictEqual(newSnapshot.children.length, 1)
    assert.strictEqual(newSnapshot.has_more, true)
    assert.strictEqual(newSnapshot.descendantCount, 3)
    assert.strictEqual(newSnapshot.children.find(item => item.data.uid === 'a').data.childCount, 0)
    assert.ok(!sqlLog.some(sql => /select count\(\*\)/i.test(sql)))
    console.log('room subtree PostgreSQL snapshot tests passed')
  } finally {
    if (roomCreated) {
      await pool.query('delete from rooms where room_key = $1', [roomKey]).catch(() => {})
    }
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
