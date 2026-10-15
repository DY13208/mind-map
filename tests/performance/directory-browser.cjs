const path = require('node:path')
const assert = require('node:assert/strict')
const { createHarness } = require('./engine-harness.cjs')

const contents = `
import Vue from 'vue'
import VueRouter from 'vue-router'
import Vuex from 'vuex'
import ElementUI from 'element-ui'
import FilesPage from './web/src/pages/ProductShell/FilesPage.vue'
import SpaceDetailPage from './web/src/pages/ProductShell/SpaceDetailPage.vue'
import SopRegistry from './web/src/pages/SopRegistry/Index.vue'
import { setProductHttp } from './web/src/services/productHttp'
Vue.use(VueRouter);Vue.use(Vuex);Vue.use(ElementUI)
Vue.prototype.$bus=new Vue()
window.__MIND_MAP_RUNTIME__={collabApi:window.location.origin}
const calls=[]
const searchJobs=[]
let deferSearch=false
let deniedTeam=false
const rows=Array.from({length:60},(_,i)=>({roomKey:'team-room-'+String(i+1).padStart(2,'0'),
  id:'team-room-'+String(i+1).padStart(2,'0'),title:i===20?'NeedleTeam21':'Team Room '+String(i+1).padStart(2,'0'),
  folderId:null,owner:{id:'owner',name:'Owner'},role:'owner',canEdit:true,canManage:true,revision:1,
  updatedAt:'2026-10-13T00:00:01.000Z',createdAt:'2026-10-13T00:00:00.000Z',
  contentUpdatedAt:'2026-10-13T00:00:01.000Z',resourceUpdatedAt:'2026-10-13T00:00:01.000Z',
  collaborators:[],favorite:false,folderName:'根目录'}))
const team={id:'team-a',name:'团队A',role:'owner',fileCount:60,roomCount:60,memberCount:1,owner:'Owner'}
async function transport(pathname,options={}){
  const url=new URL(pathname,window.location.origin);calls.push({url:url.pathname+url.search,method:options.method||'GET'})
  if(options.method && options.method!=='GET') throw new Error('Directory fixture is read-only: '+options.method+' '+url.pathname)
  const keyword=url.searchParams.get('q')||''
  if(deferSearch && keyword.startsWith('RaceSearch'))return new Promise((resolve,reject)=>{
    const job={keyword,resolve,signal:options.signal,aborted:false};searchJobs.push(job)
    if(options.signal)options.signal.addEventListener('abort',()=>{job.aborted=true;reject(Object.assign(new Error('Aborted'),{name:'AbortError'}))},{once:true})
  })
  if(url.pathname==='/api/teams')return {items:[team],list:[team]}
  if(url.pathname==='/api/teams/team-a')return team
  if(url.pathname.endsWith('/folders') || url.pathname==='/api/folders')return {items:[],list:[]}
  if(url.pathname.endsWith('/members'))return {items:[],list:[]}
  if(url.pathname.endsWith('/card-preview'))return {preview:{revision:1,sketch:{text:'Card',children:[]}}}
  if(url.pathname==='/api/teams/team-a/rooms'){
    if(deniedTeam)throw Object.assign(new Error('Team permission revoked'),{statusCode:403,code:'FORBIDDEN'})
    const q=url.searchParams.get('q')||'';const filtered=rows.filter(r=>r.title.includes(q))
    const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):filtered.length
    const offset=Number(url.searchParams.get('offset')||0)
    const list=filtered.slice(offset,offset+limit)
    return {items:list,list,total:filtered.length,limit,offset,nextCursor:offset+list.length<filtered.length?String(offset+list.length):null}
  }
  // The personal file route excludes team-owned maps in the production PG engine.
  if(url.pathname==='/api/files'){
    const personal={...rows[0],roomKey:'personal-room',id:'personal-room',title:'Personal Map'}
    const list=(!keyword||personal.title.includes(keyword))?[personal]:[]
    return {list,total:list.length,limit:Number(url.searchParams.get('limit')||20),offset:0,nextCursor:null}
  }
  if(url.pathname.endsWith('/info'))return {file:rows.find(r=>url.pathname.includes(r.roomKey))||rows[0]}
  if(url.pathname.includes('/nodes/query'))return {matches:[],items:[],total:0}
  if(url.pathname.endsWith('/subtree') || url.pathname.endsWith('/preview'))return {tree:{data:{uid:'root',text:'Root'},children:[]},version:1}
  if(url.pathname.endsWith('/version'))return {version:1}
  if(url.pathname.includes('/sop-ledger'))return {sops:[],items:[],list:[]}
  if(url.pathname.includes('/models'))return {models:[],items:[],list:[]}
  return {items:[],list:[],sops:[],total:0}
}
setProductHttp(transport)
const nativeFetch=window.fetch.bind(window)
window.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url,window.location.origin)
  if(!url.pathname.startsWith('/api/'))return nativeFetch(input,options)
  return new Response(JSON.stringify(await transport(url.pathname+url.search,options)),{status:200,headers:{'Content-Type':'application/json'}})
}
const router=new VueRouter({mode:'abstract',routes:[
  {path:'/files',component:FilesPage,props:{mode:'files'}},
  {path:'/spaces/:id',component:SpaceDetailPage},
  {path:'/sops',component:SopRegistry},
  {path:'/sop',component:SopRegistry}
]})
const store=new Vuex.Store({state:{localConfig:{}},mutations:{setLocalConfig(state,value){state.localConfig=value}}})
const app=new Vue({el:'#app',router,store,render:h=>h('router-view')})
window.directory={calls,router,app,rows,searchJobs,denyKnownTeam(){deniedTeam=true},pauseSearch(){deferSearch=true},
  flushSearch(keyword){searchJobs.filter(j=>j.keyword===keyword).forEach(j=>j.resolve({list:[{...rows[0],roomKey:keyword,id:keyword,title:keyword}],total:1,limit:20,offset:0}))},
  async open(route){await router.push(route);await Vue.nextTick()},
  page(){return app.$children[0]},async frames(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}}
`

async function createDirectoryHarness() {
  const harness = await createHarness({ contents,
    // The shared harness intentionally omits styles; supply widget dimensions
    // so real Element UI caret/input controls have usable hit targets.
    html: '<!doctype html><html><head><meta charset="utf-8"><style>.el-tree-node__expand-icon{display:inline-block;width:20px;height:20px}.el-tree-node__content{min-width:220px;height:28px}.el-popover{background:white;position:fixed!important;left:20px!important;top:80px!important;transform:none!important;max-height:700px;overflow:auto}.roomCard{display:inline-block;width:240px;min-height:160px}.roomPreview{height:100px}</style></head><body><div id="app"></div><script src="/fixture.js"></script></body></html>',
    viewport: { width: 1280, height: 900 } })
  harness.context.setDefaultTimeout(5000)
  return harness
}

async function boundedFiles(harness) {
  const page = await harness.newPage('/files-case')
  try {
    await page.evaluate(()=>directory.open('/files?team=team-a'))
    await page.waitForFunction(()=>directory.page() && !directory.page().loading)
    const data = await page.evaluate(()=>({requests:directory.calls.filter(x=>x.url.includes('/teams/team-a/rooms')),
      cards:document.querySelectorAll('.roomCard').length,pager:directory.page().showPager,error:directory.page().error}))
    assert.equal(data.error,'')
    assert.ok(data.requests.length>0)
    assert.equal(new URL(data.requests[0].url,'http://fixture.invalid').searchParams.get('limit'),'20')
    assert.equal(data.cards,20)
    assert.equal(data.pager,true)
  } finally { await page.close() }
}

async function sopLegacyTwentyOne(harness) {
  const page = await harness.newPage('/sop-selected')
  try {
    await page.evaluate(()=>directory.open('/sops'))
    await page.waitForFunction(()=>directory.page() && !directory.page().spacesLoading)
    await page.locator('.spaceSelect').click()
    const team = page.locator('.el-tree-node__content').filter({hasText:'团队A'}).first()
    await team.locator('.el-tree-node__expand-icon').click()
    await page.waitForFunction(()=>document.querySelectorAll('.spaceDirectoryOption--room').length>0)
    // Reachability protection also supports the future paginated More control.
    let target = page.locator('.el-tree-node__content').filter({hasText:'NeedleTeam21'})
    if(await target.count()===0){
      const more=page.locator('.el-tree-node__content').filter({hasText:/加载更多|更多/}).first()
      await more.click()
    }
    await target.first().click()
    await page.waitForFunction(()=>directory.page().roomKey==='team-room-21')
    assert.equal(await page.evaluate(()=>directory.router.currentRoute.query.room),'team-room-21')
    assert.ok((await page.locator('.spaceSelect').innerText()).includes('NeedleTeam21'),'Selected team title remains visible after the paginated tree is replaced')
  } finally { await page.close() }
}

async function sopBounded(harness) {
  const page = await harness.newPage('/sop-bounded')
  try {
    await page.evaluate(()=>directory.open('/sops'))
    await page.waitForFunction(()=>directory.page() && !directory.page().spacesLoading)
    await page.locator('.spaceSelect').click()
    const team=page.locator('.el-tree-node__content').filter({hasText:'团队A'}).first()
    await team.locator('.el-tree-node__expand-icon').click()
    await page.waitForFunction(()=>directory.calls.some(x=>x.url.includes('/teams/team-a/rooms')))
    const request=await page.evaluate(()=>directory.calls.find(x=>x.url.includes('/teams/team-a/rooms')).url)
    assert.equal(new URL(request,'http://fixture.invalid').searchParams.get('limit'),'20',
      'SOP directory must use the bounded paging service rather than fetch sixty at once')
  } finally { await page.close() }
}

async function sopTeamSearch(harness) {
  const page = await harness.newPage('/sop-search')
  try {
    await page.evaluate(()=>directory.open('/sops'))
    await page.waitForFunction(()=>directory.page() && !directory.page().spacesLoading)
    await page.locator('.spaceSelect').click()
    await page.locator('.spaceDirectoryPicker input').fill('NeedleTeam21')
    await page.waitForFunction(()=>directory.page().spaceDirectoryQuery==='NeedleTeam21' && !directory.page().spaceDirectorySearchLoading)
    const results=await page.evaluate(()=>directory.page().spaceDirectorySearchResults.map(x=>x.roomKey||x.room_key))
    assert.ok(results.includes('team-room-21'),'SOP remote search must find a team-owned map beyond page one')
  } finally { await page.close() }
}

async function sopSearchRace(harness, requireAbort) {
  const page=await harness.newPage('/sop-race')
  try{
    await page.evaluate(()=>directory.open('/sops'))
    await page.waitForFunction(()=>directory.page() && !directory.page().spacesLoading)
    await page.locator('.spaceSelect').click()
    await page.evaluate(()=>directory.pauseSearch())
    const input=page.locator('.spaceDirectoryPicker input')
    await input.fill('RaceSearchOld')
    await page.waitForFunction(()=>directory.searchJobs.some(x=>x.keyword==='RaceSearchOld'))
    await input.fill('RaceSearchNew')
    await page.waitForFunction(()=>directory.searchJobs.some(x=>x.keyword==='RaceSearchNew'))
    if(requireAbort){
      const stale=await page.evaluate(()=>directory.searchJobs.filter(x=>x.keyword==='RaceSearchOld').map(x=>({aborted:x.aborted,signalAborted:x.signal&&x.signal.aborted})))
      assert.ok(stale.every(x=>x.aborted&&x.signalAborted),'Old real HTTP searches must be aborted, not only ignored after completing')
    }
    await page.evaluate(()=>directory.flushSearch('RaceSearchNew'))
    await page.waitForFunction(()=>!directory.page().spaceDirectorySearchLoading)
    await page.evaluate(async()=>{directory.flushSearch('RaceSearchOld');await directory.frames()})
    const results=await page.evaluate(()=>directory.page().spaceDirectorySearchResults.map(x=>x.roomKey||x.room_key))
    assert.ok(results.includes('RaceSearchNew'))
    assert.ok(!results.includes('RaceSearchOld'),'Old search responses must never replace current results')
  }finally{
    await page.evaluate(()=>{directory.flushSearch('RaceSearchOld');directory.flushSearch('RaceSearchNew')}).catch(()=>{})
    await page.close()
  }
}

async function sopRevokedTeamSearch(harness) {
  const page = await harness.newPage('/sop-revoked-search')
  try {
    await page.evaluate(()=>directory.open('/sops'))
    await page.waitForFunction(()=>directory.page() && !directory.page().spacesLoading)
    await page.evaluate(()=>directory.denyKnownTeam())
    await page.locator('.spaceSelect').click()
    await page.locator('.spaceDirectoryPicker input').fill('Personal Map')
    await page.waitForFunction(()=>directory.page().spaceDirectoryQuery==='Personal Map' && !directory.page().spaceDirectorySearchLoading)
    const results=await page.evaluate(()=>directory.page().spaceDirectorySearchResults.map(x=>x.roomKey||x.room_key))
    assert.ok(results.includes('personal-room'),'One revoked team must not erase other successful authorized search results')
  } finally { await page.close() }
}

module.exports = { createDirectoryHarness, boundedFiles, sopLegacyTwentyOne, sopBounded, sopTeamSearch, sopSearchRace, sopRevokedTeamSearch }
if(require.main===module){
  const test=require('node:test')
  let harness
  test.before(async()=>{harness=await createDirectoryHarness()})
  test.after(async()=>{if(harness)await harness.close()})
  test('[R31] real FilesPage mounts only its bounded team page and pager',()=>boundedFiles(harness))
  test('[R31] actual SOP tree can select team room twenty-one and retain its selected label',()=>sopLegacyTwentyOne(harness))
  test('[R31] actual SOP tree expands a bounded team page',()=>sopBounded(harness))
  test('[R31] actual SOP remote search reaches a team-owned map beyond page one',()=>sopTeamSearch(harness))
  test('[R31] actual SOP ignores a delayed old response after a newer search completes',()=>sopSearchRace(harness,false))
  test('[R31] actual SOP cancels obsolete HTTP work when its search changes',()=>sopSearchRace(harness,true))
  test('[R31] real SOP search retains personal results when a previously listed team is revoked',()=>sopRevokedTeamSearch(harness))
}
