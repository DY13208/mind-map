import { bfsWalk, throttle, checkTwoRectIsOverlap } from '../utils'
import AutoMove from '../utils/AutoMove'

// 节点选择插件
class Select {
  //  构造函数
  constructor({ mindMap }) {
    this.mindMap = mindMap
    this.rect = null
    this.isMousedown = false
    this.mouseDownX = 0
    this.mouseDownY = 0
    this.mouseMoveX = 0
    this.mouseMoveY = 0
    this.isSelecting = false
    this.cacheActiveList = []
    this.lastMultiSelectList = []
    this.lastMultiSelectUids = []
    this.autoMove = new AutoMove(mindMap)
    this.bindEvent()
  }

  //  绑定事件
  bindEvent() {
    this.onMousedown = this.onMousedown.bind(this)
    this.onMousemove = this.onMousemove.bind(this)
    this.onMouseup = this.onMouseup.bind(this)
    this.checkInNodesRaw = this.checkInNodes.bind(this)
    this.checkInNodes = throttle(this.checkInNodesRaw, 300, this)

    this.onNodeActive = this.onNodeActive.bind(this)
    this.mindMap.on('mousedown', this.onMousedown)
    this.mindMap.on('mousemove', this.onMousemove)
    this.mindMap.on('mouseup', this.onMouseup)
    this.mindMap.on('node_mouseup', this.onMouseup)
    this.mindMap.on('node_active', this.onNodeActive)
  }

  // 解绑事件
  unBindEvent() {
    this.mindMap.off('mousedown', this.onMousedown)
    this.mindMap.off('mousemove', this.onMousemove)
    this.mindMap.off('mouseup', this.onMouseup)
    this.mindMap.off('node_mouseup', this.onMouseup)
    this.mindMap.off('node_active', this.onNodeActive)
  }

  // 鼠标按下
  onMousedown(e) {
    const { readonly, mousedownEventPreventDefault } = this.mindMap.opt
    if (readonly) {
      return
    }
    let { useLeftKeySelectionRightKeyDrag } = this.mindMap.opt
    if (
      !(e.ctrlKey || e.metaKey) &&
      (useLeftKeySelectionRightKeyDrag ? e.which !== 1 : e.which !== 3)
    ) {
      return
    }
    if (mousedownEventPreventDefault) {
      e.preventDefault()
    }
    this.isMousedown = true
    this.cacheActiveList = [...this.mindMap.renderer.activeNodeList]
    let { x, y } = this.mindMap.toPos(e.clientX, e.clientY)
    this.mouseDownX = x
    this.mouseDownY = y
    this.createRect(x, y)
  }

  // 鼠标移动
  onMousemove(e) {
    if (this.mindMap.opt.readonly) {
      return
    }
    if (!this.isMousedown) {
      return
    }
    let { x, y } = this.mindMap.toPos(e.clientX, e.clientY)
    this.mouseMoveX = x
    this.mouseMoveY = y
    if (
      Math.abs(x - this.mouseDownX) <= 10 &&
      Math.abs(y - this.mouseDownY) <= 10
    ) {
      return
    }
    this.autoMove.clearAutoMoveTimer()
    this.autoMove.onMove(
      e.clientX,
      e.clientY,
      () => {
        this.isSelecting = true
        // 绘制矩形
        if (this.rect) {
          this.rect.plot([
            [this.mouseDownX, this.mouseDownY],
            [this.mouseMoveX, this.mouseDownY],
            [this.mouseMoveX, this.mouseMoveY],
            [this.mouseDownX, this.mouseMoveY]
          ])
        }
        this.checkInNodes()
      },
      (dir, step) => {
        switch (dir) {
          case 'left':
            this.mouseDownX += step
            break
          case 'top':
            this.mouseDownY += step
            break
          case 'right':
            this.mouseDownX -= step
            break
          case 'bottom':
            this.mouseDownY -= step
            break
          default:
            break
        }
      }
    )
  }

  // 结束框选
  onMouseup() {
    if (this.mindMap.opt.readonly) {
      return
    }
    if (!this.isMousedown) {
      return
    }
    const didSelect = this.isSelecting
    // 节流会丢掉松开前最后一次检测，这里立刻提交选区，否则右键菜单拿到的还是空选中
    if (typeof this.checkInNodesRaw === 'function') {
      this.checkInNodesRaw()
    }
    this.checkTriggerNodeActiveEvent()
    this.rememberMultiSelect()
    this.autoMove.clearAutoMoveTimer()
    this.isMousedown = false
    this.cacheActiveList = []
    if (this.rect) this.rect.remove()
    this.rect = null
    this.isSelecting = false
    if (didSelect && this.lastMultiSelectUids.length > 1) {
      const pos = (this.mindMap.event && this.mindMap.event.mousemovePos) || {}
      this.mindMap.emit('multi_select_end', {
        clientX: pos.x,
        clientY: pos.y,
        uids: this.lastMultiSelectUids.slice(),
        nodes: this.getMultiSelectCache()
      })
    }
  }

  onNodeActive(node, nodeList) {
    if (Array.isArray(nodeList) && nodeList.length > 1) {
      this.lastMultiSelectList = nodeList.slice()
      this.lastMultiSelectUids = nodeList
        .map(item => this.getNodeUid(item))
        .filter(Boolean)
    }
  }

  rememberMultiSelect() {
    const list =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    if (list.length > 1) {
      this.lastMultiSelectList = list.slice()
      this.lastMultiSelectUids = list
        .map(node => this.getNodeUid(node))
        .filter(Boolean)
    }
  }

  clearMultiSelectCache() {
    this.lastMultiSelectList = []
    this.lastMultiSelectUids = []
  }

  getNodeUid(node) {
    if (!node) return ''
    return (node.getData && node.getData('uid')) || node.uid || ''
  }

  isNodeInList(list, node) {
    const uid = this.getNodeUid(node)
    if (!uid) return false
    return (list || []).some(item => this.getNodeUid(item) === uid)
  }

  getMultiSelectCache() {
    const renderer = this.mindMap && this.mindMap.renderer
    const uids = this.lastMultiSelectUids || []
    if (
      uids.length > 1 &&
      renderer &&
      typeof renderer.findNodeByUid === 'function'
    ) {
      const live = uids
        .map(uid => renderer.findNodeByUid(uid))
        .filter(Boolean)
      if (live.length > 1) return live
      // 渲染重建后旧实例可能仍留在 lastMultiSelectList 中。
      // 不能把这些已脱离画布的节点交给右键菜单，否则菜单会把当前
      // 右键节点误判为旧多选上下文，尤其容易发生在概要重渲染之后。
      return []
    }
    return (this.lastMultiSelectList || []).filter(Boolean)
  }

  // 如果激活节点改变了，那么触发事件
  checkTriggerNodeActiveEvent() {
    let isNumChange =
      this.cacheActiveList.length !==
      this.mindMap.renderer.activeNodeList.length
    let isNodeChange = false
    if (!isNumChange) {
      for (let i = 0; i < this.cacheActiveList.length; i++) {
        let cur = this.cacheActiveList[i]
        if (
          !this.mindMap.renderer.activeNodeList.find(item => {
            return item.getData('uid') === cur.getData('uid')
          })
        ) {
          isNodeChange = true
          break
        }
      }
    }
    if (isNumChange || isNodeChange) {
      this.mindMap.renderer.emitNodeActiveEvent()
    }
  }

  //  创建矩形
  createRect(x, y) {
    if (this.rect) this.rect.remove()
    this.rect = this.mindMap.svg
      .polygon()
      .stroke({
        color: '#0984e3'
      })
      .fill({
        color: 'rgba(9,132,227,0.3)'
      })
      .plot([[x, y]])
  }

  //  检测在选区里的节点
  checkInNodes() {
    let { scaleX, scaleY, translateX, translateY } =
      this.mindMap.draw.transform()
    let minx = Math.min(this.mouseDownX, this.mouseMoveX)
    let miny = Math.min(this.mouseDownY, this.mouseMoveY)
    let maxx = Math.max(this.mouseDownX, this.mouseMoveX)
    let maxy = Math.max(this.mouseDownY, this.mouseMoveY)

    const check = node => {
      let { left, top, width, height } = node
      let right = (left + width) * scaleX + translateX
      let bottom = (top + height) * scaleY + translateY
      left = left * scaleX + translateX
      top = top * scaleY + translateY
      if (
        checkTwoRectIsOverlap(minx, maxx, miny, maxy, left, right, top, bottom)
      ) {
        if (node.getData('isActive')) {
          return
        }
        this.mindMap.renderer.addNodeToActiveList(node)
        this.mindMap.renderer.emitNodeActiveEvent()
      } else if (node.getData('isActive')) {
        if (!node.getData('isActive')) {
          return
        }
        this.mindMap.renderer.removeNodeFromActiveList(node)
        this.mindMap.renderer.emitNodeActiveEvent()
      }
    }

    // 概要节点挂在所属节点上，不在普通 children 树里；其下的子树也要参与
    // 框选，否则“概要后节点”永远选不中。概要子树里的节点还能再挂概要，所以
    // 这里需要递归。
    const checkGeneralizations = node => {
      ;(node._generalizationList || []).forEach(item => {
        const gNode = item && item.generalizationNode
        if (!gNode) return
        bfsWalk(gNode, child => {
          check(child)
          checkGeneralizations(child)
        })
      })
    }
    bfsWalk(this.mindMap.renderer.root, node => {
      check(node)
      checkGeneralizations(node)
    })
    this.rememberMultiSelect()
  }

  // 是否存在选区
  hasSelectRange() {
    return this.isSelecting
  }

  // 插件被移除前做的事情
  beforePluginRemove() {
    this.unBindEvent()
  }

  // 插件被卸载前做的事情
  beforePluginDestroy() {
    this.unBindEvent()
  }
}

Select.instanceName = 'select'

export default Select
