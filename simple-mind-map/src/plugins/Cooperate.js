import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import {
  isSameObject,
  simpleDeepClone,
  getType,
  isUndef,
  getTextFromHtml,
  transformTreeDataToObject,
  transformObjectToTreeData,
  removeFromParentNodeData,
  copyNodeTree
} from '../utils/index'
import { applyObjectToYMap, migrateLegacyNodes } from './cooperateYjs'

function collapseDeepNodes(root, keepDepth = 2) {
  const stack = root ? [{ node: root, depth: 0 }] : []
  while (stack.length) {
    const { node, depth } = stack.pop()
    if (!node || !node.data) continue
    const children = node.children || []
    if (depth >= keepDepth && children.length > 0) {
      node.data.expand = false
    }
    for (let i = 0; i < children.length; i++) {
      stack.push({ node: children[i], depth: depth + 1 })
    }
  }
}

const INSERT_COMMANDS = {
  INSERT_NODE: true,
  INSERT_MULTI_NODE: true,
  INSERT_CHILD_NODE: true,
  INSERT_MULTI_CHILD_NODE: true,
  INSERT_PARENT_NODE: true,
  PASTE_NODE: true
}

const MOVE_COMMANDS = {
  UP_NODE: true,
  DOWN_NODE: true,
  MOVE_UP_ONE_LEVEL: true,
  MOVE_NODE_TO: true,
  INSERT_AFTER: true,
  INSERT_BEFORE: true,
  INSERT_PARENT_NODE: true
}

const STRUCTURE_COMMANDS = {
  ...INSERT_COMMANDS,
  ...MOVE_COMMANDS,
  REMOVE_NODE: true,
  REMOVE_CURRENT_NODE: true,
  CUT_NODE: true,
  ADD_GENERALIZATION: true,
  REMOVE_GENERALIZATION: true
}

const RECENT_HTTP_MS = 8000
const RECENT_PUSH_GRACE_MS = 2500

function pruneRecentMap(map, maxAge = RECENT_HTTP_MS) {
  const now = Date.now()
  map.forEach((at, uid) => {
    if (now - at > maxAge) map.delete(uid)
  })
}

function keepHttpChild(uid, serverKids, lastPushed, recentPushed) {
  if (!uid) return true
  if (serverKids.has(uid)) return true
  // Not uploaded yet: keep so a delayed add is not wiped by a stale poll.
  if (!lastPushed[uid]) return true
  const at = recentPushed && recentPushed.get(uid)
  return !!(at && Date.now() - at < RECENT_PUSH_GRACE_MS)
}

// 协同插件
class Cooperate {
  constructor(opt) {
    this.opt = opt
    this.mindMap = opt.mindMap
    // yjs文档
    this.ydoc = new Y.Doc()
    // 共享数据
    this.ymap = null
    // 连接提供者
    this.provider = null
    // 感知数据
    this.awareness = null
    this.currentAwarenessData = []
    this.waitNodeUidMap = {} // 该列表中的uid对应的节点还未渲染完毕
    // 当前的平级对象类型的思维导图数据
    this.currentData = null
    // 用户信息
    this.userInfo = null
    // 是否正在重新设置思维导图数据
    this.isSetData = false
    // 尚未写入 ydoc 的本地数据，等同步完成后再决定推送还是采用远端
    this.pendingInitData = this.mindMap.opt.data
      ? simpleDeepClone(this.mindMap.opt.data)
      : null
    this.hasAppliedSync = false
    this.isApplyingRemote = false
    this.pendingRemoteTree = null
    this.observeApplyTimer = null
    this.pendingLocalData = null
    this.localApplyTimer = null
    this.largeMapModeEnabled = false
    this.pendingRemoteUids = new Set()
    this.pendingRemoteAdded = new Set()
    this.pendingRemoteDeleted = new Set()
    this.pendingRemoteStructure = false
    this.suppressLocalUntil = 0
    this.recentDeleted = new Map()
    this.expectRemoteDoc = false
    this.previewApplied = false
    this.hydratingCurrentData = false
    this.httpCollabMode = false
    this.httpRoomKey = ''
    this.httpFetchSubtree = null
    this.httpFetchDeepSubtree = null
    this.httpFetchExportTree = null
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpDeleteNode = null
    this.httpUpdatedAt = ''
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    this.httpTextTimer = null
    this.httpStructureTimer = null
    this.httpInsertPromise = null
    this.httpInsertRescan = false
    this.httpHydrating = false
    this.localOrigin = { source: 'simple-mind-map-cooperate' }
    // 绑定事件
    this.bindEvent()
  }

  mapSize() {
    return this.currentData ? Object.keys(this.currentData).length : 0
  }

  largeMapDelay(smallMs, largeMs) {
    return this.mapSize() >= 200 ? largeMs : smallMs
  }

  // 初始化数据
  initData(data, { replace = false } = {}) {
    data = simpleDeepClone(data)
    // 解绑原来的数据
    if (this.ymap) {
      this.ymap.unobserveDeep(this.onObserve)
    }
    // 创建共享数据
    this.ymap = this.ydoc.getMap()
    // 思维导图树结构转平级对象结构
    this.currentData = transformTreeDataToObject(data)
    const previousData = this.ymap.toJSON()
    applyObjectToYMap(this.ymap, this.currentData, previousData, {
      origin: this.localOrigin,
      replace
    })
    this.currentData = this.ymap.toJSON()
    // 监听数据同步
    this.onObserve = this.onObserve.bind(this)
    this.ymap.observeDeep(this.onObserve)
  }

  // 获取yjs doc实例
  getDoc() {
    return this.ydoc
  }

  // 设置连接提供者
  setProvider(provider, webrtcProviderConfig = {}) {
    this.disconnectProvider({ recreateDoc: false })
    const { roomName, signalingList, ...otherConfig } = webrtcProviderConfig
    this.hasAppliedSync = false
    this.provider =
      provider ||
      new WebrtcProvider(roomName, this.ydoc, {
        signaling: signalingList,
        ...otherConfig
      })
    this.awareness = this.provider.awareness

    // 监听状态同步事件
    this.onAwareness = this.onAwareness.bind(this)
    this.awareness.on('change', this.onAwareness)
    this.publishAwareness([])
    this.bindProviderSync()
  }

  // 等待文档同步后再决定采用远端数据还是推送本地数据
  bindProviderSync() {
    const apply = () => {
      if (this.hasAppliedSync) return
      this.hasAppliedSync = true
      this.applySyncedDoc()
    }
    if (this.provider && typeof this.provider.on === 'function') {
      this.provider.on('sync', isSynced => {
        if (isSynced !== false) apply()
      })
      this.provider.on('synced', synced => {
        if (synced !== false) apply()
      })
    }
    if (this.provider && this.provider.synced) {
      apply()
      return
    }
  }

  setExpectRemoteDoc(value) {
    this.expectRemoteDoc = !!value
  }

  setPreviewApplied(applied) {
    this.previewApplied = !!applied
  }

  applySyncedDoc() {
    this.ymap = this.ydoc.getMap()
    migrateLegacyNodes(this.ymap)
    if (this.onObserve) {
      try {
        this.ymap.unobserveDeep(this.onObserve)
      } catch (e) {
        // ignore
      }
    }
    this.onObserve = this.onObserve.bind(this)
    this.ymap.observeDeep(this.onObserve)
    const remoteSize = [...this.ymap.keys()].length
    if (remoteSize > 0) {
      this.enableLargeMapMode(remoteSize)
      if (this.previewApplied || remoteSize >= 200) {
        this.suppressLocalUntil = Date.now() + (remoteSize >= 200 ? 4000 : 250)
        if (!this.previewApplied) {
          const res = transformObjectToTreeData(this.ymapToShallowJSON())
          if (res) {
            collapseDeepNodes(res, 2)
            this.applyRemoteTree(res)
          }
        }
        if (remoteSize < 400) this.scheduleCurrentDataHydrate()
      } else {
        const data = this.ymap.toJSON()
        this.currentData = data
        const res = transformObjectToTreeData(data)
        if (res) this.applyRemoteTree(res)
      }
      this.previewApplied = false
      this.expectRemoteDoc = false
      this.pendingInitData = null
      return
    }
    if (this.expectRemoteDoc || this.previewApplied) {
      this.expectRemoteDoc = false
      this.previewApplied = false
      return
    }
    if (this.pendingInitData) {
      this.initData(this.pendingInitData, { replace: true })
    }
  }

  ymapToShallowJSON() {
    const data = {}
    this.ymap.forEach((value, uid) => {
      if (!value || typeof value.toJSON !== 'function') return
      const json = value.toJSON()
      data[uid] = {
        isRoot: !!json.isRoot,
        data: json.data || {},
        children: json.children || []
      }
    })
    return data
  }

  scheduleCurrentDataHydrate() {
    if (!this.ymap) return
    this.hydratingCurrentData = true
    const keys = Array.from(this.ymap.keys())
    const next = {}
    let index = 0
    const step = () => {
      if (!this.ymap) {
        this.hydratingCurrentData = false
        return
      }
      const end = Math.min(index + 250, keys.length)
      for (; index < end; index++) {
        const uid = keys[index]
        const value = this.ymap.get(uid)
        next[uid] =
          value && typeof value.toJSON === 'function' ? value.toJSON() : value
      }
      if (index < keys.length) {
        setTimeout(step, 0)
        return
      }
      this.currentData = next
      this.hydratingCurrentData = false
    }
    step()
  }

  hydrateLazyChildren(node) {
    if (!node) return
    const data = node.nodeData
    const live = data && data.children && data.children.length
    const count = Number(node.getData && node.getData('childCount')) || 0
    const uid = node.getData && node.getData('uid')
    if (live && this.hydratedUids.has(uid) && (!count || live >= count)) return
    if (this.httpFetchSubtree) {
      if (!live && count <= 0) return
      return this.hydrateFromHttp(node)
    }
    if (!this.ymap) return
    if (!uid) return
    const nodeMap = this.ymap.get(uid)
    if (!nodeMap || typeof nodeMap.get !== 'function') return
    const children = nodeMap.get('children')
    const childUids =
      children && typeof children.toArray === 'function' ? children.toArray() : []
    if (!data) return
    if (!data.children) data.children = []
    const have = new Set(
      data.children.map(child => child && child.data && child.data.uid)
    )
    childUids.forEach(childUid => {
      if (have.has(childUid)) return
      const childMap = this.ymap.get(childUid)
      if (!childMap || typeof childMap.toJSON !== 'function') return
      const json = childMap.toJSON()
      data.children.push({
        data: {
          ...(json.data || {}),
          uid: childUid,
          expand: false,
          childCount: Array.isArray(json.children) ? json.children.length : 0
        },
        children: []
      })
    })
  }

  // 断开协同连接
  disconnectProvider({ recreateDoc = true } = {}) {
    if (this.awareness) {
      this.awareness.off('change', this.onAwareness)
      try {
        this.awareness.setLocalState(null)
      } catch (e) {
        // ignore
      }
    }
    if (this.provider && typeof this.provider.destroy === 'function') {
      this.provider.destroy()
    }
    this.provider = null
    this.awareness = null
    this.currentAwarenessData = []
    this.waitNodeUidMap = {}
    this.hasAppliedSync = false
    if (!recreateDoc) return
    this.previewApplied = false
    if (this.ymap && this.onObserve) {
      this.ymap.unobserveDeep(this.onObserve)
    }
    this.ymap = null
    this.currentData = null
    try {
      this.pendingInitData = simpleDeepClone(this.mindMap.getData())
    } catch (e) {
      // ignore
    }
    if (this.ydoc) {
      this.ydoc.destroy()
    }
    this.ydoc = new Y.Doc()
  }

  // 绑定事件
  bindEvent() {
    // 监听思维导图改变
    this.onDataChange = this.onDataChange.bind(this)
    this.mindMap.on('data_change', this.onDataChange)

    // 监听思维导图节点激活事件
    this.onNodeActive = this.onNodeActive.bind(this)
    this.mindMap.on('node_active', this.onNodeActive)

    // 监听思维导图渲染完毕事件
    this.onNodeTreeRenderEnd = this.onNodeTreeRenderEnd.bind(this)
    this.mindMap.on('node_tree_render_end', this.onNodeTreeRenderEnd)

    // 监听设置思维导图数据事件
    this.onSetData = this.onSetData.bind(this)
    this.onBeforeSetData = this.onBeforeSetData.bind(this)
    this.mindMap.on('before_set_data', this.onBeforeSetData)
    this.mindMap.on('set_data', this.onSetData)
    this.onAfterExecCommand = this.onAfterExecCommand.bind(this)
    this.mindMap.on('afterExecCommand', this.onAfterExecCommand)
    this.onBeforeExecCommand = this.onBeforeExecCommand.bind(this)
    this.mindMap.on('beforeExecCommand', this.onBeforeExecCommand)
    this.onExpandBtnClick = this.onExpandBtnClick.bind(this)
    this.mindMap.on('expand_btn_click', this.onExpandBtnClick)
  }

  // 解绑事件
  unBindEvent() {
    clearTimeout(this.observeApplyTimer)
    clearTimeout(this.localApplyTimer)
    this.observeApplyTimer = null
    this.localApplyTimer = null
    this.pendingRemoteTree = null
    this.pendingRemoteUids = new Set()
    this.pendingRemoteAdded = new Set()
    this.pendingRemoteDeleted = new Set()
    this.pendingRemoteStructure = false
    this.pendingLocalData = null
    this.disconnectProvider()
    this.mindMap.off('data_change', this.onDataChange)
    this.mindMap.off('node_active', this.onNodeActive)
    this.mindMap.off('node_tree_render_end', this.onNodeTreeRenderEnd)
    this.mindMap.off('before_set_data', this.onBeforeSetData)
    this.mindMap.off('set_data', this.onSetData)
    this.mindMap.off('afterExecCommand', this.onAfterExecCommand)
    if (this.onBeforeExecCommand) {
      this.mindMap.off('beforeExecCommand', this.onBeforeExecCommand)
    }
    this.mindMap.off('expand_btn_click', this.onExpandBtnClick)
    clearTimeout(this.httpTextTimer)
    clearTimeout(this.httpStructureTimer)
  }

  // 数据同步时的处理，更新当前思维导图
  onObserve(events, transaction) {
    if (
      transaction &&
      (transaction.origin === this.localOrigin ||
        transaction.origin === 'cooperate-schema-migration')
    ) {
      return
    }
    const changedRootKeys = events
      .filter(event => event.target === this.ymap && event.changes)
      .flatMap(event => Array.from(event.changes.keys.keys()))
    const hasLegacyNode = changedRootKeys.some(
      key => !(this.ymap.get(key) instanceof Y.Map)
    )
    if (hasLegacyNode) {
      migrateLegacyNodes(this.ymap)
    }
    events.forEach(event => {
      if (event.target === this.ymap && event.changes) {
        event.changes.keys.forEach((change, key) => {
          this.pendingRemoteUids.add(key)
          if (change.action === 'add') this.pendingRemoteAdded.add(key)
          if (change.action === 'delete') this.pendingRemoteDeleted.add(key)
          if (change.action !== 'update') this.pendingRemoteStructure = true
        })
        return
      }
      const path = event.path || []
      if (typeof path[0] === 'string') this.pendingRemoteUids.add(path[0])
      if (path[1] === 'children') this.pendingRemoteStructure = true
    })
    clearTimeout(this.observeApplyTimer)
    this.observeApplyTimer = setTimeout(() => {
      this.flushRemoteObserve()
    }, this.largeMapDelay(50, 200))
  }

  flushRemoteObserve() {
    if (!this.ymap) return
    this.flushLocalNow()
    const uids = Array.from(this.pendingRemoteUids)
    const added = Array.from(this.pendingRemoteAdded)
    const deleted = Array.from(this.pendingRemoteDeleted)
    const structure = this.pendingRemoteStructure
    this.pendingRemoteUids = new Set()
    this.pendingRemoteAdded = new Set()
    this.pendingRemoteDeleted = new Set()
    this.pendingRemoteStructure = false
    this.enableLargeMapMode(this.ymap.size || this.mapSize())
    if (!structure && uids.length > 0 && uids.length <= 12) {
      if (this.applyRemoteNodePatch(uids)) return
    }
    if (structure && added.length === 1 && deleted.length === 0) {
      if (this.applyRemoteInsert(added[0])) return
    }
    if (structure && deleted.length === 1 && added.length === 0) {
      if (this.applyRemoteRemove(deleted[0])) return
    }
    if ((this.ymap.size || 0) >= 200) {
      if (uids.length) this.applyRemoteNodePatch(uids.slice(0, 20))
      return
    }
    const data = this.ymap.toJSON()
    this.currentData = data
    const res = transformObjectToTreeData(data)
    if (!res) return
    this.applyRemoteTree(res)
  }

  applyRemoteNodePatch(uids) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || typeof renderer.findNodeByUid !== 'function') return false
    const nextNodes = []
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i]
      const nodeMap = this.ymap.get(uid)
      if (!nodeMap || typeof nodeMap.toJSON !== 'function') return false
      const json = nodeMap.toJSON()
      const node = renderer.findNodeByUid(uid)
      if (!node) return false
      nextNodes.push({ uid, json, node })
    }
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      nextNodes.forEach(({ uid, json, node }) => {
        if (this.currentData) this.currentData[uid] = json
        const data = json.data || {}
        renderer.setNodeData(node, {
          text: data.text,
          note: data.note,
          richText: data.richText
        })
        renderer.reRenderNodeCheckChange(node, true)
      })
    } catch (err) {
      return false
    } finally {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
    return true
  }

  findRemoteParentUid(uid) {
    let parentUid = ''
    this.ymap.forEach((value, key) => {
      if (parentUid || key === uid || !(value instanceof Y.Map)) return
      const children = value.get('children')
      if (
        children &&
        typeof children.toArray === 'function' &&
        children.toArray().includes(uid)
      ) {
        parentUid = key
      }
    })
    return parentUid
  }

  applyRemoteInsert(uid) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || typeof renderer.findNodeByUid !== 'function') return false
    if (renderer.findNodeByUid(uid)) return true
    const nodeMap = this.ymap.get(uid)
    if (!nodeMap || typeof nodeMap.toJSON !== 'function') return false
    const json = nodeMap.toJSON()
    const parentUid = this.findRemoteParentUid(uid)
    if (!parentUid) return false
    const parentNode = renderer.findNodeByUid(parentUid)
    if (!parentNode) return false
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      if (!parentNode.nodeData.children) parentNode.nodeData.children = []
      const exists = parentNode.nodeData.children.some(
        child => child && child.data && child.data.uid === uid
      )
      if (!exists) {
        const data = json.data || {}
        parentNode.nodeData.children.push({
          data: {
            uid,
            text: data.text,
            note: data.note,
            richText: data.richText,
            expand: data.expand !== false
          },
          children: []
        })
      }
      renderer.setNodeData(parentNode, { expand: true })
      this.mindMap.render()
      if (this.currentData) {
        this.currentData[uid] = json
        const parent = this.currentData[parentUid]
        if (parent) {
          const children = parent.children || []
          if (!children.includes(uid)) parent.children = [...children, uid]
        }
      }
    } catch (err) {
      return false
    } finally {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
    return true
  }

  applyRemoteRemove(uid) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || typeof renderer.findNodeByUid !== 'function') return false
    const node = renderer.findNodeByUid(uid)
    if (!node || node.isRoot) return false
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      removeFromParentNodeData(node)
      this.mindMap.render()
      if (this.currentData) {
        Object.keys(this.currentData).forEach(key => {
          const children = this.currentData[key] && this.currentData[key].children
          if (Array.isArray(children) && children.includes(uid)) {
            this.currentData[key].children = children.filter(child => child !== uid)
          }
        })
        delete this.currentData[uid]
      }
    } catch (err) {
      return false
    } finally {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
    return true
  }

  // 大文件优先使用性能模式，避免远端全量同步后逐字编辑触发高频重排
  enableLargeMapMode(nodeCount) {
    if (nodeCount < 200 || this.largeMapModeEnabled) return
    this.largeMapModeEnabled = true
    this.mindMap.updateConfig({
      openPerformance: true,
      openRealtimeRenderOnNodeTextEdit: false,
      isShowExpandNum: true
    })
  }

  // 概要不是树里的子节点，对端更新后需要再排一次版才会画出来
  applyRemoteTree(res) {
    if (this.isApplyingRemote) {
      this.pendingRemoteTree = res
      return
    }
    this.isApplyingRemote = true
    const done = () => {
      this.suppressLocalUntil =
        Date.now() + (this.largeMapModeEnabled ? 2000 : 250)
      this.isApplyingRemote = false
      if (this.pendingRemoteTree) {
        const next = this.pendingRemoteTree
        this.pendingRemoteTree = null
        this.applyRemoteTree(next)
      }
    }
    try {
      // 避免 updateData 自带的 render + addHistory 叠加二次 render
      const data = this.mindMap.handleData(res)
      this.mindMap.emit('before_update_data', data)
      this.mindMap.command.pause()
      this.mindMap.renderer.setData(data)
      this.mindMap.render(() => {
        try {
          this.mindMap.command.recovery()
        } finally {
          done()
        }
      })
      this.mindMap.emit('update_data', data)
    } catch (err) {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      done()
      throw err
    }
  }

  // 当前思维导图改变后的处理，触发同步
  onDataChange(data) {
    if (
      this.isSetData ||
      this.isApplyingRemote ||
      this.previewApplied ||
      this.hydratingCurrentData ||
      this.httpHydrating
    ) {
      return
    }
    if (this.httpCollabMode) {
      this.scheduleHttpTextSync()
      // Some large-map commands finish through a deferred render path. In that
      // path afterExecCommand can be intentionally ignored while the renderer
      // is busy, so structure changes must also be recovered from data_change.
      this.scheduleHttpStructureSync()
      return
    }
    if (Date.now() < this.suppressLocalUntil) return
    if (!this.ymap) {
      this.pendingInitData = data
      return
    }
    this.pendingLocalData = data
    clearTimeout(this.localApplyTimer)
    this.localApplyTimer = setTimeout(() => {
      this.localApplyTimer = null
      this.flushLocalNow()
    }, this.largeMapDelay(80, 220))
  }

  onAfterExecCommand(name) {
    if (
      this.isSetData ||
      this.isApplyingRemote ||
      this.previewApplied ||
      this.hydratingCurrentData ||
      this.httpHydrating ||
      (this.mindMap.renderer && this.mindMap.renderer._lazyCommandPending)
    ) {
      return
    }
    if (this.httpCollabMode) {
      this.onHttpCommand(name)
      return
    }
    if (!this.ymap || !STRUCTURE_COMMANDS[name]) return
    if (name === 'BACK' || name === 'FORWARD') this.recentDeleted.clear()
    const data = this.mindMap.command.getCopyData()
    if (!data) return
    this.pendingLocalData = data
    this.flushLocalNow()
  }

  flushLocalNow() {
    clearTimeout(this.localApplyTimer)
    this.localApplyTimer = null
    const pending = this.pendingLocalData
    this.pendingLocalData = null
    if (pending && this.ymap) this.flushLocalDataChange(pending)
  }

  flushLocalDataChange(data) {
    const res = transformTreeDataToObject(data)
    this.updateChanges(res)
  }

  // 找出更新点
  updateChanges(data) {
    const { beforeCooperateUpdate } = this.mindMap.opt
    const oldData = this.currentData || {}
    const now = Date.now()
    this.recentDeleted.forEach((at, uid) => {
      if (now - at > 8000) this.recentDeleted.delete(uid)
    })
    Object.keys(data).forEach(uid => {
      if (!this.recentDeleted.has(uid) || oldData[uid]) return
      delete data[uid]
      Object.keys(data).forEach(parentUid => {
        const children = data[parentUid] && data[parentUid].children
        if (!Array.isArray(children) || !children.includes(uid)) return
        data[parentUid].children = children.filter(child => child !== uid)
      })
    })
    const createOrUpdateList = []
    Object.keys(data).forEach(uid => {
      if (!oldData[uid] || !isSameObject(oldData[uid], data[uid])) {
        createOrUpdateList.push({ uid, data: data[uid], oldData: oldData[uid] })
      }
    })
    if (beforeCooperateUpdate && createOrUpdateList.length > 0) {
      beforeCooperateUpdate({ type: 'createOrUpdate', list: createOrUpdateList, data })
    }
    const deleteList = Object.keys(oldData)
      .filter(uid => !data[uid])
      .map(uid => ({ uid, data: oldData[uid] }))
    deleteList.forEach(item => this.recentDeleted.set(item.uid, now))
    if (beforeCooperateUpdate && deleteList.length > 0) {
      beforeCooperateUpdate({ type: 'delete', list: deleteList })
    }
    if (createOrUpdateList.length === 0 && deleteList.length === 0) return
    const patch = {}
    createOrUpdateList.forEach(item => {
      patch[item.uid] = data[item.uid]
    })
    applyObjectToYMap(this.ymap, patch, oldData, {
      origin: this.localOrigin,
      deleteUids: deleteList.map(item => item.uid)
    })
    const next = { ...oldData, ...patch }
    deleteList.forEach(item => {
      delete next[item.uid]
    })
    this.currentData = next
  }

  // 节点激活状态改变后触发感知数据同步
  onNodeActive(node, nodeList) {
    this.publishAwareness((nodeList || []).map(item => item.uid))
    if (node) this.repairEmptyExpand(node)
  }

  onExpandBtnClick(node) {
    if (!node) return
    const live = node.nodeData && node.nodeData.children && node.nodeData.children.length
    if (node.getData('expand') && !live) this.repairEmptyExpand(node)
  }

  async repairEmptyExpand(node) {
    if (!node || this._repairingExpand) return
    const childCount = Number(node.getData && node.getData('childCount')) || 0
    const live =
      node.nodeData && node.nodeData.children && node.nodeData.children.length
    if (live || childCount <= 0) return
    const uid = node.getData && node.getData('uid')
    if (uid && this.hydrateFailedUids.has(uid)) return
    this._repairingExpand = true
    try {
      await this.hydrateLazyChildren(node)
      if (node.nodeData && node.nodeData.children && node.nodeData.children.length) {
        this.mindMap.execCommand('SET_NODE_EXPAND', node, true)
      }
    } finally {
      this._repairingExpand = false
    }
  }

  // 节点树渲染完毕事件
  onNodeTreeRenderEnd() {
    Object.keys(this.waitNodeUidMap).forEach(uid => {
      const node = this.mindMap.renderer.findNodeByUid(uid)
      if (node) {
        node.addUser(this.waitNodeUidMap[uid])
      }
    })
    this.waitNodeUidMap = {}
  }

  onBeforeSetData() {
    clearTimeout(this.localApplyTimer)
    this.localApplyTimer = null
    this.pendingLocalData = null
    this.isSetData = true
  }

  // 监听思维导图数据的重新设置事件
  onSetData(data) {
    if (this.previewApplied || this.httpCollabMode) {
      this.isSetData = false
      this.pendingInitData = null
      return
    }
    this.pendingInitData = data
    if (this.ymap) {
      this.initData(data, { replace: true })
    }
    this.isSetData = false
  }

  setLazyLoaders(config = {}) {
    if (config.roomKey) this.httpRoomKey = config.roomKey
    if (config.fetchSubtree) this.httpFetchSubtree = config.fetchSubtree
    if (config.fetchDeepSubtree) this.httpFetchDeepSubtree = config.fetchDeepSubtree
    if (config.fetchExportTree) this.httpFetchExportTree = config.fetchExportTree
    if (config.fetchNodes) this.httpFetchNodes = config.fetchNodes
    if (config.fetchLocate) this.httpFetchLocate = config.fetchLocate
    if (config.patchNode) this.httpPatchNode = config.patchNode
    if (config.addNode) this.httpAddNode = config.addNode
    if (config.deleteNode) this.httpDeleteNode = config.deleteNode
    if (config.updatedAt) this.httpUpdatedAt = config.updatedAt
  }

  setHttpCollab(config = {}) {
    this.setLazyLoaders(config)
    this.httpCollabMode = true
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.enableLargeMapMode(config.nodeCount || 400)
  }

  clearHttpCollab() {
    this.httpCollabMode = false
    this.httpRoomKey = ''
    this.httpFetchSubtree = null
    this.httpFetchDeepSubtree = null
    this.httpFetchExportTree = null
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpDeleteNode = null
    this.httpUpdatedAt = ''
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    this.httpInsertRescan = false
  }

  mergeHttpChildren(data, incoming) {
    if (!data) return
    if (!data.children) data.children = []
    const have = new Set(
      data.children.map(child => child && child.data && child.data.uid)
    )
    ;(incoming || []).forEach(child => {
      const uid = child && child.data && child.data.uid
      if (!uid || have.has(uid)) return
      data.children.push(child)
      have.add(uid)
      this.markUidPushed(uid, child.data)
    })
  }

  markUidPushed(uid, data) {
    if (!uid || this.lastPushed[uid]) return
    this.lastPushed[uid] = {
      text: data && data.text ? String(data.text) : '',
      note: (data && data.note) || ''
    }
  }

  markTreeUids(root) {
    const walk = node => {
      if (!node) return
      const data = node.data || (node.nodeData && node.nodeData.data)
      const uid = data && data.uid
      this.markUidPushed(uid, data)
      const kids = node.children || (node.nodeData && node.nodeData.children) || []
      kids.forEach(walk)
    }
    walk(root)
  }

  nodeNeedsHydrate(node) {
    if (!node) return false
    const live =
      (node.nodeData && node.nodeData.children && node.nodeData.children.length) ||
      0
    const count = Number(node.getData && node.getData('childCount')) || 0
    const uid = node.getData && node.getData('uid')
    if (!count) return false
    if (!live) return true
    return count > live && !this.hydratedUids.has(uid)
  }

  async hydrateFromHttp(node) {
    if (!node || !this.httpFetchSubtree) return
    const uid = node.getData && node.getData('uid')
    const data = node.nodeData
    if (!uid || !data) return
    const liveLen = Array.isArray(data.children) ? data.children.length : 0
    const count = Number(data.data && data.data.childCount) || 0
    if (liveLen > 0 && this.hydratedUids.has(uid) && (count <= 0 || liveLen >= count)) {
      return
    }
    this.httpHydrating = true
    try {
      const result = await this.httpFetchSubtree(uid)
      this.mergeHttpChildren(data, result && result.children)
      if (data.data) {
        data.data.hasMore = !!(result && result.has_more)
        data.data.childCount =
          (result && result.total) || data.data.childCount || 0
      }
      if (data.children && data.children.length) {
        this.hydratedUids.add(uid)
        this.hydrateFailedUids.delete(uid)
      }
    } catch (err) {
      throw err
    } finally {
      this.httpHydrating = false
    }
  }

  async hydrateNodeData(data) {
    if (!data || !this.httpFetchSubtree) return data
    const uid = data.data && data.data.uid
    if (!uid) return data
    const live = Array.isArray(data.children) ? data.children.length : 0
    const count = Number(data.data && data.data.childCount) || 0
    if (live && (!count || live >= count)) return data
    const result = await this.httpFetchSubtree(uid)
    if (!data.children || !data.children.length) {
      data.children = (result && result.children) || []
    } else {
      this.mergeHttpChildren(data, result && result.children)
    }
    if (data.data) {
      data.data.hasMore = !!(result && result.has_more)
      data.data.childCount = (result && result.total) || count || 0
    }
    this.hydratedUids.add(uid)
    this.markUidPushed(uid, data.data)
    ;(data.children || []).forEach(child => {
      const childUid = child && child.data && child.data.uid
      this.markUidPushed(childUid, child && child.data)
    })
    return data
  }

  findTreeNode(root, uid) {
    if (!root) return null
    if (!uid) return root
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()
      if (node && node.data && node.data.uid === uid) return node
      const kids = (node && node.children) || []
      for (let i = 0; i < kids.length; i++) stack.push(kids[i])
    }
    return null
  }

  hydrateTreeNodeFromYmap(data) {
    if (!data || !this.ymap) return data
    if (Array.isArray(data.children) && data.children.length) return data
    const uid = data.data && data.data.uid
    if (!uid) return data
    const nodeMap = this.ymap.get(uid)
    if (!nodeMap || typeof nodeMap.get !== 'function') return data
    const children = nodeMap.get('children')
    const childUids =
      children && typeof children.toArray === 'function' ? children.toArray() : []
    if (!data.children) data.children = []
    const have = new Set(
      data.children.map(child => child && child.data && child.data.uid)
    )
    childUids.forEach(childUid => {
      if (have.has(childUid)) return
      const childMap = this.ymap.get(childUid)
      if (!childMap || typeof childMap.toJSON !== 'function') return
      const json = childMap.toJSON()
      data.children.push({
        data: {
          ...(json.data || {}),
          uid: childUid,
          expand: false,
          childCount: Array.isArray(json.children) ? json.children.length : 0
        },
        children: []
      })
    })
    return data
  }

  hydrateYmapTree(data) {
    if (!data || !this.ymap) return data
    if (!Array.isArray(data.children) || !data.children.length) {
      this.hydrateTreeNodeFromYmap(data)
    }
    ;(data.children || []).forEach(child => this.hydrateYmapTree(child))
    return data
  }

  collectEmptyChildNodesAtDepth(root, depth) {
    const stubs = []
    const walk = (node, d) => {
      if (!node) return
      if (d === depth) {
        const kids = node.children || []
        const count = Number(node.data && node.data.childCount) || 0
        if (count > kids.length) stubs.push(node)
        return
      }
      if (d < depth) {
        const kids = node.children || []
        for (let i = 0; i < kids.length; i++) walk(kids[i], d + 1)
      }
    }
    walk(root, 0)
    return stubs
  }

  async hydrateTreeToLevel(root, level, options = {}) {
    if (!root || !(level > 0)) return root
    if (!this.httpFetchSubtree && !this.ymap) return root
    const maxFetches =
      Number(options.maxFetches) > 0 ? Number(options.maxFetches) : 120
    const concurrency = Math.min(
      8,
      Math.max(1, Number(options.concurrency) || 6)
    )
    let fetches = 0
    const hydrateOne = async node => {
      if (this.httpFetchSubtree) return this.hydrateNodeData(node)
      return this.hydrateTreeNodeFromYmap(node)
    }
    const runPool = async jobs => {
      let index = 0
      const worker = async () => {
        while (index < jobs.length && fetches < maxFetches) {
          const job = jobs[index++]
          fetches += 1
          try {
            await hydrateOne(job)
          } catch (err) {
            console.error('[mind-map] load children failed', err)
          }
        }
      }
      const size = Math.min(concurrency, jobs.length)
      await Promise.all(new Array(size).fill(0).map(() => worker()))
    }
    this.httpHydrating = true
    try {
      for (let depth = 0; depth < level && fetches < maxFetches; depth++) {
        const stubs = this.collectEmptyChildNodesAtDepth(root, depth)
        if (!stubs.length) continue
        await runPool(stubs)
      }
    } finally {
      this.httpHydrating = false
    }
    return root
  }

  onBeforeExecCommand(name) {
    if (!this.httpCollabMode) return
    if (
      name !== 'REMOVE_NODE' &&
      name !== 'REMOVE_CURRENT_NODE' &&
      name !== 'CUT_NODE'
    ) {
      return
    }
    const list = (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    this.pendingHttpDeletes = list
      .map(node => node && node.getData && node.getData('uid'))
      .filter(Boolean)
  }

  onHttpCommand(name) {
    if (
      name === 'REMOVE_NODE' ||
      name === 'REMOVE_CURRENT_NODE' ||
      name === 'CUT_NODE'
    ) {
      const keepChildren = name === 'REMOVE_CURRENT_NODE'
      const uids = this.pendingHttpDeletes.splice(0)
      uids.forEach(uid => {
        if (!this.httpDeleteNode) return
        this.forgetHttpUid(uid)
        this.recentHttpDeleted.set(uid, Date.now())
        this.httpDeleteNode(uid, { keepChildren }).catch(() => {})
      })
      return
    }
    if (INSERT_COMMANDS[name]) {
      const inserted = this.flushHttpInsert()
      if (name === 'INSERT_PARENT_NODE') {
        Promise.resolve(inserted)
          .then(() => this.flushHttpMove())
          .then(() => {
            const node =
              this.mindMap.renderer &&
              this.mindMap.renderer.activeNodeList &&
              this.mindMap.renderer.activeNodeList[0]
            return this.flushHttpReparentChildren(node)
          })
          .catch(err => console.error('[mind-map] insert parent failed', err))
      }
      return
    }
    if (MOVE_COMMANDS[name]) {
      this.flushHttpMove()
      return
    }
    if (
      name === 'SET_NODE_TEXT' ||
      name === 'SET_NODE_DATA' ||
      name === 'SET_NODE_NOTE' ||
      name === 'SET_NODE_STYLE' ||
      name === 'SET_NODE_STYLES' ||
      name === 'ADD_GENERALIZATION' ||
      name === 'REMOVE_GENERALIZATION'
    ) {
      this.scheduleHttpTextSync()
    }
  }

  scheduleHttpTextSync() {
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = setTimeout(() => {
      this.httpTextTimer = null
      this.flushHttpText()
    }, 280)
  }

  scheduleHttpStructureSync(delay = 180) {
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = setTimeout(() => {
      this.httpStructureTimer = null
      this.flushHttpInsert().catch(err => {
        console.error('[mind-map] structure sync failed', err)
      })
    }, delay)
  }

  nodePlain(node) {
    if (!node || typeof node.getData !== 'function') return ''
    const text = node.getData('text')
    return node.getData('richText') ? getTextFromHtml(text) : String(text || '')
  }

  nodePatchPayload(node) {
    const payload = {
      text: this.nodePlain(node),
      note: (node.getData && node.getData('note')) || ''
    }
    ;[
      'image',
      'imageTitle',
      'imageSize',
      'icon',
      'tag',
      'hyperlink',
      'hyperlinkTitle',
      'outerFrame',
      'generalization'
    ].forEach(key => {
      const value = node.getData && node.getData(key)
      if (value !== undefined && value !== null && value !== '') {
        payload[key] = value
      }
    })
    return payload
  }

  flushHttpText() {
    if (!this.httpPatchNode) return
    const nodes =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    nodes.forEach(node => {
      const uid = node.getData && node.getData('uid')
      if (!uid) return
      const payload = this.nodePatchPayload(node)
      const snap = JSON.stringify(payload)
      const prev = this.lastPushed[uid]
      if (prev && prev.snap === snap) return
      this.lastPushed[uid] = {
        text: payload.text,
        note: payload.note,
        snap
      }
      this.httpPatchNode(uid, payload).catch(() => {})
    })
  }

  collectUnpushedNodes(node, out = []) {
    if (!node) return out
    if (node.isRoot) {
      ;(node.children || []).forEach(child => this.collectUnpushedNodes(child, out))
      return out
    }
    const uid = node.getData && node.getData('uid')
    if (uid && !this.lastPushed[uid]) out.push(node)
    const kids = node.children || []
    kids.forEach(child => this.collectUnpushedNodes(child, out))
    return out
  }

  nodeDepth(node) {
    let depth = 0
    let current = node
    while (current && current.parent) {
      depth += 1
      current = current.parent
    }
    return depth
  }

  async flushHttpInsert() {
    if (!this.httpAddNode) return
    if (this.httpInsertPromise) {
      this.httpInsertRescan = true
      return this.httpInsertPromise
    }
    this.httpInsertPromise = this.flushHttpInsertNow()
    try {
      await this.httpInsertPromise
    } finally {
      this.httpInsertPromise = null
      if (this.httpInsertRescan) {
        this.httpInsertRescan = false
        this.scheduleHttpStructureSync(0)
      }
    }
  }

  async flushHttpInsertNow() {
    const renderer = this.mindMap.renderer
    const pending = []
    const list = (renderer && renderer.activeNodeList) || []
    list.forEach(node => this.collectUnpushedNodes(node, pending))
    if (!pending.length && renderer && renderer.root) {
      this.collectUnpushedNodes(renderer.root, pending)
    }
    const seen = new Set()
    const unique = pending.filter(node => {
      const uid = node.getData && node.getData('uid')
      if (!uid || seen.has(uid)) return false
      seen.add(uid)
      return true
    })
    unique.sort((a, b) => this.nodeDepth(a) - this.nodeDepth(b))
    for (const node of unique) {
      const uid = node.getData && node.getData('uid')
      const parent =
        node.parent && node.parent.getData && node.parent.getData('uid')
      const text = this.nodePlain(node)
      const note = (node.getData && node.getData('note')) || ''
      const kids =
        (node.parent && node.parent.nodeData && node.parent.nodeData.children) ||
        []
      const index = kids.findIndex(
        item => item && item.data && item.data.uid === uid
      )
      try {
        await this.httpAddNode({
          parent,
          uid,
          text,
          note,
          index: index < 0 ? undefined : index
        })
        this.lastPushed[uid] = { text, note }
        this.recentPushed.set(uid, Date.now())
      } catch (err) {
        const msg = String((err && err.message) || err)
        if (/节点已存在/.test(msg)) {
          this.lastPushed[uid] = { text, note }
          this.recentPushed.set(uid, Date.now())
        } else {
          console.error('[mind-map] add node failed', err)
        }
      }
    }
  }

  flushHttpMove() {
    if (!this.httpPatchNode) return Promise.resolve()
    const node =
      this.mindMap.renderer &&
      this.mindMap.renderer.activeNodeList &&
      this.mindMap.renderer.activeNodeList[0]
    if (!node || node.isRoot) return Promise.resolve()
    const uid = node.getData && node.getData('uid')
    const parent =
      node.parent && node.parent.getData && node.parent.getData('uid')
    if (!uid || !parent) return Promise.resolve()
    const kids =
      (node.parent.nodeData && node.parent.nodeData.children) || []
    const index = kids.findIndex(item => item && item.data && item.data.uid === uid)
    return this.httpPatchNode(uid, {
      parent,
      index: index < 0 ? 0 : index
    }).catch(err => console.error('[mind-map] move node failed', err))
  }

  flushHttpReparentChildren(node) {
    if (!this.httpPatchNode || !node) return Promise.resolve()
    const parentUid = node.getData && node.getData('uid')
    const kids = (node.nodeData && node.nodeData.children) || []
    return Promise.all(
      kids.map((child, index) => {
        const childUid = child && child.data && child.data.uid
        if (!childUid) return Promise.resolve()
        return this.httpPatchNode(childUid, {
          parent: parentUid,
          index
        }).catch(err => console.error('[mind-map] reparent failed', err))
      })
    )
  }

  forgetHttpUid(uid) {
    if (!uid) return
    delete this.lastPushed[uid]
    this.recentPushed.delete(uid)
    this.hydratedUids.delete(uid)
  }

  isRecentlyHttpDeleted(uid) {
    if (!uid || !this.recentHttpDeleted) return false
    pruneRecentMap(this.recentHttpDeleted)
    return this.recentHttpDeleted.has(uid)
  }

  dropHttpTree(node) {
    if (!node) return
    const uid = node.data && node.data.uid
    this.forgetHttpUid(uid)
    ;(node.children || []).forEach(child => this.dropHttpTree(child))
  }

  async copyNodeTrees(nodes) {
    const list = (nodes || []).filter(Boolean)
    if (!list.length) return null
    const trees = []
    for (const node of list) {
      const uid = node.getData && node.getData('uid')
      let copied = null
      if (uid && this.httpFetchDeepSubtree) {
        try {
          const result = await this.httpFetchDeepSubtree(uid)
          if (result && result.tree) {
            copied = copyNodeTree({}, result.tree, true, true)
          }
        } catch (err) {
          console.error('[mind-map] copy subtree failed', err)
        }
      }
      if (!copied && node.nodeData) {
        if (this.httpFetchSubtree) {
          await this.hydrateDataTree(node.nodeData)
        } else {
          this.hydrateYmapTree(node.nodeData)
        }
        copied = copyNodeTree({}, node, true, true)
      }
      if (copied) trees.push(copied)
    }
    return trees.length ? trees : null
  }

  async fetchExportTree() {
    if (!this.httpFetchExportTree) return null
    const payload = await this.httpFetchExportTree()
    return payload && payload.tree ? payload.tree : null
  }

  async hydrateDataTree(data) {
    if (!data) return data
    await this.hydrateNodeData(data)
    const kids = data.children || []
    for (let i = 0; i < kids.length; i++) {
      await this.hydrateDataTree(kids[i])
    }
    return data
  }

  collectVisibleUids() {
    const uids = []
    const walk = node => {
      if (!node || !node.data) return
      if (node.data.uid) uids.push(node.data.uid)
      ;(node.children || []).forEach(walk)
    }
    walk(this.mindMap.renderer && this.mindMap.renderer.renderTree)
    return uids.slice(0, 800)
  }

  async fetchHttpNodes(uids) {
    const list = (uids || []).filter(Boolean)
    if (!list.length || !this.httpFetchNodes) return []
    const nodes = []
    for (let i = 0; i < list.length; i += 200) {
      const payload = await this.httpFetchNodes(list.slice(i, i + 200))
      nodes.push(...((payload && payload.nodes) || []))
    }
    return nodes
  }

  async refreshVisibleFromHttp(updatedAt) {
    if (!this.httpCollabMode || !this.httpFetchNodes) return
    if (this.httpHydrating || this.isApplyingRemote) return
    if (updatedAt && updatedAt === this.httpUpdatedAt) return
    const first = !this.httpUpdatedAt
    this.httpUpdatedAt = updatedAt || this.httpUpdatedAt
    if (first) return
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    if (!tree) return
    const uids = this.collectVisibleUids()
    if (!uids.length) return
    pruneRecentMap(this.recentHttpDeleted)
    pruneRecentMap(this.recentPushed, RECENT_PUSH_GRACE_MS)
    const remoteNodes = await this.fetchHttpNodes(uids)
    if (!remoteNodes.length) return
    const editing =
      renderer.textEdit &&
      typeof renderer.textEdit.isShowTextEdit === 'function' &&
      renderer.textEdit.isShowTextEdit()
        ? renderer.textEdit.currentNode
        : null
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    let changed = false
    try {
      const missing = []
      const missingFor = new Map()
      remoteNodes.forEach(item => {
        const node = renderer.findNodeByUid(item.uid)
        const data = item.data || {}
        if (node && node !== editing) {
          const text = data.richText
            ? getTextFromHtml(data.text)
            : String(data.text || '')
          const note = data.note || ''
          const prev = this.lastPushed[item.uid]
          if (!prev || prev.text !== text || (prev.note || '') !== note) {
            renderer.setNodeData(node, {
              text: data.text,
              note: data.note,
              richText: data.richText,
              image: data.image,
              imageTitle: data.imageTitle,
              imageSize: data.imageSize,
              icon: data.icon,
              tag: data.tag,
              hyperlink: data.hyperlink,
              hyperlinkTitle: data.hyperlinkTitle
            })
            if (typeof renderer.reRenderNodeCheckChange === 'function') {
              renderer.reRenderNodeCheckChange(node, true)
            }
            this.lastPushed[item.uid] = { text, note }
            changed = true
          }
        }
        const treeNode = this.findTreeNode(tree, item.uid)
        if (!treeNode) return
        const serverKids = item.children || []
        const keep = new Set(serverKids)
        const have = new Set(
          (treeNode.children || [])
            .map(child => child && child.data && child.data.uid)
            .filter(Boolean)
        )
        const need = serverKids.filter(
          id => id && !have.has(id) && !this.isRecentlyHttpDeleted(id)
        )
        if (need.length) {
          missingFor.set(item.uid, need)
          need.forEach(id => missing.push(id))
        }
        const prevKids = treeNode.children || []
        const next = prevKids.filter(child => {
          const id = child && child.data && child.data.uid
          return keepHttpChild(id, keep, this.lastPushed, this.recentPushed)
        })
        if (next.length !== prevKids.length) {
          prevKids
            .filter(child => !next.includes(child))
            .forEach(child => this.dropHttpTree(child))
          treeNode.children = next
          changed = true
        }
        if (treeNode.data) {
          treeNode.data.childCount = Math.max(next.length, serverKids.length)
        }
      })
      if (missing.length) {
        const extraNodes = await this.fetchHttpNodes(missing.slice(0, 800))
        const byUid = new Map(extraNodes.map(item => [item.uid, item]))
        missingFor.forEach((childIds, parentUid) => {
          const parent = this.findTreeNode(tree, parentUid)
          if (!parent) return
          const stubs = childIds
            .map(id => byUid.get(id))
            .filter(Boolean)
            .map(item => ({
              data: {
                ...(item.data || {}),
                uid: item.uid,
                expand: false,
                childCount: Array.isArray(item.children)
                  ? item.children.length
                  : 0
              },
              children: []
            }))
          const before = (parent.children || []).length
          this.mergeHttpChildren(parent, stubs)
          if ((parent.children || []).length !== before) changed = true
        })
      }
      if (changed) this.mindMap.render()
    } finally {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
  }

  async revealUid(uid) {
    if (!uid) return null
    const renderer = this.mindMap.renderer
    let target = renderer.findNodeByUid(uid)
    if (target) {
      this.mindMap.execCommand('GO_TARGET_NODE', uid)
      return target
    }
    if (!this.httpFetchLocate) return null
    const located = await this.httpFetchLocate(uid)
    if (!located || !located.ancestors) return null
    this.httpHydrating = true
    try {
      for (let i = 0; i < located.ancestors.length; i++) {
        const id = located.ancestors[i]
        let node = renderer.findNodeByUid(id)
        if (!node && i > 0) {
          const parent = renderer.findNodeByUid(located.ancestors[i - 1])
          const stub = located.nodes && located.nodes[id]
          if (parent && stub) {
            this.mergeHttpChildren(parent.nodeData, [stub])
            if (this._origSetNodeExpand) this._origSetNodeExpand(parent, true)
            this.mindMap.render()
            node = renderer.findNodeByUid(id)
          }
        }
        if (node) {
          await this.hydrateFromHttp(node)
          if (this._origSetNodeExpand) this._origSetNodeExpand(node, true)
          this.mindMap.render()
        }
      }
    } finally {
      this.httpHydrating = false
    }
    target = renderer.findNodeByUid(uid)
    if (target) this.mindMap.execCommand('GO_TARGET_NODE', uid)
    return target
  }

  // 设置用户信息
  /**
   * {
   *    id: '',     // 必传，用户唯一的id
   *    name: '',   // 用户名称。name和avatar两个只传一个即可，如果都传了，会显示avatar
   *    avatar: '', // 用户头像
   *    color: ''   // 如果没有传头像，那么会以一个圆形来显示名称的第一个字，文字的颜色为白色，圆的颜色可以通过该字段设置
   * }
   **/
  setUserInfo(userInfo) {
    if (
      getType(userInfo) !== 'Object' ||
      isUndef(userInfo.id) ||
      (isUndef(userInfo.name) && isUndef(userInfo.avatar))
    )
      return
    this.userInfo = userInfo || null
  }

  publishAwareness(nodeIdList = []) {
    if (!this.userInfo || !this.awareness) return
    this.awareness.setLocalStateField('user', {
      userInfo: { ...this.userInfo },
      nodeIdList
    })
  }

  // 监听感知数据同步事件
  onAwareness() {
    const walk = (list, callback) => {
      list.forEach(value => {
        const legacyKey = Object.keys(value).find(key => {
          return value[key] && value[key].userInfo
        })
        const data = value.user || (legacyKey && value[legacyKey])
        if (!data) return
        const userInfo = data.userInfo
        const nodeIdList = data.nodeIdList
        if (!userInfo || !nodeIdList) return
        nodeIdList.forEach(uid => {
          const node = this.mindMap.renderer.findNodeByUid(uid)
          callback(uid, node, userInfo)
        })
      })
    }
    // 清除之前的数据
    walk(this.currentAwarenessData, (uid, node, userInfo) => {
      if (node) {
        node.removeUser(userInfo)
      }
    })
    // 设置当前数据
    const data = Array.from(this.awareness.getStates().values())
    this.currentAwarenessData = data
    this.waitNodeUidMap = {}
    walk(data, (uid, node, userInfo) => {
      // 不显示自己
      if (this.userInfo && userInfo.id === this.userInfo.id) return
      if (node) {
        node.addUser(userInfo)
      } else {
        this.waitNodeUidMap[uid] = userInfo
      }
    })
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

Cooperate.instanceName = 'cooperate'

export default Cooperate
