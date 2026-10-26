const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const babel=require('@babel/core'),compiler=require('vue-template-compiler')
const parsed=compiler.parseComponent(fs.readFileSync(path.join(__dirname,'../src/pages/Edit/components/ConflictDraftInbox.vue'),'utf8'))
const code=babel.transformSync(parsed.script.content,{configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code
let principal='user',removed=[],discarded=[],messages=[]
const loaded={exports:{}}
new Function('require','module','exports',code)(id=>{
 if(id==='@/utils/conflictDraftPolicy')return require('./loadConflictTestUtility.cjs')('conflictDraftPolicy')
 if(id==='@/utils/conflictDraftDisplay')return require('./loadConflictTestUtility.cjs')('conflictDraftDisplay')
 if(id==='@/utils/roomLocation')return {roomFromLocation:()=> 'room'}
 if(id==='@/utils/conflictEdit')return {currentEditPrincipal:()=>principal,getEditCooperate:mm=>mm.cooperate}
 if(id==='@/utils/conflictDraftStore')return {removeConflictDraft:async item=>removed.push(item.key)}
 if(id==='./ConflictDraftPanel.vue')return {}
 throw Error(id)
},loaded,loaded.exports)
const component=loaded.exports.default
const session={id:'s',uid:'n',roomKey:'room',state:'conflict',fields:['text'],baseValues:{text:'before'},baseVersions:{text:4},draft:{text:'mine'}}
const item={key:'saved-key',room:'room',principal:'user',session,reason:'save_failed',error:{code:'NETWORK_ERROR'}}
function setup(commit){
 removed=[];discarded=[];messages=[];principal='user'
 const cooperate={getEditSession:()=>session,collabV2Adapter:{getStatus:()=>({phase:'LIVE'})},commitEditSession:commit,
  discardEditSession:id=>discarded.push(id),rebaseEditSession(){throw Error('automatic rebase forbidden')}}
 const vm={...component.data(),room:'room',mindMap:{cooperate},$t:key=>key,
  $message:{warning:m=>messages.push(m),error:m=>messages.push(m),success:m=>messages.push(m)}}
 for(const [key,method]of Object.entries(component.methods))vm[key]=method.bind(vm)
 vm.loadDrafts=async()=>{}
 vm.persistSessionEvent=async(s,error)=>{vm.retained={session:s,error}}
 return vm
}
;(async()=>{
 let release,calls=0
 const vm=setup(async(id,draft)=>{calls++;assert.equal(id,'s');assert.equal(draft.text,'mine');assert.equal(session.baseVersions.text,4);return new Promise(r=>{release=r})})
 const pending=vm.retryDraft(item)
 await vm.retryDraft(item)
 assert.equal(calls,1,'double-click cannot submit twice')
 await vm.onSessionFinished(session)
 assert.equal(removed.length,0,'session event alone is not an ACK for this retry')
 release({draftSaved:true,saved:true,version:5})
 await pending
 assert.deepEqual(removed,['saved-key']);assert.deepEqual(discarded,['s'])
 const queued=setup(async()=>({draftSaved:true,queued:true,version:0}))
 await queued.retryDraft(item);assert.equal(removed.length,0);assert.equal(discarded.length,0)
 const conflict=setup(async()=>{throw Object.assign(Error('field changed'),{code:'REPLACE_CONFLICT'})})
 await conflict.retryDraft(item);assert.equal(removed.length,0);assert.equal(conflict.retained.error.code,'REPLACE_CONFLICT')
 const changed=setup(async()=>new Promise(r=>{release=r}))
 const old=changed.retryDraft(item);principal='another-user';release({draftSaved:true,version:5});await old
 assert.equal(removed.length,0);assert.equal(discarded.length,0,'late ACK cannot clear another principal’s state')
 const blocked=setup(async()=>{throw Error('must not submit')})
 await blocked.retryDraft({...item,error:{code:'PRECONDITION_REQUIRED'}})
 assert.equal(removed.length,0)
 console.log('PASS original-baseline retry, double-click guard, ACK-only cleanup, queued/conflict preservation and principal isolation')
})().catch(error=>{console.error(error);process.exitCode=1})
