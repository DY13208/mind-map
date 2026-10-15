'use strict'
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {createCollaborationAdapter}=require('../../simple-mind-map/bin/collabV2/adapter')
const {memoryOutbox}=require('../../simple-mind-map/bin/collabV2/outbox')
const phase=process.env.PERF_TDD_PHASE||'red',label=process.env.PERF_TDD_LABEL||'baseline'
assert.ok(['red','green'].includes(phase));assert.match(label,/^[a-z0-9_-]+$/)
const dest=path.resolve(__dirname,'../../work/performance-tdd',phase,'frontend','adapter-transient-lifecycle-'+label+'.json')
if(fs.existsSync(dest))throw Error('refusing overwrite '+dest)
const delay=ms=>new Promise(r=>setTimeout(r,ms)),deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const adapterFile=path.resolve(__dirname,'../../simple-mind-map/bin/collabV2/adapter.js')
const report={phase,adapterSourceFile:adapterFile,adapterSourceHash:crypto.createHash('sha256').update(fs.readFileSync(adapterFile)).digest('hex'),nodeVersion:process.version,startedAt:new Date().toISOString(),scope:'Actual production adapter and production memory outbox. Controlled socket ACK and durable-put boundaries, not PG/real Socket E2E.',cases:[]}
function socketFixture(){const held=[];return{held,connected:true,id:'owned-test-socket',on(){},off(){},disconnect(){this.connected=false},connect(){this.connected=true},emit(event,payload,cb){if(event==='join'||event==='sync')cb({ok:true,role:'editor',canEdit:true,canView:true,peers:[],serverRevision:0,operations:[],hasMore:false});else if(event==='op')held.push({payload,cb});else if(cb)cb({ok:true})}}}
async function observe({putBlocked}){
 const socket=socketFixture(),outbox=memoryOutbox(),putEntered=deferred(),putRelease=deferred(),originalPut=outbox.put
 if(putBlocked)outbox.put=async op=>{await originalPut(op);putEntered.resolve();await putRelease.promise;return op}
 const adapter=createCollaborationAdapter({socket,outbox,clientId:crypto.randomUUID(),timeoutMs:15000})
 let settled=false,result=null
 try{
  await adapter.connect({roomKey:'transient-A',userId:'test-owner',lastServerRevision:0})
  const opId=crypto.randomUUID(),pending=adapter.submitOperation({opId,type:'node.update',roomKey:'transient-A',payload:{uid:'n0',text:'Final A'}}).then(v=>{settled=true;result={ok:true,revision:v.serverRevision}},e=>{settled=true;result={ok:false,code:e.code}})
  if(putBlocked)await putEntered.promise
  else{const end=Date.now()+2000;while(!socket.held.length){if(Date.now()>end)throw Error('real sendOp did not emit');await delay(1)}}
  const before=adapter.getStatus()
  await adapter.disconnect()
  if(putBlocked)putRelease.resolve()
  await delay(25)
  const settledAfterExit=settled,resultAfterExit=result,after=adapter.getStatus(),durableAfterExit=(await outbox.list('','transient-A')).map(x=>({opId:x.opId,roomKey:x.roomKey,status:x.status,text:x.payload.text}))
  await adapter.connect({roomKey:'transient-B',userId:'test-owner',lastServerRevision:0})
  const bBefore=adapter.getStatus()
  for(const held of socket.held.splice(0))held.cb({ok:true,opId:held.payload.opId,serverRevision:1})
  await delay(25)
  const bAfter=adapter.getStatus()
  return{putBlocked,opId,before:{pendingCount:before.pendingCount,outboxPending:before.outboxPending},settledAfterExit,result:resultAfterExit,after:{pendingCount:after.pendingCount,outboxPending:after.outboxPending,phase:after.phase,roomKey:after.roomKey},durableAfterExit,beforeB:{head:bBefore.lastServerRevision,undo:bBefore.undoDepth},afterB:{head:bAfter.lastServerRevision,undo:bAfter.undoDepth,phase:bAfter.phase,roomKey:bAfter.roomKey},remainingA:(await outbox.list('','transient-A')).map(x=>({opId:x.opId,roomKey:x.roomKey,status:x.status}))}
 }finally{putRelease.resolve();for(const held of socket.held.splice(0))held.cb({ok:true,opId:held.payload.opId,serverRevision:1});await delay(10);await adapter.disconnect()}
}
async function observeRejectedPut() {
 const socket=socketFixture(),outbox=memoryOutbox(),entered=deferred(),release=deferred()
 outbox.put=async()=>{entered.resolve();await release.promise;const error=new Error('owned delayed durable put failure');error.code='OWNED_OUTBOX_FAILURE';throw error}
 const adapter=createCollaborationAdapter({socket,outbox,clientId:crypto.randomUUID(),timeoutMs:15000})
 let result=null
 try{
  await adapter.connect({roomKey:'rejected-A',userId:'owner-A',lastServerRevision:0})
  const pending=adapter.submitOperation({type:'node.update',payload:{uid:'n0',text:'Failed A write'}}).then(()=>{result={ok:true}},e=>{result={ok:false,code:e.code}})
  await entered.promise;await adapter.disconnect();await adapter.connect({roomKey:'rejected-B',userId:'owner-B',lastServerRevision:0})
  const before=adapter.getStatus();release.resolve();await pending;await delay(1);const after=adapter.getStatus()
  return{before:{phase:before.phase,currentError:before.currentError},after:{phase:after.phase,currentError:after.currentError,roomKey:after.roomKey},result,durableA:(await outbox.list('','rejected-A')).length}
 }finally{release.resolve();await adapter.disconnect()}
}

async function observeStoreCompletion() {
 const socket=socketFixture(),outbox=memoryOutbox(),entered=deferred(),release=deferred(),remove=outbox.remove
 outbox.remove=async opId=>{await remove(opId);entered.resolve();await release.promise}
 const emit=socket.emit
 socket.emit=function(event,payload,cb){if(event==='op'){cb({ok:true,opId:payload.opId,serverRevision:1});return}return emit.call(this,event,payload,cb)}
 const adapter=createCollaborationAdapter({socket,outbox,clientId:crypto.randomUUID(),timeoutMs:15000})
 let result=null
 try {
  await adapter.connect({roomKey:'store-A',userId:'owner-A',lastServerRevision:0})
  const pending=adapter.submitOperation({type:'node.update',payload:{uid:'n0',text:'Known committed A'}}).then(v=>{result={ok:true}},e=>{result={ok:false,code:e.code}})
  await entered.promise
  await adapter.disconnect()
  await adapter.connect({roomKey:'store-B',userId:'owner-B',lastServerRevision:0})
  const before=adapter.getStatus()
  release.resolve();await delay(25)
  const after=adapter.getStatus()
  return { before:{head:before.lastServerRevision,undo:before.undoDepth},after:{head:after.lastServerRevision,undo:after.undoDepth,roomKey:after.roomKey,phase:after.phase},result,durableA:(await outbox.list('','store-A')).length }
 }finally{release.resolve();await delay(10);await adapter.disconnect()}
}

;(async()=>{try{for(const putBlocked of[false,true]){const row={id:putBlocked?'R06-adapter-enqueue-exit':'R06-adapter-ack-exit',assertions:[]};try{row.observed=await observe({putBlocked});const x=row.observed;for(const[name,check]of[
 ['leaving room settles transient caller without pending ACK references',()=>{assert.equal(x.after.pendingCount,0);assert.equal(x.after.outboxPending,0);assert.equal(x.settledAfterExit,true);assert.equal(x.result.ok,false);assert.equal(x.result.code,'ROOM_LEFT')}],
 ['durable A operation stays replayable after leaving room and stale ACK',()=>{assert.equal(x.durableAfterExit.length,1);assert.equal(x.durableAfterExit[0].opId,x.opId);assert.equal(x.durableAfterExit[0].roomKey,'transient-A');assert.equal(x.remainingA.length,1);assert.equal(x.remainingA[0].opId,x.opId)}],
 ['late A callback cannot advance B head or B undo',()=>{assert.equal(x.afterB.roomKey,'transient-B');assert.equal(x.afterB.phase,'LIVE');assert.equal(x.afterB.head,x.beforeB.head);assert.equal(x.afterB.undo,x.beforeB.undo)}]
 ]){try{check();row.assertions.push({name,status:'PASS'})}catch(e){if(!(e instanceof assert.AssertionError))throw e;row.assertions.push({name,status:'RED_CONFIRMED',message:e.message})}}row.status=row.assertions.some(x=>x.status==='RED_CONFIRMED')?(phase==='red'?'RED_CONFIRMED':'REGRESSION_FAILED'):(phase==='red'?'BASELINE_PROTECTION_PASS':'GREEN_CONFIRMED')}catch(e){row.status='BLOCKED_ENV';row.error=e.stack}report.cases.push(row);console.log(JSON.stringify(row))}
 const row={id:'R06-adapter-store-completion-exit',assertions:[]}
 try{row.observed=await observeStoreCompletion();const x=row.observed;for(const[name,check]of[
 ['known A ACK before exit may remove A durable row but completes only A caller',()=>{assert.equal(x.durableA,0);assert.deepEqual(x.result,{ok:false,code:'ROOM_LEFT'})}],
 ['old ACK store completion cannot mutate replacement B revision or undo',()=>{assert.equal(x.after.roomKey,'store-B');assert.equal(x.after.phase,'LIVE');assert.equal(x.after.head,x.before.head);assert.equal(x.after.undo,x.before.undo)}]
 ]){try{check();row.assertions.push({name,status:'PASS'})}catch(e){if(!(e instanceof assert.AssertionError))throw e;row.assertions.push({name,status:'RED_CONFIRMED',message:e.message})}}row.status=row.assertions.some(x=>x.status==='RED_CONFIRMED')?(phase==='red'?'RED_CONFIRMED':'REGRESSION_FAILED'):(phase==='red'?'BASELINE_PROTECTION_PASS':'GREEN_CONFIRMED')}catch(e){row.status='BLOCKED_ENV';row.error=e.stack}report.cases.push(row);console.log(JSON.stringify(row))
 const rejected={id:'R06-adapter-put-rejection-exit',assertions:[]}
 try{rejected.observed=await observeRejectedPut();const x=rejected.observed;for(const[name,check]of[
 ['failed A durable put rejects A caller without inventing persisted rows',()=>{assert.equal(x.result.ok,false);assert.equal(x.result.code,'OWNED_OUTBOX_FAILURE');assert.equal(x.durableA,0)}],
 ['old A outbox rejection cannot set replacement B error status',()=>{assert.equal(x.after.roomKey,'rejected-B');assert.equal(x.after.phase,'LIVE');assert.deepEqual(x.after.currentError,x.before.currentError)}]
 ]){try{check();rejected.assertions.push({name,status:'PASS'})}catch(e){if(!(e instanceof assert.AssertionError))throw e;rejected.assertions.push({name,status:'RED_CONFIRMED',message:e.message})}}rejected.status=rejected.assertions.some(x=>x.status==='RED_CONFIRMED')?(phase==='red'?'RED_CONFIRMED':'REGRESSION_FAILED'):(phase==='red'?'BASELINE_PROTECTION_PASS':'GREEN_CONFIRMED')}catch(e){rejected.status='BLOCKED_ENV';rejected.error=e.stack}report.cases.push(rejected);console.log(JSON.stringify(rejected))}
 finally{report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log('ADAPTER_TRANSIENT_LIFECYCLE_REPORT '+dest);if(report.cases.some(x=>x.status==='BLOCKED_ENV'))process.exitCode=2;else if(report.cases.some(x=>['RED_CONFIRMED','REGRESSION_FAILED'].includes(x.status)))process.exitCode=1}})()
