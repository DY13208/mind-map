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

test('signed HRMS SOP check requires the service viewer and the exact SOP branch', async t => {
  const skipRootEnv = process.env.MIND_MAP_SKIP_ROOT_ENV
  process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
  require('../bin/leaveWorkflow/hrSopCheck')
  if (skipRootEnv === undefined) delete process.env.MIND_MAP_SKIP_ROOT_ENV
  else process.env.MIND_MAP_SKIP_ROOT_ENV = skipRootEnv
  const env = {
    HRMS_API_BASE: 'http://127.0.0.1:8080',
    WCPD_HRMS_APPROVAL_BRIDGE_KEY: key,
    WCPD_HRMS_APPROVAL_BRIDGE_CORP_ID: 'test-corp',
    WCPD_HR_SOP_BRIDGE_VIEWER_ID: 'sop-reader',
    WCPD_AI_REVIEW_ENABLED: '1',
    WCPD_AI_REVIEW_API_KEY: 'test',
    WCPD_AI_REVIEW_MIN_CONFIDENCE: '0.75'
  }
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const root = '7df2ad7a-0978-43be-acb7-3d5e4ead6dd7'
  const branches = [randomUUID(), randomUUID()]
  const steps = [randomUUID(), randomUUID(), randomUUID()]
  const rejectGroup = randomUUID()
  const rejectRule = randomUUID()
  const ageGroups = Array.from({ length: 9 }, () => randomUUID())
  let verdict
  let preTodoRecipient = '接收账号：test-user'
  let role = 'viewer'
  const db = { async query(sql) {
    if (sql.includes('room_tombstones')) return { rows: [] }
    if (sql.includes('from rooms')) return { rows: [{ room_key: 'room-yk3tz4aj' }] }
    if (sql.includes('room_members')) return { rows: [{ user_id: 'sop-reader', role }] }
    assert.match(sql, /with recursive branch/)
    return { rows: [
      { uid: root, depth: 0, text: '人事流程' },
      ...branches.map(uid => ({ uid, depth: 1, parent_uid: root, text: '测试分支' })),
      { uid: steps[0], depth: 2, parent_uid: branches[0], text: 'IT审核', note: '核对日期' },
      { uid: steps[1], depth: 2, parent_uid: branches[0], text: 'SSC审核' },
      { uid: steps[2], depth: 2, parent_uid: branches[0], text: '没有规则的审核步骤' },
      { uid: rejectGroup, depth: 3, parent_uid: steps[0], text: '以下情况拒绝' },
      { uid: 'step-account', depth: 3, parent_uid: steps[0], text: '账号：it-reviewer' },
      { uid: 'before-review', depth: 3, parent_uid: steps[0], text: '审批前待办' },
      ...(preTodoRecipient ? [{ uid: 'before-account', depth: 4, parent_uid: 'before-review', text: preTodoRecipient }] : []),
      { uid: 'before-content', depth: 4, parent_uid: 'before-review', text: '处理内容：核对资产编号' },
      { uid: rejectRule, depth: 4, parent_uid: rejectGroup, text: '明确不符合要求' },
      ...[
        [0, branches[0], 2, '提交要求'],
        [1, ageGroups[0], 3, '待入职人员'], [2, ageGroups[0], 3, '年龄'],
        [3, ageGroups[0], 3, '待入职人员简历'], [4, ageGroups[3], 4, '简历附件'],
        [5, steps[1], 3, '默认同意'], [6, steps[1], 3, '以下情况拒绝'],
        [7, ageGroups[5], 4, '仅在年龄可核验且小于40岁时自动通过。年龄不满足或无法核验时转人工。'],
        [8, ageGroups[6], 4, '年龄可核验，且大于或等于 40 周岁时，自动驳回']
      ].map(([index, parent_uid, depth, text]) => ({ uid: ageGroups[index], parent_uid, depth, text }))
    ].sort((a, b) => a.depth - b.depth) }
  } }
  const model = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, async json() {
    return { choices: [{ message: { content: JSON.stringify(verdict || {
      pass: true, branchUid: branches[0], confidence: 0.99
    }) } }] }
  } }))
  async function send(branchUid, signed = true, stepUid, files = [], date = '2026-11-14', resultMode, age, includeReason, match = {}) {
    let result
    const fields = age === undefined ? { date: { value: date } } : {
      name: { label: '姓名', value: '测试甲' }, age: { label: '年龄', value: age }
    }
    const submission = JSON.stringify({ 提交字段: fields })
    const requiredEvidence = stepUid === steps[1] ? [] : [{ type: 'field', key: 'date' }]
    if (age !== undefined) requiredEvidence.push(
      { type: 'field', key: 'name' }, { type: 'field', key: 'age' }, { type: 'attachment', key: 'record' })
    if (stepUid === steps[0]) requiredEvidence.push({ type: 'attachment', key: 'record' })
    const input = bridge.sign(key, 'hr-sop-check', { corpId: 'test-corp', branchUid, stepUid, text: submission, files, requiredEvidence, resultMode, includeReason, ...match })
    const headers = {}
    const handled = await bridge.handle({ method: 'POST' }, { setHeader: (key, value) => { headers[key] = value } }, {
      url: { pathname: '/api/workflow-hrms-bridge/hr-sop-check' }, db,
      readBody: async () => signed ? input : { ...input, signature: '0'.repeat(64) },
      sendJson: (_, status, body) => { result = { status, body } }
    })
    assert.equal(handled, true)
    return resultMode ? { ...result, mode: headers['X-SOP-Result-Mode'] } : result
  }
  assert.equal((await send(branches[0], false)).status, 403)
  assert.deepEqual(await send(branches[0]), { status: 200, body: true })
  assert.deepEqual(await send(branches[1]), { status: 200, body: false })
  assert.deepEqual(await send(randomUUID()), { status: 200, body: false })
  const record = { name: 'record.txt', base64: Buffer.from('test record').toString('base64') }
  assert.deepEqual(await send(branches[0], true, steps[0]), { status: 200, body: false })
  assert.deepEqual(await send(branches[0], true, steps[0], [record]), { status: 200, body: false })
  assert.deepEqual(await send(branches[0], true, steps[0], [{ ...record, fieldKey: 'record' }], ' '), { status: 200, body: false })
  assert.deepEqual(await send(branches[0], true, steps[1]), { status: 200, body: false })
  assert.equal(model.mock.callCount(), 2)
  assert.deepEqual(await send(branches[0], true, steps[0], [{ ...record, fieldKey: 'record' }]), { status: 200, body: true })
  const modelInput = JSON.parse(model.mock.calls.at(-1).arguments[1].body)
  assert.match(modelInput.messages[0].content, /核对该流程所有必填字段/)
  const modelEvidence = JSON.parse(modelInput.messages[1].content)
  assert.deepEqual(modelEvidence.sop.map(node => node.uid), [root, branches[0], steps[0], ageGroups[0], rejectGroup, 'step-account',
    ...ageGroups.slice(1, 4), rejectRule, ageGroups[4]])
  assert.deepEqual(await send(branches[0], true, steps[2]), { status: 200, body: false })
  assert.deepEqual(await send(branches[1], true, steps[0]), { status: 200, body: false })
  role = null
  assert.equal((await send(branches[0])).status, 403)
  assert.equal(model.mock.callCount(), 3)
  role = 'viewer'
  const tri = files => send(branches[0], true, steps[0], files, '2026-11-14', 'triState')
  const complete = [{ ...record, fieldKey: 'record' }]
  verdict = { decision: 'reject', branchUid: branches[0], confidence: 0.99, rejectRuleUid: rejectRule }
  assert.deepEqual(await tri([]), { status: 200, body: null, mode: 'triState' })
  assert.equal(model.mock.callCount(), 3)
  assert.deepEqual(await tri(complete), { status: 200, body: false, mode: 'triState' })
  verdict.rejectRuleUid = steps[1]
  assert.deepEqual(await tri(complete), { status: 200, body: null, mode: 'triState' })
  verdict.rejectRuleUid = rejectRule
  verdict.confidence = 0.6
  assert.deepEqual(await tri(complete), { status: 200, body: null, mode: 'triState' })
  verdict.decision = 'approve'
  verdict.confidence = 0.99
  assert.deepEqual(await tri(complete), { status: 200, body: true, mode: 'triState' })
  const modelCalls = model.mock.callCount()
  for (const [age, recorded, result] of [[30, 30, true], [40, 40, false], [30, 45, null]]) {
    verdict = { decision: result === null ? 'manual' : result ? 'approve' : 'reject',
      branchUid: steps[1], confidence: 0.99, rejectRuleUid: ageGroups[8] }
    const file = { ...record, fieldKey: 'record', base64: Buffer.from('年龄：' + recorded + '岁').toString('base64') }
    assert.deepEqual(await send(branches[0], true, steps[1], [file], '2026-11-14', 'triState', age),
      { status: 200, body: result, mode: 'triState' })
    const body = JSON.parse(model.mock.calls.at(-1).arguments[1].body)
    const { submission } = JSON.parse(body.messages[1].content)
    assert.equal(submission.fields.age.value, age)
  }
  assert.equal(model.mock.callCount(), modelCalls + 3)
  verdict = { decision: 'approve', confidence: 0.98, reason: '年龄符合通过条件。' }
  const detail = () => send(branches[0], true, steps[0], complete, '2026-11-14', 'triState', undefined, true)
  assert.deepEqual((await detail()).body, { result: true, reason: '年龄符合通过条件。' })
  const selected = await send(branches[0], true, steps[0], complete, '2026-11-14', 'triState', undefined, true,
    { selectedEvidenceOnly: true })
  assert.equal(selected.body.result, true)
  const selectedPrompt = JSON.parse(model.mock.calls.at(-1).arguments[1].body).messages[0].content
  assert.match(selectedPrompt, /本次只核验目标审核步骤/)
  assert.doesNotMatch(selectedPrompt, /核对该流程所有必填字段/)
  const subsidyFiles = Array.from({ length: 6 }, (_, index) => ({ ...complete[0], name: `proof-${index}.txt` }))
  assert.equal((await tri(subsidyFiles)).body, null)
  const subsidy = await send(branches[0], true, steps[0], subsidyFiles, '2026-11-14', 'triState', undefined, true,
    { subsidyEvidence: true })
  assert.equal(subsidy.body.result, true)
  const subsidyPrompt = JSON.parse(model.mock.calls.at(-1).arguments[1].body)
  assert.equal(JSON.parse(subsidyPrompt.messages[1].content).submission.attachments.length, 6)
  verdict = { decision: 'reject', confidence: 0.98, rejectRuleUid: rejectRule, reason: '记录不符合要求。' }
  assert.deepEqual((await detail()).body, { result: false, reason: '命中「明确不符合要求」。记录不符合要求。' })
  const auto = match => send(branches[0], true, undefined, [], '2026-11-14', 'triState', undefined, true, match)
  verdict = { decision: 'approve', confidence: 0.98, reason: '符合通过条件。' }
  assert.deepEqual((await auto({ stepLabel: 'IT审核' })).body, { result: true, reason: '符合通过条件。' })
  assert.deepEqual((await auto({ stepLabel: '审批人', stepAccount: 'IT-REVIEWER' })).body, { result: true, reason: '符合通过条件。' })
  const beforeMismatch = model.mock.callCount()
  assert.equal((await auto({ stepLabel: '找不到的节点' })).body.result, null)
  assert.equal((await auto({ stepLabel: 'SSC审核', stepAccount: 'it-reviewer' })).body.result, null)
  assert.equal(model.mock.callCount(), beforeMismatch)
  assert.deepEqual(await send(branches[0], true, undefined, [], '2026-11-14', undefined, undefined, undefined,
    { stepAccount: 'IT-REVIEWER', readPreTasks: true }), {
    status: 200, body: { preTasks: [{ account: 'test-user', content: '核对资产编号' }] }
  })
  assert.deepEqual((await send(branches[0], true, steps[1], [], '2026-11-14', undefined, undefined, undefined,
    { readPreTasks: true })).body, { preTasks: [] })
  for (const recipient of ['发起人', '被发起人']) {
    preTodoRecipient = '接收人：' + recipient
    assert.deepEqual((await send(branches[0], true, steps[0], [], '2026-11-14', undefined, undefined, undefined,
      { readPreTasks: true })).body, { preTasks: [{ recipient, content: '核对资产编号' }] })
  }
  preTodoRecipient = '接收账号：待入职人员的实际企微账号'
  assert.equal((await send(branches[0], true, steps[0], [], '2026-11-14', undefined, undefined, undefined,
    { readPreTasks: true })).status, 400)
  preTodoRecipient = ''
  assert.deepEqual((await send(branches[0], true, steps[0], [], '2026-11-14', undefined, undefined, undefined,
    { readPreTasks: true })).body, { preTasks: [{ recipient: '当前审批人', content: '核对资产编号' }] })
  assert.equal(model.mock.callCount(), beforeMismatch)
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
