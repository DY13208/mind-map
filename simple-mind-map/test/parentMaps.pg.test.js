// Only connection-local TEMP tables are written; no schema init or live data writes.
const test = require('node:test')
const assert = require('node:assert/strict')
require('../bin/loadEnv')
const { Client } = require('pg')
const { listParentMaps } = require('../bin/parentMaps')

test('direct parents: ACL, dedupe, cycles, deletion, search, keyset pages and legacy refs', async () => {
  const db = new Client({ ...(process.env.PARENT_MAP_TEST_PG_URL ? { connectionString: process.env.PARENT_MAP_TEST_PG_URL } : {}), connectionTimeoutMillis: 4000 })
  await db.connect()
  try {
    await db.query(`
      create temp table rooms(room_key text primary key, title text, nodes jsonb default '{}', deleted_at timestamptz);
      create temp table room_nodes(room_key text, uid text, data jsonb, is_root boolean default false, deleted_at timestamptz);
      create temp table room_members(room_key text, user_id text, role text);
      create temp table room_tombstones(room_key text);
      create temp table node_shares(id uuid, room_key text, token_hash text, role text, recipient_user_id text, recipient_user_ids text[], revoked_at timestamptz, expires_at timestamptz);
    `)
    const req = { forceAcl: true, authUser: { id: 'viewer' }, headers: {} }
    await db.query("insert into rooms(room_key,title) values ('child','Child'),('ancestor','Ancestor'),('hidden','Secret'),('trash','Trash'),('gone','Gone')")
    await db.query("insert into room_members values ('hidden','other','owner')")
    await db.query("insert into room_tombstones values ('gone'); update rooms set deleted_at=now() where room_key='trash'")
    const ref = async (room, target, uid = 'root', deleted = false) => db.query(
      'insert into room_nodes(room_key,uid,data,is_root,deleted_at) values($1,$2,$3,$4,$5)',
      [room, uid, JSON.stringify({ mapRef: target }), uid === 'root', deleted ? new Date() : null]
    )
    await ref('hidden', { mapId: 'child' }); await ref('trash', { mapId: 'child' }); await ref('gone', { mapId: 'child' })
    await ref('child', { mapId: 'child' }) // self/cycle is excluded
    for (let i = 0; i < 25; i++) {
      const room = `parent-${String(i).padStart(2,'0')}`
      await db.query('insert into rooms(room_key,title) values($1,$2)', [room, `Parent ${i}`])
      await ref(room, { mapId: 'child' })
    }
    await ref('parent-00', { mapId: 'child' }, 'duplicate')
    await ref('ancestor', { mapId: 'parent-00' }) // not a direct parent
    let page = await listParentMaps(db, req, 'child')
    assert.equal(page.list.length, 20); assert.equal(page.hasMore, true)
    assert.equal(new Set(page.list.map(x => x.roomKey)).size, 20)
    const next = await listParentMaps(db, req, 'child', { cursor: page.nextCursor })
    assert.equal(next.list.length, 5); assert.equal(next.hasMore, false)
    assert.ok(!next.list.some(x => page.list.some(y => y.roomKey === x.roomKey)))
    const search = await listParentMaps(db, req, 'child', { q: 'Parent 24' })
    assert.deepEqual(search.list.map(x => x.roomKey), ['parent-24'])
    await assert.rejects(listParentMaps(db, req, 'child', { q: 'changed', cursor: page.nextCursor }), { code: 'INVALID_CURSOR' })
    await assert.rejects(listParentMaps(db, { ...req, authUser: { id: 'other' } }, 'hidden', { cursor: page.nextCursor }), { code: 'INVALID_CURSOR' })
    await assert.rejects(listParentMaps(db, req, 'hidden'), { statusCode: 403 })
    const crypto = require('crypto')
    const { nodeShareCookieName } = require('../bin/roomAcl')
    const shareId = crypto.randomUUID()
    const token = 'a'.repeat(32)
    await db.query('insert into node_shares(id,room_key,token_hash,role) values($1,$2,$3,$4)',
      [shareId, 'hidden', crypto.createHash('sha256').update(token).digest('hex'), 'viewer'])
    const cookieReq = { ...req, headers: { cookie: `${nodeShareCookieName('hidden')}=${shareId}.${token}` } }
    assert.deepEqual((await listParentMaps(db, cookieReq, 'child', { q: 'Secret' })).list.map(x => x.roomKey), ['hidden'])
    cookieReq.headers.cookie = `${nodeShareCookieName('hidden')}=${shareId}.${'b'.repeat(32)}`
    assert.deepEqual((await listParentMaps(db, cookieReq, 'child', { q: 'Secret' })).list, [])
    assert.deepEqual((await listParentMaps(db, req, 'child', { q: '%' })).list, [])
    // Database errors during final permission checks must not become an empty success.
    const failingDb = { query(sql, args) {
      if (sql.includes('select user_id, role') && args[0] === 'parent-00') throw new Error('DB unavailable')
      return db.query(sql, args)
    } }
    await assert.rejects(listParentMaps(failingDb, req, 'child'), /DB unavailable/)
    await db.query("update room_nodes set deleted_at=now() where room_key='parent-24'")
    assert.deepEqual((await listParentMaps(db, req, 'child', { q: 'Parent 24' })).list, [])
    await db.query("insert into rooms(room_key,title,nodes) values('legacy','Legacy', $1)", [JSON.stringify({ root: { data: { mapRef: JSON.stringify({ map_id: 'child' }) } } })])
    assert.deepEqual((await listParentMaps(db, req, 'child', { q: 'Legacy' })).list.map(x => x.roomKey), ['legacy'])
    await db.query("insert into rooms(room_key,title) values('string','String'); insert into room_nodes(room_key,uid,data,is_root) values('string','root','{\"mapRef\":\"child\"}',true)")
    assert.deepEqual((await listParentMaps(db, req, 'child', { q: 'String' })).list.map(x => x.roomKey), ['string'])
  } finally { await db.end() }
})
