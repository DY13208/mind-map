'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync('simple-mind-map/src/plugins/Cooperate.js', 'utf8')
const start = source.indexOf('  async refreshCollapsedNodeCounts() {')
const end = source.indexOf('\n  async fetchHttpNodes(', start)
function indexTreeNodesByUid(root) {
  const map = new Map()
  const walk = node => {map.set(node.data.uid, node);(node.children || []).forEach(walk)}
  walk(root)
  return map
}
const method = vm.runInNewContext('({' + source.slice(start, end) + '})', {indexTreeNodesByUid}).refreshCollapsedNodeCounts
async function main() {
  const raw = {data:{uid:'parent',expand:false,childCount:6,descendantCount:29,text:'local draft',__fv:{text:4}},children:[]}
  let calls=0, badges=0, release
  const node={nodeData:raw,updateExpandBtnNode(){badges++}}
  const ctx={httpCollabMode:true,httpRoomKey:'room-a',lastAppliedVersion:177,
    collabV2Adapter:{getStatus:()=>({phase:'LIVE',pendingCount:0})},httpFetchNodes(){},
    mindMap:{renderer:{renderTree:raw,findNodeByUid:()=>node}},
    fetchHttpNodes:async()=>{calls++;return [{uid:'parent',data:{childCount:8,descendantCount:237,text:'server text',__fv:{text:999}}}]},
    refreshCollapsedNodeCounts:method}
  assert.equal(await method.call(ctx),true)
  assert.equal(raw.data.descendantCount,237)
  assert.equal(raw.data.childCount,8)
  assert.equal(raw.data.text,'local draft','count reads cannot replace content or edit baselines')
  assert.equal(raw.data.__fv.text,4)
  assert.equal(badges,1)
  await method.call(ctx)
  assert.equal(calls,1,'view-only renders reuse the same revision badge counts')
  ctx.lastAppliedVersion++
  ctx.fetchHttpNodes=()=>new Promise(resolve=>{release=resolve})
  const pending=method.call(ctx)
  ctx.httpRoomKey='room-b'
  release([{uid:'parent',data:{childCount:1,descendantCount:1}}])
  assert.equal(await pending,false)
  assert.equal(raw.data.descendantCount,237,'old-room response cannot touch current badges')
  ctx.httpRoomKey='room-a'
  const newer=method.call(ctx)
  ctx.lastAppliedVersion++
  release([{uid:'parent',data:{childCount:1,descendantCount:1}}])
  assert.equal(await newer,false)
  assert.equal(raw.data.descendantCount,237,'older revision cannot overwrite a newer structural state')
  ctx.fetchHttpNodes=async()=>[{uid:'parent',data:{childCount:0,descendantCount:0}}]
  await method.call(ctx)
  assert.equal(raw.data.descendantCount,0,'deletes can lower totals to zero')
  console.log('PASS collapsed badge refresh, revision dedup, room/revision isolation and draft preservation')
}
main().catch(error=>{console.error(error);process.exitCode=1})
