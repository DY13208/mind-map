/**
 * 概要后面的子节点「重叠到一起」回归测试。
 *
 * 现象：概要下挂多个子节点，文字改长之后（或连续插入后），几个节点叠在同一个
 * 位置上，看起来糊成一团。
 *
 * 根因：为了修「输入时子树被拆掉导致文字丢失」，createGeneralizationNode 加了
 * 结构复用分支——结构没变就不再 child.remove() + 重建。但「重建」这条路上
 * createNode 顺带做了 getSize()（重新量宽高）；复用分支把它一起跳过了，
 * 于是文字变长/换行的节点仍按旧 height 参与排版，
 * layoutGeneralizationChildren 用 `cur.top += cur.height + marginY` 递推，
 * 后一个兄弟就被放到前一个身上。
 *
 * 修复：复用分支里对「数据变过」或「高度缺失」的子节点补一次 getSize()，
 * 再算 childrenAreaHeight。
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
const source = raw.replace(/^import .*$/gm, '').replace(/^export default /m, 'module.exports = ')

// 子节点尺寸由文字长度决定，模拟「文字变长 → 换行 → 变高」
function heightForText(text) {
  const len = String(text || '').replace(/<[^>]+>/g, '').length
  return len > 6 ? 60 : 30
}

class FakeMindMapNode {
  constructor(opt) {
    this.nodeData = opt.data
    this.isGeneralization = !!opt.isGeneralization
    this.layerIndex = opt.layerIndex || 0
    this.children = []
    this.group = {}
    this.width = 80
    this.height = heightForText(this.nodeData && this.nodeData.data && this.nodeData.data.text)
    this.nodeDataSnapshot = JSON.stringify(this.getData())
    this.childrenAreaHeight = 0
    this.needLayout = false
    this.generalizationBelongNode = null
    this.parent = null
    this._generalizationList = []
    this.getSizeCalls = 0
  }
  handleData(data) {
    data.data.expand = data.data.expand === false ? false : true
    data.children = data.children || []
    return data
  }
  getData(key) {
    const d = this.nodeData.data
    if (key === undefined) return d
    return d[key]
  }
  getSize() {
    this.getSizeCalls++
    this.width = 80
    this.height = heightForText(this.getData('text'))
    this.nodeDataSnapshot = JSON.stringify(this.getData())
    return true
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
  addChildren(node) {
    if (!node) return
    if (!this.children.includes(node)) this.children.push(node)
  }
}

// 与 Base 同名方法的语义保持一致
const layout = {
  getGeneralizationChildGrowDir: () => 'h',
  getMarginX: () => 20,
  getMarginY: () => 20,
  checkIsNodeDataChange(lastData, curData) {
    if (!lastData) return false
    let prev = typeof lastData === 'string' ? JSON.parse(lastData) : lastData
    prev.isActive = curData.isActive
    prev.expand = curData.expand
    return JSON.stringify(prev) !== JSON.stringify(curData)
  },
  createGeneralizationChildNodes(gNode) {
    ;(gNode.children || []).forEach(c => c && c.remove && c.remove())
    gNode.children = []
    ;(gNode.nodeData.children || []).forEach(childTree => {
      const n = new FakeMindMapNode({
        data: childTree,
        isGeneralization: true,
        layerIndex: gNode.layerIndex + 1
      })
      n.parent = gNode
      gNode.addChildren(n)
    })
    gNode.childrenAreaHeight = gNode.children.length * 30
  },
  measureGeneralizationTree: node => ({ width: node.width + 20, height: node.height }),
  renderGeneralization: () => {}
}

const sandbox = {
  module: { exports: {} },
  console,
  MindMapNode: FakeMindMapNode,
  createUid: () => 'u-' + Math.random().toString(36).slice(2, 8),
  collabGeneralization: require(path.join(ROOT, 'utils/collabGeneralization.js'))
}
vm.runInNewContext(source, sandbox)
const api = sandbox.module.exports

function makeOwner(generalization) {
  const owner = Object.create(FakeMindMapNode.prototype)
  owner.nodeData = { data: { uid: 'owner-1', text: '分支主题', expand: true, generalization }, children: [] }
  owner.uid = 'owner-1'
  owner.isGeneralization = false
  owner.isRoot = false
  owner.layerIndex = 2
  owner.children = []
  owner.group = {}
  owner.height = 30
  owner.width = 80
  owner._generalizationList = []
  owner.lineDraw = {
    path: () => ({ addClass() {}, remove() {}, node: null }),
    add() {},
    node: {}
  }
  owner.nodeDraw = { find: () => ({ remove() {} }) }
  owner.renderer = {
    layout,
    registerNodeIndex: () => {},
    addNodeToActiveList: () => {},
    removeNodeFromActiveList: () => {},
    nodeCache: {},
    lastNodeCache: {}
  }
  owner.mindMap = { renderer: owner.renderer }
  return owner
}

function treeChild(uid, text) {
  return { data: { uid, text, expand: true, richText: true }, children: [] }
}

// 模拟 layoutGeneralizationChildren 的纵向递推，返回每个节点的 top
function computeTops(gNode, marginY = 20) {
  const kids = gNode.children
  const areaH = gNode.childrenAreaHeight || gNode.height
  const top = 0 + gNode.height / 2 - areaH / 2
  let totalTop = top + marginY
  const tops = []
  kids.forEach(cur => {
    tops.push(totalTop)
    totalTop += cur.height + marginY
  })
  return tops
}

function hasOverlap(gNode, marginY = 20) {
  const tops = computeTops(gNode, marginY)
  for (let i = 1; i < tops.length; i++) {
    const prevBottom = tops[i - 1] + gNode.children[i - 1].height
    if (tops[i] < prevBottom) return { overlap: true, index: i, tops }
  }
  return { overlap: false, tops }
}

// ---- 1. 首次渲染：不重叠 ----
const g = [{ uid: 'g1', text: '概要', expand: true, children: [treeChild('a', '短'), treeChild('b', '短'), treeChild('c', '短')] }]
const owner = makeOwner(g)
api.createGeneralizationNode.call(owner)
const gNode = owner._generalizationList[0].generalizationNode
check('首次渲染 3 个子节点', gNode.children.length === 3)
check('首次渲染不重叠', hasOverlap(gNode).overlap === false, JSON.stringify(hasOverlap(gNode).tops))

// ---- 2. 改长文字后（结构没变，走复用分支）：必须重新量尺寸，否则重叠 ----
{
  g[0].children[0].data.text = '这是一段明显更长的文字内容需要换行'
  api.createGeneralizationNode.call(owner)
  const first = gNode.children[0]
  check(
    '文字变长后子节点高度被重新测量',
    first.height === 60,
    'height=' + first.height
  )
  const res = hasOverlap(gNode)
  check('文字变长后仍不重叠', res.overlap === false, JSON.stringify(res.tops))
  check(
    'childrenAreaHeight 用了新高度（包含 60）',
    gNode.childrenAreaHeight >= 60 + 30 + 30,
    'area=' + gNode.childrenAreaHeight
  )
}

// ---- 3. 复用分支不该对没变的数据反复测量（避免每帧重算） ----
{
  const before = gNode.children[1].getSizeCalls
  api.createGeneralizationNode.call(owner)
  check(
    '数据没变的子节点不重复测量',
    gNode.children[1].getSizeCalls === before,
    'calls=' + gNode.children[1].getSizeCalls
  )
}

// ---- 4. 高度缺失（0/undefined）的子节点必须补量，否则全叠在一起 ----
{
  gNode.children[2].height = 0
  gNode.children[2].nodeDataSnapshot = JSON.stringify(gNode.children[2].getData())
  api.createGeneralizationNode.call(owner)
  check('高度为 0 的子节点被补量', gNode.children[2].height > 0, 'height=' + gNode.children[2].height)
  check('补量后不重叠', hasOverlap(gNode).overlap === false)
}

// ---- 5. 新增子节点（结构变化）走重建，仍然不重叠 ----
{
  g[0].children.push(treeChild('d', '短'))
  api.createGeneralizationNode.call(owner)
  check('新增后子节点数 4', gNode.children.length === 4)
  check('新增后不重叠', hasOverlap(gNode).overlap === false, JSON.stringify(computeTops(gNode)))
}

// ---- 6. 长文字换行场景：多个都变长 ----
{
  g[0].children[1].data.text = '同样是明显更长的文字需要换行处理'
  g[0].children[3].data.text = '这一段也很长需要换行显示才行'
  api.createGeneralizationNode.call(owner)
  check('多个变长后不重叠', hasOverlap(gNode).overlap === false, JSON.stringify(computeTops(gNode)))
}

// ---- 7. 源码层面的守卫 ----
{
  // 量尺寸与逐层重算已抽到 refreshGeneralizationSubtree 里，并被无条件调用
  // （复用分支和重建分支都需要）。断言按这个结构写，避免随重构漂移。
  const refreshStart = raw.indexOf('function refreshGeneralizationSubtree')
  const refreshEnd = raw.indexOf('\n}\n', refreshStart)
  const refreshBody = refreshStart >= 0 ? raw.slice(refreshStart, refreshEnd) : ''
  check('存在 refreshGeneralizationSubtree', refreshStart > 0)
  check('它内部调用了 getSize', /child\.getSize\(\)/.test(refreshBody))
  check('把缺快照视为脏（必须量）', /const dataDirty =\s*\n?\s*!snapshot/.test(refreshBody))
  check('高度为 0 视为需要补量', /const sizeMissing = !\(child\.height > 0\)/.test(refreshBody))
  check(
    '量完尺寸才计算 childrenAreaHeight',
    refreshBody.indexOf('child.getSize()') < refreshBody.indexOf('childrenAreaHeight =')
  )
  check(
    '无条件的调用（重建分支的新节点高度为 0，也必须补）',
    /refreshGeneralizationSubtree\(cur\.generalizationNode, layout\)/.test(raw)
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
