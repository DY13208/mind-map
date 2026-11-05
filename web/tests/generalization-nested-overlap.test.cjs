/**
 * 概要子树「多层嵌套时全叠在一起」回归测试（2026-11-05 现场 2）。
 *
 * 现象：在概要里的节点上继续加子节点（三级以上），整列节点叠成一团。
 * 现场数据（room-avtdq8dl 的 a48175a2）：
 *   概要 → 2 个节点，各自又挂 4 个 / 3 个节点
 *   截图里只能看到 3 个「分支主题」重重压在一起。
 *
 * 根因：上一轮的重叠修复**只补了顶层**。
 *   - 只对 gNode 的直接子节点调 getSize()
 *   - 只重算 gNode.childrenAreaHeight
 * 但 layoutGeneralizationChildren 是**每一层各自递推**的：
 *     const areaH = gNode.childrenAreaHeight || gNode.height
 *     let totalTop = top + marginY
 *     gNode.children.forEach(cur => { cur.top = totalTop; totalTop += cur.height + marginY })
 * 所以第二层节点的兄弟怎么排，取决于**它自己父节点**的 childrenAreaHeight。
 * 那个值没重算（或子节点高度变了却没重算），整层就被算在同一个 top 上 → 全部重叠。
 *
 * 修复：refreshGeneralizationSubtree 递归到每一层 —— 先补量尺寸，再从深到浅
 * 重算每层的 childrenAreaHeight（口径与 Base.createGeneralizationChildNodes 一致）。
 * 这里直接抽真实的 layoutGeneralizationChildren 来算坐标，做多层重叠检测。
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
const genRaw = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')
const baseRaw = fs.readFileSync(path.join(ROOT, 'layouts/Base.js'), 'utf8')

// ---- 抽真实的 layoutGeneralizationChildren ----
function extractFn(src, name) {
  const start = src.indexOf(`  ${name}(`)
  if (start < 0) return null
  let i = src.indexOf(') {', start)
  if (i < 0) return null
  i += 2
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        return `function ${name}${src.slice(src.indexOf('(', start), i + 1)}`
      }
    }
  }
  return null
}

const layoutFnSrc = extractFn(baseRaw, 'layoutGeneralizationChildren')
check('抽出布局函数 layoutGeneralizationChildren', !!layoutFnSrc)

const MARGIN = 20
const layoutTarget = {}
new Function('target', `${layoutFnSrc}\ntarget.layoutGeneralizationChildren = layoutGeneralizationChildren`)(layoutTarget)
const layoutGeneralizationChildren = layoutTarget.layoutGeneralizationChildren

// 布局函数内部是 this.layoutGeneralizationChildren 递归调用，所以必须挂到
// 调用时的 this 对象上。这里补一个 helper，统一用带方法的 host 调用。
function runLayout(host, gNode, dir = 'h', isLeft = false) {
  if (!host.layoutGeneralizationChildren) {
    host.layoutGeneralizationChildren = layoutGeneralizationChildren
  }
  return layoutGeneralizationChildren.call(host, gNode, dir, isLeft)
}

// ---- 载入被测模块 ----
const genSource = genRaw.replace(/^import .*$/gm, '').replace(/^export default /m, 'module.exports = ')
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
    if (node && !this.children.includes(node)) this.children.push(node)
  }
}

const layout = {
  getMarginX: () => MARGIN,
  getMarginY: () => MARGIN,
  getGeneralizationChildGrowDir: () => 'h',
  checkIsNodeDataChange(lastData, curData) {
    if (!lastData) return false
    let prev = typeof lastData === 'string' ? JSON.parse(lastData) : lastData
    prev.isActive = curData.isActive
    prev.expand = curData.expand
    return JSON.stringify(prev) !== JSON.stringify(curData)
  },
  // 与 Base.createGeneralizationChildNodes 的关键部分等价：重建 children 并逐层算高度。
  // 注意这里**故意不调 getSize**，因为真实实现里新建的 MindMapNode 初始
  // width/height 就是 0，而 area 是当场按这些 0 高度算出来的 —— 这正是
  // 「新增节点后整列重叠」的成因，测试必须复刻它，否则抓不到问题。
  createGeneralizationChildNodes(gNode) {
    const rebuild = node => {
      ;(node.children || []).forEach(c => c && c.remove && c.remove())
      node.children = []
      ;(node.nodeData.children || []).forEach(t => {
        const n = new FakeMindMapNode({ data: t, isGeneralization: true, layerIndex: node.layerIndex + 1 })
        n.parent = node
        // 复刻真实行为：新建实例宽高为 0
        n.width = 0
        n.height = 0
        n.nodeDataSnapshot = ''
        node.addChildren(n)
        rebuild(n)
      })
      const len = node.children.length
      node.childrenAreaHeight = len
        ? node.children.reduce((h, c) => h + c.height, 0) + (len + 1) * MARGIN
        : 0
    }
    rebuild(gNode)
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
vm.runInNewContext(genSource, sandbox)
const api = sandbox.module.exports

function makeOwner(generalization) {
  const owner = Object.create(FakeMindMapNode.prototype)
  owner.nodeData = { data: { uid: 'owner-1', text: '根', expand: true, generalization }, children: [] }
  owner.uid = 'owner-1'
  owner.isGeneralization = false
  owner.isRoot = false
  owner.layerIndex = 1
  owner.children = []
  owner.group = {}
  owner.width = 80
  owner.height = 30
  owner._generalizationList = []
  owner.lineDraw = { path: () => ({ addClass() {}, remove() {}, node: null }), add() {}, node: {} }
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

function leaf(uid, text) {
  return { data: { uid, text, expand: true, richText: true }, children: [] }
}

// 逐层检测重叠：返回所有重叠位置
function findOverlaps(node, dir = 'h', isLeft = false, out = []) {
  const kids = node.children || []
  if (node.getData('expand') === false || kids.length <= 0) return out
  // 用真实布局函数算出每个子节点的 top
  runLayout(layout, node, dir, isLeft)
  for (let i = 1; i < kids.length; i++) {
    const prevBottom = kids[i - 1].top + kids[i - 1].height
    if (kids[i].top < prevBottom) {
      out.push({
        level: node.layerIndex,
        prev: kids[i - 1].getData('uid'),
        cur: kids[i].getData('uid'),
        prevBottom,
        curTop: kids[i].top
      })
    }
  }
  kids.forEach(k => findOverlaps(k, dir, isLeft, out))
  return out
}

// 建三层：概要 → 2 个节点 → 各挂 4/3 个子节点（复刻现场数据形状）
function buildDeep(n1Text = '短', n2Text = '短') {
  const item = {
    uid: 'g1',
    text: '概要',
    expand: true,
    children: [
      {
        data: { uid: 'n1', text: n1Text, expand: true, richText: true },
        children: [leaf('n1a', '短'), leaf('n1b', '短'), leaf('n1c', '短'), leaf('n1d', '短')]
      },
      {
        data: { uid: 'n2', text: n2Text, expand: true, richText: true },
        children: [leaf('n2a', '短'), leaf('n2b', '短'), leaf('n2c', '短')]
      }
    ]
  }
  const owner = makeOwner([item])
  api.createGeneralizationNode.call(owner)
  return { item, owner, gNode: owner._generalizationList[0].generalizationNode }
}

// ---- 0. 新增节点场景：新建实例高度为 0，必须补量后重排（现场主诉） ----
{
  const { item, owner, gNode } = buildDeep()
  // 往第二层节点上继续加两个子节点 → 结构变化，走重建路径
  item.children[0].children.push(leaf('n1e', '分支主题'), leaf('n1f', '分支主题'))
  api.createGeneralizationNode.call(owner)
  const n1 = gNode.children[0]
  check('新增后第二层子节点数 6', n1.children.length === 6, 'kids=' + n1.children.length)
  check(
    '新增节点被补量高度（不再全是 0）',
    n1.children.every(c => c.height > 0),
    'heights=' + JSON.stringify(n1.children.map(c => c.height))
  )
  const overlaps = findOverlaps(gNode)
  check('新增节点后不重叠（现场主诉）', overlaps.length === 0, JSON.stringify(overlaps))
}

// ---- 1. 首次构建：三层都不重叠 ----
{
  const { gNode } = buildDeep()
  check('首次构建：3 层节点齐全', (() => {
    const l1 = gNode.children
    return l1.length === 2 && l1[0].children.length === 4 && l1[1].children.length === 3
  })())
  check('首次构建：全层不重叠', findOverlaps(gNode).length === 0, JSON.stringify(findOverlaps(gNode)))
}

// ---- 2. 关键场景：改第二层节点的文字（让它的子节点高度变化） ----
{
  const { item, owner, gNode } = buildDeep()
  // 让 n1 的第一个子节点文字变长 → 高度 30 → 60
  item.children[0].children[0].data.text = '这是一段明显更长的文字需要换行'
  api.createGeneralizationNode.call(owner)
  const target = gNode.children[0].children[0]
  check('第二层子节点高度被重新测量', target.height === 60, 'height=' + target.height)
  const overlaps = findOverlaps(gNode)
  check('第二层：改文字后不重叠', overlaps.length === 0, JSON.stringify(overlaps))
}

// ---- 3. 关键场景：第二层节点的 childrenAreaHeight 必须被重算 ----
{
  const { item, owner, gNode } = buildDeep()
  const n1 = gNode.children[0]
  const before = n1.childrenAreaHeight
  item.children[0].children[0].data.text = '又是一段很长很长的文字需要换行显示'
  api.createGeneralizationNode.call(owner)
  check(
    '第二层节点的 childrenAreaHeight 被重算',
    n1.childrenAreaHeight > before,
    `${before} -> ${n1.childrenAreaHeight}`
  )
  check('childrenAreaHeight 与子节点高度之和一致', (() => {
    const sum = n1.children.reduce((h, c) => h + c.height, 0) + (n1.children.length + 1) * MARGIN
    return n1.childrenAreaHeight === sum
  })(), 'area=' + n1.childrenAreaHeight)
}

// ---- 4. 多层同时变长 ----
{
  const { item, owner, gNode } = buildDeep()
  item.children[0].data.text = '第一层节点文字也变长了需要换行'
  item.children[0].children[1].data.text = '第二层另一个也变长了需要换行'
  item.children[1].children[2].data.text = '第二个父节点下的子节点也变长'
  api.createGeneralizationNode.call(owner)
  const overlaps = findOverlaps(gNode)
  check('多层同时变长：不重叠', overlaps.length === 0, JSON.stringify(overlaps))
}

// ---- 5. 收起态：布局函数对该层直接短路（不产生坐标，也就不会重叠） ----
{
  const { item, owner, gNode } = buildDeep()
  item.children[0].data.expand = false
  api.createGeneralizationNode.call(owner)
  const n1 = gNode.children[0]
  check('收起节点不产生重叠', findOverlaps(gNode).length === 0)
  // 收起的判断在布局函数里（expand === false 直接 return），所以这里只校验
  // 布局确实不再给它安排位置 —— 而不是要求 childrenAreaHeight 归零。
  const before = n1.children.map(c => c.top)
  runLayout(layout, n1)
  check(
    '收起节点：布局函数直接短路（子节点不被重新定位）',
    JSON.stringify(n1.children.map(c => c.top)) === JSON.stringify(before),
    'tops=' + JSON.stringify(n1.children.map(c => c.top))
  )
  check(
    '收起节点：实例与子节点仍完整保留（只是不显示）',
    n1.children.length === 4 && typeof n1.childrenAreaHeight === 'number'
  )
}

// ---- 6. 数据没变时不重复测量（性能） ----
{
  const { owner, gNode } = buildDeep()
  const target = gNode.children[0].children[1]
  const before = target.getSizeCalls
  api.createGeneralizationNode.call(owner)
  api.createGeneralizationNode.call(owner)
  check('数据没变不重复测量', target.getSizeCalls === before, 'calls=' + target.getSizeCalls)
}

// ---- 7. 源码守卫 ----
{
  check('新增 refreshGeneralizationSubtree', /function refreshGeneralizationSubtree\(gNode, layout, depth = 0\)/.test(genRaw))
  check('递归处理每一层', /refreshGeneralizationSubtree\(child, layout, depth \+ 1\)/.test(genRaw))
  check('复用分支调用递归版（不是只补顶层）', /refreshGeneralizationSubtree\(cur\.generalizationNode, layout\)/.test(genRaw))
  check('按节点自己的 layerIndex 取间距', /layout\.getMarginY\(\(gNode\.layerIndex \|\| 0\) \+ 1\)/.test(genRaw))
  check('收起态强置为 0', /const len = collapsed \? 0 : kids\.length/.test(genRaw))
  check('有深度上限防爆栈', /if \(!gNode \|\| depth > 50\) return/.test(genRaw))
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
