// Regression: edits made before node.insert's ACK must remain pending, not be
// mistaken for the text that was persisted by that insert.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict')
const parser=require('@babel/parser')
const source=fs.readFileSync(path.resolve(__dirname,'../../simple-mind-map/src/plugins/Cooperate.js'),'utf8')
const ast=parser.parse(source,{sourceType:'module'})
const body=ast.program.body.find(node=>node.type==='ClassDeclaration'&&node.id.name==='Cooperate').body.body
const methods=['acknowledgeInsertedNode','flushHttpInsertNow','syncHttpGeneralization'].map(name=>{const method=body.find(node=>node.key?.name===name);assert.ok(method,name);return source.slice(method.start,method.end)}).join('\n')
const gen=require('../../simple-mind-map/src/utils/collabGeneralization')
const context={module:{exports:{}},collabGeneralization:gen,generalizationSignature:gen.generalizationSignature,v2Trace(){},isPermanentNodeError:()=>false,console,
  collabPasteUndo:{pasteUndoInverse:()=>({}),forestRootsFromInserts:()=>[],publishPasteUndoTrace(){}}}
vm.runInNewContext(`class Insert {${methods}};module.exports=Insert`,context)
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
async function test(batch){
 const owner=new context.module.exports(),started=deferred(),ack=deferred(),sent=[],data=[{text:'default A',style:{color:'red'}},{text:'default B'}]
 Object.assign(owner,{collabV2Adapter:{},pendingUids:new Set(),acked:new Set(),lastPushed:{},recentPushed:new Map(),scheduled:0,
  isPersistAcked(uid){return this.acked.has(uid)},isTombstonedUid:()=>false,flushHttpTextNow:async()=>false,
  mindMap:{renderer:{findNodeByUid(uid){const i=Number(uid.slice(1));return{getData:k=>k?data[i][k]:data[i]}}}},
  markUidPushed(uid,snapshot){this.acked.add(uid);this.pendingUids.delete(uid);this.lastPushed[uid]=snapshot},
  hasUnsyncedLocalText(node){const text=node.getData('text');return !Object.values(this.lastPushed).some(row=>row.text===text)},
  scheduleHttpTextSync(){this.scheduled++},
  httpAddNode:async payload=>{sent.push(JSON.parse(JSON.stringify(payload)));started.resolve();await ack.promise},
  submitV2:async(type,payload)=>{sent.push(JSON.parse(JSON.stringify(payload)));started.resolve();await ack.promise;return{opId:'qa-op'}}
 })
 const rows=data.slice(0,batch?2:1).map((d,i)=>({uid:'n'+i,parent:'root',index:i,text:d.text,data:d}))
 const pending=owner.flushHttpInsertNow({fromCommand:true,preRecords:rows})
 await started.promise
 data[0].text='Typed before ACK';data[0].style.color='blue';if(batch)data[1].text='Second typed before ACK'
 ack.resolve();await pending
 assert.equal(owner.lastPushed.n0.text,'default A','ACK baseline must contain sent text')
 assert.equal(owner.lastPushed.n0.style.color,'red','ACK must not capture a live nested style mutation')
 assert(owner._pendingTextUids.has('n0'),'newer text must remain queued')
 if(batch){assert.equal(owner.lastPushed.n1.text,'default B');assert(owner._pendingTextUids.has('n1'))}
 assert.equal(owner.scheduled,batch?2:1)
 assert.equal(sent[0].ops?sent[0].ops[0].payload.data.text:sent[0].data.text,'default A')
 console.log('PASS',batch?'batch inserts':'single insert','preserve text typed before ACK')
}
async function summaries(){
 const summary=[{uid:'summary',text:'summary',range:[0,0]}]
 for(const [previous,next,expected] of [[undefined,null,0],[null,[],0],[summary,summary,0],[summary,null,1],[undefined,summary,1]]){
  const owner=new context.module.exports(),sent=[],data={uid:'owner',text:'owner',generalization:next},node={getData:key=>key?data[key]:data}
  Object.assign(owner,{httpCollabMode:true,mindMap:{renderer:{activeNodeList:[]}},lastPushed:{owner:{text:'owner',note:'',full:{text:'owner',note:'',...(previous===undefined?{}:{generalization:previous})}}},
   nodePlain:()=>data.text,setGenIntent(){},stampLocalFieldVersion(){},nodePatchPayload:()=>data,
   httpPatchNode:(uid,patch)=>{sent.push({uid,patch});return Promise.resolve()}})
  owner.syncHttpGeneralization(node);await Promise.resolve();assert.equal(sent.length,expected)
 }
 console.log('PASS moving an ordinary node creates no empty summary undo step; summary edits and removal still sync')
}
;(async()=>{await test(false);await test(true);await summaries()})().catch(error=>{console.error(error);process.exitCode=1})
