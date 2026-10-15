'use strict'
const path=require('node:path')
const {runCases}=require('./frontend-runner.cjs')
runCases('cooperate-replay-lifecycle',['event-first','ack-first','duplicates'].map(mode=>(
 {id:'R06-fresh-actor-durable-replay-'+mode,name:'fresh real Edit with same stable clientId applies its durable A replay once while peer receives canonical operation',
  observe:page=>page.evaluate(async({mode})=>{
   const f=window.perfFrontend,roomKey='fresh-replay-'+crypto.randomUUID(),clientId=crypto.randomUUID(),data=f.tree(4),target='Final durable A replay'
   await f.requestMemory('seed',{roomKey,tree:data})
   const old=f.mountEditor?await f.mountEditor(roomKey):null,oldMM=old.component.mindMap
   await f.waitRender(oldMM,()=>oldMM.setData(structuredClone(data)))
   const original=await f.connectStableV2(oldMM,data,roomKey,clientId),outbox=f.createOutbox()
   let actor,peer,peerMM
   try{
    original.socket.disconnect()
    oldMM.renderer.findNodeByUid('n0').setText(target,false)
    const flush=original.co.flushHttpTextNow()
    const deadline=Date.now()+8000
    let rows=[]
    while(!(rows=await outbox.list(clientId,roomKey)).length){if(Date.now()>deadline)throw Error('actual original durable operation was not enqueued');await f.pause(10)}
    const opId=rows[0].opId,queued={opId,clientId:rows[0].clientId,roomKey:rows[0].roomKey,text:rows[0].payload.text,status:rows[0].status}
    f.unmount(old);await original.adapter.disconnect();await flush
    const before=await f.requestMemory('state',{roomKey})
    peerMM=await f.createEngine(structuredClone(data))
    peer=await f.connectStableV2(peerMM,data,roomKey,crypto.randomUUID())
    actor=await f.mountEditor(roomKey);const mm=actor.component.mindMap
    await f.waitRender(mm,()=>mm.setData(structuredClone(data)))
    const freshInitial=mm.renderer.findNodeByUid('n0').getData('text')
    const fresh=await f.connectStableV2(mm,data,roomKey,clientId,mode)
    const settle=Date.now()+8000
    while(fresh.ack.length!==1||fresh.events.length!==(mode==='duplicates'?2:1)||peer.events.length!==(mode==='duplicates'?2:1)||fresh.adapter.getStatus().lastServerRevision!==1||(await outbox.list(clientId,roomKey)).length||mm.renderer.isRendering||peerMM.renderer.isRendering||peer.co._remoteGeometryTimer||fresh.co._remoteGeometryTimer){
     if(Date.now()>settle)throw Error('actual replay ACK/transport/model settle timeout')
     await f.pause(20)
    }
    await f.pause(30)
    const state=await f.requestMemory('state',{roomKey}),describe=map=>{const node=map.renderer.findNodeByUid('n0'),text=node._textData?.node?.node;return{model:node.getData('text'),raw:map.renderer.renderTree.children[0].data.text,dom:text&&text.textContent,connected:!!text?.isConnected,visible:node.checkIsInClient(map.opt.performanceConfig.padding)}}
    const result={mode,clientId,opId,queued,before:{revision:before.revision,text:before.nodes.n0.data.text,operations:before.operations.length},freshInitial,
     after:{revision:state.revision,text:state.nodes.n0.data.text,opIds:state.operations.map(op=>op.opId)},freshClientId:fresh.adapter.getClientId(),freshAck:fresh.ack,freshEvents:fresh.events,peerEvents:peer.events,
     actor:describe(mm),peer:describe(peerMM),freshStatus:{head:fresh.adapter.getStatus().lastServerRevision,pending:fresh.adapter.getStatus().pendingCount,outbox:fresh.adapter.getStatus().outboxPending},durableRemaining:(await outbox.list(clientId,roomKey)).length}
    await fresh.adapter.disconnect()
    return result
   }finally{if(actor)f.unmount(actor);if(peer)await peer.adapter.disconnect();if(peerMM)peerMM.destroy();await original.adapter.disconnect()}
  },{mode}),checks:[
   {name:'fresh actor starts old and original same-id durable operation actually commits exactly once',assert:(x,a)=>{a.equal(x.before.revision,0);a.equal(x.before.text,'Node 0');a.equal(x.before.operations,0);a.equal(x.freshInitial,'Node 0');a.equal(x.queued.clientId,x.clientId);a.equal(x.freshClientId,x.clientId);a.equal(x.after.revision,1);a.equal(x.after.text,'Final durable A replay');a.deepEqual(x.after.opIds,[x.opId]);a.equal(x.freshAck.length,1);a.equal(x.freshAck[0].opId,x.opId);a.equal(x.freshAck[0].clientId,x.clientId);a.equal(x.durableRemaining,0)}},
   {name:'same-client fresh actor current model and visible DOM reach acknowledged A replay',assert:(x,a)=>{a.equal(x.actor.model,'Final durable A replay');a.equal(x.actor.raw,x.actor.model);a.equal(x.actor.dom,x.actor.model);a.equal(x.actor.connected,true);a.equal(x.actor.visible,true);a.deepEqual(x.freshStatus,{head:1,pending:0,outbox:0})}},
   {name:'different-client actual peer receives original canonical operation and visible update',assert:(x,a)=>{a.equal(x.peerEvents.length,x.mode==='duplicates'?2:1);a.equal(x.peerEvents[0].opId,x.opId);a.equal(x.peer.model,'Final durable A replay');a.equal(x.peer.dom,x.peer.model);a.equal(x.peer.connected,true)}}
  ]}
 )).concat([
 {id:'R06-ordinary-self-echo-protection',name:'ordinary optimistic local edit keeps self echo suppression and no duplicate remote notification',
  observe:page=>page.evaluate(async()=>{
   const f=window.perfFrontend,roomKey='ordinary-self-'+crypto.randomUUID(),data=f.tree(4),clientId=crypto.randomUUID()
   await f.requestMemory('seed',{roomKey,tree:data});const editor=await f.mountEditor(roomKey),mm=editor.component.mindMap
   await f.waitRender(mm,()=>mm.setData(structuredClone(data)));const session=await f.connectStableV2(mm,data,roomKey,clientId,'duplicates')
   const notices=[],listener=(tree,change)=>{if(change&&change.source==='remote')notices.push(change.affectedUids)}
   mm.on('data_change',listener)
   try{mm.renderer.findNodeByUid('n0').setText('Ordinary local text',false);await session.co.flushHttpTextNow();await f.pause(400)
    const state=await f.requestMemory('state',{roomKey}),node=mm.renderer.findNodeByUid('n0')
    return{notices,ack:session.ack,events:session.events,operations:state.operations.length,text:node.getData('text'),dom:node._textData.node.node.textContent,connected:node._textData.node.node.isConnected}
   }finally{mm.off('data_change',listener);f.unmount(editor);await session.adapter.disconnect()}
  }),checks:[{name:'actual original operation once, optimistic current DOM retained, self broadcast never becomes remote content delta',assert:(x,a)=>{a.equal(x.operations,1);a.equal(x.ack.length,1);a.equal(x.events.length,2);a.equal(x.text,'Ordinary local text');a.equal(x.dom,x.text);a.equal(x.connected,true);a.deepEqual(x.notices,[])}}]}
 ]),{entry:path.join(__dirname,'cooperate-replay-browser-entry.js')})
