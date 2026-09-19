const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

function loadClass(file, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/layouts', file), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
    .replace(/export default (\w+)/, 'module.exports = $1')
  const module = { exports: {} }
  vm.runInNewContext(source, { module, ...globals }, { filename: file })
  return module.exports
}

const CONSTANTS = { LAYOUT_GROW_DIR: { LEFT: 'left', RIGHT: 'right' } }
const Base = loadClass('Base.js')
const layouts = ['LogicalStructure.js', 'MindMap.js'].map(file => [
  file, loadClass(file, { Base, CONSTANTS })
])

for (const [name, Layout] of layouts) {
  for (const lineStyle of ['straight', 'direct', 'curve']) {
    for (const declaredLeft of [false, true]) {
      test(`${name} ${lineStyle}: reversed ${declaredLeft ? 'left' : 'right'} branch connects facing edges`, () => {
        const layout = Object.assign(Object.create(Layout.prototype), {
          isUseLeft: declaredLeft,
          mindMap: {
            opt: { alwaysShowExpandBtn: false },
            themeConfig: { lineRadius: 5, nodeUseLineStyle: false }
          },
          getMarginX: () => 80
        })
        const child = {
          left: declaredLeft ? 250 : 20, top: 75, width: 60, height: 30,
          dir: declaredLeft ? 'left' : 'right'
        }
        const node = { left: 130, top: 110, width: 80, height: 30, layerIndex: 2, children: [child] }
        const before = JSON.stringify(node)
        let plotted
        let styled
        layout.renderLine(node, [{ plot: p => { plotted = p } }], (_line, target) => { styled = target }, lineStyle)
        const coordinates = plotted.match(/-?\d+(?:\.\d+)?/g).map(Number)
        const xs = coordinates.filter((_v, i) => i % 2 === 0)
        const parentEdge = declaredLeft ? 210 : 130
        const childEdge = declaredLeft ? 250 : 80
        assert.equal(xs[0], parentEdge)
        assert.equal(xs.at(-1), childEdge)
        assert.ok(xs.every(x => x >= Math.min(parentEdge, childEdge) && x <= Math.max(parentEdge, childEdge)))
        assert.equal(styled, child)
        assert.equal(JSON.stringify(node), before, 'routing must not change saved positions or direction')
      })
    }
  }
}

test('normal branches retain their existing connector route', () => {
  const layout = Object.create(Base.prototype)
  const parent = { left: 100, width: 50 }
  assert.equal(layout.renderReversedHorizontalLine(parent, { left: 200, width: 30 }, null, null, 'straight', false), false)
  assert.equal(layout.renderReversedHorizontalLine(parent, { left: 0, width: 30 }, null, null, 'straight', true), false)
})

test('a narrow reversed gap cannot send a rounded corner through text', () => {
  const layout = Object.assign(Object.create(Base.prototype), {
    mindMap: { opt: {}, themeConfig: { lineRadius: 20 } }
  })
  let plotted
  layout.renderReversedHorizontalLine(
    { left: 100, top: 80, width: 80, height: 30 },
    { left: 35, top: 79, width: 60, height: 30 },
    { plot: p => { plotted = p } }, null, 'straight', false
  )
  const xs = plotted.match(/-?\d+(?:\.\d+)?/g).map(Number).filter((_v, i) => i % 2 === 0)
  assert.ok(xs.every(x => x >= 95 && x <= 100))
})
