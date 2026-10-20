const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process'),
  { randomUUID } = require('node:crypto')
const { Pool, Client } = require('../simple-mind-map/node_modules/pg')
const service = require('../simple-mind-map/bin/leaveWorkflow/service'),
  core = require('../simple-mind-map/bin/leaveWorkflow/core'),
  workflow = require('../simple-mind-map/bin/leaveWorkflow/workflowCore'),
  acl = require('../simple-mind-map/bin/roomAcl')
const { template: fixture } = require('./fixtures/approval-templates.cjs')
let count = 0
const check = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  count++
}
const rejects = async (run, code) => {
  await assert.rejects(run, e => e.code === code, code)
  count++
}
const who = id => ({ forceAcl: true, authUser: { id, corpId: 'corp' } })
const body = (r, more = {}) => ({
  operationId: randomUUID(),
  expectedRevision: r.revision,
  ...more
})
async function main() {
  const { compactLeaveResult } = await import(
    '../simple-mind-map/bin/leaveWorkflow/mcp.mjs'
  )
  const large = compactLeaveResult({
    id: 'large',
    revision: 1,
    status: 'draft',
    round: 1,
    current_step: 0,
    fields: Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => ['f_' + i, '测'.repeat(3000)])
    ),
    template: { source: { roomKey: 'r', nodeUid: 'n' }, fields: [] },
    steps: Array.from({ length: 20 }, () => ({
      role: '长'.repeat(4000),
      criteria: []
    })),
    report: {
      missing: [],
      blockers: ['测'.repeat(20000)],
      warnings: [],
      configurationRequired: []
    },
    cc: []
  })
  check(
    Buffer.byteLength(JSON.stringify(large)) <= 48000,
    true,
    'MCP output remains bounded for large generic requests'
  )
  check(large.truncated, true)
  assert.equal(process.env.LEAVE_TEST_DISPOSABLE, '1')
  assert.match(process.env.LEAVE_TEST_DB_CONTAINER || '', /test|preview/)
  const info = JSON.parse(
    execFileSync('docker', ['inspect', process.env.LEAVE_TEST_DB_CONTAINER], {
      encoding: 'utf8'
    })
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
  const schema = 'approval_test_' + process.pid + '_' + Date.now(),
    pool = new Pool({ ...config, options: '-c search_path=' + schema })
  try {
    await admin.query('create schema ' + schema)
    await pool.query(`create table rooms(room_key text primary key,owner_id text,folder_id text,deleted_at timestamptz,updated_at timestamptz default now(),title text);
    create table room_tombstones(room_key text primary key);create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
    create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,departments jsonb default '[1]');
    create table room_nodes(room_key text,uid text,parent_uid text,position text,data jsonb,deleted_at timestamptz,primary key(room_key,uid));
    create table node_attachments(id text primary key,room_key text,node_uid text,content_hash text,file_name text,status text,extracted_text text);
    insert into wecom_users(user_id,wecom_userid,corp_id,name) select u,u,'corp',u from unnest(array['owner','applicant','manager','ssc','ceo','other']) u;`)
    await acl.initSchema(pool)
    await service.initSchema(pool)
    const insert = async (room, nodes) => {
      for (const n of nodes)
        await pool.query(
          'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5)',
          [room, n.uid, n.parent_uid, n.position, n.data]
        )
    }
    for (const room of ['contracts', 'channels', 'hidden', 'personal']) {
      const owner = room === 'personal' ? 'applicant' : 'owner'
      await pool.query(
        'insert into rooms(room_key,owner_id,title) values($1,$2,$1)',
        [room, owner]
      )
      await acl.ensureOwner(pool, room, owner)
      if (['contracts', 'channels'].includes(room))
        await acl.setMember(pool, room, 'applicant', 'viewer', 'owner')
    }
    const contract = fixture(),
      channel = fixture('channel'),
      hidden = fixture('contract', 'hidden'),
      source = { roomKey: 'contracts', nodeUid: contract.root }
    await insert('contracts', contract.nodes)
    await insert('channels', channel.nodes)
    await insert('hidden', hidden.nodes)
    await insert('personal', [
      {
        uid: 'application',
        parent_uid: null,
        position: 'A',
        data: { text: '我要签合同' }
      }
    ])
    let found = await service.resolve(pool, who('applicant'), '我要签合同')
    check(
      found.candidates.length,
      1,
      'hidden templates must not appear in discovery'
    )
    check(
      found.candidates[0].source,
      source,
      'template discovery does not require a fixed directory'
    )
    check(
      (await service.resolve(pool, who('applicant'), '我要取消签合同'))
        .candidates.length,
      0
    )
    check(
      (await service.resolve(pool, who('applicant'), '我要请一个不存在的流程'))
        .candidates.length,
      0
    )
    const alternate = fixture('contract', 'alternate')
    await insert('channels', alternate.nodes)
    check(
      (await service.resolve(pool, who('applicant'), '我要签合同')).candidates
        .length,
      2,
      'ambiguous templates are returned together, never silently chosen'
    )
    let r = await service.prepare(pool, who('applicant'), {
      roomKey: 'personal',
      nodeUid: 'application',
      source
    })
    check(r.template.kind, 'generic')
    check(r.template.fields.length, 7)
    check(
      r.template.steps.map(s => s.role),
      ['法务审核', '财务审核']
    )
    await rejects(
      () =>
        service.prepare(pool, who('applicant'), {
          roomKey: 'contracts',
          nodeUid: contract.root,
          source
        }),
      'FORBIDDEN'
    )
    await rejects(
      () =>
        service.prepare(pool, who('owner'), {
          roomKey: 'contracts',
          nodeUid: contract.root,
          source
        }),
      'TEMPLATE_AS_REQUEST'
    )
    await rejects(
      () =>
        service.prepare(pool, who('applicant'), {
          roomKey: 'personal',
          nodeUid: 'application',
          source: { roomKey: 'channels', nodeUid: channel.root }
        }),
      'FLOW_CONFLICT'
    )
    check(
      (await service.notices(pool, who('manager'))).unread,
      0,
      'drafts do not notify'
    )
    const writer = async (room, cmd) => {
      const p = cmd.payload
      if (cmd.type === 'node.insert')
        await pool.query(
          'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5) on conflict do nothing',
          [room, p.uid, p.parentUid, 'A', { text: p.text, ...p.data }]
        )
      else
        await pool.query(
          'update room_nodes set data=data||$3::jsonb where room_key=$1 and uid=$2',
          [room, p.uid, p.patch]
        )
    }
    await service.project(pool, writer, r.id)
    check(
      (await service.subtree(pool, 'personal', 'application')).some(
        n => n.data.text === '请假类型'
      ),
      false,
      'generic requests must not inherit leave-only fields'
    )
    const values = {
      合作方: '测试合作方A',
      合同金额: '12000',
      品牌: '测试品牌A',
      生效日期: '2026-10-26',
      业务联系人: '账号：manager'
    }
    for (const f of r.template.fields)
      if (values[f.label])
        await pool.query(
          "update room_nodes set data=jsonb_build_object('text',$2::text) where room_key='personal' and uid=$1",
          [core.projectionId(r.id + ':value:' + f.key), values[f.label]]
        )
    const file = r.template.fields.find(f => f.type === 'attachment'),
      fileNode = core.projectionId(r.id + ':field:' + file.key)
    await insert('personal', [
      {
        uid: 'contract-proof-node',
        parent_uid: fileNode,
        position: 'A',
        data: { text: '测试合同.pdf', attachmentId: 'contract-proof' }
      }
    ])
    await pool.query(
      "insert into node_attachments values('contract-proof','personal','contract-proof-node','hash-one','测试合同.pdf','ready','测试证据')"
    )
    r = await service.mutate(pool, who('applicant'), r.id, 'import', body(r))
    check(r.report.blockers, [])
    check(
      r.report.hours,
      null,
      'generic workflows do not calculate leave hours'
    )
    check(r.report.configurationRequired, [])
    check(
      r.fields[r.template.fields.find(f => f.type === 'member').key],
      'manager'
    )
    check(
      r.report.attachments.map(a => a.id),
      ['contract-proof']
    )
    check(r.fields[file.key], ['contract-proof'])
    await rejects(
      () =>
        service.mutate(
          pool,
          who('applicant'),
          r.id,
          'submit',
          body(r, {
            nodeSource: true,
            expectedNodeHash: r.report.nodeInputHash,
            confirmSubmission: true
          })
        ),
      'APPLICATION_INCOMPLETE'
    )
    const tpl = await service.template(pool, who('owner'), source)
    await rejects(
      () =>
        service.publish(pool, who('applicant'), {
          source,
          expectedFingerprint: tpl.fingerprint,
          operationId: randomUUID()
        }),
      'FORBIDDEN'
    )
    await service.publish(pool, who('owner'), {
      source,
      expectedFingerprint: tpl.fingerprint,
      operationId: randomUUID()
    })
    r = await service.mutate(pool, who('applicant'), r.id, 'import', body(r))
    const amount = r.template.fields.find(f => f.label === '合同金额'),
      brand = r.template.fields.find(f => f.type === 'enum'),
      date = r.template.fields.find(f => f.type === 'date')
    check(
      workflow
        .evaluate(r.template, { ...r.fields, [amount.key]: '-1' })
        .blockers.some(s => s.includes('不能小于')),
      true
    )
    check(
      workflow
        .evaluate(r.template, { ...r.fields, [brand.key]: '不存在' })
        .blockers.some(s => s.includes('选项')),
      true
    )
    check(
      workflow
        .evaluate(r.template, { ...r.fields, [date.key]: '2026-02-31' })
        .blockers.some(s => s.includes('无效')),
      true
    )
    const submission = body(r, {
      nodeSource: true,
      expectedNodeHash: r.report.nodeInputHash,
      confirmSubmission: true
    })
    r = await service.mutate(pool, who('applicant'), r.id, 'submit', submission)
    check(r.status, 'pending')
    check(r.steps[0].assigneeId, 'manager')
    check((await service.notices(pool, who('manager'))).unread, 1)
    check(
      (await service.mutate(pool, who('applicant'), r.id, 'submit', submission))
        .duplicate,
      true
    )
    await rejects(
      () =>
        service.mutate(
          pool,
          { authUser: { id: 'manager', mcp: true } },
          r.id,
          'decide',
          body(r, { decision: 'approve', reason: 'MCP不能代批' })
        ),
      'HUMAN_DECISION_REQUIRED'
    )
    await rejects(() => service.get(pool, who('other'), r.id), 'NOT_FOUND')
    r = await service.mutate(
      pool,
      who('manager'),
      r.id,
      'decide',
      body(r, {
        decision: 'approve',
        reason: '测试：合同主体金额附件已核对',
        checkedCriteria: r.steps[0].criteria.map(c => c.uid)
      })
    )
    check(r.current_step, 1)
    check(
      (await service.notices(pool, who('ceo'))).unread,
      0,
      'CC is sent only after final approval'
    )
    r = await service.mutate(
      pool,
      who('ssc'),
      r.id,
      'decide',
      body(r, {
        decision: 'approve',
        reason: '测试：业务要点核对完成',
        checkedCriteria: r.steps[1].criteria.map(c => c.uid)
      })
    )
    check(r.status, 'approved')
    check((await service.notices(pool, who('ceo'))).unread, 1)
    check(
      (await service.get(pool, who('applicant'), r.id)).history.filter(
        e => e.action === 'decide'
      ).length,
      2
    )
    check(
      (await service.list(pool, who('manager'), { scope: 'history' })).list[0]
        .title,
      '合同签约审批'
    )
    await service.project(pool, writer, r.id)
    check(
      (await service.subtree(pool, 'personal', 'application')).some(
        n => n.data.text === '合同签约审批：已通过'
      ),
      true
    )
    await rejects(
      () =>
        service.prepare(pool, who('applicant'), {
          roomKey: 'personal',
          nodeUid: 'application',
          source
        }),
      'ANCHOR_USED'
    )
    await insert('personal', [
      {
        uid: 'prefilled',
        parent_uid: null,
        position: 'B',
        data: { text: '我要签合同' }
      },
      {
        uid: 'prefilled-partner',
        parent_uid: 'prefilled',
        position: 'A',
        data: { text: '合作方：已有合作方' }
      }
    ])
    let pre = await service.prepare(pool, who('applicant'), {
      roomKey: 'personal',
      nodeUid: 'prefilled',
      source
    })
    const partner = pre.template.fields.find(f => f.label === '合作方')
    check(
      pre.fields[partner.key],
      '已有合作方',
      'direct prefilled nodes are imported'
    )
    await service.project(pool, writer, pre.id)
    check(
      (await service.subtree(pool, 'personal', 'prefilled')).some(
        n => n.data.text === '申请资料'
      ),
      false,
      'projection preserves direct field layout'
    )
    const amountDef = pre.template.fields.find(f => f.label === '合同金额')
    await pool.query(
      "update room_nodes set data=jsonb_build_object('text','120') where room_key='personal' and uid=$1",
      [core.projectionId(pre.id + ':value:' + amountDef.key)]
    )
    pre = await service.mutate(
      pool,
      who('applicant'),
      pre.id,
      'import',
      body(pre)
    )
    await pool.query(
      "update room_nodes set data=jsonb_build_object('text','合同预算〔必填〕') where room_key='contracts' and uid=$1",
      [amountDef.uid]
    )
    pre = await service.mutate(
      pool,
      who('applicant'),
      pre.id,
      'import',
      body(pre)
    )
    check(
      pre.fields[amountDef.key],
      '120',
      'a generated field keeps its identity and value when the template label changes'
    )
    await service.project(pool, writer, pre.id)
    check(
      (await service.subtree(pool, 'personal', 'prefilled')).some(
        n => n.uid === amountDef.instanceUid && n.data.text === '合同预算'
      ),
      true,
      'generated headings track the template without overwriting values'
    )
    const changed = fixture('channel', 'new-location')
    await insert('channels', [
      {
        uid: 'department',
        parent_uid: null,
        position: 'B',
        data: { text: '任意部门SOP' }
      }
    ])
    changed.nodes[0].parent_uid = 'department'
    await insert('channels', changed.nodes)
    check(
      (await service.catalog(pool, who('applicant'))).list.some(
        t => t.source.nodeUid === changed.root
      ),
      true,
      'new templates in a new location are discovered without a code change or restart'
    )
    const broken = structuredClone(channel.nodes)
    broken.push({
      uid: 'parallel',
      parent_uid: channel.root,
      position: 'Z',
      data: { text: '并行会签' }
    })
    check(
      workflow
        .compile(broken, channel.root)
        .configurationErrors.some(s => s.includes('顺序审批')),
      true,
      'unsupported routing is blocked, not flattened'
    )
    const nested = structuredClone(channel.nodes),
      nestedFlow = nested.find(n => n.data.text === '审批流程')
    nested.push({
      uid: 'nested-parallel',
      parent_uid: nestedFlow.uid,
      position: 'Z',
      data: { text: '条件分支' }
    })
    check(
      workflow
        .compile(nested, channel.root)
        .configurationErrors.some(s => s.includes('顺序审批')),
      true
    )
    await pool.query(
      "delete from room_nodes where room_key='channels' and data->>'text'='账号：manager'"
    )
    const unconfigured = await service.template(pool, who('owner'), {
      roomKey: 'channels',
      nodeUid: channel.root
    })
    await rejects(
      () =>
        service.publish(pool, who('owner'), {
          source: unconfigured.source,
          expectedFingerprint: unconfigured.fingerprint,
          operationId: randomUUID()
        }),
      'POLICY_INCOMPLETE'
    )
    for (let i = 0; i < 55; i++)
      await insert('channels', [
        {
          uid: 'extra-' + i,
          parent_uid: null,
          position: 'Z',
          data: { text: '分页流程' + i }
        },
        {
          uid: 'extra-marker-' + i,
          parent_uid: 'extra-' + i,
          position: 'A',
          data: { text: '流程标识：分页测试' + i }
        }
      ])
    const shortPage = await service.catalog(pool, who('applicant'), {
      limit: 20
    })
    check(
      shortPage.list.length <= 20,
      true,
      'MCP catalog uses a small output budget'
    )
    check(shortPage.hasMore, true)
    const first = await service.catalog(pool, who('applicant'))
    check(first.hasMore, true)
    const second = await service.catalog(pool, who('applicant'), {
      cursor: first.nextCursor
    })
    check(second.hasMore, false)
    check(
      new Set(
        [...first.list, ...second.list].map(
          t => t.source.roomKey + ':' + t.source.nodeUid
        )
      ).size,
      first.list.length + second.list.length
    )
    check(
      (
        await service.resolve(pool, who('applicant'), '我要分页测试54')
      ).candidates.some(t => t.title === '分页流程54'),
      true,
      'resolution follows all catalog pages'
    )
    await rejects(
      () => service.catalog(pool, who('applicant'), { cursor: 'invalid' }),
      'INVALID_CURSOR'
    )
    console.log(
      JSON.stringify({
        ok: true,
        assertions: count,
        schemaIsolation: true,
        tests: [
          'distributed discovery',
          'ACL',
          'ambiguous routing',
          'dynamic fields',
          'attachments',
          'member lookup',
          'validation',
          'publication',
          'human approvals',
          'CC and history',
          'new templates without code changes',
          'catalog pages',
          'unsupported flow rejection'
        ]
      })
    )
  } finally {
    await pool.end()
    await admin.query('drop schema if exists ' + schema + ' cascade')
    await admin.end()
  }
}
main().catch(e => {
  console.error(e.stack || e)
  process.exitCode = 1
})
