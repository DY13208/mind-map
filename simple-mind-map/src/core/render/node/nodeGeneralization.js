import MindMapNode from './MindMapNode'
import { createUid } from '../../../utils/index'

// 获取节点概要数据
function formatGetGeneralization() {
  const data = this.getData('generalization')
  return Array.isArray(data) ? data : data ? [data] : []
}

//  检查是否存在概要
function checkHasGeneralization() {
  return this.formatGetGeneralization().length > 0
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

//  创建概要节点
function createGeneralizationNode() {
  if (this.isGeneralization || !this.checkHasGeneralization()) {
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
    if (!item.uid) {
      item.uid = createUid()
    }
    // 线和节点
    if (!cur.generalizationLine) {
      cur.generalizationLine = this.lineDraw.path()
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
    }
    delete item.inserting
    // 关联所属节点
    cur.generalizationNode.generalizationBelongNode = this
    cur.generalizationNode.parent = this
    layout.createGeneralizationChildNodes(cur.generalizationNode)
    // 大小
    if (cur.generalizationNode.width > maxWidth)
      maxWidth = cur.generalizationNode.width
    if (cur.generalizationNode.height > maxHeight)
      maxHeight = cur.generalizationNode.height
    const subtree = layout.measureGeneralizationTree(
      cur.generalizationNode,
      growDir
    )
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
  if (this.isGeneralization) return
  const nextSig = this.formatGetGeneralization()
    .map(item => {
      if (!item || typeof item !== 'object') return String(item || '')
      const range =
        Array.isArray(item.range) && item.range.length >= 2
          ? `${Number(item.range[0])},${Number(item.range[1])}`
          : ''
      return [item.uid || '', String(item.text || ''), range].join(':')
    })
    .join('|')
  if (
    this._generalizationSig === nextSig &&
    ((nextSig && this._generalizationList.length) ||
      (!nextSig && !this._generalizationList.length))
  ) {
    return
  }
  this.removeGeneralization()
  this.createGeneralizationNode()
  this._generalizationSig = this.formatGetGeneralization()
    .map(item => {
      if (!item || typeof item !== 'object') return String(item || '')
      const range =
        Array.isArray(item.range) && item.range.length >= 2
          ? `${Number(item.range[0])},${Number(item.range[1])}`
          : ''
      return [item.uid || '', String(item.text || ''), range].join(':')
    })
    .join('|')
}

//  渲染概要节点
function renderGeneralization(forceRender) {
  if (this.isGeneralization) return
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
  this.renderer.layout.renderGeneralization(this._generalizationList)
  this._generalizationList.forEach(item => {
    this.style.generalizationLine(item.generalizationLine)
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
  if (this.isGeneralization) return
  this._generalizationList.forEach(item => {
    item.generalizationNode.style.onRemove()
    if (item.generalizationLine) {
      item.generalizationLine.remove()
      item.generalizationLine = null
    }
    if (item.generalizationNode) {
      // 删除概要节点时要同步从激活节点里删除
      this.renderer.removeNodeFromActiveList(item.generalizationNode)
      item.generalizationNode.remove()
      item.generalizationNode = null
    }
  })
  this._generalizationList = []
  this._generalizationSig = ''
  // hack修复当激活一个节点时创建概要，然后立即激活创建的概要节点后会重复创建概要节点并且无法删除的问题
  if (this.generalizationBelongNode) {
    this.nodeDraw
      .find('.generalization_' + this.generalizationBelongNode.uid)
      .remove()
  }
}

//  隐藏概要节点
function hideGeneralization() {
  if (this.isGeneralization) return
  this._generalizationList.forEach(item => {
    if (item.generalizationLine) item.generalizationLine.hide()
    if (item.generalizationNode) item.generalizationNode.hide()
  })
}

//  显示概要节点
function showGeneralization() {
  if (this.isGeneralization) return
  this._generalizationList.forEach(item => {
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
