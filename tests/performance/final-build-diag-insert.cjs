const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto')
const {startFinalFixture,openActorEditor,repo}=require('./final-build-app.cjs')
const {settled}=require('./online-browser-matrix.cjs')
const observe=require('./online-browser-observation.cjs')
const {closeOwnedFixture}=require('./online-cleanup.cjs')
const OUT=path.join(repo,'work/performance-tdd/pi/final-build-e2e/diag-insert')
async function main(){
  fs.mkdirSync(OUT,{recursive:true})
  const runId=crypto.randomUUID().replace(/-/g,'').slice(0,16)
  const fixture=await startFinalFixture({instances:1,profile:'default'})
  const seed=await fixture.apps[0].control('seedSmall',{runId})
  fixture.roomKey=seed.roomKey
  const browser=await require('./final-build-app.cjs').chromium.launch({headless:true,channel:'chrome'})
  const frames=[]
  const client=await openActorEditor(browser,fixture,{actor:'owner',roomKey:seed.roomKey,onPage:async page=>observe.observeWire(page,0,frames)})
  await settled(client)
  const snap=await client.page.evaluate(()=>{
    const mm=window.__onlineMM,c=mm.cooperate
    const before=(mm.renderer.findNodeByUid('branch-1').children||[]).map(n=>n.getData('uid'))
    mm.execCommand('SET_NODE_ACTIVE',mm.renderer.findNodeByUid('branch-1'))
    const activeAfterSet=mm.renderer.activeNodeList.length
    const needsHydrate=typeof c.nodeNeedsHydrate==='function'?c.nodeNeedsHydrate(mm.renderer.findNodeByUid('branch-1')):null
    const beforeHist=mm.command.history.length
    mm.renderer.insertChildNode(false,[mm.renderer.findNodeByUid('branch-1')],{uid:'diag-added-1',text:'<p>diag</p>',richText:true})
    const after=(mm.renderer.findNodeByUid('branch-1').children||[]).map(n=>n.getData('uid'))
    return {before,activeAfterSet,needsHydrate,beforeHist,afterHist:mm.command.history.length,lazyAfter:!!(mm.renderer._lazyCommandPending),after,inserted:after.includes('diag-added-1'),
      flags:{isSetData:c.isSetData,isApplyingRemote:c.isApplyingRemote,previewApplied:c.previewApplied,httpHydrating:c.httpHydrating,httpReplacing:c.httpReplacing,suppressMsLeft:(c.suppressLocalUntil||0)-Date.now(),undoActive:c._v2UndoActive,httpHistorySyncing:c.httpHistorySyncing,lazyPending:!!(mm.renderer._lazyCommandPending)},
      history:mm.command.history.length,uid_exists:!!mm.renderer.findNodeByUid('diag-added-1')}
  })
  await new Promise(r=>setTimeout(r,5000))
  const framesAfter=frames.filter(f=>f.direction==='sent'&&f.event==='op').map(f=>({type:f.body.type,opId:f.body.opId,payload:JSON.stringify(f.body.payload).slice(0,120)}))
  fs.writeFileSync(path.join(OUT,'diag-'+runId+'.json'),JSON.stringify({snap,framesAfter},null,2))
  console.log(JSON.stringify({snap,framesAfter},null,2))
  await closeOwnedFixture(browser,[client],fixture)
}
main().catch(e=>{console.error(e);process.exitCode=1})
