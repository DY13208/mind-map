'use strict'
const path=require('node:path')
const {runCases}=require('./frontend-runner.cjs')
runCases('demonstrate-lifecycle',[
 {id:'R04-demonstrate-listeners',name:'real Demonstrate SFC unregisters only its two bus handlers on repeated destruction',
  observe:page=>page.evaluate(async()=>{
   const f=window.perfFrontend,mm=await f.createEngine(f.tree(4)),events=['demonstrate_jump','exit_demonstrate']
   const externalCounts={demonstrate_jump:0,exit_demonstrate:0},external={}
   events.forEach(event=>{external[event]=()=>externalCounts[event]++;f.bus.$on(event,external[event])})
   const count=()=>Object.fromEntries(events.map(event=>[event,(f.bus._events[event]||[]).length]))
   const baseline=count(),rounds=[],retired=[]
   try{
    for(let i=0;i<10;i++){
     const panel=f.mount(f.DemonstratePanel,{mindMap:mm}),vm=panel.component
     const owned={demonstrate_jump:(f.bus._events.demonstrate_jump||[]).includes(vm.onJump),exit_demonstrate:(f.bus._events.exit_demonstrate||[]).includes(vm.onExit)}
     f.bus.$emit('demonstrate_jump',2,9)
     const live={index:vm.curStepIndex,total:vm.totalStep}
     f.unmount(panel)
     const before={index:vm.curStepIndex,total:vm.totalStep,isEnter:vm.isEnterDemonstrate}
     f.bus.$emit('demonstrate_jump',7,11);f.bus.$emit('exit_demonstrate')
     const after={index:vm.curStepIndex,total:vm.totalStep,isEnter:vm.isEnterDemonstrate}
     rounds.push({owned,live,before,after,destroyed:vm._isDestroyed,listeners:count()});retired.push(vm)
    }
    return {baseline,rounds,externalPreserved:events.every(event=>(f.bus._events[event]||[]).includes(external[event])),externalCounts}
   }finally{events.forEach(event=>f.bus.$off(event,external[event]));mm.destroy()}
  }),checks:[
   {name:'mounted actual panel handles live jumps and owns both handlers',assert:(x,a)=>x.rounds.forEach(row=>{a.deepEqual(row.owned,{demonstrate_jump:true,exit_demonstrate:true});a.deepEqual(row.live,{index:2,total:9});a.equal(row.destroyed,true)})},
   {name:'each real unmount returns both event counts to baseline',assert:(x,a)=>x.rounds.forEach(row=>a.deepEqual(row.listeners,x.baseline))},
   {name:'late events never execute retired panel handlers',assert:(x,a)=>x.rounds.forEach(row=>a.deepEqual(row.after,row.before))},
   {name:'unrelated listeners remain registered and receive actual events',assert:(x,a)=>{a.equal(x.externalPreserved,true);a.deepEqual(x.externalCounts,{demonstrate_jump:20,exit_demonstrate:10})}}
  ]}
],{entry:path.join(__dirname,'demonstrate-browser-entry.js')})
