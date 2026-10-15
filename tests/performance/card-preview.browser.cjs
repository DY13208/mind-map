const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./engine-harness.cjs')

const contents = `
import Vue from 'vue'
import ElementUI from 'element-ui'
import RoomCard from './web/src/pages/ProductShell/components/RoomCard.vue'
import { setProductHttp } from './web/src/services/productHttp'
Vue.use(ElementUI)
const requests=[]
let automatic=false
setProductHttp((url,options={})=>{
  let resolve,reject
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no})
  const request={url,signal:options.signal,aborted:false,resolve,reject}
  requests.push(request)
  if(options.signal) options.signal.addEventListener('abort',()=>{
    request.aborted=true
    reject(Object.assign(new Error('Aborted'),{name:'AbortError'}))
  },{once:true})
  if(automatic) resolve({preview:{roomKey:decodeURIComponent(url.split('/')[3]),revision:1,
    updatedAt:'2026-10-13T00:00:01.000Z',sketch:{text:'Actual preview',children:[]}}})
  return promise
})
const row=i=>({roomKey:'browser-room-'+i,id:'browser-room-'+i,title:'Room '+i,revision:1,
  contentUpdatedAt:'2026-10-13T00:00:01.000Z',updatedAt:'2026-10-13T00:00:01.000Z',
  folderName:'Root',favorite:false,role:'owner',collaborators:[],owner:{id:'owner',name:'Owner'}})
const host=new Vue({el:'#app',data:{cards:[],mode:'grid'},
  render(h){return h('main',{class:this.mode},this.cards.map(room=>h(RoomCard,{key:room.roomKey,props:{room}})))}})
window.fixture={requests,host,
  async mount(count,mode='grid',auto=false){automatic=auto;host.mode=mode;host.cards=Array.from({length:count},(_,i)=>row(i));await Vue.nextTick()},
  async remove(){host.cards=[];await Vue.nextTick()},
  async frames(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))},
  resolveAll(){requests.forEach(r=>r.resolve({preview:{revision:1,sketch:{text:'Resolved',children:[]}}}))}
}
`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0}.grid{display:grid;grid-template-columns:repeat(10,120px);gap:2px}
  .grid .roomCard{height:75px;overflow:hidden}.grid .roomPreview{height:35px}
  .stack .roomCard{height:240px;width:350px}.stack .roomPreview{height:150px}
  .stack .roomCard+.roomCard{margin-top:1500px}
</style></head><body><div id="app"></div><script src="/fixture.js"></script></body></html>`

let harness
test.before(async () => { harness = await createHarness({ contents, html, viewport: { width: 1280, height: 900 } }) })
test.after(async () => { if (harness) await harness.close() })

test('[R26] mounted production cards keep visible preview requests below four in flight', async () => {
  const page = await harness.newPage('/concurrency')
  try {
    await page.evaluate(async () => { await fixture.mount(100); await fixture.frames() })
    const metrics = await page.evaluate(() => ({ cards:document.querySelectorAll('.roomCard').length,
      requests:fixture.requests.length, active:fixture.requests.filter(r=>!r.aborted).length }))
    assert.equal(metrics.cards,100,'Fixture must mount all real RoomCard components')
    assert.ok(metrics.active<=4,`Visible card production dispatch started ${metrics.active} unresolved requests`)
  } finally { await page.close() }
})

test('[R28] real IntersectionObserver preserves 120px prefetch and does not request a far-away card', async () => {
  const page = await harness.newPage('/lazy')
  try {
    await page.evaluate(async () => { await fixture.mount(2,'stack',true); await fixture.frames() })
    const first = await page.evaluate(() => ({ requests:fixture.requests.map(r=>r.url),
      distantTop:document.querySelectorAll('.roomPreview')[1].getBoundingClientRect().top }))
    assert.ok(first.distantTop>1020,'Second card must really be beyond viewport plus 120px')
    assert.deepEqual(first.requests,['/api/files/browser-room-0/card-preview'])
    await page.locator('.roomCard').nth(1).scrollIntoViewIfNeeded()
    await page.waitForFunction(()=>fixture.requests.length===2)
    assert.equal(await page.locator('.mindMapPreview').count(),2)
  } finally { await page.close() }
})

test('[R28] actual Vue unmount aborts a pending preview instead of only disconnecting its observer', async () => {
  const page = await harness.newPage('/unmount')
  try {
    await page.evaluate(async () => { await fixture.mount(1); await fixture.frames() })
    await page.waitForFunction(()=>fixture.requests.length===1)
    await page.evaluate(()=>fixture.remove())
    const observed = await page.evaluate(() => ({ cards:document.querySelectorAll('.roomCard').length,
      hasSignal:!!fixture.requests[0].signal,aborted:fixture.requests[0].aborted }))
    assert.equal(observed.cards,0)
    assert.equal(observed.hasSignal,true,'Production service must receive the cancellable signal')
    assert.equal(observed.aborted,true,'Removed last subscriber must abort the real request')
  } finally { await page.close() }
})
