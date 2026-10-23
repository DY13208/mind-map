import merge from 'deepmerge'
import { readSmmClipboardHtml, nodesToTabOutline } from '../../utils/copyOutline'
import performanceObserver from '../../../bin/collabV2/performanceObserver'
import LogicalStructure from '../../layouts/LogicalStructure'
import CompactStructure from '../../layouts/CompactStructure'
import MindMap from '../../layouts/MindMap'
import CatalogOrganization from '../../layouts/CatalogOrganization'
import OrganizationStructure from '../../layouts/OrganizationStructure'
import Timeline from '../../layouts/Timeline'
import VerticalTimeline from '../../layouts/VerticalTimeline'
import Fishbone from '../../layouts/Fishbone'
import TextEdit from './TextEdit'
import ViewportIndex from '../../utils/viewportIndex'
import { walkLayoutInSlices, runWorkInSlices } from '../../utils/layoutSlices'
import {
  copyNodeTree,
  simpleDeepClone,
  walk,
  bfsWalk,
  loadImage,
  isUndef,
  getTopAncestorsFomNodeList,
  addDataToAppointNodes,
  createUidForAppointNodes,
  formatDataToArray,
  removeFromParentNodeData,
  detachNodeFromParent,
  createUid,
  getNodeDataIndex,
  getNodeIndexInNodeList,
  getNodeUid,
  setDataToClipboard,
  getDataFromClipboard,
  htmlEscape,
  parseAddGeneralizationNodeList,
  checkNodeListIsEqual,
  createSmmFormatData,
  checkSmmFormatData,
  checkIsNodeStyleDataKey,
  formatGetNodeGeneralization,
  sortNodeList,
  checkClipboardReadEnable,
  isNodeNotNeedRenderData
} from '../../utils'
import { shapeList } from './node/Shape'
import { lineStyleProps } from '../../theme/default'
import { CONSTANTS, ERROR_TYPES } from '../../constants/constant'
import { Polygon } from '@svgdotjs/svg.js'
import mapRefUtil from '../../utils/mapRef'
import collabPaste from '../../utils/collabPaste'
import { undoTrace, undoFullTreeForbidden } from '../../utils/collabTrace'
import {
  destroyStaleLayoutNodes,
  inspectLayoutRenderer
} from '../../utils/collabLayoutCleanup'
import historyClipboard from '../../utils/historyClipboard'
import remoteRenderScheduler from '../../utils/remoteRenderScheduler'
import edgeGeometryModule from '../../utils/edgeGeometry'
const edgeGeometry = edgeGeometryModule.boundsFromPath
  ? edgeGeometryModule
  : edgeGeometryModule.default

// 布局列表
const layouts = {
  // 逻辑结构图
  [CONSTANTS.LAYOUT.LOGICAL_STRUCTURE]: LogicalStructure,
  // 向左逻辑结构图
  [CONSTANTS.LAYOUT.LOGICAL_STRUCTURE_LEFT]: LogicalStructure,
  // 思维导图
  [CONSTANTS.LAYOUT.MIND_MAP]: MindMap,
  // 目录组织图
  [CONSTANTS.LAYOUT.CATALOG_ORGANIZATION]: CatalogOrganization,
  // 组织结构图
  [CONSTANTS.LAYOUT.ORGANIZATION_STRUCTURE]: OrganizationStructure,
  // 时间轴
  [CONSTANTS.LAYOUT.TIMELINE]: Timeline,
  // 时间轴2
  [CONSTANTS.LAYOUT.TIMELINE2]: Timeline,
  // 竖向时间轴
  [CONSTANTS.LAYOUT.VERTICAL_TIMELINE]: VerticalTimeline,
  // 竖向时间轴2
  [CONSTANTS.LAYOUT.VERTICAL_TIMELINE2]: VerticalTimeline,
  // 竖向时间轴3
  [CONSTANTS.LAYOUT.VERTICAL_TIMELINE3]: VerticalTimeline,
  // 鱼骨图
  [CONSTANTS.LAYOUT.FISHBONE]: Fishbone,
  // 鱼骨图2
  [CONSTANTS.LAYOUT.FISHBONE2]: Fishbone
}

const EXPAND_ALL_BATCH = 6
const EXPAND_ALL_PER_FRAME = 48
// Compact layout is super-linear. Around 300 visible nodes one pass was
// already about a second, and around 900 it froze the page for tens of seconds.
const COMPACT_VISIBLE_NODE_LIMIT = 250

function countVisibleLayoutNodes(tree) {
  if (!tree) return 0
  let count = 0
  const stack = [tree]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count += 1
    if (node.data && node.data.expand === false) continue
    const kids = node.children || []
    for (let i = 0; i < kids.length; i += 1) stack.push(kids[i])
  }
  return count
}

//  渲染
class Render {
  //  构造函数
  constructor(opt = {}) {
    this.opt = opt
    this.mindMap = opt.mindMap
    this.themeConfig = this.mindMap.themeConfig
    // 渲染树，操作过程中修改的都是这里的数据
    this.renderTree = this.mindMap.opt.data
      ? merge({}, this.mindMap.opt.data)
      : null
    // 是否重新渲染
    this.reRender = false
    // 是否正在渲染中
    this.isRendering = false
    // 是否存在等待渲染
    this.hasWaitRendering = false
    // 用于缓存节点
    this.nodeCache = {}
    this.lastNodeCache = {}
    // Only current model instances belong here; detached/retired generations
    // must never be returned to commands or selection caches.
    this.nodeIndex = new Map()
    this._nodeIndexRoot = null
    // 收集触发render的来源
    this.renderSourceList = []
    // 收集render的回调函数
    this.renderCallbackList = []
    // 当前激活的节点列表
    this.activeNodeList = []
    this._activeNodeIndexes = new Map()
    this._activeIndexList = this.activeNodeList
    this._activeIndexLength = 0
    // 防抖定时器
    this.emitNodeActiveEventTimer = null
    this.renderTimer = null
    this._remoteRenderBatchDepth = 0
    this._remoteRenderPending = false
    this._remoteRenderDirtyUids = new Set()
    this._remoteRenderScheduler = remoteRenderScheduler.createRemoteRenderScheduler({
      maxWaitMs: 50,
      isBackground: () =>
        typeof document !== 'undefined' && document.visibilityState === 'hidden',
      onFlush: () => {
        this._remoteRenderPending = false
        this._remoteRenderDirtyUids.clear()
        this._render()
      }
    })
    this._expandAllToken = 0
    this._renderGeneration = 0
    this._layoutSwitchCount = 0
    this._layoutRenderCount = 0
    this._lastLayoutName = ''
    // 根节点
    this.root = null
    // 文本编辑框，需要再bindEvent之前实例化，否则单击事件只能触发隐藏文本编辑框，而无法保存文本修改
    this.textEdit = new TextEdit(this)
    // 当前复制的数据
    this.beingCopyData = null
    // 节点高亮框
    this.highlightBoxNode = null
    this.highlightBoxNodeStyle = null
    this._pasteFromNativeEvent = false
    // 上一次节点激活数据
    this.lastActiveNodeList = []
    // 布局
    this.setLayout()
    // 绑定事件
    this.bindEvent()
    // 注册命令
    this.registerCommands()
    // 注册快捷键
    this.registerShortcutKeys()
  }

  //  设置布局结构
  setLayout() {
    if (this.isRendering || this.renderCallbackList.length) this.cancelRender()
    this._renderGeneration = (this._renderGeneration || 0) + 1
    this.isRendering = false
    this.hasWaitRendering = false
    clearTimeout(this.renderTimer)
    if (this.layout && this.layout.beforeChange) {
      this.layout.beforeChange()
    }
    this.cleanupLayoutRenderer()
    if (this.mindMap.opt.layout === CONSTANTS.LAYOUT.COMPACT_STRUCTURE) {
      this.mindMap.opt.layout = CONSTANTS.LAYOUT.LOGICAL_STRUCTURE
      this.mindMap.opt.compactLayout = true
    }
    const { layout } = this.mindMap.opt
    let L = layout === CONSTANTS.LAYOUT.LOGICAL_STRUCTURE &&
      this.mindMap.opt.compactLayout
      ? CompactStructure
      : layouts[layout] || this.mindMap[layout]
    if (!L) {
      L = layouts[CONSTANTS.LAYOUT.LOGICAL_STRUCTURE]
      this.mindMap.opt.layout = CONSTANTS.LAYOUT.LOGICAL_STRUCTURE
    }
    this.layout = new L(this, this.mindMap.opt.layout)
    this._compactDegraded = false
    this._layoutSwitchCount = (this._layoutSwitchCount || 0) + 1
    this._lastLayoutName = this.mindMap.opt.layout
  }

  // Large expanded maps keep the user's compact preference, but this render
  // uses the ordinary logical layout so the main thread does not freeze.
  applyCompactLayoutBudget() {
    const opt = this.mindMap && this.mindMap.opt
    if (!opt || opt.layout !== CONSTANTS.LAYOUT.LOGICAL_STRUCTURE) return
    if (!opt.compactLayout && !this._compactDegraded) return
    const visible = countVisibleLayoutNodes(this.renderTree)
    const over = visible > COMPACT_VISIBLE_NODE_LIMIT
    if (over && this.layout instanceof CompactStructure) {
      this.layout = new LogicalStructure(this, CONSTANTS.LAYOUT.LOGICAL_STRUCTURE)
      this._compactDegraded = true
    } else if (!over && this._compactDegraded && opt.compactLayout) {
      this.layout = new CompactStructure(this, CONSTANTS.LAYOUT.LOGICAL_STRUCTURE)
      this._compactDegraded = false
    }
  }

  cleanupLayoutRenderer() {
    const caches = [this.nodeCache, this.lastNodeCache]
    const seen = new Set()
    caches.forEach(cache => {
      Object.keys(cache || {}).forEach(uid => {
        const node = cache[uid]
        if (!node || seen.has(node)) return
        seen.add(node)
        if (typeof node.removeLine === 'function') node.removeLine()
        if (typeof node.removeGeneralization === 'function') {
          node.removeGeneralization()
        }
        node.needLayout = true
      })
    })
    if (this.layout && this.layout.lru && typeof this.layout.lru.clear === 'function') {
      this.layout.lru.clear()
    }
    if (this.mindMap && this.mindMap.lineDraw && this.mindMap.lineDraw.clear) {
      this.mindMap.lineDraw.clear()
    }
  }

  restoreActiveUids(uids = []) {
    if (!uids.length || typeof this.findNodeByUid !== 'function') return
    uids.forEach(uid => {
      const node = this.findNodeByUid(uid)
      if (node && typeof node.active === 'function') node.active()
    })
  }

  sweepOrphanNodeGroups() {
    const draw = this.mindMap && this.mindMap.nodeDraw
    if (!draw || typeof draw.children !== 'function') return
    const live = new Set()
    const liveLines = new Set()
    const seen = new Set()
    const collect = node => {
      if (!node || seen.has(node)) return
      seen.add(node)
      if (node.group) live.add(node.group)
      ;(node._lines || []).forEach(line => liveLines.add(line))
      ;(node.children || []).forEach(collect)
      ;(node._generalizationList || []).forEach(item => collect(item.generalizationNode))
    }
    Object.keys(this.nodeCache || {}).forEach(uid => {
      collect(this.nodeCache[uid])
    })
    const kids = draw.children()
    const list = kids && typeof kids.each === 'function' ? [] : Array.from(kids || [])
    if (kids && typeof kids.each === 'function') {
      kids.each(child => list.push(child))
    }
    list.forEach(child => {
      if (!child || live.has(child)) return
      if (typeof child.hasClass !== 'function' || !child.hasClass('smm-node')) {
        return
      }
      if (typeof child.remove === 'function') child.remove()
    })
    const lineDraw = this.mindMap.lineDraw
    if (lineDraw && typeof lineDraw.children === 'function') {
      Array.from(lineDraw.children()).forEach(line => {
        if (line.hasClass('smm-tree-connector') && !liveLines.has(line)) line.remove()
      })
    }
  }

  // 重新设置思维导图数据
  setData(data) {
    if (this._destroyed) return
    const cooperate = this.mindMap.cooperate
    if (cooperate && cooperate._v2UndoActive && !cooperate._v2UndoAllowReplace) {
      undoFullTreeForbidden('Render.setData', {
        duringUndo: true
      })
      return
    }
    if (cooperate && cooperate._v2MoveActive && !cooperate._v2MoveAllowReplace) {
      if (typeof cooperate.markMoveFullTreeForbidden === 'function') {
        cooperate.markMoveFullTreeForbidden('Render.setData')
      }
      return
    }
    this.cancelRender()
    this._viewportIndex = null
    this.renderTree = data || null
  }

  //   绑定事件
  bindEvent() {
    const {
      openPerformance,
      performanceConfig,
      openRealtimeRenderOnNodeTextEdit
    } = this.mindMap.opt
    // 画布点击事件清除当前激活节点列表
    this.mindMap.on('draw_click', e => {
      this.clearActiveNodeListOnDrawClick(e, 'click')
    })
    // 画布右键事件事件清除当前激活节点列表
    this.mindMap.on('contextmenu', e => {
      this.clearActiveNodeListOnDrawClick(e, 'contextmenu')
    })
    // 鼠标双击回到根节点
    this.mindMap.svg.on('dblclick', () => {
      if (!this.mindMap.opt.enableDblclickBackToRootNode) return
      this.setRootNodeCenter()
    })
    // 性能模式
    const paintView = () => {
      if (!this.renderTree) {
        return
      }
      if (this.root && this._viewportIndex && !this.isRendering) {
        this.mindMap.emit('node_tree_render_start')
        this.paintViewport().then(completed => {
          if (completed) this.mindMap.emit('node_tree_render_end', { reason: 'view', layoutEpoch: this._layoutEpoch || 0 })
        }).catch(error => this.mindMap.opt.errorHandler('render_error', error))
      }
    }
    const onViewDataChange = () => {
      if (this._viewRenderTimer || this._destroyed) return
      this._viewRenderTimer = setTimeout(() => {
        this._viewRenderTimer = null
        if (!this._destroyed) paintView()
      }, performanceConfig.time)
    }
    if (openPerformance) {
      this.mindMap.on('view_data_change', onViewDataChange)
    }
    // 文本编辑时实时更新节点大小
    const textEditChange = this.onNodeTextEditChange.bind(this)
    this.onNodeTextEditChange = data => {
      clearTimeout(this._nodeTextEditChangeTimer)
      if (this._destroyed) return
      this._nodeTextEditChangeTimer = setTimeout(() => {
        this._nodeTextEditChangeTimer = null
        if (!this._destroyed) textEditChange(data)
      }, 100)
    }
    if (openRealtimeRenderOnNodeTextEdit) {
      this.mindMap.on('node_text_edit_change', this.onNodeTextEditChange)
    }
    // 监听配置改变事件
    this.mindMap.on('after_update_config', (opt, lastOpt) => {
      // 更新openPerformance配置
      if (opt.openPerformance !== lastOpt.openPerformance) {
        this.mindMap[opt.openPerformance ? 'on' : 'off'](
          'view_data_change',
          onViewDataChange
        )
        this.forceLoadNode()
      }
      // 更新openRealtimeRenderOnNodeTextEdit配置
      if (
        opt.openRealtimeRenderOnNodeTextEdit !==
        lastOpt.openRealtimeRenderOnNodeTextEdit
      ) {
        this.mindMap[opt.openRealtimeRenderOnNodeTextEdit ? 'on' : 'off'](
          'node_text_edit_change',
          this.onNodeTextEditChange
        )
      }
    })
    // 用原生 paste 事件读取剪贴板：HTTP 局域网下 clipboard.read 不可用；
    // 点击 SVG 节点后焦点不在 body 时，Control+v 快捷键也不会触发。
    // 输入框 / 节点文本编辑中不拦截。
    this.handlePaste = this.handlePaste.bind(this)
    window.addEventListener('paste', this.handlePaste)
    this.mindMap.on('beforeDestroy', () => {
      window.removeEventListener('paste', this.handlePaste)
    })
  }

  // 监听文本编辑事件，实时更新节点大小
  onNodeTextEditChange({ node, text }) {
    node._textData = node.createTextNode(text)
    const { width, height } = node.getNodeRect()
    node.width = width
    node.height = height
    node.layout()
    this.mindMap.render(() => {
      this.textEdit.updateTextEditNode()
    })
  }

  // 强制渲染节点，不考虑是否在画布可视区域内
  forceLoadNode(node) {
    node = node || this.root
    if (node) {
      this.mindMap.emit('node_tree_render_start')
      node.render(() => {
        if (this.mindMap.opt.openPerformance) this.buildViewportIndex()
        this.mindMap.emit('node_tree_render_end', { reason: 'export', layoutEpoch: this._layoutEpoch || 0 })
      }, true)
    }
  }

  //  注册命令
  registerCommands() {
    // 全选
    this.selectAll = this.selectAll.bind(this)
    this.mindMap.command.add('SELECT_ALL', this.selectAll)
    // 回退
    this.back = this.back.bind(this)
    this.mindMap.command.add('BACK', this.back)
    // 前进
    this.forward = this.forward.bind(this)
    this.mindMap.command.add('FORWARD', this.forward)
    // 插入同级节点
    this.insertNode = this.insertNode.bind(this)
    this.mindMap.command.add('INSERT_NODE', this.insertNode)
    // 插入多个同级节点
    this.insertMultiNode = this.insertMultiNode.bind(this)
    this.mindMap.command.add('INSERT_MULTI_NODE', this.insertMultiNode)
    // 插入子节点
    this.insertChildNode = this.insertChildNode.bind(this)
    this.mindMap.command.add('INSERT_CHILD_NODE', this.insertChildNode)
    // 插入多个子节点
    this.insertMultiChildNode = this.insertMultiChildNode.bind(this)
    this.mindMap.command.add(
      'INSERT_MULTI_CHILD_NODE',
      this.insertMultiChildNode
    )
    // 插入父节点
    this.insertParentNode = this.insertParentNode.bind(this)
    this.mindMap.command.add('INSERT_PARENT_NODE', this.insertParentNode)
    // 上移节点
    this.upNode = this.upNode.bind(this)
    this.mindMap.command.add('UP_NODE', this.upNode)
    // 下移节点
    this.downNode = this.downNode.bind(this)
    this.mindMap.command.add('DOWN_NODE', this.downNode)
    //  将一个节点上移一个层级
    this.moveUpOneLevel = this.moveUpOneLevel.bind(this)
    this.mindMap.command.add('MOVE_UP_ONE_LEVEL', this.moveUpOneLevel)
    // 移动节点
    this.insertAfter = this.insertAfter.bind(this)
    this.mindMap.command.add('INSERT_AFTER', this.insertAfter)
    this.insertBefore = this.insertBefore.bind(this)
    this.mindMap.command.add('INSERT_BEFORE', this.insertBefore)
    this.moveNodeTo = this.moveNodeTo.bind(this)
    this.mindMap.command.add('MOVE_NODE_TO', this.moveNodeTo)
    // 删除节点
    this.removeNode = this.removeNode.bind(this)
    this.mindMap.command.add('REMOVE_NODE', this.removeNode)
    // 仅删除当前节点
    this.removeCurrentNode = this.removeCurrentNode.bind(this)
    this.mindMap.command.add('REMOVE_CURRENT_NODE', this.removeCurrentNode)
    // 粘贴节点
    this.pasteNode = this.pasteNode.bind(this)
    this.mindMap.command.add('PASTE_NODE', this.pasteNode)
    // 剪切节点
    this.cutNode = this.cutNode.bind(this)
    this.mindMap.command.add('CUT_NODE', this.cutNode)
    // 修改节点单个样式
    this.setNodeStyle = this.setNodeStyle.bind(this)
    this.mindMap.command.add('SET_NODE_STYLE', this.setNodeStyle)
    // 修改节点多个样式
    this.setNodeStyles = this.setNodeStyles.bind(this)
    this.mindMap.command.add('SET_NODE_STYLES', this.setNodeStyles)
    // 切换节点是否激活
    this.setNodeActive = this.setNodeActive.bind(this)
    this.mindMap.command.add('SET_NODE_ACTIVE', this.setNodeActive)
    // 清除所有激活节点
    this.clearActiveNode = this.clearActiveNode.bind(this)
    this.mindMap.command.add('CLEAR_ACTIVE_NODE', this.clearActiveNode)
    // 切换节点是否展开
    this.setNodeExpand = this.setNodeExpand.bind(this)
    this.mindMap.command.add('SET_NODE_EXPAND', this.setNodeExpand)
    // 展开所有节点
    this.expandAllNode = this.expandAllNode.bind(this)
    this.mindMap.command.add('EXPAND_ALL', this.expandAllNode)
    // 收起所有节点
    this.unexpandAllNode = this.unexpandAllNode.bind(this)
    this.mindMap.command.add('UNEXPAND_ALL', this.unexpandAllNode)
    // 展开到指定层级
    this.expandToLevel = this.expandToLevel.bind(this)
    this.mindMap.command.add('UNEXPAND_TO_LEVEL', this.expandToLevel)
    // 设置节点数据
    this.setNodeData = this.setNodeData.bind(this)
    this.mindMap.command.add('SET_NODE_DATA', this.setNodeData)
    // 设置节点文本
    this.setNodeText = this.setNodeText.bind(this)
    this.mindMap.command.add('SET_NODE_TEXT', this.setNodeText)
    // 设置节点图片
    this.setNodeImage = this.setNodeImage.bind(this)
    this.mindMap.command.add('SET_NODE_IMAGE', this.setNodeImage)
    // 设置节点图标
    this.setNodeIcon = this.setNodeIcon.bind(this)
    this.mindMap.command.add('SET_NODE_ICON', this.setNodeIcon)
    // 设置节点超链接
    this.setNodeHyperlink = this.setNodeHyperlink.bind(this)
    this.mindMap.command.add('SET_NODE_HYPERLINK', this.setNodeHyperlink)
    this.setNodeMapRef = this.setNodeMapRef.bind(this)
    this.mindMap.command.add('SET_NODE_MAP_REF', this.setNodeMapRef)
    // 设置节点备注
    this.setNodeNote = this.setNodeNote.bind(this)
    this.mindMap.command.add('SET_NODE_NOTE', this.setNodeNote)
    // 设置节点评论
    this.setNodeComment = this.setNodeComment.bind(this)
    this.mindMap.command.add('SET_NODE_COMMENT', this.setNodeComment)
    // 设置节点附件
    this.setNodeAttachment = this.setNodeAttachment.bind(this)
    this.mindMap.command.add('SET_NODE_ATTACHMENT', this.setNodeAttachment)
    // 设置节点标签
    this.setNodeTag = this.setNodeTag.bind(this)
    this.mindMap.command.add('SET_NODE_TAG', this.setNodeTag)
    // 设置节点公式
    this.insertFormula = this.insertFormula.bind(this)
    this.mindMap.command.add('INSERT_FORMULA', this.insertFormula)
    // 添加节点概要
    this.addGeneralization = this.addGeneralization.bind(this)
    this.mindMap.command.add('ADD_GENERALIZATION', this.addGeneralization)
    // 删除节点概要
    this.removeGeneralization = this.removeGeneralization.bind(this)
    this.mindMap.command.add('REMOVE_GENERALIZATION', this.removeGeneralization)
    // 设置节点自定义位置
    this.setNodeCustomPosition = this.setNodeCustomPosition.bind(this)
    this.mindMap.command.add(
      'SET_NODE_CUSTOM_POSITION',
      this.setNodeCustomPosition
    )
    // 一键整理布局
    this.resetLayout = this.resetLayout.bind(this)
    this.mindMap.command.add('RESET_LAYOUT', this.resetLayout)
    // 设置节点形状
    this.setNodeShape = this.setNodeShape.bind(this)
    this.mindMap.command.add('SET_NODE_SHAPE', this.setNodeShape)
    // 定位节点
    this.goTargetNode = this.goTargetNode.bind(this)
    this.mindMap.command.add('GO_TARGET_NODE', this.goTargetNode)
    // 一键去除节点自定义样式
    this.removeCustomStyles = this.removeCustomStyles.bind(this)
    this.mindMap.command.add('REMOVE_CUSTOM_STYLES', this.removeCustomStyles)
    // 一键去除所有节点自定义样式
    this.removeAllNodeCustomStyles = this.removeAllNodeCustomStyles.bind(this)
    this.mindMap.command.add(
      'REMOVE_ALL_NODE_CUSTOM_STYLES',
      this.removeAllNodeCustomStyles
    )
  }

  //  注册快捷键
  registerShortcutKeys() {
    // 插入下级节点
    this.mindMap.keyCommand.addShortcut('Tab', () => {
      this.mindMap.execCommand('INSERT_CHILD_NODE')
    })
    // 插入下级节点
    this.mindMap.keyCommand.addShortcut('Insert', () => {
      this.mindMap.execCommand('INSERT_CHILD_NODE')
    })
    // 插入同级节点
    this.mindMap.keyCommand.addShortcut('Enter', () => {
      this.mindMap.execCommand('INSERT_NODE')
    })
    // 插入父节点
    this.mindMap.keyCommand.addShortcut('Shift+Tab', () => {
      this.mindMap.execCommand('INSERT_PARENT_NODE')
    })
    // 插入概要
    this.mindMap.keyCommand.addShortcut('Control+g', () => {
      this.mindMap.execCommand('ADD_GENERALIZATION')
    })
    // 展开/收起节点
    this.toggleActiveExpand = this.toggleActiveExpand.bind(this)
    this.mindMap.keyCommand.addShortcut('/', this.toggleActiveExpand)
    // 删除节点
    this.mindMap.keyCommand.addShortcut('Del|Backspace', () => {
      this.mindMap.execCommand('REMOVE_NODE')
    })
    // 仅删除当前节点
    this.mindMap.keyCommand.addShortcut('Shift+Backspace', () => {
      this.mindMap.execCommand('REMOVE_CURRENT_NODE')
    })
    // 节点编辑时某些快捷键会存在冲突，需要暂时去除
    this.mindMap.on('before_show_text_edit', () => {
      this.startTextEdit()
    })
    this.mindMap.on('hide_text_edit', () => {
      this.endTextEdit()
    })
    // 全选
    this.mindMap.keyCommand.addShortcut('Control+a', () => {
      this.mindMap.execCommand('SELECT_ALL')
    })
    // 一键整理布局
    this.mindMap.keyCommand.addShortcut('Control+l', () => {
      this.mindMap.execCommand('RESET_LAYOUT')
    })
    // 上移节点
    this.mindMap.keyCommand.addShortcut('Control+Up', () => {
      this.mindMap.execCommand('UP_NODE')
    })
    // 下移节点
    this.mindMap.keyCommand.addShortcut('Control+Down', () => {
      this.mindMap.execCommand('DOWN_NODE')
    })
    // 复制节点
    this.mindMap.keyCommand.addShortcut('Control+c', () => {
      this.copy()
    })
    // 剪切节点
    this.mindMap.keyCommand.addShortcut('Control+x', () => {
      this.cut()
    })
    // 粘贴节点。优先走原生 paste 事件（见 handlePaste），避免 HTTP 下读剪贴板失败、以及与 paste 重复插入。
    this.mindMap.keyCommand.addShortcut('Control+v', () => {
      setTimeout(() => {
        if (this._pasteFromNativeEvent) {
          this._pasteFromNativeEvent = false
          return
        }
        this.paste()
      }, 0)
    })
    // 根节点居中显示
    this.mindMap.keyCommand.addShortcut('Control+Enter', () => {
      this.setRootNodeCenter()
    })
  }

  // 派发节点激活事件
  emitNodeActiveEvent(node = null, activeNodeList = [...this.activeNodeList]) {
    const isChange = !checkNodeListIsEqual(
      this.lastActiveNodeList,
      activeNodeList
    )
    if (!isChange) return
    this.lastActiveNodeList = [...activeNodeList]
    clearTimeout(this.emitNodeActiveEventTimer)
    this.emitNodeActiveEventTimer = setTimeout(() => {
      this.mindMap.emit('node_active', node, activeNodeList)
    }, 0)
  }

  // 鼠标点击画布时清空当前激活节点列表
  clearActiveNodeListOnDrawClick(e, eventType) {
    if (this.activeNodeList.length <= 0) return
    // 清除激活状态
    let isTrueClick = true
    // 是否是左键多选节点，右键拖动画布
    const { useLeftKeySelectionRightKeyDrag } = this.mindMap.opt
    // 两种模式里右键都用来打开已框选节点的菜单，不能把选区清掉。
    if (eventType === 'contextmenu') {
      return
    }
    // 如果鼠标按下和松开的距离较大，则不认为是点击事件
    if (useLeftKeySelectionRightKeyDrag) {
      const mousedownPos = this.mindMap.event.mousedownPos
      isTrueClick =
        Math.abs(e.clientX - mousedownPos.x) <= 5 &&
        Math.abs(e.clientY - mousedownPos.y) <= 5
    }
    if (isTrueClick) {
      this.mindMap.execCommand('CLEAR_ACTIVE_NODE')
    }
  }

  //  开启文字编辑，会禁用回车键和删除键相关快捷键防止冲突
  startTextEdit() {
    this.mindMap.keyCommand.save()
  }

  //  结束文字编辑，会恢复回车键和删除键相关快捷键
  endTextEdit() {
    this.mindMap.keyCommand.restore()
  }

  // 清空节点缓存池
  clearCache() {
    this.layout.lru.clear()
    this.nodeCache = {}
    this.lastNodeCache = {}
    if (this.nodeIndex) this.nodeIndex.clear()
    this._nodeIndexRoot = null
  }

  // 保存触发渲染的参数
  addRenderParams(callback, source) {
    if (callback) {
      const index = this.renderCallbackList.findIndex(fn => {
        return fn === callback
      })
      if (index === -1) {
        this.renderCallbackList.push(callback)
      }
    }
    if (source) {
      const index = this.renderSourceList.findIndex(s => {
        return s === source
      })
      if (index === -1) {
        this.renderSourceList.push(source)
      }
    }
  }

  // 判断是否包含某种触发渲染源
  checkHasRenderSource(val) {
    val = Array.isArray(val) ? val : [val]
    for (let i = 0; i < this.renderSourceList.length; i++) {
      if (val.includes(this.renderSourceList[i])) {
        return true
      }
    }
    return false
  }

  cancelRender() {
    this._renderGeneration = (this._renderGeneration || 0) + 1
    clearTimeout(this.renderTimer)
    this.renderTimer = null
    if (this._remoteRenderScheduler) this._remoteRenderScheduler.cancel()
    this._remoteRenderPending = false
    if (this._remoteRenderDirtyUids) this._remoteRenderDirtyUids.clear()
    this._viewportPaintToken = (this._viewportPaintToken || 0) + 1
    this.isRendering = false
    this.hasWaitRendering = false
    this.renderCallbackList = []
    this.renderSourceList = []
    this.mindMap.emit('render_cancelled', { generation: this._renderGeneration })
  }

  // 渲染完毕的操作
  onRenderEnd() {
    const callbacks = this.renderCallbackList
    this.isRendering = false
    this.reRender = false
    this.renderCallbackList = []
    this.renderSourceList = []
    this.mindMap.emit('node_tree_render_end', { reason: 'layout', layoutEpoch: this._layoutEpoch || 0 })
    this.mindMap.emit('render_complete', {
      renderId: this._diagnosticRenderId,
      renderedNodes: Object.keys(this.nodeCache).length
    })
    callbacks.forEach(fn => fn())
  }

  // 渲染
  render(callback, source) {
    if (this._destroyed) return
    this.addRenderParams(callback, source)
    clearTimeout(this.renderTimer)
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this._render()
    }, 0)
  }

  beginRemoteRenderBatch() {
    this._remoteRenderBatchDepth = Number(this._remoteRenderBatchDepth || 0) + 1
  }

  endRemoteRenderBatch() {
    this._remoteRenderBatchDepth = Math.max(0, Number(this._remoteRenderBatchDepth || 0) - 1)
    if (this._remoteRenderBatchDepth || !this._remoteRenderPending) return
    this._remoteRenderPending = false
    const dirtyUids = Array.from(this._remoteRenderDirtyUids)
    this._remoteRenderDirtyUids.clear()
    this._remoteRenderScheduler.schedule(dirtyUids)
  }

  requestRemoteRender(uid, callback, source) {
    this.addRenderParams(callback, source)
    const uids = Array.isArray(uid) ? uid : uid == null ? [] : [uid]
    uids.forEach(item => {
      if (item != null && String(item)) this._remoteRenderDirtyUids.add(String(item))
    })
    this._remoteRenderPending = true
    if (this._remoteRenderBatchDepth) return
    this._remoteRenderPending = false
    const dirtyUids = Array.from(this._remoteRenderDirtyUids)
    this._remoteRenderDirtyUids.clear()
    this._remoteRenderScheduler.schedule(dirtyUids)
  }

  // 更新的渲染已经接管画布时，把这次中断的渲染让出去，避免位置一直停在重叠的旧布局上
  finishSupersededRender(generation = this._renderGeneration) {
    // Cancellation already released the old pass. Its delayed callback must
    // not release a newer pass that now owns the renderer state.
    if (this._destroyed || generation !== this._renderGeneration) return
    this.isRendering = false
    if (!this.hasWaitRendering) return
    this.hasWaitRendering = false
    this.render()
  }

  // 真正的渲染
  _render() {
    if (this._destroyed) return
    // 切换主题时，被收起的节点需要添加样式复位的标注
    if (this.checkHasRenderSource(CONSTANTS.CHANGE_THEME)) {
      this.resetUnExpandNodeStyle()
    }
    // 如果当前还没有渲染完毕，不再触发渲染
    if (this.isRendering) {
      // 等待当前渲染完毕后再进行一次渲染
      this.hasWaitRendering = true
      return
    }
    const syncPaint = !!this._syncPaintOnce
    this._syncPaintOnce = false
    const forceOverviewPaint = !!this._forceOverviewPaintOnce
    this._forceOverviewPaintOnce = false
    this.isRendering = true
    this._diagnosticRenderId = (this._diagnosticRenderId || 0) + 1
    this.mindMap.emit('render_started', { renderId: this._diagnosticRenderId })
    this._viewportPaintToken = (this._viewportPaintToken || 0) + 1
    this._viewportIndex = null
    const renderGeneration = this._renderGeneration
    const isLayoutSwitch = this.checkHasRenderSource(CONSTANTS.CHANGE_LAYOUT)
    if (isLayoutSwitch) {
      this._layoutRenderCount = (this._layoutRenderCount || 0) + 1
    }
    const activeUids = isLayoutSwitch
      ? (this.activeNodeList || [])
          .map(node => node && node.getData && node.getData('uid'))
          .filter(Boolean)
      : []
    // 节点缓存
    this.lastNodeCache = this.nodeCache
    this.nodeCache = {}
    // 重新渲染需要清除激活状态
    if (this.reRender) {
      this.clearActiveNodeList()
    }
    // 如果没有节点数据
    if (!this.renderTree) {
      this.onRenderEnd()
      return
    }
    this.mindMap.emit('node_tree_render_start')
    this.applyCompactLayoutBudget()
    // 计算布局
    this.root = null
    const layoutDiagnostic = performanceObserver.enabled()
    const layoutShape = layoutDiagnostic ? performanceObserver.treeShape(this.renderTree) : null
    const layoutStarted = layoutDiagnostic ? performance.now() : 0
    this.layout.doLayout(root => {
      if (layoutDiagnostic) performanceObserver.record('layout', {
        ...layoutShape,
        layout: this.layout instanceof CompactStructure ? 'compactStructure' : this.mindMap.opt.layout,
        compactPreference: this.mindMap.opt.compactLayout,
        elapsedMs: performance.now() - layoutStarted,
        superseded: renderGeneration !== this._renderGeneration
      })
      if (renderGeneration !== this._renderGeneration) {
        this.finishSupersededRender(renderGeneration)
        return
      }
      const stale = destroyStaleLayoutNodes(this.lastNodeCache, this.nodeCache)
      stale.destroyed.forEach(uid => {
        const prev = this.lastNodeCache[uid]
        if (prev) this.removeNodeFromActiveList(prev)
      })
      if (stale.destroyed.length) this.emitNodeActiveEvent()
      // 更新根节点
      this.root = root
      this._layoutEpoch = (this._layoutEpoch || 0) + 1
      this.rebuildNodeIndex()
      // Layout switch must paint synchronously so an in-flight performance
      // pass cannot leave the previous structure on the canvas.
      const asyncPaint =
        !!this.mindMap.opt.openPerformance && !isLayoutSwitch && !syncPaint
      this.paintLayoutTree(
        () => {
          if (renderGeneration !== this._renderGeneration) {
            this.finishSupersededRender(renderGeneration)
            return
          }
          this.isRendering = false
          if (this.hasWaitRendering) {
            this.hasWaitRendering = false
            this.render()
            return
          }
          this.sweepOrphanNodeGroups()
          if (isLayoutSwitch) {
            this.restoreActiveUids(activeUids)
            this._lastRenderWasLayoutSwitch = true
            inspectLayoutRenderer(
              this.mindMap,
              '',
              this.mindMap.opt && this.mindMap.opt.layout
            )
          } else {
            this._lastRenderWasLayoutSwitch = false
          }
          this.onRenderEnd()
        },
        isLayoutSwitch || forceOverviewPaint,
        asyncPaint
      )
    })
    this.emitNodeActiveEvent()
  }

  // Full layout paints use one budgeted DFS rather than a timer per child.
  // Explicit forceLoadNode/export keeps the existing synchronous full pass.
  isPerfFlag(name) {
    const flags = (this.mindMap.opt && this.mindMap.opt.performanceFlags) || {}
    return !!flags[name]
  }

  getViewportWorldRect() {
    const { transform } = this.mindMap.view.getTransformData()
    const padding =
      (this.mindMap.opt.performanceConfig &&
        this.mindMap.opt.performanceConfig.padding) ||
      0
    const sx = transform.scaleX || 1
    const sy = transform.scaleY || 1
    return {
      left: (-padding - transform.translateX) / sx,
      top: (-padding - transform.translateY) / sy,
      right: (this.mindMap.width + padding - transform.translateX) / sx,
      bottom: (this.mindMap.height + padding - transform.translateY) / sy
    }
  }

  nodeIntersectsViewport(node, viewport) {
    if (!node || !viewport) return false
    const left = node.left
    const top = node.top
    const right = left + (node.width || 0)
    const bottom = top + (node.height || 0)
    return (
      right >= viewport.left &&
      left <= viewport.right &&
      bottom >= viewport.top &&
      top <= viewport.bottom
    )
  }

  shouldPaintNodeNow(node, viewport, pinned) {
    if (!node || node.isRoot) return true
    if (pinned && pinned.has(node)) return true
    if (this.nodeIntersectsViewport(node, viewport)) return true
    if (node.parent && this.nodeIntersectsViewport(node.parent, viewport)) return true
    return false
  }

  rememberConnectorSpecs(node, refreshGeometry = false) {
    if (!node) return
    if (node.getData && node.getData('expand') === false) {
      if (refreshGeometry) node.removeLine()
      node._connectorSpecs = []
      return
    }
    // A structural edit can move a previously painted branch offscreen.
    // Skipping its node DOM must not let the viewport index reuse old paths.
    // Update existing connector slots only; unpainted branches still use
    // geometry specs without allocating offscreen SVG paths.
    if (refreshGeometry && (node._lines || []).length) node.renderLine()
    const live = node._lines || []
    if (live.length) {
      node._connectorSpecs = live
        .map(line => {
          const d =
            (line && line._smmPath) ||
            (line && line.node && line.node.getAttribute && line.node.getAttribute('d'))
          return d ? { d } : null
        })
        .filter(Boolean)
      return
    }
    if (!refreshGeometry && node._connectorSpecs && node._connectorSpecs.length) return
    const captured = edgeGeometry.captureNodeConnectors(node)
    node._connectorSpecs = captured.map(item => ({
      d: item.d,
      bounds: item.bounds
    }))
  }

  paintLayoutTree(callback, forceRender, asyncPaint) {
    const generation = this._renderGeneration
    const cancelled = () => this._destroyed || generation !== this._renderGeneration
    const done = async () => {
      if (cancelled()) return
      if (this.mindMap.opt.openPerformance) {
        if (!(await this.buildViewportIndex({ async: true, cancelled })) || cancelled()) return
        if (!forceRender && (!(await this.paintViewport()) || cancelled())) return
      }
      callback()
    }
    if (!asyncPaint) {
      this.root.render(() => { done().catch(error => this.mindMap.opt.errorHandler('render_error', error)) }, forceRender)
      return
    }
    // Skip is DOM-only. data.expand / personal view state are never written here.
    const lazy =
      !forceRender &&
      this.mindMap.opt.openPerformance &&
      this.isPerfFlag('lazyOffscreenPaint')
    const viewport = lazy ? this.getViewportWorldRect() : null
    const pinned = lazy ? this.collectPinnedViewportNodes() : null
    walkLayoutInSlices([this.root, null, node => {
      if (lazy && !this.shouldPaintNodeNow(node, viewport, pinned)) {
        this.rememberConnectorSpecs(node, true)
        return node.getData('expand') === false
      }
      node.render(() => {}, forceRender, false, true)
      return node.getData('expand') === false
    }, null, true], { cancelled }).then(completed => {
      if (completed && !cancelled()) return done()
    }).catch(error => this.mindMap.opt.errorHandler('render_error', error))
  }

  buildViewportIndex(options = {}) {
    const items = []
    const visibleNodes = new Set(), visibleEdges = new Set()
    if (!this._edgeBounds) this._edgeBounds = new WeakMap()
    const seen = new Set()
    const addEdge = element => {
      if (!element || seen.has(element)) return
      // Floating themes deliberately keep a hidden M0,0 model path. It is
      // not painted geometry and must not make every theme a pan candidate.
      if (element.style.display === 'none' || element.getAttribute('display') === 'none') return
      seen.add(element)
      const parent = element.parentNode || this.mindMap.lineDraw.node
      const strokeWidth = parseFloat(element.getAttribute('stroke-width') || parent.getAttribute('stroke-width') || '0') || 0
      const miterLimit = parseFloat(element.getAttribute('stroke-miterlimit') || '4') || 4
      const markers = [element.getAttribute('marker-start'), element.getAttribute('marker-end')]
      const d = element.getAttribute('d')
      // Compare the raw geometry inputs individually instead of allocating a
      // joined string per connector on every collect pass.
      const cached = this._edgeBounds.get(element)
      let bounds = cached && cached.d === d && cached.strokeWidth === strokeWidth &&
        cached.miterLimit === miterLimit && cached.markerStart === markers[0] && cached.markerEnd === markers[1]
        ? cached.bounds
        : null
      if (!bounds) {
        if (this.isPerfFlag('analyticEdgeBounds')) {
          bounds = edgeGeometry.boundsFromPathWithStroke(d, {
            strokeWidth,
            miterLimit,
            hasMarker: markers.some(Boolean)
          })
        }
        if (!bounds) {
          const rect = element.getBBox()
          // Native getBBox omits painted stroke and marker extents. Use a
          // conservative miter envelope and the built-in 20px marker reserve.
          const padding = Math.max(strokeWidth / 2 * Math.max(1, miterLimit), markers.some(Boolean) ? 20 : 0)
          bounds = { left: rect.x - padding, top: rect.y - padding,
            right: rect.x + rect.width + padding, bottom: rect.y + rect.height + padding }
        }
        this._edgeBounds.set(element, { d, strokeWidth, miterLimit, markerStart: markers[0], markerEnd: markers[1], bounds })
      }
      const item = { element, parent, bounds }
      items.push(item)
      if (element.isConnected) visibleEdges.add(item)
    }
    // The model owns detached paths. DOM enumeration alone loses them after
    // a local resize or a scoped explicit export refreshes the index.
    const collect = function * (renderer) {
      const nodes = renderer.nodeIndex ? renderer.nodeIndex.values() : Object.values(renderer.nodeCache)
      for (const node of nodes) {
        const { left, top, width, height } = node
        items.push({ node, bounds: { left, top, right: left + width, bottom: top + height } })
        if (node.group && node.group.node.parentNode) visibleNodes.add(node)
        yield
        const lines = node._lines || []
        if (lines.length) {
          for (const line of lines) { addEdge(line.node); yield }
        } else if (renderer.isPerfFlag('lazyOffscreenPaint')) {
          renderer.rememberConnectorSpecs(node)
          const parent = renderer.mindMap.lineDraw.node
          for (const spec of node._connectorSpecs || []) {
            const raw = spec.bounds || edgeGeometry.boundsFromPath(spec.d)
            const bounds = edgeGeometry.inflateBounds(raw, {
              strokeWidth: 1,
              miterLimit: 4,
              hasMarker: false
            })
            if (bounds) {
              items.push({
                element: null,
                parent,
                bounds,
                d: spec.d,
                sourceNode: node
              })
            }
            yield
          }
        }
        for (const item of node._generalizationList || []) {
          if (item.generalizationLine) addEdge(item.generalizationLine.node)
          yield
        }
      }
      for (const path of renderer.mindMap.lineDraw.node.querySelectorAll('path')) { addEdge(path); yield }
    }
    const publish = index => {
      if (!index || this._destroyed || (options.cancelled && options.cancelled())) return false
      this._viewportIndex = index
      this._visibleViewportNodes = visibleNodes
      this._visibleViewportEdges = visibleEdges
      return true
    }
    if (options.async) return (async () => {
      // collect() may call SVG getBBox (heavy step) so it keeps the per-step
      // clock; the packed index build batches only its own pure arithmetic
      // yields internally and is still bounded by the same slice budget.
      if (!(await runWorkInSlices(collect(this), options))) return false
      return publish(await ViewportIndex.create(items, options))
    })()
    const work = collect(this)
    while (!work.next().done) { /* Explicit export needs the complete scene now. */ }
    return publish(new ViewportIndex(items))
  }

  // 编辑中/已激活节点及其祖先：视口剔除时不得卸 DOM，否则会出现
  // 「数据还在、搜索能命中、画布空白，刷新才恢复」的假丢失。
  collectPinnedViewportNodes() {
    const pinned = new Set()
    const addWithAncestors = node => {
      let cur = node
      while (cur) {
        pinned.add(cur)
        cur = cur.parent || null
      }
    }
    ;(this.activeNodeList || []).forEach(addWithAncestors)
    if (
      this.textEdit &&
      typeof this.textEdit.isShowTextEdit === 'function' &&
      this.textEdit.isShowTextEdit() &&
      this.textEdit.currentNode
    ) {
      addWithAncestors(this.textEdit.currentNode)
    }
    const richText = this.mindMap && this.mindMap.richText
    if (richText && richText.showTextEdit && richText.node) {
      addWithAncestors(richText.node)
    }
    return pinned
  }

  getPinnedViewportNodesCached() {
    const gen = this._renderGeneration || 0
    if (this._pinnedViewportNodesGen === gen && this._pinnedViewportNodesCache) {
      return this._pinnedViewportNodesCache
    }
    this._pinnedViewportNodesGen = gen
    this._pinnedViewportNodesCache = this.collectPinnedViewportNodes()
    return this._pinnedViewportNodesCache
  }

  isNodeGroupAttached(node) {
    return !!(node && node.group && node.group.node && node.group.node.parentNode)
  }

  async paintViewport(changedNodes) {
    if (!this._viewportIndex || this._destroyed) return false
    const token = this._viewportPaintToken = (this._viewportPaintToken || 0) + 1
    const generation = this._renderGeneration
    const cancelled = () => this._destroyed || token !== this._viewportPaintToken || generation !== this._renderGeneration
    const { transform } = this.mindMap.view.getTransformData()
    const padding = this.mindMap.opt.performanceConfig.padding || 0
    const sx = transform.scaleX || 1, sy = transform.scaleY || 1
    const viewport = { left: (-padding - transform.translateX) / sx, top: (-padding - transform.translateY) / sy,
      right: (this.mindMap.width + padding - transform.translateX) / sx, bottom: (this.mindMap.height + padding - transform.translateY) / sy }
    const candidates = this._viewportIndex.query(viewport)
    const nodes = new Set(candidates.filter(item => item.node).map(item => item.node))
    nodes.add(this.root)
    // 视口重绘时必须用最新激活/编辑集；布局 DFS 里再用 generation 缓存
    this._pinnedViewportNodesCache = null
    const pinned = this.collectPinnedViewportNodes()
    this._pinnedViewportNodesGen = this._renderGeneration || 0
    this._pinnedViewportNodesCache = pinned
    pinned.forEach(node => nodes.add(node))
    const lazyPaint = this.isPerfFlag('lazyOffscreenPaint')
    const edges = new Set(candidates.filter(item => item.element || (lazyPaint && item.d)))
    const tasks = []
    ;(this._visibleViewportNodes || []).forEach(node => {
      if (!nodes.has(node) && !pinned.has(node)) tasks.push(() => {
        if (node.group) node.group.remove()
        this._visibleViewportNodes.delete(node)
      })
    })
    ;(this._visibleViewportEdges || []).forEach(item => {
      if (!edges.has(item)) tasks.push(() => {
        if (item.element) item.element.remove()
        this._visibleViewportEdges.delete(item)
      })
    })
    nodes.forEach(node => {
      // 已标记可见但 group 已被卸掉时必须补挂，否则会一直「搜得到却看不见」
      const attached = this.isNodeGroupAttached(node)
      if (
        changedNodes &&
        !changedNodes.has(node) &&
        this._visibleViewportNodes.has(node) &&
        attached
      ) {
        return
      }
      tasks.push(() => {
      // Flags off: keep the old skipLine=true path. Lazy paint must draw
      // outgoing lines on first mount because paintLayoutTree skipped them.
      const skipLine = !lazyPaint || attached
      node.render(() => {}, pinned.has(node), false, true, skipLine)
      this._visibleViewportNodes.add(node)
      })
    })
    edges.forEach(item => tasks.push(() => {
      if (lazyPaint && !item.element && item.sourceNode) {
        if (!(item.sourceNode._lines || []).length) item.sourceNode.renderLine()
        const match = (item.sourceNode._lines || []).find(line => {
          const d =
            (line && line._smmPath) ||
            (line && line.node && line.node.getAttribute && line.node.getAttribute('d'))
          return d === item.d
        })
        if (match) {
          item.element = match.node
          item.parent = this.mindMap.lineDraw.node
        }
      }
      if (item.element && item.parent && item.element.parentNode !== item.parent) {
        item.parent.appendChild(item.element)
      }
      if (item.element) this._visibleViewportEdges.add(item)
    }))
    // Update the actual attached sets per task. A superseding view must see
    // partial attachment, not the previous pass's not-yet-painted targets.
    return walkLayoutInSlices([{ children: tasks.map(run => ({ run })) }, null, task => {
      if (task.run) task.run()
    }, null, true], { cancelled })
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this.cancelRender()
    clearTimeout(this.emitNodeActiveEventTimer)
    this.emitNodeActiveEventTimer = null
    clearTimeout(this._viewRenderTimer)
    clearTimeout(this._nodeTextEditChangeTimer)
    this._viewRenderTimer = null
    this._nodeTextEditChangeTimer = null
    this.clearCache()
    this.layout.root = null
    Object.values(this.layout).forEach(value => { if (value instanceof Map || value instanceof Set) value.clear() })
    this._viewportIndex = null
    this._visibleViewportNodes = null
    this._visibleViewportEdges = null
    this._edgeBounds = null
    this.renderTree = null
    this.root = null
    this.beingCopyData = null
    this.activeNodeList = []
    this.lastActiveNodeList = []
    this._activeNodeIndexes.clear()
    this._activeIndexList = this.activeNodeList
    this._activeIndexLength = 0
    this._expandAllToken = 0
    this._expandOperationId = (this._expandOperationId || 0) + 1
    this._lazyCommandPending = false
  }

  // 当某个自定义节点内容改变后，可以调用该方法实时更新该节点大小和整体节点的定位
  renderByCustomNodeContentNode(node) {
    node.getSize()
    node.customNodeContentRealtimeLayout()
    this.mindMap.render()
  }

  // 给当前被收起来的节点数据添加更新标志
  resetUnExpandNodeStyle() {
    if (!this.renderTree) return
    walk(this.renderTree, null, node => {
      if (!node.data.expand) {
        walk(node, null, node2 => {
          // 主要是触发数据新旧对比，不一样则会重新创建节点
          node2.data['needUpdate'] = true
        })
        return true
      }
    })
  }

  //  清除当前所有激活节点，并会触发事件
  clearActiveNode() {
    if (this.activeNodeList.length <= 0) {
      return
    }
    this.clearActiveNodeList()
    this.emitNodeActiveEvent(null, [])
  }

  //  清除当前激活的节点列表
  clearActiveNodeList() {
    this.activeNodeList.forEach(item => {
      this.mindMap.execCommand('SET_NODE_ACTIVE', item, false)
    })
    this.activeNodeList = []
    this.syncActiveNodeIndexes()
  }

  // 添加节点到激活列表里
  addNodeToActiveList(node, notEmitBeforeNodeActiveEvent = false) {
    if (
      this.mindMap.opt.onlyOneEnableActiveNodeOnCooperate &&
      node.userList.some(item => item && item.editing)
    )
      return
    const index = this.findActiveNodeIndex(node)
    if (index === -1) {
      if (!notEmitBeforeNodeActiveEvent) {
        this.mindMap.emit('before_node_active', node, this.activeNodeList)
      }
      this.mindMap.execCommand('SET_NODE_ACTIVE', node, true)
      this.activeNodeList.push(node)
      this._activeNodeIndexes.set(getNodeUid(node), this.activeNodeList.length - 1)
      this._activeIndexLength = this.activeNodeList.length
    }
  }

  // 在激活列表里移除某个节点
  removeNodeFromActiveList(node) {
    let index = this.findActiveNodeIndex(node)
    if (index === -1) {
      return
    }
    this.mindMap.execCommand('SET_NODE_ACTIVE', node, false)
    this.activeNodeList.splice(index, 1)
    this._activeNodeIndexes.delete(getNodeUid(node))
    for (let i = index; i < this.activeNodeList.length; i++) {
      this._activeNodeIndexes.set(getNodeUid(this.activeNodeList[i]), i)
    }
    this._activeIndexLength = this.activeNodeList.length
  }

  // 手动激活多个节点，激活单个节点请直接调用节点实例的active()方法
  activeMultiNode(nodeList = []) {
    nodeList.forEach(node => {
      // 手动派发节点激活前事件
      this.mindMap.emit('before_node_active', node, this.activeNodeList)
      // 激活节点，并将该节点添加到激活节点列表里
      this.addNodeToActiveList(node, true)
    })
    this.emitNodeActiveEvent(nodeList[nodeList.length - 1] || null)
  }

  // 手动取消激活多个节点
  cancelActiveMultiNode(nodeList = []) {
    const cancelledUids = new Set(nodeList.map(getNodeUid))
    this.activeNodeList = this.activeNodeList.filter(node => {
      if (!cancelledUids.has(getNodeUid(node))) return true
      this.mindMap.execCommand('SET_NODE_ACTIVE', node, false)
      return false
    })
    this.syncActiveNodeIndexes()
    this.emitNodeActiveEvent(null)
  }

  syncActiveNodeIndexes() {
    const list = this.activeNodeList || []
    if (this._activeIndexList === list && this._activeIndexLength === list.length && this._activeNodeIndexes) return
    this._activeNodeIndexes = new Map()
    list.forEach((node, index) => this._activeNodeIndexes.set(getNodeUid(node), index))
    this._activeIndexList = list
    this._activeIndexLength = list.length
  }

  //  检索某个节点在激活列表里的索引
  findActiveNodeIndex(node) {
    this.syncActiveNodeIndexes()
    const index = this._activeNodeIndexes.get(getNodeUid(node))
    return index === undefined ? -1 : index
  }

  //  全选
  selectAll() {
    if (this.mindMap.opt.readonly) return
    walk(
      this.root,
      null,
      node => {
        if (!node.getData('isActive')) {
          this.addNodeToActiveList(node)
        }
        // 概要节点及其子树
        if (node._generalizationList && node._generalizationList.length > 0) {
          node._generalizationList.forEach(item => {
            const addTree = gNode => {
              if (!gNode) return
              if (!gNode.getData('isActive')) {
                this.addNodeToActiveList(gNode)
              }
              ;(gNode.children || []).forEach(addTree)
              // 概要子树里的节点还能再挂概要
              ;(gNode._generalizationList || []).forEach(sub => {
                addTree(sub && sub.generalizationNode)
              })
            }
            addTree(item.generalizationNode)
          })
        }
      },
      null,
      true,
      0,
      0
    )
    this.emitNodeActiveEvent()
  }

  //  回退
  back(step) {
    this.backForward('back', step)
  }

  //  前进
  forward(step) {
    this.backForward('forward', step)
  }

  // 前进回退
  backForward(type, step) {
    const cooperate = this.mindMap.cooperate
    const v2 = !!(cooperate && cooperate.collabV2Adapter)
    undoTrace('render.backForward', {
      type,
      step,
      v2,
      authority: v2 ? 'v2-adapter' : 'native-history'
    })
    if (v2) {
      undoTrace('render.skip-native-restore', {
        type,
        reason: 'COLLAB_V2 undo authority'
      })
      return
    }
    this.mindMap.execCommand('CLEAR_ACTIVE_NODE')
    const data = this.mindMap.command[type](step)
    if (data) {
      if (cooperate && typeof cooperate.sanitizeHistoryTree === 'function') {
        cooperate.sanitizeHistoryTree(data)
      }
      this.renderTree = data
      this.mindMap.render()
    }
    this.mindMap.emit('data_change', data)
  }

  // 获取创建新节点的行为
  getNewNodeBehavior(openEdit = false, handleMultiNodes = false) {
    const { createNewNodeBehavior } = this.mindMap.opt
    let focusNewNode = false // 是否激活新节点
    let inserting = false // 新节点是否进入编辑模式
    switch (createNewNodeBehavior) {
      // 默认会激活新创建的节点，并且进入编辑模式。如果同时创建了多个新节点，那么只会激活而不会进入编辑模式
      case CONSTANTS.CREATE_NEW_NODE_BEHAVIOR.DEFAULT:
        focusNewNode = handleMultiNodes || !openEdit
        inserting = handleMultiNodes ? false : openEdit // 如果同时对多个节点插入子节点，那么无需进入编辑模式
        break
      // 不激活新创建的节点
      case CONSTANTS.CREATE_NEW_NODE_BEHAVIOR.NOT_ACTIVE:
        focusNewNode = false
        inserting = false
        break
      // 只激活新创建的节点，不进入编辑模式
      case CONSTANTS.CREATE_NEW_NODE_BEHAVIOR.ACTIVE_ONLY:
        focusNewNode = true
        inserting = false
        break
      default:
        break
    }
    return {
      focusNewNode,
      inserting
    }
  }

  runAfterHydrate(nodes, fn, commandName) {
    if (this._destroyed) return true
    const cooperate = this.mindMap.cooperate
    if (
      this._skipLazyHydrate ||
      !cooperate ||
      typeof cooperate.nodeNeedsHydrate !== 'function'
    ) {
      return false
    }
    const stubs = (nodes || []).filter(node => cooperate.nodeNeedsHydrate(node))
    if (!stubs.length) return false
    const command = this.mindMap.command
    if (command) command.pause()
    this._lazyCommandPending = true
    // Wait for full hydrate — do not race a timeout (partial tree must not edit).
    const hydrate = Promise.all(
      stubs.map(node =>
        Promise.resolve(
          typeof cooperate.ensurePlacementParent === 'function'
            ? cooperate.ensurePlacementParent(node)
            : cooperate.hydrateLazyChildren(node)
        ).catch(err => {
          console.error('[mind-map] load children failed', err)
        })
      )
    )
    hydrate
      .then(() => {
        if (this._destroyed) return
        this._skipLazyHydrate = true
        this._lazyCommandPending = false
        try {
          fn()
        } finally {
          this._skipLazyHydrate = false
        }
        if (command && command.isPause) {
          command.recovery()
          command.addHistory()
        }
        if (
          commandName &&
          cooperate.httpCollabMode &&
          typeof cooperate.onHttpCommand === 'function'
        ) {
          cooperate.onHttpCommand(commandName)
        }
      })
      .catch(err => {
        if (this._destroyed) return
        this._lazyCommandPending = false
        this._skipLazyHydrate = false
        if (command && command.isPause) command.recovery()
        console.error('[mind-map] placement hydrate failed', err)
      })
    return true
  }

  // Tab 和 Enter 共用子节点写入逻辑；index 未指定时追加到末尾。
  insertChildNodeData(parent, newNode, index) {
    if (!parent.nodeData.children) parent.nodeData.children = []
    const children = parent.nodeData.children
    if (index === undefined) children.push(newNode)
    else children.splice(index, 0, newNode)
    this.mindMap.command.recordContentChange?.({
      added: [newNode],
      countable: this.mindMap.command.isCountableNode(parent)
    })
    const prev = Number(parent.getData && parent.getData('childCount')) || 0
    parent.setData({
      expand: true,
      childCount: Math.max(children.length, prev + 1)
    })
  }

  //  插入同级节点
  insertNode(
    openEdit = true,
    appointNodes = [],
    appointData = null,
    appointChildren = []
  ) {
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    // 协同刷新和懒加载可能替换节点实例，按稳定 UID 定位当前节点。
    const list = (appointNodes.length > 0 ? appointNodes : this.activeNodeList)
      .map(node => node && this.findNodeByUid(getNodeUid(node)))
      .filter(Boolean)
    if (!list.length) return
    const parents = list.map(node => node && node.parent).filter(Boolean)
    if (
      this.runAfterHydrate(
        parents,
        () =>
          this.insertNode(openEdit, list, appointData, appointChildren),
        'INSERT_NODE'
      )
    ) {
      return
    }
    this.textEdit.hideEditTextBox()
    const {
      defaultInsertSecondLevelNodeText,
      defaultInsertBelowSecondLevelNodeText
    } = this.mindMap.opt
    const handleMultiNodes = list.length > 1
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode, inserting } = this.getNewNodeBehavior(
      openEdit,
      handleMultiNodes
    )
    const params = {
      expand: true,
      richText: isRichText,
      isActive: focusNewNode // 如果同时对多个节点插入子节点，那么需要把新增的节点设为激活状态。如果不进入编辑状态，那么也需要手动设为激活状态
    }
    if (isRichText) params.resetRichText = true
    // 动态指定的子节点数据也需要添加相关属性
    appointChildren = addDataToAppointNodes(appointChildren, params)
    const alreadyIsRichText = appointData && appointData.richText
    let createNewId = false
    list.forEach(node => {
      if (node.isGeneralization || node.isRoot) {
        return
      }
      appointChildren = simpleDeepClone(appointChildren)
      const parent = node.parent
      const isOneLayer = node.layerIndex === 1
      // 新插入节点的默认文本
      const text = isOneLayer
        ? defaultInsertSecondLevelNodeText
        : defaultInsertBelowSecondLevelNodeText
      // 计算插入位置
      const index = getNodeDataIndex(node)
      // 定位失败不能把 -1 + 1 当作 0，否则新节点会被插到最上方。
      if (index < 0) return
      // 如果指定的数据就是富文本格式，那么不需要重新创建
      if (alreadyIsRichText && params.resetRichText) {
        delete params.resetRichText
      }
      const newNodeData = {
        inserting,
        data: {
          text: text,
          ...params,
          uid: createUid(),
          ...(appointData || {})
        },
        children: [...createUidForAppointNodes(appointChildren, createNewId)]
      }
      createNewId = true
      this.insertChildNodeData(parent, newNodeData, index + 1)
    })
    // 如果同时对多个节点插入子节点，需要清除原来激活的节点
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render()
  }

  // 插入多个同级节点
  insertMultiNode(appointNodes, nodeList) {
    if (!nodeList || nodeList.length <= 0) return
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    this.textEdit.hideEditTextBox()
    const list = appointNodes.length > 0 ? appointNodes : this.activeNodeList
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode } = this.getNewNodeBehavior(false, true)
    const params = {
      expand: true,
      richText: isRichText,
      isActive: focusNewNode
    }
    if (isRichText) params.resetRichText = true
    nodeList = addDataToAppointNodes(nodeList, params)
    let createNewId = false
    list.forEach(node => {
      if (node.isGeneralization || node.isRoot) {
        return
      }
      nodeList = simpleDeepClone(nodeList)
      const parent = node.parent
      // 计算插入位置
      const index = getNodeDataIndex(node)
      const newNodeList = createUidForAppointNodes(nodeList, createNewId)
      createNewId = true
      parent.nodeData.children.splice(index + 1, 0, ...newNodeList)
      this.mindMap.command.recordContentChange?.({ added: newNodeList, countable: this.mindMap.command.isCountableNode(parent) })
    })
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render()
  }

  //  插入子节点
  insertChildNode(
    openEdit = true,
    appointNodes = [],
    appointData = null,
    appointChildren = []
  ) {
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    // Rendering and lazy hydration can replace node instances. Always insert
    // into the current tree, and never fall back to a removed node's data.
    const list = (appointNodes.length > 0 ? appointNodes : this.activeNodeList)
      .map(node => node && this.findNodeByUid(node.getData('uid')))
      .filter(Boolean)
    if (!list.length) return
    if (
      this.runAfterHydrate(
        list,
        () =>
          this.insertChildNode(
            openEdit,
            list,
            appointData,
            appointChildren
          ),
        'INSERT_CHILD_NODE'
      )
    ) {
      return
    }
    this.textEdit.hideEditTextBox()
    const {
      defaultInsertSecondLevelNodeText,
      defaultInsertBelowSecondLevelNodeText
    } = this.mindMap.opt
    const handleMultiNodes = list.length > 1
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode, inserting } = this.getNewNodeBehavior(
      openEdit,
      handleMultiNodes
    )
    const params = {
      expand: true,
      richText: isRichText,
      isActive: focusNewNode
    }
    if (isRichText) params.resetRichText = true
    // 动态指定的子节点数据也需要添加相关属性
    appointChildren = addDataToAppointNodes(appointChildren, params)
    const alreadyIsRichText = appointData && appointData.richText
    let createNewId = false
    list.forEach(node => {
      appointChildren = simpleDeepClone(appointChildren)
      if (!node.nodeData.children) {
        node.nodeData.children = []
      }
      const text = node.isRoot
        ? defaultInsertSecondLevelNodeText
        : defaultInsertBelowSecondLevelNodeText
      // 如果指定的数据就是富文本格式，那么不需要重新创建
      if (alreadyIsRichText && params.resetRichText) {
        delete params.resetRichText
      }
      const newNode = {
        inserting,
        data: {
          text: text,
          uid: createUid(),
          ...params,
          ...(appointData || {})
        },
        children: [...createUidForAppointNodes(appointChildren, createNewId)]
      }
      createNewId = true
      this.insertChildNodeData(node, newNode)
      if (node.isGeneralization && node.generalizationBelongNode) {
        node.generalizationBelongNode.createGeneralizationNode()
      }
    })
    // 如果同时对多个节点插入子节点，需要清除原来激活的节点
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render()
  }

  // 插入多个子节点
  insertMultiChildNode(appointNodes, childList) {
    if (!childList || childList.length <= 0) return
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    this.textEdit.hideEditTextBox()
    const list = appointNodes.length > 0 ? appointNodes : this.activeNodeList
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode } = this.getNewNodeBehavior(false, true)
    const params = {
      expand: true,
      richText: isRichText,
      isActive: focusNewNode
    }
    if (isRichText) params.resetRichText = true
    childList = addDataToAppointNodes(childList, params)
    let createNewId = false
    list.forEach(node => {
      childList = simpleDeepClone(childList)
      if (!node.nodeData.children) {
        node.nodeData.children = []
      }
      childList = createUidForAppointNodes(childList, createNewId, null, true)
      // 第一个引用不需要重新创建uid，后面的需要重新创建，否则id会重复
      createNewId = true
      node.nodeData.children.push(...childList)
      this.mindMap.command.recordContentChange?.({ added: childList, countable: this.mindMap.command.isCountableNode(node) })
      const live = node.nodeData.children.length
      const prev = Number(node.getData && node.getData('childCount')) || 0
      node.setData({
        expand: true,
        childCount: Math.max(live, prev + childList.length)
      })
      if (node.isGeneralization && node.generalizationBelongNode) {
        node.generalizationBelongNode.createGeneralizationNode()
      }
    })
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render()
  }

  // 插入父节点
  insertParentNode(openEdit = true, appointNodes, appointData) {
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    this.textEdit.hideEditTextBox()
    const {
      defaultInsertSecondLevelNodeText,
      defaultInsertBelowSecondLevelNodeText
    } = this.mindMap.opt
    const list = appointNodes.length > 0 ? appointNodes : this.activeNodeList
    const handleMultiNodes = list.length > 1
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode, inserting } = this.getNewNodeBehavior(
      openEdit,
      handleMultiNodes
    )
    const params = {
      expand: true,
      richText: isRichText,
      isActive: focusNewNode
    }
    if (isRichText) params.resetRichText = true
    const alreadyIsRichText = appointData && appointData.richText
    list.forEach(node => {
      if (node.isGeneralization || node.isRoot) {
        return
      }
      const text =
        node.layerIndex === 1
          ? defaultInsertSecondLevelNodeText
          : defaultInsertBelowSecondLevelNodeText
      // 如果指定的数据就是富文本格式，那么不需要重新创建
      if (alreadyIsRichText && params.resetRichText) {
        delete params.resetRichText
      }
      const newNode = {
        inserting,
        data: {
          text: text,
          uid: createUid(),
          ...params,
          ...(appointData || {})
        },
        children: [node.nodeData]
      }
      const parent = node.parent
      // 获取当前节点所在位置
      const index = getNodeDataIndex(node)
      parent.nodeData.children.splice(index, 1, newNode)
      this.mindMap.command.recordContentChange?.({ added: [newNode], countable: this.mindMap.command.isCountableNode(parent) })
    })
    // 如果同时对多个节点插入子节点，需要清除原来激活的节点
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render()
  }

  //  上移节点，多个节点只会操作第一个节点
  upNode(appointNode) {
    if (this.activeNodeList.length <= 0 && !appointNode) {
      return
    }
    const list = appointNode ? [appointNode] : this.activeNodeList
    const node = list[0]
    if (node.isRoot) {
      return
    }
    if (
      this.runAfterHydrate(
        [node.parent].filter(Boolean),
        () => this.upNode(appointNode),
        'UP_NODE'
      )
    ) {
      return
    }
    let parent = node.parent
    let childList = parent.children
    let index = getNodeIndexInNodeList(node, childList)
    if (index === -1 || index === 0) {
      return
    }
    let insertIndex = index - 1
    // 节点实例
    childList.splice(index, 1)
    childList.splice(insertIndex, 0, node)
    // 节点数据
    parent.nodeData.children.splice(index, 1)
    parent.nodeData.children.splice(insertIndex, 0, node.nodeData)
    this.mindMap.render()
  }

  //  下移节点，多个节点只会操作第一个节点
  downNode(appointNode) {
    if (this.activeNodeList.length <= 0 && !appointNode) {
      return
    }
    const list = appointNode ? [appointNode] : this.activeNodeList
    const node = list[0]
    if (node.isRoot) {
      return
    }
    if (
      this.runAfterHydrate(
        [node.parent].filter(Boolean),
        () => this.downNode(appointNode),
        'DOWN_NODE'
      )
    ) {
      return
    }
    let parent = node.parent
    let childList = parent.children
    let index = getNodeIndexInNodeList(node, childList)
    if (index === -1 || index === childList.length - 1) {
      return
    }
    let insertIndex = index + 1
    // 节点实例
    childList.splice(index, 1)
    childList.splice(insertIndex, 0, node)
    // 节点数据
    parent.nodeData.children.splice(index, 1)
    parent.nodeData.children.splice(insertIndex, 0, node.nodeData)
    this.mindMap.render()
  }

  // 将节点上移一个层级，多个节点只会操作第一个节点
  moveUpOneLevel(node) {
    node = node || this.activeNodeList[0]
    if (!node || node.isRoot || node.layerIndex <= 1) {
      return
    }
    const parent = node.parent
    const grandpa = parent.parent
    const index = getNodeIndexInNodeList(node, parent.children)
    const parentIndex = getNodeIndexInNodeList(parent, grandpa.children)
    // 节点数据
    parent.nodeData.children.splice(index, 1)
    grandpa.nodeData.children.splice(parentIndex + 1, 0, node.nodeData)
    this.mindMap.render()
  }

  // 移除节点数据的自定义样式的内部方法
  _handleRemoveCustomStyles(nodeData) {
    let hasCustomStyles = false
    Object.keys(nodeData).forEach(key => {
      if (checkIsNodeStyleDataKey(key)) {
        hasCustomStyles = true
        delete nodeData[key]
      }
    })
    // 如果是富文本，那么直接全部重新创建，因为有些样式是通过标签来渲染的
    if (this.hasRichTextPlugin()) {
      hasCustomStyles = true
      nodeData.resetRichText = true
    }
    return hasCustomStyles
  }

  // 一键去除自定义样式
  removeCustomStyles(node) {
    node = node || this.activeNodeList[0]
    if (!node) {
      return
    }
    const hasCustomStyles = this._handleRemoveCustomStyles(node.getData())
    if (hasCustomStyles) {
      this.reRenderNodeCheckChange(node)
    }
  }

  // 一键去除所有节点自定义样式
  removeAllNodeCustomStyles(appointNodes) {
    appointNodes = formatDataToArray(appointNodes)
    let hasCustomStyles = false
    // 指定了节点列表，那么遍历该节点列表
    if (appointNodes.length > 0) {
      appointNodes.forEach(node => {
        const _hasCustomStyles = this._handleRemoveCustomStyles(node.getData())
        if (_hasCustomStyles) hasCustomStyles = true
      })
    } else {
      // 否则遍历整棵树
      if (!this.renderTree) return
      walk(this.renderTree, null, node => {
        const _hasCustomStyles = this._handleRemoveCustomStyles(node.data)
        if (_hasCustomStyles) hasCustomStyles = true
        // 不要忘记概要节点
        const generalizationList = formatGetNodeGeneralization(node.data)
        if (generalizationList.length > 0) {
          generalizationList.forEach(generalizationData => {
            const _hasCustomStyles =
              this._handleRemoveCustomStyles(generalizationData)
            if (_hasCustomStyles) hasCustomStyles = true
          })
        }
      })
    }
    if (hasCustomStyles) {
      this.mindMap.reRender()
    }
  }

  // 复制节点
  async copy() {
    if (this._copyPromise) {
      try {
        await this._copyPromise
      } catch (e) {
        // ignore
      }
    }
    this._copyPromise = this.copyNow()
    try {
      await this._copyPromise
    } finally {
      this._copyPromise = null
    }
  }

  async copyNow() {
    if (this.activeNodeList.length <= 0) {
      this.beingCopyData = null
      return
    }
    historyClipboard.clearHistoryCopy()
    let nodeList = getTopAncestorsFomNodeList(this.activeNodeList)
    nodeList = sortNodeList(nodeList)
    const cooperate = this.mindMap.cooperate
    if (cooperate && typeof cooperate.copyNodeTrees === 'function') {
      this.beingCopyData = await cooperate.copyNodeTrees(nodeList)
    } else {
      this.beingCopyData = nodeList.map(node => copyNodeTree({}, node, true))
    }
    if (!this.beingCopyData) return
    if (!this.mindMap.opt.disabledClipboard) {
      await setDataToClipboard(createSmmFormatData(this.beingCopyData, cooperate && cooperate.httpRoomKey))
    }
  }

  // 剪切节点
  async cut() {
    if (this._copyPromise) {
      try {
        await this._copyPromise
      } catch (e) {
        // ignore
      }
    }
    this._copyPromise = this.cutNow()
    try {
      await this._copyPromise
    } finally {
      this._copyPromise = null
    }
  }

  async cutNow() {
    historyClipboard.clearHistoryCopy()
    const cooperate = this.mindMap.cooperate
    let copied = null
    if (
      this.activeNodeList.length > 0 &&
      cooperate &&
      typeof cooperate.copyNodeTrees === 'function'
    ) {
      let nodeList = getTopAncestorsFomNodeList(this.activeNodeList).filter(
        node => !node.isRoot
      )
      nodeList = sortNodeList(nodeList)
      copied = await cooperate.copyNodeTrees(nodeList)
    }
    this.mindMap.execCommand('CUT_NODE', copyData => {
      this.beingCopyData = copied || copyData
      if (!this.mindMap.opt.disabledClipboard) {
        setDataToClipboard(createSmmFormatData(this.beingCopyData, cooperate && cooperate.httpRoomKey))
      }
    })
  }

  isClipboardPasteTargetBlocked(event) {
    if (this.textEdit && this.textEdit.isShowTextEdit()) return true
    if (this.mindMap.richText && this.mindMap.richText.showTextEdit) return true
    const el = event && event.target
    if (!el) return false
    if (el.isContentEditable) return true
    const tag = String(el.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
    if (typeof el.closest === 'function') {
      return !!el.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
      )
    }
    return false
  }

  readClipboardDataFromEvent(clipboardData) {
    let img = null
    const text =
      clipboardData.getData('text/plain') || clipboardData.getData('text') || ''
    const html = clipboardData.getData('text/html') || ''
    const items = clipboardData.items
    if (items) {
      Array.from(items).forEach(item => {
        if (item.type && item.type.indexOf('image') > -1) {
          img = item.getAsFile()
        }
      })
    }
    return { text, html, img }
  }

  // 原生 paste：HTTP 可用，且点击节点后焦点在 SVG 上也能粘贴
  handlePaste(event) {
    if (this.mindMap.opt.historyInteractionPaused) return
    if (this.mindMap.opt.readonly) return
    const { disabledClipboard } = this.mindMap.opt
    if (disabledClipboard) return
    if (this.isClipboardPasteTargetBlocked(event)) return
    if (this.activeNodeList.length <= 0) return
    const clipboardData =
      event.clipboardData ||
      (event.originalEvent && event.originalEvent.clipboardData)
    if (!clipboardData) return
    const payload = this.readClipboardDataFromEvent(clipboardData)
    if (!payload.text && !payload.html && !payload.img) {
      const historyTrees = this.getHistoryCopyForCurrentRoom()
      if (!historyTrees) return
      this._pasteFromNativeEvent = true
      event.preventDefault()
      this.paste()
      return
    }
    this._pasteFromNativeEvent = true
    event.preventDefault()
    this.paste(payload)
  }

  pasteInAppCopy() {
    if (this.mindMap.opt.historyInteractionPaused) return false
    const historyTrees = this.getHistoryCopyForCurrentRoom()
    if (historyTrees) {
      this.mindMap.execCommand('PASTE_NODE', historyTrees)
      return true
    }
    if (!this.beingCopyData) return false
    this.mindMap.execCommand('PASTE_NODE', this.beingCopyData)
    return true
  }

  getHistoryCopyForCurrentRoom() {
    const roomKey = this.mindMap && this.mindMap.opt
      ? this.mindMap.opt.historyCopyRoomKey
      : ''
    return roomKey ? historyClipboard.getHistoryCopy(roomKey) : null
  }

  // 粘贴
  async paste(preset = null) {
    if (this.mindMap.opt.historyInteractionPaused) return
    if (this._copyPromise) {
      try {
        await this._copyPromise
      } catch (e) {
        // ignore
      }
    }
    const { errorHandler, disabledClipboard } = this.mindMap.opt
    const hasPreset =
      preset && (preset.text || preset.html || preset.img)
    if (hasPreset) {
      await this.applyClipboardPaste(preset)
      return
    }
    if (!disabledClipboard && checkClipboardReadEnable()) {
      try {
        const res = await getDataFromClipboard()
        const hasClip = !!(res && (res.text || res.html || res.img))
        if (hasClip) {
          await this.applyClipboardPaste({
            text: res.text || '',
            html: res.html || '',
            img: res.img || null
          })
          return
        }
      } catch (error) {
        errorHandler(ERROR_TYPES.READ_CLIPBOARD_ERROR, error)
      }
    }
    const historyTrees = this.getHistoryCopyForCurrentRoom()
    if (historyTrees) {
      this.mindMap.execCommand('PASTE_NODE', historyTrees)
      return
    }
    if (this.beingCopyData) {
      this.mindMap.execCommand('PASTE_NODE', this.beingCopyData)
    }
  }

  async applyClipboardPaste({ text = '', html = '', img = null }) {
    const jsonPayload = checkSmmFormatData(text)
    const copiedPayload = readSmmClipboardHtml(html) || (jsonPayload.isSmm
      ? { simpleMindMap: true, data: jsonPayload.data, sourceRoom: jsonPayload.sourceRoom }
      : null)
    if (copiedPayload) {
      const targetUids = this.activeNodeList.map(node => node.getData('uid'))
      if (!targetUids.length) return
      let trees = copiedPayload.data
      if (this.mindMap.opt.customHandleClipboardData) {
        try {
          trees = await this.mindMap.opt.customHandleClipboardData(copiedPayload)
        } catch (error) {
          this.mindMap.opt.errorHandler(ERROR_TYPES.CUSTOM_HANDLE_CLIPBOARD_TEXT_ERROR, error)
          return
        }
      }
      const targets = targetUids.map(uid => this.findNodeByUid(uid)).filter(Boolean)
      if (targets.length !== targetUids.length) return
      this.mindMap.execCommand('PASTE_NODE', trees, targets)
      return
    }
    const {
      errorHandler,
      handleIsSplitByWrapOnPasteCreateNewNode,
      handleNodePasteImg,
      onlyPasteTextWhenHasImgAndText
    } = this.mindMap.opt

    // Some clipboard paths expose only text. Match our copy exactly, including
    // single leaves, so unrelated external outlines cannot paste stale node data.
    if (
      this.beingCopyData &&
      !this.getHistoryCopyForCurrentRoom() &&
      text &&
      !html && !img &&
      text.replace(/\r\n?/g, '\n') === nodesToTabOutline(this.beingCopyData)
    ) {
      this.mindMap.execCommand('PASTE_NODE', this.beingCopyData)
      return
    }

    if (text || html) {
      let smmData = null
      let useDefault = true
      if (this.mindMap.opt.customHandleClipboardText) {
        try {
          const res = await this.mindMap.opt.customHandleClipboardText(text, {
            html
          })
          if (!isUndef(res)) {
            useDefault = false
            const checkRes = checkSmmFormatData(res)
            if (checkRes.isSmm) {
              smmData = checkRes.data
            } else {
              text = checkRes.data
            }
          }
        } catch (error) {
          errorHandler(ERROR_TYPES.CUSTOM_HANDLE_CLIPBOARD_TEXT_ERROR, error)
        }
      }
      if (useDefault && text) {
        const checkRes = checkSmmFormatData(text)
        if (checkRes.isSmm) {
          smmData = checkRes.data
        } else {
          text = checkRes.data
        }
      }
      if (smmData) {
        this.mindMap.execCommand(
          'PASTE_NODE',
          Array.isArray(smmData) ? smmData : [smmData]
        )
      } else if (text) {
        if (this.hasRichTextPlugin()) {
          text = htmlEscape(text)
        }
        const textArr = text
          .split(/\r?\n|(?<!\n)\r/g)
          .filter(item => {
            return !!item
          })
        if (textArr.length > 1 && handleIsSplitByWrapOnPasteCreateNewNode) {
          handleIsSplitByWrapOnPasteCreateNewNode()
            .then(() => {
              this.mindMap.execCommand(
                'INSERT_MULTI_CHILD_NODE',
                [],
                textArr.map(item => {
                  return {
                    data: {
                      text: item
                    },
                    children: []
                  }
                })
              )
            })
            .catch(() => {
              this.mindMap.execCommand('INSERT_CHILD_NODE', false, [], {
                text
              })
            })
        } else {
          this.mindMap.execCommand('INSERT_CHILD_NODE', false, [], {
            text
          })
        }
      }
    }
    if (img && (!text || !onlyPasteTextWhenHasImgAndText)) {
      try {
        let imgData = null
        if (handleNodePasteImg && typeof handleNodePasteImg === 'function') {
          imgData = await handleNodePasteImg(img)
        } else {
          imgData = await loadImage(img)
        }
        if (this.activeNodeList.length > 0) {
          this.activeNodeList.forEach(node => {
            this.mindMap.execCommand('SET_NODE_IMAGE', node, {
              url: imgData.url,
              title: '',
              width: imgData.size.width,
              height: imgData.size.height
            })
          })
        }
      } catch (error) {
        errorHandler(ERROR_TYPES.LOAD_CLIPBOARD_IMAGE_ERROR, error)
      }
    }
  }

  //  将节点移动到另一个节点的前面
  insertBefore(node, exist) {
    this.insertTo(node, exist, 'before')
  }

  //  将节点移动到另一个节点的后面
  insertAfter(node, exist) {
    this.insertTo(node, exist, 'after')
  }

  // 将节点移动到另一个节点的前面或后面
  insertTo(node, exist, dir = 'before') {
    let nodeList = formatDataToArray(node)
    nodeList = nodeList.filter(item => {
      return !item.isRoot
    })
    if (!exist || this.isInvalidMoveTarget(nodeList, exist.parent)) return
    if (
      this.runAfterHydrate(
        [exist && exist.parent].filter(Boolean),
        () => this.insertTo(node, exist, dir),
        dir === 'after' ? 'INSERT_AFTER' : 'INSERT_BEFORE'
      )
    ) {
      return
    }
    if (dir === 'after') {
      nodeList.reverse()
    }
    const touchedParents = new Set()
    nodeList.forEach(item => {
      // 移动节点
      let nodeParent = item.parent
      let nodeBorthers = nodeParent.children
      let nodeIndex = getNodeIndexInNodeList(item, nodeBorthers)
      const uid = getNodeUid(item)
      const dataIndex = nodeParent.nodeData.children.findIndex(
        child => child && child.data && child.data.uid === uid
      )
      const existParent = exist.parent
      if (item === exist || !existParent || nodeIndex === -1 || dataIndex === -1) {
        return
      }
      const anchorUid = getNodeUid(exist)
      if (
        uid === anchorUid ||
        getNodeIndexInNodeList(exist, existParent.children) === -1 ||
        !existParent.nodeData.children.some(
          child => child && child.data && child.data.uid === anchorUid
        )
      ) {
        return
      }
      // Validate the insert slot before mutating the old parent. An early
      // return after splice left multi-select moves half-applied and kept
      // stale connectors on the previous parent.
      let existBorthers = existParent.children
      let existIndex = getNodeIndexInNodeList(exist, existBorthers)
      let targetDataIndex = existParent.nodeData.children.findIndex(
        child => child && child.data && child.data.uid === anchorUid
      )
      if (existIndex === -1 || targetDataIndex === -1) {
        return
      }
      touchedParents.add(nodeParent)
      touchedParents.add(existParent)
      // Invalidate old connectors before asynchronous layout reuses the nodes.
      if (typeof nodeParent.removeLine === 'function') nodeParent.removeLine()
      detachNodeFromParent(item)

      if (dir === 'after') {
        existIndex++
        targetDataIndex++
      }
      // Re-read lists after detach in case old/new parent were the same.
      existBorthers = existParent.children
      existIndex = Math.max(
        0,
        Math.min(
          existIndex,
          existBorthers.length
        )
      )
      targetDataIndex = Math.max(
        0,
        Math.min(
          targetDataIndex,
          existParent.nodeData.children.length
        )
      )
      // Same-parent reorder: after detach, anchor index may have shifted.
      if (nodeParent === existParent) {
        existIndex = getNodeIndexInNodeList(exist, existBorthers)
        targetDataIndex = existParent.nodeData.children.findIndex(
          child => child && child.data && child.data.uid === anchorUid
        )
        if (existIndex === -1 || targetDataIndex === -1) return
        if (dir === 'after') {
          existIndex++
          targetDataIndex++
        }
      }
      existBorthers.splice(existIndex, 0, item)
      existParent.nodeData.children.splice(targetDataIndex, 0, item.nodeData)
      item.parent = existParent
      this.resetMovedNodePosition(item)
    })
    touchedParents.forEach(parent => {
      if (!parent) return
      if (Array.isArray(parent.children)) {
        parent.children = parent.children.filter(
          child => child && child.parent === parent
        )
      }
      if (typeof parent.setData === 'function' && parent.nodeData) {
        parent.setData({
          childCount: (parent.nodeData.children || []).length
        })
      }
      if (typeof parent.removeLine === 'function') parent.removeLine()
    })
    this.mindMap.render()
  }

  //  移除节点
  removeNode(appointNodes = []) {
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    // 删除节点后需要激活的节点
    let needActiveNode = null
    let isAppointNodes = appointNodes.length > 0
    let list = isAppointNodes ? appointNodes : this.activeNodeList
    let root = list.find(node => {
      return node.isRoot
    })
    if (root) {
      this.clearActiveNodeList()
      this.mindMap.command.recordContentChange?.({ removed: root.nodeData.children.slice() })
      root.children = []
      root.nodeData.children = []
    } else {
      // 如果只选中了一个节点，删除后激活其兄弟节点或者父节点
      needActiveNode = this.getNextActiveNode(list)
      for (let i = 0; i < list.length; i++) {
        const node = list[i]
        const currentEditNode = this.textEdit.getCurrentEditNode()
        if (
          currentEditNode &&
          currentEditNode.getData('uid') === node.getData('uid')
        ) {
          // 如果当前节点正在编辑中，那么先完成编辑
          this.textEdit.hideEditTextBox()
        }
        if (isAppointNodes) list.splice(i, 1)
        if (node.isGeneralization) {
          this.deleteNodeGeneralization(node)
          this.removeNodeFromActiveList(node)
          i--
        } else {
          this.removeNodeFromActiveList(node)
          this.mindMap.command.recordContentChange?.({ removed: [node] })
          removeFromParentNodeData(node)
          i--
        }
      }
    }
    this.activeNodeList = []
    // 激活被删除节点的兄弟节点或父节点
    if (needActiveNode) {
      this.addNodeToActiveList(needActiveNode)
    }
    this.emitNodeActiveEvent()
    this.mindMap.render()
  }

  // 删除概要节点，即从所属节点里删除该概要
  deleteNodeGeneralization(node) {
    const targetNode = node && node.generalizationBelongNode
    if (!targetNode) return
    const genUid = (node.getData && node.getData('uid')) || node.uid
    const raw = targetNode.getData('generalization')
    const list = Array.isArray(raw) ? raw.slice() : raw ? [raw] : []
    let index =
      typeof targetNode.getGeneralizationNodeIndex === 'function'
        ? targetNode.getGeneralizationNodeIndex(node)
        : -1
    if (index < 0) {
      index = list.findIndex(
        item =>
          item &&
          (item.uid === genUid || item.uid === node.uid)
      )
    }
    const next =
      index < 0
        ? list.filter(
            item => item && item.uid !== genUid && item.uid !== node.uid
          )
        : list.filter((_, i) => i !== index)
    this.mindMap.execCommand('SET_NODE_DATA', targetNode, {
      generalization: next.length ? next : null
    })
    if (!next.length) {
      if (typeof targetNode.removeGeneralization === 'function') {
        targetNode.removeGeneralization()
      }
    } else if (typeof targetNode.updateGeneralization === 'function') {
      targetNode.updateGeneralization()
    }
    this.closeHighlightNode()
  }

  // 仅删除当前节点
  removeCurrentNode(appointNodes = []) {
    appointNodes = formatDataToArray(appointNodes)
    if (this.activeNodeList.length <= 0 && appointNodes.length <= 0) {
      return
    }
    let isAppointNodes = appointNodes.length > 0
    let list = isAppointNodes ? appointNodes : this.activeNodeList
    list = list.filter(node => {
      return !node.isRoot
    })
    if (
      this.runAfterHydrate(
        list,
        () => this.removeCurrentNode(appointNodes),
        'REMOVE_CURRENT_NODE'
      )
    ) {
      return
    }
    // 删除节点后需要激活的节点，如果只选中了一个节点，删除后激活其兄弟节点或者父节点
    let needActiveNode = this.getNextActiveNode(list)
    for (let i = 0; i < list.length; i++) {
      let node = list[i]
      if (node.isGeneralization) {
        // 删除概要节点
        this.deleteNodeGeneralization(node)
      } else {
        this.mindMap.command.recordContentChange?.({ removed: [{ data: node.nodeData.data, children: [] }] })
        const parent = node.parent
        const index = getNodeDataIndex(node)
        parent.nodeData.children.splice(
          index,
          1,
          ...(node.nodeData.children || [])
        )
      }
    }
    this.activeNodeList = []
    // 激活被删除节点的兄弟节点或父节点
    if (needActiveNode) {
      this.addNodeToActiveList(needActiveNode)
    }
    this.emitNodeActiveEvent()
    this.mindMap.render()
  }

  // 计算下一个可激活的节点
  getNextActiveNode(deleteList) {
    // 删除多个节点不自动激活相邻节点
    if (deleteList.length !== 1) return null
    // 被删除的节点不在当前激活的节点列表里，不激活相邻节点
    if (this.findActiveNodeIndex(deleteList[0]) === -1) return null
    let needActiveNode = null
    if (
      this.activeNodeList.length === 1 &&
      !this.activeNodeList[0].isGeneralization &&
      this.mindMap.opt.deleteNodeActive
    ) {
      const node = this.activeNodeList[0]
      const broList = node.parent.children
      const nodeIndex = getNodeIndexInNodeList(node, broList)
      // 如果后面有兄弟节点
      if (nodeIndex < broList.length - 1) {
        needActiveNode = broList[nodeIndex + 1]
      } else {
        // 如果前面有兄弟节点
        if (nodeIndex > 0) {
          needActiveNode = broList[nodeIndex - 1]
        } else {
          // 没有兄弟节点
          needActiveNode = node.parent
        }
      }
    }
    return needActiveNode
  }

  //  复制节点
  copyNode() {
    if (this.activeNodeList.length <= 0) {
      return null
    }
    let nodeList = getTopAncestorsFomNodeList(this.activeNodeList)
    nodeList = sortNodeList(nodeList)
    return nodeList.map(node => {
      return copyNodeTree({}, node, true)
    })
  }

  //  剪切节点
  cutNode(callback) {
    if (this.activeNodeList.length <= 0) {
      return
    }
    if (this.runAfterHydrate(this.activeNodeList, () => this.cutNode(callback), 'CUT_NODE')) {
      return
    }
    // 找出激活节点中的顶层节点列表，并过滤掉根节点
    let nodeList = getTopAncestorsFomNodeList(this.activeNodeList).filter(
      node => {
        return !node.isRoot
      }
    )
    nodeList = sortNodeList(nodeList)
    // 复制数据
    const copyData = nodeList.map(node => {
      return copyNodeTree({}, node, true)
    })
    // 从父节点的数据中移除
    nodeList.forEach(node => {
      this.mindMap.command.recordContentChange?.({ removed: [node] })
      removeFromParentNodeData(node)
    })
    // 清空激活节点列表
    this.clearActiveNodeList()
    this.mindMap.render()
    if (callback && typeof callback === 'function') {
      callback(copyData)
    }
  }

  //  移动节点作为另一个节点的子节点
  moveNodeTo(node, toNode, positions = []) {
    let nodeList = formatDataToArray(node)
    nodeList = nodeList.filter(item => {
      return !item.isRoot
    })
    if (this.isInvalidMoveTarget(nodeList, toNode)) return
    if (
      this.runAfterHydrate(
        [toNode].filter(Boolean),
        () => this.moveNodeTo(node, toNode, positions),
        'MOVE_NODE_TO'
      )
    ) {
      return
    }
    const touchedParents = new Set([toNode])
    nodeList.forEach(item => {
      this.removeNodeFromActiveList(item)
      const fromParent = item.parent
      if (fromParent) touchedParents.add(fromParent)
      detachNodeFromParent(item)
      toNode.setData({
        expand: true
      })
      if (!toNode.nodeData.children) toNode.nodeData.children = []
      const uid = getNodeUid(item)
      toNode.nodeData.children = toNode.nodeData.children.filter(
        child => !(child && child.data && child.data.uid === uid)
      )
      toNode.nodeData.children.push(item.nodeData)
      if (Array.isArray(toNode.children)) {
        toNode.children = toNode.children.filter(
          child => child !== item && getNodeUid(child) !== uid
        )
        toNode.children.push(item)
      }
      item.parent = toNode
      this.resetMovedNodePosition(item)
      const position = positions.find(entry => entry.uid === getNodeUid(item))
      if (position) {
        item.setData({ isFloating: true, customLeft: position.customLeft, customTop: position.customTop })
        item.customLeft = position.customLeft
        item.customTop = position.customTop
      }
    })
    touchedParents.forEach(parent => {
      if (!parent) return
      if (Array.isArray(parent.children)) {
        parent.children = parent.children.filter(
          child => child && child.parent === parent
        )
      }
      if (typeof parent.setData === 'function' && parent.nodeData) {
        parent.setData({
          childCount: (parent.nodeData.children || []).length
        })
      }
      if (typeof parent.removeLine === 'function') parent.removeLine()
    })
    this.emitNodeActiveEvent()
    this.mindMap.render()
  }

  // Validate against data descendants as well as rendered nodes (lazy children
  // need not have a rendered instance yet). Reject the entire multi-node move.
  isInvalidMoveTarget(nodes, target) {
    if (!target) return true
    const targetUid = target.getData('uid')
    return nodes.some(node => {
      const stack = [node.nodeData]
      const seen = new Set()
      while (stack.length) {
        const current = stack.pop()
        if (!current || seen.has(current)) continue
        seen.add(current)
        if (current.data && current.data.uid === targetUid) return true
        stack.push(...(current.children || []))
      }
      return false
    })
  }

  // Structural moves follow sibling order instead of the old absolute position.
  resetMovedNodePosition(node) {
    node.customLeft = undefined
    node.customTop = undefined
    node.setData({ customLeft: null, customTop: null, isFloating: false })
  }

  //   粘贴节点到节点
  pasteNode(data, appointNodes = []) {
    const cooperate = this.mindMap.cooperate
    let trees = formatDataToArray(data)
    if (cooperate && typeof cooperate.preparePasteTrees === 'function') {
      trees = cooperate.preparePasteTrees(trees)
    } else {
      trees = formatDataToArray(simpleDeepClone(data))
      const roomKey = this.mindMap.opt && this.mindMap.opt.historyCopyRoomKey
      const historySignature = roomKey
        ? historyClipboard.getHistoryCopySignature(roomKey)
        : ''
      const isHistoryCopy =
        !!historySignature &&
        historySignature === JSON.stringify({ simpleMindMap: true, data: trees })
      if (isHistoryCopy) {
        // History extraction resolves private image keys against that version's
        // own imgMap. Do not let a same-key entry in the current map replace it.
        trees = collabPaste.preparePasteTrees(trees).trees
      } else {
        createUidForAppointNodes(trees, true, null, true)
      }
    }
    this.mindMap.execCommand('INSERT_MULTI_CHILD_NODE', appointNodes, trees)
  }

  //  设置节点样式
  setNodeStyle(node, prop, value) {
    const data = {
      [prop]: value
    }
    this.setNodeDataRender(node, data)
    // 更新了连线的样式
    if (lineStyleProps.includes(prop)) {
      (node.parent || node).renderLine(true)
    }
  }

  //  设置节点多个样式
  setNodeStyles(node, style) {
    const data = { ...style }
    this.setNodeDataRender(node, data)
    // 更新了连线的样式
    let props = Object.keys(style)
    let hasLineStyleProps = false
    props.forEach(key => {
      if (lineStyleProps.includes(key)) {
        hasLineStyleProps = true
      }
    })
    if (hasLineStyleProps) {
      (node.parent || node).renderLine(true)
    }
  }

  //  设置节点是否激活
  setNodeActive(node, active) {
    this.mindMap.execCommand('SET_NODE_DATA', node, {
      isActive: active
    })
    node.updateNodeByActive(active)
  }

  //  设置节点是否展开
  setNodeExpand(node, expand) {
    if (this._destroyed) return
    const wasCollapsed = node.getData('expand') === false
    const apply = nextExpand => {
      const collapsedChildren =
        nextExpand && wasCollapsed ? this.collapseChildrenOf(node) : false
      this.mindMap.execCommand('SET_NODE_DATA', node, {
        expand: nextExpand
      })
      if (collapsedChildren) this.mindMap.emit('personal_expand_change')
      this.mindMap.render()
    }
    if (!expand) {
      apply(false)
      return
    }
    const live =
      node.nodeData && node.nodeData.children && node.nodeData.children.length
    const cooperate = this.mindMap.cooperate
    if (live || !cooperate || typeof cooperate.hydrateLazyChildren !== 'function') {
      apply(true)
      return
    }
    const after = () => {
      if (this._destroyed) return
      const hasKids =
        node.nodeData && node.nodeData.children && node.nodeData.children.length
      if (hasKids) {
        apply(true)
        return
      }
      const childCount = Number(node.getData && node.getData('childCount')) || 0
      if (
        childCount > 0 &&
        cooperate &&
        typeof cooperate.repairEmptyExpand === 'function'
      ) {
        cooperate.repairEmptyExpand(node)
      }
    }
    const hydrated = cooperate.hydrateLazyChildren(node)
    if (hydrated && typeof hydrated.then === 'function') {
      hydrated.then(after).catch(err => {
        if (this._destroyed) return
        console.error('[mind-map] load children failed', err)
        if (typeof cooperate.repairEmptyExpand === 'function') {
          cooperate.repairEmptyExpand(node)
        }
      })
      return
    }
    after()
  }

  // 从收起状态展开时只露出下一级，子节点不沿用收起前的展开状态
  collapseChildrenOf(node) {
    const children = (node.nodeData && node.nodeData.children) || []
    let changed = false
    children.forEach(child => {
      if (!child || !child.data || !this.nodeHasChildren(child)) return
      if (child.data.expand !== false) {
        child.data.expand = false
        changed = true
      }
    })
    return changed
  }

  nodeHasChildren(node) {
    if (!node) return false
    if (node.children && node.children.length > 0) return true
    const data = node.data || node
    return Number(data.childCount) > 0
  }

  getExpandTreeData(node) {
    return node && (node.data || node)
  }

  // 概要数据也是一棵可展开的虚拟子树。展开/收起命令遍历原始树时，
  // 需要把它们作为当前节点的附加孩子纳入，否则从概要节点触发的
  // “展开/收起所有下级”会退回根节点或漏掉概要子节点。
  getGeneralizationTrees(node) {
    const list = node && node.data && node.data.generalization
    if (!list) return []
    return (Array.isArray(list) ? list : [list]).filter(Boolean)
  }

  applyExpandFlagsToLevel(level, root = this.renderTree) {
    walk(
      root,
      null,
      (node, parent, isRoot, layerIndex) => {
        const expand = layerIndex < level
        const data = this.getExpandTreeData(node)
        if (expand) {
          data.expand = true
        } else if (!isRoot && this.nodeHasChildren(node)) {
          data.expand = false
        }
      },
      null,
      true,
      0,
      0
    )
  }

  hydrateThen(root, level, options, after) {
    if (this._destroyed) return
    const command = this.mindMap.command
    const finish = () => {
      if (this._destroyed) return
      after()
      if (command && command.isPause) {
        command.recovery()
        command.addHistory()
      }
    }
    if (command) command.pause()
    const cooperate = this.mindMap.cooperate
    if (
      !cooperate ||
      typeof cooperate.hydrateTreeToLevel !== 'function'
    ) {
      finish()
      return
    }
    const hydrated = cooperate.hydrateTreeToLevel(root, level, options)
    if (hydrated && typeof hydrated.then === 'function') {
      hydrated.then(finish).catch(err => {
        console.error('[mind-map] load children failed', err)
        finish()
      })
      return
    }
    finish()
  }

  waitForRender() {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this.mindMap.off('render_cancelled', done)
        resolve()
      }
      this.mindMap.on('render_cancelled', done)
      try {
        this.render(done)
      } catch (err) {
        this.mindMap.off('render_cancelled', done)
        reject(err)
      }
    })
  }

  collectCollapsedFrontier(root) {
    const out = []
    const visit = node => {
      if (!node) return
      const data = this.getExpandTreeData(node)
      const expanded = !data || data.expand !== false
      const children = node.children || []
      const childCount = Number(data && data.childCount) || 0
      // 已展开的节点也可能是 HTTP 懒加载占位节点，需要先补齐子节点。
      if (childCount > children.length) {
        out.push(node)
        return
      }
      if (!expanded) {
        if (this.nodeHasChildren(node)) out.push(node)
        return
      }
      for (let i = 0; i < children.length; i++) visit(children[i])
      this.getGeneralizationTrees(node).forEach(visit)
    }
    visit(root)
    return out
  }

  async hydrateFrontier(nodes) {
    if (this._destroyed) return false
    const cooperate = this.mindMap.cooperate
    if (!cooperate || typeof cooperate.hydrateNodeData !== 'function') return false
    const stubs = (nodes || []).filter(node => {
      // 概要条目是原始 generalization 数据，不是协同层的普通节点记录，
      // 不能把它交给只接受 node.data 的懒加载接口。
      if (!node || !node.data) return false
      const live = node.children && node.children.length
      const data = this.getExpandTreeData(node)
      const count = Number(data && data.childCount) || 0
      return count > live
    })
    if (!stubs.length) return false
    const jobs = stubs.slice(0, EXPAND_ALL_BATCH * 2)
    const concurrency = 2
    let index = 0
    let changed = false
    const worker = async () => {
      while (index < jobs.length) {
        if (this._destroyed) return
        const node = jobs[index++]
        const before = (node.children && node.children.length) || 0
        try {
          await cooperate.hydrateNodeData(node)
          if (this._destroyed) return
          const after = (node.children && node.children.length) || 0
          if (after > before) changed = true
        } catch (err) {
          console.error('[mind-map] load children failed', err)
        }
      }
    }
    await Promise.all(
      new Array(Math.min(concurrency, jobs.length)).fill(0).map(() => worker())
    )
    return changed
  }

  //  展开所有
  expandAllNode(uid = '') {
    if (!this.renderTree) return
    const token = (this._expandOperationId || 0) + 1
    this._expandOperationId = token
    this._expandAllToken = token
    const command = this.mindMap.command
    if (command) command.pause()
    const start = this.findExpandStartNode(uid)
    return this.expandSubtreeProgressive(start, token)
      .catch(err => {
        console.error('[mind-map] expand all failed', err)
      })
      .finally(() => {
        if (this._expandAllToken === token) this._expandAllToken = 0
        if (command && command.isPause) {
          command.recovery()
          command.addHistory()
        }
      })
  }

  findExpandStartNode(uid) {
    if (!uid || !this.renderTree) return this.renderTree
    const cooperate = this.mindMap.cooperate
    if (cooperate && typeof cooperate.findTreeNode === 'function') {
      const found = cooperate.findTreeNode(this.renderTree, uid)
      if (found) return found
    }
    let found = null
    const visit = node => {
      if (!node || found) return
      const data = this.getExpandTreeData(node)
      if (data && data.uid === uid) {
        found = node
        return
      }
      ;(node.children || []).forEach(visit)
      this.getGeneralizationTrees(node).forEach(visit)
    }
    visit(this.renderTree)
    // 指定目标不存在时不要误把整图当作起点。
    return found
  }

  async expandSubtreeProgressive(start, token) {
    if (!start || this._destroyed) return
    // Queue stable identities: collaboration hydration can replace renderTree.
    const entryFor = node => ({
      node,
      uid: (this.getExpandTreeData(node) || {}).uid,
      tree: this.renderTree
    })
    const resolve = entry => this.renderTree === entry.tree
      ? entry.node
      : entry.uid ? this.findExpandStartNode(entry.uid) : null
    const startEntry = entryFor(start)
    const queue = [startEntry]
    const visited = new Set()
    let index = 0
    while (index < queue.length) {
      if (this._expandAllToken !== token || !resolve(startEntry)) return
      const batch = []
      let willShow = 0
      while (index < queue.length && batch.length < EXPAND_ALL_BATCH) {
        const entry = queue[index]
        const node = resolve(entry)
        const key = entry.uid || node
        if (!node || visited.has(key)) {
          index++
          continue
        }
        const kids = (node.children && node.children.length) || 0
        if (batch.length && willShow + kids > EXPAND_ALL_PER_FRAME) break
        index++
        visited.add(key)
        batch.push(entryFor(node))
        willShow += kids
      }
      const childCounts = batch.map(entry => (entry.node.children || []).length)
      await this.hydrateFrontier(batch.map(entry => entry.node))
      if (this._expandAllToken !== token || !resolve(startEntry)) return
      let changed = false
      batch.forEach((entry, batchIndex) => {
        const node = resolve(entry)
        if (!node) return
        const children = node.children || []
        const summaries = this.getGeneralizationTrees(node)
        // Failed loads stay collapsed and can be retried by the user.
        if (children.length || summaries.length) {
          const data = this.getExpandTreeData(node)
          if (data.expand !== true || children.length !== childCounts[batchIndex]) {
            changed = true
          }
          data.expand = true
        }
        children.forEach(child => queue.push(entryFor(child)))
        summaries.forEach(summary => queue.push(entryFor(summary)))
      })
      if (changed) {
        this.mindMap.emit('personal_expand_change')
        await this.waitForRender()
        if (this._expandAllToken !== token) return
      }
    }
  }

  unexpandAllNode(isSetRootNodeCenter = true, uid = '') {
    if (!this.renderTree) return
    this._expandAllToken = 0
    this._expandOperationId = (this._expandOperationId || 0) + 1

    const _walk = (node, isRoot, enableUnExpand) => {
      // 如果该节点为目标节点，那么修改允许展开的标志
      const data = this.getExpandTreeData(node)
      if (!enableUnExpand && data && data.uid === uid) {
        enableUnExpand = true
      }
      if (enableUnExpand && !isRoot && this.nodeHasChildren(node)) {
        data.expand = false
      }
      if (node.children && node.children.length > 0) {
        node.children.forEach(child => {
          _walk(child, false, enableUnExpand)
        })
      }
      this.getGeneralizationTrees(node).forEach(item => {
        _walk(item, false, enableUnExpand)
      })
    }
    _walk(this.renderTree, true, !uid)
    this.mindMap.emit('personal_expand_change')

    this.mindMap.render(() => {
      if (isSetRootNodeCenter) {
        this.setRootNodeCenter()
      }
    })
  }

  //  展开到指定层级
  expandToLevel(level, uid = '') {
    if (!this.renderTree) return
    // 带 UID 时，以该节点为第 0 层，只改变它的下级分支。
    const start = this.findExpandStartNode(uid)
    if (!start) return
    const target = Number(level) || 0
    const token = (this._expandOperationId || 0) + 1
    this._expandOperationId = token
    this._expandAllToken = 0
    this.hydrateThen(start, target, { maxFetches: 40, concurrency: 2 }, () => {
      if (this._expandOperationId !== token) return
      // 懒加载期间协同刷新可能替换整棵树，按 UID 重新解析目标。
      const current = this.findExpandStartNode(uid)
      if (!current) return
      this.applyExpandFlagsToLevel(target, current)
      this.mindMap.emit('personal_expand_change')
      this.mindMap.render()
    })
  }

  //  切换激活节点的展开状态
  toggleActiveExpand() {
    this.activeNodeList.forEach(node => {
      if (node.isRoot) return
      if (typeof node.getChildrenLength === 'function') {
        if (node.getChildrenLength() <= 0) return
      } else if (!node.nodeData.children || node.nodeData.children.length <= 0) {
        return
      }
      this.toggleNodeExpand(node)
    })
  }

  //  切换节点展开状态
  toggleNodeExpand(node) {
    this.mindMap.execCommand('SET_NODE_EXPAND', node, !node.getData('expand'))
  }

  //  设置节点文本
  setNodeText(node, text, richText, resetRichText) {
    richText = richText === undefined ? node.getData('richText') : richText
    this.setNodeDataRender(node, {
      text,
      richText,
      resetRichText
    })
  }

  //  设置节点图片
  setNodeImage(node, data) {
    const {
      url,
      title,
      width,
      height,
      custom = false
    } = data || { url: '', title: '', width: 0, height: 0, custom: false }
    this.setNodeDataRender(node, {
      image: url,
      imageTitle: title || '',
      imageSize: {
        width,
        height,
        custom
      }
    })
  }

  //  设置节点图标
  setNodeIcon(node, icons) {
    this.setNodeDataRender(node, {
      icon: icons
    })
  }

  //  设置节点超链接
  setNodeHyperlink(node, link, title = '') {
    this.setNodeDataRender(node, {
      hyperlink: link,
      hyperlinkTitle: title
    })
  }

  setNodeMapRef(node, mapRef) {
    this.setNodeDataRender(node, {
      mapRef: mapRefUtil.normalizeMapRef(mapRef)
    })
  }

  //  设置节点备注
  setNodeNote(node, note) {
    this.setNodeDataRender(node, {
      note
    })
  }

  //  设置节点评论（评论列表 + 是否已解决）
  setNodeComment(node, comments, resolved = false) {
    this.setNodeDataRender(node, {
      // 始终提交完整数组（含删除墓碑），由合并层按 id 合并
      comments: Array.isArray(comments) ? comments : [],
      commentResolved: !!resolved
    })
  }

  //  设置节点附件
  setNodeAttachment(node, url, name = '', meta = null) {
    const patch = {
      attachmentUrl: url,
      attachmentName: name
    }
    if (meta && typeof meta === 'object') {
      [
        'attachmentId',
        'attachmentMimeType',
        'attachmentStatus',
        'attachmentError',
        'attachmentExtractedText',
        'attachmentProgress',
        'attachmentErrorIgnored'
      ].forEach(key => {
        if (meta[key] != null) patch[key] = meta[key]
      })
    }
    // 「忽略错误」只对当前这次失败有效：换了文件或状态不再是 failed 时自动清除。
    const current = (node && typeof node.getData === 'function' && node.getData()) || {}
    if (current.attachmentErrorIgnored && patch.attachmentErrorIgnored == null) {
      const nextId = patch.attachmentId != null ? patch.attachmentId : current.attachmentId
      const nextStatus = patch.attachmentStatus != null ? patch.attachmentStatus : current.attachmentStatus
      const sameFile =
        String(nextId || '') === String(current.attachmentId || '') &&
        String(patch.attachmentName || '') === String(current.attachmentName || '') &&
        String(patch.attachmentUrl || '') === String(current.attachmentUrl || '')
      if (!sameFile || String(nextStatus || '').trim().toLowerCase() !== 'failed') {
        patch.attachmentErrorIgnored = false
      }
    }
    this.setNodeDataRender(node, patch)
  }

  //  设置节点标签
  setNodeTag(node, tag) {
    this.setNodeDataRender(node, {
      tag
    })
  }

  // 设置节点公式
  insertFormula(formula, appointNodes = []) {
    // 只在富文本模式下可用，并且需要注册Formula插件
    if (!this.hasRichTextPlugin() || !this.mindMap.formula) return
    appointNodes = formatDataToArray(appointNodes)
    const list = appointNodes.length > 0 ? appointNodes : this.activeNodeList
    list.forEach(node => {
      this.mindMap.formula.insertFormulaToNode(node, formula)
    })
  }

  //  添加节点概要
  addGeneralization(data, openEdit = true, appointNodes = []) {
    appointNodes = formatDataToArray(appointNodes)
    const resolveLive = list => {
      const find =
        typeof this.findNodeByUid === 'function'
          ? this.findNodeByUid.bind(this)
          : null
      return (list || [])
        .map(node => {
          if (!node) return null
          const uid = (node.getData && node.getData('uid')) || node.uid
          return (uid && find && find(uid)) || node
        })
        .filter(node => node && typeof node.getData === 'function')
    }
    let source = resolveLive(
      appointNodes.length > 0 ? appointNodes : this.activeNodeList
    )
    if (source.length <= 1) {
      const select = this.mindMap.select
      const cached = resolveLive(
        select && typeof select.getMultiSelectCache === 'function'
          ? select.getMultiSelectCache()
          : []
      )
      const current = source[0]
      if (
        cached.length > 1 &&
        (!current ||
          (select &&
            typeof select.isNodeInList === 'function' &&
            select.isNodeInList(cached, current)))
      ) {
        source = cached
      }
    }
    if (source.length <= 0) {
      return
    }
    const nodeList = source.filter(node => {
      return (
        node &&
        !node.isRoot &&
        !node.isGeneralization &&
        !node.checkHasSelfGeneralization()
      )
    })
    const list = parseAddGeneralizationNodeList(nodeList)
    if (list.length <= 0) return
    const isRichText = this.hasRichTextPlugin()
    const { focusNewNode, inserting } = this.getNewNodeBehavior(
      openEdit,
      list.length > 1
    )
    let needRender = false
    const alreadyIsRichText = data && data.richText
    list.forEach(item => {
      const newData = {
        inserting,
        ...(data || {
          text: this.mindMap.opt.defaultGeneralizationText
        }),
        range: item.range || null,
        uid: createUid(),
        richText: isRichText,
        isActive: focusNewNode
      }
      if (isRichText && !alreadyIsRichText) newData.resetRichText = isRichText
      let generalization = item.node.getData('generalization')
      generalization = generalization
        ? Array.isArray(generalization)
          ? generalization
          : [generalization]
        : []
      // 如果是范围概要，那么检查该范围是否存在
      if (item.range) {
        const isExist = !!generalization.find(item2 => {
          return (
            item2.range &&
            item2.range[0] === item.range[0] &&
            item2.range[1] === item.range[1]
          )
        })
        if (isExist) {
          return
        }
        // 不存在则添加
        generalization.push(newData)
      } else {
        // 不是范围概要直接添加，因为前面已经判断过是否存在
        generalization.push(newData)
      }
      needRender = true
      this.mindMap.execCommand('SET_NODE_DATA', item.node, {
        generalization
      })
      // 插入子节点时自动展开子节点
      item.node.setData({
        expand: true
      })
    })
    if (!needRender) return
    // 需要清除原来激活的节点
    if (focusNewNode) {
      this.clearActiveNodeList()
    }
    this.mindMap.render(() => {
      // 修复祖先节点存在概要时位置未更新的问题
      // 修复同时给存在上下级关系的节点添加概要时重叠的问题
      this.mindMap.render()
    })
  }

  //  删除节点概要
  removeGeneralization() {
    if (this.activeNodeList.length <= 0) {
      return
    }

    // 概要节点的数据实际存在它的所属节点上。直接选中概要时，
    // node.checkHasGeneralization() 为 false，所以需要按所属节点反向删除对应条目。
    const selectedGeneralizationMap = new Map()
    const selectedOwnerNodes = new Set()
    this.activeNodeList.forEach(node => {
      if (node.isGeneralization) {
        const owner = node.generalizationBelongNode
        if (!owner) return
        if (!selectedGeneralizationMap.has(owner)) {
          selectedGeneralizationMap.set(owner, new Set())
        }
        selectedGeneralizationMap.get(owner).add(node.getData('uid'))
        return
      }
      if (!node.checkHasGeneralization()) {
        return
      }
      selectedOwnerNodes.add(node)
      this.mindMap.execCommand('SET_NODE_DATA', node, {
        generalization: null
      })
      if (typeof node.removeGeneralization === 'function') {
        node.removeGeneralization()
      }
    })

    selectedGeneralizationMap.forEach((uidSet, owner) => {
      // 所属节点也被选中时，上面已经删除了它的全部概要。
      if (selectedOwnerNodes.has(owner)) return
      const generalization = owner.getData('generalization')
      const list = Array.isArray(generalization)
        ? generalization
        : generalization
          ? [generalization]
          : []
      const nextList = list.filter(item => item && !uidSet.has(item.uid))
      this.mindMap.execCommand('SET_NODE_DATA', owner, {
        generalization: nextList.length ? nextList : null
      })
      if (!nextList.length && typeof owner.removeGeneralization === 'function') {
        owner.removeGeneralization()
      } else if (typeof owner.updateGeneralization === 'function') {
        owner.updateGeneralization()
      }
    })
    this.mindMap.render()
    this.closeHighlightNode()
  }

  //  设置节点自定义位置
  setNodeCustomPosition(node, left = undefined, top = undefined) {
    const nodeList = formatDataToArray(node)
    nodeList.forEach(item => {
      this.mindMap.execCommand('SET_NODE_DATA', item, {
        customLeft: left,
        customTop: top
      })
    })
  }

  //  一键整理布局，即去除自定义位置
  resetLayout() {
    walk(
      this.root,
      null,
      node => {
        node.customLeft = undefined
        node.customTop = undefined
        this.mindMap.execCommand('SET_NODE_DATA', node, {
          customLeft: undefined,
          customTop: undefined
        })
        this.mindMap.render()
      },
      null,
      true,
      0,
      0
    )
  }

  //  设置节点形状
  setNodeShape(node, shape) {
    if (!shape || !shapeList.includes(shape)) {
      return
    }
    let nodeList = [node] || this.activeNodeList
    nodeList.forEach(item => {
      this.setNodeStyle(item, 'shape', shape)
    })
  }

  // 定位到指定节点
  goTargetNode(node, callback = () => {}) {
    let uid = typeof node === 'string' ? node : node.getData('uid')
    if (!uid) return
    this.expandToNodeUid(uid, () => {
      let targetNode = this.findNodeByUid(uid)
      if (targetNode) {
        targetNode.active()
        this.moveNodeToCenter(targetNode)
        // 性能模式下 group 可能已被视口剔除；居中后强制补绘，避免搜索定位空白
        if (this.mindMap.opt.openPerformance) {
          if (!this.isNodeGroupAttached(targetNode)) {
            targetNode.render(() => {}, true)
          }
          if (this._viewportIndex && !this.isRendering) {
            this.paintViewport(new Set([targetNode])).catch(error =>
              this.mindMap.opt.errorHandler('render_error', error)
            )
          }
        }
        callback(targetNode)
      }
    })
  }

  //  更新节点数据
  setNodeData(node, data) {
    Object.keys(data).forEach(key => {
      node.nodeData.data[key] = data[key]
    })
  }

  //  设置节点数据，并判断是否渲染
  setNodeDataRender(node, data, notRender = false) {
    this.mindMap.execCommand('SET_NODE_DATA', node, data)
    if (isNodeNotNeedRenderData(data)) {
      this.mindMap.emit('node_tree_render_end')
      return
    }
    this.reRenderNodeCheckChange(node, notRender)
  }

  // 重新节点某个节点，判断节点大小是否发生了改变，是的话触发重绘
  reRenderNodeCheckChange(node, notRender) {
    const oldHeight = node.height
    let changed = node.reRender()
    if (changed) {
      // A right-growing logical leaf with unchanged height has no descendants
      // to move, and its incoming connector's left endpoint stays fixed.
      // Summaries/compact routes/other layouts retain the full correct path.
      let hasSummary = node.isGeneralization
      for (let current = node; current; current = current.parent) {
        if (current.checkHasGeneralization()) hasSummary = true
      }
      if (!notRender && !hasSummary && !node.isRoot && node.customLeft === undefined && node.customTop === undefined && !node.children.length &&
        oldHeight === node.height && this.mindMap.opt.layout === CONSTANTS.LAYOUT.LOGICAL_STRUCTURE &&
        !this.mindMap.opt.compactLayout && !this.mindMap.themeConfig.nodeUseLineStyle) {
        this._layoutEpoch = (this._layoutEpoch || 0) + 1
        const metadata = { reason: 'layout', layoutEpoch: this._layoutEpoch }
        if (this.mindMap.opt.openPerformance) {
          if (!this._viewportIndex || !this._viewportIndex.update({ node, bounds: {
            left: node.left, top: node.top, right: node.left + node.width, bottom: node.top + node.height
          } })) {
            this.mindMap.render()
            return
          }
          if (node.group && node.group.node.parentNode) this._visibleViewportNodes.add(node)
          this.paintViewport(new Set([node])).then(completed => {
            if (completed && !this._destroyed) this.mindMap.emit('node_tree_render_end', metadata)
          }).catch(error => this.mindMap.opt.errorHandler('render_error', error))
        } else this.mindMap.emit('node_tree_render_end', metadata)
        return
      }
      if (!notRender) this.mindMap.render()
    } else {
      this.mindMap.emit('node_tree_render_end')
    }
  }

  // 移动节点到画布中心
  // resetScale参数指定是否要将画布缩放值复位为100%，当你没有显式传递时，默认值为undefined，因为实例化选项的resetScaleOnMoveNodeToCenter配置也会决定是否复位缩放，所以当你没有显式传递时使用resetScaleOnMoveNodeToCenter配置，否则使用resetScale配置
  moveNodeToCenter(node, resetScale) {
    let { resetScaleOnMoveNodeToCenter } = this.mindMap.opt
    if (resetScale !== undefined) {
      resetScaleOnMoveNodeToCenter = resetScale
    }
    let { transform, state } = this.mindMap.view.getTransformData()
    let { left, top, width, height } = node
    if (!resetScaleOnMoveNodeToCenter) {
      left *= transform.scaleX
      top *= transform.scaleY
      width *= transform.scaleX
      height *= transform.scaleY
    }
    let halfWidth = this.mindMap.width / 2
    let halfHeight = this.mindMap.height / 2
    let nodeCenterX = left + width / 2
    let nodeCenterY = top + height / 2
    let targetX = halfWidth - state.x
    let targetY = halfHeight - state.y
    let offsetX = targetX - nodeCenterX
    let offsetY = targetY - nodeCenterY
    this.mindMap.view.translateX(offsetX)
    this.mindMap.view.translateY(offsetY)
    if (resetScaleOnMoveNodeToCenter) {
      this.mindMap.view.setScale(1)
    }
  }

  // 回到中心主题，即设置根节点到画布中心
  setRootNodeCenter() {
    this.moveNodeToCenter(this.root)
  }

  // 展开到指定uid的节点
  expandToNodeUid(uid, callback = () => {}) {
    if (!this.renderTree) {
      callback()
      return
    }
    let parentsList = []
    let isGeneralization = false
    const cache = {}
    bfsWalk(this.renderTree, (node, parent) => {
      if (node.data.uid === uid) {
        parentsList = parent ? [...cache[parent.data.uid], parent] : []
        return 'stop'
      }
      const generalizationList = formatGetNodeGeneralization(node.data)
      generalizationList.forEach(item => {
        if (item.uid === uid) {
          parentsList = parent ? [...cache[parent.data.uid], parent, node] : []
          isGeneralization = true
        }
      })
      if (isGeneralization) {
        return 'stop'
      }
      cache[node.data.uid] = parent ? [...cache[parent.data.uid], parent] : []
    })
    let needRender = false
    parentsList.forEach(node => {
      if (!node.data.expand) {
        needRender = true
        node.data.expand = true
      }
    })
    // 如果是展开到概要节点，那么父节点下的所有节点都需要开
    if (isGeneralization) {
      const lastNode = parentsList[parentsList.length - 1]
      if (lastNode) {
        walk(lastNode, null, node => {
          if (!node.data.expand) {
            needRender = true
            node.data.expand = true
          }
        })
      }
    }
    if (needRender) {
      // Temporary reveal for search/locate. Do not persist as a user preference.
      this.mindMap.emit('personal_expand_change', { source: 'reveal' })
      this.mindMap.render(callback)
    } else {
      callback()
    }
  }

  registerNodeIndex(node) {
    if (!node) return
    if (!this.nodeIndex) this.nodeIndex = new Map()
    const pending = [node], seen = new Set()
    while (pending.length) {
      const current = pending.pop()
      if (!current || seen.has(current)) continue
      seen.add(current)
      const uid = getNodeUid(current)
      if (uid) this.nodeIndex.set(uid, current)
      ;(current.children || []).forEach(child => pending.push(child))
      ;(current._generalizationList || []).forEach(item => pending.push(item.generalizationNode))
    }
  }

  unregisterNodeIndex(node) {
    if (!node || !this.nodeIndex) return
    const pending = [node], seen = new Set()
    while (pending.length) {
      const current = pending.pop()
      if (!current || seen.has(current)) continue
      seen.add(current)
      const uid = getNodeUid(current)
      // A late callback from an old instance cannot remove the new one.
      if (this.nodeIndex.get(uid) === current) this.nodeIndex.delete(uid)
      ;(current.children || []).forEach(child => pending.push(child))
      ;(current._generalizationList || []).forEach(item => pending.push(item.generalizationNode))
    }
  }

  rebuildNodeIndex() {
    this.nodeIndex = new Map()
    this.registerNodeIndex(this.root)
    this._nodeIndexRoot = this.root
  }

  // Current rendered model only, including nested summary subtrees.
  findNodeByUid(uid) {
    if (!this.root) return
    if (!this.nodeIndex || this._nodeIndexRoot !== this.root) this.rebuildNodeIndex()
    return this.nodeIndex.get(uid)
  }

  // 高亮节点或子节点
  highlightNode(node, range, style) {
    // 如果当前正在渲染，那么不进行高亮，因为节点位置可能不正确
    if (this.isRendering) return
    style = {
      stroke: 'rgb(94, 200, 248)',
      fill: 'transparent',
      ...(style || {})
    }
    // 尚未创建
    if (!this.highlightBoxNode) {
      this.highlightBoxNode = new Polygon()
        .stroke({
          color: style.stroke || 'transparent'
        })
        .fill({
          color: style.fill || 'transparent'
        })
    } else if (this.highlightBoxNodeStyle) {
      // 样式更新了
      if (
        this.highlightBoxNodeStyle.stroke !== style.stroke ||
        this.highlightBoxNodeStyle.fill !== style.fill
      ) {
        this.highlightBoxNode
          .stroke({
            color: style.stroke || 'transparent'
          })
          .fill({
            color: style.fill || 'transparent'
          })
      }
    }
    this.highlightBoxNodeStyle = { ...style }
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity
    if (range) {
      const children = node.children.slice(range[0], range[1] + 1)
      children.forEach(child => {
        if (child.left < minx) {
          minx = child.left
        }
        if (child.top < miny) {
          miny = child.top
        }
        const right = child.left + child.width
        const bottom = child.top + child.height
        if (right > maxx) {
          maxx = right
        }
        if (bottom > maxy) {
          maxy = bottom
        }
      })
    } else {
      minx = node.left
      miny = node.top
      maxx = node.left + node.width
      maxy = node.top + node.height
    }
    this.highlightBoxNode.plot([
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy]
    ])
    this.mindMap.otherDraw.add(this.highlightBoxNode)
  }

  // 关闭高亮
  closeHighlightNode() {
    if (!this.highlightBoxNode) return
    this.highlightBoxNode.remove()
  }

  // 是否存在富文本插件
  hasRichTextPlugin() {
    return !!this.mindMap.richText
  }
}

export default Render
