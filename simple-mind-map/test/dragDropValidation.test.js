const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname,'../src/plugins/Drag.js'),'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
  .replace('export default Drag','module.exports = Drag')
const moduleMock = { exports: {} }
vm.runInNewContext(source,{module:moduleMock,Base:class {},CONSTANTS:{LAYOUT:{LOGICAL_STRUCTURE:'logicalStructure'}},collabPaste:{resolveDropBusinessNode:n=>n,publishGeneralizationDragTrace(){}}})
const Drag = moduleMock.exports
function node(left, top, children = []) {
  return {left,top,width:40,height:20,children,getData:k=>k==='expand'?true:'n',setOpacity(){},showChildren(){},endDrag(){}}
}
test('dropping a parent on a descendant cancels even with free drag enabled', async()=>{
  const child=node(100,100), parent=node(0,0,[child])
  let reset=false
  const drag=Object.assign(Object.create(Drag.prototype),{
    isMousedown:true,isDragging:true,clone:{},drawTransform:{scaleX:1,scaleY:1,translateX:0,translateY:0},beingDragNodeList:[parent],
    mindMap:{opt:{enableFreeDrag:true},toPos:(x,y)=>({x,y}),execCommand(){throw new Error('no mutation permitted')}},
    reset(){reset=true},onMove(){throw new Error('invalid drop must not update preview')}
  })
  await drag.onMouseup({clientX:110,clientY:110})
  assert.equal(reset,true)
})
test('release resolves the final target before an unexpired hover throttle',async()=>{
  const parent=node(0,0), target=node(100,100)
  let finalTarget
  const drag=Object.assign(Object.create(Drag.prototype),{
    isMousedown:true,isDragging:true,clone:{},drawTransform:{scaleX:1,scaleY:1,translateX:0,translateY:0},beingDragNodeList:[parent],nodeList:[target],
    placeholder:{size(){}},placeHolderLine:{hide(){}},removeExtraLines(){},
    onMove(){},handleOverlapNode(){},handleLogicalStructure(n){this.overlapNode=n},reset(){},
    mindMap:{opt:{layout:'logicalStructure',beforeDragEnd:args=>{finalTarget=args.overlapNodeUid;return true}},toPos:(x,y)=>({x,y}),execCommand(){}}
  })
  target.getData=k=>k==='isActive'?false:'target'
  await drag.onMouseup({clientX:110,clientY:110})
  assert.equal(finalTarget,'target')
})

