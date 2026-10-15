'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('cooperate-transient-lifecycle', [
 { id:'R06-transient-exit',name:'actual Edit final A backup and durable enqueue release retired ACK/text-flush references',
  observe:page=>page.evaluate(async()=>{
   const f=window.perfFrontend,editor=await f.mountEditor('transient-exit-A'),mm=editor.component.mindMap,data=f.tree(8),container=mm.el
   await f.waitRender(mm,()=>mm.setData(data));const v2=await f.connectV2(mm,data,'transient-exit-A'),co=v2.co
   let draftComplete,outboxComplete
   const draftDone=new Promise(resolve=>{draftComplete=resolve}),outboxDone=new Promise(resolve=>{outboxComplete=resolve})
   const writes=[],outboxWrites=[],original=IDBObjectStore.prototype.put
   IDBObjectStore.prototype.put=function(value,key){
    if(key==='room:transient-exit-A'){writes.push({key,text:value.root.children[0].data.text});this.transaction.addEventListener('complete',()=>draftComplete())}
    if(this.transaction.db.name==='mind-map-collab-v2'&&this.name==='outbox'&&value.roomKey==='transient-exit-A'){
     outboxWrites.push({opId:value.opId,roomKey:value.roomKey,text:value.payload.text});this.transaction.addEventListener('complete',()=>outboxComplete())
    }
    return original.call(this,value,key)
   }
   try{
    const node=mm.renderer.findNodeByUid('n0'),edit=mm.renderer.textEdit
    await edit.show({node,forceEdit:true});edit.textEditNode.innerText='Final transient A'
    edit.textEditNode.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Final transient A'}))
    f.unmount(editor);await v2.adapter.disconnect()
    await Promise.race([Promise.all([draftDone,outboxDone]),f.pause(5000).then(()=>{throw Error('actual final draft/outbox transaction did not complete')})])
    await f.pause(250)
    const status=v2.adapter.getStatus()
    const rows=await new Promise((resolve,reject)=>{const open=indexedDB.open('mind-map-collab-v2',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('outbox','readonly'),req=tx.objectStore('outbox').getAll();req.onerror=()=>reject(req.error);req.onsuccess=()=>{resolve(req.result.filter(row=>row.roomKey==='transient-exit-A').map(row=>({opId:row.opId,roomKey:row.roomKey,status:row.status,text:row.payload.text})));db.close()}}})
    return{writes,outboxWrites,durableRows:rows,disposed:co._disposed,pendingUids:co.pendingUids.size,httpTextFlushPromise:!!co.httpTextFlushPromise,httpTextFlushing:co.httpTextFlushing,
     adapter:{phase:status.phase,roomKey:status.roomKey,pendingCount:status.pendingCount,outboxPending:status.outboxPending},oldCanvasEmpty:container.querySelectorAll('.smm-node').length===0}
   }finally{IDBObjectStore.prototype.put=original;await v2.adapter.disconnect()}
  }),checks:[
   {name:'actual final A draft and durable A operation are retained once after transaction completion',assert:(x,a)=>{a.deepEqual(x.writes,[{key:'room:transient-exit-A',text:'Final transient A'}]);a.equal(x.outboxWrites.length,1);a.equal(x.durableRows.length,1);a.equal(x.durableRows[0].opId,x.outboxWrites[0].opId);a.equal(x.durableRows[0].text,'Final transient A');a.equal(x.oldCanvasEmpty,true)}},
   {name:'retired model callbacks and adapter ACK references settle after an independent browser task',assert:(x,a)=>{a.equal(x.disposed,true);a.equal(x.pendingUids,0);a.equal(x.httpTextFlushPromise,false);a.equal(x.httpTextFlushing,false);a.deepEqual(x.adapter,{phase:'DISCONNECTED',roomKey:'',pendingCount:0,outboxPending:0})}}
  ]}
])
