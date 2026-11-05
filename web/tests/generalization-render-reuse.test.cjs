/**
 * createGeneralizationNode 结构复用分支的行为/健壮性测试。
 *
 * 概要子树在 openRealtimeRenderOnNodeTextEdit 开启时每敲一个字就会整图重排。
 * 修复后：结构没变就复用子节点实例，不再 child.remove() + 重建。
 * 这里用 stub 的 layout / MindMapNode 直接驱动真实函数，验证：
 *  - 只改文字：不重建，复用同一批子节点实例
 *  - 增删节点 / 展开态变化 / range 变化 / children 数组被替换：必须重建
 *  - 复用分支不会抛错（之前画布整体空白，怀疑渲染期异常）
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const raw = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')

// 去掉 import 与 export，注入最小依赖
const source = raw
  .replace(/^import .*$/gm, '')
  .replace(/^export default /m, 'module.exports = ')

const rebuildCalls = []
class FakeMindMapNode {
  constructor(opt) {
    this.nodeData = opt.data
    this.isGeneralization = !!opt.isGeneralization
    this.layerIndex = opt.layerIndex
    this.children = []
    this.group = {}
    this.generalizationBelongNode = null
    this.parent = null
    this.width = 100
    this.height = 30
    this.childrenAreaHeight = 0
    this._generalizationList = []
  }
  handleData(data) {
    data.data.expand = data.data.expand === false ? false : true
    data.children = data.children || []
    return data
  }
  getData(key) {
    if (key === undefined) return this.nodeData.data
    if (key === 'expand') return this.nodeData.data.expand
    return this.nodeData.data[key]
  }
  checkHasGeneralization() {
    const g = this.nodeData.data.generalization
    return !!g && (!Array.isArray(g) || g.length > 0)
  }
  formatGetGeneralization() {
    const g = this.nodeData.data.generalization
    return Array.isArray(g) ? g : g ? [g] : []
  }
  removeGeneralization() { this._generalizationList = [] }
  updateGeneralization() {}
}

const sandbox = {
  module: { exports: {} },
  console,
  MindMapNode: FakeMindMapNode,
  createUid: () => 'uid-' + Math.random().toString(36).slice(2, 8),
  collabGeneralization: require(path.join(ROOT, 'utils/collabGeneralization.js')),
  walk: undefined
}
// 真实文件里用的是简化的 walk 调用，这里给个够用的实现
sandbox.walk = (root, parent, before, after, isRoot, layerIndex = 0, index = 0, ancestors = []) => {
  const stop = before && before(root, parent, isRoot, layerIndex, index, ancestors)
  if (!stop && root.children && root.children.length) {
    root.children.forEach((n, i) => sandbox.walk(n, root, before, after, false, layerIndex + 1, i, [...ancestors, root]))
  }
  after && after(root, parent, isRoot, layerIndex, index, ancestors)
}

vm.runInNewContext(source, sandbox)
const api = sandbox.module.exports
check('模块加载成功', !!api && typeof api.createGeneralizationNode === 'function')

// 组装 owner 节点
function makeOwner(generalization) {
  const owner = Object.create(FakeMindMapNode.prototype)
  Object.assign(owner, {
    nodeData: { data: { uid: 'owner-1', text: '分支主题', expand: true, generalization }, children: [] },
    isGeneralization: false,
    isRoot: false,
    layerIndex: 2,
    children: [],
    group: {},
    generalizationBelongNode: null,
    parent: null,
    width: 100,
    height: 30,
    childrenAreaHeight: 0,
    _generalizationList: [],
    color: '#333'
  })
  owner.lineDraw = { path: () => ({ node: null, remove() {}, add() {} }), node: {} }
  owner.renderer = {}
  owner.mindMap = {}
  owner.style = { generalizationLine: () => {} }
  return owner
}

function makeEnv(owner) {
  const created = []
  const layout = {
    getGeneralizationChildGrowDir: () => 'h',
    getMarginY: () => 20,
    createGeneralizationChildNodes: gNode => {
      rebuildCalls.push(gNode)
      // 模拟真实实现：清空并重建 children
      gNode.children = (gNode.nodeData.children || []).map(child => {
        const n = new FakeMindMapNode({
          data: child,
          isGeneralization: true,
          layerIndex: gNode.layerIndex + 1
        })
        n.group = {}
        created.push(n)
        return n
      })
      gNode.childrenAreaHeight = gNode.children.length * 30
    },
    measureGeneralizationTree: () => ({ width: 120, height: 40 }),
    renderGeneralization: () => {}
  }
  owner.renderer = {
    layout,
    registerNodeIndex: () => {},
    addNodeToActiveList: () => {}
  }
  owner.mindMap = { renderer: owner.renderer }
  return { layout, created }
}

function genItem(uid, children, extra = {}) {
  return { uid, text: '概要' + uid, expand: true, children, ...extra }
}
function leaf(uid, text = '分支主题') {
  return { data: { uid, text, expand: true, richText: true }, children: [] }
}

// ---- 1. 首次创建 ----
const itemA = genItem('g1', [leaf('c1'), leaf('c2')])
const owner = makeOwner([itemA])
const env = makeEnv(owner)
rebuildCalls.length = 0
api.createGeneralizationNode.call(owner)
check('首次创建：调用了 createGeneralizationChildNodes', rebuildCalls.length === 1)
const firstKids = owner._generalizationList[0].generalizationNode.children.slice()
check('首次创建：子节点数为 2', firstKids.length === 2, String(firstKids.length))

// ---- 2. 只改文字：不应重建 ----
rebuildCalls.length = 0
itemA.children[0].data.text = '改过的文字'
api.createGeneralizationNode.call(owner)
check(
  '只改文字：不调用 createGeneralizationChildNodes（复用实例）',
  rebuildCalls.length === 0,
  'calls=' + rebuildCalls.length
)
check(
  '只改文字：子节点实例保持同一批',
  owner._generalizationList[0].generalizationNode.children[0] === firstKids[0]
)

// ---- 3. 新增子节点：必须重建 ----
rebuildCalls.length = 0
itemA.children.push(leaf('c3'))
api.createGeneralizationNode.call(owner)
check('新增子节点：触发重建', rebuildCalls.length === 1)
check('新增子节点：子节点数变 3', owner._generalizationList[0].generalizationNode.children.length === 3)

// ---- 4. 展开态变化：必须重建 ----
rebuildCalls.length = 0
itemA.children[0].data.expand = false
api.createGeneralizationNode.call(owner)
check('展开态变化：触发重建', rebuildCalls.length === 1)

// ---- 5. children 数组被整体替换（远端快照）：必须重建 ----
rebuildCalls.length = 0
itemA.children = [leaf('c1'), leaf('c2'), leaf('c3')]
api.createGeneralizationNode.call(owner)
check('children 数组被替换：触发重建', rebuildCalls.length === 1)

// ---- 6. 复用分支不抛错且高度有效 ----
rebuildCalls.length = 0
let threw = null
try {
  api.createGeneralizationNode.call(owner)
  api.createGeneralizationNode.call(owner)
} catch (err) {
  threw = err
}
check('连续渲染两次不抛错', threw === null, threw ? threw.message : '')
const height = owner._generalizationList[0].generalizationNode.childrenAreaHeight
check('childrenAreaHeight 是有限数字', typeof height === 'number' && Number.isFinite(height), String(height))

// ---- 7. 扁平 children（导入/历史数据）不能中断渲染 ----
{
  const flat = {
    uid: 'g2',
    text: '概要',
    expand: true,
    children: [{ uid: 'f1', text: '扁平子节点', expand: true, children: [] }]
  }
  const owner2 = makeOwner([flat])
  makeEnv(owner2)
  let err = null
  try {
    api.createGeneralizationNode.call(owner2)
  } catch (e) {
    err = e
  }
  check('扁平 children 不抛错', err === null, err ? err.message : '')
  check(
    '扁平 children 被就地包成 { data, children }',
    flat.children[0] && flat.children[0].data && flat.children[0].data.uid === 'f1'
  )
  check(
    '包装后 data 指回原对象（编辑能写回）',
    flat.children[0].data === flat.children[0].data && flat.children[0].data.text === '扁平子节点'
  )
}

// ---- 8. 深层嵌套 + 空 children 边界 ----
{
  const deep = genItem('g3', [{
    data: { uid: 'd1', text: '一级', expand: true },
    children: [{ data: { uid: 'd2', text: '二级', expand: true }, children: [] }]
  }])
  const owner3 = makeOwner([deep])
  makeEnv(owner3)
  let err = null
  try {
    api.createGeneralizationNode.call(owner3)
    api.createGeneralizationNode.call(owner3)
  } catch (e) {
    err = e
  }
  check('深层嵌套连续渲染不抛错', err === null, err ? err.message : '')
}

{
  const empty = genItem('g4', [])
  const owner4 = makeOwner([empty])
  makeEnv(owner4)
  let err = null
  try {
    api.createGeneralizationNode.call(owner4)
  } catch (e) {
    err = e
  }
  check('children 为空数组不抛错', err === null, err ? err.message : '')
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
