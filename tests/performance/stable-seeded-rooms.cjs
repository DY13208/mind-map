// Stable-only owned-fixture data preparation.
//
// The existing stable entry historically bootstrapped its rooms through the
// product HTTP create route (POST /api/files). For a brand-new room that route
// hydrates via ensureDoc -> preloadRoom -> loadPersistedPayload, whose final
// fallback is the Tencent COS read (getYjsBuffer -> putYjsBuffer). With no COS
// credentials in the isolated environment the observed result was a 500
// `missing param Bucket`. That COS read is fixture setup, not part of the
// renderer measurement.
//
// This helper therefore prepares the exact authoritative trees through the
// owned fixture child's existing native controls:
//   - `seed` creates the owned room + owner membership and a tiny PG tree;
//   - `persistTree` overwrites it with the exact fixture tree using the real
//     storage.upsertRoom(..., { allowFullTree: true }) PG path.
// No product source, no test-only production entry, and no product COS is
// touched. The subsequent browser measurement still uses the real HTTP full
// fetch, real native WebSocket and the original 2 warmup + 5 formal samples.
const assert = require('node:assert/strict')
const { bushTree } = require('../../simple-mind-map/test/fixtures/largeMapFixtures')
const isolation = require('./isolation.cjs')

const OWNER_ID = 'performance-owner'

async function prepareStableRooms(app, sizes, onSeededRoom = () => {}) {
  assert.ok(app && typeof app.control === 'function', 'owned fixture application is required')
  assert.ok(Array.isArray(sizes) && sizes.length > 0, 'stable fixture sizes are required')
  assert.equal(typeof onSeededRoom, 'function', 'onSeededRoom collector must be callable')
  const rooms = {}
  const prepared = []
  for (const size of sizes) {
    assert.ok(Number.isInteger(size) && size >= 1 && size <= 10000, 'stable fixture size must be a bounded integer')
    const seed = await app.control('seed', { branches: 1, leaves: 1 })
    assert.match(String(seed.roomKey), /^performance-online-[0-9a-f-]{36}$/, 'native seed must return an owned room key')
    // The child tracks this room for cleanup the moment `seed` returns, so the
    // harness records it before any later step can fail. A partial seeding
    // failure must still leave a verifiable cleanup obligation.
    onSeededRoom({ size, roomKey: String(seed.roomKey) })
    const { tree, nodeCount } = bushTree(size, 'c2s' + size + '-')
    assert.equal(nodeCount, size, 'stable fixture tree must contain the exact requested node count')
    const persisted = await app.control('persistTree', { roomKey: seed.roomKey, tree })
    assert.equal(persisted.count, size, 'native persistTree must write the exact authoritative tree')
    const state = await app.control('state', { roomKey: seed.roomKey })
    assert.equal(state.count, size, 'native fixture state must read back the exact PG tree')
    rooms[String(size)] = seed.roomKey
    prepared.push({ size, roomKey: seed.roomKey, persistedCount: persisted.count, pgCount: state.count, revision: Number(state.revision) })
  }
  // Independent proof in the real isolated PG that the authoritative node rows
  // and the owner permission actually exist for every owned room.
  const proofs = await isolation.withIsolatedPg(async pool => {
    const rows = []
    for (const item of prepared) {
      const nodes = await pool.query("select count(*)::int as count from room_nodes where room_key=$1 and deleted_at is null", [item.roomKey])
      const room = await pool.query('select version from rooms where room_key=$1', [item.roomKey])
      const member = await pool.query('select role from room_members where room_key=$1 and user_id=$2', [item.roomKey, OWNER_ID])
      assert.equal(nodes.rows[0].count, item.size, 'Real PG must hold the exact fixture tree: ' + item.size)
      assert.equal(room.rows.length, 1, 'Real PG must hold the owned room row: ' + item.size)
      assert.equal(member.rows[0] && member.rows[0].role, 'owner', 'Real PG must hold the owner membership: ' + item.size)
      rows.push({ ...item, pgNodeRows: nodes.rows[0].count, pgVersion: Number(room.rows[0].version), pgRole: member.rows[0].role })
    }
    return rows
  })
  return { rooms, proofs }
}

async function remainingSeededRooms(roomKeys) {
  return isolation.withIsolatedPg(async pool => {
    const result = await pool.query('select room_key from rooms where room_key = any($1::text[]) order by room_key', [roomKeys])
    return result.rows.map(row => row.room_key)
  })
}

module.exports = { prepareStableRooms, remainingSeededRooms, OWNER_ID }
