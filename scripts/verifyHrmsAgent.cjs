const assert=require('node:assert/strict'),{randomUUID}=require('crypto'),{execFileSync}=require('child_process')
const {Client,Pool}=require('../simple-mind-map/node_modules/pg')
const gateway=require('../simple-mind-map/bin/hrmsAgent/service')
async function main(){
 assert.equal(process.env.LEAVE_TEST_DISPOSABLE,'1')
 const container=process.env.LEAVE_TEST_DB_CONTAINER;assert.match(container,/test|preview/)
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0]
 const env=Object.fromEntries(info.Config.Env.map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)]))
 const config={host:'127.0.0.1',port:Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort),user:env.POSTGRES_USER || 'postgres',password:env.POSTGRES_PASSWORD,database:env.POSTGRES_DB || env.POSTGRES_USER || 'postgres'}
 const admin=new Client(config);await admin.connect();const schema='hrms_agent_test_'+Date.now();await admin.query('create schema '+schema)
 const pool=new Pool({...config,options:'-c search_path='+schema})
 Object.assign(process.env,{HRMS_AGENT_CORP_ID:'test-corp',HRMS_AGENT_COMPANY:'测试公司'})
 let checks=0,writes=0,reads=0
 const check=(a,b)=>{assert.deepEqual(a,b);checks++}
 const reject=async(fn,code)=>{await assert.rejects(fn,e=>e.code===code);checks++}
 const req=id=>({authUser:{id,mcp:true}})
 const browser=id=>({authUser:{id},headers:{cookie:'test-session',origin:'http://localhost:8989',host:'localhost:8989','sec-fetch-site':'same-origin'}})
 const approve=async plan=>{
  const page=await gateway.confirmationPage(pool,browser('one'),plan.plan_id)
  await gateway.confirmFromPage(pool,browser('one'),{plan_id:plan.plan_id,confirmation_hash:plan.confirmation_hash,nonce:page.nonce})
 }
 const operation='employee_roster.hr_roster.api.employee_center.save_application'
 const query='employee_roster.hr_roster.api.employee_center.get_context'
 const params={application_type:'subsidy',payload:{amount:55},submit:false}
 const deps={callApi:async(_path,options)=>{
  assert.equal(options.user.id,'one');assert.equal(options.user.wecomUserId,'wecom-one')
  assert.equal(options.user.mcp,undefined)
  if(options.json.mode==='write'){writes++;return {data:{message:{name:'synthetic-created'}}}}
  if(options.json.mode==='read'){reads++;return {data:{message:{source:'synthetic',api_secret:'never-return',employee:'EMP-1'}}}}
  return {data:{message:{business_write_executed:false}}}
 }}
 try{
  await pool.query("create table wecom_users(user_id text primary key,corp_id text,wecom_userid text,name text,departments jsonb); insert into wecom_users values('one','test-corp','wecom-one','合成员工一','[]'),('two','test-corp','wecom-two','合成员工二','[]'),('other','other-corp','wecom-other','其他企业','[]')")
  await gateway.initSchema(pool)
  let offset,all=[]
  do{const c=await gateway.handle(pool,req('one'),{action:'catalog',cursor:offset});all.push(...c.list);offset=c.next_cursor}while(offset)
  check(all.length,170)
  check(all.find(o=>o.name==='complete_approval_task').policy,'manual')
  delete process.env.HRMS_AGENT_WRITES_ENABLED
  await reject(()=>gateway.handle(pool,req('one'),{action:'prepare',operation,params,operation_id:randomUUID()},deps),'HRMS_WRITES_DISABLED')
  check(all.find(o=>o.name==='get_roster_data').available,false)
  const profileDescription=await gateway.handle(pool,req('one'),{action:'describe',operation:query})
  check(profileDescription.params.includes('employee'),true)
  check(profileDescription.scope,'self_or_authorized_admin')
  check(gateway.operation(query,{employee:'EMP-OTHER'},'read').id,query)
  await reject(()=>gateway.handle(pool,req('one'),{action:'query',operation:'employee_roster.hr_roster.page.roster.roster.get_roster_data'},deps),'HRMS_SELF_ONLY')
  process.env.HRMS_AGENT_WRITES_ENABLED='true'
  process.env.EXTERNAL_API_EXCHANGE_KEY='synthetic-exchange-key-for-isolated-tests-only'
  await reject(()=>gateway.handle(pool,{authUser:{id:'one',service:true}},{action:'catalog'}),'PERSONAL_IDENTITY_REQUIRED')
  await reject(()=>gateway.handle(pool,req('other'),{action:'query',operation:query},deps),'HRMS_CORP_MISMATCH')
  await reject(()=>gateway.handle(pool,req('one'),{action:'query',operation:'https://outside.invalid'},deps),'HRMS_OPERATION_UNKNOWN')
  await reject(()=>gateway.handle(pool,req('one'),{action:'query',operation:'employee_roster.hr_roster.approval_runtime.complete_approval_task'},deps),'HRMS_OPERATION_RESTRICTED')
  await reject(()=>gateway.handle(pool,req('one'),{action:'query',operation:query,params:{user:'someone-else'}},deps),'HRMS_PARAMETER_UNKNOWN')
  await reject(()=>gateway.handle(pool,req('one'),{action:'prepare',operation,params:{...params,payload:{password:'synthetic-only'}},operation_id:randomUUID()},deps),'HRMS_SECRET_PARAMS')
  const result=await gateway.handle(pool,req('one'),{action:'query',operation:query},deps)
  check(result.complete,true);check(JSON.stringify(result).includes('never-return'),false)
  const operationId=randomUUID()
  const plan=await gateway.handle(pool,req('one'),{action:'prepare',operation,params,operation_id:operationId},deps)
  check(writes,0);check(plan.preview.business_write_executed,false)
  await reject(()=>gateway.handle(pool,req('one'),{action:'prepare',operation,params:{...params,submit:true},operation_id:operationId},deps),'HRMS_OPERATION_CONFLICT')
  await reject(()=>gateway.handle(pool,req('one'),{action:'execute',plan_id:plan.plan_id,confirmed:true,confirmation_hash:plan.confirmation_hash},deps),'HRMS_PAGE_CONFIRMATION_REQUIRED')
  await reject(()=>gateway.confirmationPage(pool,{...req('one'),headers:browser('one').headers},plan.plan_id),'HUMAN_DECISION_REQUIRED')
  await reject(()=>gateway.confirmationPage(pool,browser('two'),plan.plan_id),'HRMS_PLAN_NOT_FOUND')
  const page=await gateway.confirmationPage(pool,browser('one'),plan.plan_id)
  const confirmation={plan_id:plan.plan_id,confirmation_hash:plan.confirmation_hash,nonce:page.nonce}
  await reject(()=>gateway.confirmFromPage(pool,{...browser('one'),headers:{...browser('one').headers,origin:'https://outside.invalid'}},confirmation),'HRMS_ORIGIN_REQUIRED')
  await reject(()=>gateway.confirmFromPage(pool,browser('one'),{...confirmation,confirmation_hash:'tampered'}),'HRMS_CONFIRMATION_INVALID')
  await gateway.confirmFromPage(pool,browser('one'),confirmation)
  await reject(()=>gateway.confirmFromPage(pool,browser('one'),confirmation),'HRMS_CONFIRMATION_INVALID')
  check(writes,0)
  await reject(()=>gateway.handle(pool,req('two'),{action:'status',plan_id:plan.plan_id},deps),'HRMS_PLAN_NOT_FOUND')
  await gateway.handle(pool,req('one'),{action:'execute',plan_id:plan.plan_id,confirmed:true,confirmation_hash:plan.confirmation_hash},deps)
  const repeat=await gateway.handle(pool,req('one'),{action:'execute',plan_id:plan.plan_id,confirmed:true,confirmation_hash:plan.confirmation_hash},deps)
  check(writes,1);check(repeat.duplicate,true)
  const next=await gateway.handle(pool,req('one'),{action:'prepare',operation,params:{...params,payload:{amount:56}},operation_id:randomUUID()},deps)
  await approve(next)
  await reject(()=>gateway.handle(pool,req('one'),{action:'execute',plan_id:next.plan_id,confirmed:true,confirmation_hash:next.confirmation_hash},{callApi:async()=>{throw Error('synthetic timeout')}}),'HRMS_OUTCOME_UNKNOWN')
  check((await gateway.handle(pool,req('one'),{action:'status',plan_id:next.plan_id},deps)).state,'unknown')
  await reject(()=>gateway.handle(pool,req('one'),{action:'prepare',operation,params:{...params,payload:{amount:56}},operation_id:randomUUID()},deps),'HRMS_ACTION_EXISTS')
  const long='中文数据😀'.repeat(9000)
  let part=await gateway.handle(pool,req('one'),{action:'query',operation:query},{callApi:async()=>({data:{message:{value:long}}})})
  const cursor=part.next_cursor;let assembled=part.content
  await reject(()=>gateway.handle(pool,req('two'),{action:'read_page',cursor},deps),'HRMS_RESULT_EXPIRED')
  while(!part.complete){part=await gateway.handle(pool,req('one'),{action:'read_page',cursor:part.next_cursor},deps);assembled+=part.content}
  check(JSON.parse(assembled).value,long)
  delete process.env.HRMS_AGENT_WRITES_ENABLED
  await reject(()=>gateway.handle(pool,req('one'),{action:'execute',plan_id:plan.plan_id},deps),'HRMS_WRITES_DISABLED')
  const {registerHrmsTools}=await import('../simple-mind-map/bin/hrmsAgent/mcp.mjs')
  const {z}=require('../simple-mind-map/node_modules/zod')
  let tool
  registerHrmsTools({tool:(name,description,shape,handler)=>{tool={name,description,shape,handler}}},{z,api:async(path,options)=>{check(path,'/api/integrations/hrms/agent');return {item:JSON.parse(options.body)}},ok:v=>v,fail:e=>({isError:true})})
  check(tool.name,'hrms_api')
  check(z.object(tool.shape).safeParse({action:'execute',plan_id:'invalid'}).success,false)
  check((await tool.handler({action:'catalog'})).action,'catalog')
  console.log(JSON.stringify({ok:true,checks,isolatedDatabase:true,realHrmsCalls:0,realBusinessWrites:0}))
 }finally{await pool.end();await admin.query('drop schema '+schema+' cascade');await admin.end()}
}
main().catch(e=>{console.error(e.stack || e);process.exitCode=1})
