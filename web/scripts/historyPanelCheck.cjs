const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const compiler = require('../node_modules/vue-template-compiler')
const esbuild = require('../node_modules/esbuild')

function component(file, mocks = {}) {
  const script = compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')).script.content
  const code = esbuild.transformSync(script, {format:'cjs'}).code
  const mod={exports:{}}
  new Function('require','module','exports',code)(name=>mocks[name] || {},mod,mod.exports)
  return mod.exports.default
}

async function main() {
  let resolveTree
  let exported
  const reads=[]
  let resolvePage
  const panel=component('pages/ProductShell/components/HistoryPanel.vue',{
    '@/services/historyService':{
      getVersionTree:(room,version,options)=>{reads.push({room,version,options});return new Promise(resolve=>{resolveTree=resolve})},
      listVersions:()=>new Promise(resolve=>{resolvePage=resolve})
    },
    '@/services/historyExport':{exportHistoryVersion:async args=>{exported=args;return 'download'}},
    '@/utils/historySnapshot':{prepareHistorySnapshot:tree=>({tree})}
  })
  const vm={...panel.data(),...panel.methods,visible:true,roomKey:'source-room',room:{title:'历史脑图'},$nextTick:async()=>{},$refs:{exportDialog:{open(){}}}}
  await vm.openExport({versionId:'version-A',createdAt:'2026-10-13T01:00:00Z'})
  const request={type:'json',fileName:'history'}
  const task=vm.executeHistoryExport(request)
  vm.selected={versionId:'version-B'}
  resolveTree({tree:{data:{uid:'A',text:'历史A'},children:[]},metadata:{layout:'logicalStructure'}})
  assert.equal(await task,'download')
  assert.equal(reads[0].room,'source-room')
  assert.equal(reads[0].version,'version-A')
  assert.equal(exported.tree.data.uid,'A')
  assert.equal(exported.request,request)
  assert.equal(vm.exporting,false)
  // 关闭/取消之后，迟到的读取不能导出。
  exported=null
  await vm.openExport({versionId:'version-C',createdAt:'2026-10-13T01:00:00Z'})
  const cancelled=vm.executeHistoryExport(request)
  vm.cancelExport()
  assert.equal(reads[1].options.signal.aborted,true)
  resolveTree({tree:{data:{uid:'C'},children:[]}})
  await assert.rejects(cancelled,{name:'AbortError'})
  assert.equal(exported,null)
  // 单任务约束及不可重建版本入口。
  await vm.openExport({versionId:'version-D',createdAt:'2026-10-13T01:00:00Z'})
  const running=vm.executeHistoryExport(request)
  await assert.rejects(vm.executeHistoryExport(request))
  await vm.openExport({versionId:'version-E',createdAt:'2026-10-13T01:00:00Z'})
  assert.equal(vm._exportTarget.versionId,'version-D')
  resolveTree({tree:{data:{uid:'D'},children:[]}})
  await running
  vm.cancelExport()
  await vm.openExport({versionId:'unreadable',availability:'unreadable'})
  assert.equal(vm._exportTarget,null)
  vm._reloadToken=1;vm.nextCursor='old-cursor';vm.versions=[{versionId:'old'}]
  const pagination=vm.loadMore()
  vm._reloadToken=2;vm.versions=[{versionId:'fresh'}]
  resolvePage({list:[{versionId:'stale-page'}],nextCursor:'stale'})
  await pagination
  assert.deepEqual(vm.versions,[{versionId:'fresh'}])

  const index=component('pages/Edit/Index.vue',{'vuex':{mapMutations:()=>({}),mapState:()=>({})}})
  const map={opt:{},keyCommand:{isPause:false,pause(){this.isPause=true},recovery(){this.isPause=false}}}
  const editor={$refs:{editor:{mindMap:map}}}
  const set=index.methods.setHistoryInteractionPaused.bind(editor)
  set(true);assert.equal(map.opt.historyInteractionPaused,true);assert.equal(map.keyCommand.isPause,true)
  set(false);assert.equal(map.opt.historyInteractionPaused,false);assert.equal(map.keyCommand.isPause,false)
  map.keyCommand.isPause=true
  set(true);set(false);assert.equal(map.keyCommand.isPause,true)
  console.log('PASS: pinned version export, stale fetch cancellation, single task, unreadable version and editor interaction pause restoration')
}
main().catch(error=>{console.error(error);process.exitCode=1})
