const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

// 直接加载真实的 Base 布局代码，避免依赖浏览器侧 ESM 加载。
const source = fs
  .readFileSync(require.resolve('../src/layouts/Base.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export default Base', 'module.exports = Base')

const sandbox = {
  module: { exports: {} },
  CONSTANTS: { LAYOUT: { ORGANIZATION_STRUCTURE: 'organization' } },
  initRootNodePositionMap: () => ({}),
  Lru: function () {},
  createUid: () => 'uid',
  walk: () => {},
  console
}
vm.runInNewContext(source, sandbox)
const Base = sandbox.module.exports

const MARGIN = 20
const GEN_MARGIN = 15

function makeLayout() {
  const layout = Object.create(Base.prototype)
  layout.mindMap = {
    themeConfig: {
      generalizationNodeMargin: GEN_MARGIN,
      generalizationLineMargin: 5
    }
  }
  layout.getMarginX = () => MARGIN
  layout.getMarginY = () => MARGIN
  return layout
}

// 概要子树里的节点：可选地带上自己的概要（嵌套概要）
function node(opts) {
  const {
    width = 100,
    height = 30,
    children = [],
    layerIndex = 1,
    genWidth = 0,
    genHeight = 0
  } = opts || {}
  return {
    width,
    height,
    children,
    layerIndex,
    getData(key) {
      if (key === 'expand') return true
      return undefined
    },
    checkHasVisibleGeneralization() {
      return genWidth > 0 || genHeight > 0
    },
    getVisibleGeneralizationSize() {
      return {
        width: genWidth,
        height: genHeight,
        subtreeWidth: genWidth,
        subtreeHeight: genHeight
      }
    }
  }
}

const layout = makeLayout()

// 1. 没有嵌套概要时，测量结果保持原样
const plainChild = node({ width: 60, height: 30, layerIndex: 2 })
const plainGen = node({ width: 100, height: 30, children: [plainChild] })
const plain = layout.measureGeneralizationTree(plainGen, 'h')
assert.strictEqual(
  plain.width,
  100 + MARGIN + 60,
  'plain generalization subtree width must stay unchanged'
)

// 2. 概要节点自身带概要时，宽度要为嵌套概要预留空间
const nestedGen = node({
  width: 100,
  height: 30,
  children: [node({ width: 60, height: 30, layerIndex: 2 })],
  genWidth: 80
})
const nested = layout.measureGeneralizationTree(nestedGen, 'h')
assert.strictEqual(
  nested.width,
  100 + MARGIN + 60 + 80 + GEN_MARGIN,
  'nested generalization on the generalization node must reserve width'
)

// 3. 概要子树里的子节点自身带概要时，也要预留空间
const childWithGen = node({
  width: 60,
  height: 30,
  layerIndex: 2,
  genWidth: 40
})
const parentGen = node({ width: 100, height: 30, children: [childWithGen] })
const childNested = layout.measureGeneralizationTree(parentGen, 'h')
assert.strictEqual(
  childNested.width,
  100 + MARGIN + (60 + 40 + GEN_MARGIN),
  'nested generalization on a child inside the subtree must reserve width'
)

// 4. 纵向布局（组织结构图）走高度方向
const verticalNested = node({
  width: 100,
  height: 30,
  children: [node({ width: 60, height: 30, layerIndex: 2 })],
  genHeight: 50
})
const vertical = layout.measureGeneralizationTree(verticalNested, 'v')
assert.strictEqual(
  vertical.height,
  30 + MARGIN + 30 + 50 + GEN_MARGIN,
  'vertical layout must reserve height for nested generalization'
)

// 5. 不支持概要查询的节点（例如纯数据对象）不应抛错
assert.strictEqual(
  layout.getNestedGeneralizationExtent({ width: 10, height: 10 }, 'h'),
  0,
  'nodes without generalization helpers must be treated as no extra extent'
)
assert.strictEqual(layout.getNestedGeneralizationExtent(null, 'h'), 0)

console.log('nested generalization layout tests passed')
