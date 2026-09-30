import btnsSvg from '../../../svg/btns'
import { SVG, G, Rect, Text } from '@svgdotjs/svg.js'
import { isUndef } from '../../../utils'
import nodeDescendantCount from '../../../utils/nodeDescendantCount'
import { CONSTANTS } from '../../../constants/constant'

// Ring geometry of the built-in add/collapse icons (1024 viewBox): outer
// radius 480.768, ring thickness 74. The badge reuses it so all
// junction buttons share one outline.
const ICON_RING_INSET = 31.232 / 1024
const ICON_RING_WIDTH = 74 / 1024

// Only a single digit fits safely inside the icon ring. Keep padding between
// glyphs and rounded ends for all longer labels, including custom formatters.
const getCountBadgeGeometry = (count, btnSize, expandBtnStyle, textWidth = 0) => {
  const strokeWidth = btnSize * ICON_RING_WIDTH
  const inset = btnSize * ICON_RING_INSET + strokeWidth / 2
  const height = btnSize - inset * 2
  const fontSize = Math.min(
    (expandBtnStyle && expandBtnStyle.fontSize) || 12,
    Math.round(btnSize * 0.55)
  )
  const label = String(count)
  const length = Array.from(label).length
  const estimatedWidth = length * fontSize * (/^\d+$/.test(label) ? 0.7 : 1)
  const width = Math.max(height, Math.ceil(Math.max(estimatedWidth, textWidth) + fontSize))
  return { width, height, inset, strokeWidth, fontSize }
}

const getCountBadgeGeometryKey = (count, btnSize, expandBtnStyle) =>
  JSON.stringify([String(count), btnSize, expandBtnStyle && expandBtnStyle.fontSize])

const getCountBadgeColor = expandBtnStyle =>
  (expandBtnStyle && expandBtnStyle.color) || '#808080'

// Which node edge the layout anchors the button group to.
function getCountBadgeSide() {
  const { LAYOUT, LAYOUT_GROW_DIR } = CONSTANTS
  const layout = this.mindMap.opt.layout
  if (layout === LAYOUT.LOGICAL_STRUCTURE_LEFT) return 'left'
  if (layout === LAYOUT.LOGICAL_STRUCTURE || layout === LAYOUT.COMPACT_STRUCTURE) {
    return 'right'
  }
  if (layout === LAYOUT.MIND_MAP || /^verticalTimeline/.test(layout)) {
    return this.dir === LAYOUT_GROW_DIR.LEFT ? 'left' : 'right'
  }
  return 'center'
}

function getExpandBtnCount(rawCount) {
  let count = isUndef(rawCount)
    ? nodeDescendantCount.getDescendantCount(this)
    : rawCount
  const { expandBtnNumHandler } = this.mindMap.opt
  if (typeof expandBtnNumHandler === 'function') {
    const result = expandBtnNumHandler(count, this)
    if (!isUndef(result)) count = result
  }
  return count
}

function getExpandBtnOuterWidth() {
  const { notShowExpandBtn, isShowExpandNum, expandBtnStyle } = this.mindMap.opt
  if (notShowExpandBtn || this.isRoot || this.getChildrenLength() <= 0) return 0
  if (isShowExpandNum && this.getData('expand') === false) {
    const count = this.getExpandBtnCount()
    const key = getCountBadgeGeometryKey(count, this.expandBtnSize, expandBtnStyle)
    const { width, inset } = this._expandBtnCountGeometryKey === key
      ? this._expandBtnCountGeometry
      : getCountBadgeGeometry(count, this.expandBtnSize, expandBtnStyle)
    return Math.max(this.expandBtnSize, width + inset * 2)
  }
  return this.expandBtnSize
}

// 创建展开收起按钮的内容节点
function createExpandNodeContent() {
  if (this._openExpandNode) {
    return
  }
  const { expandBtnSize, expandBtnIcon, isShowExpandNum } = this.mindMap.opt
  let { close, open } = expandBtnIcon || {}
  // 根据配置判断是否显示数量按钮
  if (isShowExpandNum) {
    // 展开的节点
    this._openExpandNode = new Text()
    this._openExpandNode.addClass('smm-expand-btn-text')
    // 文本垂直居中
    this._openExpandNode.attr({
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      x: expandBtnSize / 2,
      y: 0
    })
  } else {
    this._openExpandNode = SVG(open || btnsSvg.open).size(
      expandBtnSize,
      expandBtnSize
    )
    this._openExpandNode.x(0).y(-expandBtnSize / 2)
  }
  // 收起的节点
  this._closeExpandNode = SVG(close || btnsSvg.close).size(
    expandBtnSize,
    expandBtnSize
  )
  this._closeExpandNode.x(0).y(-expandBtnSize / 2)
  // 填充节点
  this._fillExpandNode = new Rect().size(expandBtnSize, expandBtnSize)
  this._fillExpandNode.radius(expandBtnSize / 2)
  this._fillExpandNode.x(0).y(-expandBtnSize / 2)

  // 设置样式
  this.style.iconBtn(
    this._openExpandNode,
    this._closeExpandNode,
    this._fillExpandNode
  )
}
function sumNode(data = []) {
  return nodeDescendantCount.countDescendants(data)
}
//  创建或更新展开收缩按钮内容
function updateExpandBtnNode() {
  let { expand } = this.getData()
  const { expandBtnStyle } = this.mindMap.opt
  const descendantCount = expand === false && this.mindMap.opt.isShowExpandNum
    ? nodeDescendantCount.getDescendantCount(this) : null
  const count = descendantCount === null ? null : this.getExpandBtnCount(descendantCount)
  // 如果本次和上次的展开状态一样则返回
  // Collapsed badges must also refresh when descendants change remotely.
  // Keep unchanged SVG elements mounted so mouseover cannot interrupt a click.
  const badgeKey = descendantCount === null
    ? null
    : JSON.stringify([descendantCount, getCountBadgeGeometryKey(count, this.expandBtnSize, expandBtnStyle),
      getCountBadgeSide.call(this), expandBtnStyle && expandBtnStyle.color, expandBtnStyle && expandBtnStyle.fill])
  if (expand === this._lastExpandBtnType &&
    badgeKey === this._lastExpandBtnCount) return
  this._lastExpandBtnCount = badgeKey
  if (this._expandBtn) {
    this._expandBtn.clear()
  }
  this.createExpandNodeContent()
  let node
  if (expand === false) {
    node = this._openExpandNode
    this._lastExpandBtnType = false
  } else {
    node = this._closeExpandNode
    this._lastExpandBtnType = true
  }

  if (this._expandBtn) {
    // 如果是收起按钮加上边框
    let { isShowExpandNum, expandBtnStyle } =
      this.mindMap.opt
    if (isShowExpandNum) {
      if (!expand) {
        const color = getCountBadgeColor(expandBtnStyle)
        const initial = getCountBadgeGeometry(count, this.expandBtnSize, expandBtnStyle)
        // Measure only when the badge changes, not on every hover/layout frame.
        // Plain text avoids SVG.js retaining a tspan's old x after recentering.
        node.attr({ 'font-size': initial.fontSize + 'px' })
        node.plain(String(count))
        this._expandBtn.add(this._fillExpandNode).add(node)
        let textWidth = 0
        try {
          if (typeof node.length === 'function') textWidth = node.length()
        } catch (err) {
          // Detached/export SVGs can lack text measurement; use the estimate.
        }
        if (!Number.isFinite(textWidth) || textWidth < 0) textWidth = 0
        const { width, height, inset, strokeWidth, fontSize } =
          getCountBadgeGeometry(count, this.expandBtnSize, expandBtnStyle, textWidth)
        this._expandBtnCountGeometry = { width, height, inset, strokeWidth, fontSize }
        this._expandBtnCountGeometryKey = getCountBadgeGeometryKey(count, this.expandBtnSize, expandBtnStyle)
        const side = getCountBadgeSide.call(this)
        const x = side === 'right'
          ? inset
          : side === 'left'
            ? this.expandBtnSize - inset - width
            : (this.expandBtnSize - width) / 2
        this._fillExpandNode
          .stroke({ color, width: strokeWidth })
          .size(width, height)
          .radius(height / 2)
          .x(x)
          .y(-height / 2)
        node.attr({ x: x + width / 2, 'font-size': fontSize + 'px' })
        node.fill({ color })
      } else {
        this._fillExpandNode.stroke('none')
        this._fillExpandNode
          .size(this.expandBtnSize, this.expandBtnSize)
          .radius(this.expandBtnSize / 2)
          .x(0)
          .y(-this.expandBtnSize / 2)
      }
    }
    this._expandBtn.add(this._fillExpandNode).add(node)
  }
}

//  更新展开收缩按钮位置
function updateExpandBtnPos() {
  if (!this._expandBtn) {
    return
  }
  // Both states use the layout's branch junction: expanded parents collapse
  // beside the child connector, while collapsed parents show the count there.
  this.renderer.layout.renderExpandBtn(this, this._expandBtn)
}

//  创建展开收缩按钮
function renderExpandBtn() {
  if (this.isGeneralization) return
  if (this.getChildrenLength() <= 0 || this.isRoot) {
    return
  }
  const { isShowCreateChildBtnIcon, readonly } = this.mindMap.opt
  if (
    isShowCreateChildBtnIcon &&
    !readonly &&
    this.getData('isActive') &&
    this.getData('expand') !== false
  ) {
    // Selected expanded parents use the same junction for add-child.
    // Hide collapse so the two actions never overlap or compete for clicks.
    this.removeExpandBtn()
    return
  }
  if (this._expandBtn) {
    this.group.add(this._expandBtn)
  } else {
    this._expandBtn = new G()
    this._expandBtn.on('mouseover', e => {
      e.stopPropagation()
      this._expandBtn.css({
        cursor: 'pointer'
      })
    })
    this._expandBtn.on('mouseout', e => {
      e.stopPropagation()
      this._expandBtn.css({
        cursor: 'auto'
      })
    })
    this._expandBtn.on('click', e => {
      e.stopPropagation()
      const live =
        this.nodeData && this.nodeData.children && this.nodeData.children.length
      const childCount = Number(this.getData('childCount')) || 0
      const expanding = this.getData('expand') !== false
      // 已展开但子树还没灌进来时，再点一次是重新加载，不是收起
      const next =
        expanding && !live && childCount > 0 ? true : !expanding
      this.mindMap.execCommand('SET_NODE_EXPAND', this, next)
      this.mindMap.emit('expand_btn_click', this)
    })
    this._expandBtn.on('dblclick', e => {
      e.stopPropagation()
    })
    this._expandBtn.addClass('smm-expand-btn')
    this.group.add(this._expandBtn)
  }
  this._showExpandBtn = true
  this.updateExpandBtnNode()
  this.updateExpandBtnPos()
}

//  移除展开收缩按钮
function removeExpandBtn() {
  if (this._expandBtn && this._showExpandBtn) {
    this._expandBtn.remove()
    this._showExpandBtn = false
  }
}

// 显示展开收起按钮
function showExpandBtn() {
  const { alwaysShowExpandBtn, notShowExpandBtn } = this.mindMap.opt
  if (alwaysShowExpandBtn || notShowExpandBtn) return
  setTimeout(() => {
    const { isActive, expand } = this.getData()
    if (!isActive && expand !== false && !this._isMouseenter) return
    this.renderExpandBtn()
  }, 0)
}

// 隐藏展开收起按钮
function hideExpandBtn() {
  const { alwaysShowExpandBtn, notShowExpandBtn } = this.mindMap.opt
  if (alwaysShowExpandBtn || this._isMouseenter || notShowExpandBtn) return
  // 非激活状态且展开状态鼠标移出才隐藏按钮
  let { isActive, expand } = this.getData()
  if (!isActive && expand) {
    setTimeout(() => {
      this.removeExpandBtn()
    }, 0)
  }
}

export default {
  getExpandBtnCount,
  getExpandBtnOuterWidth,
  createExpandNodeContent,
  updateExpandBtnNode,
  updateExpandBtnPos,
  renderExpandBtn,
  removeExpandBtn,
  showExpandBtn,
  hideExpandBtn,
  sumNode
}
