import { SVG } from '@svgdotjs/svg.js'
import {
  isWhite,
  isTransparent,
  getVisibleColorFromTheme
} from '../utils/index'

// 小地图插件
class MiniMap {
  //  构造函数
  constructor(opt) {
    this.mindMap = opt.mindMap
    this.isMousedown = false
    this.mousedownPos = {
      x: 0,
      y: 0
    }
    this.startViewPos = {
      x: 0,
      y: 0
    }
    this.currentState = null
    this._outlineCache = null
    this._outlineDirty = true
    this.invalidateOutline = () => { this._outlineDirty = true }
    this.mindMap.on('data_change', this.invalidateOutline)
  }

  //  计算小地图的渲染数据
  /**
   * boxWidth：小地图容器的宽度
   * boxHeight：小地图容器的高度
   */
  getOutline() {
    const renderer = this.mindMap.renderer
    const version = renderer._layoutEpoch || 0
    if (this._outlineCache && !this._outlineDirty && this._outlineCache.version === version && this._outlineCache.root === renderer.root) {
      return this._outlineCache
    }
    const nodes = renderer.nodeIndex ? Array.from(renderer.nodeIndex.values()) : Object.values(renderer.nodeCache || {})
    const measured = nodes.filter(node => [node.left, node.top, node.width, node.height].every(Number.isFinite))
    const left = Math.min(...measured.map(node => node.left), 0)
    const top = Math.min(...measured.map(node => node.top), 0)
    // Bounds come from the layout model, including expanded nodes outside the
    // viewport. No main canvas nodes need to be mounted to build the outline.
    const actualLeft = measured.length ? Math.min(...measured.map(node => node.left)) : left
    const actualTop = measured.length ? Math.min(...measured.map(node => node.top)) : top
    const right = measured.length ? Math.max(...measured.map(node => node.left + node.width)) : 1
    const bottom = measured.length ? Math.max(...measured.map(node => node.top + node.height)) : 1
    const bounds = { left: actualLeft, top: actualTop, width: Math.max(1, right - actualLeft), height: Math.max(1, bottom - actualTop) }
    const svg = SVG().size(bounds.width, bounds.height).viewbox(bounds.left, bounds.top, bounds.width, bounds.height)
    measured.forEach(node => {
      ;(node._lines || []).forEach(line => { if (line && line.node) svg.add(line.clone()) })
      ;(node._generalizationList || []).forEach(item => {
        if (item.generalizationLine && item.generalizationLine.node) svg.add(item.generalizationLine.clone())
      })
    })
    measured.forEach(node => {
      const shape = node.shapeInstance.createShape()
      let fill = node.style.getStyle('fillColor')
      if (!fill || isWhite(fill) || isTransparent(fill)) fill = getVisibleColorFromTheme(this.mindMap.themeConfig)
      shape.fill(fill).stroke({ color: node.style.getStyle('borderColor') || fill, width: node.getBorderWidth() || 1 })
      shape.translate(node.left, node.top)
      svg.add(shape)
    })
    this._outlineDirty = false
    this._outlineCache = { version, root: renderer.root, bounds, svgStr: svg.svg(), image: null }
    return this._outlineCache
  }

  calculationMiniMap(boxWidth, boxHeight) {
    const outline = this.getOutline()
    const { bounds, svgStr } = outline
    const transform = this.mindMap.view.getTransformData().transform
    const scaleX = transform.scaleX || 1, scaleY = transform.scaleY || 1
    const miniMapBoxScale = Math.min(boxWidth / bounds.width, boxHeight / bounds.height)
    const actWidth = bounds.width * miniMapBoxScale
    const actHeight = bounds.height * miniMapBoxScale
    const miniMapBoxLeft = (boxWidth - actWidth) / 2
    const miniMapBoxTop = (boxHeight - actHeight) / 2
    const clamp = (value, max) => Math.max(0, Math.min(max, value))
    const viewBoxStyle = {
      left: miniMapBoxLeft + clamp((-transform.translateX / scaleX - bounds.left) * miniMapBoxScale, actWidth),
      right: miniMapBoxLeft + actWidth - clamp(((this.mindMap.width - transform.translateX) / scaleX - bounds.left) * miniMapBoxScale, actWidth),
      top: miniMapBoxTop + clamp((-transform.translateY / scaleY - bounds.top) * miniMapBoxScale, actHeight),
      bottom: miniMapBoxTop + actHeight - clamp(((this.mindMap.height - transform.translateY) / scaleY - bounds.top) * miniMapBoxScale, actHeight)
    }
    Object.keys(viewBoxStyle).forEach(key => { viewBoxStyle[key] += 'px' })
    this.currentState = { viewBoxStyle: { ...viewBoxStyle }, miniMapBoxScale, miniMapBoxLeft, miniMapBoxTop }
    return {
      getImgUrl: async callback => {
        if (!outline.image) outline.image = this.mindMap.doExport.fixSvgStrAndToBlob(svgStr)
        callback(await outline.image)
      },
      svgHTML: svgStr,
      viewBoxStyle,
      miniMapBoxScale,
      miniMapBoxLeft,
      miniMapBoxTop
    }
  }

  beforePluginRemove() {
    this.mindMap.off('data_change', this.invalidateOutline)
    this._outlineCache = null
    this.currentState = null
  }

  beforePluginDestroy() {
    this.beforePluginRemove()
  }

  // 移除节点的内容
  removeNodeContent(svg) {
    if (svg.hasClass('smm-node')) {
      let shape = svg.findOne('.smm-node-shape')
      let fill = shape.attr('fill')
      if (isWhite(fill) || isTransparent(fill)) {
        shape.attr('fill', getVisibleColorFromTheme(this.mindMap.themeConfig))
      }
      svg.clear()
      svg.add(shape)
      return
    }
    let children = svg.children()
    if (children && children.length > 0) {
      children.forEach(node => {
        this.removeNodeContent(node)
      })
    }
  }

  //  小地图鼠标按下事件
  onMousedown(e) {
    this.isMousedown = true
    this.mousedownPos = {
      x: e.clientX,
      y: e.clientY
    }
    // 保存视图当前的偏移量
    let transformData = this.mindMap.view.getTransformData()
    this.startViewPos = {
      x: transformData.state.x,
      y: transformData.state.y
    }
  }

  //  小地图鼠标移动事件
  onMousemove(e, sensitivityNum = 5) {
    if (!this.isMousedown || this.isViewBoxMousedown) {
      return
    }
    let ox = e.clientX - this.mousedownPos.x
    let oy = e.clientY - this.mousedownPos.y
    // 在视图最初偏移量上累加更新量
    this.mindMap.view.translateXTo(ox * sensitivityNum + this.startViewPos.x)
    this.mindMap.view.translateYTo(oy * sensitivityNum + this.startViewPos.y)
  }

  //  小地图鼠标松开事件
  onMouseup() {
    this.isMousedown = false
    this.isViewBoxMousedown = false
  }

  // 视口框鼠标按下事件
  onViewBoxMousedown(e) {
    this.isViewBoxMousedown = true
    this.mousedownPos = {
      x: e.clientX,
      y: e.clientY
    }
    // 保存视图当前的偏移量
    let transformData = this.mindMap.view.getTransformData()
    this.startViewPos = {
      x: transformData.state.x,
      y: transformData.state.y
    }
  }

  // 视口框鼠标移动事件
  onViewBoxMousemove(e) {
    if (!this.isViewBoxMousedown || !this.currentState || this.isMousedown)
      return
    let ox = e.clientX - this.mousedownPos.x
    let oy = e.clientY - this.mousedownPos.y
    const { viewBoxStyle, miniMapBoxScale, miniMapBoxLeft, miniMapBoxTop } =
      this.currentState
    const left = Math.max(
      miniMapBoxLeft,
      Number.parseFloat(viewBoxStyle.left) + ox
    )
    const right = Math.max(
      miniMapBoxLeft,
      Number.parseFloat(viewBoxStyle.right) - ox
    )
    const top = Math.max(
      miniMapBoxTop,
      Number.parseFloat(viewBoxStyle.top) + oy
    )
    const bottom = Math.max(
      miniMapBoxTop,
      Number.parseFloat(viewBoxStyle.bottom) - oy
    )
    this.mindMap.emit('mini_map_view_box_position_change', {
      left: left + 'px',
      right: right + 'px',
      top: top + 'px',
      bottom: bottom + 'px'
    })
    // 在视图最初偏移量上累加更新量
    const transform = this.mindMap.view.getTransformData().transform
    this.mindMap.view.translateXTo(-ox * (transform.scaleX || 1) / miniMapBoxScale + this.startViewPos.x)
    this.mindMap.view.translateYTo(-oy * (transform.scaleY || 1) / miniMapBoxScale + this.startViewPos.y)
  }
}

MiniMap.instanceName = 'miniMap'

export default MiniMap
