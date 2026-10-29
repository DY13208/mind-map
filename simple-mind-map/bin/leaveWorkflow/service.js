const { randomUUID, createHash } = require('crypto')
const acl = require('../roomAcl')
const events = require('../accessRequestEvents')
const core = require('./core')
const workflow = require('./workflowCore')
const organization = require('./hrmsOrganization')
const aiReview = require('./aiReview')
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
    create index if not exists leave_anchor_all_idx on leave_requests(room_key,node_uid,created_at desc);
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
  await db.query(`alter table leave_requests add column if not exists input_mode text not null default 'node';
    create unique index if not exists leave_active_input_anchor on leave_requests(corp_id,requester_id,room_key,node_uid,input_mode) where status in ('draft','pending','returned');
    drop index if exists leave_active_anchor;`)
  await db.query(`create table if not exists leave_policy_publications (
    id bigserial primary key, corp_id text not null, source_room text not null, source_uid text not null,
    fingerprint text not null, published_by text not null, operation_id uuid not null unique, created_at timestamptz not null default now());
    create index if not exists leave_policy_current_idx on leave_policy_publications(corp_id,source_room,source_uid,id desc);`)
  await db.query(`alter table leave_policy_publications add column if not exists agent_mode boolean not null default false;
    alter table leave_policy_publications add column if not exists content_fingerprint text;
    alter table leave_policy_publications add column if not exists invalidated_at timestamptz;`)
  await db.query(
    "create index if not exists room_nodes_workflow_markers_idx on room_nodes(room_key,parent_uid,uid) where deleted_at is null and data->>'text' like '%流程标识%'"
  )
  await require('./hrmsSync').initSchema(db)
  await require('./roleBindings').initSchema(db)
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
  if (
    !source ||
    typeof source.roomKey !== 'string' ||
    typeof source.nodeUid !== 'string' ||
    !source.roomKey ||
    !source.nodeUid ||
    source.roomKey.length > 200 ||
    source.nodeUid.length > 200
  )
    throw fail('INVALID_SOURCE', '请明确指定审批模板所在房间和节点')
  if (enforceAccess)
    await acl.assertRoomAccess(
      db,
      { ...req, forceAcl: true },
      source.roomKey,
      'view'
    )
  const nodes = await subtree(db, source.roomKey, source.nodeUid)
  const kind =
    source.roomKey === SOURCE.roomKey && source.nodeUid === SOURCE.nodeUid
      ? 'leave'
      : 'generic'
  const compiled = workflow.compile(nodes, source.nodeUid, kind)
  // 角色节点存在但未绑定账号时也要进动态解析分支：
  // HRBP / 部门负责人走人事组织架构解析，IT 走默认账号兜底，其余角色走姓名精确匹配。
  // 之前要求 !bindingUid，会让「有节点但留空」的动态角色被跳过，发布时误判为未配置。
  const namedBindings = compiled.kind === 'generic'
    ? compiled.ccBindings.filter(binding => !binding.accounts.length)
    : []
  if (namedBindings.length) {
    const who = await identity(db, req)
    for (const binding of namedBindings) {
      const registered=await require('./roleBindings').resolve(db,who.corp_id,binding.role)
      if(registered){Object.assign(binding,registered);continue}
      const specialRole = organization.role(binding.role)
      if (specialRole === 'hrbp') {
        const cfg = organization.config()
        binding.dynamicRole = 'hrbp'
        binding.resolverConfigured = cfg.ready && cfg.corpId === who.corp_id
        binding.resolverSource = {base:cfg.base,company:cfg.company,corpId:cfg.corpId}
        if (!binding.resolverConfigured) binding.resolutionError = '对应HRBP：请先配置人事组织架构只读连接及企业范围'
        continue
      }
      if (specialRole === 'head') {
        const cfg = organization.config()
        binding.dynamicRole = 'head'
        binding.resolverConfigured = cfg.ready && cfg.corpId === who.corp_id
        binding.resolverSource = {base:cfg.base,company:cfg.company,corpId:cfg.corpId}
        if (!binding.resolverConfigured) binding.resolutionError = '部门负责人：请先配置人事组织架构只读连接及企业范围'
        continue
      }
      if (specialRole === 'it') {
        const account = process.env.WCPD_APPROVAL_IT_USER_ID || 'LiJiBing'
        const matches = (await db.query('select user_id from wecom_users where corp_id=$1 and wecom_userid=$2 limit 2',[who.corp_id,account])).rows
        binding.defaultRole = 'it'
        binding.accounts = matches.length === 1 ? [matches[0].user_id] : []
        if (!binding.accounts.length) binding.resolutionError = '抄送IT：默认李吉兵的企微账号尚未同步'
        continue
      }
      const matches = await require('./memberNames').findMembers(db,who.corp_id,binding.role)
      binding.nameReference = binding.role
      if (matches.length === 1) binding.accounts = [matches[0].user_id]
      else binding.resolutionError = matches.length
        ? `抄送${binding.role}：姓名重复，请绑定具体成员账号`
        : `抄送${binding.role}：未匹配到本企业成员，请同步通讯录；若为角色名称请绑定成员账号`
    }
    compiled.cc = [...new Set(compiled.ccBindings.flatMap(binding => binding.accounts))]
    compiled.ccMissing = compiled.ccBindings.filter(binding => !binding.accounts.length && !((binding.dynamicRole === 'hrbp' || binding.dynamicRole === 'head') && binding.resolverConfigured)).map(binding => binding.role)
    compiled.fingerprint = core.digest({
      definition: compiled.fingerprint,
      namedRecipients: namedBindings.map(binding => ({name:binding.role,accounts:binding.accounts,...(binding.dynamicRole ? {resolver:binding.resolverSource} : {})}))
    })
  }
  const namedReviewers=compiled.kind==='generic'?compiled.steps.filter(step=>!step.accounts.length&&!step.bindingNodes.some(n=>/^部门[:：]/.test(n.text))):[]
  if(namedReviewers.length){
    const who=await identity(db,req)
    for(const step of namedReviewers){
      const specialRole=organization.role(step.role)
      if(specialRole==='head'||specialRole==='hrbp'){
        const cfg=organization.config()
        Object.assign(step,{dynamicRole:specialRole,resolverConfigured:cfg.ready&&cfg.corpId===who.corp_id,resolverSource:{base:cfg.base,company:cfg.company,corpId:cfg.corpId}})
        if(!step.resolverConfigured)step.resolutionError=`${step.role}：请先配置人事组织架构只读连接及企业范围`
        continue
      }
      const registered=await require('./roleBindings').resolve(db,who.corp_id,step.role)
      if(registered){
        if(registered.accounts.length===1)Object.assign(step,registered)
        else step.resolutionError=registered.resolutionError||`审核角色${step.role}包含多人，请明确审核人及审批规则，不能自动选择或代批`
        continue
      }
      const matches=await require('./memberNames').findMembers(db,who.corp_id,step.role)
      step.nameReference=step.role
      if(matches.length===1){step.accounts=[matches[0].user_id];step.resolvedName=matches[0].name}
      else step.resolutionError=matches.length?`审核人${step.role}：姓名匹配不唯一，请绑定具体成员账号`:`审核人${step.role}：未匹配到本企业成员，请填写准确姓名或成员账号`
    }
    compiled.fingerprint=core.digest({definition:compiled.fingerprint,namedReviewers:namedReviewers.map(step=>({name:step.role,accounts:step.accounts,...(step.dynamicRole?{resolver:step.resolverSource}:{} )}))})
  }
  // 规则指纹只覆盖「定义」：字段、审核要点、审批步骤、抄送配置。
  // 申请人填在字段节点下的值（以及挂在这些值节点上的附件）属于本次申请材料，
  // 换一次申请不等于换一套规则，不应让已发布版本失效。
  const fieldUids = new Set(
    (compiled.fields || []).map(field => field.instanceUid || field.uid).filter(Boolean)
  )
  const definitionNodes = rows => {
    if (!fieldUids.size) return rows
    const excluded = new Set()
    const walk = uid => {
      for (const child of rows.filter(n => n.parent_uid === uid)) {
        excluded.add(child.uid)
        walk(child.uid)
      }
    }
    for (const uid of fieldUids) walk(uid)
    return rows.filter(n => !excluded.has(n.uid))
  }
  const scoped = definitionNodes(nodes)
  return {
    ...compiled,
    contentFingerprint: core.digest({
      nodes: scoped.map(n=>({uid:n.uid,parent:n.parent_uid,position:n.position,data:require('../../src/utils/approvalDefinition').contentData(n.data)})).sort((a,b)=>a.uid.localeCompare(b.uid)),
      attachments: (await db.query('select id,node_uid,content_hash,file_name,status from node_attachments where room_key=$1 and node_uid=any($2::text[]) order by id',[source.roomKey,scoped.map(n=>n.uid)])).rows
    }),
    source: { roomKey: source.roomKey, nodeUid: source.nodeUid }
  }
}
async function publication(db, tpl, who) {
  const latest = (
    await db.query(
      'select id,fingerprint,published_by,created_at,agent_mode,content_fingerprint,invalidated_at from leave_policy_publications where corp_id=$1 and source_room=$2 and source_uid=$3 order by id desc limit 1',
      [who.corp_id, tpl.source.roomKey, tpl.source.nodeUid]
    )
  ).rows[0]
  if (latest && latest.agent_mode && !latest.invalidated_at && (latest.fingerprint !== tpl.fingerprint || latest.content_fingerprint !== tpl.contentFingerprint)) {
    await db.query('update leave_policy_publications set invalidated_at=now() where id=$1 and invalidated_at is null',[latest.id])
    latest.invalidated_at = new Date().toISOString()
  }
  const valid = !!latest && latest.fingerprint === tpl.fingerprint && (!latest.agent_mode || (!latest.invalidated_at && latest.content_fingerprint === tpl.contentFingerprint))
  return {...(latest || {}),valid,state:valid?'published':'draft'}
}
async function publish(pool, req, body) {
  return transaction(pool, async db => {
    const who = await identity(db, req, true),
      tpl = await template(db, req, body.source || SOURCE)
    await acl.assertRoomAccess(
      db,
      { ...req, forceAcl: true },
      tpl.source.roomKey,
      'manage'
    )
    operation(body)
    const previousPublication = await publication(db, tpl, who)
    if (previousPublication.agent_mode && body.agentMode !== true)
      throw fail('AGENT_PUBLISH_REQUIRED','此节点是 Agent 审批定义，请使用“发布这个审批流”重新发布',409)
    if (body.expectedFingerprint !== tpl.fingerprint)
      throw fail('POLICY_CHANGED', '流程已变化，请重新读取再发布', 409)
    if (body.agentMode === true && (tpl.kind !== 'generic' || body.expectedContentFingerprint !== tpl.contentFingerprint))
      throw fail('DEFINITION_CHANGED','节点内容已变化，请重新读取全部内容后发布',409)
    const structural = workflow
      .evaluate(tpl, {})
      .blockers.filter(x => x.startsWith('模板必要') || x === '审批步骤待配置')
    if (
      (tpl.kind !== 'generic' && !tpl.calendar.periods.length) ||
      (tpl.configurationErrors || []).length ||
      tpl.steps.some(s => !s.criteria.length || (!s.accounts.length && !(['head','hrbp'].includes(s.dynamicRole)&&s.resolverConfigured))) ||
      tpl.ccMissing.length ||
      structural.length
    )
      throw fail(
        'POLICY_INCOMPLETE',
        '请先在脑图补齐字段、审批步骤、审核人及审核要点；请假还须登记工作时间'
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
        existing.fingerprint !== tpl.fingerprint || existing.agent_mode !== (body.agentMode === true) ||
        (body.agentMode === true && existing.content_fingerprint !== tpl.contentFingerprint)
      )
        throw fail('OPERATION_CONFLICT', '发布操作编号冲突', 409)
    } else
      await db.query(
        'insert into leave_policy_publications(corp_id,source_room,source_uid,fingerprint,published_by,operation_id,agent_mode,content_fingerprint) values($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          who.corp_id,
          tpl.source.roomKey,
          tpl.source.nodeUid,
          tpl.fingerprint,
          who.user_id,
          body.operationId,
          body.agentMode === true,
          body.agentMode === true ? tpl.contentFingerprint : null
        ]
      )
    return publication(db, tpl, who)
  })
}
async function definitions(db,req,room,after='') {
  const who=await identity(db,req)
  await acl.assertRoomAccess(db,{...req,forceAcl:true},room,'view')
  const candidates=(await db.query('select distinct source_uid from leave_policy_publications where corp_id=$1 and source_room=$2 and agent_mode and source_uid>$3 order by source_uid limit 21',[who.corp_id,room,after])).rows
  const list=[]
  for(const row of candidates.slice(0,20)) {
    try {
      const tpl=await template(db,req,{roomKey:room,nodeUid:row.source_uid},false)
      const pub=await publication(db,tpl,who)
      if(pub.agent_mode) list.push({nodeUid:row.source_uid,title:tpl.title,version:String(pub.id),state:pub.state})
    }catch(e){
      if (!['SUBMISSION_REQUIREMENTS_REQUIRED','TEMPLATE_NOT_FOUND','TEMPLATE_LIMIT','TEMPLATE_CYCLE','TEMPLATE_NOT_REGISTERED'].includes(e.code)) throw e
      await db.query('update leave_policy_publications set invalidated_at=coalesce(invalidated_at,now()) where corp_id=$1 and source_room=$2 and source_uid=$3 and agent_mode',[who.corp_id,room,row.source_uid])
      list.push({nodeUid:row.source_uid,state:'draft'})
    }
  }
  return {list,hasMore:candidates.length>20,nextCursor:candidates.length>20?candidates[19].source_uid:null}
}
async function invalidateDefinition(db,req,body) {
  const who=await identity(db,req)
  await acl.assertRoomAccess(db,{...req,forceAcl:true},body.roomKey,'edit')
  await db.query('update leave_policy_publications set invalidated_at=coalesce(invalidated_at,now()) where corp_id=$1 and source_room=$2 and source_uid=$3 and id::text=$4 and agent_mode',[who.corp_id,body.roomKey,body.nodeUid,String(body.version || '')])
  return {state:'draft'}
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
async function organizationMember(db,tpl,who,fields,dynamicRole){
  const field=(tpl.fields||[]).find(f=>/^(员工|员工姓名|员工编号|申请员工)$/.test(f.label))
  let employeeRef=field&&fields[field.key]
  if(field&&field.type==='member'&&employeeRef){
    const local=(await db.query('select wecom_userid from wecom_users where corp_id=$1 and user_id=$2',[who.corp_id,employeeRef])).rows[0]
    employeeRef=local&&local.wecom_userid
  }
  if(!employeeRef){const me=(await db.query('select wecom_userid from wecom_users where corp_id=$1 and user_id=$2',[who.corp_id,who.user_id])).rows[0];employeeRef=me&&me.wecom_userid}
  const assignment=dynamicRole==='head'?await organization.resolveDepartmentHead(employeeRef,who.corp_id):await organization.resolveHrbp(employeeRef,who.corp_id)
  const person=dynamicRole==='head'?assignment.head:assignment.hrbp
  let member=(await db.query('select user_id,name from wecom_users where corp_id=$1 and wecom_userid=$2',[who.corp_id,person.wecomUserId])).rows[0]
  if(!member){
    const occupied=(await db.query('select user_id from wecom_users where user_id=$1',[person.wecomUserId])).rows.length
    const id=occupied?'wecom:'+createHash('sha256').update(`${who.corp_id}:${person.wecomUserId}`).digest('hex').slice(0,48):person.wecomUserId
    await db.query('insert into wecom_users(user_id,wecom_userid,corp_id,name) values($1,$2,$3,$4) on conflict do nothing',[id,person.wecomUserId,who.corp_id,person.name])
    member=(await db.query('select user_id,name from wecom_users where corp_id=$1 and wecom_userid=$2',[who.corp_id,person.wecomUserId])).rows[0]
  }
  if(!member)throw new Error('人事组织账号映射冲突，请核对企业成员记录')
  return {account:member.user_id,name:member.name,source:'人事组织架构',employee:assignment.employee,department:assignment.department,company:assignment.company}
}
async function routing(db, tpl, who, fields = {}) {
  const missing = [],
    steps = []
  if (!tpl.steps.length && !tpl.autoApprove) missing.push('审批步骤待配置')
  missing.push(...(tpl.configurationErrors || []))
  const memberFields =
    tpl.kind === 'generic'
      ? tpl.fields.filter(f => f.type === 'member')
      : [{ key: 'replacementId', label: '工作替补人' }]
  for (const field of memberFields)
    if (fields[field.key]) {
      const input = fields[field.key]
      const exact = (
        await db.query(
          'select user_id,name from wecom_users where corp_id=$1 and user_id=$2',
          [who.corp_id, input]
        )
      ).rows
      const matches = exact.length
        ? exact
        : (
            await db.query(
              'select user_id,name from wecom_users where corp_id=$1 and name=$2 limit 2',
              [who.corp_id, input]
            )
          ).rows
      if (matches.length === 1) fields[field.key] = matches[0].user_id
      else
        missing.push(
          matches.length
            ? `${field.label}姓名重复，请填写账号：成员ID`
            : `${field.label}未匹配到本企业成员，请填写准确姓名或账号：成员ID`
        )
    }
  if (fields.replacementId === who.user_id)
    missing.push('工作替补人不能是申请人本人')
  for (const step of tpl.steps) {
    let ids = resolveAccounts(step, who)
    if(['head','hrbp'].includes(step.dynamicRole)){
      if(!step.resolverConfigured)missing.push(step.resolutionError||`${step.role}：人事组织解析尚未配置`)
      else try{ids=[(await organizationMember(db,tpl,who,fields,step.dynamicRole)).account]}catch(e){missing.push(`${step.role}：${e.message}`)}
    }
    if (ids.length !== 1)
      missing.push(step.resolutionError || `${step.role}：${ids.length ? '匹配不唯一' : '待配置'}`)
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
  const cc = [], resolved = []
  for (const binding of tpl.ccBindings) {
    if (binding.dynamicRole === 'hrbp' || binding.dynamicRole === 'head') {
      const isHead = binding.dynamicRole === 'head'
      if (!binding.resolverConfigured) { missing.push(binding.resolutionError); continue }
      try {
        const member=await organizationMember(db,tpl,who,fields,binding.dynamicRole)
        cc.push(member.account)
        resolved.push({role:binding.role,...member})
      } catch (e) {
        missing.push((isHead ? '部门负责人：' : '对应HRBP：')+(e.name === 'TimeoutError' ? '人事系统查询超时' : e.message))
      }
      continue
    }
    const ids = resolveAccounts(binding, who)
    if (!ids.length) missing.push(binding.resolutionError || `抄送${binding.role}：待配置`)
    cc.push(...ids)
  }
  const ids = [
    ...new Set(
      [
        ...steps.map(s => s.assigneeId),
        ...cc,
        ...memberFields.map(f => fields[f.key])
      ].filter(Boolean)
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
  for (const binding of tpl.ccBindings.filter(b => b.dynamicRole !== 'hrbp')) {
    for (const id of resolveAccounts(binding,who)) {
      const person = users.find(u => u.user_id === id)
      if (person) resolved.push({role:binding.role,account:id,name:person.name,source:binding.defaultRole === 'it' ? '默认IT' : '流程配置'})
    }
  }
  for (const s of steps) {
    s.assigneeName =
      (users.find(u => u.user_id === s.assigneeId) || {}).name || ''
    if (s.assigneeId === who.user_id)
      missing.push(`${s.role}与申请人相同，须在脑图配置其他审核人`)
  }
  return { steps, cc: [...new Set(cc)], missing, resolved }
}
function cleanFields(fields, tpl) {
  if (tpl && tpl.kind === 'generic') return cleanGenericFields(fields, tpl)
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
    } else {
      if (fields[key] != null && typeof fields[key] !== 'string')
        throw fail('INVALID_FIELDS', '申请字段必须是文本')
      const text = String(fields[key] || '').trim(),
        limit = key === 'reason' ? 3000 : 180
      if (text.length > limit)
        throw fail(
          'FIELD_TOO_LONG',
          `${Object.keys(core.FIELDS).find(
            label => core.FIELDS[label] === key
          )}超过${limit}字，请精简节点内容`
        )
      out[key] = text
    }
  }
  return out
}
function cleanGenericFields(fields, tpl) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw fail('INVALID_FIELDS', '申请资料无效')
  const allowed = new Set([...tpl.fields.map(f => f.key), 'attachmentIds'])
  if (Object.keys(fields).some(key => !allowed.has(key)))
    throw fail(
      'UNKNOWN_FIELD',
      '资料包含未在当前模板登记的字段，请重新读取模板'
    )
  const out = {}
  const ids = new Set()
  for (const f of [
    ...tpl.fields,
    { key: 'attachmentIds', label: '附件', type: 'attachment' }
  ]) {
    const value = fields[f.key]
    if (f.type === 'attachment') {
      if (
        value != null &&
        (!Array.isArray(value) ||
          value.length > 10 ||
          value.some(id => typeof id !== 'string' || id.length > 80))
      )
        throw fail('INVALID_ATTACHMENTS', '附件引用无效或超过10项')
      out[f.key] = [...new Set(value || [])].sort()
      out[f.key].forEach(id => ids.add(id))
    } else {
      if (value != null && typeof value !== 'string')
        throw fail('INVALID_FIELDS', `${f.label}须为文本`)
      const text = String(value || '').trim()
      if (text.length > 3000)
        throw fail('FIELD_TOO_LONG', `${f.label}超过3000字`)
      out[f.key] = text
    }
  }
  if (ids.size > 10) throw fail('INVALID_ATTACHMENTS', '证明附件合计超过10项')
  out.attachmentIds = [...ids].sort()
  return out
}
function cleanAgentFields(fields,tpl){
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw fail('INVALID_FIELDS','Agent申请资料须为字段对象')
  const normalized={}
  for(const [key,value] of Object.entries(fields)){
    const field=tpl.fields.find(f=>f.key===key||f.label===key)
    const target=field?field.key:key
    if(Object.prototype.hasOwnProperty.call(normalized,target))throw fail('DUPLICATE_FIELD','同一字段不能同时按名称和key重复填写')
    normalized[target]=value
  }
  return cleanFields(normalized,tpl)
}
function agentInputHash(tpl,fields,attachments){
  return core.digest({fields:cleanFields(fields,tpl),attachments:attachments.map(a=>[a.id,a.hash,a.fileName]).sort((a,b)=>a[0].localeCompare(b[0]))})
}
async function checkAttachments(db, row, fields) {
  const result = []
  const nodes = await subtree(db, row.room_key, row.node_uid)
  const bound = new Set([row.node_uid])
  // Only this application’s attachment branch, never an unrelated sibling request.
  const parents = new Set([
    row.node_uid,
    ...(row.template.sourceNodeInput || row.template.agentInput ? [row.template.requirementsNodeUid] : []),
    ...nodes
      .filter(
        n =>
          n.parent_uid === row.node_uid &&
          core.plain(n.data.text) === '申请资料'
      )
      .map(n => n.uid)
  ])
  const visit = uid => {
    bound.add(uid)
    nodes.filter(n => n.parent_uid === uid).forEach(n => visit(n.uid))
  }
  nodes
    .filter(
      n =>
        parents.has(n.parent_uid) &&
        (row.template.kind === 'generic'
          ? row.template.fields.some(
              f =>
                f.type === 'attachment' &&
                core.label(core.plain(n.data.text).split(/[:：]/)[0]) ===
                  f.label
            )
          : /^附件(?:[:：]|$)/.test(core.plain(n.data.text)))
    )
    .forEach(n => visit(n.uid))
  for (const id of fields.attachmentIds || []) {
    const meta = (
      await db.query(
        'select node_uid,status,content_hash,file_name from node_attachments where room_key=$1 and id=$2',
        [row.room_key, id]
      )
    ).rows[0]
    if (!meta || !bound.has(meta.node_uid) || meta.status !== 'ready')
      throw fail(
        'ATTACHMENT_NOT_BOUND',
        '附件必须绑定当前申请节点或其附件子节点且可读取，不能引用其他申请的证明',
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
function bindFields(tpl, id, sourceNodeInput = false) {
  return tpl.kind === 'generic'
    ? {
        ...tpl,
        sourceNodeInput,
        fields: tpl.fields.map(f => ({
          ...f,
          sourceInput: sourceNodeInput,
          instanceUid: sourceNodeInput ? f.uid : core.projectionId(id + ':field:' + f.key)
        }))
      }
    : tpl
}
async function prepare(pool, req, body) {
  return transaction(pool, async db => {
    const agentInput=body.inputMode==='agent'
    if(body.inputMode!=null&&!['node','agent'].includes(body.inputMode))throw fail('INVALID_INPUT_MODE','input_mode只能是node或agent')
    if(agentInput&&body.useSourceNode===true)throw fail('INPUT_MODE_CONFLICT','Agent材料不能同时读取脑图提交要求')
    if(!agentInput&&body.fields!==undefined)throw fail('INPUT_MODE_REQUIRED','直接传申请资料须选择input_mode=agent')
    const who = await identity(db, req),
      room = String(body.roomKey || (agentInput&&body.source?.roomKey) || ''),
      node = String(body.nodeUid || (agentInput&&body.source?.nodeUid) || '')
    if (!room || !node) throw fail('ANCHOR_REQUIRED', '请指定自己的申请节点')
    await acl.assertRoomAccess(db, { ...req, forceAcl: true }, room, agentInput?'view':'edit')
    const definition = await template(db, req, body.source || SOURCE)
    const definitionPublication = await publication(db, definition, who)
    if (definitionPublication.agent_mode) {
      if (!req.authUser.mcp && !req.verifiedMcpSource) throw fail('AGENT_EXECUTION_REQUIRED','已发布的审批节点请复制给 AI，通过个人 MCP 在 Agent 中执行',409)
      if (!definitionPublication.valid) throw fail('DEFINITION_DRAFT','节点内容已修改并恢复草稿，请重新发布后执行',409)
      if (String(body.expectedDefinitionVersion || '') !== String(definitionPublication.id)) throw fail('DEFINITION_VERSION_CHANGED','请核对当前已发布的审批版本后执行',409)
      if (!agentInput&&body.useSourceNode !== true) throw fail('SOURCE_INPUT_REQUIRED','请选择原节点材料或input_mode=agent对话材料入口',409)
    }
    if(agentInput&&(!definitionPublication.agent_mode||definition.kind!=='generic'||room!==definition.source.roomKey||node!==definition.rootUid))throw fail('AGENT_INPUT_REQUIRES_PUBLISHED_FLOW','Agent材料入口必须引用当前已发布审批节点',409)
    // One business application per node, across users and workflow types. This
    // prevents a new request from silently reusing an older request's field tree.
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      'workflow-anchor:' + room + ':' + node + ':' + (agentInput?'agent':'node')
    ])
    const previous = (
      await db.query(
        'select requester_id,corp_id,status from leave_requests where room_key=$1 and node_uid=$2 and input_mode=$3 order by created_at desc limit 1',
        [room, node,agentInput?'agent':'node']
      )
    ).rows[0]
    if (
      previous && !definitionPublication.agent_mode &&
      (previous.requester_id !== who.user_id ||
        previous.corp_id !== who.corp_id)
    )
      throw fail(
        'ANCHOR_IN_USE',
        '该节点已绑定申请，请在自己的独立子节点登记',
        409
      )
    const originalNodeEntry = (body.useSourceNode === true || agentInput) && body.source &&
      body.source.roomKey === room && body.source.nodeUid === node
    if (previous && !['draft', 'pending', 'returned'].includes(previous.status) && !originalNodeEntry)
      throw fail(
        'ANCHOR_USED',
        '该节点已是历史申请，请新增独立申请子节点，避免复用旧资料',
        409
      )
    const id = randomUUID()
    const direct = body.useSourceNode === true && definition.kind === 'generic' &&
      !!definition.requirementsNodeUid && room === definition.source.roomKey && node === definition.rootUid
    if (body.useSourceNode === true && !direct)
      throw fail('INVALID_SOURCE_INPUT', '原节点校验必须明确指定同一流程的提交要求')
    const tpl = {...bindFields(definition, id, direct),...(agentInput?{agentInput:true}:{}),...(definitionPublication.agent_mode ? {agentDefinition:{version:String(definitionPublication.id),contentFingerprint:definitionPublication.content_fingerprint}} : {})}
    const anchor = await subtree(db, room, node)
    const ancestors = (
      await db.query(
        `with recursive path as (select uid,parent_uid,1 depth from room_nodes where room_key=$1 and uid=$2 and deleted_at is null union all select n.uid,n.parent_uid,p.depth+1 from room_nodes n join path p on n.uid=p.parent_uid where n.room_key=$1 and n.deleted_at is null and p.depth<20) select m.data->>'text' text from path p join room_nodes m on m.room_key=$1 and m.parent_uid=p.uid and m.deleted_at is null and (m.data->>'text' like '%流程标识%' or m.data->>'text' like '%提交要求%')`,
        [room, node]
      )
    ).rows
    if (!direct && !agentInput && ancestors.some(n => workflow.marker(n.text) || core.label(n.text) === '提交要求'))
      throw fail(
        'TEMPLATE_AS_REQUEST',
        '不能在审批模板内登记真实申请，请使用自己的业务节点'
      )
    if (!direct && !agentInput && room === tpl.source.roomKey && anchor.some(n => n.uid === tpl.rootUid))
      throw fail('TEMPLATE_AS_REQUEST', '不能在制度模板或其祖先上发起申请')
    if (
      !direct && !agentInput && room === tpl.source.roomKey &&
      (await subtree(db, tpl.source.roomKey, tpl.rootUid)).some(
        n => n.uid === node
      )
    )
      throw fail(
        'TEMPLATE_AS_REQUEST',
        '请在自己的业务节点发起，不要在制度节点下登记真实申请'
      )
    const fields = agentInput?cleanAgentFields(body.fields||{},tpl):cleanFields(
        core.extractFields(
          anchor,
          node,
          tpl.kind === 'generic' ? tpl.fields : undefined
        ),
        tpl
      ),
      nodeInputHash = core.digest(fields),
      route = await routing(db, tpl, who, fields)
    const report = {
      ...workflow.evaluate(tpl, fields),
      nodeInputHash,
      configurationRequired: route.missing,
      ccResolved: route.resolved,
      publication: await publication(db, tpl, who)
    }
    if(agentInput){report.attachments=await checkAttachments(db,{room_key:room,node_uid:node,template:tpl},fields);report.nodeInputHash=null;report.inputHash=agentInputHash(tpl,fields,report.attachments)}
    const saved = await db.query(
      `insert into leave_requests(id,corp_id,requester_id,room_key,node_uid,source_room,source_uid,template,fields,report,steps,cc,input_mode) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(corp_id,requester_id,room_key,node_uid,input_mode) where status in ('draft','pending','returned') do nothing returning *`,
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
        JSON.stringify(route.cc),agentInput?'agent':'node'
      ]
    )
    if (saved.rows.length) return saved.rows[0]
    const existing = (
      await db.query(
        `select * from leave_requests where corp_id=$1 and requester_id=$2 and room_key=$3 and node_uid=$4 and input_mode=$5 and status in ('draft','pending','returned')`,
        [who.corp_id, who.user_id, room, node,agentInput?'agent':'node']
      )
    ).rows[0]
    if (
      existing.source_room !== tpl.source.roomKey ||
      existing.source_uid !== tpl.source.nodeUid
    )
      throw fail(
        'FLOW_CONFLICT',
        '该节点已有另一类在途申请，请使用新节点发起或先处理原申请',
        409
      )
    if (tpl.agentDefinition && String((existing.template.agentDefinition || {}).version || '') !== tpl.agentDefinition.version) {
      if (existing.status !== 'draft') throw fail('AGENT_REQUEST_PENDING','旧版本申请仍在审批中或已退回，请先处理该申请后执行新版本',409)
      const previousDefinition = existing.template.agentDefinition || null
      Object.assign(existing,{template:tpl,fields,report,steps:route.steps,cc:route.cc,revision:existing.revision+1})
      const rebound=await update(db,existing)
      await event(db,rebound,who,'rebind_definition',{op:randomUUID(),hash:core.digest(tpl.agentDefinition)},{previousDefinition,definition:tpl.agentDefinition})
      return rebound
    }
    return existing
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
  let definitionState = null
  if (row.template.agentDefinition) {
    try {
      const current = await template(pool, req, row.template.source, false)
      const pub = await publication(pool, current, who)
      definitionState = {state:pub.valid && String(pub.id)===String(row.template.agentDefinition.version)?'published':'draft',version:String(pub.id || '')}
    } catch (_) { definitionState = {state:'draft'} }
  }
  return {
    ...row,
    definitionState,
    history,
    hrmsSync: await require('./hrmsSync').state(pool, row.id, row.round),
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
    // jsonb may reorder object keys; compare canonical data rather than serialization order.
    const materialHash = value =>
      JSON.stringify(
        [value.fields, value.template, value.report, value.steps, value.cc],
        (_key, item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(
                Object.keys(item)
                  .sort()
                  .map(key => [key, item[key]])
              )
            : item
      )
    const originalMaterial = materialHash(row)
    const reviewedFields = core.digest(cleanFields(row.fields, row.template))
    const reviewedPolicy = row.template.fingerprint
    let detail = {}
    if (['save', 'import', 'submit', 'withdraw'].includes(action) && !owner)
      throw fail('REQUESTER_ONLY', '只有申请人可以修改或提交', 403)
    if (['save', 'import', 'submit'].includes(action)) {
      const agentInput=row.template.agentInput===true
      if(agentInput){
        if(!req.authUser.mcp&&!req.verifiedMcpSource)throw fail('AGENT_EXECUTION_REQUIRED','对话材料请通过个人MCP在Agent中维护和提交',409)
        if(action==='import'||body.nodeSource===true)throw fail('INPUT_MODE_CONFLICT','本申请使用Agent对话材料，不能从脑图导入或切换材料来源',409)
        if(action==='submit'&&body.fields!==undefined)throw fail('SAVE_BEFORE_SUBMIT','请先save并向用户展示更新后的材料，再提交')
      }
      if (!['draft', 'returned'].includes(row.status))
        throw fail('LOCKED', '已提交材料不能直接修改；请先撤回或退回', 409)
      await acl.assertRoomAccess(
        db,
        { ...req, forceAcl: true },
        row.room_key,
        agentInput?'view':'edit'
      )
      const agentDefinition = row.template.agentDefinition
      row.template = bindFields(
        await template(db, req, {
          roomKey: row.source_room,
          nodeUid: row.source_uid
        }),
        row.id,
        row.template.sourceNodeInput === true
      )
      if(agentInput)row.template.agentInput=true
      if (agentDefinition) row.template.agentDefinition = agentDefinition
      const currentPublication = await publication(db,row.template,who)
      if (currentPublication.agent_mode || agentDefinition) {
        if (action === 'save'&&!agentInput) throw fail('IMMUTABLE_DEFINITION','已发布审批的脑图材料入口只读取原节点；对话材料请选择input_mode=agent',409)
        if (action === 'submit' && (!req.authUser.mcp && !req.verifiedMcpSource || (!agentInput&&body.nodeSource !== true)))
          throw fail('AGENT_EXECUTION_REQUIRED','请在 Agent 中通过 MCP 核对原节点后执行',409)
        if (!currentPublication.agent_mode || !currentPublication.valid) throw fail('DEFINITION_DRAFT','审批节点已修改为草稿，请重新发布，不能执行旧规则',409)
        if (!agentDefinition || String(currentPublication.id) !== String(agentDefinition.version) ||
            (action === 'submit' && String(body.expectedDefinitionVersion || '') !== String(agentDefinition.version)))
          throw fail('DEFINITION_VERSION_CHANGED','已发布审批版本变化，请重新核对当前版本',409)
      }
      if (
        action === 'submit' &&
        (body.nodeSource === true||agentInput) &&
        row.template.fingerprint !== reviewedPolicy
      )
        throw fail(
          'POLICY_CHANGED',
          '流程或人员配置已变化，请重新读取节点并核对审批流程',
          409
        )
      let nodeInputHash = row.report.nodeInputHash
      if (
        action === 'import' ||
        (action === 'submit' && body.nodeSource === true)
      ) {
        const fromNodes = cleanFields(
          core.extractFields(
            await subtree(db, row.room_key, row.node_uid),
            row.node_uid,
            row.template.kind === 'generic' ? row.template.fields : undefined
          ),
          row.template
        )
        nodeInputHash = core.digest(fromNodes)
        if (
          body.expectedFields &&
          core.digest(cleanFields(body.expectedFields, row.template)) !==
            nodeInputHash
        )
          throw fail(
            'NODE_DATA_PENDING',
            '节点修改尚未同步到服务器，请等待同步完成后重新检查',
            409
          )
        if (action === 'submit' && body.expectedNodeHash !== nodeInputHash)
          throw fail(
            'NODE_DATA_CHANGED',
            '脑图资料已改变，请重新读取并核对摘要后提交',
            409
          )
        row.fields = fromNodes
      } else if (action === 'save') {
        row.fields = agentInput?cleanAgentFields(body.fields,row.template):cleanFields(body.fields, row.template)
        nodeInputHash = null
      }
      const route = await routing(db, row.template, who, row.fields)
      if (action === 'submit' && (body.nodeSource === true||agentInput) && core.digest(route.cc) !== core.digest(row.cc))
        throw fail('ROUTING_CHANGED','组织架构或抄送人员已变化，请重新读取并核对本次接收人',409)
      if (
        action === 'submit' &&
        (body.nodeSource === true||agentInput) &&
        core.digest(cleanFields(row.fields, row.template)) !== reviewedFields
      )
        throw fail(
          'MEMBER_MATCH_CHANGED',
          '成员匹配已变化，请重新读取节点并核对人员字段',
          409
        )
      row.report = {
        ...workflow.evaluate(row.template, row.fields),
        nodeInputHash,
        configurationRequired: route.missing,
        ccResolved: route.resolved,
        attachments: await checkAttachments(db, row, row.fields),
        publication: await publication(db, row.template, who)
      }
      if(agentInput){
        row.report.inputHash=agentInputHash(row.template,row.fields,row.report.attachments)
        if(action==='submit'){
          if(body.expectedInputHash!==row.report.inputHash)throw fail('INPUT_DATA_CHANGED','申请材料或附件已变化，请重新核对inputHash后提交',409)
          if(core.digest(route.steps.map(s=>[s.role,s.assigneeId]))!==core.digest(row.steps.map(s=>[s.role,s.assigneeId])))throw fail('ROUTING_CHANGED','实际审核人已变化，请重新save并核对后提交',409)
        }
      }
      row.steps = route.steps
      row.cc = route.cc
      if (action === 'submit') {
        if (body.confirmSubmission !== true)
          throw fail('CONFIRM_REQUIRED', '请先核对本次材料后确认提交')
        const blocked = [...row.report.blockers, ...route.missing]
        if (!row.report.publication.valid && row.template.kind === 'generic') {
          if (body.confirmRules !== true || body.expectedPolicyFingerprint !== row.template.fingerprint)
            throw fail('RULE_CONFIRMATION_REQUIRED', '请核对本次字段、规则、审核人与抄送人，并明确确认当前流程版本', 409)
          row.report.ruleConfirmation = {scope:'request',fingerprint:row.template.fingerprint,confirmedBy:who.user_id,confirmedAt:new Date().toISOString()}
          row.report.publication = {...row.report.publication,valid:true,scope:'request',fingerprint:row.template.fingerprint}
        } else if (!row.report.publication.valid) {
          blocked.push('当前流程尚未由模板管理员发布，或修改后需要重新发布')
        }
        if (blocked.length)
          throw fail('APPLICATION_INCOMPLETE', blocked.join('；'))
        row.status = row.template.autoApprove ? 'approved' : 'pending'
        row.current_step = 0
        // AI 预审：能按已发布规则判定的，直接代为通过或驳回并留痕；
        // 判不了（置信度不足/事实读不出/调用失败）才保持 pending，生成实际审批人的待办。
        // 开关走 aiReview.shouldRun：WCPD_AI_REVIEW_ENABLED!=='0' 且流程未挂「人工审批」即生效。
        const aiTrace = aiReview.shouldRun(row.template)
          ? await aiReview.applyOnSubmit(db, row)
          : null
        if (row.template.agentDefinition) {
          const latest=await template(db,req,row.template.source,false)
          const latestPublication=await publication(db,latest,who)
          if (!latestPublication.valid || String(latestPublication.id)!==String(row.template.agentDefinition.version))
            throw fail('DEFINITION_DRAFT','AI核验期间节点内容已修改，请重新发布后执行',409)
        }
        detail = {
          ...(row.report.ruleConfirmation ? {ruleConfirmation:row.report.ruleConfirmation} : {}),
          ...(aiTrace || {}),
          ...(!row.template.autoApprove && aiTrace && row.status !== 'pending' ? {
            automaticDecision: {
              decision: row.status === 'approved' ? 'approve' : 'reject',
              source: 'ai-review',
              fingerprint: row.template.fingerprint
            }
          } : {}),
          ...(row.template.autoApprove ? {
            automaticDecision: {
              decision: 'approve',
              rule: row.template.autoApproveRule,
              source: row.template.source,
              fingerprint: row.template.fingerprint
            }
          } : {}),
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
        if (row.template.agentDefinition) {
          const current=await publication(db,currentTemplate,who)
          if (!current.valid || String(current.id)!==String(row.template.agentDefinition.version)) throw fail('DEFINITION_DRAFT','原审批定义已修改或重新发布，请退回后重新执行',409)
        }
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
    if (action === 'import' && originalMaterial === materialHash(row)) {
      await event(db, row, who, action, replay, { unchanged: true })
      return { ...row, unchanged: true }
    }
    row.revision++
    const saved = await update(db, row)
    await event(db, saved, who, action, replay, detail)
    if (saved.status === 'approved') await require('./hrmsSync').enqueue(db, saved)
    if (
      (action === 'submit' && saved.status === 'pending') ||
      (action === 'decide' && saved.status === 'pending')
    )
      await notify(
        db,
        saved,
        [saved.steps[saved.current_step].assigneeId],
        'todo'
      )
    if ((action === 'decide' && saved.status !== 'pending') ||
        (action === 'submit' && saved.status === 'approved'))
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
      `select r.id,r.status,r.revision,r.round,r.current_step,r.steps,r.created_at,r.updated_at,coalesce(u.name,r.requester_id) requester_name,case when r.template->>'kind'='generic' then r.template->>'title' else '请假申请' end title from leave_requests r left join wecom_users u on u.user_id=r.requester_id and u.corp_id=r.corp_id where r.corp_id=$1 and ${condition} order by r.updated_at desc,r.id limit $3 offset $4`,
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
async function project(pool, writer, requestId = null) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const pending = (
      await db.query(
        'select * from leave_requests where projection_pending and projection_retry_at<=now() and ($1::uuid is null or id=$1) order by projection_retry_at limit 5 for update skip locked',
        [requestId]
      )
    ).rows
    for (const row of pending) {
      try {
        if (row.template.sourceNodeInput || row.template.agentInput) {
          await db.query("update leave_requests set projection_pending=false,projection_error='' where id=$1", [row.id])
          continue
        }
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
          const directFields = existing.some(n =>
            row.template.kind === 'generic'
              ? row.template.fields.some(
                  f => f.label === core.label(n.data.text).split(/[:：]/)[0]
                )
              : core.FIELDS[core.label(n.data.text).split(/[:：]/)[0]]
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
          for (const f of row.template.fields) {
            const present = fieldRows.find(
              n =>
                n.uid === f.instanceUid ||
                core.label(n.data.text).split(/[:：]/)[0] === f.label
            )
            if (present) {
              if (
                present.uid === f.instanceUid &&
                !/[:：]/.test(core.plain(present.data.text)) &&
                core.plain(present.data.text) !== f.label
              )
                await writer(row.room_key, {
                  operationId: core.projectionId(
                    row.id + ':label:' + f.key + ':' + row.revision
                  ),
                  mapId: row.room_key,
                  actorId: 'leave-workflow',
                  clientId: 'leave-workflow',
                  baseVersion: null,
                  type: 'node.update',
                  payload: { uid: present.uid, patch: { text: f.label } }
                })
              continue // Never overwrite a user-entered value or child.
            }
            const fieldUid = core.projectionId(row.id + ':field:' + f.key)
            await insert(fieldUid, parent, f.label)
            if (f.key !== 'attachmentIds' && f.type !== 'attachment')
              await insert(
                core.projectionId(row.id + ':value:' + f.key),
                fieldUid,
                '待填写'
              )
          }
          const hints = [
            ...(row.report.blockers || []),
            ...(row.report.configurationRequired || [])
          ]
          if (!(row.report.publication || {}).valid)
            hints.push(row.template.kind === 'generic' ? '提交前请核对并确认本次规则版本' : '流程待管理员配置并发布')
          const hintText =
            row.report.hours == null
              ? ''
              : `时长：${row.report.hours}小时 / ${row.report.days}工作日；`
          const text = `填写检查：${hintText}${
            hints.length ? hints.join('；') : '资料齐全，可核对并提交'
          }`
          const hintUid = core.projectionId(row.id + ':check')
          const hint = (
            await db.query(
              'select data from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
              [row.room_key, hintUid]
            )
          ).rows[0]
          if (!hint) await insert(hintUid, row.node_uid, text)
          else if (hint.data.text !== text)
            await writer(row.room_key, {
              operationId: core.projectionId(row.id + ':check:' + row.revision),
              mapId: row.room_key,
              actorId: 'leave-workflow',
              clientId: 'leave-workflow',
              baseVersion: null,
              type: 'node.update',
              payload: { uid: hintUid, patch: { text } }
            })
        }
        const uid = core.projectionId(row.id),
          exists = (
            await db.query(
              'select uid from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
              [row.room_key, uid]
            )
          ).rows.length
        const text = `${
          row.template.kind === 'generic' ? row.template.title : '请假申请'
        }：${core.statusText(row.status)}${
          row.status === 'pending'
            ? ' · ' + row.steps[row.current_step].role
            : ''
        }`
        // Reuse supported hyperlink fields so both Yjs and direct writers retain the entry.
        const entry = {
          hyperlink: `/?room=${encodeURIComponent(row.room_key)}&leaveRequest=${
            row.id
          }`,
          hyperlinkTitle: '查看申请与审批记录'
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
  catalog: (db, req, options = {}) =>
    require('./catalog').page(db, req, options, { identity, SOURCE }),
  resolve: (db, req, text) =>
    require('./catalog').resolve(db, req, text, { identity, SOURCE }),
  initSchema,
  identity,
  subtree,
  template,
  routing,
  publication,
  definitions,
  invalidateDefinition,
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
