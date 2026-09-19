const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname,'../src/layouts/Base.js'),'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm,'')
  .replace('export default Base','module.exports = Base')
const moduleMock = {exports:{}}
vm.runInNewContext(source,{module:moduleMock})
test('cached instance rebinds to the current hydrated data before geometry and commands',()=>{
  const old={data:{uid:'a',customLeft:400},children:[]}
  const node={uid:'a',nodeData:old,layerIndex:1,reset(){},handleData:d=>d,getData(k){return this.nodeData.data[k]},getSize(){assert.equal(this.nodeData.data.customLeft,null)}}
  const current={data:{uid:'a',customLeft:null},children:[{data:{uid:'child'}}],_node:node}
  const renderer={reRender:false,findActiveNodeIndex:()=>-1}
  const layout=Object.assign(Object.create(moduleMock.exports.prototype),{
    renderer,mindMap:{renderer,nodeInnerPrefixList:[],nodeInnerPostfixList:[]},
    cacheNode(){},checkIsLayerTypeChange:()=>false,
    checkIsLayoutChangeRerenderExpandBtnPlaceholderRect(){},checkNodeFixChange:()=>({}),
    checkIsNeedResizeSources:()=>false,checkIsNodeDataChange:()=>true,checkGetGeneralizationChange(){}
  })
  assert.equal(layout.createNode(current,null,true,0,0,[]),node)
  assert.equal(node.nodeData,current)
  node.nodeData.children.push({data:{uid:'new'}})
  assert.equal(current.children.length,2)
  assert.equal(old.children.length,0)
})

test('same-data structural changes invalidate measured geometry',()=>{
  let measurements=0
  const data={data:{uid:'parent'},children:[]}
  const node={uid:'parent',nodeData:data,layerIndex:2,reset(){},handleData:d=>d,
    getData(k){return this.nodeData.data[k]},getSize(){measurements++}}
  data._node=node
  const renderer={reRender:false,findActiveNodeIndex:()=>-1}
  const layout=Object.assign(Object.create(moduleMock.exports.prototype),{
    renderer,mindMap:{renderer,nodeInnerPrefixList:[],nodeInnerPostfixList:[]},
    cacheNode(){},checkIsLayerTypeChange:()=>false,
    checkIsLayoutChangeRerenderExpandBtnPlaceholderRect(){},checkNodeFixChange:()=>false,
    checkIsNeedResizeSources:()=>false,checkIsNodeDataChange:()=>false,checkGetGeneralizationChange(){}
  })
  layout.createNode(data,null,true,2,0,[])
  assert.equal(measurements,1)
  layout.createNode(data,null,true,2,0,[])
  assert.equal(measurements,1)
  data.children.push({data:{uid:'child'}})
  layout.createNode(data,null,true,2,0,[])
  assert.equal(measurements,2)
  data.children=[]
  layout.createNode(data,null,true,2,0,[])
  assert.equal(measurements,3)
})
