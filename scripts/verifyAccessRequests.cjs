const assert = require('assert/strict')
const http = require('http')
const { Client, Pool } = require('../simple-mind-map/node_modules/pg')
const acl = require('../simple-mind-map/bin/roomAcl')
const requests = require('../simple-mind-map/bin/accessRequests')
const events = require('../simple-mind-map/bin/accessRequestEvents')
async function main() {
  assert.equal(process.env.PERMISSION_TEST_DISPOSABLE, '1')
  assert.ok(process.env.PGDATABASE && process.env.PGPORT)
  const admin = new Client()
  await admin.connect()
  const schema = 'access_test_' + process.pid
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({ options: `-c search_path=${schema}`, max: 10 })
  const actor = id => ({ forceAcl: true, authUser: { id, corpId: 'corp' } })
  let server, ownerStream, outsiderStream, unsubscribeSpy
  try {
    await pool.query(`create table rooms(room_key text primary key,owner_id text,folder_id text,deleted_at timestamptz,updated_at timestamptz default now(),title text);
      create table room_tombstones(room_key text primary key);create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
      create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,avatar text);
      insert into rooms(room_key,owner_id,title) values('room','owner','项目规划');
      insert into wecom_users(user_id,wecom_userid,corp_id,name) values('owner','wx-owner','corp','所有者'),('second','wx-second','corp','另一所有者'),('applicant','wx-applicant','corp','申请人'),('other','wx-other','corp','其他成员');`)
    await acl.initSchema(pool)
    await requests.initSchema(pool)
    await requests.initSchema(pool)
    await acl.ensureOwner(pool, 'room', 'owner')
    await acl.setMember(pool, 'room', 'second', 'owner', 'owner')
    await pool.query(
      "insert into rooms(room_key,owner_id,title) values('offline-room','owner','离线申请')"
    )
    await acl.ensureOwner(pool, 'offline-room', 'owner')
    await requests.requestAccess(pool, actor('applicant'), {
      roomKey: 'offline-room',
      role: 'viewer'
    })
    assert.equal(
      (await requests.listInbox(pool, actor('owner'))).total,
      1,
      'Offline applications persist without a connected listener'
    )
    await pool.query("delete from rooms where room_key='offline-room'")
    server = http.createServer((req, res) =>
      events.stream(pool, req, res, req.url === '/owner' ? 'owner' : 'other')
    )
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    const controller = new AbortController(),
      otherController = new AbortController()
    ownerStream = controller
    outsiderStream = otherController
    const response = await fetch(base + '/owner', { signal: controller.signal })
    const reader = response.body.getReader()
    const outsider = await fetch(base + '/other', {
      signal: otherController.signal
    })
    const outsiderReader = outsider.body.getReader()
    async function nextEvent(stream, pattern) {
      const timeout = setTimeout(() => stream.cancel(), 3000)
      try {
        let received = ''
        while (!received.includes(pattern)) {
          const { value, done } = await stream.read()
          assert.equal(done, false)
          received += Buffer.from(value).toString()
        }
        return received
      } finally {
        clearTimeout(timeout)
      }
    }
    const ready = await nextEvent(reader, 'ready')
    if (!ready.includes('invalidate')) await nextEvent(reader, 'invalidate')
    await nextEvent(outsiderReader, 'ready')
    let outsiderEvents = 0
    unsubscribeSpy = events.bridgeFor(pool).subscribe('other', () => {
      outsiderEvents++
    })
    const row = await requests.requestAccess(pool, actor('applicant'), {
      roomKey: 'room',
      role: 'editor',
      reason: '补充实施计划'
    })
    const inbox = await requests.listInbox(pool, actor('owner'))
    assert.equal(inbox.total, 1)
    assert.equal(inbox.list[0].request_reason, '补充实施计划')
    assert.equal((await requests.listInbox(pool, actor('other'))).total, 0)
    await nextEvent(reader, 'invalidate')
    assert.equal(outsiderEvents, 0, 'Unrelated users receive no invalidation')
    const duplicate = await requests.requestAccess(pool, actor('applicant'), {
      roomKey: 'room',
      role: 'editor',
      reason: '补充实施计划'
    })
    assert.equal(row.id, duplicate.id)
    assert.equal((await requests.listInbox(pool, actor('owner'))).total, 1)
    await assert.rejects(
      requests.decide(pool, actor('other'), row.id, 'approve', {
        role: 'manager'
      }),
      e => e.statusCode === 404
    )
    await assert.rejects(
      requests.decide(pool, actor('owner'), row.id, 'approve', {
        role: 'owner'
      }),
      e => e.statusCode === 400
    )
    const both = await Promise.allSettled([
      requests.decide(pool, actor('owner'), row.id, 'approve', {
        role: 'manager'
      }),
      requests.decide(pool, actor('second'), row.id, 'reject')
    ])
    assert.equal(both.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(
      both.filter(r => r.status === 'rejected' && r.reason.statusCode === 409)
        .length,
      1
    )
    const decided = (
      await pool.query('select * from room_access_requests where id=$1', [
        row.id
      ])
    ).rows[0]
    if (decided.status === 'approved') {
      assert.equal(
        (await acl.getAccess(pool, 'room', 'applicant')).role,
        'manager'
      )
      assert.equal(decided.granted_role, 'manager')
    } else
      assert.equal((await acl.getAccess(pool, 'room', 'applicant')).role, null)
    const retry = await requests.decide(
      pool,
      actor(decided.decided_by),
      row.id,
      decided.status === 'approved' ? 'approve' : 'reject',
      { role: decided.granted_role }
    )
    assert.equal(retry.already_processed, true)
    const results = await requests.listResults(pool, actor('applicant'))
    assert.equal(results.unread, 1)
    assert.equal((await requests.listResults(pool, actor('other'))).total, 0)
    await requests.markSeen(pool, actor('other'), [row.id])
    assert.equal(
      (await requests.listResults(pool, actor('applicant'))).unread,
      1
    )
    await requests.markSeen(pool, actor('applicant'), [row.id])
    assert.equal(
      (await requests.listResults(pool, actor('applicant'))).unread,
      0
    )
    if (decided.status !== 'approved') {
      const grant = await requests.requestAccess(pool, actor('applicant'), {
        roomKey: 'room',
        role: 'editor'
      })
      await requests.decide(pool, actor('owner'), grant.id, 'approve', {
        role: 'manager'
      })
      await requests.markSeen(pool, actor('applicant'), [grant.id])
    }
    assert.equal(
      (await acl.getAccess(pool, 'room', 'applicant')).role,
      'manager'
    )
    assert.equal(
      (
        await requests.requestAccess(pool, actor('applicant'), {
          roomKey: 'room'
        })
      ).status,
      'already_allowed'
    )
    await acl.removeMember(pool, 'room', 'applicant', '', 'owner')
    const second = await requests.requestAccess(pool, actor('applicant'), {
      roomKey: 'room',
      role: 'viewer'
    })
    let fail = true
    const failingPool = {
      async connect() {
        const client = await pool.connect()
        return {
          release: () => client.release(),
          query(sql, args) {
            if (fail && String(sql).includes('set status=$2')) {
              fail = false
              throw new Error('injected decision failure')
            }
            return client.query(sql, args)
          }
        }
      }
    }
    await assert.rejects(
      requests.decide(failingPool, actor('owner'), second.id, 'approve', {
        role: 'editor'
      }),
      /injected/
    )
    assert.equal(
      (await acl.getAccess(pool, 'room', 'applicant')).role,
      null,
      'Grant rolls back with decision failure'
    )
    assert.equal(
      (await requests.mine(pool, actor('applicant'), 'room')).status,
      'pending'
    )
    await requests.decide(pool, actor('owner'), second.id, 'reject', {
      reason: '请补充项目用途'
    })
    assert.equal(
      (await requests.mine(pool, actor('applicant'), 'room')).decision_reason,
      '请补充项目用途'
    )
    const transferRequest = await requests.requestAccess(pool, actor('other'), {
      roomKey: 'room',
      role: 'viewer'
    })
    await acl.transferOwnership(pool, 'room', 'second', 'owner', 'corp')
    await assert.rejects(
      requests.decide(pool, actor('owner'), transferRequest.id, 'approve'),
      e => e.statusCode === 404
    )
    await requests.decide(
      pool,
      actor('second'),
      transferRequest.id,
      'approve',
      { role: 'viewer' }
    )
    assert.equal((await acl.getAccess(pool, 'room', 'other')).role, 'viewer')
    const editorRequest = await requests.requestAccess(
      pool,
      actor('applicant'),
      { roomKey: 'room', role: 'viewer' }
    )
    await requests.decide(pool, actor('second'), editorRequest.id, 'approve', {
      role: 'editor'
    })
    assert.equal(
      (await acl.getAccess(pool, 'room', 'applicant')).role,
      'editor'
    )
    await pool.query("update rooms set deleted_at=now() where room_key='room'")
    assert.equal(
      (await requests.mine(pool, actor('applicant'), 'room')).access.canView,
      false
    )
    await assert.rejects(
      requests.requestAccess(pool, actor('other'), { roomKey: 'room' }),
      e => e.statusCode === 404
    )
    assert.equal((await requests.listInbox(pool, actor('owner'))).total, 0)
    console.log(
      'Access request checks passed: durable inbox, SSE, identity isolation, custom grant, concurrent approval, retry, transaction rollback, results/read status, rejection, deleted file'
    )
  } finally {
    if (unsubscribeSpy) unsubscribeSpy()
    if (ownerStream) ownerStream.abort()
    if (outsiderStream) outsiderStream.abort()
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
