const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const utilsSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/index.js'),
  'utf8'
)
const bfsWalkMatch = utilsSource.match(
  /export const bfsWalk = \([\s\S]*?\n\}/
)
const overlapMatch = utilsSource.match(
  /export const checkTwoRectIsOverlap = \([\s\S]*?\n\}/
)
assert.ok(bfsWalkMatch, 'bfsWalk source must exist')
assert.ok(overlapMatch, 'checkTwoRectIsOverlap source must exist')
const helpers = vm.runInNewContext(`
${bfsWalkMatch[0].replace('export const bfsWalk =', 'const bfsWalk =')}
${overlapMatch[0].replace(
  'export const checkTwoRectIsOverlap =',
  'const checkTwoRectIsOverlap ='
)}
({ bfsWalk, checkTwoRectIsOverlap })
`)

const selectSource = fs
  .readFileSync(require.resolve('../src/plugins/Select.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export default Select', 'module.exports = Select')
const sandbox = {
  module: { exports: {} },
  AutoMove: function () {},
  bfsWalk: helpers.bfsWalk,
  throttle: fn => fn,
  checkTwoRectIsOverlap: helpers.checkTwoRectIsOverlap,
  console
}
vm.runInNewContext(selectSource, sandbox)
const Select = sandbox.module.exports

const makeNode = (uid, left, top, width = 40, height = 20, children = []) => {
  const node = {
    uid,
    left,
    top,
    width,
    height,
    children,
    _generalizationList: [],
    data: { isActive: false },
    getData(key) {
      if (key === undefined) return this.data
      return this.data[key]
    },
    setData(key, value) {
      this.data[key] = value
    }
  }
  children.forEach(child => {
    child.parent = node
  })
  return node
}

const root = makeNode('root', 0, 0)
const branch = makeNode('branch', 100, 40)
const gChild = makeNode('g-child', 320, 40)
const gNode = makeNode('g-root', 280, 40, 40, 20, [gChild])
branch._generalizationList = [{ generalizationNode: gNode }]
root.children = [branch]

const activated = []
const select = Object.create(Select.prototype)
select.mouseDownX = 270
select.mouseDownY = 30
select.mouseMoveX = 380
select.mouseMoveY = 80
select.mindMap = {
  draw: {
    transform: () => ({ scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 })
  },
  renderer: {
    root,
    addNodeToActiveList(node) {
      activated.push(node.uid)
      node.data.isActive = true
    },
    removeNodeFromActiveList(node) {
      node.data.isActive = false
    },
    emitNodeActiveEvent() {}
  }
}
select.rememberMultiSelect = () => {}

select.checkInNodes()

assert.ok(
  activated.includes('g-child'),
  'box select must include generalization subtree nodes'
)
assert.ok(
  activated.includes('g-root'),
  'box select must still include the generalization node itself'
)
assert.ok(
  !activated.includes('branch'),
  'unrelated siblings outside the rect should not be activated when overlap helper is only for in-rect nodes'
)

console.log('select generalization subtree tests passed')
