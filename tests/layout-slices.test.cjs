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
test('sliced layout releases its yield channel so the Node process can exit', async () => {
  const { spawn } = require('node:child_process')
  const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/utils/layoutSlices.js'), 'utf8')
  const encoded = JSON.stringify(Buffer.from(source).toString('base64'))
  // A shallow, cheap iterator forces several 8ms slices (each yields a
  // macrotask) without a deep chain. A yield port left open would keep the
  // Node event loop alive and hang this child.
  const script = [
    '(async () => {',
    '  let yields = 0',
    '  const RealMessageChannel = globalThis.MessageChannel',
    '  globalThis.MessageChannel = function (...args) { yields++; return new RealMessageChannel(...args) }',
    '  globalThis.MessageChannel.prototype = RealMessageChannel.prototype',
    '  const m = await import("data:text/javascript;base64," + ' + encoded + ')',
    '  function* cheap() { for (let i = 0; i < 300000; i++) yield i }',
    '  await m.runWorkInSlices(cheap())',
    '  console.log("slicer-idle-exit-done yields=" + yields)',
    '})()'
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('slicer kept the Node process alive')) }, 8000)
    child.once('exit', value => { clearTimeout(timer); resolve(value) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(code, 0)
  assert.match(out, /slicer-idle-exit-done/)
  // The protection must actually exercise a yield; a trivially fast iterator
  // that never slices would make it vacuous.
  const yields = Number((out.match(/yields=(\d+)/) || [])[1] || 0)
  assert.ok(yields >= 1, 'expected at least one MessageChannel yield, saw ' + yields)
})
