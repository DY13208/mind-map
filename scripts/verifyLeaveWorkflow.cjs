const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Pool, Client } = require('../simple-mind-map/node_modules/pg')
const core = require('../simple-mind-map/bin/leaveWorkflow/core')
const service = require('../simple-mind-map/bin/leaveWorkflow/service')
const acl = require('../simple-mind-map/bin/roomAcl')
const fixture = require('./fixtures/leave-template-verified.json')
let assertions = 0
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  assertions++
}
async function rejects(run, code) {
  await assert.rejects(run, e => e.code === code, code)
  assertions++
}
const who = id => ({ forceAcl: true, authUser: { id, corpId: 'corp' } })
const body = (row, extra = {}) => ({
  operationId: randomUUID(),
  expectedRevision: row.revision,
  ...extra
})
function configuredFixture() {
  const nodes = structuredClone(fixture),
    root = service.SOURCE.nodeUid
  const child = (p, text) =>
    nodes.find(n => n.parent_uid === p && core.label(n.data.text) === text)
  const config = child(root, '审批配置')
  const binding = (parent, text, id) => {
    const target = child(parent, text)
    assert.ok(target, text)
    nodes.push({
      uid: 'binding-' + id + '-' + target.uid,
      parent_uid: target.uid,
      position: 'A',
      data: { text: '账号：' + id }
    })
  }
  binding(config.uid, '部门负责人', 'manager')
  binding(config.uid, 'SSC', 'ssc')
  const cc = child(config.uid, '抄送')
  for (const [role, id] of [
    ['总经理', 'ceo'],
    ['副总', 'vp'],
    ['人事组', 'hr'],
    ['部门负责人', 'manager']
  ])
    binding(cc.uid, role, id)
  return nodes
}
async function main() {
  const template = core.compileTemplate(fixture, service.SOURCE.nodeUid),
    c = template.calendar
  check(template.types.includes('病假'), true)
  check(
    template.steps.map(s => s.role),
    ['部门负责人', 'SSC']
  )
  check(c.periods, [
    [540, 720],
    [810, 1110]
  ])
  for (const [a, b, minutes] of [
    ['2026-10-19T09:00', '2026-10-19T18:30', 480],
    ['2026-10-19T11:00', '2026-10-19T14:30', 120],
    ['2026-10-19T12:00', '2026-10-19T13:30', 0],
    ['2026-10-16T17:30', '2026-10-19T10:00', 120],
    ['2026-10-17T09:00', '2026-10-18T18:30', 0],
    ['2026-10-19T09:00', '2026-10-21T18:30', 1440]
  ])
    check(core.workingMinutes(a, b, c), minutes)
  check(
    core.workingMinutes('2026-10-17T09:00', '2026-10-17T18:30', {
      ...c,
      workdays: ['2026-10-17']
    }),
    480
  )
  check(
    core.workingMinutes('2026-10-19T09:00', '2026-10-19T18:30', {
      ...c,
      holidays: ['2026-10-19']
    }),
    0
  )
  assert.throws(() =>
    core.workingMinutes('2026-02-31T09:00', '2026-03-01T18:00', c)
  )
  assertions++
  assert.throws(() => core.workingMinutes('明天上午', '2026-10-21T18:00', c))
  assertions++
  check(core.evaluate(template, {}).missing.length, 5)
  check(
    core
      .evaluate(template, { leaveType: '婚假' })
      .blockers.includes('该假种的必要条件要求上传证明附件'),
    true
  )
  check(
    core
      .evaluate(template, { leaveType: '病假' })
      .warnings.some(s => s.includes('当月补交')),
    true
  )
  assert.equal(
    process.env.LEAVE_TEST_DISPOSABLE,
    '1',
    'Explicit disposable DB opt-in required'
  )
  const container = process.env.LEAVE_TEST_DB_CONTAINER
  assert.ok(
    container && /preview|test/.test(container),
    'Use a named disposable preview/test database container'
  )
  const info = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' })
  )[0]
  const env = Object.fromEntries(
    info.Config.Env.map(s => [
      s.slice(0, s.indexOf('=')),
      s.slice(s.indexOf('=') + 1)
    ])
  )
  const config = {
    host: '127.0.0.1',
    port: Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort),
    database: env.POSTGRES_DB || env.POSTGRES_USER || 'postgres',
    user: env.POSTGRES_USER || 'postgres',
    password: env.POSTGRES_PASSWORD
  }
  const admin = new Client(config)
  await admin.connect()
  const schema = 'leave_test_' + process.pid + '_' + Date.now(),
    pool = new Pool({ ...config, options: '-c search_path=' + schema, max: 12 })
  try {
    await admin.query(`create schema ${schema}`)
    await pool.query(`create table rooms(room_key text primary key, owner_id text, folder_id text, deleted_at timestamptz, updated_at timestamptz default now(), title text, version integer default 1);
      create table room_tombstones(room_key text primary key);
      create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
      create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,avatar text,departments jsonb default '[1]');
      create table room_nodes(room_key text,uid text,parent_uid text,position text,data jsonb,deleted_at timestamptz,primary key(room_key,uid));
      create table node_attachments(id text primary key,room_key text,node_uid text,content_hash text,file_name text,status text,extracted_text text);
      insert into wecom_users(user_id,wecom_userid,corp_id,name) select u,u,'corp',u from unnest(array['owner','applicant','manager','ssc','replacement','ceo','vp','hr','other']) u;
      insert into wecom_users(user_id,wecom_userid,corp_id,name) values('foreign','foreign','another','foreign');`)
    await pool.query(
      "insert into rooms(room_key,owner_id,title) values($1,'owner','公司模型'),('personal','applicant','个人工作')",
      [service.SOURCE.roomKey]
    )
    await acl.initSchema(pool)
    await acl.ensureOwner(pool, service.SOURCE.roomKey, 'owner')
    await acl.ensureOwner(pool, 'personal', 'applicant')
    await acl.setMember(
      pool,
      service.SOURCE.roomKey,
      'applicant',
      'viewer',
      'owner'
    )
    await service.initSchema(pool)
    await service.initSchema(pool)
    const missingRoute = await service.routing(
      pool,
      { ...core.compileTemplate(fixture, service.SOURCE.nodeUid) },
      { user_id: 'applicant', corp_id: 'corp', departments: [1] }
    )
    check(missingRoute.missing.includes('部门负责人：待配置'), true)
    check(missingRoute.missing.includes('SSC：待配置'), true)
    const nodes = configuredFixture()
    for (const n of nodes)
      await pool.query(
        'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5)',
        [
          service.SOURCE.roomKey,
          n.uid,
          n.parent_uid,
          n.position,
          JSON.stringify(n.data)
        ]
      )
    await pool.query(
      "insert into room_nodes values('personal','anchor',null,'A','{\"text\":\"我要请假\"}',null)"
    )
    const actor = who('applicant'),
      fields = {
        leaveType: '事假',
        start: '2026-10-20T09:00',
        end: '2026-10-20T11:00',
        replacementId: 'replacement',
        reason: '个人事务，已完成工作交接',
        attachmentIds: []
      }
    let row = await service.prepare(pool, actor, {
      roomKey: 'personal',
      nodeUid: 'anchor'
    })
    check(
      (
        await service.prepare(pool, actor, {
          roomKey: 'personal',
          nodeUid: 'anchor'
        })
      ).id,
      row.id,
      'prepare is idempotent'
    )
    check(
      (await service.notices(pool, who('manager'))).unread,
      0,
      'draft does not notify'
    )
    await rejects(() => service.get(pool, who('manager'), row.id), 'NOT_FOUND')
    await rejects(
      () =>
        service.prepare(
          pool,
          { authUser: { id: 'mcp-service', service: true } },
          { roomKey: 'personal', nodeUid: 'anchor' }
        ),
      'PERSONAL_IDENTITY_REQUIRED'
    )
    await rejects(() => service.get(pool, who('other'), row.id), 'NOT_FOUND')
    await rejects(() => service.get(pool, who('foreign'), row.id), 'NOT_FOUND')
    row = await service.mutate(
      pool,
      actor,
      row.id,
      'save',
      body(row, { fields })
    )
    check(row.report.hours, 2)
    await rejects(
      () =>
        service.mutate(
          pool,
          actor,
          row.id,
          'submit',
          body(row, { confirmSubmission: true })
        ),
      'APPLICATION_INCOMPLETE'
    )
    const tpl = await service.template(pool, who('owner'))
    await rejects(
      () =>
        service.publish(pool, actor, {
          expectedFingerprint: tpl.fingerprint,
          operationId: randomUUID()
        }),
      'FORBIDDEN'
    )
    await service.publish(pool, who('owner'), {
      expectedFingerprint: tpl.fingerprint,
      operationId: randomUUID()
    })
    row = await service.mutate(
      pool,
      actor,
      row.id,
      'submit',
      body(row, { confirmSubmission: true })
    )
    check(row.status, 'pending')
    check(row.steps[row.current_step].assigneeId, 'manager')
    const firstNotices = await service.notices(pool, who('manager'))
    check(firstNotices.unread, 1)
    check(
      (await service.notices(pool, who('manager'), true, [])).unread,
      1,
      'unseen arrivals are not accidentally marked seen'
    )
    check(
      (
        await service.notices(
          pool,
          who('manager'),
          true,
          firstNotices.list.map(n => n.id)
        )
      ).unread,
      0
    )
    check((await service.notices(pool, who('ssc'))).unread, 0)
    const decide = body(row, {
      decision: 'approve',
      reason: '已核对申请时段、交接安排和制度依据',
      checkedCriteria: row.steps[0].criteria.map(c => c.uid)
    })
    await rejects(
      () => service.mutate(pool, who('ssc'), row.id, 'decide', decide),
      'NOT_ASSIGNEE'
    )
    await rejects(
      () =>
        service.mutate(
          pool,
          { ...who('manager'), authUser: { id: 'manager', mcp: true } },
          row.id,
          'decide',
          decide
        ),
      'HUMAN_DECISION_REQUIRED'
    )
    await rejects(
      () =>
        service.mutate(pool, who('manager'), row.id, 'decide', {
          ...decide,
          operationId: randomUUID(),
          checkedCriteria: []
        }),
      'CHECKS_REQUIRED'
    )
    const raced = await Promise.allSettled([
      service.mutate(pool, who('manager'), row.id, 'decide', decide),
      service.mutate(pool, who('manager'), row.id, 'decide', {
        ...decide,
        operationId: randomUUID()
      })
    ])
    check(
      raced.filter(r => r.status === 'fulfilled').length,
      1,
      'two windows advance exactly once'
    )
    row = await service.get(pool, actor, row.id)
    check(row.current_step, 1)
    check((await service.notices(pool, who('ssc'))).unread, 1)
    const duplicate = await service.mutate(
      pool,
      who('manager'),
      row.id,
      'decide',
      decide
    )
    check(duplicate.duplicate, true)
    row = await service.mutate(
      pool,
      who('ssc'),
      row.id,
      'decide',
      body(row, { decision: 'return', reason: '请补充交接说明后重新申请' })
    )
    check(row.round, 2)
    check(row.status, 'returned')
    row = await service.mutate(
      pool,
      actor,
      row.id,
      'save',
      body(row, {
        fields: { ...fields, reason: '个人事务，已重新确认交接工作与接替安排' }
      })
    )
    row = await service.mutate(
      pool,
      actor,
      row.id,
      'submit',
      body(row, { confirmSubmission: true })
    )
    check(row.current_step, 0)
    check(
      row.steps.some(s => s.decision),
      false,
      'old approvals do not carry over'
    )
    for (const person of ['manager', 'ssc'])
      row = await service.mutate(
        pool,
        who(person),
        row.id,
        'decide',
        body(row, {
          decision: 'approve',
          reason: '已逐项核对本轮材料、制度和交接信息',
          checkedCriteria: row.steps[row.current_step].criteria.map(c => c.uid)
        })
      )
    check(row.status, 'approved')
    check((await service.list(pool, who('ceo'), { scope: 'cc' })).total, 1)
    check(
      (await service.list(pool, who('ceo'), { scope: 'todo' })).total,
      0,
      'CC does not approve'
    )
    check(
      (await service.list(pool, who('manager'), { scope: 'history' })).total,
      1
    )
    check(
      (await service.notices(pool, actor)).list.some(
        n => n.kind === 'approved'
      ),
      true
    )
    const saved = await service.get(pool, actor, row.id)
    check(saved.history.filter(e => e.action === 'decide').length, 4)
    check(
      (
        await pool.query(
          "select count(*)::int n from leave_events where request_id=$1 and action='submit' and detail ? 'snapshot'",
          [row.id]
        )
      ).rows[0].n,
      2,
      'each submitted material version persists'
    )
    const { registerLeaveTools, compactLeaveResult } = await import(
      '../simple-mind-map/bin/leaveWorkflow/mcp.mjs'
    )
    const { z } = require('../simple-mind-map/node_modules/zod')
    let invoke, inputSchema
    registerLeaveTools(
      {
        tool(name, description, schema, callback) {
          check(name, 'leave_request')
          inputSchema = z.object(schema)
          invoke = callback
        }
      },
      {
        z,
        ok: data => data,
        fail: e => ({
          isError: true,
          content: [{ type: 'text', text: e.message }]
        }),
        api: async path => ({
          item: await service.get(pool, actor, path.split('/').pop())
        })
      }
    )
    check(
      inputSchema.safeParse({ action: 'decide', request_id: row.id }).success,
      false,
      'MCP does not expose human decision'
    )
    const toolStatus = await invoke({ action: 'status', request_id: row.id })
    check(toolStatus.request_id, row.id)
    check(toolStatus.validation.hours, 2)
    check(
      (await invoke({ action: 'submit', request_id: row.id })).isError,
      true,
      'MCP writes require an operation UUID and revision'
    )
    const huge = compactLeaveResult({
      ...saved,
      history: Array.from({ length: 100 }, () => ({
        action: 'analysis',
        detail: { content: 'x'.repeat(10000) }
      }))
    })
    check(
      Buffer.byteLength(JSON.stringify(huge)) <= 48000,
      true,
      'MCP output is bounded'
    )
    // Rule changes and proofs cannot silently preserve an earlier approval.
    const newDraft = async name => {
      await pool.query(
        "insert into room_nodes values('personal',$1,null,'Z','{\"text\":\"我要请假\"}',null)",
        [name]
      )
      let draft = await service.prepare(pool, actor, {
        roomKey: 'personal',
        nodeUid: name
      })
      return service.mutate(
        pool,
        actor,
        draft.id,
        'save',
        body(draft, { fields })
      )
    }
    let changed = await newDraft('changes')
    await pool.query(
      "insert into node_attachments values('proof','personal','changes','hash-one','证明.pdf','ready','原证明内容'),('other-proof','personal','another','hash-other','他人.pdf','ready','他人资料')"
    )
    await rejects(
      () =>
        service.mutate(
          pool,
          actor,
          changed.id,
          'save',
          body(changed, {
            fields: { ...fields, attachmentIds: ['other-proof'] }
          })
        ),
      'ATTACHMENT_NOT_BOUND'
    )
    changed = await service.mutate(
      pool,
      actor,
      changed.id,
      'save',
      body(changed, { fields: { ...fields, attachmentIds: ['proof'] } })
    )
    changed = await service.mutate(
      pool,
      actor,
      changed.id,
      'submit',
      body(changed, { confirmSubmission: true })
    )
    await pool.query(
      "update node_attachments set content_hash='hash-two',extracted_text='替换后的敏感内容' where id='proof'"
    )
    check(
      (await service.get(pool, who('manager'), changed.id))
        .attachmentEvidence[0].text,
      '',
      'changed evidence not exposed as old proof'
    )
    await rejects(
      () => service.attachment(pool, who('manager'), changed.id, 'proof'),
      'MATERIAL_CHANGED'
    )
    const approve = r =>
      body(r, {
        decision: 'approve',
        reason: '逐项核验',
        checkedCriteria: r.steps[r.current_step].criteria.map(c => c.uid)
      })
    await rejects(
      () =>
        service.mutate(
          pool,
          who('manager'),
          changed.id,
          'decide',
          approve(changed)
        ),
      'MATERIAL_CHANGED'
    )
    const bindingNode = nodes.find(
      n =>
        n.data.text === '账号：manager' &&
        nodes.find(
          p =>
            p.uid === n.parent_uid &&
            p.parent_uid ===
              nodes.find(n => core.label(n.data.text) === '审批配置').uid
        )
    )
    await pool.query(
      "update room_nodes set data=jsonb_set(data,'{text}','\"账号：other\"') where room_key=$1 and uid=$2",
      [service.SOURCE.roomKey, bindingNode.uid]
    )
    await rejects(
      () =>
        service.mutate(
          pool,
          who('manager'),
          changed.id,
          'decide',
          approve(changed)
        ),
      'POLICY_CHANGED'
    )
    const returnBody = body(changed, {
      decision: 'return',
      reason: '配置与材料已变更，请按新流程重提'
    })
    changed = await service.mutate(
      pool,
      who('manager'),
      changed.id,
      'decide',
      returnBody
    )
    const replayReturn = await service.mutate(
      pool,
      who('manager'),
      changed.id,
      'decide',
      returnBody
    )
    check(
      replayReturn.duplicate,
      true,
      'return retries succeed without newer material leakage'
    )
    changed = await service.mutate(
      pool,
      actor,
      changed.id,
      'save',
      body(changed, { fields: { ...fields, reason: '新一轮私密材料' } })
    )
    let tpl2 = await service.template(pool, who('owner'))
    await service.publish(pool, who('owner'), {
      expectedFingerprint: tpl2.fingerprint,
      operationId: randomUUID()
    })
    changed = await service.mutate(
      pool,
      actor,
      changed.id,
      'submit',
      body(changed, { confirmSubmission: true })
    )
    const old = await service.get(pool, who('manager'), changed.id)
    check(old.historical, true)
    check(
      old.fields.reason,
      fields.reason,
      'old reviewer sees only their original materials'
    )
    check(
      old.history.some(
        e => e.detail.reason && e.detail.reason.includes('配置与材料')
      ),
      true
    )
    check(
      old.attachmentEvidence[0].text,
      '',
      'old reviewer cannot read replaced proof'
    )
    check(
      (await service.list(pool, who('manager'), { scope: 'history' })).total,
      2
    )
    // Bounded history pages preserve all events, including long-running rounds.
    for (let i = 0; i < 55; i++)
      await service.mutate(
        pool,
        actor,
        changed.id,
        'analysis',
        body(changed, { content: '辅助建议 ' + i })
      )
    const page1 = await service.get(pool, actor, changed.id)
    check(page1.history.length, 50)
    check(page1.historyHasMore, true)
    const page2 = await service.get(pool, actor, changed.id, {
      before: page1.history[0].id
    })
    check(page2.history.length > 0, true)
    check(
      page2.history.some(e => page1.history.some(p => p.id === e.id)),
      false
    )
    changed = await service.mutate(
      pool,
      who('other'),
      changed.id,
      'decide',
      body(changed, { decision: 'reject', reason: '材料不满足制度' })
    )
    check(changed.status, 'rejected')
    const formerInbox = await service.list(pool, who('manager'), {
      scope: 'history'
    })
    check(
      JSON.stringify(formerInbox).includes('材料不满足制度'),
      false,
      'inbox cards do not leak later-round judgments'
    )
    let withdrawn = await newDraft('withdraw')
    withdrawn = await service.mutate(
      pool,
      actor,
      withdrawn.id,
      'withdraw',
      body(withdrawn)
    )
    check(withdrawn.status, 'withdrawn')
    await rejects(
      () =>
        service.mutate(
          pool,
          actor,
          withdrawn.id,
          'submit',
          body(withdrawn, { confirmSubmission: true })
        ),
      'LOCKED'
    )
    // Real command projection semantics, including clickable request metadata.
    const written = []
    await service.project(pool, async (room, cmd) => {
      written.push(cmd)
      const p = cmd.payload
      if (cmd.type === 'node.insert')
        await pool.query(
          'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5) on conflict do nothing',
          [room, p.uid, p.parentUid, 'A', { text: p.text, ...p.data }]
        )
      else
        await pool.query(
          'update room_nodes set data=data || $3::jsonb where room_key=$1 and uid=$2',
          [room, p.uid, p.patch]
        )
    })
    check(
      written.some(c =>
        String(
          (c.payload.data || c.payload.patch || {}).hyperlink || ''
        ).includes(row.id)
      ),
      true
    )
    check(
      (
        await pool.query(
          "select data->>'text' text from room_nodes where uid=$1",
          [core.projectionId(row.id)]
        )
      ).rows[0].text,
      '请假申请：已通过'
    )
    check(
      (
        await pool.query(
          "select count(*)::int n from room_nodes where data->>'text'='申请资料'"
        )
      ).rows[0].n > 0,
      false,
      'only draft/returned requests get empty field scaffolds'
    )
    await pool.query("delete from room_nodes where room_key='personal'")
    await service.project(pool, async () => {
      throw new Error('deleted anchor')
    })
    check(
      (await service.get(pool, actor, row.id)).status,
      'approved',
      'deleting the graph cannot delete approval history'
    )
    check(
      (
        await pool.query(
          'select projection_pending from leave_requests where id=$1',
          [row.id]
        )
      ).rows[0].projection_pending,
      false
    )
    console.log(
      JSON.stringify({
        ok: true,
        assertions,
        schemaIsolation: true,
        tests: [
          'calendar',
          'personal MCP',
          'privacy',
          'publication',
          'sequential approvals',
          'concurrent clicks',
          'return and resubmit',
          'CC',
          'persistent history',
          'rule/material changes',
          'old-reviewer privacy',
          'history pages',
          'reject/withdraw',
          'projection',
          'deleted graph'
        ]
      })
    )
  } finally {
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
}
main().catch(e => {
  console.error(e.stack || e)
  process.exitCode = 1
})
