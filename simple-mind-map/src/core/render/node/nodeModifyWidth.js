import { Rect } from '@svgdotjs/svg.js'

// 初始化拖拽
function initDragHandle() {
  if (!this.mindMap.opt.enableDragModifyNodeWidth || this._dragHandleInitialized) {
    return
  }
  this._dragHandleInitialized = true
  // 拖拽手柄元素
  this._dragHandleNodes = null
  // Transparent edge hit areas include both corners. No selection rectangle
  // or visible handle is needed to resize the node.
  this.dragHandleHitWidth = 12
  // 鼠标按下时的x坐标
  this.dragHandleMousedownX = 0
  // 鼠标是否处于按下状态
  this.isDragHandleMousedown = false
  // 当前拖拽的手柄序号
  this.dragHandleIndex = 0
  // 鼠标按下时记录当前的customTextWidth值
  this.dragHandleMousedownCustomTextWidth = 0
  // 鼠标按下时记录当前的手型样式
  this.dragHandleMousedownBodyCursor = ''
  // 鼠标按下时记录当前节点的left值
  this.dragHandleMousedownLeft = 0
  this.dragHandleOriginalWidth = undefined
  this.dragHandleOriginalLeft = undefined
  // Coalesce the size and layout update into a single paint per frame.
  this.dragHandleLayoutFrame = null
  this.dragHandleNeedsUpdate = false
  this.dragHandleDidMove = false

  this.onDragMousemoveHandle = this.onDragMousemoveHandle.bind(this)
  this.onDragMouseupHandle = this.onDragMouseupHandle.bind(this)
}

// 鼠标移动事件
function onDragMousemoveHandle(e) {
  if (!this.isDragHandleMousedown) return
  e.stopPropagation()
  e.preventDefault()
  let {
    minNodeTextModifyWidth,
    maxNodeTextModifyWidth,
    isUseCustomNodeContent,
    customCreateNodeContent
  } = this.mindMap.opt
  const useCustomContent =
    isUseCustomNodeContent && customCreateNodeContent && this._customNodeContent
  document.body.style.cursor = 'ew-resize'
  this.group.css({
    cursor: 'ew-resize'
  })
  const { scaleX } = this.mindMap.draw.transform()
  const ox = e.clientX - this.dragHandleMousedownX
  if (Math.abs(ox) < 2 && !this.dragHandleDidMove) return
  let newWidth =
    this.dragHandleMousedownCustomTextWidth +
    (this.dragHandleIndex % 2 === 0 ? -ox : ox) / scaleX
  newWidth = Math.max(newWidth, minNodeTextModifyWidth)
  if (maxNodeTextModifyWidth !== -1) {
    newWidth = Math.min(newWidth, maxNodeTextModifyWidth)
  }
  // 如果存在图片，那么最小值需要考虑图片宽度
  if (!useCustomContent && this.getData('image')) {
    const imgSize = this.getImgShowSize()
    if (
      this._rectInfo.textContentWidth - this.customTextWidth + newWidth <=
      imgSize[0]
    ) {
      newWidth =
        imgSize[0] + this.customTextWidth - this._rectInfo.textContentWidth
    }
  }
  if (newWidth === this.customTextWidth) return
  this.dragHandleDidMove = true
  this.customTextWidth = newWidth
  // The layout pass reads nodeData, while the command (and history update) is
  // committed only on mouseup. Keep the preview geometry in both places.
  this.nodeData.data.customTextWidth = newWidth
  if (this.dragHandleIndex % 2 === 0) {
    this.customLeft = this.dragHandleMousedownLeft +
      this.dragHandleMousedownCustomTextWidth - newWidth
    this.left = this.customLeft
    this.nodeData.data.customLeft = this.customLeft
  }
  this.dragHandleNeedsUpdate = true
  if (this.dragHandleLayoutFrame === null) {
    this.dragHandleLayoutFrame = requestAnimationFrame(() => {
      this.dragHandleLayoutFrame = null
      if (!this.isDragHandleMousedown || !this.dragHandleNeedsUpdate) return
      this.dragHandleNeedsUpdate = false
      this.renderer._syncLayoutForResize = !!(
        this.renderer.layout && this.renderer.layout.compactConfig
      )
      this.renderer._syncPaintOnce = true
      this.mindMap.render()
    })
  }
}

// 鼠标松开事件
function onDragMouseupHandle() {
  if (!this.isDragHandleMousedown) return
  window.removeEventListener('mousemove', this.onDragMousemoveHandle, true)
  window.removeEventListener('mouseup', this.onDragMouseupHandle, true)
  window.removeEventListener('blur', this.onDragMouseupHandle)
  if (this.dragHandleLayoutFrame !== null) {
    cancelAnimationFrame(this.dragHandleLayoutFrame)
    this.dragHandleLayoutFrame = null
  }
  this.dragHandleNeedsUpdate = false
  document.body.style.cursor = this.dragHandleMousedownBodyCursor
  this.group.css({
    cursor: 'default'
  })
  this.isDragHandleMousedown = false
  this.dragHandleMousedownX = 0
  const draggedFromLeft = this.dragHandleIndex === 0
  this.dragHandleIndex = 0
  this.dragHandleMousedownCustomTextWidth = 0
  if (!this.dragHandleDidMove) return
  this.dragHandleDidMove = false
  // Preview writes into nodeData so every layout pass sees the new size. Put
  // the original values back before the command, otherwise collaboration and
  // history may treat the final resize as a no-op.
  this.nodeData.data.customTextWidth = this.dragHandleOriginalWidth
  if (draggedFromLeft) {
    this.nodeData.data.customLeft = this.dragHandleOriginalLeft
  }
  this.setData(draggedFromLeft
    ? { customTextWidth: this.customTextWidth, customLeft: this.customLeft }
    : { customTextWidth: this.customTextWidth })
  this.mindMap.render()
  this.mindMap.emit('dragModifyNodeWidthEnd', this)
}

// 插件拖拽手柄元素
function createDragHandleNode() {
  const list = [new Rect(), new Rect()]
  list.forEach((node, index) => {
    node
      .size(this.dragHandleHitWidth, this.height + this.dragHandleHitWidth)
      .fill({
        color: 'transparent'
      })
      .css({
        cursor: 'ew-resize'
      })
    node.on('mousedown', e => {
      if (!this.checkEnableDragModifyNodeWidth()) return
      e.stopPropagation()
      e.preventDefault()
      this.dragHandleMousedownX = e.clientX
      this.dragHandleIndex = index
      this.dragHandleMousedownCustomTextWidth =
        this.customTextWidth === undefined
          ? this._textData
            ? this._textData.width
            : this.width
          : this.customTextWidth
      this.dragHandleMousedownBodyCursor = document.body.style.cursor
      this.dragHandleMousedownLeft = this.left
      this.dragHandleOriginalWidth = this.nodeData.data.customTextWidth
      this.dragHandleOriginalLeft = this.nodeData.data.customLeft
      this.isDragHandleMousedown = true
      this.dragHandleDidMove = false
      window.addEventListener('mousemove', this.onDragMousemoveHandle, true)
      window.addEventListener('mouseup', this.onDragMouseupHandle, true)
      window.addEventListener('blur', this.onDragMouseupHandle)
    })
  })
  return list
}

// 更新拖拽按钮的显隐和位置尺寸
function updateDragHandle() {
  if (!this.checkEnableDragModifyNodeWidth()) {
    if (this._dragHandleNodes) {
      this._dragHandleNodes.forEach(node => node.remove())
    }
    if (this.group) this.group.removeClass('smm-resizable-node')
    return
  }
  if (!this._dragHandleInitialized) this.initDragHandle()
  if (!this._dragHandleNodes) {
    this._dragHandleNodes = this.createDragHandleNode()
  }
  this.group.addClass('smm-resizable-node')
  if (!this.getData('isActive') && !this._isMouseenter &&
    !this.isDragHandleMousedown) {
    this._dragHandleNodes.forEach(node => node.remove())
    return
  }
  this._dragHandleNodes.forEach((node, index) => {
    node.size(this.dragHandleHitWidth, this.height + this.dragHandleHitWidth)
    node.x(index === 0
      ? -this.dragHandleHitWidth / 2
      : this.width - this.dragHandleHitWidth / 2)
    node.y(-this.dragHandleHitWidth / 2)
    if (node.parent() !== this.group) this.group.add(node)
  })
}

export default {
  initDragHandle,
  onDragMousemoveHandle,
  onDragMouseupHandle,
  createDragHandleNode,
  updateDragHandle
}
