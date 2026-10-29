const assert=require('node:assert/strict')
async function main(){
  const {compactLeaveResult,registerApprovalTools}=await import('../simple-mind-map/bin/leaveWorkflow/mcp.mjs')
  const {z}=require('../simple-mind-map/node_modules/zod')
  const row={id:'00000000-0000-4000-8000-000000000001',revision:1,round:1,status:'draft',fields:{},steps:[],cc:['hr'],template:{source:{roomKey:'r',nodeUid:'n'},sourceNodeInput:true,autoApprove:true,fields:[]},report:{nodeInputHash:'hash',ccResolved:[{role:'对应HRBP',account:'hr',name:'测试HRBP',source:'人事组织架构',department:'测试组织',apiSecret:'never-return'}],missing:[],blockers:[],configurationRequired:[]}}
  const outputs=[]
  for(const status of ['pending','failed','synced']){
    const out=compactLeaveResult({...row,hrmsSync:{status,attempts:2,last_error:status==='failed'?'连接失败':'',synced_at:null,result:status==='synced'?{name:'hrms-doc',applicationNo:'WCPD-TEST',status:'已通过',apiSecret:'never-return'}:null,payload:{secret:'never-return'}}})
    assert.equal(out.hrms_sync.status,status)
    assert.equal(out.source_node_input,true)
    assert.equal(out.cc_resolved[0].name,'测试HRBP')
    assert.equal(JSON.stringify(out).includes('never-return'),false)
    outputs.push(out)
  }
  assert.equal(outputs[2].hrms_sync.result.application_no,'WCPD-TEST')
  assert.equal(compactLeaveResult(row).hrms_sync,null)
  const huge={...row,fields:{large:'大'.repeat(100000)},report:{...row.report,ccResolved:Array.from({length:100},(_,i)=>({role:'角色'.repeat(500),account:String(i),name:'姓名'.repeat(500),source:'来源'.repeat(500),department:'组织'.repeat(500),company:'企业'.repeat(500),employee:'员工'.repeat(500)}))},hrmsSync:{status:'synced',result:{applicationNo:'WCPD-TEST'}}}
  const brief=compactLeaveResult(huge)
  assert.ok(Buffer.byteLength(JSON.stringify(brief))<=48000)
  assert.equal(brief.cc_resolved_count,100)
  assert.equal(brief.cc_resolved_truncated,true)
  assert.equal(brief.hrms_sync.result.application_no,'WCPD-TEST')
  let schema,handler
  const calls=[]
  registerApprovalTools({tool(_name,_desc,s,h){schema=z.object(s);handler=h}},{z,ok:v=>v,fail:e=>({isError:true,error:e.message}),api:async(path,options)=>{calls.push({path,body:options?.body&&JSON.parse(options.body)});return row}})
  assert.equal(schema.safeParse({action:'prepare',use_source_node:'true'}).success,false)
  await handler(schema.parse({action:'prepare',room_key:'r',node_uid:'n',template_source:{room_key:'r',node_uid:'n'},use_source_node:true}))
  assert.deepEqual(calls[0].body,{roomKey:'r',nodeUid:'n',source:{roomKey:'r',nodeUid:'n'},useSourceNode:true})
  await handler(schema.parse({action:'prepare',template_source:{room_key:'r',node_uid:'n'},input_mode:'agent',fields:{金额:'123'}}))
  assert.equal(calls[1].body.inputMode,'agent');assert.deepEqual(calls[1].body.fields,{金额:'123'})
  await handler(schema.parse({action:'save',request_id:row.id,input_mode:'agent',fields:{金额:'456'},expected_revision:1,operation_id:'00000000-0000-4000-8000-000000000002'}))
  assert.equal(calls[2].path.endsWith('/save'),true);assert.equal(calls[2].body.nodeSource,false)
  assert.deepEqual(calls[2].body.fields,{金额:'456'})
  assert.equal(compactLeaveResult({...row,template:{...row.template,sourceNodeInput:false,agentInput:true},report:{...row.report,inputHash:'agent-hash'}}).validation.inputHash,'agent-hash')
  console.log('PASS: MCP source-node forwarding, resolved recipients, sync states, allowlisted output and bounded fallback')
}
main().catch(e=>{console.error(e);process.exitCode=1})
