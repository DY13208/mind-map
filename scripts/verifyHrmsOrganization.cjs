const assert=require('node:assert/strict')
const {config,role,resolveHrbp}=require('../simple-mind-map/bin/leaveWorkflow/hrmsOrganization')
const env={HRMS_ORG_API_BASE:'http://hrms.local',HRMS_ORG_API_KEY:'testapikey123',HRMS_ORG_API_SECRET:'testsecret123',HRMS_ORG_CORP_ID:'corp',HRMS_ORG_COMPANY:'测试公司'}
async function main(){
 assert.equal(role('对应hrbp'),'hrbp')
 assert.equal(role('对应 HRBP'),'hrbp')
 assert.equal(role('it'),'it')
 assert.equal(role('黄贤润'),'')
 assert.equal(config({}).ready,false)
 let calls=0
 const fetchImpl=async(url,options)=>{
  calls++
  assert.equal(url.pathname,'/api/method/employee_roster.integrations.approval_directory.resolve_hrbp')
  assert.equal(url.searchParams.get('employee_ref'),'测试员工')
  assert.equal(url.searchParams.get('company'),'测试公司')
  assert.equal(options.method,'GET')
  assert.equal(options.headers.Authorization,'token testapikey123:testsecret123')
  return {ok:true,json:async()=>({message:{employee:'EMP-1',department:'测试部门',company:'测试公司',hrbp:{employee:'EMP-HR',name:'测试HRBP',wecomUserId:'hrbp-user',status:'Active'}}})}
 }
 const result=await resolveHrbp('测试员工','corp',{env,fetchImpl})
 assert.equal(result.hrbp.wecomUserId,'hrbp-user')
 await assert.rejects(()=>resolveHrbp('测试员工','another-corp',{env,fetchImpl}),/企业不匹配/)
 await assert.rejects(()=>resolveHrbp('','corp',{env,fetchImpl}),/先.*填写/)
 assert.equal(calls,1)
 await assert.rejects(()=>resolveHrbp('测试员工','corp',{env,fetchImpl:async()=>({ok:true,json:async()=>({message:{...result,hrbp:{...result.hrbp,status:'Left'}}})})}),/在职/)
 console.log('PASS: HRMS organization roles, scoped read-only lookup, identity and active-HRBP guards')
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
