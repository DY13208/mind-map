'use strict'
// Native App/IndexedDB/MCP/PG fixture. Only the network-failure case is injected.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const fixture = path.join(__dirname, 'mcp-guards-browser.cjs')
let source = fs.readFileSync(fixture, 'utf8')
source = source.replace("'mcp-guards-seed.cjs'", "'text-edit-seed.cjs'")
source = source.replace("for (const actor of ['owner', 'editor-a', 'editor-b'])", "for (const actor of ['owner'])")
const start = source.indexOf('  const converge = async revision => {'), end = source.indexOf('\nmain().catch(error =>')
const focused = async function () {
  const {page} = clients[0]
  report.scope = 'Compiled native App + real IndexedDB/PG/MCP; one injected NETWORK_ERROR before transport; real guarded retry ACK and real MCP field conflict. No production writes.'
  const bind = async () => {
    await page.waitForFunction(`(() => {const mm=(${mapInBrowser.toString()})();if(mm)window.__guardMM=mm;return mm&&mm.renderer.root&&!mm.renderer.isRendering&&mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'})()`)
    await page.evaluate(() => {
      const stack=[document.querySelector('#app').__vue__]
      while(stack.length){const vm=stack.pop();if(vm.$options.name==='ConflictDraftInbox'){window.__inbox=vm;break}stack.push(...vm.$children)}
    })
    await page.waitForFunction(() => !!window.__inbox)
  }
  const openEdit = async uid => {
    await page.evaluate(async uid => {
      const mm=__guardMM
      await new Promise(resolve => mm.execCommand('GO_TARGET_NODE',uid,resolve))
      await mm.renderer.textEdit.show({node:mm.renderer.findNodeByUid(uid),forceEdit:true})
    },uid)
    return page.evaluate(() => __guardMM.richText?.showTextEdit ? '.smm-richtext-node-edit-wrap .ql-editor' : '.smm-node-edit-wrap')
  }
  await bind()
  await page.waitForTimeout(500)
  const selector = await openEdit('other')
  const retryText = '网络恢复后保存的真实输入'
  await page.locator(selector).fill(retryText)
  await page.evaluate(() => {
    const c=__guardMM.cooperate, original=c.submitV2.bind(c)
    window.__recoverySubmits=[]
    window.__failNextEdit=true
    c.submitV2=async(type,payload)=>{
      __recoverySubmits.push({type,payload})
      if(type==='node.update'&&__failNextEdit){throw Object.assign(new Error('Injected network failure before transport'),{code:'NETWORK_ERROR'})}
      return original(type,payload)
    }
  })
  assert.equal(await page.evaluate(() => __guardMM.renderer.textEdit.hideEditTextBox()),false)
  await page.waitForFunction(() => __inbox.actionableDrafts.length===1)
  assert.equal(await page.evaluate(() => __inbox.visible),false,'a failed save must not force a modal open')
  await page.locator('.draftInboxTrigger').click()
  await page.getByRole('button',{name:'重试保存',exact:true}).waitFor({state:'visible'})
  await page.screenshot({path:path.join(OUT,'retry-before.png')})
  const originalBaseline = await page.evaluate(() => __inbox.actionableDrafts[0].session.baseVersions)
  await page.evaluate(() => {window.__failNextEdit=false})
  await page.getByRole('button',{name:'重试保存',exact:true}).click()
  await page.waitForFunction(() => __inbox.actionableDrafts.length===0 && !__guardMM.renderer.textEdit.isShowTextEdit())
  const afterRetry=await query('other')
  assert.ok(JSON.stringify(afterRetry).includes(retryText),'retry must receive a real ACK and persist the content')
  const submitted=await page.evaluate(() => __recoverySubmits.filter(item=>item.type==='node.update').at(-1))
  assert.equal(submitted.payload.expected['__fv.text'],originalBaseline.text,'retry must keep its original captured baseline')
  await check('network failure offers a single guarded retry; ACK closes editor and clears only that draft',async()=>({originalBaseline,persisted:true}))

  // Actual remote same-field edit while this editor retains its own input.
  const conflictSelector=await openEdit('other')
  const localText='我的修改，需要与他人的内容比较'
  await page.locator(conflictSelector).fill(localText)
  const current=(await query('other')).items[0]
  const remoteText='同事已经保存的另一份内容'
  const remote=await call('update_node',{room_key:roomKey,node:'other',text:remoteText,
    expected:{uid:'other','__fv.text':current.data.__fv.text}})
  assert.equal(remote.toolError,false,JSON.stringify(remote))
  await page.waitForFunction(() => __inbox.actionableDrafts.some(item=>__inbox.draftPolicy(item).kind==='conflict'))
  assert.equal(await page.evaluate(() => __inbox.visible),false,'a later conflict must not reopen a previously closed inbox')
  const conflict=await page.evaluate(() => __inbox.actionableDrafts[0])
  assert.ok(JSON.stringify(conflict.session.draft).includes(localText))
  // Seed an older unchanged text record directly into the existing local KV,
  // modelling records created by the previous UI. It must survive unchanged.
  await page.evaluate(async () => {
    const principal=localStorage.getItem('COOPERATE_USER_ID')||'anonymous',room=__inbox.room
    const key='conflictDraft:v1:'+encodeURIComponent(principal)+':'+encodeURIComponent(room)+':other:text:legacy-unchanged'
    const session={id:'legacy-unchanged',uid:'other',roomKey:room,kind:'text',fields:['text'],baseValues:{text:'没有改动的旧记录'},baseVersions:{text:0},draft:{text:'没有改动的旧记录'},draftRevision:1,state:'conflict'}
    const record={version:1,key,sessionId:session.id,uid:'other',group:'text',principal,room,session,reason:'conflict',error:{code:'PRECONDITION_REQUIRED'},savedAt:Date.now()}
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mind-map-local',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
    await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(record,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})
    db.close();window.__legacyRecord=record
    await __inbox.loadDrafts()
  })
  assert.equal(await page.evaluate(() => __inbox.actionableDrafts.length),1)
  assert.equal(await page.evaluate(() => __inbox.diagnosticDrafts.length),1)
  await page.reload();await bind()
  await page.waitForFunction(() => __inbox.drafts.length===2)
  assert.equal(await page.evaluate(() => __inbox.diagnosticDrafts[0].session.draft.text),'没有改动的旧记录')
  await page.locator('.draftInboxTrigger').click()
  assert.equal(await page.getByRole('button',{name:'重试保存',exact:true}).count(),0,'real conflict must not offer an automatic overwrite/rebase')
  await page.getByRole('button',{name:'查看服务器最新内容',exact:true}).click()
  await page.locator('.conflictDraftDialog .latestSection pre').waitFor({state:'visible'})
  assert.ok((await page.locator('.conflictDraftDialog .latestSection pre').innerText()).includes(remoteText))
  assert.ok((await page.locator('.conflictDraftDialog').innerText()).includes(localText))
  await clients[0].context.grantPermissions(['clipboard-read','clipboard-write'],{origin})
  await page.getByRole('button',{name:'复制我的内容',exact:true}).click()
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),localText,'copy must contain only the input, not metadata placeholders')
  assert.ok((await page.locator('.draftInboxTrigger').innerText()).includes('1'),'technical record must not inflate the unsaved-content count')
  await page.screenshot({path:path.join(OUT,'conflict-desktop.png')})
  await page.setViewportSize({width:390,height:844})
  await page.waitForTimeout(150)
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
    dialog:document.querySelector('.conflictDraftDialog').getBoundingClientRect().toJSON()}))
  assert.ok(layout.dialog.left>=0&&layout.dialog.right<=390,'mobile dialog fits the viewport')
  await page.screenshot({path:path.join(OUT,'conflict-mobile.png')})
  await page.evaluate(()=>document.body.classList.add('isDark'))
  await page.screenshot({path:path.join(OUT,'conflict-mobile-dark.png')})
  await check('real field conflict shows both values, preserves legacy records across F5 and fits mobile/dark',async()=>({conflictUid:conflict.uid,actionable:1,records:1,layout}))
  report.passed=true
}
source=source.slice(0,start)+'\n await ('+focused.toString()+`)().catch(async error => {
 report.uiFailure = await clients[0].page.evaluate(() => ({drafts:window.__inbox?.drafts,policies:window.__inbox?.drafts.map(item=>__inbox.draftPolicy(item)),text:document.body.innerText.slice(-5000)})).catch(()=>null)
 await clients[0].page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{})
 throw error
})\n}\n`+source.slice(end)
const runtime=new Module(fixture,module);runtime.filename=fixture;runtime.paths=module.paths;runtime._compile(source,fixture)
