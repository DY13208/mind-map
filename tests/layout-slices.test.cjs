const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/utils/layoutSlices.js'), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}
test('sliced layout retains DFS order, depths, parents and collapsed branch behavior', async () => {
  const { walkLayoutInSlices } = await load()
  const root = { id: 'root', children: [{ id: 'a', children: [{ id: 'hidden' }] }, { id: 'b', children: [{ id: 'c' }] }] }
  const seen = []
  await walkLayoutInSlices([root, null, (node,parent,isRoot,depth,index,ancestors) => {
    seen.push(['enter',node.id,parent?.id,depth,index,ancestors.map(n=>n.id)])
    return node.id==='a'
  }, node=>seen.push(['exit',node.id]),true])
  assert.deepEqual(seen.map(row=>row.slice(0,2)),[['enter','root'],['enter','a'],['exit','a'],['enter','b'],['enter','c'],['exit','c'],['exit','b'],['exit','root']])
  assert.deepEqual(seen.find(row=>row[1]==='c'),['enter','c','b',2,0,['root','b']])
})
test('sliced layout yields and stops when a newer render cancels it', async () => {
  const { walkLayoutInSlices } = await load()
  let cancelled=false,visited=0
  const root={children:Array.from({length:1000},()=>({children:[]}))}
  const timer=setTimeout(()=>{cancelled=true},0)
  const complete=await walkLayoutInSlices([root,null,()=>{
    visited++
    const until=performance.now()+0.05;while(performance.now()<until){}
  },null,true],{budgetMs:1,cancelled:()=>cancelled})
  clearTimeout(timer)
  assert.equal(complete,false)
  assert.ok(visited>0 && visited<1000)
})
