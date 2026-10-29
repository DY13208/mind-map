const assert=require('node:assert/strict')
const review=require('../simple-mind-map/bin/leaveWorkflow/aiReview')
async function main(){
  Object.assign(process.env,{WCPD_AI_REVIEW_ENABLED:'1',WCPD_AI_REVIEW_DEFAULT:'1',WCPD_AI_REVIEW_API_KEY:'synthetic-key',WCPD_AI_REVIEW_BASE_URL:'http://127.0.0.1:9'})
  const original=global.fetch
  const make=()=>({status:'pending',current_step:0,fields:{amount:'55'},template:{kind:'generic',title:'隔离补贴审批',fingerprint:'test',fields:[{key:'amount',label:'补贴金额'}]},steps:[{role:'SSC',assigneeId:'ssc',criteria:[{uid:'truth',text:'加班真实性',context:['须确认']}]}]})
  try{
    for(const [decision,confidence,expected] of [['approve',0.95,'approved'],['reject',0.95,'rejected'],['escalate',0.9,'pending'],['approve',0.2,'pending']]){
      global.fetch=async url=>{assert.ok(url.startsWith('http://127.0.0.1:9/'));return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({decision,confidence,checked:['加班真实性'],matched:decision==='reject'?['补贴金额错误']:[],reason:'合成验证数据'})}}]})}}
      const row=make()
      await review.applyOnSubmit({query:async()=>({rows:[]})},row)
      assert.equal(row.status,expected)
      if(expected==='pending')assert.equal(row.steps[0].decision,undefined)
    }
    global.fetch=async()=>{throw Error('synthetic network failure')}
    const failed=make();await review.applyOnSubmit({},failed);assert.equal(failed.status,'pending')
    const manual=make();manual.template.humanOnly=true;assert.equal(await review.applyOnSubmit({},manual),null)
    console.log('PASS: Agent AI review follows configuration, confidence and failure handoff preserve human tasks, manual-only never auto-decides; no external calls')
  }finally{global.fetch=original}
}
main().catch(e=>{console.error(e);process.exitCode=1})
