const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const windowEvents = new Map()
const browserWindow = {
  addEventListener: (name, handler) => windowEvents.set(name, handler),
  removeEventListener: (name, handler) => { if (windowEvents.get(name) === handler) windowEvents.delete(name) }
}

function load(relative, name) {
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
    .replace(`export default ${name}`, `module.exports = ${name}`)
  const sandbox = { module: { exports: {} }, setTimeout, clearTimeout, window: browserWindow }
  vm.runInNewContext(source, sandbox)
  return sandbox.module.exports
}
const MindMapNode = load('../src/core/render/node/MindMapNode.js', 'MindMapNode')
const Select = load('../src/plugins/Select.js', 'Select')
const View = load('../src/core/view/View.js', 'View')
const style = () => {
  const values = new Map()
  return { values, setProperty: (key, value) => values.set(key, value),
    removeProperty: key => values.delete(key) }
}

function makeNode(uid, active) {
  const node = Object.create(MindMapNode.prototype)
  const data = { uid, isActive: active }
  const handlers = {}
  node.uid = uid
  node.getData = key => key ? data[key] : data
  node.getStyle = () => '#246bff'
  node.getBorderWidth = () => 1
  node.group = { on: (event, handler) => { handlers[event] = handler },
    addClass() {}, removeClass() {} }
  node.shapeNode = { node: { style: style() } }
  node.hoverNode = { node: { style: style() } }
  return { node, data, handlers }
}

test('selection colors the existing shape and restores its theme border on deselection', () => {
  const { node, data } = makeNode('a', true)
  node.mindMap = { opt: {} }
  node.updateNodeActiveClass()
  assert.equal(node.shapeNode.node.style.values.get('stroke'), '#246bff')
  assert.equal(node.shapeNode.node.style.values.get('stroke-width'), '2')
  assert.equal(node.hoverNode.node.style.values.get('display'), 'none')
  data.isActive = false
  node.updateNodeActiveClass()
  assert.equal(node.shapeNode.node.style.values.size, 0)
  assert.equal(node.hoverNode.node.style.values.size, 0)
})

test('right-click keeps a current single selection even when an older multi-selection exists', () => {
  const { node, handlers } = makeNode('a', true)
  const unrelated = { uid: 'b' }
  node.renderer = { activeNodeList: [node] }
  let menus = 0
  node.mindMap = { opt: {}, select: {
    getMultiSelectCache: () => [node, unrelated], isNodeInList: () => true
  }, emit: event => { if (event === 'node_contextmenu') menus++ } }
  node.active = () => assert.fail('right-click must not reselect an already selected node')
  node.restoreMultiSelect = () => assert.fail('old selections must not be restored')
  node.bindGroupEvent()
  handlers.contextmenu({ clientX: 100, clientY: 100, stopPropagation() {}, preventDefault() {} })
  assert.deepEqual(node.renderer.activeNodeList, [node])
  assert.equal(menus, 1)
  assert.equal(node.shapeNode.node.style.values.get('stroke'), '#246bff')
})

test('right-click preserves current multi-selection and selects a different target when needed', () => {
  const { node, handlers } = makeNode('a', true)
  const unrelated = { uid: 'b' }
  node.renderer = { activeNodeList: [node, unrelated] }
  node.mindMap = { opt: {}, emit() {} }
  let activations = 0
  node.active = () => { activations++; node.renderer.activeNodeList = [node] }
  node.bindGroupEvent()
  const event = { clientX: 100, clientY: 100, stopPropagation() {}, preventDefault() {} }
  handlers.contextmenu(event)
  assert.equal(activations, 0)
  assert.equal(node.renderer.activeNodeList.length, 2)
  node.renderer.activeNodeList = [unrelated]
  handlers.contextmenu(event)
  assert.equal(activations, 1)
  assert.deepEqual(node.renderer.activeNodeList, [node])
})

test('a click does not reuse a previous selection rectangle; a real drag still commits', () => {
  for (const didSelect of [false, true]) {
    const select = Object.create(Select.prototype)
    select.mindMap = { opt: {}, emit() {} }
    select.autoMove = { clearAutoMoveTimer() {} }
    select.isMousedown = true
    select.isSelecting = didSelect
    select.lastMultiSelectUids = []
    let checks = 0
    select.checkInNodesRaw = () => { checks++ }
    select.checkTriggerNodeActiveEvent = () => {}
    select.rememberMultiSelect = () => {}
    select.onMouseup()
    assert.equal(checks, didSelect ? 1 : 0)
    assert.equal(select.isMousedown, false)
  }
})

test('a pending selection callback cannot alter nodes after mouseup', () => {
  const select = Object.create(Select.prototype)
  select.isMousedown = false
  select.isSelecting = false
  select.mindMap = { renderer: { root: {} }, draw: {
    transform: () => assert.fail('a completed gesture must not check nodes again')
  } }
  select.checkInNodes()
})

test('a new selection gesture resets stale end coordinates', () => {
  const select = Object.create(Select.prototype)
  select.mouseMoveX = 900
  select.mouseMoveY = 800
  select.mindMap = { opt: { useLeftKeySelectionRightKeyDrag: false },
    renderer: { activeNodeList: [] }, toPos: (x, y) => ({ x, y }) }
  select.createRect = () => {}
  select.onMousedown({ which: 3, clientX: 100, clientY: 120 })
  assert.equal(select.mouseMoveX, 100)
  assert.equal(select.mouseMoveY, 120)
})

test('minor pointer jitter keeps the selected node; a real canvas drag clears it', () => {
  const handlers = {}
  const view = Object.create(View.prototype)
  let clears = 0
  let transforms = 0
  view.firstDrag = true
  view.sx = 0
  view.sy = 0
  view.transform = () => { transforms++ }
  view.setCanvasPanningCursor = () => {}
  view.syncCanvasDragCursor = () => {}
  view.mindMap = { opt: {}, el: { addEventListener() {} },
    keyCommand: { addShortcut() {} }, on() {},
    renderer: { activeNodeList: [{}] }, execCommand: () => { clears++ },
    event: { on: (event, handler) => { handlers[event] = handler } } }
  view.bind()
  handlers.drag({}, { mousemoveOffset: { x: 2, y: 3 } })
  assert.equal(clears, 0)
  assert.equal(transforms, 0)
  handlers.drag({}, { mousemoveOffset: { x: 10, y: 3 } })
  assert.equal(clears, 1)
  assert.equal(transforms, 1)
})

test('context menu actions use current selection rather than historical cached nodes', () => {
  const source = fs.readFileSync(path.join(__dirname,
    '../../web/src/pages/Edit/components/Contextmenu.vue'), 'utf8')
  const method = name => {
    const start = source.indexOf(`    ${name}(`)
    return source.slice(start, source.indexOf('\n    },', start) + 7).trim().replace(/,$/, '')
  }
  const methods = vm.runInNewContext(`({ ${method('collectSelectedNodes')}, ${method('getCachedMultiNodes')} })`)
  const a = { uid: 'a' }
  const b = { uid: 'b' }
  const context = { mindMap: { renderer: { activeNodeList: [a] },
    select: { getMultiSelectCache: () => [a, b] } }, nodeUid: node => node.uid }
  assert.deepEqual(Array.from(methods.collectSelectedNodes.call(context, a)), [a])
  assert.deepEqual(Array.from(methods.getCachedMultiNodes.call(context)), [a])
  context.mindMap.renderer.activeNodeList = [a, b]
  assert.deepEqual(Array.from(methods.collectSelectedNodes.call(context, a)), [a, b])
})


function selectionGesture() {
  const select = Object.create(Select.prototype)
  const handlers = new Map()
  let autoMoves = 0, clears = 0, checks = 0
  select.mindMap = {
    opt: { useLeftKeySelectionRightKeyDrag: true },
    elRect: { left: 100, top: 50, right: 800, bottom: 600 },
    renderer: { activeNodeList: [], emitNodeActiveEvent() {} },
    toPos: (x, y) => ({ x: x - 100, y: y - 50 }),
    on: (name, handler) => handlers.set(name, handler),
    off: (name, handler) => { if (handlers.get(name) === handler) handlers.delete(name) },
    emit() {}
  }
  select.lastMultiSelectUids = []
  select.rect = null
  select.autoMove = { clearAutoMoveTimer: () => { clears++ },
    onMove: (x, y, callback) => { autoMoves++; callback() } }
  select.createRect = () => { select.rect = { plot() {}, remove() {} } }
  select.bindEvent()
  select.checkInNodesRaw = () => { checks++ }
  select.onMousedown({ which: 1, clientX: 200, clientY: 150 })
  select.onMousemove({ clientX: 300, clientY: 250, buttons: 1 })
  return { select, handlers, get autoMoves() { return autoMoves }, get clears() { return clears }, get checks() { return checks } }
}

test('a lost release freezes selection before an unpressed hover reaches another region', () => {
  const x = selectionGesture()
  try {
    x.select.onMousemove({ clientX: 700, clientY: 500, buttons: 0 })
    assert.equal(x.select.isMousedown, false)
    assert.equal(x.select.isSelecting, false)
    assert.equal(x.select.mouseMoveX, 200)
    assert.equal(x.select.mouseMoveY, 200)
    assert.equal(x.autoMoves, 1)
    assert.equal(x.checks, 1)
    assert.equal(x.select.checkInNodesTimer, null)
  } finally { x.select.unBindEvent() }
})

test('right-button selection stops when only the unrelated left button is held', () => {
  const x = selectionGesture()
  try {
    x.select.selectionButton = 2
    x.select.onMousemove({ clientX: 700, clientY: 500, buttons: 1 })
    assert.equal(x.select.isMousedown, false)
    assert.equal(x.autoMoves, 1)
  } finally { x.select.unBindEvent() }
})

test('window blur finishes the gesture, clears delayed work and unbinds on disposal', () => {
  const x = selectionGesture()
  assert.equal(typeof windowEvents.get('blur'), 'function')
  windowEvents.get('blur')()
  assert.equal(x.select.isMousedown, false)
  assert.equal(x.select.rect, null)
  assert.equal(x.select.checkInNodesTimer, null)
  assert.equal(x.checks, 1)
  x.select.unBindEvent()
  assert.equal(windowEvents.has('blur'), false)
  assert.equal(x.handlers.size, 0)
})

test('moving over a sidebar stops automatic panning and retains the last canvas rectangle', () => {
  const x = selectionGesture()
  try {
    const clears = x.clears
    x.select.onMousemove({ clientX: 900, clientY: 500, buttons: 1 })
    assert.equal(x.autoMoves, 1)
    assert.ok(x.clears > clears)
    assert.equal(x.select.mouseMoveX, 200)
    assert.equal(x.select.mouseMoveY, 200)
    x.select.onMouseup({ clientX: 900, clientY: 500 })
    assert.equal(x.select.mouseMoveX, 200)
    assert.equal(x.select.mouseMoveY, 200)
  } finally { x.select.unBindEvent() }
})

test('a started rectangle can shrink back near its origin', () => {
  const x = selectionGesture()
  try {
    x.select.onMousemove({ clientX: 205, clientY: 155, buttons: 1 })
    assert.equal(x.autoMoves, 2)
    assert.equal(x.select.mouseMoveX, 105)
    assert.equal(x.select.mouseMoveY, 105)
  } finally { x.select.unBindEvent() }
})

test('both canvas and node release use the actual final pointer position', () => {
  for (const onNode of [false, true]) {
    const x = selectionGesture()
    try {
      const e = { clientX: 310, clientY: 260 }
      if (onNode) x.handlers.get('node_mouseup')({}, e)
      else x.handlers.get('mouseup')(e)
      assert.equal(x.select.mouseMoveX, 210)
      assert.equal(x.select.mouseMoveY, 210)
      assert.equal(x.select.isMousedown, false)
    } finally { x.select.unBindEvent() }
  }
})
