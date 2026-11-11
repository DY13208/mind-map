const {createHash} = require('crypto')
const organization = require('./hrmsOrganization')
const external = require('../hrmsExternalApi')
const workers = new WeakMap()
// 脑图模板标题 → 人事系统入口（新系统路径；老 Frappe 的 /api/method/... 已退役）。
const SYNC_TARGETS = {
  '转正申请表': '/api/v1/hrms/external/approvals/import-approved',
  '录用': '/api/v1/hrms/external/approvals/import-hired'
}
function config(env = process.env) {
  const cfg = organization.config({HRMS_ORG_API_BASE:env.HRMS_SYNC_API_BASE,HRMS_ORG_API_KEY:env.HRMS_SYNC_API_KEY,HRMS_ORG_API_SECRET:env.HRMS_SYNC_API_SECRET,HRMS_ORG_COMPANY:env.HRMS_SYNC_COMPANY,HRMS_ORG_CORP_ID:env.HRMS_SYNC_CORP_ID})
  return {...cfg,enabled:env.HRMS_SYNC_ENABLED === '1'}
}
async function initSchema(db) {
  await db.query(`create table if not exists approval_hrms_sync (
    request_id uuid not null references leave_requests(id), round integer not null,
    payload jsonb not null, status text not null default 'pending' check(status in ('pending','failed','synced')),
    attempts integer not null default 0, retry_at timestamptz not null default now(),
    last_error text not null default '', result jsonb, synced_at timestamptz,
    primary key(request_id,round));
    create index if not exists approval_hrms_retry on approval_hrms_sync(retry_at) where status <> 'synced';`)
}
async function enqueue(db,row) {
  const cfg=config()
  if (!cfg.enabled || row.status !== 'approved' || !SYNC_TARGETS[row.template.title] || row.corp_id !== cfg.corpId) return
  const person=(await db.query('select wecom_userid,name from wecom_users where corp_id=$1 and user_id=$2',[row.corp_id,row.requester_id])).rows[0]
  const audit=(await db.query('select actor_id,action,detail,created_at from leave_events where request_id=$1 and detail->>\'round\'=$2 order by id',[row.id,String(row.round)])).rows
  const fields=Object.fromEntries(row.template.fields.map(f=>[f.label,row.fields[f.key] || '']))
  const accounts=[...new Set([row.requester_id,...row.cc,...row.steps.map(s=>s.assigneeId),...audit.map(e=>e.actor_id)].filter(Boolean))]
  const people=(await db.query('select user_id as account,wecom_userid as "wecomUserId",name from wecom_users where corp_id=$1 and user_id=any($2::text[])',[row.corp_id,accounts])).rows
  const payload={version:1,requestId:row.id,round:row.round,company:cfg.company,corpId:row.corp_id,title:row.template.title,status:'approved',requester:person,fields,attachments:row.report.attachments || [],snapshot:{template:row.template,fields:row.fields,steps:row.steps,cc:row.cc,ccResolved:row.report.ccResolved || [],people,audit},approvedAt:row.updated_at}
  await db.query('insert into approval_hrms_sync(request_id,round,payload) values($1,$2,$3) on conflict do nothing',[row.id,row.round,payload])
}
async function state(db,id,round) {
  return (await db.query('select status,attempts,last_error,result,synced_at from approval_hrms_sync where request_id=$1 and round=$2',[id,round])).rows[0] || null
}
async function send(payload,options={}) {
  const cfg=config(options.env)
  if (!cfg.enabled || !cfg.ready || cfg.company !== payload.company || cfg.corpId !== payload.corpId) throw new Error('人事同步连接未配置或企业不匹配')
  const target = SYNC_TARGETS[payload.title]
  if (!target) throw new Error(`模板「${payload.title}」没有人事系统对接的同步接口`)
  // 新系统走 Bearer 换票：以发起人的企微账号换取本人 Token。
  const requester = payload.requester || {}
  const user = options.user || (requester.wecom_userid
    ? {id: requester.wecom_userid, wecomUserId: requester.wecom_userid}
    : null)
  if (!user) throw new Error('人事同步缺少发起人的企业微信账号')
  let body
  try {
    const response = await external.callApi(target, {
      env: options.env,
      user,
      fetchImpl: options.fetchImpl,
      method: 'POST',
      timeoutMs: payload.title === '录用' ? 120000 : 60000,
      json: {payload}
    })
    body = response && response.data
  } catch (err) {
    throw new Error(`人事系统同步失败：${err.message}`)
  }
  if (!body || body.success === false)
    throw new Error(`人事系统同步失败：${(body && body.msg) || '未知错误'}`)
  const result = body.data
  if(!result || result.sourceKey!==`${payload.requestId}:${payload.round}` || !result.name || result.status !== '已通过') throw new Error('人事系统未确认单据同步成功')
  // 录用会多返建档与开户结果，转正没有这些键。
  const extra = {}
  for (const key of ['employee','employeeCreated','loginAccount','profileComplete','problems'])
    if (result[key] !== undefined) extra[key] = result[key]
  return {...extra,name:result.name,applicationNo:result.applicationNo,status:result.status}}
async function run(pool,options={}) {
  if(!config(options.env).enabled) return
  const db=await pool.connect()
  try{
    await db.query('begin')
    const job=(await db.query("select * from approval_hrms_sync where status <> 'synced' and retry_at<=now() order by retry_at limit 1 for update skip locked")).rows[0]
    if(job){
      try{
        const row=(await db.query('select id,room_key,status,round from leave_requests where id=$1',[job.request_id])).rows[0]
        if(!row || row.status!=='approved' || row.round!==job.round) throw new Error('单据状态或轮次已变化，不能同步')
        const payload=structuredClone(job.payload)
        if(payload.attachments.length>10) throw new Error('同步附件超过10份')
        let total=0
        for(const file of payload.attachments){
          const content=await (options.readAttachment || require('../nodeKnowledge/store').getContentById)(db,require('./attachments').storageScope(row,file),file.id,{maxBytes:20*1024*1024})
          if(!content || content.attachment.contentHash!==file.hash || createHash('sha256').update(content.buffer).digest('hex')!==file.hash) throw new Error('审批附件已变化，不能同步为原材料')
          total+=content.buffer.length
          if(total>20*1024*1024) throw new Error('同步附件合计超过20MB')
          file.contentBase64=content.buffer.toString('base64')
        }
        const result=await send(payload,options)
        await db.query("update approval_hrms_sync set status='synced',attempts=attempts+1,last_error='',result=$3,synced_at=now() where request_id=$1 and round=$2",[job.request_id,job.round,result])
      }catch(e){
        await db.query("update approval_hrms_sync set status='failed',attempts=attempts+1,last_error=$3,retry_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second' where request_id=$1 and round=$2",[job.request_id,job.round,String(e.message || '同步失败').slice(0,300)])
      }
    }
    await db.query('commit')
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
}
function startWorker(pool) {
  if(workers.has(pool) || !config().enabled) return
  const runOnce=()=>run(pool).catch(()=>{})
  const timer=setInterval(runOnce,15000);timer.unref();workers.set(pool,timer)
  setImmediate(runOnce)
}
module.exports={config,initSchema,enqueue,state,send,run,startWorker}
