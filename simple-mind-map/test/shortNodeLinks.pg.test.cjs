const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const { Pool } = require('pg')
const { randomUUID } = require('node:crypto')
let cluster, admin, port
before(async () => {
  cluster = fs.mkdtempSync(path.join(os.tmpdir(), 'short-link-pg-'))
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  await new Promise(resolve => server.close(resolve))
  execFileSync('initdb', ['-D', cluster, '-U', 'shortlink_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore' })
  execFileSync('pg_ctl', ['-D', cluster, '-l', path.join(cluster, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${cluster}`, '-w', 'start'], { stdio: 'ignore' })
  admin = new Pool({ host: '127.0.0.1', port, user: 'shortlink_test', database: 'postgres' })
})
after(async () => {
  if (admin) await admin.end()
  if (cluster) {
    try { execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } finally { fs.rmSync(cluster, { recursive: true, force: true }) }
  }
})
async function withDirectoryDatabase(fn) {
  const schema = 'short_' + randomUUID().replace(/-/g, '')
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({ host: '127.0.0.1', port, user: 'shortlink_test', database: 'postgres', options: `-c search_path=${schema}`, max: 6 })
  try {
    await pool.query(`create table rooms(room_key text primary key,title text,version int,updated_at timestamptz);
      create table room_tombstones(room_key text primary key);
      create table room_nodes(room_key text,uid text,data jsonb,deleted_at timestamptz);
      create table room_members(room_key text,user_id text);`)
    // Inject the access boundary; verify every create/resolve consults it again.
    const acl = { async assertRoomAccess(db, request, room, action) {
      assert.equal(action, 'view')
      const result = await db.query('select 1 from room_members where room_key=$1 and user_id=$2', [room, request.authUser.id])
      if (!result.rows.length) throw Object.assign(Error('denied'), { statusCode: 403 })
    } }
    return await fn({ client: pool, adapter: pool, acl })
  } finally {
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
  }
}
async function seedPreview(f, { children }) {
  const key = 'fixture-map'
  await f.client.query(`insert into rooms values($1,'Map',1,now());`, [key])
  await f.client.query(`insert into room_members values($1,'owner'),($1,'other-member')`, [key])
  for (let i = 1; i <= children; i++) await f.client.query('insert into room_nodes values($1,$2,$3,null)', [key, 'c'+i, { text: 'Child '+i }])
  return key
}
const { resolveRoomRef } = require('../bin/roomNodes')
const { createShortNodeLinks } = require('../bin/shortNodeLinks')
const req = user => ({ authUser: { id: user }, forceAcl: true, headers: {} })

test('short links reuse persisted locators across processes, rename and concurrent creation', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 2, grandChildren: 0 })
    const options = { pool: f.adapter,
      assertAccess: (request, room) => f.acl.assertRoomAccess(f.adapter, request, room, 'view'),
      resolveRef: (room, uid) => resolveRoomRef(f.adapter, room, uid) }
    const service = createShortNodeLinks(options)
    const a = await service.create(req('owner'), { roomKey: key, uid: 'c1' })
    assert.match(a.code, /^[A-Za-z0-9_-]{12}$/)
    const b = await createShortNodeLinks(options).create(req('other-member'), { roomKey: key, uid: 'c1' })
    assert.equal(a.code, b.code)
    const results = await Promise.all(Array.from({ length: 4 }, () => service.create(req('owner'), { roomKey: key, uid: 'c2' })))
    assert.equal(new Set(results.map(x => x.code)).size, 1)
    await f.client.query(`update room_nodes set data = jsonb_set(data, '{text}', '"Renamed"') where room_key=$1 and uid='c1'`, [key])
    const target = await createShortNodeLinks(options).resolve(req('other-member'), a.code)
    assert.equal(target.text, 'Renamed')
    assert.equal(target.uid, 'c1')
    assert.equal(target.roomKey, key)
    assert.equal((await f.client.query('select count(*) from node_short_links')).rows[0].count, '2')
  })
})

test('link possession grants no access; revoked membership, missing/deleted nodes and invalid codes fail', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 1, grandChildren: 0 })
    const service = createShortNodeLinks({ pool: f.adapter,
      assertAccess: (request, room) => f.acl.assertRoomAccess(f.adapter, request, room, 'view'),
      resolveRef: (room, uid) => resolveRoomRef(f.adapter, room, uid) })
    const { code } = await service.create(req('owner'), { roomKey: key, uid: 'c1' })
    await assert.rejects(service.resolve(req('outsider'), code), e => e.statusCode === 403)
    await assert.rejects(service.create(req('outsider'), { roomKey: key, uid: 'c1' }), e => e.statusCode === 403)
    await f.client.query('delete from room_members where room_key=$1 and user_id=$2', [key, 'other-member'])
    await assert.rejects(service.resolve(req('other-member'), code), e => e.statusCode === 403)
    await f.client.query("update room_nodes set deleted_at=now() where room_key=$1 and uid='c1'", [key])
    await assert.rejects(service.resolve(req('owner'), code), e => e.statusCode === 404)
    await assert.rejects(service.create(req('owner'), { roomKey: key, uid: 'missing' }), e => e.statusCode === 404)
    await assert.rejects(service.resolve(req('owner'), '../x'), e => e.statusCode === 404)
    await assert.rejects(service.create(req('owner'), null), e => e.statusCode === 400)
    await assert.rejects(service.resolve(req('owner'), 'AAAAAAAAAAAA'), e => e.statusCode === 404)
  })
})

test('random code collisions retry without changing another node destination', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 2, grandChildren: 0 })
    const codes = ['AAAAAAAAAAAA', 'AAAAAAAAAAAA', 'BBBBBBBBBBBB']
    const service = createShortNodeLinks({ pool: f.adapter, assertAccess: async () => {},
      resolveRef: (room, uid) => resolveRoomRef(f.adapter, room, uid), randomCode: () => codes.shift() })
    const first = await service.create({}, { roomKey: key, uid: 'c1' })
    const second = await service.create({}, { roomKey: key, uid: 'c2' })
    assert.equal(first.code, 'AAAAAAAAAAAA')
    assert.equal(second.code, 'BBBBBBBBBBBB')
    assert.equal((await service.resolve({}, first.code)).uid, 'c1')
  })
})
