const assert = require('node:assert/strict')
process.env.WCPD_AI_REVIEW_ENABLED = '0'
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
let organizationServer
const body = (r, more = {}) => ({
  operationId: randomUUID(),
  expectedRevision: r.revision,
  ...more
})
async function main() {
  process.env.WCPD_AI_REVIEW_ENABLED = '0'
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
    const roles=require('../simple-mind-map/bin/leaveWorkflow/roleBindings')
    await pool.query("insert into workflow_role_bindings(corp_id,role,member_ids,source_names,updated_by) values('corp','测试单人角色',array['ceo'],array['测试经理'],'owner'),('corp','测试多人角色',array['manager','ssc','ceo','other'],array['甲','乙','丙','丁'],'owner'),('corp','测试缺失角色',array['missing'],array['缺失'],'owner')")
    check((await roles.resolve(pool,'corp','测试单人角色')).accounts,['ceo'],'registered single-role member is resolved')
    check((await roles.resolve(pool,'corp','测试多人角色')).accounts,['manager','ssc','ceo','other'],'all four group recipients are preserved')
    check(await roles.resolve(pool,'elsewhere','测试单人角色'),null,'role bindings are isolated by corporation')
    check(await roles.resolve(pool,'corp','未登记角色'),null)
    check((await roles.resolve(pool,'corp','测试缺失角色')).accounts,[],'missing role member blocks the full binding instead of silently dropping a recipient')
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
      'RULE_CONFIRMATION_REQUIRED'
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
    // Right-click workflows explicitly select a node with 提交要求, without
    // publishing it into the fuzzy template catalog or modifying the template.
    const automatic = fixture('channel', 'node-auto')
    automatic.nodes = automatic.nodes.filter(n => !/^流程标识/.test(n.data.text))
    automatic.nodes.find(n => n.data.text === '申请字段').data.text = '提交要求'
    automatic.nodes.find(n => n.parent_uid === automatic.root && n.data.text === '抄送').data.text = '抄送老板'
    automatic.nodes.push({ uid: 'auto-rule', parent_uid: automatic.root, position: 'Z', data: { text: '发起后全部流程默认同意' } })
    await insert('channels', automatic.nodes)
    await insert('personal', [{ uid: 'auto-application', parent_uid: null, position: 'B', data: { text: '本次渠道申请' } }])
    const autoSource = { roomKey: 'channels', nodeUid: automatic.root }
    const autoTemplate = await service.template(pool, who('owner'), autoSource)
    await service.publish(pool, who('owner'), { source: autoSource, expectedFingerprint: autoTemplate.fingerprint, operationId: randomUUID() })
    let autoRequest = await service.prepare(pool, who('applicant'), { roomKey: 'personal', nodeUid: 'auto-application', source: autoSource })
    check(autoRequest.report.configurationRequired, [], 'explicit auto-approval must not require human approvers')
    check(autoRequest.report.missing.length, 4, 'all submission requirements are required by default')
    await rejects(() => service.mutate(pool, who('applicant'), autoRequest.id, 'submit', body(autoRequest, { confirmSubmission: true, nodeSource: true, expectedNodeHash: autoRequest.report.nodeInputHash })), 'APPLICATION_INCOMPLETE')
    check((await pool.query('select count(*)::int n from leave_notifications where request_id=$1', [autoRequest.id])).rows[0].n, 0, 'incomplete applications never notify CC recipients')
    await service.project(pool, writer, autoRequest.id)
    const autoValues = { 渠道名称: '测试渠道', 申请措施: '调整', 预计日期: '2026-10-27', 库存及结款说明: '已填写完整' }
    for (const f of autoRequest.template.fields)
      await pool.query("update room_nodes set data=jsonb_build_object('text',$2::text) where room_key='personal' and uid=$1", [core.projectionId(autoRequest.id + ':value:' + f.key), autoValues[f.label]])
    autoRequest = await service.mutate(pool, who('applicant'), autoRequest.id, 'import', body(autoRequest))
    await rejects(() => service.mutate(pool, who('applicant'), autoRequest.id, 'submit', body(autoRequest, { nodeSource: true, expectedNodeHash: autoRequest.report.nodeInputHash })), 'CONFIRM_REQUIRED')
    const autoSubmit = body(autoRequest, { confirmSubmission: true, nodeSource: true, expectedNodeHash: autoRequest.report.nodeInputHash })
    autoRequest = await service.mutate(pool, who('applicant'), autoRequest.id, 'submit', autoSubmit)
    check(autoRequest.status, 'approved', 'the published node rule automatically completes after confirmed submission')
    check(autoRequest.steps, [], 'automatic approval must not forge human decisions')
    check((await service.get(pool, who('ceo'), autoRequest.id)).status, 'approved', 'configured CC recipient can read the final snapshot')
    check((await pool.query('select recipient_id,kind from leave_notifications where request_id=$1 order by recipient_id', [autoRequest.id])).rows, [{recipient_id:'applicant',kind:'approved'},{recipient_id:'ceo',kind:'approved'}])
    const autoHistory = (await service.get(pool, who('applicant'), autoRequest.id)).history
    check(autoHistory.find(e=>e.action==='submit').detail.automaticDecision.rule.uid, 'auto-rule', 'history records the published rule responsible for automatic agreement')
    await service.mutate(pool, who('applicant'), autoRequest.id, 'submit', autoSubmit)
    check((await pool.query('select count(*)::int n from leave_notifications where request_id=$1', [autoRequest.id])).rows[0].n, 2, 'replaying submit never duplicates result notifications')
    await rejects(() => service.prepare(pool, who('owner'), { roomKey:'channels',nodeUid:automatic.root,source:autoSource }), 'TEMPLATE_AS_REQUEST')
    const requirementsUid = automatic.nodes.find(n=>n.data.text==='提交要求').uid
    await insert('channels',[
      {uid:'source-score',parent_uid:requirementsUid,position:'ZZ',data:{text:'转正评分表'}},
      {uid:'source-score-wrapper',parent_uid:'source-score',position:'A',data:{text:'评分表附件'}},
      {uid:'source-score-file',parent_uid:'source-score-wrapper',position:'A',data:{text:'分支主题',attachmentId:'source-proof'}}
    ])
    await pool.query("insert into node_attachments values('source-proof','channels','source-score-file','source-hash','评分表.pdf','ready','评分记录')")
    const directTemplate = await service.template(pool,who('owner'),autoSource)
    await service.publish(pool,who('owner'),{source:autoSource,expectedFingerprint:directTemplate.fingerprint,operationId:randomUUID()})
    let directRequest = await service.prepare(pool, who('owner'), {
      roomKey:'channels', nodeUid:automatic.root, source:autoSource, useSourceNode:true
    })
    check(directRequest.template.sourceNodeInput, true)
    check(directRequest.report.missing.length, 4)
    const nodeCount = Number((await pool.query("select count(*) from room_nodes where room_key='channels'")).rows[0].count)
    await service.project(pool, writer, directRequest.id)
    check(Number((await pool.query("select count(*) from room_nodes where room_key='channels'")).rows[0].count), nodeCount, 'direct submission never creates application branches or projection nodes')
    for(const field of directRequest.template.fields.filter(f=>f.type!=='attachment')) await insert('channels', [
      {uid:'direct-wrapper-'+field.uid,parent_uid:field.uid,position:'Z',data:{text:field.type==='date'?'具体日期':'具体人员'}},
      {uid:'direct-value-'+field.uid,parent_uid:'direct-wrapper-'+field.uid,position:'A',data:{text:autoValues[field.label]}}
    ])
    directRequest = await service.mutate(pool,who('owner'),directRequest.id,'import',body(directRequest))
    check(directRequest.report.missing, [], 'original 提交要求 nested child values are read')
    check(directRequest.report.attachments.map(a=>a.id),['source-proof'],'original submission attachment is verified within the source field')
    check(directRequest.fields[directRequest.template.fields.find(f=>f.label==='渠道名称').key], '测试渠道')
    check(directRequest.report.publication.valid,true,'filling original form values does not invalidate published rules')
    directRequest = await service.mutate(pool,who('owner'),directRequest.id,'submit',body(directRequest,{confirmSubmission:true,nodeSource:true,expectedNodeHash:directRequest.report.nodeInputHash}))
    check(directRequest.status,'approved')
    await service.project(pool,writer,directRequest.id)
    check(Number((await pool.query("select count(*) from room_nodes where room_key='channels'")).rows[0].count),nodeCount+8,'completed direct flow also creates no branches')
    const again = await service.prepare(pool,who('owner'),{roomKey:'channels',nodeUid:automatic.root,source:autoSource,useSourceNode:true})
    check(again.status,'draft','a completed original-node request can be started again without making a new node')
    check(again.id !== directRequest.id,true,'the old approval history remains a separate immutable request')
    const named = fixture('channel','named-cc')
    named.nodes.find(n=>n.parent_uid===named.root && n.data.text==='抄送').data.text='抄送测试黄、测试李'
    named.nodes.push({uid:'named-auto',parent_uid:named.root,position:'Z',data:{text:'发起后全部流程默认同意'}})
    await insert('channels',named.nodes)
    await pool.query("update wecom_users set name=case user_id when 'ceo' then '测试黄' when 'ssc' then '测试李' else name end where user_id in ('ceo','ssc')")
    const namedSource={roomKey:'channels',nodeUid:named.root}
    const namedTemplate=await service.template(pool,who('owner'),namedSource)
    check(namedTemplate.cc,['ceo','ssc'],'explicit CC names resolve to unique same-corporation members without role configuration')
    check(namedTemplate.ccMissing,[])
    await service.publish(pool,who('owner'),{source:namedSource,expectedFingerprint:namedTemplate.fingerprint,operationId:randomUUID()})
    await pool.query("insert into wecom_users(user_id,wecom_userid,corp_id,name) values('duplicate-name','duplicate-name','corp','测试黄'),('other-corp-name','other-corp-name','elsewhere','测试李')")
    const ambiguous=await service.template(pool,who('owner'),namedSource)
    check(ambiguous.ccBindings.find(b=>b.role==='测试黄').resolutionError.includes('姓名重复'),true)
    check(ambiguous.ccBindings.find(b=>b.role==='测试李').accounts,['ssc'],'names in other corporations are never candidates')
    check((await service.publication(pool,ambiguous,{corp_id:'corp'})).valid,false,'changed recipient matching invalidates publication')
    let currentHrbp = {employee:'EMP-HR',name:'组织HRBP',wecomUserId:'org-hrbp-one',status:'Active'}
    let currentHead = {employee:'EMP-HEAD',name:'组织负责人',wecomUserId:'org-head-one',status:'Active'}
    organizationServer = require('node:http').createServer((req,res)=>{
      const url=new URL(req.url,'http://local')
      assert.equal(url.searchParams.get('employee_ref'),'测试员工')
      assert.equal(req.headers.authorization,'token orgapikey123:orgsecret123')
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify({message:{employee:'EMP-SUBJECT',department:'测试组织',company:'测试公司',hrbp:currentHrbp,head:currentHead}}))
    })
    await new Promise(resolve=>organizationServer.listen(0,'127.0.0.1',resolve))
    Object.assign(process.env,{HRMS_ORG_API_BASE:'http://127.0.0.1:'+organizationServer.address().port,HRMS_ORG_API_KEY:'orgapikey123',HRMS_ORG_API_SECRET:'orgsecret123',HRMS_ORG_COMPANY:'测试公司',HRMS_ORG_CORP_ID:'corp'})
    const headFixture=fixture('channel','org-head-reviewer')
    headFixture.nodes.find(n=>n.data.text==='渠道负责人').data.text='部门负责人'
    headFixture.nodes.find(n=>n.data.text==='渠道名称〔必填〕').data.text='员工'
    await insert('channels',headFixture.nodes)
    const headSource={roomKey:'channels',nodeUid:headFixture.root}
    const headTemplate=await service.template(pool,who('owner'),headSource)
    check(headTemplate.steps[0].dynamicRole,'head','reviewer department head is dynamically resolved, not a literal member name')
    check(headTemplate.steps[0].resolverConfigured,true)
    await service.publish(pool,who('owner'),{source:headSource,expectedFingerprint:headTemplate.fingerprint,operationId:randomUUID()})
    const employeeField=headTemplate.fields.find(f=>f.label==='员工')
    let headRoute=await service.routing(pool,headTemplate,{user_id:'owner',corp_id:'corp',departments:[]},{[employeeField.key]:'测试员工'})
    check(headRoute.steps[0].assigneeId,'org-head-one','reviewer uses the application employee organization head')
    check(headRoute.missing,[])
    currentHead=null
    headRoute=await service.routing(pool,headTemplate,{user_id:'owner',corp_id:'corp',departments:[]},{[employeeField.key]:'测试员工'})
    check(headRoute.steps[0].assigneeId,'','missing organization head cannot be guessed')
    check(headRoute.missing.some(x=>x.startsWith('部门负责人：')),true)
    currentHead={employee:'EMP-HEAD',name:'组织负责人',wecomUserId:'org-head-one',status:'Active'}
    await pool.query("insert into wecom_users(user_id,wecom_userid,corp_id,name) values('LiJiBing','LiJiBing','corp','李吉兵Elon🏹')")
    const organizationFlow=fixture('channel','org-routing')
    organizationFlow.nodes.find(n=>n.data.text==='申请字段').data.text='提交要求'
    organizationFlow.nodes.find(n=>n.data.text==='渠道名称〔必填〕').data.text='员工〔必填〕'
    organizationFlow.nodes.find(n=>n.parent_uid===organizationFlow.root&&n.data.text==='抄送').data.text='抄送对应hrbp、it'
    organizationFlow.nodes.push({uid:'org-auto',parent_uid:organizationFlow.root,position:'Z',data:{text:'发起后全部流程默认同意'}})
    await insert('channels',organizationFlow.nodes)
    const organizationSource={roomKey:'channels',nodeUid:organizationFlow.root}
    let organizationTemplate=await service.template(pool,who('owner'),organizationSource)
    check(organizationTemplate.ccMissing,[],'HRBP resolver and default IT need no manual role bindings')
    const subjectValues={员工:'测试员工',申请措施:'调整',预计日期:'2026-10-28',库存及结款说明:'已核对'}
    for(const f of organizationTemplate.fields) await insert('channels',[{uid:'org-input-'+f.uid,parent_uid:f.uid,position:'ZZ',data:{text:subjectValues[f.label]}}])
    organizationTemplate=await service.template(pool,who('owner'),organizationSource)
    await service.publish(pool,who('owner'),{source:organizationSource,expectedFingerprint:organizationTemplate.fingerprint,operationId:randomUUID()})
    let organizationRequest=await service.prepare(pool,who('owner'),{roomKey:'channels',nodeUid:organizationFlow.root,source:organizationSource,useSourceNode:true})
    check(organizationRequest.cc,['org-hrbp-one','LiJiBing'])
    check(organizationRequest.report.configurationRequired,[])
    check(organizationRequest.report.ccResolved[0].department,'测试组织')
    check((await pool.query("select name from wecom_users where corp_id='corp' and wecom_userid='org-hrbp-one'")).rows[0].name,'组织HRBP','HRMS canonical WeCom account is imported without guessing a name or user id')
    currentHrbp={...currentHrbp,wecomUserId:'org-hrbp-two',name:'新组织HRBP'}
    await rejects(()=>service.mutate(pool,who('owner'),organizationRequest.id,'submit',body(organizationRequest,{nodeSource:true,confirmSubmission:true,expectedNodeHash:organizationRequest.report.nodeInputHash})),'ROUTING_CHANGED')
    check((await pool.query('select count(*)::int n from leave_notifications where request_id=$1',[organizationRequest.id])).rows[0].n,0,'changed HRBP cannot silently receive an unreviewed submission')
    organizationRequest=await service.mutate(pool,who('owner'),organizationRequest.id,'import',body(organizationRequest))
    check(organizationRequest.cc,['org-hrbp-two','LiJiBing'])
    const sync=require('../simple-mind-map/bin/leaveWorkflow/hrmsSync')
    Object.assign(process.env,{HRMS_SYNC_ENABLED:'1',HRMS_SYNC_API_BASE:'http://127.0.0.1:9',HRMS_SYNC_API_KEY:'synckey123',HRMS_SYNC_API_SECRET:'syncsecret123',HRMS_SYNC_COMPANY:'测试公司',HRMS_SYNC_CORP_ID:'corp'})
    const proof=Buffer.from('immutable approval attachment')
    const proofHash=require('crypto').createHash('sha256').update(proof).digest('hex')
    const syncRow={...directRequest,template:{...directRequest.template,title:'转正申请表'},report:{attachments:[{id:'source-proof',hash:proofHash,fileName:'评分表.txt'}]}}
    await sync.enqueue(pool,{...syncRow,status:'draft'})
    await sync.enqueue(pool,{...syncRow,corp_id:'other-corp'})
    check(await sync.state(pool,syncRow.id,syncRow.round),null,'drafts and other-company approvals are not queued')
    const rolled=await pool.connect()
    try{await rolled.query('begin');await sync.enqueue(rolled,syncRow);await rolled.query('rollback')}finally{rolled.release()}
    check(await sync.state(pool,syncRow.id,syncRow.round),null,'queue rolls back atomically with approval transaction')
    await sync.enqueue(pool,syncRow);await sync.enqueue(pool,syncRow)
    check((await pool.query('select count(*)::int n from approval_hrms_sync')).rows[0].n,1,'duplicate completion queues one document')
    let delivered=0
    const transport=async(_url,options)=>{
      delivered++
      const data=JSON.parse(options.body).payload
      check(data.attachments[0].contentBase64,proof.toString('base64'),'actual immutable attachment bytes are sent')
      return {ok:true,json:async()=>({message:{sourceKey:`${data.requestId}:${data.round}`,name:'hrms-instance',applicationNo:'WCPD-TEST',status:'已通过'}})}
    }
    await sync.run(pool,{fetchImpl:transport,readAttachment:async()=>({attachment:{contentHash:proofHash},buffer:Buffer.from('changed')})})
    check((await sync.state(pool,syncRow.id,syncRow.round)).status,'failed','changed attachment blocks sync')
    check(delivered,0)
    await pool.query('update approval_hrms_sync set retry_at=now()')
    await sync.run(pool,{fetchImpl:async()=>{throw new Error('network unavailable')},readAttachment:async()=>({attachment:{contentHash:proofHash},buffer:proof})})
    check((await sync.state(pool,syncRow.id,syncRow.round)).status,'failed','network failure remains durable for retry')
    await pool.query('update approval_hrms_sync set retry_at=now()')
    await sync.run(pool,{fetchImpl:transport,readAttachment:async()=>({attachment:{contentHash:proofHash},buffer:proof})})
    check((await sync.state(pool,syncRow.id,syncRow.round)).result.name,'hrms-instance')
    await sync.run(pool,{fetchImpl:transport})
    check(delivered,1,'synced documents are not delivered again')
    check((await service.get(pool,who('owner'),syncRow.id)).hrmsSync.status,'synced','only authorized request reads expose sync status')
    const natural=require('./fixtures/natural-approval.cjs')('natural-db')
    await insert('channels',natural.nodes)
    const naturalSource={roomKey:'channels',nodeUid:natural.root}
    let nr=await service.prepare(pool,who('owner'),{roomKey:'channels',nodeUid:natural.root,source:naturalSource,useSourceNode:true})
    check(nr.template.autoApprove,false)
    check(nr.report.configurationRequired,[])
    check(nr.report.publication.valid,false)
    await rejects(()=>service.mutate(pool,who('owner'),nr.id,'submit',body(nr,{nodeSource:true,expectedNodeHash:nr.report.nodeInputHash,confirmSubmission:true})),'RULE_CONFIRMATION_REQUIRED')
    await rejects(()=>service.mutate(pool,who('owner'),nr.id,'submit',body(nr,{nodeSource:true,expectedNodeHash:nr.report.nodeInputHash,confirmSubmission:true,confirmRules:true,expectedPolicyFingerprint:'stale'})),'RULE_CONFIRMATION_REQUIRED')
    nr=await service.mutate(pool,who('owner'),nr.id,'submit',body(nr,{nodeSource:true,expectedNodeHash:nr.report.nodeInputHash,confirmSubmission:true,confirmRules:true,expectedPolicyFingerprint:nr.template.fingerprint}))
    check(nr.status,'pending','conditional default agreement waits for actual SSC')
    check(nr.steps[0].assigneeId,'ssc')
    check(nr.report.ruleConfirmation.confirmedBy,'owner')
    check(nr.report.publication.scope,'request')
    check((await pool.query('select count(*)::int n from leave_policy_publications where source_uid=$1',[natural.root])).rows[0].n,0,'execution confirmation does not globally publish a template')
    await rejects(()=>service.mutate(pool,who('ssc'),nr.id,'decide',body(nr,{decision:'approve',reason:'核对条件',checkedCriteria:[]})),'CHECKS_REQUIRED')
    nr=await service.mutate(pool,who('ssc'),nr.id,'decide',body(nr,{decision:'approve',reason:'已核对真实性及拒绝条件，未触发拒绝',checkedCriteria:nr.steps[0].criteria.map(c=>c.uid)}))
    check(nr.status,'approved')
    check((await service.get(pool,who('owner'),nr.id)).history.some(e=>e.action==='submit'&&e.detail.ruleConfirmation?.scope==='request'),true)
    const agentFixture=require('./fixtures/natural-approval.cjs')('agent-definition')
    await insert('channels',agentFixture.nodes)
    const agentSource={roomKey:'channels',nodeUid:agentFixture.root}
    let agentTpl=await service.template(pool,who('owner'),agentSource)
    const pub1=await service.publish(pool,who('owner'),{source:agentSource,expectedFingerprint:agentTpl.fingerprint,expectedContentFingerprint:agentTpl.contentFingerprint,agentMode:true,operationId:randomUUID()})
    check(pub1.state,'published')
    const agentWho={...who('owner'),authUser:{id:'owner',mcp:true}}
    const agentBody={roomKey:'channels',nodeUid:agentFixture.root,source:agentSource,useSourceNode:true,expectedDefinitionVersion:String(pub1.id)}
    await rejects(()=>service.prepare(pool,who('owner'),agentBody),'AGENT_EXECUTION_REQUIRED')
    await rejects(()=>service.prepare(pool,agentWho,{...agentBody,expectedDefinitionVersion:'stale'}),'DEFINITION_VERSION_CHANGED')
    let ar=await service.prepare(pool,agentWho,agentBody)
    check(ar.template.agentDefinition.version,String(pub1.id))
    const graphBeforeAgent=core.digest((await pool.query("select uid,parent_uid,position,data from room_nodes where room_key='channels' order by uid")).rows)
    let chat=await service.prepare(pool,agentWho,{source:agentSource,inputMode:'agent',expectedDefinitionVersion:String(pub1.id)})
    check(chat.input_mode,'agent')
    check(chat.template.agentInput,true)
    check(chat.id!==ar.id,true,'node and Agent inputs have independent active applications')
    check(chat.report.missing.includes('补贴金额'),true,'Agent does not borrow prefilled brain-map values')
    check(chat.fields[chat.template.fields.find(f=>f.label==='补贴金额').key],'')
    await service.initSchema(pool) // Repeated migrations must allow both active input modes.
    await rejects(()=>service.mutate(pool,agentWho,chat.id,'import',body(chat)),'INPUT_MODE_CONFLICT')
    await rejects(()=>service.mutate(pool,who('owner'),chat.id,'save',body(chat,{fields:{}})),'AGENT_EXECUTION_REQUIRED')
    await rejects(()=>service.mutate(pool,agentWho,chat.id,'save',body(chat,{fields:{未登记字段:'禁止'}})),'UNKNOWN_FIELD')
    await rejects(()=>service.prepare(pool,agentWho,{source:agentSource,inputMode:'agent',expectedDefinitionVersion:String(pub1.id),fields:{attachmentIds:['invented-file']}}),'ATTACHMENT_NOT_BOUND')
    const chatFields={'补贴月份':'2026-11','补贴金额':'123','申请说明':'Agent独立申请材料'}
    chat=await service.mutate(pool,agentWho,chat.id,'save',body(chat,{fields:chatFields}))
    check(chat.template.agentInput,true,'Agent material mode survives template refresh')
    check(chat.report.missing,[])
    check(chat.fields[chat.template.fields.find(f=>f.label==='补贴金额').key],'123')
    await rejects(()=>service.mutate(pool,agentWho,chat.id,'submit',body(chat,{expectedDefinitionVersion:String(pub1.id),expectedInputHash:chat.report.inputHash})),'CONFIRM_REQUIRED')
    await rejects(()=>service.mutate(pool,agentWho,chat.id,'submit',body(chat,{expectedDefinitionVersion:String(pub1.id),expectedInputHash:'stale',confirmSubmission:true})),'INPUT_DATA_CHANGED')
    await rejects(()=>service.mutate(pool,agentWho,chat.id,'submit',body(chat,{nodeSource:true,expectedDefinitionVersion:String(pub1.id),expectedInputHash:chat.report.inputHash,confirmSubmission:true})),'INPUT_MODE_CONFLICT')
    const chatSubmit=body(chat,{expectedDefinitionVersion:String(pub1.id),expectedInputHash:chat.report.inputHash,confirmSubmission:true})
    chat=await service.mutate(pool,agentWho,chat.id,'submit',chatSubmit)
    check(chat.status,'pending','Agent materials route to the actual human reviewer')
    check((await service.mutate(pool,agentWho,chat.id,'submit',chatSubmit)).duplicate,true)
    await service.project(pool,async()=>{throw Error('Agent materials must never write graph nodes')},chat.id)
    check(core.digest((await pool.query("select uid,parent_uid,position,data from room_nodes where room_key='channels' order by uid")).rows),graphBeforeAgent,'Agent preparation/save/submit/project never modify the graph')
    check((await service.get(pool,who('ssc'),chat.id)).fields[chat.template.fields.find(f=>f.label==='补贴金额').key],'123','reviewer sees the Agent snapshot')
    chat=await service.mutate(pool,who('ssc'),chat.id,'decide',body(chat,{decision:'approve',reason:'核对Agent申请材料与规则',checkedCriteria:chat.steps[0].criteria.map(c=>c.uid)}))
    check(chat.status,'approved')
    await service.project(pool,async()=>{throw Error('Completed Agent application must not write graph')},chat.id)
    let chatNext=await service.prepare(pool,agentWho,{source:agentSource,inputMode:'agent',expectedDefinitionVersion:String(pub1.id)})
    check(chatNext.id!==chat.id,true,'a completed Agent request does not prevent a new application')
    const material=agentFixture.nodes.find(n=>n.data.text==='55')
    await pool.query("update room_nodes set data=jsonb_build_object('text','66') where room_key='channels' and uid=$1",[material.uid])
    agentTpl=await service.template(pool,who('owner'),agentSource)
    check((await service.publication(pool,agentTpl,{corp_id:'corp'})).state,'published','editing application values does not edit published rules')
    await rejects(()=>service.mutate(pool,agentWho,ar.id,'submit',body(ar,{nodeSource:true,expectedNodeHash:ar.report.nodeInputHash,expectedDefinitionVersion:String(pub1.id),confirmSubmission:true})),'NODE_DATA_CHANGED')
    await pool.query("update room_nodes set data=jsonb_build_object('text','55') where room_key='channels' and uid=$1",[material.uid])
    const ruleNode=agentFixture.truth
    await pool.query("update room_nodes set data=jsonb_build_object('text','核对加班真实性') where room_key='channels' and uid=$1",[ruleNode])
    agentTpl=await service.template(pool,who('owner'),agentSource)
    check((await service.publication(pool,agentTpl,{corp_id:'corp'})).state,'draft','editing approval rules invalidates the published definition')
    await rejects(()=>service.mutate(pool,agentWho,chatNext.id,'save',body(chatNext,{fields:chatFields})),'DEFINITION_DRAFT')
    await rejects(()=>service.mutate(pool,agentWho,ar.id,'submit',body(ar,{nodeSource:true,expectedNodeHash:ar.report.nodeInputHash,expectedDefinitionVersion:String(pub1.id),confirmSubmission:true,confirmRules:true,expectedPolicyFingerprint:ar.template.fingerprint})),'DEFINITION_DRAFT')
    await pool.query("update room_nodes set data=jsonb_build_object('text','加班真实性') where room_key='channels' and uid=$1",[ruleNode])
    agentTpl=await service.template(pool,who('owner'),agentSource)
    check((await service.publication(pool,agentTpl,{corp_id:'corp'})).valid,false,'reverting content does not republish an invalidated definition')
    const pub2=await service.publish(pool,who('owner'),{source:agentSource,expectedFingerprint:agentTpl.fingerprint,expectedContentFingerprint:agentTpl.contentFingerprint,agentMode:true,operationId:randomUUID()})
    await rejects(()=>service.mutate(pool,agentWho,ar.id,'submit',body(ar,{nodeSource:true,expectedNodeHash:ar.report.nodeInputHash,expectedDefinitionVersion:String(pub1.id),confirmSubmission:true})),'DEFINITION_VERSION_CHANGED')
    ar=await service.prepare(pool,agentWho,{...agentBody,expectedDefinitionVersion:String(pub2.id)})
    check(ar.template.agentDefinition.version,String(pub2.id))
    ar=await service.mutate(pool,agentWho,ar.id,'submit',body(ar,{nodeSource:true,expectedNodeHash:ar.report.nodeInputHash,expectedDefinitionVersion:String(pub2.id),confirmSubmission:true}))
    check(ar.status,'pending','Agent routes unverifiable exceptions to the actual reviewer')
    check((await service.notices(pool,who('ssc'))).list.some(n=>n.request_id===ar.id&&n.kind==='todo'),true,'human handoff generates the actual reviewer inbox notification')
    check((await service.definitions(pool,who('owner'),'channels')).list.some(d=>d.nodeUid===agentFixture.root&&d.state==='published'),true)
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
    if(organizationServer){organizationServer.closeAllConnections();await new Promise(resolve=>organizationServer.close(resolve))}
    await pool.end()
    await admin.query('drop schema if exists ' + schema + ' cascade')
    await admin.end()
  }
}
main().catch(e => {
  console.error(e.stack || e)
  process.exitCode = 1
})
