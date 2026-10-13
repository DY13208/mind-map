const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function loadSourceClass(relativePath, name, dependencyNames = [], args = []) {
  let source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  source = source.replace(
    /^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\r?\n/gm,
    ''
  )
  source = source.replace(`export default ${name}`, `return ${name}`)
  return new Function(...dependencyNames, source)(...args)
}

function loadDefaultOptions() {
  let source = fs.readFileSync(
    path.join(root, 'src/constants/defaultOptions.js'),
    'utf8'
  )
  source = source.replace(/^import .*\r?\n/, '')
  source = source.replace('export const defaultOpt =', 'const defaultOpt =')
  source += '\nreturn defaultOpt'
  const constants = new Proxy(
    {},
    {
      get: () => constants
    }
  )
  return new Function('CONSTANTS', source)(constants)
}

class FakeAutoMove {
  clearAutoMoveTimer() {}

  onMove(clientX, clientY, onMove) {
    onMove()
  }
}

function walk(node, callback) {
  if (!node) return
  callback(node)
  ;(node.children || []).forEach(child => walk(child, callback))
}

function overlaps(minX, maxX, minY, maxY, left, right, top, bottom) {
  return minX <= right && maxX >= left && minY <= bottom && maxY >= top
}

const Select = loadSourceClass(
  'src/plugins/Select.js',
  'Select',
  ['bfsWalk', 'checkTwoRectIsOverlap', 'AutoMove'],
  [walk, overlaps, FakeAutoMove]
)
const MindMapNode = loadSourceClass(
  'src/core/render/node/MindMapNode.js',
  'MindMapNode'
)

function createRenderer(mindMap) {
  const renderer = {
    activeNodeList: [],
    clearActiveNodeList() {
      this.activeNodeList.forEach(node => {
        node.data.isActive = false
      })
      this.activeNodeList = []
    },
    addNodeToActiveList(node) {
      if (!this.activeNodeList.includes(node)) {
        this.activeNodeList.push(node)
      }
      node.data.isActive = true
    },
    removeNodeFromActiveList(node) {
      this.activeNodeList = this.activeNodeList.filter(item => item !== node)
      node.data.isActive = false
    },
    findActiveNodeIndex(node) {
      return this.activeNodeList.indexOf(node)
    },
    emitNodeActiveEvent(node) {
      mindMap.emit('node_active', node, this.activeNodeList)
    }
  }
  return renderer
}

function createMindMapNode(mindMap) {
  const listeners = {}
  const node = Object.create(MindMapNode.prototype)
  node.group = {
    on(name, callback) {
      listeners[name] = callback
    }
  }
  node.mindMap = mindMap
  node.renderer = mindMap.renderer
  node.isRoot = false
  node.isMultipleChoice = false
  node.isGeneralization = false
  node.isDrag = false
  node.userList = []
  node.data = { uid: `node-${Math.random()}`, isActive: false }
  node.getData = key => node.data[key]
  node.updateNodeActiveClass = () => {}
  node.updateDragHandle = () => {}
  node.showExpandBtn = () => {}
  node.hideExpandBtn = () => {}
  node.handleGeneralizationMouseenter = () => {}
  node.handleGeneralizationMouseleave = () => {}
  node.mindMap = mindMap
  node.bindGroupEvent()
  return { node, listeners }
}

function createMindMap(options) {
  const events = {}
  const emitted = []
  const mindMap = {
    opt: { ...options },
    emitted,
    on(name, callback) {
      ;(events[name] || (events[name] = [])).push(callback)
    },
    off(name, callback) {
      events[name] = (events[name] || []).filter(item => item !== callback)
    },
    emit(name, ...args) {
      emitted.push({ name, args })
      ;(events[name] || []).forEach(callback => callback(...args))
    },
    toPos(clientX, clientY) {
      return { x: clientX, y: clientY }
    },
    draw: {
      transform: () => ({
        scaleX: 1,
        scaleY: 1,
        translateX: 0,
        translateY: 0
      })
    },
    svg: {
      polygon() {
        return {
          stroke() {
            return this
          },
          fill() {
            return this
          },
          plot() {
            return this
          },
          remove() {
            this.removed = true
          }
        }
      }
    },
    event: { mousemovePos: { x: 100, y: 100 } },
    execCommandCalls: 0,
    execCommand() {
      this.execCommandCalls += 1
    }
  }
  mindMap.renderer = createRenderer(mindMap)
  return mindMap
}

function testNodeSelection(readonly, allowReadonlySelection, modifier = 'ctrl') {
  const mindMap = createMindMap({
    readonly,
    allowReadonlySelection,
    enableCtrlKeyNodeSelection: true,
    enableDragModifyNodeWidth: true,
    useLeftKeySelectionRightKeyDrag: true,
    mousedownEventPreventDefault: false,
    onlyOneEnableActiveNodeOnCooperate: false
  })
  const { node, listeners } = createMindMapNode(mindMap)
  const existing = createMindMapNode(mindMap).node
  mindMap.renderer.addNodeToActiveList(existing)
  const downEvent = {
    which: 1,
    button: 0,
    ctrlKey: modifier === 'ctrl',
    metaKey: modifier === 'meta',
    clientX: 50,
    clientY: 50,
    stopped: false,
    stopPropagation() {
      this.stopped = true
    },
    preventDefault() {}
  }

  listeners.mousedown(downEvent)
  const mousedownStopped = downEvent.stopped
  const clickEvent = { ...downEvent, stopped: false }
  listeners.click(clickEvent)
  listeners.dblclick({ ...clickEvent, ctrlKey: false, metaKey: false })

  return { mindMap, node, existing, listeners, mousedownStopped }
}

function testNodeClick(readonly, allowReadonlySelection) {
  const mindMap = createMindMap({
    readonly,
    allowReadonlySelection,
    enableCtrlKeyNodeSelection: true,
    enableDragModifyNodeWidth: true,
    useLeftKeySelectionRightKeyDrag: true,
    mousedownEventPreventDefault: false,
    onlyOneEnableActiveNodeOnCooperate: false
  })
  const { node, listeners } = createMindMapNode(mindMap)
  listeners.click({
    which: 1,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    stopPropagation() {}
  })
  return { mindMap, node }
}

function testReadonlyBoxSelection(allowReadonlySelection) {
  const mindMap = createMindMap({
    readonly: true,
    allowReadonlySelection,
    useLeftKeySelectionRightKeyDrag: true,
    mousedownEventPreventDefault: false
  })
  const child = {
    data: { uid: 'box-child', isActive: false },
    left: 20,
    top: 20,
    width: 40,
    height: 40,
    children: [],
    getData(key) {
      return this.data[key]
    }
  }
  mindMap.renderer.root = {
    data: { isActive: false },
    children: [child],
    getData(key) {
      return this.data[key]
    }
  }
  const select = new Select({ mindMap })
  const downEvent = {
    which: 1,
    ctrlKey: false,
    metaKey: false,
    clientX: 0,
    clientY: 0,
    preventDefault() {}
  }

  select.onMousedown(downEvent)
  const started = select.isMousedown
  if (started) {
    select.onMousemove({ clientX: 100, clientY: 100 })
    select.onMouseup()
  }
  select.beforePluginDestroy()
  return { mindMap, select, child, started }
}

assert.equal(loadDefaultOptions().allowReadonlySelection, false)

const disabledNodeSelection = testNodeSelection(true, false)
assert.equal(disabledNodeSelection.node.data.isActive, true)
assert.equal(disabledNodeSelection.node.isMultipleChoice, false)
assert.equal(disabledNodeSelection.mousedownStopped, false)
assert.equal(disabledNodeSelection.mindMap.renderer.activeNodeList.length, 1)
assert.equal(disabledNodeSelection.existing.data.isActive, false)
assert.equal(
  disabledNodeSelection.mindMap.emitted.some(
    event => event.name === 'node_dblclick'
  ),
  false
)
assert.equal(disabledNodeSelection.mindMap.execCommandCalls, 0)
assert.equal(disabledNodeSelection.node.checkEnableDragModifyNodeWidth(), false)

const enabledNodeSelection = testNodeSelection(true, true)
assert.equal(enabledNodeSelection.node.data.isActive, true)
assert.equal(enabledNodeSelection.node.isMultipleChoice, false)
assert.equal(enabledNodeSelection.mousedownStopped, true)
assert.equal(enabledNodeSelection.mindMap.renderer.activeNodeList.length, 2)
assert.equal(enabledNodeSelection.mindMap.execCommandCalls, 0)
assert.equal(enabledNodeSelection.node.checkEnableDragModifyNodeWidth(), false)

const enabledMetaSelection = testNodeSelection(true, true, 'meta')
assert.equal(enabledMetaSelection.node.data.isActive, true)
assert.equal(enabledMetaSelection.mousedownStopped, true)

const defaultReadonlyClick = testNodeClick(true, false)
assert.equal(defaultReadonlyClick.node.data.isActive, true)
const enabledReadonlyClick = testNodeClick(true, true)
assert.equal(enabledReadonlyClick.node.data.isActive, true)

const disabledBoxSelection = testReadonlyBoxSelection(false)
assert.equal(disabledBoxSelection.started, false)
assert.equal(disabledBoxSelection.child.data.isActive, false)
assert.equal(disabledBoxSelection.mindMap.execCommandCalls, 0)

const enabledBoxSelection = testReadonlyBoxSelection(true)
assert.equal(enabledBoxSelection.started, true)
assert.equal(enabledBoxSelection.child.data.isActive, true)
assert.equal(enabledBoxSelection.mindMap.execCommandCalls, 0)

console.log('只读单击保持可用；Ctrl/Meta 多选和框选默认关闭，启用后可用且不触发写命令。')
