const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { createHarness, repo } = require('./engine-harness.cjs')
const webRequire = createRequire(path.join(repo, 'web/package.json'))
const babel = webRequire('@babel/core')
const sourcePath = path.join(repo, 'simple-mind-map/src/layouts/CompactStructure.js')
const base = 'd5793106098afe8a2ff9bbb60193bc25e5e45f88'

// Compile actual production source, adding only a runtime score observation.
// The baseline function comes from Git, not a copied/rewritten routing model.
function observeSource(source) {
  return babel.transformSync(source, { filename: sourcePath, babelrc: false, configFile: false,
    plugins: [({ types: t }) => ({ visitor: {
      ImportDeclaration(p) {
        if (p.node.source.value.startsWith('.')) p.node.source.value = path.resolve(path.dirname(sourcePath), p.node.source.value)
      },
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id, { name: 'score' }) ||
            !p.findParent(q => q.isClassMethod() && t.isIdentifier(q.node.key, { name: 'assignConnectorLanes' }))) return
        p.node.init = t.callExpression(t.memberExpression(t.identifier('window'), t.identifier('__compactCandidateProbe')),
          [p.node.init, t.identifier('x'), t.identifier('middle'), t.identifier('node')])
      }
    } })] }).code
}

const contents = `
import './tests/performance/renderer-browser-entry.js'
import CompactStructure from './simple-mind-map/src/layouts/CompactStructure.js'
import BeforeCompact from 'compact-routing-before-source'
const liveMethod = CompactStructure.prototype.assignConnectorLanes
const beforeMethod = BeforeCompact.prototype.assignConnectorLanes
let activeCall=null
window.__compactCandidateProbe=(score,x,middle,node)=>{
  if(activeCall){
    const uid=node.getData('uid')
    const route=activeCall.routes[uid]||(activeCall.routes[uid]={evaluations:0,firstScore:score,firstX:x,middle})
    route.evaluations++
    if(score===0)route.zeroScores=(route.zeroScores||0)+1
  }
  return score
}
function snapshot(mm){
  const layout=mm.renderer.layout
  return {coordinates:rendererFixture.coordinates(mm),
    paths:Array.from(mm.lineDraw.node.querySelectorAll('path')).map(path=>path.getAttribute('d')),
    buses:Array.from(layout.busXByNode||[]).map(([node,x])=>[node.getData('uid'),x]),
    arms:Array.from(layout.armOffsetsByNode||[]).map(([node,offsets])=>[node.getData('uid'),offsets])}
}
function geometryReads(){
  const restorers=[]
  for(const name of ['left','top']){
    const descriptor=Object.getOwnPropertyDescriptor(rendererFixture.MindMapNode.prototype,name)
    if(!descriptor||typeof descriptor.get!=='function')throw new Error('Live node position getter unavailable: '+name)
    Object.defineProperty(rendererFixture.MindMapNode.prototype,name,{...descriptor,get(){
      if(activeCall)activeCall.positionReads++
      return descriptor.get.call(this)
    }})
    restorers.push(()=>Object.defineProperty(rendererFixture.MindMapNode.prototype,name,descriptor))
  }
  return ()=>restorers.reverse().forEach(fn=>fn())
}
async function run(method,branches,options={},custom=false){
  const calls=[]
  CompactStructure.prototype.assignConnectorLanes=function(...args){
    const previous=activeCall,call={depth:args[0]??null,positionReads:0,routes:{}}
    activeCall=call;const start=performance.now()
    try{return method.apply(this,args)}finally{
      call.ms=performance.now()-start;calls.push(call);activeCall=previous
    }
  }
  const restore=geometryReads()
  let mm
  try{
    const data=rendererFixture.wideLayered(branches)
    if(custom){
      data.children[1].data.customLeft=880;data.children[1].data.customTop=180
      data.children[2].data.expand=false
      data.children[3].children[0].data.customLeft=640
      data.children[3].children[0].data.customTop=180
    }
    mm=await rendererFixture.create(data,{layout:'logicalStructure',compactLayout:true,openPerformance:false,...options})
    if(mm.renderer.layout.constructor.name!=='CompactStructure'&&options.layout!=='logicalStructureLeft'&&options.layout!=='mindMap')throw new Error('Real compact layout not selected')
    return {branches,n:1+branches*3,options,custom,calls,golden:snapshot(mm)}
  }finally{
    if(mm)mm.destroy()
    restore();CompactStructure.prototype.assignConnectorLanes=liveMethod
  }
}
window.compactRouting={async compare(){
  const rows=[]
  for(const branches of [20,80]){
    const before=await run(beforeMethod,branches),current=await run(liveMethod,branches)
    rows.push({scenario:'wide-'+branches,before,current})
  }
  for(const options of [{},{layout:'logicalStructureLeft'},{layout:'mindMap'},{themeConfig:{nodeUseLineStyle:true}},
    {alwaysShowExpandBtn:true,notShowExpandBtn:false}]){
    rows.push({scenario:'custom-'+JSON.stringify(options),before:await run(beforeMethod,4,options,true),current:await run(liveMethod,4,options,true)})
  }
  return rows
}}
`

test('real compact routing stops after a globally optimal zero score and preserves coordinates/paths', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const destination = path.join(repo, 'work/performance-tdd', phase, 'renderer')
  fs.mkdirSync(destination, { recursive: true })
  let before
  try { before = cp.execFileSync('git', ['show', base + ':simple-mind-map/src/layouts/CompactStructure.js'], { cwd: repo, encoding: 'utf8' }) }
  catch (error) { throw new Error('BASELINE_UNAVAILABLE: fetch the real base commit before running this test', { cause: error }) }
  const current = fs.readFileSync(sourcePath, 'utf8')
  const harness = await createHarness({ contents, stubs: {
    [sourcePath]: observeSource(current),
    'compact-routing-before-source': observeSource(before)
  } })
  try {
    const rows = await harness.page.evaluate(() => compactRouting.compare())
    assert.deepEqual(harness.errors, [], 'Browser exceptions are infrastructure failures, not performance RED')
    const report = { base, browser: harness.browser.version(), phase,
      sourceSha256: crypto.createHash('sha256').update(current).digest('hex'),
      boundary: 'Actual renderer/live MindMapNode getters and production routing; baseline exact Git method on the same current engine. One complete real creation per scenario, diagnostic routing-call times, not a time/P95 acceptance claim.', rows }
    fs.writeFileSync(path.join(destination, 'compact-routing-work.json'), JSON.stringify(report, null, 2))
    for (const row of rows) assert.deepEqual(row.current.golden, row.before.golden, row.scenario + ': coordinates/connector golden changed')
    for (const row of rows.filter(row => row.scenario.startsWith('wide-'))) {
      const branchCalls = row.current.calls.filter(call => call.depth === 1)
      assert.ok(branchCalls.length, 'Real default compact routing must be executed')
      for (const call of branchCalls) {
        const routes = Object.values(call.routes)
        assert.equal(routes.length, row.current.branches)
        assert.ok(routes.every(route => route.firstScore === 0), 'The wide fixture must really reach a score-zero first candidate')
        assert.ok(routes.every(route => route.evaluations === 1),
          `${row.scenario}: score-zero routes still evaluated ${routes.reduce((sum, route)=>sum+route.evaluations,0)} candidates`)
        assert.ok(call.positionReads <= row.current.n * row.current.branches * 40,
          `${row.scenario}: routing read ${call.positionReads} live positions for ${row.current.n} nodes`)
      }
    }
  } finally { await harness.close() }
})
