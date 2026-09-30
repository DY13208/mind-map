const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

class Rect {
  constructor() { this.events = {}; this._parent = null }
  size(width, height) { this.width = width; this.height = height; return this }
  fill() { return this }
  stroke() { return this }
  radius() { return this }
  attr() { return this }
  css() { return this }
  x(value) { this.left = value; return this }
  y(value) { this.top = value; return this }
  on(name, handler) { this.events[name] = handler; return this }
  parent() { return this._parent }
  remove() { this._parent = null; return this }
}

const source = fs.readFileSync(
  path.join(__dirname, '../src/core/render/node/nodeModifyWidth.js'),
  'utf8'
).replace(/^import .*\n/gm, '').replace('export default {', 'module.exports = {')
const moduleMock = { exports: {} }
const frames = []
vm.runInNewContext(source, {
  module: moduleMock,
  Rect,
  window: { addEventListener() {}, removeEventListener() {} },
  document: { body: { style: { cursor: '' } } },
  requestAnimationFrame: callback => { frames.push(callback); return frames.length },
  cancelAnimationFrame() {}
})

test('both node edges can resize from either corner without visible handles', () => {
  const methods = moduleMock.exports
  for (const corner of [0, 1, 2, 3]) {
    const index = corner % 2
    const group = {
      add(handle) { handle._parent = this },
      css() {},
      addClass() {},
      removeClass() {}
    }
    let treeRenders = 0
    let previewWidth
    let storedData
    const node = {
      ...methods,
      mindMap: {
        opt: {
          enableDragModifyNodeWidth: true,
          minNodeTextModifyWidth: 20,
          maxNodeTextModifyWidth: -1
        },
        draw: { transform: () => ({ scaleX: 1 }) },
        render() { treeRenders++; previewWidth = node.nodeData.data.customTextWidth },
        emit() {}
      },
      renderer: { layout: { compactConfig: {} } },
      nodeData: { data: {} },
      group,
      width: 100,
      height: 30,
      left: 10,
      customTextWidth: 100,
      getData: key => key === 'isActive',
      checkEnableDragModifyNodeWidth: () => true,
      isUseCustomNodeContent: () => false,
      setData(data) {
        assert.equal(this.nodeData.data.customTextWidth, undefined)
        if (index === 0) assert.equal(this.nodeData.data.customLeft, undefined)
        storedData = data
        Object.assign(this.nodeData.data, data)
      }
    }
    node.initDragHandle()
    node.updateDragHandle()
    assert.equal(node._dragHandleNodes.length, 2)
    assert.equal(node._dragHandleMarks, undefined)
    assert.equal(JSON.stringify(node._dragHandleNodes.map(handle => [handle.left, handle.top])),
      JSON.stringify([[-6, -6], [94, -6]]))
    assert.equal(node._dragHandleNodes[0].height, 42)
    const event = {
      clientX: 100,
      clientY: corner < 2 ? 0 : 30,
      stopPropagation() {},
      preventDefault() {}
    }
    node._dragHandleNodes[index].events.mousedown(event)
    node.onDragMousemoveHandle({ ...event, clientX: 110 })
    assert.equal(node.customTextWidth, index % 2 === 0 ? 90 : 110)
    assert.equal(node.left, index % 2 === 0 ? 20 : 10)
    if (index === 0) assert.equal(node.nodeData.data.customLeft, 20)
    assert.equal(treeRenders, 0)
    frames.shift()()
    assert.equal(previewWidth, index % 2 === 0 ? 90 : 110)
    assert.equal(treeRenders, 1)
    assert.equal(node.renderer._syncLayoutForResize, true)
    node.onDragMouseupHandle()
    assert.equal(storedData.customTextWidth, index % 2 === 0 ? 90 : 110)
    if (index === 0) assert.equal(storedData.customLeft, 20)
    assert.equal(treeRenders, 2)
  }
})
