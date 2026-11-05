import MindMapNode from './MindMapNode'
import { createUid } from '../../../utils/index'
import collabGeneralization from '../../../utils/collabGeneralization'

// 获取节点概要数据
function formatGetGeneralization() {
  const data = this.getData('generalization')
  return Array.isArray(data) ? data : data ? [data] : []
}

// 概要子树统一成渲染树结构 { data, children }。
// 画布插入留下的就是该结构；导入/历史数据可能是扁平的 { uid, text, children }，
// walk 只认前者，遇到扁平会取不到 data.data.uid 而中断整树渲染。
// 就地替换数组元素（数组引用不变），data 指回原对象，编辑仍能写回。
function normalizeGeneralizationChildren(list) {
  if (!Array.isArray(list)) return
  for (let i = 0; i < list.length; i++) {
    const child = list[i]
    if (!child || typeof child !== 'object') continue
    if (!(child.data && typeof child.data === 'object')) {
      list[i] = {
        data: child,
        children: Array.isArray(child.children) ? child.children : []
      }
    }
    normalizeGeneralizationChildren(list[i].children)
  }
}

function asGeneralizationList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

// 清掉渲染期的节点实例引用（`_node`）。它指向 MindMapNode、带循环引用，
// 一旦混进 generalization 数据：postMessage 结构化克隆会抛
// OUTBOX_NON_CLONEABLE_PAYLOAD（同步失败），JSON 深拷贝会因循环返回 null
// （后续往 null 写字段直接 TypeError，整次渲染中断 → 画布空白）。
function stripNodeRef(list, depth = 0) {
  if (!Array.isArray(list) || depth > 50) return
  list.forEach(node => {
    if (!node || typeof node !== 'object') return
    delete node._node
    const data = node.data
    if (data && typeof data === 'object') {
      delete data._node
      asGeneralizationList(data.generalization).forEach(nested => {
        if (nested && typeof nested === 'object') {
          delete nested._node
          stripNodeRef(nested.children, depth + 1)
        }
      })
    }
    stripNodeRef(node.children, depth + 1)
  })
}

//  检查是否存在概要
function checkHasGeneralization() {
  return this.formatGetGeneralization().length > 0
}

// 节点是否还有未展开/未挂载的子树（收起时右侧空括号会很丑）
function nodeSubtreeIsCollapsed(node) {
  if (!node) return false
  const live = (node.children && node.children.length) || 0
  const declared = Number(node.getData && node.getData('childCount')) || 0
  const hasKids = live > 0 || declared > 0
  if (!hasKids) return false
  if (node.getData('expand') === false) return true
  // 已标记展开但子节点尚未挂载（懒加载）
  if (live === 0 && declared > 0) return true
  return false
}

// 某条概要是否应展示：范围内有子树的节点都展开后才显示括号
function shouldShowGeneralizationItem(owner, item) {
  if (!owner || owner.getData('expand') === false) return false
  const range = item && Array.isArray(item.range) ? item.range : null
  if (range && range.length >= 2) {
    const start = Number(range[0])
    const end = Number(range[1])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return false
    }
    const children = owner.children || []
    if (!children.length || end >= children.length) return false
    for (let i = start; i <= end; i++) {
      if (nodeSubtreeIsCollapsed(children[i])) return false
    }
    return true
  }
  // 整体概要：所属节点自身子树需可见
  return !nodeSubtreeIsCollapsed(owner)
}

// 是否存在当前应展示的概要（用于占位与布局）
function checkHasVisibleGeneralization() {
  if (!this.checkHasGeneralization() || this.getData('expand') === false) {
    return false
  }
  return this.formatGetGeneralization().some(item =>
    shouldShowGeneralizationItem(this, item)
  )
}

// 当前可见概要占用的最大宽高
function getVisibleGeneralizationSize() {
  const empty = { width: 0, height: 0, subtreeWidth: 0, subtreeHeight: 0 }
  if (!this.checkHasVisibleGeneralization()) return empty
  const list = this.formatGetGeneralization()
  let width = 0
  let height = 0
  let subtreeWidth = 0
  let subtreeHeight = 0
  list.forEach((data, index) => {
    if (!shouldShowGeneralizationItem(this, data)) return
    const cur = this._generalizationList[index]
    if (!cur || !cur.generalizationNode) return
    width = Math.max(width, cur.generalizationNode.width || 0)
    height = Math.max(height, cur.generalizationNode.height || 0)
    subtreeWidth = Math.max(
      subtreeWidth,
      cur.subtreeWidth || cur.generalizationNode.width || 0
    )
    subtreeHeight = Math.max(
      subtreeHeight,
      cur.subtreeHeight || cur.generalizationNode.height || 0
    )
  })
  return { width, height, subtreeWidth, subtreeHeight }
}

//  检查是否存在自身的概要，非子节点区间
function checkHasSelfGeneralization() {
  const list = this.formatGetGeneralization()
  return !!list.find(item => {
    return !item.range || item.range.length <= 0
  })
}

// 获取概要节点所在的概要列表里的索引
function getGeneralizationNodeIndex(node) {
  const genUid = (node.getData && node.getData('uid')) || node.uid
  return this._generalizationList.findIndex(item => {
    const gen = item && item.generalizationNode
    if (!gen) return false
    if (gen === node) return true
    if (gen.uid && (gen.uid === node.uid || gen.uid === genUid)) return true
    const dataUid = gen.getData && gen.getData('uid')
    return !!(dataUid && (dataUid === genUid || dataUid === node.uid))
  })
}

// 概要子树的结构签名：uid + 展开态 + 嵌套形状。
// 只要结构没变（只是改文字），就不该把整棵子树拆掉重建 —— 拆建会替换掉
// 正在编辑的节点实例/编辑框，导致输入内容丢失（表现为节点变空）。
function generalizationStructureSignature(item) {
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 50) return ''
    return list
      .map(node => {
        const uid = (node && node.data && node.data.uid) || ''
        const expand = node && node.data && node.data.expand === false ? '0' : '1'
        return uid + ':' + expand + '(' + walk(node && node.children, depth + 1) + ')'
      })
      .join(',')
  }
  const range = Array.isArray(item && item.range) ? item.range.join('-') : ''
  return (item && item.uid) + '|' + range + '|' + walk(item && item.children, 0)
}

//  创建概要节点
// 概要节点自身也可以拥有概要（概要下的子节点再加概要），所以这里不再排除
// isGeneralization。递归由数据决定，不存在无限展开。
function createGeneralizationNode() {
  if (!this.checkHasGeneralization()) {
    return
  }
  let maxWidth = 0
  let maxHeight = 0
  let maxSubtreeWidth = 0
  let maxSubtreeHeight = 0
  const list = this.formatGetGeneralization()
  const layout = this.renderer.layout
  const growDir = layout.getGeneralizationChildGrowDir
    ? layout.getGeneralizationChildGrowDir()
    : 'h'
  list.forEach((item, index) => {
    let cur = this._generalizationList[index]
    if (!cur) {
      cur = this._generalizationList[index] = {}
    }
    // 所属节点
    cur.node = this
    // 区间范围
    cur.range = item.range
    if (!Array.isArray(item.children)) {
      item.children = []
    }
    // 概要子树的数据有两种来源：画布插入留下的是渲染树结构
    // { data, children }，而导入/历史数据可能是扁平 { uid, text, children }。
    // walk 只认前者，遇到扁平会取不到 data.data.uid 而中断整树渲染。
    // 这里就地补一层包装（data 指回原对象，编辑仍能写回），数组引用不变。
    normalizeGeneralizationChildren(item.children)
    if (!item.uid) {
      item.uid = createUid()
    }
    // 线和节点
    if (!cur.generalizationLine) {
      cur.generalizationLine = this.lineDraw.path()
    } else if (
      cur.generalizationLine.node && this.lineDraw.node &&
      cur.generalizationLine.node.parentNode !== this.lineDraw.node
    ) {
      this.lineDraw.add(cur.generalizationLine)
    }
    // 给连线打上所属节点类名：删除概要时如果引用丢了（复用/重建过程中
    // item 被替换），还能按类名把残留的括号线清干净。
    const lineOwnerUid = (this.getData && this.getData('uid')) || this.uid
    if (lineOwnerUid && cur.generalizationLine && cur.generalizationLine.addClass) {
      cur.generalizationLine.addClass('generalization-line_' + lineOwnerUid)
    }
    if (!cur.generalizationNode) {
      cur.generalizationNode = new MindMapNode({
        data: {
          inserting: item.inserting,
          data: item,
          children: item.children
        },
        uid: item.uid || createUid(),
        renderer: this.renderer,
        mindMap: this.mindMap,
        isGeneralization: true,
        layerIndex: this.layerIndex + 1
      })
    } else {
      cur.generalizationNode.nodeData =
        cur.generalizationNode.handleData({
          inserting: item.inserting,
          data: item,
          children: item.children
        })
      cur.generalizationNode.layerIndex = this.layerIndex + 1
      // 复用实例时同步它自己的概要，否则下面测量子树尺寸时拿到的是上一轮的
      // 嵌套概要大小，主树预留空间会不够。
      cur.generalizationNode.updateGeneralization()
    }
    delete item.inserting
    // 关联所属节点
    cur.generalizationNode.generalizationBelongNode = this
    cur.generalizationNode.parent = this
    // 结构没变就别拆建：实时渲染会在每次输入后整树重排，如果这里每次都
    // child.remove() + 重建，正在编辑的节点会被拆掉，输入内容随之丢失。
    const structureSig = generalizationStructureSignature(item)
    const kids = cur.generalizationNode.children
    const reusable =
      !!cur.structureSig &&
      cur.structureSig === structureSig &&
      cur.childrenRef === item.children &&
      Array.isArray(kids) &&
      kids.length === item.children.length &&
      kids.every(child => child && child.group)
    if (reusable) {
      // 复用实例就不会再走 createNode，而 createNode 才是负责 getSize 的地方。
      // 不补这一步，文字变长/换行的节点仍按旧宽高参与排版，后一个兄弟就被放到
      // 前一个身上 —— 表现就是概要后面的子节点重叠。这里对数据变过的子节点
      // 重新量一次尺寸（判定方式与 Base.checkIsNodeDataChange 一致，忽略
      // isActive/expand，避免选中态变化引起无谓重算）。
      kids.forEach(child => {
        if (!child || typeof child.getSize !== 'function') return
        const snapshot = child.nodeDataSnapshot
        // 没有快照说明这个实例还没量过尺寸，必须量；有快照则按数据是否变过判断。
        const dataDirty =
          !snapshot ||
          typeof layout.checkIsNodeDataChange !== 'function' ||
          layout.checkIsNodeDataChange(
            snapshot,
            child.nodeData && child.nodeData.data
          )
        // 高度缺失/为 0 的节点如果直接参与排版，会所有兄弟叠在同一行。
        const sizeMissing = !(child.height > 0)
        if (!dataDirty && !sizeMissing) return
        child.getSize()
        child.needLayout = true
        // 子节点自己也可能挂着嵌套概要，尺寸变了要一起刷新
        if (typeof child.updateGeneralization === 'function') {
          child.updateGeneralization()
        }
      })
      const len = kids.length
      cur.generalizationNode.childrenAreaHeight = len
        ? kids.reduce((h, item2) => h + item2.height, 0) +
          (len + 1) * layout.getMarginY(cur.generalizationNode.layerIndex + 1)
        : 0
    } else {
      layout.createGeneralizationChildNodes(cur.generalizationNode)
      cur.structureSig = structureSig
      cur.childrenRef = item.children
    }
    // 渲染期节点引用必须清掉：createGeneralizationChildNodes 末尾本来就做这件事，
    // 复用分支跳过了它，_node 就可能漏进 generalization 数据 → 结构化克隆失败
    // （同步失败）+ JSON 深拷贝返回 null（渲染中断、画布空白）。这里统一兜一遍。
    stripNodeRef(item.children)
    delete item._node
    if (this.renderer.registerNodeIndex) {
      this.renderer.registerNodeIndex(cur.generalizationNode)
    }
    // 大小
    if (cur.generalizationNode.width > maxWidth)
      maxWidth = cur.generalizationNode.width
    if (cur.generalizationNode.height > maxHeight)
      maxHeight = cur.generalizationNode.height
    const subtree = layout.measureGeneralizationTree(
      cur.generalizationNode,
      growDir
    )
    cur.subtreeWidth = subtree.width
    cur.subtreeHeight = subtree.height
    if (subtree.width > maxSubtreeWidth) maxSubtreeWidth = subtree.width
    if (subtree.height > maxSubtreeHeight) maxSubtreeHeight = subtree.height
    // 如果该概要为激活状态，那么加入激活节点列表
    if (item.isActive) {
      this.renderer.addNodeToActiveList(cur.generalizationNode)
    }
  })
  this._generalizationNodeWidth = maxWidth
  this._generalizationNodeHeight = maxHeight
  this._generalizationSubtreeWidth = maxSubtreeWidth || maxWidth
  this._generalizationSubtreeHeight = maxSubtreeHeight || maxHeight
}

//  更新概要节点
function updateGeneralization() {
  const nextSig = collabGeneralization.generalizationSignature(
    this.getData('generalization')
  )
  if (
    this._generalizationSig === nextSig &&
    ((nextSig && this._generalizationList.length) ||
      (!nextSig && !this._generalizationList.length))
  ) {
    return
  }
  this.removeGeneralization()
  this.createGeneralizationNode()
  this._generalizationSig = nextSig
}

//  渲染概要节点
function renderGeneralization(forceRender) {
  this.updateGeneralizationData()
  const list = this.formatGetGeneralization()
  if (list.length <= 0 || this.getData('expand') === false) {
    this.removeGeneralization()
    return
  }
  if (list.length !== this._generalizationList.length) {
    this.removeGeneralization()
  }
  this.createGeneralizationNode()
  const visible = []
  this._generalizationList.forEach((item, index) => {
    const data = list[index] || item
    if (shouldShowGeneralizationItem(this, data)) {
      visible.push(item)
      if (item.generalizationLine) item.generalizationLine.show()
      if (item.generalizationNode) item.generalizationNode.show()
    } else {
      if (item.generalizationLine) item.generalizationLine.hide()
      if (item.generalizationNode) item.generalizationNode.hide()
    }
  })
  this.renderer.layout.renderGeneralization(visible)
  visible.forEach(item => {
    this.style.generalizationLine(item.generalizationLine)
    if (item.generalizationLine && item.generalizationLine.attr) {
      item.generalizationLine.attr('pointer-events', 'none')
    }
    item.generalizationNode.render(() => {}, forceRender)
  })
}

// 更新节点概要数据
function updateGeneralizationData() {
  const live = this.children ? this.children.length : 0
  const childCount = Number(this.getData('childCount')) || 0
  // Lazy-loaded trees may only mount part of the children while childCount
  // reflects the server total; dropping range summaries here turns them into
  // whole-node summaries with a huge bracket on the next render.
  const childrenLength = Math.max(live, childCount)
  const list = this.formatGetGeneralization()
  const newList = []
  list.forEach(item => {
    const range = Array.isArray(item.range)
      ? item.range
      : item.range == null
        ? null
        : [Number(item.range[0]), Number(item.range[1])]
    if (!range || !range.length) {
      newList.push(item)
      return
    }
    const start = Number(range[0])
    const end = Number(range[1])
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end >= start &&
      end <= childrenLength - 1
    ) {
      newList.push({
        ...item,
        range: [start, end]
      })
      return
    }
    const fullyLoaded = childCount > 0 && live >= childCount
    if (!fullyLoaded) {
      newList.push(item)
    }
  })
  if (newList.length !== list.length) {
    this.setData({
      generalization: newList.length ? newList : null
    })
  }
}

//  删除概要节点
function removeGeneralization() {
  this._generalizationList.forEach(item => {
    if (item.generalizationNode) item.generalizationNode.style.onRemove()
    if (item.generalizationLine) {
      item.generalizationLine.remove()
      item.generalizationLine = null
    }
    if (item.generalizationNode) {
      const genNode = item.generalizationNode
      if (this.renderer.unregisterNodeIndex) {
        this.renderer.unregisterNodeIndex(genNode)
      }
      // 删除概要节点时要同步从激活节点里删除
      this.renderer.removeNodeFromActiveList(genNode)
      genNode.remove()
      // 实例已经离开画布，缓存里再留着它，下次渲染一旦命中 lru 就会把
      // 已经 remove 的 group 重新挂回 nodeDraw，表现为「概要删了框还在」。
      const genUid = genNode.uid
      if (genUid) {
        const renderer = this.renderer || {}
        if (renderer.nodeCache) delete renderer.nodeCache[genUid]
        if (renderer.lastNodeCache) delete renderer.lastNodeCache[genUid]
        if (this.renderer && this.renderer.layout && this.renderer.layout.lru) {
          const lru = this.renderer.layout.lru
          if (typeof lru.delete === 'function') lru.delete(genUid)
        }
      }
      item.generalizationNode = null
    }
  })
  this._generalizationList = []
  this._generalizationSig = ''
  // 按类名兜底清理画布残留。
  // 上面只按 _generalizationList 里的引用去删；一旦某个条目的引用丢了
  // （重建/复用过程中 item 被替换、group 提前被移出又挂回），就会在画布上
  // 留下一个空的概要框或括号线，看起来像「删了概要但边框还在」。
  // 概要节点的 group 带 generalization_<ownerUid>，连线带
  // generalization-line_<ownerUid>，这里按 owner 的 uid 一次性清理。
  // 只对所属节点（owner）执行：概要节点自身也带同名类名，对它执行会把
  // 自己（以及需要保留的兄弟概要）误删。
  if (!this.isGeneralization) {
    const ownerUid = (this.getData && this.getData('uid')) || this.uid
    if (ownerUid) {
      if (this.nodeDraw && this.nodeDraw.find) {
        this.nodeDraw.find('.generalization_' + ownerUid).remove()
      }
      if (this.lineDraw && this.lineDraw.find) {
        this.lineDraw.find('.generalization-line_' + ownerUid).remove()
      }
    }
  }
}

//  隐藏概要节点
function hideGeneralization() {
  this._generalizationList.forEach(item => {
    if (item.generalizationLine) item.generalizationLine.hide()
    if (item.generalizationNode) item.generalizationNode.hide()
  })
}

//  显示概要节点
function showGeneralization() {
  const list = this.formatGetGeneralization()
  this._generalizationList.forEach((item, index) => {
    const data = list[index] || item
    if (!shouldShowGeneralizationItem(this, data)) {
      if (item.generalizationLine) item.generalizationLine.hide()
      if (item.generalizationNode) item.generalizationNode.hide()
      return
    }
    if (item.generalizationLine) item.generalizationLine.show()
    if (item.generalizationNode) item.generalizationNode.show()
  })
}

// 设置概要节点的透明度
function setGeneralizationOpacity(val) {
  this._generalizationList.forEach(item => {
    item.generalizationLine.opacity(val)
    item.generalizationNode.group.opacity(val)
  })
}

// 处理概要节点鼠标移入事件
function handleGeneralizationMouseenter() {
  const belongNode = this.generalizationBelongNode
  const list = belongNode.formatGetGeneralization()
  const index = belongNode.getGeneralizationNodeIndex(this)
  const generalizationData = list[index]
  // 如果主题中设置了hoverRectColor颜色，那么使用该颜色
  // 否则使用hoverRectColor实例化选项的颜色
  // 兜底使用highlightNode方法的默认颜色
  const hoverRectColor = this.getStyle('hoverRectColor')
  const color = hoverRectColor || this.mindMap.opt.hoverRectColor
  const style = color
    ? {
        stroke: color
      }
    : null
  // 区间概要，框子节点
  if (
    Array.isArray(generalizationData.range) &&
    generalizationData.range.length > 0
  ) {
    this.mindMap.renderer.highlightNode(
      belongNode,
      generalizationData.range,
      style
    )
  } else {
    // 否则框自己
    this.mindMap.renderer.highlightNode(belongNode, null, style)
  }
}

// 处理概要节点鼠标移出事件
function handleGeneralizationMouseleave() {
  this.mindMap.renderer.closeHighlightNode()
}

export default {
  formatGetGeneralization,
  checkHasGeneralization,
  checkHasVisibleGeneralization,
  getVisibleGeneralizationSize,
  checkHasSelfGeneralization,
  getGeneralizationNodeIndex,
  createGeneralizationNode,
  updateGeneralization,
  updateGeneralizationData,
  renderGeneralization,
  removeGeneralization,
  hideGeneralization,
  showGeneralization,
  setGeneralizationOpacity,
  handleGeneralizationMouseenter,
  handleGeneralizationMouseleave
}
