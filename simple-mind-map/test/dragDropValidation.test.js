const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname,'../src/plugins/Drag.js'),'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
  .replace('export default Drag','module.exports = Drag')
const moduleMock = { exports: {} }
const layouts = {
  LOGICAL_STRUCTURE:'logicalStructure',
  LOGICAL_STRUCTURE_LEFT:'logicalStructureLeft',
  ORGANIZATION_STRUCTURE:'organizationStructure'
}
vm.runInNewContext(source,{
  module:moduleMock,
  Base:class {},
  CONSTANTS:{
    LAYOUT:layouts,
    LAYOUT_GROW_DIR:{TOP:'top',LEFT:'left',BOTTOM:'bottom',RIGHT:'right'}
  },
  getNodeIndexInNodeList:(target,list)=>list.indexOf(target),
  collabPaste:{
    resolveDropBusinessNode:n=>n,
    publishGeneralizationDragTrace(){},
    generalizationCorridorPx:()=>0
  }
})
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

test('drag without a valid drop restores the node to the active list', async()=>{
  const dragged=node(0,0)
  dragged.getData=k=>k==='uid'?'dragged':k==='expand'?true:false
  const active=[]
  const drag=Object.assign(Object.create(Drag.prototype),{
    isMousedown:true,isDragging:true,clone:{},drawTransform:null,
    beingDragNodeList:[dragged],removeCloneNode(){},reset(){},
    mindMap:{
      opt:{enableFreeDrag:false},
      renderer:{
        findNodeByUid:uid=>uid==='dragged'?dragged:null,
        addNodeToActiveList:node=>active.push(node),
        emitNodeActiveEvent(){}
      },
      emit(){}
    }
  })
  await drag.onMouseup({clientX:0,clientY:0})
  assert.deepEqual(active,[dragged])
})

function dropTarget({ left = 100, top = 100, width = 80, height = 40 } = {}) {
  return {
    left, top, width, height,
    layerIndex: 1,
    dir: 'right',
    isRoot: false,
    parent: null
  }
}

function dragForEdgeTest(layout, mouseMoveX, mouseMoveY, scale = 1) {
  let placeholder
  return Object.assign(Object.create(Drag.prototype), {
    mindMap: {
      opt: { layout },
      renderer: {
        layout: {
          getMarginX: () => 40,
          getMarginY: () => 20
        }
      }
    },
    drawTransform: {
      scaleX: scale,
      scaleY: scale,
      translateX: 0,
      translateY: 0
    },
    mouseMoveX,
    mouseMoveY,
    minOffset: 10,
    placeholderWidth: 50,
    placeholderHeight: 10,
    beingDragNodeList: [{ width: 70 }],
    overlapNode: null,
    prevNode: null,
    nextNode: null,
    setPlaceholderRect(rect) { placeholder = rect },
    getPlaceholderHint() { return placeholder }
  })
}

test('bottom edge of the last mind-map sibling offers an insert-after target and hint', () => {
  const target = dropTarget()
  const drag = dragForEdgeTest(layouts.LOGICAL_STRUCTURE, 110, 132)

  drag.handleVerticalCheck(target, [target])

  assert.equal(drag.prevNode, target)
  assert.equal(drag.nextNode, null)
  assert.equal(drag.overlapNode, null)
  assert.ok(drag.getPlaceholderHint(), 'insert-after placeholder should be rendered')
  assert.ok(drag.getPlaceholderHint().y > target.top + target.height)
})

test('insert-after edge target remains usable when the canvas is zoomed', () => {
  const target = dropTarget()
  const drag = dragForEdgeTest(layouts.LOGICAL_STRUCTURE, 220, 265, 2)

  drag.handleVerticalCheck(target, [target])

  assert.equal(drag.prevNode, target)
  assert.ok(drag.getPlaceholderHint())
})

test('right edge of the last horizontal sibling offers an insert-after target and hint', () => {
  const target = dropTarget()
  const drag = dragForEdgeTest(layouts.ORGANIZATION_STRUCTURE, 165, 110)

  drag.handleHorizontalCheck(target, [target])

  assert.equal(drag.prevNode, target)
  assert.equal(drag.overlapNode, null)
  assert.ok(drag.getPlaceholderHint(), 'insert-after placeholder should be rendered')
  assert.ok(drag.getPlaceholderHint().x > target.left + target.width)
})

test('right-side corridor offers a child drop target and placeholder in a right-growing mind map', () => {
  const target = { ...dropTarget(), children: [] }
  const drag = dragForEdgeTest(layouts.LOGICAL_STRUCTURE, 260, 120)

  drag.handleVerticalCheck(target, [target])
  assert.equal(drag.overlapNode, target)
  assert.equal(drag.prevNode, null)
  assert.equal(drag.nextNode, null)

  drag.handleOverlapNode()
  assert.ok(drag.getPlaceholderHint(), 'child placeholder should be rendered')
  assert.ok(drag.getPlaceholderHint().x > target.left + target.width)
})

test('left-side corridor offers the symmetric child drop target for a left-growing map', () => {
  const target = { ...dropTarget(), children: [] }
  const drag = dragForEdgeTest(layouts.LOGICAL_STRUCTURE_LEFT, 20, 120)

  drag.handleVerticalCheck(target, [target])
  assert.equal(drag.overlapNode, target)

  drag.handleOverlapNode()
  assert.ok(drag.getPlaceholderHint())
  assert.ok(drag.getPlaceholderHint().x < target.left)
})

test('the source guide follows each node shape without enclosing its children', () => {
  const styles = []
  const translations = []
  const shape = { css(value) { styles.push(value) } }
  const group = {
    attr() {},
    group() { return { translate(x, y) { translations.push([x, y]); return this }, add(s) { assert.equal(s, shape) } } }
  }
  const dragged = node(100, 200, [node(1600, 800)])
  dragged.shapeNode = { clone: () => shape }
  const drag = Object.assign(Object.create(Drag.prototype), {
    beingDragNodeList: [dragged], mindMap: { otherDraw: { group: () => group,
      rect: () => assert.fail('the guide must not create a padded rectangle') } }
  })
  drag.createDragRangeGuide()
  assert.deepEqual(translations, [[100, 200]])
  assert.equal(styles[0]['stroke-dasharray'], '6 4')
  assert.equal(styles[0].fill, 'none')
})

test('blank canvas drop creates an independent theme even when ordinary free drag is disabled', async () => {
  const dragged = node(50, 70)
  dragged.getData = key => key === 'uid' ? 'dragged' : key === 'expand' ? true : false
  const root = node(0, 0)
  let move
  const drag = Object.assign(Object.create(Drag.prototype), {
    isMousedown: true, isDragging: true, clone: {},
    beingDragNodeList: [dragged], nodeList: [],
    drawTransform: { scaleX: 2, scaleY: 2, translateX: 10, translateY: 20 },
    offsetX: 8, offsetY: 10,
    placeholder: { size() {} }, placeHolderLine: { hide() {} },
    removeExtraLines() {}, onMove() {}, removeCloneNode() {}, reset() {},
    mindMap: { opt: { enableFreeDrag: false }, toPos: (x, y) => ({ x, y }),
      execCommand(name, nodes, parent, positions) { move = { name, nodes, parent, positions } },
      renderer: { root, findNodeByUid: () => dragged, addNodeToActiveList() {}, emitNodeActiveEvent() {} }, emit() {} }
  })
  await drag.onMouseup({ clientX: 418, clientY: 430 })
  assert.equal(move.name, 'MOVE_NODE_TO')
  assert.equal(move.parent, root)
  assert.equal(move.positions[0].isFloating, true)
  assert.equal(move.positions[0].customLeft, 200)
  assert.equal(move.positions[0].customTop, 200)
})
