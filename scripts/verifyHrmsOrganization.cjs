const assert=require('node:assert/strict')
const {config,role,resolveHrbp}=require('../simple-mind-map/bin/leaveWorkflow/hrmsOrganization')
const KEY='k'.repeat(40)
// 注意：organization.config 读 HRMS_ORG_*，换票客户端读 HRMS_API_BASE + EXTERNAL_API_EXCHANGE_KEY。
const env={
  HRMS_API_BASE:'https://hrms.test',
  HRMS_ORG_API_BASE:'https://hrms.test',
  HRMS_ORG_COMPANY:'测试公司',
  HRMS_ORG_CORP_ID:'corp',
  HRMS_CLIENT_NAME:'WCPD',
  EXTERNAL_API_EXCHANGE_KEY:KEY,
}
const user={id:'u1',wecomUserId:'test-user'}
const TOKEN='hrms_ext_abcdefghijkl'
// 换票客户端用 response.text() 读响应，不是 json()。
const res=payload=>({ok:true,status:200,text:async()=>JSON.stringify(payload)})
const issued=()=>res({code:0,success:true,msg:'成功',data:{
  access_token:TOKEN,token_type:'Bearer',expires_at:null,scope:'user',user:'u1',token_id:'1'}})
const found=hrbpStatus=>res({code:0,success:true,msg:'成功',data:{
  employee:'EMP-1',department:'测试部门',company:'测试公司',
  hrbp:{employee:'EMP-HR',name:'测试HRBP',wecomUserId:'hrbp-user',status:hrbpStatus}}})

async function main(){
 assert.equal(role('对应hrbp'),'hrbp')
 assert.equal(role('对应 HRBP'),'hrbp')
 assert.equal(role('it'),'it')
 assert.equal(role('黄贤润'),'')
 assert.equal(config({}).ready,false)

 const seen=[]
 const fetchImpl=async(rawUrl,options)=>{
  // 换票传的是字符串，查询传的是 URL 对象，统一成 URL。
  const url=typeof rawUrl==='string'?new URL(rawUrl):rawUrl
  seen.push(url.pathname)
  if(url.pathname==='/api/v1/hrms/external/issue-token'){
   assert.equal(options.method,'POST')
   assert.equal(options.headers['X-API-Exchange-Key'],KEY)
   assert.deepEqual(JSON.parse(options.body),{client_name:'WCPD',hr_wecom_id:'test-user'})
   return issued()
  }
  assert.equal(url.pathname,'/api/v1/hrms/external/directory/hrbp')
  assert.equal(url.searchParams.get('employee_ref'),'test-user')
  assert.equal(url.searchParams.get('company'),'测试公司')
  assert.equal(options.method,'GET')
  assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`)
  return found('Active')
 }
 const result=await resolveHrbp('test-user','corp',{env,fetchImpl,user})
 assert.equal(result.hrbp.wecomUserId,'hrbp-user')
 assert.deepEqual(seen,['/api/v1/hrms/external/issue-token','/api/v1/hrms/external/directory/hrbp'])

 await assert.rejects(()=>resolveHrbp('test-user','another-corp',{env,fetchImpl,user}),/企业不匹配/)
 await assert.rejects(()=>resolveHrbp('','corp',{env,fetchImpl,user}),/先.*填写/)
 // 非在职 HRBP 必须拒绝（token 已缓存，只打查询接口）
 await assert.rejects(()=>resolveHrbp('test-user','corp',{env,fetchImpl:async()=>found('Left'),user}),/在职/)
 console.log('PASS: HRMS organization roles, bearer exchange, scoped lookup, identity and active-HRBP guards')
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
