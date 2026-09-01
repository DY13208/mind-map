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
  removeFromParentNodeData
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

const STRUCTURE_COMMANDS = {
  INSERT_NODE: true,
  INSERT_MULTI_NODE: true,
  INSERT_CHILD_NODE: true,
  INSERT_MULTI_CHILD_NODE: true,
  INSERT_PARENT_NODE: true,
  INSERT_AFTER: true,
  INSERT_BEFORE: true,
  REMOVE_NODE: true,
  REMOVE_CURRENT_NODE: true,
  PASTE_NODE: true,
  CUT_NODE: true,
  UP_NODE: true,
  DOWN_NODE: true,
  MOVE_UP_ONE_LEVEL: true,
  MOVE_NODE_TO: true,
  ADD_GENERALIZATION: true,
  REMOVE_GENERALIZATION: true,
  RESET_LAYOUT: true,
  BACK: true,
  FORWARD: true
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
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpDeleteNode = null
    this.httpUpdatedAt = ''
    this.hydratedUids = new Set()
    this.lastPushed = {}
    this.pendingHttpDeletes = []
    this.httpTextTimer = null
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
    if (this.httpCollabMode) return this.hydrateFromHttp(node)
    if (!this.ymap || !node) return
    const uid = node.getData && node.getData('uid')
    if (!uid) return
    const nodeMap = this.ymap.get(uid)
    if (!nodeMap || typeof nodeMap.get !== 'function') return
    const children = nodeMap.get('children')
    const childUids =
      children && typeof children.toArray === 'function' ? children.toArray() : []
    const data = node.nodeData
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
          expand: false
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
    const renderer = this.mindMap.renderer
    if (renderer && typeof renderer.setNodeExpand === 'function') {
      this._origSetNodeExpand = renderer.setNodeExpand.bind(renderer)
      renderer.setNodeExpand = (node, expand) => {
        if (!expand) return this._origSetNodeExpand(node, expand)
        const hydrated = this.hydrateLazyChildren(node)
        if (hydrated && typeof hydrated.then === 'function') {
          return hydrated
            .then(() => this._origSetNodeExpand(node, expand))
            .catch(() => this._origSetNodeExpand(node, expand))
        }
        return this._origSetNodeExpand(node, expand)
      }
    }
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
    clearTimeout(this.httpTextTimer)
    const renderer = this.mindMap.renderer
    if (renderer && this._origSetNodeExpand) {
      renderer.setNodeExpand = this._origSetNodeExpand
      this._origSetNodeExpand = null
    }
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
      this.httpHydrating
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
    this.publishAwareness(nodeList.map(item => item.uid))
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

  setHttpCollab(config = {}) {
    this.httpCollabMode = true
    this.httpRoomKey = config.roomKey || ''
    this.httpFetchSubtree = config.fetchSubtree || null
    this.httpFetchNodes = config.fetchNodes || null
    this.httpFetchLocate = config.fetchLocate || null
    this.httpPatchNode = config.patchNode || null
    this.httpAddNode = config.addNode || null
    this.httpDeleteNode = config.deleteNode || null
    this.httpUpdatedAt = config.updatedAt || ''
    this.hydratedUids = new Set()
    this.lastPushed = {}
    this.enableLargeMapMode(config.nodeCount || 400)
  }

  clearHttpCollab() {
    this.httpCollabMode = false
    this.httpRoomKey = ''
    this.httpFetchSubtree = null
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpDeleteNode = null
    this.httpUpdatedAt = ''
    this.hydratedUids = new Set()
    this.lastPushed = {}
    this.pendingHttpDeletes = []
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
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
    })
  }

  async hydrateFromHttp(node) {
    if (!node || !this.httpFetchSubtree) return
    const uid = node.getData && node.getData('uid')
    const data = node.nodeData
    if (!uid || !data) return
    if (this.hydratedUids.has(uid)) return
    const childCount =
      (node.getData && Number(node.getData('childCount'))) || 0
    const hasKids = Array.isArray(data.children) && data.children.length > 0
    if (hasKids) {
      this.hydratedUids.add(uid)
      return
    }
    if (childCount <= 0) {
      this.hydratedUids.add(uid)
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
      this.hydratedUids.add(uid)
    } finally {
      this.httpHydrating = false
    }
  }

  async hydrateNodeData(data) {
    if (!this.httpCollabMode || !data || !this.httpFetchSubtree) return data
    const uid = data.data && data.data.uid
    if (!uid) return data
    if (Array.isArray(data.children) && data.children.length) return data
    const result = await this.httpFetchSubtree(uid)
    data.children = (result && result.children) || []
    if (data.data) {
      data.data.hasMore = !!(result && result.has_more)
      data.data.childCount = (result && result.total) || 0
    }
    this.hydratedUids.add(uid)
    return data
  }

  onBeforeExecCommand(name) {
    if (!this.httpCollabMode) return
    if (name !== 'REMOVE_NODE' && name !== 'REMOVE_CURRENT_NODE') return
    const list = (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    this.pendingHttpDeletes = list
      .map(node => node && node.getData && node.getData('uid'))
      .filter(Boolean)
  }

  onHttpCommand(name) {
    if (name === 'REMOVE_NODE' || name === 'REMOVE_CURRENT_NODE') {
      const uids = this.pendingHttpDeletes.splice(0)
      uids.forEach(uid => {
        if (!this.httpDeleteNode) return
        delete this.lastPushed[uid]
        this.httpDeleteNode(uid).catch(() => {})
      })
      return
    }
    if (STRUCTURE_COMMANDS[name]) {
      this.flushHttpInsert()
      return
    }
    if (
      name === 'SET_NODE_TEXT' ||
      name === 'SET_NODE_DATA' ||
      name === 'SET_NODE_NOTE'
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

  nodePlain(node) {
    if (!node || typeof node.getData !== 'function') return ''
    const text = node.getData('text')
    return node.getData('richText') ? getTextFromHtml(text) : String(text || '')
  }

  flushHttpText() {
    if (!this.httpPatchNode) return
    const nodes =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    nodes.forEach(node => {
      const uid = node.getData && node.getData('uid')
      if (!uid) return
      const text = this.nodePlain(node)
      const note = (node.getData && node.getData('note')) || ''
      const prev = this.lastPushed[uid]
      if (prev && prev.text === text && prev.note === note) return
      this.lastPushed[uid] = { text, note }
      this.httpPatchNode(uid, { text, note }).catch(() => {})
    })
  }

  flushHttpInsert() {
    if (!this.httpAddNode) return
    const node =
      this.mindMap.renderer &&
      this.mindMap.renderer.activeNodeList &&
      this.mindMap.renderer.activeNodeList[0]
    if (!node || node.isRoot) return
    const uid = node.getData && node.getData('uid')
    if (!uid || this.lastPushed[uid]) return
    const parent =
      node.parent && node.parent.getData && node.parent.getData('uid')
    const text = this.nodePlain(node)
    this.lastPushed[uid] = { text, note: node.getData('note') || '' }
    this.httpAddNode({
      parent,
      uid,
      text
    }).catch(() => {})
  }

  collectVisibleUids() {
    const uids = []
    const walk = node => {
      if (!node || !node.data) return
      if (node.data.uid) uids.push(node.data.uid)
      ;(node.children || []).forEach(walk)
    }
    walk(this.mindMap.renderer && this.mindMap.renderer.renderTree)
    return uids.slice(0, 200)
  }

  async refreshVisibleFromHttp(updatedAt) {
    if (!this.httpCollabMode || !this.httpFetchNodes) return
    if (updatedAt && updatedAt === this.httpUpdatedAt) return
    this.httpUpdatedAt = updatedAt || this.httpUpdatedAt
    const uids = this.collectVisibleUids()
    if (!uids.length) return
    const payload = await this.httpFetchNodes(uids)
    const nodes = (payload && payload.nodes) || []
    if (!nodes.length) return
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      const renderer = this.mindMap.renderer
      nodes.forEach(item => {
        const node = renderer.findNodeByUid(item.uid)
        if (!node) return
        const data = item.data || {}
        renderer.setNodeData(node, {
          text: data.text,
          note: data.note,
          richText: data.richText
        })
        renderer.reRenderNodeCheckChange(node, true)
        this.lastPushed[item.uid] = {
          text: data.richText ? getTextFromHtml(data.text) : String(data.text || ''),
          note: data.note || ''
        }
      })
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
