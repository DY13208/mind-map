const { randomUUID } = require('crypto')
const acl = require('../roomAcl')
const events = require('../accessRequestEvents')
const core = require('./core')
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SOURCE = {
  roomKey: process.env.WCPD_LEAVE_TEMPLATE_ROOM || 'room-yk3tz4aj',
  nodeUid:
    process.env.WCPD_LEAVE_TEMPLATE_NODE ||
    '1f580e83-3ced-43da-9f52-1e72f68992e0'
}
const fail = core.failure
async function transaction(pool, work) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const r = await work(db)
    await db.query('commit')
    return r
  } catch (e) {
    await db.query('rollback')
    throw e
  } finally {
    db.release()
  }
}
async function initSchema(db) {
  await db.query(`create table if not exists leave_requests (
    id uuid primary key, corp_id text not null, requester_id text not null, room_key text not null, node_uid text not null,
    source_room text not null, source_uid text not null, template jsonb not null, fields jsonb not null default '{}',
    report jsonb not null default '{}', steps jsonb not null default '[]', cc jsonb not null default '[]',
    status text not null default 'draft' check(status in ('draft','pending','returned','approved','rejected','withdrawn')),
    current_step integer not null default 0, revision integer not null default 1, round integer not null default 1,
    projection_pending boolean not null default true, projection_retry_at timestamptz not null default now(), projection_error text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create unique index if not exists leave_active_anchor on leave_requests(corp_id,requester_id,room_key,node_uid) where status in ('draft','pending','returned');
    create index if not exists leave_requester_idx on leave_requests(corp_id,requester_id,updated_at desc);
    create index if not exists leave_todo_idx on leave_requests(corp_id,(steps->current_step->>'assigneeId'),updated_at desc) where status='pending';
    create table if not exists leave_events (
      id bigserial primary key, request_id uuid not null references leave_requests(id), operation_id uuid not null,
      actor_id text not null, action text not null, payload_hash text not null, revision integer not null,
      detail jsonb not null default '{}', created_at timestamptz not null default now(), unique(request_id,operation_id));
    create index if not exists leave_events_request_idx on leave_events(request_id,id);
    create index if not exists leave_events_actor_idx on leave_events(actor_id,request_id) where action='decide';
    create table if not exists leave_notifications (
      id uuid primary key, request_id uuid not null references leave_requests(id), recipient_id text not null,
      kind text not null, revision integer not null, seen_at timestamptz, created_at timestamptz not null default now(),
      unique(request_id,recipient_id,kind,revision));
    create index if not exists leave_notice_recipient_idx on leave_notifications(recipient_id,created_at desc);`)
  await db.query(`create table if not exists leave_policy_publications (
    id bigserial primary key, corp_id text not null, source_room text not null, source_uid text not null,
    fingerprint text not null, published_by text not null, operation_id uuid not null unique, created_at timestamptz not null default now());
    create index if not exists leave_policy_current_idx on leave_policy_publications(corp_id,source_room,source_uid,id desc);`)
}
async function identity(db, req, human = false) {
  const user = req.authUser
  if (!user || !user.id || user.service)
    throw fail(
      'PERSONAL_IDENTITY_REQUIRED',
      '请使用已登录的个人身份或个人MCP令牌，不能使用共享服务令牌',
      401
    )
  if (human && (user.mcp || req.verifiedMcpSource))
    throw fail(
      'HUMAN_DECISION_REQUIRED',
      '正式审批只能由当前审核人登录页面办理，AI/MCP不能代批',
      403
    )
  const {
    rows
  } = await db.query(
    'select user_id,corp_id,name,departments from wecom_users where user_id=$1',
    [acl.normalizeUserId(user.id)]
  )
  const who = rows[0]
  if (!who || !who.corp_id)
    throw fail('MEMBER_REQUIRED', '请先绑定有效的企业成员身份', 403)
  return who
}
async function subtree(db, roomKey, uid) {
  const { rows } = await db.query(
    `with recursive branch as (
    select uid,parent_uid,position,data,1 as depth,array[uid] as trail from room_nodes where room_key=$1 and uid=$2 and deleted_at is null
    union all select n.uid,n.parent_uid,n.position,n.data,b.depth+1,b.trail||n.uid from room_nodes n join branch b on n.parent_uid=b.uid
    where n.room_key=$1 and n.deleted_at is null and b.depth<20 and not n.uid=any(b.trail)
  ) select * from branch order by depth,position,uid limit 501`,
    [roomKey, uid]
  )
  if (!rows.length || rows.length > 500 || rows.some(n => n.depth >= 20))
    throw fail(
      'NODE_SCOPE_INVALID',
      '节点不存在或子树超过读取范围，请缩小范围',
      400
    )
  return rows
}
async function template(db, req, source = SOURCE, enforceAccess = true) {
  if (enforceAccess)
    await acl.assertRoomAccess(
      db,
      { ...req, forceAcl: true },
      source.roomKey,
      'view'
    )
  const nodes = await subtree(db, source.roomKey, source.nodeUid)
  return { ...core.compileTemplate(nodes, source.nodeUid), source }
}
async function publication(db, tpl, who) {
  const latest = (
    await db.query(
      'select fingerprint,published_by,created_at from leave_policy_publications where corp_id=$1 and source_room=$2 and source_uid=$3 order by id desc limit 1',
      [who.corp_id, tpl.source.roomKey, tpl.source.nodeUid]
    )
  ).rows[0]
  return {
    valid: !!latest && latest.fingerprint === tpl.fingerprint,
    ...(latest || {})
  }
}
async function publish(pool, req, body) {
  return transaction(pool, async db => {
    const who = await identity(db, req, true),
      tpl = await template(db, req)
    await acl.assertRoomAccess(
      db,
      { ...req, forceAcl: true },
      tpl.source.roomKey,
      'manage'
    )
    operation(body)
    if (body.expectedFingerprint !== tpl.fingerprint)
      throw fail('POLICY_CHANGED', '流程已变化，请重新读取再发布', 409)
    const structural = core
      .evaluate(tpl, {})
      .blockers.filter(x => x.startsWith('模板必要') || x === '审批步骤待配置')
    if (
      !tpl.calendar.periods.length ||
      tpl.steps.some(s => !s.criteria.length || !s.accounts.length) ||
      tpl.ccMissing.length ||
      structural.length
    )
      throw fail(
        'POLICY_INCOMPLETE',
        '请先在脑图补齐工作时间、各审核人账号、审核要点和抄送人员'
      )
    const ids = [...new Set([...tpl.steps.flatMap(s => s.accounts), ...tpl.cc])]
    const count = (
      await db.query(
        'select user_id from wecom_users where corp_id=$1 and user_id=any($2::text[])',
        [who.corp_id, ids]
      )
    ).rows.length
    if (count !== ids.length)
      throw fail('INVALID_MEMBERS', '流程包含未匹配的企业成员账号')
    const existing = (
      await db.query(
        'select * from leave_policy_publications where operation_id=$1',
        [body.operationId]
      )
    ).rows[0]
    if (existing) {
      if (
        existing.corp_id !== who.corp_id ||
        existing.published_by !== who.user_id ||
        existing.fingerprint !== tpl.fingerprint
      )
        throw fail('OPERATION_CONFLICT', '发布操作编号冲突', 409)
    } else
      await db.query(
        'insert into leave_policy_publications(corp_id,source_room,source_uid,fingerprint,published_by,operation_id) values($1,$2,$3,$4,$5,$6)',
        [
          who.corp_id,
          tpl.source.roomKey,
          tpl.source.nodeUid,
          tpl.fingerprint,
          who.user_id,
          body.operationId
        ]
      )
    return publication(db, tpl, who)
  })
}
function resolveAccounts(binding, who) {
  const departments = (Array.isArray(who.departments)
    ? who.departments
    : []
  ).map(x => String(x && typeof x === 'object' ? x.id : x))
  const departmentNodes = binding.bindingNodes.filter(n =>
    /^部门[:：]/.test(n.text)
  )
  if (!departmentNodes.length) return binding.accounts
  const matches = departmentNodes.filter(n =>
    departments.includes(n.text.replace(/^部门[:：]\s*/, '').trim())
  )
  return [
    ...new Set(
      binding.bindingNodes
        .filter(n => matches.some(m => n.parent_uid === m.uid))
        .map(n => n.account)
        .filter(Boolean)
    )
  ]
}
async function routing(db, tpl, who, fields = {}) {
  const missing = [],
    steps = []
  if (!tpl.steps.length) missing.push('审批步骤待配置')
  if (fields.replacementId === who.user_id)
    missing.push('工作替补人不能是申请人本人')
  for (const step of tpl.steps) {
    const ids = resolveAccounts(step, who)
    if (ids.length !== 1)
      missing.push(`${step.role}：${ids.length ? '匹配不唯一' : '待配置'}`)
    steps.push({
      role: step.role,
      uid: step.uid,
      assigneeId: ids.length === 1 ? ids[0] : '',
      criteria: step.criteria
    })
  }
  if (
    fields.leaveType === '长假' &&
    tpl.steps.some(s => s.criteria.some(c => /长假.*交接人同意/.test(c.text)))
  ) {
    steps.splice(1, 0, {
      role: '交接人确认',
      uid: 'handover',
      assigneeId: fields.replacementId || '',
      criteria: tpl.steps
        .flatMap(s => s.criteria)
        .filter(c => /长假.*交接人同意/.test(c.text))
    })
  }
  const cc = []
  for (const binding of tpl.ccBindings) {
    const ids = resolveAccounts(binding, who)
    if (!ids.length) missing.push(`抄送${binding.role}：待配置`)
    cc.push(...ids)
  }
  const ids = [
    ...new Set(
      [...steps.map(s => s.assigneeId), ...cc, fields.replacementId].filter(
        Boolean
      )
    )
  ]
  const users = ids.length
    ? (
        await db.query(
          'select user_id,name from wecom_users where corp_id=$1 and user_id=any($2::text[])',
          [who.corp_id, ids]
        )
      ).rows
    : []
  for (const id of ids)
    if (!users.some(u => u.user_id === id))
      missing.push(`账号${id}未匹配到同企业成员`)
  for (const s of steps) {
    s.assigneeName =
      (users.find(u => u.user_id === s.assigneeId) || {}).name || ''
    if (s.assigneeId === who.user_id)
      missing.push(`${s.role}与申请人相同，须在脑图配置其他审核人`)
  }
  return { steps, cc: [...new Set(cc)], missing }
}
function cleanFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw fail('INVALID_FIELDS', '申请字段无效')
  const out = {}
  for (const key of Object.values(core.FIELDS)) {
    if (key === 'attachmentIds') {
      if (
        fields[key] != null &&
        (!Array.isArray(fields[key]) ||
          fields[key].length > 10 ||
          fields[key].some(id => typeof id !== 'string' || id.length > 80))
      )
        throw fail('INVALID_ATTACHMENTS', '附件引用无效或超过10项')
      out[key] = fields[key] || []
    } else
      out[key] = String(fields[key] || '')
        .trim()
        .slice(0, key === 'reason' ? 3000 : 180)
  }
  return out
}
async function checkAttachments(db, row, fields) {
  const result = []
  for (const id of fields.attachmentIds || []) {
    const meta = (
      await db.query(
        'select node_uid,status,content_hash,file_name from node_attachments where room_key=$1 and id=$2',
        [row.room_key, id]
      )
    ).rows[0]
    if (!meta || meta.node_uid !== row.node_uid || meta.status !== 'ready')
      throw fail(
        'ATTACHMENT_NOT_BOUND',
        '附件必须绑定当前申请节点且可读取，不能引用其他申请的证明',
        403
      )
    result.push({ id, hash: meta.content_hash, fileName: meta.file_name })
  }
  return result
}
function canRead(row, who) {
  return (
    row.corp_id === who.corp_id &&
    (row.requester_id === who.user_id ||
      (!['draft', 'returned'].includes(row.status) &&
        row.steps.some(s => s.assigneeId === who.user_id)) ||
      (row.status === 'approved' && row.cc.includes(who.user_id)))
  )
}
async function request(db, id, who, lock = false, replayOperation) {
  if (!UUID.test(String(id))) throw fail('INVALID_ID', '申请编号无效')
  const row = (
    await db.query(
      `select * from leave_requests where id=$1${lock ? ' for update' : ''}`,
      [id]
    )
  ).rows[0]
  if (!row || !canRead(row, who)) {
    // An old reviewer may retry an already committed decision, without receiving newer materials.
    if (
      row &&
      row.corp_id === who.corp_id &&
      lock &&
      UUID.test(String(replayOperation || '')) &&
      (
        await db.query(
          'select 1 from leave_events where request_id=$1 and actor_id=$2 and operation_id=$3',
          [id, who.user_id, replayOperation]
        )
      ).rows.length
    )
      return { ...row, historicalReplay: true }
    throw fail('NOT_FOUND', '申请不存在或无权查看', 404)
  }
  return row
}
async function notify(db, row, recipients, kind) {
  for (const userId of [...new Set(recipients.filter(Boolean))])
    await db.query(
      `insert into leave_notifications(id,request_id,recipient_id,kind,revision) values($1,$2,$3,$4,$5) on conflict do nothing`,
      [randomUUID(), row.id, userId, kind, row.revision]
    )
  await events.publish(db, recipients)
}
function operation(body) {
  if (!UUID.test(String(body.operationId || '')))
    throw fail('OPERATION_REQUIRED', '缺少有效的幂等操作编号')
  return body.operationId
}
async function duplicate(db, row, who, action, body) {
  const op = operation(body),
    hash = core.digest({ actor: who.user_id, action, ...body })
  const existing = (
    await db.query(
      'select * from leave_events where request_id=$1 and operation_id=$2',
      [row.id, op]
    )
  ).rows[0]
  if (existing && existing.payload_hash !== hash)
    throw fail('OPERATION_CONFLICT', '同一操作编号不能用于不同内容', 409)
  return {
    op,
    hash,
    exists: !!existing,
    revision: existing && existing.revision
  }
}
async function event(db, row, who, action, replay, detail = {}) {
  await db.query(
    'insert into leave_events(request_id,operation_id,actor_id,action,payload_hash,revision,detail) values($1,$2,$3,$4,$5,$6,$7)',
    [
      row.id,
      replay.op,
      who.user_id,
      action,
      replay.hash,
      row.revision,
      JSON.stringify({ round: row.round, ...detail })
    ]
  )
}
async function update(db, row) {
  return (
    await db.query(
      `update leave_requests set fields=$2,template=$3,steps=$4,cc=$5,status=$6,current_step=$7,revision=$8,round=$9,report=$10,projection_pending=true,projection_retry_at=now(),updated_at=now() where id=$1 returning *`,
      [
        row.id,
        JSON.stringify(row.fields),
        JSON.stringify(row.template),
        JSON.stringify(row.steps),
        JSON.stringify(row.cc),
        row.status,
        row.current_step,
        row.revision,
        row.round,
        JSON.stringify(row.report)
      ]
    )
  ).rows[0]
}
function expectRevision(row, value) {
  if (Number(value) !== row.revision)
    throw fail('REVISION_CONFLICT', '申请已变化，请刷新后再操作', 409)
}
async function prepare(pool, req, body) {
  return transaction(pool, async db => {
    const who = await identity(db, req),
      room = String(body.roomKey || ''),
      node = String(body.nodeUid || '')
    if (!room || !node) throw fail('ANCHOR_REQUIRED', '请指定自己的申请节点')
    await acl.assertRoomAccess(db, { ...req, forceAcl: true }, room, 'edit')
    const tpl = await template(db, req)
    const anchor = await subtree(db, room, node)
    if (room === tpl.source.roomKey && anchor.some(n => n.uid === tpl.rootUid))
      throw fail('TEMPLATE_AS_REQUEST', '不能在制度模板或其祖先上发起申请')
    if (
      room === tpl.source.roomKey &&
      (await subtree(db, tpl.source.roomKey, tpl.rootUid)).some(
        n => n.uid === node
      )
    )
      throw fail(
        'TEMPLATE_AS_REQUEST',
        '请在自己的业务节点发起，不要在制度节点下登记真实申请'
      )
    const fields = cleanFields(core.extractFields(anchor, node)),
      route = await routing(db, tpl, who, fields)
    const report = {
      ...core.evaluate(tpl, fields),
      configurationRequired: route.missing,
      publication: await publication(db, tpl, who)
    }
    const id = randomUUID()
    const saved = await db.query(
      `insert into leave_requests(id,corp_id,requester_id,room_key,node_uid,source_room,source_uid,template,fields,report,steps,cc) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(corp_id,requester_id,room_key,node_uid) where status in ('draft','pending','returned') do nothing returning *`,
      [
        id,
        who.corp_id,
        who.user_id,
        room,
        node,
        tpl.source.roomKey,
        tpl.source.nodeUid,
        JSON.stringify(tpl),
        JSON.stringify(fields),
        JSON.stringify(report),
        JSON.stringify(route.steps),
        JSON.stringify(route.cc)
      ]
    )
    if (saved.rows.length) return saved.rows[0]
    return (
      await db.query(
        `select * from leave_requests where corp_id=$1 and requester_id=$2 and room_key=$3 and node_uid=$4 and status in ('draft','pending','returned')`,
        [who.corp_id, who.user_id, room, node]
      )
    ).rows[0]
  })
}
async function get(pool, req, id, options = {}) {
  const who = await identity(pool, req)
  let row,
    historical = false
  try {
    row = await request(pool, id, who)
  } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e
    const decision = (
      await pool.query(
        "select e.detail from leave_events e join leave_requests r on r.id=e.request_id where e.request_id=$1 and e.actor_id=$2 and r.corp_id=$3 and e.action='decide' order by e.id desc limit 1",
        [id, who.user_id, who.corp_id]
      )
    ).rows[0]
    if (!decision) throw e
    const submitted = (
      await pool.query(
        "select detail from leave_events where request_id=$1 and action='submit' and detail->>'round'=$2 order by id desc limit 1",
        [id, String(decision.detail.round)]
      )
    ).rows[0]
    if (!submitted || !submitted.detail.snapshot) throw e
    row = {
      ...submitted.detail.snapshot,
      id,
      historical: true,
      status: 'historical',
      round: decision.detail.round,
      current_step: decision.detail.step,
      requester_id: '',
      revision: 0
    }
    historical = true
  }
  const before = /^\d+$/.test(String(options.before || ''))
    ? String(options.before)
    : null
  let history = (
    await pool.query(
      "select id,actor_id,action,revision,detail,created_at from leave_events where request_id=$1 and ($2::bigint is null or id<$2) and ($3::text is null or detail->>'round'=$3) order by id desc limit 51",
      [id, before, historical ? String(row.round) : null]
    )
  ).rows
  const historyHasMore = history.length > 50
  history = history.slice(0, 50).reverse()
  // Submission snapshots stay in the audit store, not in every client response.
  history = history.map(e => {
    const { snapshot, ...detail } = e.detail
    return { ...e, detail }
  })
  const attachmentEvidence =
    row.fields.attachmentIds && row.fields.attachmentIds.length
      ? (
          await pool.query(
            'select id,content_hash,file_name,left(extracted_text,1600) as text,length(extracted_text) as total_chars from node_attachments where room_key=$1 and id=any($2::text[]) limit 10',
            [row.room_key, row.fields.attachmentIds]
          )
        ).rows.map(a => {
          const bound = (row.report.attachments || []).find(
            item => item.id === a.id
          )
          const unchanged =
            ['draft', 'returned'].includes(row.status) ||
            (bound && bound.hash === a.content_hash)
          return {
            id: a.id,
            fileName: (bound && bound.fileName) || a.file_name,
            text: unchanged ? a.text || '' : '',
            complete: unchanged && Number(a.total_chars) <= 1600,
            readable: !!a.text && !!unchanged,
            changed: !unchanged
          }
        })
      : []
  return {
    ...row,
    history,
    historyHasMore,
    attachmentEvidence,
    canDecide:
      !historical &&
      !req.authUser.mcp &&
      !req.verifiedMcpSource &&
      row.status === 'pending' &&
      row.steps[row.current_step].assigneeId === who.user_id
  }
}
async function mutate(pool, req, id, action, body) {
  return transaction(pool, async db => {
    const who = await identity(db, req, action === 'decide'),
      row = await request(db, id, who, true, body.operationId)
    const replay = await duplicate(db, row, who, action, body)
    if (replay.exists)
      return row.historicalReplay
        ? { id: row.id, revision: replay.revision, duplicate: true }
        : { ...row, duplicate: true }
    expectRevision(row, body.expectedRevision)
    const owner = row.requester_id === who.user_id
    let detail = {}
    if (['save', 'import', 'submit', 'withdraw'].includes(action) && !owner)
      throw fail('REQUESTER_ONLY', '只有申请人可以修改或提交', 403)
    if (['save', 'import', 'submit'].includes(action)) {
      if (!['draft', 'returned'].includes(row.status))
        throw fail('LOCKED', '已提交材料不能直接修改；请先撤回或退回', 409)
      await acl.assertRoomAccess(
        db,
        { ...req, forceAcl: true },
        row.room_key,
        'edit'
      )
      row.template = await template(db, req, {
        roomKey: row.source_room,
        nodeUid: row.source_uid
      })
      if (action === 'import')
        row.fields = cleanFields(
          core.extractFields(
            await subtree(db, row.room_key, row.node_uid),
            row.node_uid
          )
        )
      else if (action === 'save') row.fields = cleanFields(body.fields)
      const route = await routing(db, row.template, who, row.fields)
      row.report = {
        ...core.evaluate(row.template, row.fields),
        configurationRequired: route.missing,
        attachments: await checkAttachments(db, row, row.fields),
        publication: await publication(db, row.template, who)
      }
      row.steps = route.steps
      row.cc = route.cc
      if (action === 'submit') {
        if (body.confirmSubmission !== true)
          throw fail('CONFIRM_REQUIRED', '请先核对本次材料后确认提交')
        const blocked = [...row.report.blockers, ...route.missing]
        if (!row.report.publication.valid)
          blocked.push('当前流程尚未由模板管理员发布，或修改后需要重新发布')
        if (blocked.length)
          throw fail('APPLICATION_INCOMPLETE', blocked.join('；'))
        row.status = 'pending'
        row.current_step = 0
        detail = {
          snapshot: {
            fields: row.fields,
            template: row.template,
            report: row.report,
            steps: row.steps,
            cc: row.cc,
            room_key: row.room_key,
            node_uid: row.node_uid
          }
        }
      }
    } else if (action === 'withdraw') {
      if (!['draft', 'pending', 'returned'].includes(row.status))
        throw fail('CLOSED', '已结束的申请不能撤回')
      row.status = 'withdrawn'
    } else if (action === 'decide') {
      if (row.status !== 'pending')
        throw fail('NOT_PENDING', '申请已经处理', 409)
      const step = row.steps[row.current_step]
      if (step.assigneeId !== who.user_id)
        throw fail('NOT_ASSIGNEE', '只有当前指定审核人可以办理', 403)
      if (
        !['approve', 'return', 'reject'].includes(body.decision) ||
        !String(body.reason || '').trim()
      )
        throw fail('DECISION_REQUIRED', '请选择决定并填写本次判断依据')
      if (body.decision === 'approve') {
        const currentTemplate = await template(
          db,
          req,
          row.template.source,
          false
        )
        if (currentTemplate.fingerprint !== row.template.fingerprint)
          throw fail(
            'POLICY_CHANGED',
            '制度或人员配置已变化，请退回申请重新读取和提交',
            409
          )
        const checked = new Set(
          Array.isArray(body.checkedCriteria) ? body.checkedCriteria : []
        )
        if (step.criteria.some(c => !checked.has(c.uid)))
          throw fail('CHECKS_REQUIRED', '请逐项核验当前步骤的审核要点')
        const attachments = await checkAttachments(db, row, row.fields)
        if (
          core.digest(attachments) !== core.digest(row.report.attachments || [])
        )
          throw fail(
            'MATERIAL_CHANGED',
            '证明附件已变化，请退回后重新提交',
            409
          )
      }
      const reason = String(body.reason)
        .trim()
        .slice(0, 3000)
      detail = {
        round: row.round,
        step: row.current_step,
        role: step.role,
        decision: body.decision,
        reason,
        checkedCriteria: body.checkedCriteria || []
      }
      step.decision = body.decision
      step.reason = reason
      step.decidedBy = who.user_id
      step.decidedAt = new Date().toISOString()
      if (body.decision === 'approve') {
        row.current_step++
        if (row.current_step === row.steps.length) row.status = 'approved'
      } else if (body.decision === 'return') {
        row.status = 'returned'
        row.round++
      } else row.status = 'rejected'
    } else if (action === 'analysis') {
      if (!['draft', 'returned', 'pending'].includes(row.status))
        throw fail('CLOSED', '申请已结束')
      const step = row.status === 'pending' ? row.current_step : 0
      const content = String(body.content || '').trim()
      if (!content || content.length > 10000)
        throw fail('ANALYSIS_LIMIT', '分析须为1到10000字')
      detail = {
        step,
        content,
        sourceFingerprint: row.template.fingerprint,
        label: 'AI辅助建议，非审批结论'
      }
      // Advisory events do not invalidate a material/decision revision.
      await event(db, row, who, action, replay, detail)
      return row
    } else throw fail('INVALID_ACTION', '操作无效')
    row.revision++
    const saved = await update(db, row)
    await event(db, saved, who, action, replay, detail)
    if (
      action === 'submit' ||
      (action === 'decide' && saved.status === 'pending')
    )
      await notify(
        db,
        saved,
        [saved.steps[saved.current_step].assigneeId],
        'todo'
      )
    if (action === 'decide' && saved.status !== 'pending')
      await notify(
        db,
        saved,
        [saved.requester_id, ...(saved.status === 'approved' ? saved.cc : [])],
        saved.status
      )
    if (action === 'withdraw')
      await notify(
        db,
        saved,
        saved.steps.map(s => s.assigneeId),
        'withdrawn'
      )
    return saved
  })
}
async function list(pool, req, filters = {}) {
  const who = await identity(pool, req),
    scope = ['todo', 'mine', 'history', 'cc'].includes(filters.scope)
      ? filters.scope
      : 'todo'
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 20)),
    offset = Math.min(10000, Math.max(0, Number(filters.offset) || 0))
  const condition = {
    todo: `r.status='pending' and r.steps->r.current_step->>'assigneeId'=$2`,
    mine: 'r.requester_id=$2',
    history: `exists(select 1 from leave_events e where e.request_id=r.id and e.actor_id=$2 and e.action='decide')`,
    cc: `r.status='approved' and r.cc ? $2`
  }[scope]
  const rows = (
    await pool.query(
      `select r.id,r.status,r.revision,r.round,r.current_step,r.steps,r.created_at,r.updated_at,coalesce(u.name,r.requester_id) requester_name from leave_requests r left join wecom_users u on u.user_id=r.requester_id and u.corp_id=r.corp_id where r.corp_id=$1 and ${condition} order by r.updated_at desc,r.id limit $3 offset $4`,
      [who.corp_id, who.user_id, limit, offset]
    )
  ).rows
  const total = Number(
    (
      await pool.query(
        `select count(*)::int total from leave_requests r where r.corp_id=$1 and ${condition}`,
        [who.corp_id, who.user_id]
      )
    ).rows[0].total
  )
  // Inbox cards do not need review text; former reviewers must not see later-round reasons.
  return {
    list: rows.map(row => ({
      ...row,
      steps: row.steps.map(s => ({ role: s.role }))
    })),
    total,
    limit,
    offset
  }
}
async function notices(pool, req, mark = false, seenIds = []) {
  const who = await identity(pool, req)
  if (mark) {
    if (
      !Array.isArray(seenIds) ||
      seenIds.length > 100 ||
      seenIds.some(id => !UUID.test(String(id)))
    )
      throw fail('INVALID_NOTICES', '通知编号无效')
    await pool.query(
      'update leave_notifications n set seen_at=now() from leave_requests r where n.request_id=r.id and r.corp_id=$2 and n.recipient_id=$1 and n.id=any($3::uuid[]) and n.seen_at is null',
      [who.user_id, who.corp_id, seenIds]
    )
  }
  const unread = Number(
    (
      await pool.query(
        'select count(*)::int total from leave_notifications n join leave_requests r on r.id=n.request_id where n.recipient_id=$1 and r.corp_id=$2 and n.seen_at is null',
        [who.user_id, who.corp_id]
      )
    ).rows[0].total
  )
  const list = (
    await pool.query(
      'select n.id,n.request_id,n.kind,n.revision,n.seen_at,n.created_at from leave_notifications n join leave_requests r on r.id=n.request_id where n.recipient_id=$1 and r.corp_id=$2 order by n.created_at desc,n.id limit 20',
      [who.user_id, who.corp_id]
    )
  ).rows
  return { unread, list }
}
async function attachment(pool, req, id, attachmentId) {
  const row = await get(pool, req, id)
  if (!(row.fields.attachmentIds || []).includes(attachmentId))
    throw fail('NOT_FOUND', '附件不属于当前申请', 404)
  const bound = (row.report.attachments || []).find(a => a.id === attachmentId)
  const meta = (
    await pool.query(
      'select content_hash from node_attachments where room_key=$1 and id=$2',
      [row.room_key, attachmentId]
    )
  ).rows[0]
  if (!meta) throw fail('NOT_FOUND', '附件已不存在', 404)
  if (
    !['draft', 'returned'].includes(row.status) &&
    (!bound || meta.content_hash !== bound.hash)
  )
    throw fail(
      'MATERIAL_CHANGED',
      '附件已变更，不能作为本轮提交的证明下载',
      409
    )
  const content = await require('../nodeKnowledge/store').getContentById(
    pool,
    row.room_key,
    attachmentId,
    { maxBytes: 20 * 1024 * 1024 }
  )
  if (
    content &&
    !['draft', 'returned'].includes(row.status) &&
    content.attachment.contentHash !== bound.hash
  )
    throw fail('MATERIAL_CHANGED', '附件已变更，请重新核验', 409)
  return content
}
async function project(pool, writer) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const pending = (
      await db.query(
        'select * from leave_requests where projection_pending and projection_retry_at<=now() order by projection_retry_at limit 5 for update skip locked'
      )
    ).rows
    for (const row of pending) {
      try {
        const anchor = (
          await db.query(
            'select uid from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
            [row.room_key, row.node_uid]
          )
        ).rows[0]
        if (!anchor) {
          await db.query(
            "update leave_requests set projection_pending=false,projection_error='申请入口已删除，审批记录仍保留' where id=$1",
            [row.id]
          )
          continue
        }
        const insert = async (uid, parentUid, text) => {
          if (
            (
              await db.query(
                'select uid from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
                [row.room_key, uid]
              )
            ).rows.length
          )
            return
          await writer(row.room_key, {
            operationId: core.projectionId(uid + ':insert'),
            mapId: row.room_key,
            actorId: 'leave-workflow',
            clientId: 'leave-workflow',
            baseVersion: null,
            type: 'node.insert',
            payload: { uid, parentUid, text }
          })
        }
        if (row.status === 'draft' || row.status === 'returned') {
          const existing = (
            await db.query(
              'select uid,data from room_nodes where room_key=$1 and parent_uid=$2 and deleted_at is null',
              [row.room_key, row.node_uid]
            )
          ).rows
          const group = existing.find(
            n => core.plain(n.data.text) === '申请资料'
          )
          const directFields = existing.some(
            n => core.FIELDS[core.label(n.data.text).split(/[:：]/)[0]]
          )
          const parent = group
            ? group.uid
            : directFields
            ? row.node_uid
            : core.projectionId(row.id + ':fields')
          if (!group && !directFields)
            await insert(parent, row.node_uid, '申请资料')
          const fieldRows = (
            await db.query(
              'select uid,data from room_nodes where room_key=$1 and parent_uid=$2 and deleted_at is null',
              [row.room_key, parent]
            )
          ).rows
          for (const f of row.template.fields)
            if (
              !fieldRows.some(
                n => core.label(n.data.text).split(/[:：]/)[0] === f.label
              )
            )
              await insert(
                core.projectionId(row.id + ':field:' + f.key),
                parent,
                f.label
              )
        }
        const uid = core.projectionId(row.id),
          exists = (
            await db.query(
              'select uid from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
              [row.room_key, uid]
            )
          ).rows.length
        const text = `请假申请：${core.statusText(row.status)}${
          row.status === 'pending'
            ? ' · ' + row.steps[row.current_step].role
            : ''
        }`
        // Reuse supported hyperlink fields so both Yjs and direct writers retain the entry.
        const entry = {
          hyperlink: `/?room=${encodeURIComponent(row.room_key)}&leaveRequest=${
            row.id
          }`,
          hyperlinkTitle: '查看请假申请与审批记录'
        }
        const command = {
          operationId: core.projectionId(row.id + ':' + row.revision),
          mapId: row.room_key,
          actorId: 'leave-workflow',
          clientId: 'leave-workflow',
          baseVersion: null,
          type: exists ? 'node.update' : 'node.insert',
          payload: exists
            ? { uid, patch: { text, ...entry } }
            : {
                uid,
                parentUid: row.node_uid,
                text,
                data: entry
              }
        }
        await writer(row.room_key, command)
        await db.query(
          "update leave_requests set projection_pending=false,projection_error='' where id=$1 and revision=$2",
          [row.id, row.revision]
        )
      } catch (e) {
        await db.query(
          "update leave_requests set projection_retry_at=now()+interval '1 minute',projection_error=$2 where id=$1",
          [row.id, String(e.message || '入口更新待重试').slice(0, 200)]
        )
      }
    }
    await db.query('commit')
  } catch (e) {
    await db.query('rollback')
    throw e
  } finally {
    db.release()
  }
}
module.exports = {
  SOURCE,
  initSchema,
  identity,
  subtree,
  template,
  routing,
  publication,
  publish,
  cleanFields,
  prepare,
  get,
  mutate,
  list,
  notices,
  attachment,
  project,
  transaction
}
