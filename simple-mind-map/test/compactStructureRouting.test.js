const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.join(__dirname, '../src/layouts/CompactStructure.js'),
  'utf8'
).replace(/^import .*\n/gm, '').replace('export default CompactStructure', 'module.exports = CompactStructure')
const moduleMock = { exports: {} }
class LogicalStructure {
  constructor(renderer) {
    this.renderer = renderer
    this.mindMap = renderer.mindMap
  }

  computedBaseValue() {}
}
const compactLayoutConfig = {
  siblingGap: 10,
  childGap: 8,
  groupGap: 40,
  levelGap: 36,
  connectorLaneGap: 8,
  connectorMargin: 6,
  nodeMinHeight: 28
}
vm.runInNewContext(source, {
  module: moduleMock,
  LogicalStructure,
  compactLayoutConfig,
  asyncRun: () => {}
})

const node = (id, width, children = []) => ({
  id,
  left: 0,
  top: 0,
  width,
  height: 28,
  expandBtnSize: 16,
  children,
  getData: key => key === 'expand' ? true : undefined,
  hasCustomPosition: () => false
})

const segments = (d, owner) => {
  const horizontal = []
  const vertical = []
  let previous
  for (const [, command, rawX, rawY] of d.matchAll(/([ML])\s*(-?[\d.]+),(-?[\d.]+)/g)) {
    const point = [Number(rawX), Number(rawY)]
    if (command === 'L' && previous) {
      if (point[0] === previous[0] && point[1] !== previous[1]) {
        vertical.push({ owner, x: point[0], min: Math.min(point[1], previous[1]), max: Math.max(point[1], previous[1]) })
      } else if (point[1] === previous[1] && point[0] !== previous[0]) {
        horizontal.push({ owner, y: point[1], min: Math.min(point[0], previous[0]), max: Math.max(point[0], previous[0]) })
      }
    }
    previous = point
  }
  return { horizontal, vertical }
}

test('compact branches use separate routed trunks without crossing other branches', () => {
  const root = node('root', 80, [
    node('knowledge', 60, [node('software', 80)]),
    node('c', 40, Array.from({ length: 5 }, (_, i) => node(`c${i}`, 65))),
    node('sop', 55, [node('request', 75)]),
    node('itbp', 120, Array.from({ length: 7 }, (_, i) => node(`itbp${i}`, 90))),
    node('bid', 80, [node('policy', 90)]),
    node('wb', 70, Array.from({ length: 10 }, (_, i) => node(`wb${i}`, 75)))
  ])
  root.top = 300
  root.children.forEach(child => { child.layerIndex = 1 })
  const renderer = {
    mindMap: {
      opt: { alwaysShowExpandBtn: true, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  layout.root = root
  layout.renderReversedHorizontalLine = () => false
  const paths = []
  layout.setLineStyle = (style, line, d) => paths.push({ owner: line.owner, d })
  layout.computedBaseValue()
  layout.computedTopValue()

  assert.deepEqual(root.children.slice(1).map((child, i) => {
    return child.top - root.children[i].top - root.children[i].height
  }), [10, 10, 10, 10, 10])

  const branches = root.children.filter(child => child.children.length)
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i]
      const b = branches[j]
      const span = parent => {
        const ys = [parent.top + parent.height / 2,
          ...parent.children.map(child => child.top + child.height / 2)]
        return [Math.min(...ys), Math.max(...ys)]
      }
      const [aMin, aMax] = span(a)
      const [bMin, bMax] = span(b)
      if (aMin < bMax && bMin < aMax) {
        assert.ok(
          Math.abs(layout.busXByNode.get(a) - layout.busXByNode.get(b)) >= 8,
          `${a.id} and ${b.id} overlap on the same connector lane`
        )
      }
    }
  }

  for (const parent of [root, ...root.children]) {
    if (parent.children.length) {
      layout.renderLineStraight(parent, parent.children.map(() => ({ owner: parent.id })))
    }
  }
  const horizontal = []
  const vertical = []
  paths.forEach(({ owner, d }) => {
    const result = segments(d, owner)
    horizontal.push(...result.horizontal)
    vertical.push(...result.vertical)
  })
  assert.equal(vertical.length, 7, 'one vertical trunk for each expanded parent')
  for (const v of vertical) {
    for (const h of horizontal) {
      if (v.owner === h.owner) continue
      const crosses = v.x > h.min && v.x < h.max && h.y > v.min && h.y < v.max
      assert.equal(crosses, false, `${v.owner} trunk crosses ${h.owner} branch`)
    }
  }
  for (let i = 0; i < horizontal.length; i++) {
    for (let j = i + 1; j < horizontal.length; j++) {
      const a = horizontal[i]
      const b = horizontal[j]
      if (a.owner === b.owner) continue
      const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min)
      assert.ok(overlap <= 1 || Math.abs(a.y - b.y) >= 3,
        `${a.owner} and ${b.owner} paint over the same horizontal line`)
    }
  }
  for (const parent of root.children) {
    for (const v of vertical) {
      if (v.owner === parent.id) continue
      const crosses = v.x > parent.left && v.x < parent.left + parent.width &&
        v.max > parent.top && v.min < parent.top + parent.height
      assert.equal(crosses, false, `${v.owner} trunk crosses ${parent.id} node`)
    }
    for (const h of horizontal) {
      if (h.owner === parent.id) continue
      const crosses = h.y > parent.top && h.y < parent.top + parent.height &&
        h.max > parent.left && h.min < parent.left + parent.width
      assert.equal(crosses, false, `${h.owner} branch crosses ${parent.id} node`)
    }
  }
})

test('children keep the same local gap after parents of different widths', () => {
  const root = node('root', 80, [
    node('short', 50, [node('short-child', 70)]),
    node('long', 160, [node('long-child', 70)])
  ])
  root.top = 300
  const renderer = {
    mindMap: {
      opt: { alwaysShowExpandBtn: true, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  layout.root = root
  layout.computedBaseValue()
  layout.computedTopValue()
  const gaps = root.children.map(parent => {
    return parent.children[0].left - parent.left - parent.width
  })
  assert.deepEqual(gaps, [36, 36])
})

test('resizing a parent shifts its children and connector in the same layout pass', () => {
  const child = node('child', 70)
  const parent = node('parent', 60, [child])
  parent.layerIndex = 1
  const root = node('root', 80, [parent])
  root.top = 300
  const renderer = {
    mindMap: {
      opt: { alwaysShowExpandBtn: true, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  layout.root = root
  layout.computedBaseValue()
  layout.computedTopValue()
  const oldLeft = child.left
  const oldBus = layout.busXByNode.get(parent)
  parent.width = 180
  layout.computedTopValue()
  assert.ok(child.left > oldLeft)
  assert.ok(layout.busXByNode.get(parent) > oldBus)
})

test('a branch trunk stays outside a neighboring node in its vertical span', () => {
  const request = node('request', 70)
  request.top = 138
  const sop = node('sop', 70, [request])
  sop.top = 100
  sop.layerIndex = 1
  const itbp = node('itbp', 140)
  itbp.top = 136
  const root = node('root', 80, [sop, itbp])
  const renderer = {
    mindMap: {
      opt: { alwaysShowExpandBtn: true, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  layout.levels = [[root], [sop, itbp], [request]]
  layout.positionChildGroups([sop, itbp], [{ parent: sop, children: [request] }])
  layout.assignConnectorLanes(1)
  assert.ok(layout.busXByNode.get(sop) > itbp.left + itbp.width)

  let path
  layout.renderReversedHorizontalLine = () => false
  layout.setLineStyle = (style, line, d) => { path = d }
  layout.renderLineStraight(sop, [{}])
  const { vertical } = segments(path, sop.id)
  assert.ok(vertical.every(v => {
    return v.x >= itbp.left + itbp.width ||
      v.max <= itbp.top || v.min >= itbp.top + itbp.height
  }))
})

test('resize preview completes compact layout in the same paint', () => {
  const renderer = {
    _syncLayoutForResize: true,
    mindMap: {
      opt: { alwaysShowExpandBtn: false, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  const calls = []
  layout.root = node('root', 80)
  layout.computedBaseValue = () => calls.push('measure')
  layout.computedTopValue = () => calls.push('position')
  layout.doLayout(() => calls.push('paint'))
  assert.deepEqual(calls, ['measure', 'position', 'paint'])
  assert.equal(renderer._syncLayoutForResize, false)
})

test('a widened parent does not route its connector through another child group', () => {
  const request = node('request', 80)
  request.left = 830
  request.top = 417
  const neighboringChild = node('neighboring-child', 130)
  neighboringChild.left = 590
  neighboringChild.top = 484
  const c = node('c', 380)
  c.left = 418
  c.top = 434
  const sop = node('sop', 70, [request])
  sop.left = 418
  sop.top = 484
  sop.layerIndex = 1
  const itbp = node('itbp', 130, [neighboringChild])
  itbp.left = 418
  itbp.top = 524
  itbp.layerIndex = 1
  const root = node('root', 150, [c, sop, itbp])
  const renderer = {
    mindMap: {
      opt: { alwaysShowExpandBtn: true, notShowExpandBtn: false },
      themeConfig: { nodeUseLineStyle: false }
    }
  }
  const layout = new moduleMock.exports(renderer)
  layout.root = root
  layout.levels = [[root], [c, sop, itbp], [request, neighboringChild]]
  layout.obstacleRightByNode.set(sop, c.left + c.width)
  layout.obstacleRightByNode.set(itbp, c.left + c.width)
  layout.renderReversedHorizontalLine = () => false
  const paths = []
  layout.setLineStyle = (style, line, d) => paths.push({ owner: line.owner, d })
  layout.assignConnectorLanes(1)
  assert.notEqual(layout.armOffsetsByNode.get(sop).source, 0,
    'the widened C node should force the SOP source arm around the next group')
  layout.renderLineStraight(sop, [{ owner: sop.id }])
  const foreignChildren = [
    { parent: itbp, child: neighboringChild },
    { parent: c, child: c }
  ]
  for (const { owner, d } of paths) {
    const { horizontal, vertical } = segments(d, owner)
    for (const { parent, child } of foreignChildren) {
      if (parent.id === owner) continue
      const left = child.left + 1
      const right = child.left + child.width - 1
      const top = child.top + 1
      const bottom = child.top + child.height - 1
      const crosses = horizontal.some(line => line.y > top && line.y < bottom &&
        line.max > left && line.min < right) ||
        vertical.some(line => line.x > left && line.x < right &&
          line.max > top && line.min < bottom)
      assert.equal(crosses, false, `${owner} connector crosses ${child.id}`)
    }
  }
})
