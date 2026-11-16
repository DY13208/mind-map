/**
 * 概要后面粘贴节点后，旁边的分支要等刷新才让位。
 *
 * 粘贴只把新节点推进概要的 children。所属节点实例会被复用，构造函数里的
 * updateGeneralization 不会再跑。主树在 computedBaseValue 里用
 * getVisibleGeneralizationSize() 给兄弟让位；若这一步读到的仍是上一轮子树高度，
 * 概要分支变高后就会压住旁边的分支。绘制阶段才重测已经晚了。
 * 整页刷新会新建节点，构造时就量过，所以刷新后位置是对的。
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
const baseRaw = fs.readFileSync(path.join(ROOT, 'layouts/Base.js'), 'utf8')
const genRaw = fs.readFileSync(
  path.join(ROOT, 'core/render/node/nodeGeneralization.js'),
  'utf8'
)

function extractMethod(src, name) {
  const start = src.indexOf(`  ${name}(`)
  if (start < 0) return null
  let i = src.indexOf('{', start)
  if (i < 0) return null
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

const createStart = baseRaw.indexOf('  createNode(')
const createEnd = baseRaw.indexOf('  // 检查概要节点是否需要更新')
const createBody = baseRaw.slice(createStart, createEnd)
const refreshCalls = createBody.match(
  /this\.refreshGeneralizationBeforeLayout\(newNode\)/g
)
check(
  '两条复用路径都会在布局读尺寸前重测概要',
  refreshCalls && refreshCalls.length === 2,
  'calls=' + (refreshCalls ? refreshCalls.length : 0)
)
check(
  '重测发生在 checkGetGeneralizationChange 之后',
  createBody.indexOf('checkGetGeneralizationChange') <
    createBody.indexOf('refreshGeneralizationBeforeLayout')
)
const refreshSrc = extractMethod(baseRaw, 'refreshGeneralizationBeforeLayout')
check('抽出 refreshGeneralizationBeforeLayout', !!refreshSrc)
check(
  '重测调用 createGeneralizationNode',
  refreshSrc && refreshSrc.includes('node.createGeneralizationNode()')
)
check(
  '重入时直接返回，避免概要子树重建再走进来',
  refreshSrc && refreshSrc.includes('node._measuringGeneralization')
)
check(
  '布局测量不摘掉还在的节点',
  refreshSrc && refreshSrc.includes('_generalizationMeasureOnly = true')
)
check(
  '测量模式按 uid 保留节点',
  /if \(measureOnly\) \{[\s\S]*keepUids\.has\(uid\)\) return/.test(baseRaw)
)
const nodeRaw = fs.readFileSync(
  path.join(ROOT, 'core/render/node/MindMapNode.js'),
  'utf8'
)
const removeStart = nodeRaw.indexOf('  remove() {')
const removeBody = nodeRaw.slice(removeStart, nodeRaw.indexOf('  destroy() {'))
check(
  '没有 group 也先清连线',
  removeBody.indexOf('this.removeLine()') < removeBody.indexOf('this.group')
)

const measureSrc = extractMethod(baseRaw, 'measureGeneralizationTree')
const subtreeHSrc = extractMethod(baseRaw, 'generalizationSubtreeHeight')
const extentSrc = extractMethod(baseRaw, 'getNestedGeneralizationExtent')
check('抽出 measureGeneralizationTree', !!measureSrc)

const MARGIN_X = 30
const MARGIN_Y = 20
const measureHost = {
  getMarginX: () => MARGIN_X,
  getMarginY: () => MARGIN_Y
}
new Function(
  'host',
  `${extentSrc}
   ${measureSrc}
   ${subtreeHSrc}
   host.measureGeneralizationTree = measureGeneralizationTree
   host.generalizationSubtreeHeight = generalizationSubtreeHeight
   host.getNestedGeneralizationExtent = getNestedGeneralizationExtent`
)(measureHost)

const source = genRaw
  .replace(/^import .*$/gm, '')
  .replace(/^export default /m, 'module.exports = ')

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
    this.height = heightForText(
      this.nodeData && this.nodeData.data && this.nodeData.data.text
    )
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
  removeGeneralization() {
    this._generalizationList = []
  }
  updateGeneralization() {}
  addChildren(node) {
    if (!node) return
    if (!this.children.includes(node)) this.children.push(node)
  }
}

const layout = {
  getGeneralizationChildGrowDir: () => 'h',
  getMarginX: () => MARGIN_X,
  getMarginY: () => MARGIN_Y,
  measureGeneralizationTree(node, dir) {
    return measureHost.measureGeneralizationTree(node, dir)
  },
  generalizationSubtreeHeight(node, dir) {
    return measureHost.generalizationSubtreeHeight(node, dir)
  },
  checkIsNodeDataChange(lastData, curData) {
    if (!lastData) return false
    const prev = typeof lastData === 'string' ? JSON.parse(lastData) : lastData
    prev.isActive = curData.isActive
    prev.expand = curData.expand
    return JSON.stringify(prev) !== JSON.stringify(curData)
  },
  createGeneralizationChildNodes(gNode) {
    ;(gNode.children || []).forEach(child => child && child.remove && child.remove())
    gNode.children = []
    ;(gNode.nodeData.children || []).forEach(childTree => {
      const node = new FakeMindMapNode({
        data: childTree,
        isGeneralization: true,
        layerIndex: gNode.layerIndex + 1
      })
      node.parent = gNode
      gNode.addChildren(node)
    })
  }
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
  owner.nodeData = {
    data: {
      uid: 'owner-1',
      text: '人物',
      expand: true,
      generalization
    },
    children: []
  }
  owner.uid = 'owner-1'
  owner.isGeneralization = false
  owner.layerIndex = 1
  owner.children = []
  owner.group = {}
  owner.height = 36
  owner.width = 80
  owner._generalizationList = []
  owner._measuringGeneralization = false
  owner.lineDraw = {
    path: () => ({ addClass() {}, remove() {}, node: null }),
    add() {},
    node: {}
  }
  owner.nodeDraw = { find: () => ({ remove() {} }) }
  owner.renderer = {
    layout,
    registerNodeIndex() {},
    addNodeToActiveList() {},
    removeNodeFromActiveList() {}
  }
  owner.createGeneralizationNode = function () {
    return api.createGeneralizationNode.call(this)
  }
  return owner
}

function treeChild(uid) {
  return { data: { uid, text: '分支主题', expand: true }, children: [] }
}

// 与 LogicalStructure.computedBaseValue / adjustTopValue 同一口径
function siblingShift(subtreeHeight, childrenAreaHeight, nodeHeight) {
  const generalizationNodeHeight = subtreeHeight + MARGIN_Y
  const childrenAreaHeight2 = Math.max(childrenAreaHeight, generalizationNodeHeight)
  return Math.max(0, childrenAreaHeight2 - MARGIN_Y * 2 - nodeHeight) / 2
}

const generalization = [
  {
    uid: 'summary',
    text: '人物概要',
    expand: true,
    children: [treeChild('a')]
  }
]
const owner = makeOwner(generalization)
api.createGeneralizationNode.call(owner)
const before = owner._generalizationList[0].subtreeHeight
const childrenAreaHeight = 180
const shiftBefore = siblingShift(before, childrenAreaHeight, owner.height)
check('粘贴前概要子树已有高度', before > 0, 'h=' + before)

// 复制粘贴：只改数据，不重测。这就是刷新前画面上的状态。
for (let i = 0; i < 6; i++) generalization[0].children.push(treeChild('p' + i))
const stale = owner._generalizationList[0].subtreeHeight
check('未重测时子树高度仍是粘贴前的值', stale === before, 'h=' + stale)
const shiftStale = siblingShift(stale, childrenAreaHeight, owner.height)
check(
  '未重测时旁边分支让出的空间不变',
  shiftStale === shiftBefore,
  'shift=' + shiftStale
)

// 布局复用节点时现在会走这一步，绘制之前就把新高度交给 childrenAreaHeight2。
owner.createGeneralizationNode()
const fresh = owner._generalizationList[0].subtreeHeight
check('重测后概要子树变高', fresh > before, 'h=' + fresh)
check(
  '重测后的高度已经超过所属节点原有的子节点区',
  fresh + MARGIN_Y > childrenAreaHeight,
  'fresh=' + fresh
)
const shiftFresh = siblingShift(fresh, childrenAreaHeight, owner.height)
check(
  '旁边分支让出的空间变大',
  shiftFresh > shiftStale,
  shiftStale + ' -> ' + shiftFresh
)

// 布局入口本身会调用这次重测，而不是只在绘制阶段调用
{
  const layoutOwner = makeOwner([
    {
      uid: 'summary-2',
      text: '人物概要',
      expand: true,
      children: [treeChild('b')]
    }
  ])
  api.createGeneralizationNode.call(layoutOwner)
  const cached = layoutOwner._generalizationList[0].subtreeHeight
  for (let i = 0; i < 6; i++) {
    layoutOwner.nodeData.data.generalization[0].children.push(treeChild('q' + i))
  }
  const base = { refreshGeneralizationBeforeLayout: null }
  new Function(
    'base',
    `${refreshSrc}
     base.refreshGeneralizationBeforeLayout = refreshGeneralizationBeforeLayout`
  )(base)
  base.refreshGeneralizationBeforeLayout(layoutOwner)
  const laidOut = layoutOwner._generalizationList[0].subtreeHeight
  check('布局入口重测会抬高子树', laidOut > cached, cached + ' -> ' + laidOut)
  check(
    '重测结束后解除重入标记',
    layoutOwner._measuringGeneralization === false
  )
}

const failed = results.filter(item => !item.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
