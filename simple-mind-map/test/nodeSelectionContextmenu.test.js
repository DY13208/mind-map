const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function load(relative, name) {
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
    .replace(`export default ${name}`, `module.exports = ${name}`)
  const sandbox = { module: { exports: {} } }
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
