import { Rect } from '@svgdotjs/svg.js'

// 初始化拖拽
function initDragHandle() {
  if (!this.mindMap.opt.enableDragModifyNodeWidth || this._dragHandleInitialized) {
    return
  }
  this._dragHandleInitialized = true
  // 拖拽手柄元素
  this._dragHandleNodes = null
  this._dragHandleMarks = null
  // 四角共享同一套文本宽度调整逻辑；高度由文本换行自动计算。
  this.dragHandleWidth = 6
  this.dragHandleHitWidth = 14
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
  // Coalesce the size and layout update into a single paint per frame.
  this.dragHandleLayoutFrame = null
  this.dragHandleNeedsUpdate = false

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
  this.customTextWidth = newWidth
  // The layout pass reads nodeData, while the command (and history update) is
  // committed only on mouseup. Keep the preview geometry in both places.
  this.nodeData.data.customTextWidth = newWidth
  if (this.dragHandleIndex % 2 === 0) {
    this.left = this.dragHandleMousedownLeft +
      this.dragHandleMousedownCustomTextWidth - newWidth
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
  this.dragHandleIndex = 0
  this.dragHandleMousedownCustomTextWidth = 0
  this.setData({
    customTextWidth: this.customTextWidth
  })
  this.mindMap.render()
  this.mindMap.emit('dragModifyNodeWidthEnd', this)
}

// 插件拖拽手柄元素
function createDragHandleNode() {
  const list = Array.from({ length: 4 }, () => new Rect())
  this._dragHandleMarks = Array.from({ length: 4 }, () => new Rect())
  list.forEach((node, index) => {
    node
      .size(this.dragHandleHitWidth, this.dragHandleHitWidth)
      .fill({
        color: 'transparent'
      })
      .css({
        cursor: index === 0 || index === 3 ? 'nwse-resize' : 'nesw-resize'
      })
    this._dragHandleMarks[index]
      .size(this.dragHandleWidth, this.dragHandleWidth)
      .fill({ color: '#fff' })
      .stroke({ color: '#409eff', width: 1 })
      .radius(1)
      .attr('pointer-events', 'none')
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
      this.isDragHandleMousedown = true
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
      this._dragHandleMarks.forEach(node => node.remove())
    }
    return
  }
  if (!this._dragHandleInitialized) this.initDragHandle()
  if (!this._dragHandleNodes) {
    this._dragHandleNodes = this.createDragHandleNode()
  }
  if (this.getData('isActive')) {
    this._dragHandleNodes.forEach((node, index) => {
      const isLeft = index % 2 === 0
      const isTop = index < 2
      node.x(isLeft
        ? -this.dragHandleHitWidth / 2
        : this.width - this.dragHandleHitWidth / 2)
      node.y((isTop ? 0 : this.height) - this.dragHandleHitWidth / 2)
      if (node.parent() !== this.group) this.group.add(node)
      const mark = this._dragHandleMarks[index]
      mark.x(isLeft
        ? -this.dragHandleWidth / 2
        : this.width - this.dragHandleWidth / 2)
      mark.y((isTop ? 0 : this.height) - this.dragHandleWidth / 2)
      if (mark.parent() !== this.group) this.group.add(mark)
    })
  } else {
    this._dragHandleNodes.forEach(node => {
      node.remove()
    })
    this._dragHandleMarks.forEach(node => node.remove())
  }
}

export default {
  initDragHandle,
  onDragMousemoveHandle,
  onDragMouseupHandle,
  createDragHandleNode,
  updateDragHandle
}
