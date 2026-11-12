const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { test } = require('node:test')
const bridge = require('../bin/leaveWorkflow/hrmsBridge')

const key = 'test-key-that-is-longer-than-thirty-two-characters'
const now = 1780000000000

test('approval bridge authenticates the exact body, direction and time window', () => {
  const payload = { requestId: 'request', action: 'approve', reason: '材料齐全' }
  const envelope = bridge.sign(key, 'decision', payload, now)
  assert.deepEqual(bridge.verify(key, 'decision', envelope, now), payload)
  assert.throws(() => bridge.verify(key, 'snapshot', envelope, now))
  assert.throws(() => bridge.verify(key, 'decision', { ...envelope, body: envelope.body + ' ' }, now))
  assert.throws(() => bridge.verify(key, 'decision', envelope, now + 301000))
  assert.throws(() => bridge.verify('', 'decision', envelope, now))
})

test('only Agent applications have synchronized approval events', () => {
  assert.equal(bridge.isAgent({ template: { agentInput: true } }), true)
  assert.equal(bridge.isAgent({ template: { agentDefinition: { version: '2' } } }), true)
  assert.equal(bridge.isAgent({ template: {}, report: { submittedByMcp: true } }), true)
  assert.equal(bridge.isAgent({ template: {}, report: {} }), false)
})

test('outbox sends the recorded AI decision to the assigned reviewer separately from CC', async () => {
  let payload
  const row = {
    id: 'a0000000-0000-4000-8000-000000000001',
    revision: 2, round: 1, status: 'approved', corp_id: 'corp', requester_id: 'requester',
    template: { agentInput: true, fields: [] }, fields: {}, report: {},
    steps: [{ assigneeId: 'reviewer', role: '总经理', decidedBy: 'ai-review',
      decision: 'approve', reason: '符合已发布规则' }]
  }
  const db = { async query(sql, args) {
    if (sql.includes('wecom_users')) return {
      rows: args[1].map(id => ({ user_id: id, wecom_userid: 'wecom-' + id }))
    }
    payload = args[3]
    return { rows: [] }
  } }
  await bridge.enqueue(db, row, ['requester', 'cc'], 'approved', {}, { enabled: true, corp: 'corp' })
  assert.deepEqual(payload.recipients, ['wecom-requester', 'wecom-cc'])
  assert.deepEqual(payload.automaticReviews, [
    { index: 0, assignee: 'wecom-reviewer', role: '总经理', decision: 'approve', reason: '符合已发布规则' }
  ])
})

test('signed timeline returns recorded rules only for participants in the mirrored round', async t => {
  const env = {
    HRMS_API_BASE: 'http://127.0.0.1:8080',
    WCPD_HRMS_APPROVAL_BRIDGE_KEY: key,
    WCPD_HRMS_APPROVAL_BRIDGE_CORP_ID: 'test-corp'
  }
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const input = { requestId: randomUUID(), round: 1, revision: 2, corpId: 'test-corp' }
  const audit = [{ actor_id: 'applicant', action: 'submit', detail: {
    automaticDecision: { decision: 'approve', rule: { text: '发起后全部流程默认同意' } }
  } }]
  const people = [{ account: 'applicant', name: '申请人' }]
  const db = { async query(sql, args) {
    if (sql.includes('wecom_userid=$2')) return { rows: [{ user_id: args[1] }] }
    if (sql.includes('from leave_requests')) return { rows: [{
      requester_id: 'applicant', template: { agentDefinition: { version: '1' } },
      status: 'approved', round: 1, revision: 2, cc: ['cc'],
      steps: [{ assigneeId: 'reviewer', decidedBy: 'ai-review', decision: 'approve' }]
    }] }
    if (sql.includes('from leave_events')) {
      assert.match(sql, /detail - 'snapshot'/)
      return { rows: args[2] === '1' ? audit : [] }
    }
    assert.match(sql, /from wecom_users/)
    return { rows: people }
  } }
  async function read(actor, overrides = {}, direction = 'timeline') {
    let response
    const handled = await bridge.handle({ method: 'POST' }, {}, {
      url: { pathname: '/api/workflow-hrms-bridge/timeline' }, db,
      readBody: async () => bridge.sign(key, direction, { ...input, actor, ...overrides }),
      sendJson: (_res, status, body) => { response = { status, body } }
    })
    assert.equal(handled, true)
    return response
  }
  assert.deepEqual(await read('cc'), { status: 200, body: { ok: true, data: { audit, people } } })
  assert.equal((await read('reviewer')).status, 200)
  assert.equal((await read('other')).status, 403)
  assert.equal((await read('applicant', { round: 2 })).status, 403)
  assert.equal((await read('applicant', { revision: 3 })).status, 403)
  assert.equal((await read('cc', {}, 'decision')).status, 403)
})

test('signed HRMS decision advances the real WCPD transaction and queues the next notice', {
  skip: !process.env.APPROVAL_BRIDGE_TEST_DB_URL
}, async () => {
  const { Pool } = require('pg')
  const service = require('../bin/leaveWorkflow/service')
  const schema = 'approval_bridge_' + randomUUID().replace(/-/g, '')
  const url = new URL(process.env.APPROVAL_BRIDGE_TEST_DB_URL)
  assert.equal(url.hostname, '127.0.0.1', 'Use a disposable local database')
  const admin = new Pool({ connectionString: url.href })
  const pool = new Pool({ connectionString: url.href, options: '-c search_path=' + schema })
  const env = {
    HRMS_API_BASE: 'http://127.0.0.1:8080',
    WCPD_HRMS_APPROVAL_BRIDGE_KEY: key,
    WCPD_HRMS_APPROVAL_BRIDGE_CORP_ID: 'test-corp',
    HRMS_SYNC_ENABLED: '0'
  }
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  try {
    await admin.query(`create schema ${schema}`)
    await pool.query(`
      create table rooms(room_key text primary key);
      create table room_nodes(room_key text, parent_uid text, uid text, data jsonb, deleted_at timestamptz);
      create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,departments jsonb);
      insert into wecom_users values ('applicant','user-a','test-corp','申请人','[]'),
        ('reviewer','user-b','test-corp','审核人','[]'),('other','user-c','test-corp','其他人','[]');`)
    await service.initSchema(pool)
    const id = randomUUID()
    await pool.query(`insert into leave_requests(id,corp_id,requester_id,room_key,node_uid,source_room,source_uid,
      template,steps,status,revision) values($1,'test-corp','applicant','room','node','room','node',$2,$3,'pending',2)`,
    [id, { agentInput: true, title: '测试审批', fields: [] },
      JSON.stringify([{ assigneeId: 'reviewer', role: '主管', criteria: [] }])])

    const delivered = []
    const options = { env, fetch: async (_url, request) => {
      const event = bridge.verify(key, 'snapshot', JSON.parse(request.body))
      delivered.push(event)
      return Response.json({ data: { revision: event.revision } })
    } }
    await bridge.run(pool, options)
    assert.equal(delivered[0].kind, 'todo')
    assert.deepEqual(delivered[0].recipients, ['user-b'])

    const call = async (payload, signingKey = key) => {
      let response
      const matched = await bridge.handle({ method: 'POST' }, {}, {
        url: { pathname: '/api/workflow-hrms-bridge/decision' }, db: pool,
        readBody: async () => bridge.sign(signingKey, 'decision', payload),
        sendJson: (_response, status, body) => { response = { status, body } }
      })
      assert.ok(matched)
      return response
    }
    const input = { requestId: id, actor: 'user-b', corpId: 'test-corp', revision: 2,
      step: 0, decision: 'return', reason: '请补材料', checkedCriteria: [], operationId: randomUUID() }
    assert.equal((await call(input, key + 'wrong')).status, 403)
    assert.equal((await call({ ...input, actor: 'user-c' })).status, 404)
    assert.equal((await call({ ...input, step: 1 })).status, 409)
    assert.equal((await call(input)).status, 200)
    assert.equal((await call(input)).status, 200)
    const { rows: [row] } = await pool.query('select status,round,revision from leave_requests where id=$1', [id])
    assert.deepEqual(row, { status: 'returned', round: 2, revision: 3 })
    await bridge.run(pool, options)
    assert.equal(delivered.length, 2)
    assert.equal(delivered[1].kind, 'returned')
    assert.equal(delivered[1].decision, 'return')
    assert.deepEqual(delivered[1].recipients, ['user-a'])
    const { rows: audit } = await pool.query('select actor_id,action from leave_events where request_id=$1', [id])
    assert.deepEqual(audit, [{ actor_id: 'reviewer', action: 'decide' }])
  } finally {
    await pool.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
