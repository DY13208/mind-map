import {
  resizeImgSize,
  removeRichTextStyes,
  isUndef,
  createForeignObjectNode,
  addXmlns,
  generateColorByContent,
  camelCaseToHyphen,
  getNodeRichTextStyles,
  measureText as measureTextCanvas
} from '../../../utils'
import p1PerfPlanModule from '../../../utils/p1PerfPlan'
const p1PerfPlan = p1PerfPlanModule.wrapPlainTextLines
  ? p1PerfPlanModule
  : p1PerfPlanModule.default
import { Image as SVGImage, SVG, A, G, Rect, Text, Circle, Path } from '@svgdotjs/svg.js'
import iconsSvg from '../../../svg/icons'
import { noneRichTextNodeLineHeight, CONSTANTS } from '../../../constants/constant'
import mapRefUtil from '../../../utils/mapRef'
import { resolveHyperlinkClick } from '../../../utils/hyperlinkClick'
import {
  hasAttachmentIcon,
  attachmentIconViewState,
  attachmentBadgeGeometry
} from '../../../utils/attachmentIconState'
import {
  nodeCommentCount,
  commentMarkerViewState,
  commentTabGeometry,
  commentTabColors
} from '../../../utils/nodeComment'

// 测量svg文本宽高
const measureText = (text, style) => {
  const g = new G()
  const node = new Text().text(text)
  style.text(node)
  g.add(node)
  return g.bbox()
}

const wrapPlainParagraphsWithSvg = (paragraphs, maxWidth, style) => {
  return paragraphs.map(item => {
    const arr = String(item).split('')
    const lines = []
    let line = []
    while (arr.length) {
      const str = arr.shift()
      const next = [...line, str].join('')
      if (measureText(next, style).width <= maxWidth) line.push(str)
      else {
        lines.push(line.join(''))
        line = [str]
      }
    }
    if (line.length) lines.push(line.join(''))
    return lines.join('\n')
  })
}

const wrapPlainParagraphs = (paragraphs, maxWidth, node) => {
  const flags = (node.mindMap && node.mindMap.opt && node.mindMap.opt.performanceFlags) || {}
  const joined = paragraphs.join('\n')
  const fontSize = node.getStyle('fontSize', false)
  const fontWeight = node.getStyle('fontWeight', false)
  const fontStyle = node.getStyle('fontStyle', false)
  const styleObj = {
    italic: fontStyle === 'italic',
    bold: fontWeight === 'bold' || fontWeight === '700' || Number(fontWeight) >= 700,
    fontSize,
    fontFamily: node.getStyle('fontFamily', false) || '微软雅黑, Microsoft YaHei',
    letterSpacing: node.getStyle('letterSpacing', false),
    fontWeight,
    fontStyle,
    text: joined
  }
  if (
    flags.canvasTextMeasure &&
    !p1PerfPlan.canvasPlainTextFallbackReason(styleObj)
  ) {
    try {
      const measureWidth = text => measureTextCanvas(text || '﻿', styleObj).width
      return paragraphs.map(item =>
        p1PerfPlan.wrapPlainTextLines(item, measureWidth, maxWidth).join('\n')
      )
    } catch (error) {
      return wrapPlainParagraphsWithSvg(paragraphs, maxWidth, node.style)
    }
  }
  return wrapPlainParagraphsWithSvg(paragraphs, maxWidth, node.style)
}

// Simple rich-text HTML that can be measured without forced DOM reflow.
// Matches RichText.handleDataToRichText + resetRichText wrapping: <p>escaped</p>
const SIMPLE_RICH_TEXT_RE = /^<p>([\s\S]*)<\/p>$/i
const HAS_NESTED_TAG_RE = /<[a-z][\s\S]*?>/i

const decodeBasicEntities = str =>
  String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

const tryPlainFromSimpleRichText = html => {
  const raw = String(html || '').trim()
  if (!raw) return ''
  const m = SIMPLE_RICH_TEXT_RE.exec(raw)
  if (!m) return null
  const inner = m[1]
  if (HAS_NESTED_TAG_RE.test(inner)) return null
  return decodeBasicEntities(inner)
}

const wrapPlainLines = (plain, styleObj, maxWidth) => {
  const fontSize = parseFloat(styleObj.fontSize) || 16
  const fontFamily = styleObj.fontFamily || '微软雅黑, Microsoft YaHei'
  const bold =
    styleObj.fontWeight === 'bold' ||
    styleObj.fontWeight === '700' ||
    Number(styleObj.fontWeight) >= 700
  const italic = styleObj.fontStyle === 'italic'
  const style = { italic, bold, fontSize, fontFamily }
  const source = String(plain)
  // Fast path: single-line label that fits maxWidth (common for large maps).
  if (source.indexOf('\n') < 0) {
    const one = measureTextCanvas(source || '﻿', style)
    if (one.width <= maxWidth) {
      return {
        width: Math.min(Math.ceil(one.width) + 1, maxWidth),
        height: Math.ceil(fontSize * noneRichTextNodeLineHeight)
      }
    }
  }
  const paragraphs = source.split(/\n/)
  const lines = []
  paragraphs.forEach(para => {
    const chars = Array.from(para)
    if (!chars.length) {
      lines.push('')
      return
    }
    let line = ''
    for (let i = 0; i < chars.length; i++) {
      const next = line + chars[i]
      if (measureTextCanvas(next, style).width <= maxWidth || !line) {
        line = next
      } else {
        lines.push(line)
        line = chars[i]
      }
    }
    if (line) lines.push(line)
  })
  let width = 0
  lines.forEach(line => {
    const w = measureTextCanvas(line || '﻿', style).width
    if (w > width) width = w
  })
  const lineCount = Math.max(1, lines.length)
  const height = fontSize * noneRichTextNodeLineHeight * lineCount
  return {
    width: Math.min(Math.ceil(width) + 1, maxWidth),
    height: Math.ceil(height)
  }
}

const getRichTextMeasureCache = mindMap => {
  if (!mindMap.commonCaches.richTextMeasureCache) {
    mindMap.commonCaches.richTextMeasureCache = new Map()
  }
  return mindMap.commonCaches.richTextMeasureCache
}

// Canvas width can be a few pixels smaller than the real glyphs, so a line
// that "fits" still wraps in the node and overlaps the sibling below.
const readRichTextDomBox = (mindMap, el) => {
  if (!mindMap || !mindMap.el || !el) return null
  let host = mindMap.commonCaches.measureRichtextNodeTextSizeEl
  if (!host) {
    host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.left = '-99999px'
    host.style.top = '0'
    mindMap.el.appendChild(host)
    mindMap.commonCaches.measureRichtextNodeTextSizeEl = host
  }
  host.appendChild(el)
  const rect = el.getBoundingClientRect()
  host.removeChild(el)
  return {
    width: rect.width,
    height: rect.height
  }
}

// 标签默认的样式
const defaultTagStyle = {
  radius: 3, // 标签矩形的圆角大小
  fontSize: 12, // 字号，建议文字高度不要大于height
  fill: '', // 标签矩形的背景颜色
  height: 20, // 标签矩形的高度
  paddingX: 8 // 水平内边距，如果设置了width，将忽略该配置
  //width: 30 // 标签矩形的宽度，如果不设置，默认以文字的宽度+paddingX*2为宽度
}

// 获取图片的真实url
// 因为如果注册了NodeBase64ImageStorage插件，那么节点图片字段保存的实际是一个id，所以如果要获取图片真实的url可以通过该方法
function getImageUrl() {
  const img = this.getData('image')
  return (this.mindMap.renderer.renderTree.data.imgMap || {})[img] || img
}

//  创建图片节点
function createImgNode() {
  let img = this.getImageUrl()
  if (!img) {
    return
  }
  img = (this.mindMap.renderer.renderTree.data.imgMap || {})[img] || img
  const imgSize = this.getImgShowSize()
  const node = new SVGImage().load(img).size(...imgSize)
  // 如果指定了加载失败显示的图片，那么加载一下图片检测是否失败
  const { defaultNodeImage } = this.mindMap.opt
  if (defaultNodeImage) {
    const imgEl = new Image()
    imgEl.onerror = () => {
      node.load(defaultNodeImage)
    }
    imgEl.src = img
  }
  if (this.getData('imageTitle')) {
    node.attr('title', this.getData('imageTitle'))
  }
  node.on('click', e => {
    this.mindMap.emit('node_img_click', this, node, e)
  })
  node.on('dblclick', e => {
    this.mindMap.emit('node_img_dblclick', this, e, node)
  })
  node.on('mouseenter', e => {
    this.mindMap.emit('node_img_mouseenter', this, node, e)
  })
  node.on('mouseleave', e => {
    this.mindMap.emit('node_img_mouseleave', this, node, e)
  })
  node.on('mousemove', e => {
    this.mindMap.emit('node_img_mousemove', this, node, e)
  })
  return {
    node,
    width: imgSize[0],
    height: imgSize[1]
  }
}

//  获取图片显示宽高
function getImgShowSize() {
  const { custom, width, height } = this.getData('imageSize')
  // 如果是自定义了图片的宽高，那么不受最大宽高限制
  if (custom) return [width, height]
  return resizeImgSize(
    width,
    height,
    this.mindMap.themeConfig.imgMaxWidth,
    this.mindMap.themeConfig.imgMaxHeight
  )
}

//  创建icon节点
function createIconNode() {
  let _data = this.getData()
  if (!_data.icon || _data.icon.length <= 0) {
    return []
  }
  let iconSize = this.mindMap.themeConfig.iconSize
  return _data.icon.map(item => {
    let src = iconsSvg.getNodeIconListIcon(
      item,
      this.mindMap.opt.iconList || []
    )
    let node = null
    // svg图标
    if (/^<svg/.test(src)) {
      node = SVG(src)
    } else {
      // 图片图标
      node = new SVGImage().load(src)
    }
    node.size(iconSize, iconSize)
    node.on('click', e => {
      this.mindMap.emit('node_icon_click', this, item, e, node)
    })
    node.on('mouseenter', e => {
      this.mindMap.emit('node_icon_mouseenter', this, item, e, node)
    })
    node.on('mouseleave', e => {
      this.mindMap.emit('node_icon_mouseleave', this, item, e, node)
    })
    return {
      node,
      width: iconSize,
      height: iconSize
    }
  })
}

// 创建富文本节点
function createRichTextNode(specifyText) {
  const hasCustomWidth = this.hasCustomWidth()
  let text =
    typeof specifyText === 'string' ? specifyText : this.getData('text')
  let { textAutoWrapWidth, emptyTextMeasureHeightText } = this.mindMap.opt
  textAutoWrapWidth = hasCustomWidth ? this.customTextWidth : textAutoWrapWidth
  const g = new G()
  // 创建富文本结构，或复位富文本样式
  let recoverText = false
  const hasCollabAuthority = !!this.mindMap.cooperate?.collabV2Adapter
  if (this.getData('resetRichText')) {
    if (!hasCollabAuthority) delete this.nodeData.data.resetRichText
    recoverText = true
  }
  if (recoverText && !isUndef(text)) {
    // Prefer regex over checkIsRichText() — that helper writes innerHTML per call.
    const looksHtml = /<[a-z][\s\S]*?>/i.test(String(text))
    if (looksHtml) {
      const keepInline =
        /<(strong|em|u|s|span)\b/i.test(text) ||
        /style\s*=/i.test(text) ||
        /ql-formula/i.test(text)
      if (!keepInline) {
        text = removeRichTextStyes(text)
      }
    } else {
      // 非富文本则改为富文本结构
      text = `<p>${text}</p>`
    }
    // resetRichText is render-time normalization. Going through setData here
    // executes a command for every node and repeatedly schedules a full-tree
    // history snapshot while a large tree is still being created (O(n^2)).
    // Keep the normalized value on the authoritative node data; real user
    // edits still use SET_NODE_TEXT and retain their normal history entry.
    if (!this.nodeData.data) this.nodeData.data = {}
    // Collaborative node data belongs to the committed model. Rendering a
    // plain value as HTML must not manufacture an unrelated text mutation.
    if (!hasCollabAuthority) this.nodeData.data.text = text
  }
  // 节点的富文本样式数据
  const nodeTextStyleList = []
  const nodeRichTextStyles = getNodeRichTextStyles(this)
  Object.keys(nodeRichTextStyles).forEach(prop => {
    nodeTextStyleList.push([prop, nodeRichTextStyles[prop]])
  })
  const styleCacheKey = nodeTextStyleList
    .map(([prop, value]) => prop + ':' + value)
    .join('|')
  const measureCache = getRichTextMeasureCache(this.mindMap)
  const measureKey =
    styleCacheKey +
    '|' +
    textAutoWrapWidth +
    '|' +
    (hasCustomWidth ? this.customTextWidth : '') +
    '|' +
    text

  let width
  let height
  const cached = measureCache.get(measureKey)
  if (cached) {
    width = cached.width
    height = cached.height
  } else {
    const plain = tryPlainFromSimpleRichText(text)
    if (plain != null && !hasCustomWidth) {
      // Avoid write→read forced reflow for the common <p>plain</p> path.
      const measured = wrapPlainLines(
        plain,
        nodeRichTextStyles,
        textAutoWrapWidth
      )
      width = measured.width
      height = measured.height
    } else {
      // 测量文本大小（复杂 HTML 仍走 DOM）
      if (!this.mindMap.commonCaches.measureRichtextNodeTextSizeEl) {
        this.mindMap.commonCaches.measureRichtextNodeTextSizeEl =
          document.createElement('div')
        this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.position =
          'fixed'
        this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.left =
          '-999999px'
        this.mindMap.el.appendChild(
          this.mindMap.commonCaches.measureRichtextNodeTextSizeEl
        )
      }
      const measureDiv = this.mindMap.commonCaches.measureRichtextNodeTextSizeEl
      nodeTextStyleList.forEach(([prop, value]) => {
        measureDiv.style[prop] = value
      })
      measureDiv.style.lineHeight = 1.2
      const html = `<div>${text}</div>`
      measureDiv.innerHTML = html
      const measureEl = measureDiv.children[0]
      measureEl.classList.add('smm-richtext-node-wrap')
      addXmlns(measureEl)
      measureEl.style.maxWidth = textAutoWrapWidth + 'px'
      if (hasCustomWidth) {
        measureEl.style.width = this.customTextWidth + 'px'
      } else {
        measureEl.style.width = ''
      }
      let rect = measureEl.getBoundingClientRect()
      width = rect.width
      height = rect.height
      if (height <= 0) {
        measureDiv.innerHTML = `<p>${emptyTextMeasureHeightText}</p>`
        let elTmp = measureDiv.children[0]
        elTmp.classList.add('smm-richtext-node-wrap')
        height = elTmp.getBoundingClientRect().height
        measureDiv.innerHTML = html
      }
      width = Math.min(Math.ceil(width) + 1, textAutoWrapWidth)
      height = Math.ceil(height)
    }
    measureCache.set(measureKey, { width, height })
  }

  // Build display foreignObject without a second layout-read.
  let el
  const plainForDom = tryPlainFromSimpleRichText(text)
  if (plainForDom != null) {
    el = document.createElement('div')
    el.classList.add('smm-richtext-node-wrap')
    addXmlns(el)
    el.style.maxWidth = textAutoWrapWidth + 'px'
    if (hasCustomWidth) {
      el.style.width = this.customTextWidth + 'px'
    }
    const p = document.createElement('p')
    p.style.margin = '0'
    p.style.padding = '0'
    p.style.lineHeight = '1.2'
    p.textContent = plainForDom
    el.appendChild(p)
    if (width >= textAutoWrapWidth * 0.6) {
      const domBox = readRichTextDomBox(this.mindMap, el)
      if (domBox && domBox.height > height + 1) {
        width = Math.min(Math.ceil(domBox.width) || width, textAutoWrapWidth)
        height = Math.ceil(domBox.height)
        measureCache.set(measureKey, { width, height })
      }
    }
  } else {
    if (!this.mindMap.commonCaches.measureRichtextNodeTextSizeEl) {
      this.mindMap.commonCaches.measureRichtextNodeTextSizeEl =
        document.createElement('div')
      this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.position =
        'fixed'
      this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.left =
        '-999999px'
      this.mindMap.el.appendChild(
        this.mindMap.commonCaches.measureRichtextNodeTextSizeEl
      )
    }
    const div = this.mindMap.commonCaches.measureRichtextNodeTextSizeEl
    nodeTextStyleList.forEach(([prop, value]) => {
      div.style[prop] = value
    })
    div.style.lineHeight = 1.2
    div.innerHTML = `<div>${text}</div>`
    el = div.children[0]
    el.classList.add('smm-richtext-node-wrap')
    addXmlns(el)
    el.style.maxWidth = textAutoWrapWidth + 'px'
    if (hasCustomWidth) {
      el.style.width = this.customTextWidth + 'px'
    } else {
      el.style.width = ''
    }
  }
  g.attr('data-width', width)
  g.attr('data-height', height)
  const foreignObject = createForeignObjectNode({
    el,
    width,
    height
  })
  // 应用节点文本样式
  // 进入文本编辑时，这个样式也会同样添加到文本编辑框的元素上
  const foreignObjectStyle = {
    'line-height': 1.2
  }
  nodeTextStyleList.forEach(([prop, value]) => {
    foreignObjectStyle[camelCaseToHyphen(prop)] = value
  })
  foreignObject.css(foreignObjectStyle)
  g.add(foreignObject)
  return {
    node: g,
    nodeContent: foreignObject,
    width,
    height
  }
}

//  创建文本节点
function createTextNode(specifyText) {
  if (this.getData('needUpdate')) {
    delete this.nodeData.data.needUpdate
  }
  // 如果是富文本内容，那么转给富文本函数
  const rawText =
    typeof specifyText === 'string' ? specifyText : this.getData('text')
  if (
    this.getData('richText') ||
    /<\/?[a-z][\s\S]*>/i.test(String(rawText || ''))
  ) {
    return this.createRichTextNode(specifyText)
  }
  const text =
    typeof specifyText === 'string' ? specifyText : this.getData('text')
  if (this.getData('resetRichText')) {
    delete this.nodeData.data.resetRichText
  }
  const g = new G()
  const fontSize = this.getStyle('fontSize', false)
  const textAlign = this.getStyle('textAlign', false)
  // 文本超长自动换行
  let textArr = []
  if (!isUndef(text)) {
    textArr = String(text).split(/\n/gim)
  }
  const { textAutoWrapWidth, emptyTextMeasureHeightText } = this.mindMap.opt
  const hasCustomWidth = this.hasCustomWidth()
  const maxWidth = hasCustomWidth ? this.customTextWidth : textAutoWrapWidth
  let isMultiLine = textArr.length > 1
  textArr = wrapPlainParagraphs(textArr, maxWidth, this)
  if (textArr.some(item => String(item).includes('\n'))) isMultiLine = true
  textArr = textArr.join('\n').replace(/\n$/g, '').split(/\n/gim)
  textArr.forEach((item, index) => {
    // 避免尾部的空行不占宽度
    // 同时解决该问题：https://github.com/wanglin2/mind-map/issues/1037
    if (item === '') {
      item = '﻿'
    }
    const node = new Text().text(item)
    node.addClass('smm-text-node-wrap')
    node.attr(
      'text-anchor',
      {
        left: 'start',
        center: 'middle',
        right: 'end'
      }[textAlign] || 'start'
    )
    this.style.text(node)
    node.y(
      fontSize * noneRichTextNodeLineHeight * index +
        ((noneRichTextNodeLineHeight - 1) * fontSize) / 2
    )
    g.add(node)
  })
  let { width, height } = g.bbox()
  // 如果文本为空，那么需要计算一个默认高度
  if (height <= 0) {
    const tmpNode = new Text().text(emptyTextMeasureHeightText)
    this.style.text(tmpNode)
    const tmpBbox = tmpNode.bbox()
    height = tmpBbox.height
  }
  width = hasCustomWidth ? maxWidth : Math.min(Math.ceil(width), maxWidth)
  height = Math.ceil(height)
  g.attr('data-width', width)
  g.attr('data-height', height)
  g.attr('data-ismultiLine', isMultiLine || textArr.length > 1)
  return {
    node: g,
    width,
    height
  }
}

function hyperlinkHoverLabel(hyperlink, hyperlinkTitle) {
  const title = String(hyperlinkTitle || '').trim()
  const url = String(hyperlink || '').trim()
  return { title, url, text: title || url }
}

function ensureHyperlinkTip(mindMap) {
  if (this.hyperlinkTipEl) return this.hyperlinkTipEl
  const tip = document.createElement('div')
  tip.className = 'smm-hyperlink-tip'
  tip.style.cssText = `
    position: fixed;
    max-width: 280px;
    padding: 8px 10px;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(16, 24, 40, 0.16);
    display: none;
    z-index: ${mindMap.opt.nodeNoteTooltipZIndex};
    pointer-events: none;
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
  `
  const nameEl = document.createElement('div')
  const urlEl = document.createElement('div')
  urlEl.style.marginTop = '2px'
  tip.appendChild(nameEl)
  tip.appendChild(urlEl)
  tip._nameEl = nameEl
  tip._urlEl = urlEl
  const targetNode = mindMap.opt.customInnerElsAppendTo || document.body
  targetNode.appendChild(tip)
  this.hyperlinkTipEl = tip
  return tip
}

function showHyperlinkTip(anchor) {
  const { hyperlink, hyperlinkTitle } = this.getData()
  const label = hyperlinkHoverLabel(hyperlink, hyperlinkTitle)
  if (!label.text) return
  const tip = ensureHyperlinkTip.call(this, this.mindMap)
  const dark = document.body && document.body.classList.contains('isDark')
  tip.style.background = dark ? '#262a2e' : '#fff'
  tip.style.color = dark ? 'rgba(255, 255, 255, 0.92)' : '#1a1a1a'
  tip.style.border = dark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(16, 24, 40, 0.08)'
  tip._nameEl.textContent = label.title || label.url
  tip._nameEl.style.fontWeight = label.title ? '600' : '400'
  if (label.title && label.url && label.title !== label.url) {
    tip._urlEl.textContent = label.url
    tip._urlEl.style.display = 'block'
    tip._urlEl.style.color = dark ? 'rgba(255, 255, 255, 0.55)' : '#667085'
  } else {
    tip._urlEl.textContent = ''
    tip._urlEl.style.display = 'none'
  }
  const rect = anchor.node.getBoundingClientRect()
  tip.style.display = 'block'
  const tipRect = tip.getBoundingClientRect()
  let left = rect.left
  let top = rect.bottom + 6
  if (left + tipRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - tipRect.width - 8)
  }
  if (top + tipRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - tipRect.height - 6)
  }
  tip.style.left = left + 'px'
  tip.style.top = top + 'px'
}

function hideHyperlinkTip() {
  if (this.hyperlinkTipEl) this.hyperlinkTipEl.style.display = 'none'
}

//  创建超链接节点
function createHyperlinkNode() {
  const { hyperlink, hyperlinkTitle } = this.getData()
  hideHyperlinkTip.call(this)
  if (!hyperlink) {
    return
  }
  const { customHyperlinkJump, hyperlinkIcon, hyperlinkClickMode } = this.mindMap.opt
  const { icon, style } = hyperlinkIcon
  const iconSize = this.getNodeIconSize('hyperlinkIcon')
  // 图标外留一圈透明命中区（chip），悬停时显示浅色底
  const chipPadding = Math.max(3, Math.round(iconSize * 0.2))
  const chipSize = iconSize + chipPadding * 2
  const node = new SVG().size(chipSize, chipSize)
  const dark =
    typeof document !== 'undefined' &&
    !!document.body &&
    document.body.classList.contains('isDark')
  // 默认透明，只在悬停时显示浅底；透明底仍作为点击区域
  const chipFill = 'rgba(0, 0, 0, 0)'
  const chipHoverFill = dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(16, 24, 40, 0.1)'
  // 超链接节点：保留 <a>，Ctrl/Cmd+点击或 open 模式下仍直接打开
  const a = new A().to(hyperlink).target('_blank')
  a.attr('rel', 'noopener noreferrer')
  a.css('cursor', 'pointer')
  a.node.addEventListener('click', e => {
    const action = resolveHyperlinkClick({
      mode: hyperlinkClickMode,
      event: e,
      customHyperlinkJump
    })
    if (action === 'native') return
    e.preventDefault()
    if (action === 'custom') {
      customHyperlinkJump(hyperlink, this)
      return
    }
    // popover：交给上层弹出“打开/复制/编辑/删除”操作条
    e.stopPropagation()
    hideHyperlinkTip.call(this)
    this.mindMap.emit(
      'node_hyperlinkClick',
      this,
      e,
      node.node.getBoundingClientRect()
    )
  })
  // 圆角底，同时作为鼠标区域
  const chip = a
    .rect(chipSize, chipSize)
    .radius(Math.round(chipSize / 4))
    .fill({ color: chipFill })
  chip.addClass('smm-hyperlink-chip')
  // 超链接图标
  const iconNode = SVG(icon || iconsSvg.hyperlink)
    .size(iconSize, iconSize)
    .move(chipPadding, chipPadding)
  this.style.iconNode(iconNode, style.color)
  if (!icon) {
    // 默认图标为描边样式
    iconNode.attr({ stroke: style.color || this.style.merge('color'), fill: 'none' })
  }
  a.add(iconNode)
  node.add(a)
  node.on('mouseenter', () => {
    chip.fill({ color: chipHoverFill })
    showHyperlinkTip.call(this, node)
  })
  node.on('mouseleave', () => {
    chip.fill({ color: chipFill })
    hideHyperlinkTip.call(this)
  })
  return {
    node,
    width: chipSize,
    height: chipSize
  }
}

function createMapRefNode() {
  const ref = mapRefUtil.normalizeMapRef(this.getData('mapRef'))
  if (!ref) return
  // 企业微信式文档图标（略大于普通链接标）
  const iconSize = Math.max(18, this.getNodeIconSize('hyperlinkIcon') + 4)
  const node = new SVG().size(iconSize, iconSize)
  const title = ref.nodeId
    ? `双击预览子脑图 ${ref.mapId} / ${ref.nodeId}`
    : `双击预览子脑图 ${ref.mapId}`
  node.add(SVG(`<title>${title}</title>`))
  node.rect(iconSize, iconSize).fill({ color: 'transparent' })
  const iconNode = SVG(iconsSvg.mapRef).size(iconSize, iconSize)
  node.add(iconNode)
  node.css('cursor', 'pointer')
  const emitOpen = e => {
    e.stopPropagation()
    e.preventDefault()
    this.mindMap.emit('map_ref_click', this, ref)
  }
  node.on('click', emitOpen)
  node.on('dblclick', emitOpen)
  return {
    node,
    width: iconSize,
    height: iconSize
  }
}

//  创建标签节点
function createTagNode() {
  const tagData = this.getData('tag')
  if (!tagData || tagData.length <= 0) {
    return []
  }
  let { maxTag, tagsColorMap } = this.mindMap.opt
  tagsColorMap = tagsColorMap || {}
  const nodes = []
  tagData.slice(0, maxTag).forEach((item, index) => {
    let str = ''
    let style = {
      ...defaultTagStyle
    }
    // 旧版只支持字符串类型
    if (typeof item === 'string') {
      str = item
    } else {
      // v0.10.3+版本支持对象类型
      str = item.text
      style = { ...defaultTagStyle, ...item.style }
    }
    // 是否手动设置了标签宽度
    const hasCustomWidth = typeof style.width !== 'undefined'
    // 创建容器节点
    const tag = new G()
    tag.on('click', () => {
      this.mindMap.emit('node_tag_click', this, item, index, tag)
    })
    // 标签文本
    const text = new Text().text(str)
    this.style.tagText(text, style)
    // 获取文本宽高
    const { width: textWidth, height: textHeight } = text.bbox()
    // 矩形宽度
    const rectWidth = hasCustomWidth
      ? style.width
      : textWidth + style.paddingX * 2
    // 取文本和矩形最大宽高作为标签宽高
    const maxWidth = hasCustomWidth ? Math.max(rectWidth, textWidth) : rectWidth
    const maxHeight = Math.max(style.height, textHeight)
    // 文本居中
    if (hasCustomWidth) {
      text.x((maxWidth - textWidth) / 2)
    } else {
      text.x(hasCustomWidth ? 0 : style.paddingX)
    }
    text.cy(-maxHeight / 2)
    // 标签矩形
    const rect = new Rect().size(rectWidth, style.height).cy(-maxHeight / 2)
    if (hasCustomWidth) {
      rect.x((maxWidth - rectWidth) / 2)
    }
    this.style.tagRect(rect, {
      ...style,
      fill:
        style.fill || // 优先节点自身配置
        tagsColorMap[text.node.textContent] || // 否则尝试从实例化选项tagsColorMap映射中获取颜色
        generateColorByContent(text.node.textContent) // 否则按照标签内容生成
    })
    tag.add(rect).add(text)
    nodes.push({
      node: tag,
      width: maxWidth,
      height: maxHeight
    })
  })
  return nodes
}

//  创建备注节点
function createNoteNode() {
  if (!this.getData('note')) {
    return null
  }
  const { icon, style } = this.mindMap.opt.noteIcon
  const iconSize = this.getNodeIconSize('noteIcon')
  const node = new SVG()
    .attr('cursor', 'pointer')
    .addClass('smm-node-note')
    .size(iconSize, iconSize)
  // 透明的层，用来作为鼠标区域
  node.add(new Rect().size(iconSize, iconSize).fill({ color: 'transparent' }))
  // 备注图标
  const iconNode = SVG(icon || iconsSvg.note).size(iconSize, iconSize)
  this.style.iconNode(iconNode, style.color)
  node.add(iconNode)
  // 备注tooltip
  if (!this.mindMap.opt.customNoteContentShow) {
    if (!this.noteEl) {
      this.noteEl = document.createElement('div')
      this.noteEl.style.cssText = `
          position: fixed;
          padding: 10px;
          border-radius: 5px;
          box-shadow: 0 2px 5px rgb(0 0 0 / 10%);
          display: none;
          background-color: #fff;
          z-index: ${this.mindMap.opt.nodeNoteTooltipZIndex}
      `
      const targetNode =
        this.mindMap.opt.customInnerElsAppendTo || document.body
      targetNode.appendChild(this.noteEl)
    }
    this.noteEl.innerText = this.getData('note')
  }
  node.on('mouseover', () => {
    const { left, top } = this.getNoteContentPosition()
    if (!this.mindMap.opt.customNoteContentShow) {
      this.noteEl.style.left = left + 'px'
      this.noteEl.style.top = top + 'px'
      this.noteEl.style.display = 'block'
    } else {
      this.mindMap.opt.customNoteContentShow.show(
        this.getData('note'),
        left,
        top,
        this
      )
    }
  })
  node.on('mouseout', () => {
    if (!this.mindMap.opt.customNoteContentShow) {
      this.noteEl.style.display = 'none'
    } else {
      this.mindMap.opt.customNoteContentShow.hide()
    }
  })
  node.on('click', e => {
    this.mindMap.emit('node_note_click', this, e, node)
  })
  node.on('dblclick', e => {
    this.mindMap.emit('node_note_dblclick', this, e, node)
  })
  return {
    node,
    width: iconSize,
    height: iconSize
  }
}

let attachmentIconStyleInjected = false

function ensureAttachmentIconStyle() {
  if (attachmentIconStyleInjected || typeof document === 'undefined') return
  const head = document.head
  if (!head) return
  attachmentIconStyleInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-smm-attachment-icon', '1')
  style.textContent = `
.smm-attachment-progress.is-busy {
  transform-box: fill-box;
  transform-origin: center;
  animation: smm-attachment-spin 0.85s linear infinite;
}
@keyframes smm-attachment-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .smm-attachment-progress.is-busy { animation: none; }
}
`
  head.appendChild(style)
}

function applyAttachmentIconVisual(view, data) {
  if (!view) return
  const state = attachmentIconViewState(data)
  const phases = ['uploading', 'processing', 'ready', 'failed']
  phases.forEach(phase => {
    view.root[state.phase === phase ? 'addClass' : 'removeClass'](`is-${phase}`)
  })
  view.root.attr({
    'data-smm-attachment-state': state.phase,
    'data-smm-attachment-preview': state.previewable ? 'ready' : 'blocked',
    cursor: state.previewable || state.phase === 'failed' ? 'pointer' : 'progress'
  })
  if (view.icon) view.icon.opacity(state.iconOpacity)
  if (view.titleNode) {
    const titleEl = view.titleNode.node || view.titleNode
    if (titleEl) titleEl.textContent = state.title
  }
  const circumference = 2 * Math.PI * view.radius
  if (state.progressMode === 'none') {
    view.progress.hide()
  } else {
    view.progress.show()
    view.arc.stroke({ color: state.progressColor, linecap: 'round' })
    if (state.progressMode === 'determinate') {
      view.progress.removeClass('is-busy')
      view.arc.attr({
        'stroke-dasharray': String(circumference),
        'stroke-dashoffset': String(
          circumference * (1 - state.percent / 100)
        )
      })
    } else {
      view.progress.addClass('is-busy')
      view.arc.attr({
        'stroke-dasharray': `${circumference * 0.28} ${circumference}`,
        'stroke-dashoffset': '0'
      })
    }
  }
  if (view.percentText) {
    if (state.showPercent) {
      view.percentText.show()
      view.percentText.text(String(state.percent))
      view.percentText.fill(state.progressColor)
    } else {
      view.percentText.hide()
    }
  }
  if (state.badge) {
    view.badge.show()
    view.badgeCircle.fill({ color: state.badge.color })
    if (view.badgeGlyph) {
      view.badgeGlyph[state.badge.glyph === 'error' ? 'show' : 'hide']()
    }
  } else {
    view.badge.hide()
  }
}

//  创建附件节点
function createAttachmentNode() {
  const data = this.getData() || {}
  const { attachmentName, attachmentMimeType } = data
  // Server-managed attachments are identified by attachmentId and may not have
  // a public URL (for example, objects stored with a private ACL). Uploading
  // placeholders also render so progress can sit on the same icon.
  if (!hasAttachmentIcon(data)) {
    return
  }
  ensureAttachmentIconStyle()
  const iconSize = this.getNodeIconSize('attachmentIcon')
  const { icon, style } = this.mindMap.opt.attachmentIcon
  const node = new SVG().size(iconSize, iconSize)
  node.addClass('smm-attachment-icon')
  const titleNode = SVG(`<title></title>`)
  node.add(titleNode)
  // 透明的层，用来作为鼠标区域
  node.add(new Rect().size(iconSize, iconSize).fill({ color: 'transparent' }))
  // 自定义图标优先；未自定义时根据附件名称使用相应的文件类型图标。
  const iconSvg =
    icon || iconsSvg.getAttachmentFileIcon(attachmentName, attachmentMimeType)
  const iconNode = SVG(iconSvg).size(iconSize, iconSize)
  // 内置的彩色文件类型图标保留自身配色；只有用户自定义图标和无类型信息时的回形针图标跟随主题颜色。
  if (icon || iconSvg === iconsSvg.attachment) {
    this.style.iconNode(iconNode, style.color)
  }
  node.add(iconNode)

  const stroke = Math.max(2, iconSize * 0.16)
  const radius = Math.max(3, (iconSize - stroke) / 2)
  const cx = iconSize / 2
  const cy = iconSize / 2
  const progress = new G().addClass('smm-attachment-progress')
  const track = new Circle()
    .radius(radius)
    .cx(cx)
    .cy(cy)
    .fill('none')
    .stroke({ color: 'rgba(15, 23, 42, 0.16)', width: stroke })
  const arc = new Circle()
    .radius(radius)
    .cx(cx)
    .cy(cy)
    .fill('none')
    .stroke({ color: '#1677ff', width: stroke, linecap: 'round' })
  arc.attr({
    transform: `rotate(-90 ${cx} ${cy})`
  })
  progress.add(track).add(arc)
  node.add(progress)

  const percentText = new Text()
    .text('')
    .fill('#1677ff')
  percentText.font({
    size: Math.max(8, Math.round(iconSize * 0.42)),
    family: 'ui-sans-serif, system-ui, sans-serif',
    anchor: 'middle',
    weight: 700
  })
  percentText.attr({
    x: cx,
    y: cy,
    'dominant-baseline': 'central',
    'pointer-events': 'none'
  })
  percentText.addClass('smm-attachment-percent')
  node.add(percentText)

  // 角标完整画在图标框内（嵌套 svg 会裁剪溢出部分），失败时带白色感叹号。
  const badgeGeo = attachmentBadgeGeometry(iconSize)
  const badge = new G().addClass('smm-attachment-badge')
  const badgeCircle = new Circle()
    .radius(badgeGeo.r)
    .cx(badgeGeo.cx)
    .cy(badgeGeo.cy)
    .stroke({ color: '#fff', width: badgeGeo.ring })
  const badgeGlyph = new G().addClass('smm-attachment-badge-glyph')
  badgeGlyph.add(
    new Rect()
      .size(badgeGeo.bar.width, badgeGeo.bar.height)
      .move(badgeGeo.bar.x, badgeGeo.bar.y)
      .attr({ rx: badgeGeo.bar.width / 2 })
      .fill('#fff')
  )
  badgeGlyph.add(
    new Circle()
      .radius(badgeGeo.dot.r)
      .cx(badgeGeo.dot.cx)
      .cy(badgeGeo.dot.cy)
      .fill('#fff')
  )
  badge.add(badgeCircle)
  badge.add(badgeGlyph)
  badge.attr({ 'pointer-events': 'none' })
  node.add(badge)

  const view = {
    root: node,
    icon: iconNode,
    titleNode,
    progress,
    arc,
    percentText,
    badge,
    badgeCircle,
    badgeGlyph,
    radius
  }
  applyAttachmentIconVisual(view, data)

  node.on('click', e => {
    this.mindMap.emit('node_attachmentClick', this, e, node)
  })
  node.on('contextmenu', e => {
    this.mindMap.emit('node_attachmentContextmenu', this, e, node)
  })
  return {
    node,
    width: iconSize,
    height: iconSize,
    view
  }
}

const COMMENT_BUBBLE_ICON =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3.5c4.97 0 9 3.36 9 7.5s-4.03 7.5-9 7.5c-1.1 0-2.15-.16-3.12-.46L4 20l1.33-3.6C3.89 15.04 3 13.12 3 11c0-4.14 4.03-7.5 9-7.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'

function isDarkMode() {
  return (
    typeof document !== 'undefined' &&
    !!document.body &&
    document.body.classList.contains('isDark')
  )
}

//  评论标记数据：不占用文字行宽度，真正的图形在 layout 时画成右上角融合标签
function createCommentNode() {
  const data = this.getData() || {}
  const count = nodeCommentCount(data)
  if (!count) return
  const { isNodeCommentUnread } = this.mindMap.opt
  let unread = false
  if (typeof isNodeCommentUnread === 'function') {
    try {
      unread = !!isNodeCommentUnread(this)
    } catch (e) {
      unread = false
    }
  }
  const view = commentMarkerViewState({
    count,
    resolved: !!data.commentResolved,
    dark: isDarkMode(),
    unread
  })
  return { count, view, resolved: !!data.commentResolved, width: 0, height: 0 }
}

// 只有矩形（含圆角矩形）与节点边框融合，其他形状用悬浮标签
function commentTabCanMerge(node) {
  const shape = typeof node.getShape === 'function' ? node.getShape() : ''
  return !shape || shape === CONSTANTS.SHAPE.RECTANGLE
}

//  在节点右上角绘制评论标签，contentTop 为节点内容顶部（用于计算标签上抬高度）
function renderCommentTab(contentTop) {
  this._commentTab = null
  this._commentTabBorder = null
  const meta = this._commentData
  if (!meta || !this.group) return
  const { width, height } = this
  const borderWidth = this.getBorderWidth()
  const dark = isDarkMode()
  const merge = commentTabCanMerge(this)
  const geo = commentTabGeometry({
    width,
    height,
    borderWidth,
    borderRadius: Number(this.style.merge('borderRadius')) || 0,
    contentTop,
    iconSize: this.getNodeIconSize('hyperlinkIcon'),
    label: meta.view.label,
    merge
  })
  const colors = commentTabColors({
    fill: this.style.merge('fillColor'),
    border: this.style.merge('borderColor'),
    dark,
    resolved: meta.resolved
  })
  const tab = new G()
  tab.addClass('smm-comment-tab')
  tab.addClass('smm-comment-marker')
  tab.add(SVG(`<title>${meta.view.title}</title>`))
  tab.css('cursor', 'pointer')
  const fill = new Path().plot(geo.fillPath)
  fill.fill({ color: colors.tabFill }).stroke({ width: 0, color: 'none' })
  fill.addClass('smm-comment-tab-fill')
  tab.add(fill)
  if (geo.innerPath) {
    const inner = new Path().plot(geo.innerPath)
    inner.fill('none').stroke({ color: colors.innerLine, width: 1, linecap: 'round' })
    inner.attr({ 'pointer-events': 'none' })
    tab.add(inner)
  }
  // 外轮廓与节点边框同色同宽，选中时随节点一起高亮（见 updateNodeActiveClass）
  const border = new Path().plot(geo.outerPath)
  border.fill('none').stroke({
    color: borderWidth > 0 ? colors.border : colors.innerLine,
    width: borderWidth > 0 ? borderWidth : 1,
    linecap: 'round',
    linejoin: 'round'
  })
  border.attr({ 'pointer-events': 'none' })
  border.addClass('smm-comment-tab-border')
  tab.add(border)
  const iconNode = SVG(COMMENT_BUBBLE_ICON).size(geo.icon.size, geo.icon.size)
  iconNode.move(geo.icon.x, geo.icon.y)
  iconNode.css('color', colors.iconColor)
  iconNode.attr({ 'pointer-events': 'none' })
  tab.add(iconNode)
  const countText = new Text().text(meta.view.label).fill(colors.iconColor)
  countText.font({
    size: geo.text.size,
    family: 'ui-sans-serif, system-ui, sans-serif',
    weight: 600
  })
  countText.attr({
    x: geo.text.x,
    y: geo.text.y,
    'dominant-baseline': 'central',
    'pointer-events': 'none'
  })
  tab.add(countText)
  if (meta.view.unread) {
    const dot = new Circle()
      .radius(geo.dot.r)
      .cx(geo.dot.cx)
      .cy(geo.dot.cy)
      .fill(colors.dot)
      .stroke({ color: colors.dotRing, width: 1.5 })
    dot.addClass('smm-comment-unread')
    dot.attr({ 'pointer-events': 'none' })
    tab.add(dot)
  }
  // 透明命中区域：覆盖整个标签（含伸出节点顶部的部分）
  const hit = new Rect().size(geo.hit.w, geo.hit.h).move(geo.hit.x, geo.hit.y)
  hit.fill({ color: 'transparent' })
  hit.addClass('smm-comment-tab-hit')
  tab.add(hit)
  tab.on('mouseenter', () => fill.css('filter', 'brightness(1.12)'))
  tab.on('mouseleave', () => fill.css('filter', ''))
  tab.on('mousedown', e => e.stopPropagation())
  tab.on('dblclick', e => e.stopPropagation())
  tab.on('click', e => {
    e.stopPropagation()
    this.mindMap.emit('node_commentClick', this, e, tab.node.getBoundingClientRect())
  })
  this.group.add(tab)
  this._commentTab = tab
  this._commentTabBorder = border
  this._commentTabGeometry = geo
  return tab
}

function updateAttachmentIconState() {
  const view = this._attachmentData && this._attachmentData.view
  if (!view) return
  applyAttachmentIconVisual(view, this.getData() || {})
}

// 获取节点图标大小
function getNodeIconSize(prop) {
  const { style } = this.mindMap.opt[prop]
  return isUndef(style.size) ? this.mindMap.themeConfig.iconSize : style.size
}

// 获取节点备注显示位置
function getNoteContentPosition() {
  const iconSize = this.getNodeIconSize('noteIcon')
  const { scaleY } = this.mindMap.view.getTransformData().transform
  const iconSizeAddScale = iconSize * scaleY
  let { left, top } = this._noteData.node.node.getBoundingClientRect()
  top += iconSizeAddScale
  return {
    left,
    top
  }
}

// 测量自定义节点内容元素的宽高
function measureCustomNodeContentSize(content) {
  if (!this.mindMap.commonCaches.measureCustomNodeContentSizeEl) {
    this.mindMap.commonCaches.measureCustomNodeContentSizeEl =
      document.createElement('div')
    this.mindMap.commonCaches.measureCustomNodeContentSizeEl.style.cssText = `
      position: fixed;
      left: -99999px;
      top: -99999px;
    `
    this.mindMap.el.appendChild(
      this.mindMap.commonCaches.measureCustomNodeContentSizeEl
    )
  }
  this.mindMap.commonCaches.measureCustomNodeContentSizeEl.innerHTML = ''
  this.mindMap.commonCaches.measureCustomNodeContentSizeEl.appendChild(content)
  let rect =
    this.mindMap.commonCaches.measureCustomNodeContentSizeEl.getBoundingClientRect()
  return {
    width: rect.width,
    height: rect.height
  }
}

// 是否使用的是自定义节点内容
function isUseCustomNodeContent() {
  return !!this._customNodeContent
}

export default {
  getImageUrl,
  createImgNode,
  getImgShowSize,
  createIconNode,
  createRichTextNode,
  createTextNode,
  createHyperlinkNode,
  createMapRefNode,
  createTagNode,
  createNoteNode,
  createAttachmentNode,
  createCommentNode,
  renderCommentTab,
  updateAttachmentIconState,
  getNoteContentPosition,
  getNodeIconSize,
  measureCustomNodeContentSize,
  isUseCustomNodeContent
}
