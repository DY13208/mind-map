'use strict'

/**
 * Freeze-suite regressions for Wide Sibling Position Canonicalization P0.
 * Full matrix: test/collabV2.persistence.pg.test.js (optional / long).
 */

const assert = require('assert')
const { randomUUID } = require('crypto')
const h = require('./collabV2.pgHarness')
const storage = require('../bin/storage')
const {
  generateNKeysBetween,
  isPaddedIndex,
  isValidPosition
} = require('../bin/fractionalIndex')
const { applyCollabEvent } = require('../bin/collabRecovery')

async function seed(pool, rows, label) {
  const key = 'p0-smoke-' + label + '-' + randomUUID()
  await pool.query(
    "insert into rooms(room_key,title,cos_key,nodes,version) values($1,$2,$3,'{}',0)",
    [key, label, 'test/' + key]
  )
  await pool.query(
    `insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version)
      select $1,x.uid,x.parent_uid,x.position,x.data,x.is_root,0
      from jsonb_to_recordset($2::jsonb) as x(uid text,parent_uid text,position text,data jsonb,is_root boolean)`,
    [key, JSON.stringify(rows)]
  )
  return key
}

function rootRows() {
  return [
    {
      uid: 'root',
      parent_uid: null,
      position: 'a0',
      data: { uid: 'root', text: 'Root' },
      is_root: true
    }
  ]
}

function eventPayload(result) {
  return (
    (result.operation &&
      result.operation.event &&
      result.operation.event.payload) ||
    (result.operation && result.operation.payload) ||
    {}
  )
}

async function main() {
  const api = await h.tryPg()
  if (api.error) {
    console.log('collabV2.wideSibling.persistence: SKIP (no PG)', api.error.message)
    return
  }
  const pool = api.getPool()
  const sockets = []
  let server
  const rooms = []
  let emptyRegression = 'FAIL'
  let legacyRegression = 'FAIL'
  let secondFastPath = 'FAIL'
  let reindex500Ms = null
  let reindex500Queries = null

  try {
    server = await h.startV2Server()

    // CASE 1: 5 empty-position siblings → middle insert must reindex.
    {
      const rows = rootRows()
      for (let i = 0; i < 5; i++) {
        rows.push({
          uid: 'n' + i,
          parent_uid: 'root',
          position: '',
          data: { uid: 'n' + i, text: 'Node' },
          is_root: false
        })
      }
      const key = await seed(pool, rows, 'empty-middle')
      rooms.push(key)
      const a = await h.joinClient(server.url, key, randomUUID())
      const b = await h.joinClient(server.url, key, randomUUID())
      sockets.push(a.socket, b.socket)
      const uid = randomUUID()
      const { result } = await h.submitOp(a, 'node.insert', {
        uid,
        parentUid: 'root',
        index: 2,
        text: 'EMPTY_MIDDLE'
      })
      assert.strictEqual(result.ok, true, JSON.stringify(result))
      const payload = eventPayload(result)
      assert.strictEqual(payload.reindex, true, 'empty siblings must reindex')
      assert.ok(payload.siblingPositions)
      assert.ok(
        Object.keys(payload.siblingPositions).length >= 6,
        'siblingPositions must cover reindexed set'
      )
      const after = (
        await pool.query(
          `select uid, position from room_nodes
           where room_key=$1 and parent_uid='root' and deleted_at is null
           order by position, uid`,
          [key]
        )
      ).rows
      assert.strictEqual(after[2].uid, uid)
      assert.ok(after.every(row => isValidPosition(row.position) && !isPaddedIndex(row.position)))
      const snap = await storage.getRoomSnapshot(key)
      assert.ok(snap.nodes[uid])
      assert.ok(snap.nodes.root.children.includes(uid))
      assert.strictEqual(snap.treeSource, 'room_nodes')
      const base = JSON.parse(JSON.stringify(snap.nodes))
      delete base[uid]
      base.root.children = base.root.children.filter(id => id !== uid)
      const applied = applyCollabEvent(base, {
        type: 'node.inserted',
        payload: {
          uid,
          parentUid: 'root',
          text: 'EMPTY_MIDDLE',
          position: payload.position,
          reindex: true,
          siblingPositions: payload.siblingPositions,
          index: 2
        }
      })
      assert.ok(applied[uid])
      assert.ok(applied.root.children.includes(uid))
      emptyRegression = 'PASS'
      console.log('EMPTY_POSITION_REINDEX_REGRESSION = PASS')
    }

    // CASE 2: legacy padded → first reindex, second insert fast path.
    {
      const rows = rootRows()
      for (let i = 0; i < 8; i++) {
        rows.push({
          uid: 'p' + i,
          parent_uid: 'root',
          position: String(i).padStart(8, '0'),
          data: { uid: 'p' + i, text: 'Pad' },
          is_root: false
        })
      }
      assert.ok(rows.slice(1).every(r => isPaddedIndex(r.position)))
      const key = await seed(pool, rows, 'padded-twice')
      rooms.push(key)
      const a = await h.joinClient(server.url, key, randomUUID())
      sockets.push(a.socket)

      const uid1 = randomUUID()
      const first = await h.submitOp(a, 'node.insert', {
        uid: uid1,
        parentUid: 'root',
        text: 'PADDED_FIRST'
      })
      assert.strictEqual(first.result.ok, true, JSON.stringify(first.result))
      const payload1 = eventPayload(first.result)
      assert.strictEqual(payload1.reindex, true, 'first legacy insert must reindex')
      const afterFirst = (
        await pool.query(
          `select uid, position from room_nodes
           where room_key=$1 and parent_uid='root' and deleted_at is null
           order by position, uid`,
          [key]
        )
      ).rows
      assert.ok(
        afterFirst.every(
          row => isValidPosition(row.position) && !isPaddedIndex(row.position)
        ),
        'first reindex must canonicalize all siblings'
      )
      console.log('FIRST_LEGACY_INSERT_REINDEX = PASS')
      legacyRegression = 'PASS'

      const uid2 = randomUUID()
      const second = await h.submitOp(a, 'node.insert', {
        uid: uid2,
        parentUid: 'root',
        text: 'PADDED_SECOND'
      })
      assert.strictEqual(second.result.ok, true, JSON.stringify(second.result))
      const payload2 = eventPayload(second.result)
      assert.ok(
        !payload2.reindex,
        'second insert on canonical siblings must use generateKeyBetween fast path'
      )
      assert.ok(!payload2.siblingPositions)
      const live2 = (
        await pool.query(
          `select uid from room_nodes where room_key=$1 and uid=$2 and deleted_at is null`,
          [key, uid2]
        )
      ).rows[0]
      assert.ok(live2)
      a.socket.disconnect()
      const again = await h.joinClient(server.url, key, randomUUID())
      sockets.push(again.socket)
      const snap = await storage.getRoomSnapshot(key)
      assert.ok(snap.nodes[uid1])
      assert.ok(snap.nodes[uid2])
      assert.strictEqual(snap.treeSource, 'room_nodes')
      secondFastPath = 'PASS'
      console.log('SECOND_CANONICAL_INSERT_FAST_PATH = PASS')
      console.log('LEGACY_PADDED_REINDEX_REGRESSION = PASS')
    }

    // CASE 3: 500 sibling forced reindex — duration / query sanity only.
    {
      const rows = rootRows()
      for (let i = 0; i < 500; i++) {
        rows.push({
          uid: 'w' + i,
          parent_uid: 'root',
          position: String(i).padStart(8, '0'),
          data: { uid: 'w' + i, text: 'Wide' },
          is_root: false
        })
      }
      const key = await seed(pool, rows, 'reindex-500')
      rooms.push(key)
      const a = await h.joinClient(server.url, key, randomUUID())
      sockets.push(a.socket)
      const uid = randomUUID()
      const { result, ms } = await h.submitOp(a, 'node.insert', {
        uid,
        parentUid: 'root',
        index: 250,
        text: 'REINDEX_500'
      })
      assert.strictEqual(result.ok, true, JSON.stringify(result))
      const payload = eventPayload(result)
      assert.strictEqual(payload.reindex, true)
      reindex500Ms = Math.round(ms * 100) / 100
      reindex500Queries =
        result.queryStats && result.queryStats.queries != null
          ? result.queryStats.queries
          : null
      // Batch updatePositions → queries must be O(1), not ~1 SQL per sibling.
      assert.ok(
        reindex500Queries != null && reindex500Queries < 80,
        'REINDEX_500 must not use N SQL per sibling, got queries=' +
          reindex500Queries
      )
      const after = (
        await pool.query(
          `select uid from room_nodes
           where room_key=$1 and parent_uid='root' and deleted_at is null
           order by position, uid`,
          [key]
        )
      ).rows
      assert.strictEqual(after[250].uid, uid)
      console.log('REINDEX_500_DURATION_MS =', reindex500Ms)
      console.log('REINDEX_500_QUERY_COUNT =', reindex500Queries)
    }

    console.log('collabV2.wideSibling.persistence.test.js ok')
  } finally {
    sockets.forEach(s => {
      try {
        s.disconnect()
      } catch (_) {}
    })
    if (server) {
      if (server.presence && server.presence.close) server.presence.close()
      server.server.close()
    }
    for (const key of rooms) {
      await pool.query('delete from room_operations where room_key=$1', [key]).catch(() => {})
      await pool.query('delete from room_outbox where room_key=$1', [key]).catch(() => {})
      await pool.query('delete from room_nodes where room_key=$1', [key]).catch(() => {})
      await pool.query('delete from rooms where room_key=$1', [key]).catch(() => {})
    }
    await pool.end()
  }

  assert.strictEqual(emptyRegression, 'PASS')
  assert.strictEqual(legacyRegression, 'PASS')
  assert.strictEqual(secondFastPath, 'PASS')
  assert.ok(reindex500Ms != null)
  assert.ok(reindex500Queries != null)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
