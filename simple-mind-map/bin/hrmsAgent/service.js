const crypto=require('crypto')
const catalog=require('./catalog.json')
const ownReads=new Set(require('./ownReads.json'))
const personal=require('../hrmsExternalApi')
const identity=require('../leaveWorkflow/service').identity
const failure=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode})
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)).digest('hex')
const clean=v=>{
 if(Array.isArray(v))return v.map(clean)
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!/(?:password|api_?key|secret|access_?token|refresh_?token|private_?key|token_hash|exchange_?key|authorization|cookie|^sid$|^exc$|exception|_server_messages)/i.test(k)).map(([k,x])=>[k,clean(x)]))
 return v
}
async function initSchema(db){await db.query(`create table if not exists hrms_agent_actions(id uuid primary key,owner_id text not null,corp_id text not null,operation_id uuid not null,operation text not null,params jsonb not null,request_hash text not null,state text not null default 'prepared',result jsonb,error text,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '15 minutes',unique(owner_id,operation_id));
 create unique index if not exists hrms_agent_uncertain_action on hrms_agent_actions(owner_id,request_hash) where state in ('prepared','running','unknown');
 create table if not exists hrms_agent_reads(id uuid primary key,owner_id text not null,corp_id text not null,payload text not null,expires_at timestamptz not null default now()+interval '10 minutes');
 alter table hrms_agent_reads add column if not exists scope text not null default 'legacy';
 alter table hrms_agent_actions add column if not exists confirmation_nonce_hash text;
 alter table hrms_agent_actions add column if not exists approved_by text;
 alter table hrms_agent_actions add column if not exists approved_hash text;
 alter table hrms_agent_actions add column if not exists approved_at timestamptz;`)}
const writesEnabled=()=>process.env.HRMS_AGENT_WRITES_ENABLED==='true'
function assertWrites(){if(!writesEnabled())throw failure('HRMS_WRITES_DISABLED','人事写入默认关闭；当前仅允许查询',403)}
const confirmUrl=id=>'/api/integrations/hrms/agent/confirm?plan_id='+id
const catalogView=op=>({...op,params:[...op.params,...(ownReads.has(op.id)&&!op.params.includes('employee')?['employee']:[])],scope:op.policy==='read'?'self_or_authorized_admin':undefined,available:op.policy==='read'?ownReads.has(op.id):op.policy==='write'&&writesEnabled(),restriction:op.policy==='read'&&!ownReads.has(op.id)?'未实现员工范围权限校验，禁止通过Agent查询':undefined})
function operation(id,params,policy){
 const op=catalog.find(x=>x.id===id)
 if(!op)throw failure('HRMS_OPERATION_UNKNOWN','请先查询接口目录，不能调用任意URL或未登记方法')
 if(op.policy!==policy)throw failure('HRMS_OPERATION_RESTRICTED',op.reason,403)
 if(policy==='read'&&!ownReads.has(id))throw failure('HRMS_SELF_ONLY','当前仅开放已核验的员工资料、考勤接口；管理员可按权限指定employee，全公司接口尚未开放',403)
 if(!params || typeof params!=='object' || Array.isArray(params))throw failure('HRMS_PARAMS_INVALID','params须是对象')
 const allowed=new Set([...op.params,...(ownReads.has(id)?['employee']:[])])
 for(const key of Object.keys(params))if(!allowed.has(key))throw failure('HRMS_PARAMETER_UNKNOWN','未登记参数：'+key)
 if(Buffer.byteLength(JSON.stringify(params))>12000)throw failure('HRMS_PARAMS_TOO_LARGE','参数过大，请使用专用文件工具')
 if(JSON.stringify(params)!==JSON.stringify(clean(params)))throw failure('HRMS_SECRET_PARAMS','不允许Agent通过业务参数传入密码、密钥或令牌')
 if(policy==='read'&&(params.sync===true||params.force_refresh===true))throw failure('HRMS_QUERY_SIDE_EFFECT','自动查询不执行强制同步或刷新')
 return op
}
async function actor(db,req){
 const who=await identity(db,req)
 const member=(await db.query('select wecom_userid from wecom_users where user_id=$1 and corp_id=$2',[who.user_id,who.corp_id])).rows[0]
 if(!member?.wecom_userid)throw failure('HRMS_IDENTITY_REQUIRED','请先绑定个人企业微信身份',403)
 const corp=process.env.HRMS_AGENT_CORP_ID
 if(!corp)throw failure('HRMS_CONNECTION_REQUIRED','本地人事个人鉴权网关尚未启用，须由用户确认后配置连接',503)
 if(corp!==who.corp_id)throw failure('HRMS_CORP_MISMATCH','当前人事连接不属于本企业',403)
 return {...who,wecomUserId:member.wecom_userid}
}
async function upstream(who,op,params,mode,deps){
 let authorization
 if(mode==='write'){
  const key=personal.readConfig(deps.env||process.env).exchangeKey
  if(!key||!who.approvalPlan)throw failure('HRMS_PAGE_CONFIRMATION_REQUIRED','缺少页面授权或网关密钥',403)
  const payload=Buffer.from(JSON.stringify({operation:op.id,params,wecom_userid:who.wecomUserId,plan_id:who.approvalPlan,expires:Math.floor(Date.now()/1000)+120})).toString('base64url')
  authorization=payload+'.'+crypto.createHmac('sha256',key).update(payload).digest('hex')
 }
 const result=await (deps.callApi || personal.callApi)('/api/method/employee_roster.integrations.agent_api.invoke',{
  user:{id:who.user_id,wecomUserId:who.wecomUserId},ownerUserId:who.user_id,wecomUserId:who.wecomUserId,
  method:'POST',json:{operation:op.id,params,mode,company:process.env.HRMS_AGENT_COMPANY,...(authorization?{authorization}:{})},...(deps.env?{env:deps.env}:{})
 })
 return clean(result.data?.message ?? result.data)
}
async function page(db,who,data){
 const serialized=JSON.stringify(data)
 if(serialized.length<=6000)return {data,complete:true}
 if(serialized.length>2000000)throw failure('HRMS_RESPONSE_TOO_LARGE','查询过大，请缩小日期、人员或分页范围')
 const id=crypto.randomUUID()
 await db.query('delete from hrms_agent_reads where expires_at<now()')
 await db.query("insert into hrms_agent_reads(id,owner_id,corp_id,payload,scope) values($1,$2,$3,$4,'self-v1')",[id,who.user_id,who.corp_id,serialized])
 let end=6000;if(/[\uD800-\uDBFF]/.test(serialized[end-1]))end--
 return {format:'json_fragment',content:serialized.slice(0,end),complete:false,next_cursor:Buffer.from(JSON.stringify({id,offset:end})).toString('base64url')}
}
const view=r=>({plan_id:r.id,operation:r.operation,params:clean(r.params),confirmation_hash:r.request_hash,state:r.state,expires_at:r.expires_at,error:r.error || null,page_confirmed:!!r.approved_at,confirmation_url:confirmUrl(r.id)})
async function handle(db,req,input,deps={}){
 const who=['catalog','describe'].includes(input.action)?await identity(db,req):await actor(db,req)
 if(input.action==='catalog'){
  const offset=Number(input.cursor || 0);if(!Number.isInteger(offset)||offset<0)throw failure('HRMS_CURSOR_INVALID','目录游标无效')
  const filtered=catalog.filter(x=>!input.keyword || (x.id+' '+x.reason).toLowerCase().includes(input.keyword.toLowerCase()))
  return {list:filtered.slice(offset,offset+20).map(catalogView),total:filtered.length,read_scope:'self_or_authorized_admin',writes_enabled:writesEnabled(),connection_configured:!!process.env.HRMS_AGENT_CORP_ID&&personal.readConfig().configured,has_more:offset+20<filtered.length,next_cursor:offset+20<filtered.length?String(offset+20):null}
 }
 if(input.action==='describe'){const op=catalog.find(x=>x.id===input.operation);return op?catalogView(op):{error:'未登记接口'}}
 if(input.action==='read_page'){
  let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString())}catch{throw failure('HRMS_CURSOR_INVALID','结果游标无效')}
  if(!/^[0-9a-f-]{36}$/.test(cursor.id)||!Number.isInteger(cursor.offset)||cursor.offset<0)throw failure('HRMS_CURSOR_INVALID','结果游标无效')
  const r=(await db.query("select payload from hrms_agent_reads where id=$1 and owner_id=$2 and corp_id=$3 and expires_at>now() and scope='self-v1'",[cursor.id,who.user_id,who.corp_id])).rows[0]
  if(!r)throw failure('HRMS_RESULT_EXPIRED','查询结果过期或无权读取',404)
  let end=Math.min(cursor.offset+6000,r.payload.length);if(/[\uD800-\uDBFF]/.test(r.payload[end-1]))end--
  return {format:'json_fragment',content:r.payload.slice(cursor.offset,end),complete:end>=r.payload.length,next_cursor:end<r.payload.length?Buffer.from(JSON.stringify({...cursor,offset:end})).toString('base64url'):null}
 }
 if(input.action==='query')return page(db,who,await upstream(who,operation(input.operation,input.params || {},'read'),input.params || {},'read',deps))
 if(input.action==='prepare'){
  assertWrites()
  await db.query("update hrms_agent_actions set state='expired' where owner_id=$1 and state='prepared' and expires_at<now()",[who.user_id])
  const op=operation(input.operation,input.params || {},'write')
  if(!/^[0-9a-f-]{36}$/.test(input.operation_id || ''))throw failure('HRMS_OPERATION_ID_REQUIRED','写入准备须提供唯一operation_id')
  const requestHash=hash({corp:who.corp_id,owner:who.user_id,operation:op.id,params:input.params || {}})
  const replay=(await db.query('select * from hrms_agent_actions where owner_id=$1 and operation_id=$2',[who.user_id,input.operation_id])).rows[0]
  if(replay){if(replay.request_hash!==requestHash)throw failure('HRMS_OPERATION_CONFLICT','同一operation_id不能更改参数',409);return view(replay)}
  const preview=await upstream(who,op,input.params || {},'preview',deps)
  const id=crypto.randomUUID()
  const row=(await db.query("insert into hrms_agent_actions(id,owner_id,corp_id,operation_id,operation,params,request_hash) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning *",[id,who.user_id,who.corp_id,input.operation_id,op.id,input.params || {},requestHash])).rows[0]
  if(!row)throw failure('HRMS_ACTION_EXISTS','同一内容已有待确认或结果未知的操作，请先查询原plan_id，不能换ID重试',409)
  return {...view(row),preview,requires_confirmation:true,notice:'请用户用本人登录会话打开confirmation_url核对参数并点击确认；Agent传confirmed不能授权写入。prepare没有执行写入'}
 }
 if(!/^[0-9a-f-]{36}$/.test(input.plan_id || ''))throw failure('HRMS_PLAN_REQUIRED','请先prepare取得plan_id')
 const row=(await db.query('select * from hrms_agent_actions where id=$1 and owner_id=$2 and corp_id=$3',[input.plan_id,who.user_id,who.corp_id])).rows[0]
 if(!row)throw failure('HRMS_PLAN_NOT_FOUND','计划不存在或无权读取',404)
 if(input.action==='status')return row.state==='succeeded'?{...view(row),...await page(db,who,row.result)}:view(row)
 if(input.action!=='execute')throw failure('HRMS_ACTION_INVALID','不支持的操作')
 assertWrites()
 if(row.state==='succeeded')return {...view(row),...await page(db,who,row.result),duplicate:true}
 if(row.state!=='prepared')return {...view(row),notice:'禁止自动重复执行；结果未知时需到人事系统核对'}
 if(!row.approved_at||row.approved_by!==who.user_id||row.approved_hash!==row.request_hash)throw failure('HRMS_PAGE_CONFIRMATION_REQUIRED','必须由本人登录确认页面核对并确认；Agent参数不能代替用户确认',409)
 const claimed=(await db.query("update hrms_agent_actions set state='running' where id=$1 and state='prepared' and expires_at>now() and approved_by=owner_id and approved_hash=request_hash and approved_at is not null returning *",[row.id])).rows[0]
 if(!claimed)throw failure('HRMS_PLAN_EXPIRED','计划已过期或正在执行，请重新核对',409)
 try{
  const result=await upstream({...who,approvalPlan:row.id},operation(row.operation,row.params,'write'),row.params,'write',deps)
  await db.query("update hrms_agent_actions set state='succeeded',result=$2 where id=$1",[row.id,result])
  return {...view({...row,state:'succeeded'}),...await page(db,who,result)}
 }catch(e){
  const state=[400,401,403,404].includes(e.statusCode)?'failed':'unknown'
  await db.query('update hrms_agent_actions set state=$2,error=$3 where id=$1',[row.id,state,'人事调用未完成：'+String(e.code || 'HRMS_UPSTREAM_ERROR')])
  throw failure(state==='unknown'?'HRMS_OUTCOME_UNKNOWN':e.code || 'HRMS_REJECTED',state==='unknown'?'执行结果未知；禁止重试，请用status并在人事系统核对':e.message,e.statusCode || 502)
 }
}
// Only the browser route calls these functions; they are never MCP actions.
async function browserActor(db,req){
 if(req.headers?.authorization||!req.headers?.cookie)throw failure('HRMS_BROWSER_REQUIRED','请使用本人登录的浏览器页面确认',403)
 return identity(db,req,true)
}
async function confirmationPage(db,req,id){
 const who=await browserActor(db,req)
 assertWrites()
 if(!/^[0-9a-f-]{36}$/.test(id||''))throw failure('HRMS_PLAN_REQUIRED','计划编号无效')
 const nonce=crypto.randomBytes(32).toString('base64url')
 const row=(await db.query("update hrms_agent_actions set confirmation_nonce_hash=$4 where id=$1 and owner_id=$2 and corp_id=$3 and state='prepared' and expires_at>now() returning *",[id,who.user_id,who.corp_id,hash(nonce)])).rows[0]
 if(!row)throw failure('HRMS_PLAN_NOT_FOUND','计划不存在、已执行、已过期或不属于本人',404)
 return {...view(row),nonce,actor_name:who.name,effect:catalog.find(x=>x.id===row.operation)?.reason}
}
async function confirmFromPage(db,req,input){
 const who=await browserActor(db,req)
 assertWrites()
 let origin;try{origin=new URL(req.headers.origin)}catch{throw failure('HRMS_ORIGIN_REQUIRED','确认须来自本站页面',403)}
 if(origin.host!==req.headers.host||!['http:','https:'].includes(origin.protocol)||req.headers['sec-fetch-site']==='cross-site')throw failure('HRMS_ORIGIN_REQUIRED','确认须来自本站页面',403)
 if(!/^[0-9a-f-]{36}$/.test(input.plan_id||'')||typeof input.nonce!=='string'||input.nonce.length>100)throw failure('HRMS_CONFIRMATION_INVALID','确认信息无效',403)
 const row=(await db.query("update hrms_agent_actions set approved_by=$2,approved_hash=request_hash,approved_at=now(),confirmation_nonce_hash=null where id=$1 and owner_id=$2 and corp_id=$3 and state='prepared' and expires_at>now() and request_hash=$4 and confirmation_nonce_hash=$5 returning *",[input.plan_id,who.user_id,who.corp_id,input.confirmation_hash,hash(input.nonce)])).rows[0]
 if(!row)throw failure('HRMS_CONFIRMATION_INVALID','确认已失效、已使用或参数不匹配，请重新打开页面',409)
 return view(row)
}
module.exports={initSchema,handle,operation,clean,confirmationPage,confirmFromPage}
