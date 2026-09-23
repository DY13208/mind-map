const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

function loadClass(file, globals = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/export default (\w+)/, 'module.exports = $1')
  const module = { exports: {} }
  vm.runInNewContext(source, { module, ...globals }, { filename: file })
  return module.exports
}

const Node = loadClass('core/render/node/MindMapNode.js')

function getNodeUid(node) {
  if (!node) return ''
  if (typeof node.getData === 'function') return node.getData('uid') || node.uid || ''
  return (node.data && node.data.uid) || node.uid || ''
}

function removeFromParentNodeData(node) {
  if (!node || !node.parent) return
  const uid = getNodeUid(node)
  const kids = node.parent.nodeData && node.parent.nodeData.children
  if (!Array.isArray(kids)) return
  node.parent.nodeData.children = kids.filter(
    item => !(item && item.data && item.data.uid === uid)
  )
}

function detachNodeFromParent(node) {
  if (!node || !node.parent) return
  const parent = node.parent
  const uid = getNodeUid(node)
  if (Array.isArray(parent.children)) {
    parent.children = parent.children.filter(
      item => item !== node && getNodeUid(item) !== uid
    )
  }
  removeFromParentNodeData(node)
  if (typeof parent.setData === 'function' && parent.nodeData) {
    parent.setData({ childCount: (parent.nodeData.children || []).length })
  }
  if (typeof parent.removeLine === 'function') parent.removeLine()
}

const Render = loadClass('core/render/Render.js', {
  CONSTANTS: { LAYOUT: {} },
  LogicalStructure: class {},
  MindMap: class {},
  CatalogOrganization: class {},
  OrganizationStructure: class {},
  Timeline: class {},
  VerticalTimeline: class {},
  Fishbone: class {},
  formatDataToArray: value => (Array.isArray(value) ? value : [value]),
  getNodeIndexInNodeList: (node, nodes) =>
    nodes.findIndex(item => getNodeUid(item) === getNodeUid(node)),
  getNodeUid,
  removeFromParentNodeData,
  detachNodeFromParent
})

function connector(owner) {
  const line = {
    removed: false,
    remove() {
      this.removed = true
    }
  }
  owner._lines.push(line)
  return line
}

function node(uid, children = []) {
  const data = { uid, expand: true, text: uid }
  const result = Object.assign(Object.create(Node.prototype), {
    children,
    _lines: [],
    nodeData: { data, children: children.map(n => n.nodeData) },
    getData: key => (key ? data[key] : data),
    setData: patch => Object.assign(data, patch),
    uid
  })
  children.forEach(child => {
    child.parent = result
  })
  return result
}

function walkCount(data) {
  let n = 0
  const walk = d => {
    if (!d) return
    n++
    ;(d.children || []).forEach(walk)
  }
  walk(data)
  return n
}

function bindRenderer() {
  return Object.assign(Object.create(Render.prototype), {
    runAfterHydrate: () => false,
    removeNodeFromActiveList: () => {},
    emitNodeActiveEvent: () => {},
    isInvalidMoveTarget: Render.prototype.isInvalidMoveTarget,
    resetMovedNodePosition: Render.prototype.resetMovedNodePosition,
    insertTo: Render.prototype.insertTo,
    insertAfter: Render.prototype.insertAfter,
    insertBefore: Render.prototype.insertBefore,
    moveNodeTo: Render.prototype.moveNodeTo,
    mindMap: { render() {} }
  })
}

test('multi-select MOVE_NODE_TO drops old parent membership and connectors', () => {
  const a = node('a')
  const b = node('b')
  const c = node('c')
  const old = node('old', [a, b, c])
  const target = node('target')
  const root = node('root', [old, target])
  root.nodeData.children = [old.nodeData, target.nodeData]
  old.nodeData.children = [a.nodeData, b.nodeData, c.nodeData]
  target.nodeData.children = []
  const staleA = connector(old)
  const staleB = connector(old)
  const keepC = connector(old)
  const renderer = bindRenderer()

  renderer.moveNodeTo([a, b], target)

  assert.deepEqual(old.children.map(n => n.uid), ['c'])
  assert.deepEqual(
    old.nodeData.children.map(n => n.data.uid),
    ['c']
  )
  assert.deepEqual(target.children.map(n => n.uid), ['a', 'b'])
  assert.deepEqual(
    target.nodeData.children.map(n => n.data.uid),
    ['a', 'b']
  )
  assert.equal(a.parent, target)
  assert.equal(b.parent, target)
  assert.equal(walkCount(root.nodeData), 6)
  assert.equal(staleA.removed, true)
  assert.equal(staleB.removed, true)
  assert.equal(keepC.removed, true)
  assert.equal(old._lines.length, 0)
  assert.equal(old.getData('childCount'), 1)
  assert.equal(target.getData('childCount'), 2)
})

test('multi-select INSERT_AFTER does not leave duplicate data under old parent', () => {
  const a = node('a')
  const b = node('b')
  const c = node('c')
  const old = node('old', [a, b, c])
  const anchor = node('anchor')
  const target = node('target', [anchor])
  const root = node('root', [old, target])
  root.nodeData.children = [old.nodeData, target.nodeData]
  old.nodeData.children = [a.nodeData, b.nodeData, c.nodeData]
  target.nodeData.children = [anchor.nodeData]
  connector(old)
  connector(old)
  connector(old)
  const renderer = bindRenderer()

  renderer.insertAfter([a, b], anchor)

  assert.deepEqual(old.children.map(n => n.uid), ['c'])
  assert.deepEqual(
    old.nodeData.children.map(n => n.data.uid),
    ['c']
  )
  assert.deepEqual(target.children.map(n => n.uid), ['anchor', 'a', 'b'])
  assert.deepEqual(
    target.nodeData.children.map(n => n.data.uid),
    ['anchor', 'a', 'b']
  )
  assert.equal(walkCount(root.nodeData), 7)
  assert.equal(old._lines.length, 0)
})

test('addChildren scrubs previous parent listing before multi-move layout reuse', () => {
  const a = node('a')
  const old = node('old', [a])
  const neu = node('new')
  assert.equal(a.parent, old)
  assert.equal(old.children.includes(a), true)
  // Production createNode may still point at the old parent when addChildren
  // runs; scrub must drop the stale membership so old parents cannot redraw
  // connectors to a node that already moved.
  neu.addChildren(a)
  a.parent = neu
  assert.equal(old.children.includes(a), false)
  assert.deepEqual(neu.children.map(n => n.uid), ['a'])
})

test('setPlaceholderRect replaces prior otherDraw extra lines', () => {
  const removed = []
  const makeLine = () => ({
    remove() {
      removed.push(this)
    },
    addClass() {
      return this
    },
    stroke() {
      return this
    },
    fill() {
      return this
    }
  })
  const first = [makeLine(), makeLine()]
  const second = [makeLine()]
  const drag = {
    placeHolderExtraLines: first.slice(),
    placeHolderLine: { show() {}, hide() { this.hidden = true }, hidden: false },
    placeholder: { size() { return this }, move() { return this } },
    placeholderWidth: 10,
    placeholderHeight: 4,
    beingDragNodeList: [{ fakeClone() { return {} } }],
    overlapNode: null,
    prevNode: {
      parent: { fakeClone() { return { children: [], _lines: [] } } },
      fakeClone() { return { style: { getStyle: () => 'straight' } } },
      style: { getStyle: () => 'straight' }
    },
    nextNode: null,
    mindMap: {
      opt: { dragPlaceholderLineConfig: { color: '#00f', width: 2 } },
      otherDraw: { add() {} },
      renderer: {
        layout: {
          renderLine(parent) {
            parent._lines = second.slice()
          }
        }
      }
    },
    removeExtraLines() {
      ;(this.placeHolderExtraLines || []).forEach(item => {
        if (item && typeof item.remove === 'function') item.remove()
      })
      this.placeHolderExtraLines = []
    },
    setPlaceholderRect({ x, y, dir, rotate, notRenderLine }) {
      this.removeExtraLines()
      this.placeholder.size(10, 4).move(x, y)
      if (notRenderLine) {
        this.placeHolderLine.hide()
        return
      }
      const parent = this.prevNode.parent.fakeClone()
      parent.children = [{}]
      parent._lines = []
      this.placeHolderLine.show()
      this.mindMap.renderer.layout.renderLine(parent, [this.placeHolderLine], () => {}, 'straight')
      this.placeHolderExtraLines = [...parent._lines]
      this.placeHolderExtraLines.forEach(line => {
        if (typeof line.addClass === 'function') line.addClass('smm-drag-placeholder-artifact')
        this.mindMap.otherDraw.add(line)
        line.stroke({ color: '#00f', width: 2 }).fill({ color: 'none' })
      })
    }
  }

  drag.setPlaceholderRect({ x: 1, y: 2, dir: 'right', rotate: false })
  assert.equal(first.every(line => removed.includes(line)), true)
  assert.equal(drag.placeHolderExtraLines.length, 1)
  assert.equal(drag.placeHolderExtraLines[0], second[0])

  drag.setPlaceholderRect({ x: 1, y: 2, dir: 'right', rotate: false, notRenderLine: true })
  assert.equal(drag.placeHolderLine.hidden, true)
  assert.equal(drag.placeHolderExtraLines.length, 0)
})
