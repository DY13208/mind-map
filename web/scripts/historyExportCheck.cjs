const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const compiler = require('../node_modules/vue-template-compiler')
const esbuild = require('../node_modules/esbuild')
const parsed=compiler.parseComponent(fs.readFileSync(path.join(__dirname,'../src/pages/Edit/components/Export.vue'),'utf8'))
assert.deepEqual(compiler.compile(parsed.template.content).errors,[])
const code=esbuild.transformSync(parsed.script.content,{format:'cjs'}).code
const mod={exports:{}}
new Function('require','module','exports',code)(name=>{
  if(name==='vuex')return {mapState:()=>({}),mapMutations:()=>({})}
  if(name==='@/config')return {downTypeList:{zh:['smm','png','svg','pdf','md','xmind','txt','json','xlsx','mm'].map(type=>({type}))}}
  if(name==='simple-mind-map/src/utils/index')return {isMobile:()=>false}
  return {}
},mod,mod.exports)
const component=mod.exports.default
function vm(managed=true){
  const events=[]
  const bus=[]
  const result={managed,defaultFileName:'版本A',$t:key=>key,$i18n:{locale:'zh'},
    $nextTick:fn=>{if(fn)fn();return Promise.resolve()},$emit:(...args)=>events.push(args),
    $bus:{$emit:(...args)=>bus.push(args)},$message:{error:message=>events.push(['error',message])},$notify:{info:()=>{}},
    setExtraTextOnExport:text=>bus.push(['footer',text]),events,bus}
  Object.assign(result,component.data.call(result),component.methods)
  return result
}
async function main(){
  const dialog=vm()
  assert.deepEqual(component.computed.downTypeList.call(dialog).map(row=>row.type),['smm','png','svg','pdf','md','xmind','txt','json'])
  let resolveExport
  let received
  dialog.executeExport=request=>{received=request;return new Promise(resolve=>{resolveExport=resolve})}
  dialog.open();dialog.onPaddingChange()
  const job=dialog.confirm()
  assert.equal(dialog.loading,true)
  assert.equal(received.fileName,'版本A');assert.equal(received.withConfig,true)
  await dialog.confirm();assert.equal(dialog.operationToken,1)
  resolveExport();await job
  assert.equal(dialog.dialogVisible,false)
  assert.equal(dialog.events.filter(e=>e[0]==='completed').length,1)
  assert.deepEqual(dialog.bus,[])

  const fail=vm();fail.executeExport=async()=>{throw new Error('资源不可用')};fail.open();await fail.confirm()
  assert.equal(fail.dialogVisible,true);assert.equal(fail.loading,false)
  assert.equal(fail.events.some(e=>e[0]==='error'&&e[1]==='资源不可用'),true)
  assert.equal(fail.events.some(e=>e[0]==='completed'),false)

  const cancel=vm();cancel.executeExport=()=>new Promise(resolve=>{resolveExport=resolve});cancel.open()
  const stale=cancel.confirm();cancel.cancel();resolveExport();await stale
  assert.equal(cancel.events.filter(e=>e[0]==='cancelled').length,1)
  assert.equal(cancel.events.some(e=>e[0]==='completed'),false)

  const ordinary=vm(false);ordinary.open();ordinary.exportType='png';ordinary.extraText='普通页脚'
  await ordinary.confirm()
  assert.deepEqual(ordinary.bus[0],['footer','普通页脚'])
  assert.equal(ordinary.bus[1][0],'export');assert.equal(ordinary.bus[1][1],'png')
  // Exercise the actual timeout helper without waiting for a network timeout.
  const serviceCode=esbuild.transformSync(fs.readFileSync(path.join(__dirname,'../src/services/historyExport.js'),'utf8'),{format:'cjs'}).code
  const service={exports:{}}
  const timers=new Map()
  let nextTimer=0
  new Function('require','module','exports','setTimeout','clearTimeout',serviceCode+'\nmodule.exports.waitForTaskOrAbort=waitForTaskOrAbort;')(
    name=>name==='simple-mind-map/src/plugins/RichText.js'?class RichText {}:{},service,service.exports,
    (callback,delay)=>{assert.equal(delay,60000);timers.set(++nextTimer,callback);return nextTimer},
    id=>timers.delete(id)
  )
  let finishLate
  const stalled=service.exports.waitForTaskOrAbort(new Promise(resolve=>{finishLate=resolve}),new AbortController().signal)
  timers.values().next().value()
  await assert.rejects(stalled,/资源加载超时/)
  assert.equal(timers.size,0)
  finishLate('late export result')
  console.log('PASS: shared eight formats/options, managed request isolation, busy guard, retry/cancel and ordinary export compatibility')
}
main().catch(error=>{console.error(error);process.exitCode=1})
