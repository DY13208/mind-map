const assert=require('node:assert/strict')
const Y=require('../simple-mind-map/node_modules/yjs')
const doc=require('../simple-mind-map/bin/mindDoc')
const {applyNodeCommand}=require('../simple-mind-map/bin/roomCommands')
const ydoc=new Y.Doc()
doc.applyObjectToDoc(ydoc,{
  root:{data:{uid:'root',text:'人事流程'},children:['one','probation'],isRoot:true,position:'A'},
  one:{data:{uid:'one',text:'录用'},children:[],position:'A'},
  probation:{data:{uid:'probation',text:'转正申请表',customLeft:1400.5},children:['child'],position:'B'},
  child:{data:{uid:'child',text:'提交要求'},children:[],position:'A'}
},{replace:true})
applyNodeCommand(ydoc,{type:'node.update',payload:{uid:'probation',patch:{customLeft:null}}},{version:1})
const after=doc.readObject(ydoc)
assert.equal(after.probation.data.customLeft,undefined)
assert.equal(after.probation.data.text,'转正申请表')
assert.deepEqual(after.root.children,['one','probation'])
assert.deepEqual(after.probation.children,['child'])
assert.equal(after.probation.position,'B')
assert.equal(after.probation.data.__fv['field:customLeft'],1)
ydoc.destroy()
console.log('PASS: clearing manual coordinates persists through collaborative commands without changing content, hierarchy or order')
