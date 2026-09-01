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
import {
  planCollabRecovery,
  planAfterOperations,
  markDirtySubtrees
} from './cooperateRecovery'
import {
  applyRemoteNodeData,
  patchDelta,
  publicNodeData,
  readFieldVersions
} from '../utils/fieldMerge'
import { createCollaborationStore } from '../utils/collaborationStore'

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

function sameHttpStamp(a, b) {
  if (!a || !b) return false
  if (String(a) === String(b)) return true
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && ta === tb
}

function keepHttpChild(uid, serverKids, lastPushed, recentPushed) {
  if (!uid) return true
  if (serverKids.has(uid)) return true
  // Not uploaded yet: keep so a delayed add is not wiped by a stale poll.
  if (!lastPushed[uid]) return true
  const at = recentPushed && recentPushed.get(uid)
  return !!(at && Date.now() - at < RECENT_PUSH_GRACE_MS)
}

function indexMindTree(root, out = new Map(), parent = null, index = 0) {
  if (!root || !root.data) return out
  const uid = root.data.uid
  const childUids = (root.children || [])
    .map(child => child && child.data && child.data.uid)
    .filter(Boolean)
  if (uid) {
    out.set(uid, {
      parent,
      index,
      data: root.data,
      childUids
    })
  }
  ;(root.children || []).forEach((child, i) => {
    indexMindTree(child, out, uid || parent, i)
  })
  return out
}

function treeDataPlain(data) {
  if (!data) return ''
  return data.richText ? getTextFromHtml(data.text) : String(data.text || '')
}

function diffHttpHistoryTrees(previous, current) {
  const prev = indexMindTree(previous)
  const curr = indexMindTree(current)
  const removed = []
  const added = []
  const moved = []
  const updated = []
  prev.forEach((info, uid) => {
    if (uid === 'root' || curr.has(uid)) return
    const childUids = info.childUids || []
    const keepChildren =
      childUids.length > 0 && childUids.every(id => curr.has(id))
    if (info.parent && !curr.has(info.parent) && !keepChildren) return
    removed.push({ uid, keepChildren })
  })
  curr.forEach((info, uid) => {
    if (uid === 'root') return
    const before = prev.get(uid)
    if (!before) {
      added.push({ uid, parent: info.parent, index: info.index, data: info.data })
      return
    }
    if (before.parent !== info.parent || before.index !== info.index) {
      moved.push({
        uid,
        parent: info.parent,
        index: info.index,
        fromParent: before.parent
      })
    }
    if (
      treeDataPlain(before.data) !== treeDataPlain(info.data) ||
      String((before.data && before.data.note) || '') !==
        String((info.data && info.data.note) || '')
    ) {
      updated.push({ uid, data: info.data })
    }
  })
  return { removed, added, moved, updated }
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
    this.collabStore = createCollaborationStore({
      timeoutMs: Number(
        (this.mindMap.opt && this.mindMap.opt.collabOperationTimeoutMs) || 12000
      )
    })
    this.httpFetchSubtree = null
    this.httpFetchDeepSubtree = null
    this.httpFetchExportTree = null
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpDeleteNode = null
    this.httpReplaceTree = null
    this.httpUndoOperation = null
    this.httpRedoOperation = null
    this.httpFetchOperations = null
    this.httpFetchVersion = null
    this.httpUpdatedAt = ''
    this.httpReplacing = false
    this.lastAppliedVersion = 0
    this.localUndoStack = []
    this.localRedoStack = []
    this.dirtySubtrees = new Map()
    this.httpRecovering = false
    this.httpPendingRecoverVersion = 0
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
    this.httpRefreshing = false
    this.httpPendingRefreshAt = ''
    this.httpPendingRefreshForce = false
    this.httpHistorySyncing = false
    this.localOrigin = { source: 'simple-mind-map-cooperate' }
    this.localPresence = {
      selectedUids: [],
      editingUid: null,
      cursor: null
    }
    this.presenceUsers = []
    this.presenceSyncHandler = null
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
    if (this.httpCollabMode) {
      this.previewApplied = false
      this.expectRemoteDoc = false
      this.pendingInitData = null
      return
    }
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
    const dirty = uid && this.dirtySubtrees && this.dirtySubtrees.has(uid)
    if (
      live &&
      this.hydratedUids.has(uid) &&
      (!count || live >= count) &&
      !dirty
    ) {
      return
    }
    if (this.httpFetchSubtree) {
      if (!live && count <= 0 && !dirty) return
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
    this.onBeforeShowTextEdit = this.onBeforeShowTextEdit.bind(this)
    this.onHideTextEdit = this.onHideTextEdit.bind(this)
    this.mindMap.on('before_show_text_edit', this.onBeforeShowTextEdit)
    this.mindMap.on('hide_text_edit', this.onHideTextEdit)
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
    if (this.onBeforeShowTextEdit) {
      this.mindMap.off('before_show_text_edit', this.onBeforeShowTextEdit)
    }
    if (this.onHideTextEdit) {
      this.mindMap.off('hide_text_edit', this.onHideTextEdit)
    }
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
      this.httpHydrating ||
      this.httpReplacing
    ) {
      return
    }
    if (this.httpCollabMode) {
      if (this.httpHistorySyncing) return
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
    const historyCmd = name === 'BACK' || name === 'FORWARD'
    if (
      this.isSetData ||
      this.isApplyingRemote ||
      this.previewApplied ||
      this.hydratingCurrentData ||
      this.httpHydrating ||
      this.httpReplacing ||
      (this.mindMap.renderer && this.mindMap.renderer._lazyCommandPending)
    ) {
      if (this.httpCollabMode && historyCmd) this.httpHistorySyncing = false
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
    const selectedUids = (nodeList || [])
      .map(item => {
        if (!item) return ''
        if (item.uid) return item.uid
        return item.getData && item.getData('uid')
      })
      .filter(Boolean)
    this.setLocalPresence({ selectedUids })
    if (node) this.repairEmptyExpand(node)
  }

  onBeforeShowTextEdit() {
    const renderer = this.mindMap.renderer
    const node =
      (renderer &&
        renderer.textEdit &&
        renderer.textEdit.currentNode) ||
      (renderer &&
        renderer.activeNodeList &&
        renderer.activeNodeList[0]) ||
      null
    const uid = node && node.getData && node.getData('uid')
    this.setLocalPresence({ editingUid: uid || null })
  }

  onHideTextEdit() {
    this.setLocalPresence({ editingUid: null })
  }

  setPresenceSyncHandler(handler) {
    this.presenceSyncHandler =
      typeof handler === 'function' ? handler : null
  }

  getLocalPresence() {
    return {
      selectedUids: [...(this.localPresence.selectedUids || [])],
      editingUid: this.localPresence.editingUid || null,
      cursor: this.localPresence.cursor || null
    }
  }

  setLocalPresence( partial = {}) {
    const next = {
      selectedUids: Array.isArray(partial.selectedUids)
        ? partial.selectedUids.filter(Boolean).slice(0, 40)
        : this.localPresence.selectedUids,
      editingUid:
        partial.editingUid !== undefined
          ? partial.editingUid || null
          : this.localPresence.editingUid,
      cursor:
        partial.cursor !== undefined
          ? partial.cursor
          : this.localPresence.cursor
    }
    const same =
      JSON.stringify(next) === JSON.stringify(this.localPresence)
    this.localPresence = next
    this.publishAwareness(next.selectedUids)
    if (!same && this.presenceSyncHandler) {
      try {
        this.presenceSyncHandler(this.getLocalPresence())
      } catch (err) {
        // ignore presence sync failures
      }
    }
  }

  applyPresenceUsers(list = []) {
    const renderer = this.mindMap.renderer
    if (!renderer) {
      this.presenceUsers = list || []
      return
    }
    const prev = this.presenceUsers || []
    const clearMap = new Map()
    prev.forEach(item => {
      const uids = new Set([
        ...(item.selectedUids || []),
        ...(item.editingUid ? [item.editingUid] : [])
      ])
      uids.forEach(uid => {
        if (!clearMap.has(uid)) clearMap.set(uid, [])
        clearMap.get(uid).push(item)
      })
    })
    clearMap.forEach((users, uid) => {
      const node = renderer.findNodeByUid(uid)
      if (!node) return
      users.forEach(user => node.removeUser(user))
    })
    this.waitNodeUidMap = {}
    const next = (list || []).filter(
      item => item && item.id && !(this.userInfo && item.id === this.userInfo.id)
    )
    this.presenceUsers = next
    next.forEach(item => {
      const uids = [
        ...(item.selectedUids || []),
        ...(item.editingUid ? [item.editingUid] : [])
      ]
      const unique = [...new Set(uids.filter(Boolean))]
      unique.forEach(uid => {
        const userInfo = {
          id: item.id,
          name: item.name,
          color: item.color,
          avatar: item.avatar,
          editing: item.editingUid === uid
        }
        const node = renderer.findNodeByUid(uid)
        if (node) node.addUser(userInfo)
        else this.waitNodeUidMap[uid] = userInfo
      })
    })
  }

  onExpandBtnClick(node) {
    if (!node) return
    const live =
      node.nodeData && node.nodeData.children && node.nodeData.children.length
    const childCount = Number(node.getData && node.getData('childCount')) || 0
    if (!live && childCount > 0) {
      this.repairEmptyExpand(node)
    }
  }

  async repairEmptyExpand(node) {
    if (!node || this._repairingExpand) return
    const childCount = Number(node.getData && node.getData('childCount')) || 0
    const live =
      node.nodeData && node.nodeData.children && node.nodeData.children.length
    if (live || childCount <= 0) return
    const uid = node.getData && node.getData('uid')
    if (uid) this.hydrateFailedUids.delete(uid)
    this._repairingExpand = true
    try {
      await this.hydrateLazyChildren(node)
      if (node.nodeData && node.nodeData.children && node.nodeData.children.length) {
        this.mindMap.execCommand('SET_NODE_EXPAND', node, true)
      }
    } catch (err) {
      console.error('[mind-map] load children failed', err)
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
    if (config.replaceTree) this.httpReplaceTree = config.replaceTree
    if (config.undoOperation) this.httpUndoOperation = config.undoOperation
    if (config.redoOperation) this.httpRedoOperation = config.redoOperation
    if (config.fetchOperations) this.httpFetchOperations = config.fetchOperations
    if (config.fetchVersion) this.httpFetchVersion = config.fetchVersion
    if (config.updatedAt) this.httpUpdatedAt = config.updatedAt
    if (config.version != null && Number.isFinite(Number(config.version))) {
      this.lastAppliedVersion = Number(config.version)
    }
  }

  setHttpCollab(config = {}) {
    this.setLazyLoaders(config)
    this.httpCollabMode = true
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.dirtySubtrees = new Map()
    this.localUndoStack = []
    this.localRedoStack = []
    this.enableLargeMapMode(Number(config.nodeCount) || 0)
    const roomKey = config.roomKey || this.httpRoomKey || ''
    if (roomKey) this.httpRoomKey = roomKey
    this.collabStore.reset(roomKey, Number(config.version) || 0)
    this.collabStore.setStatus('live')
    this.wrapHttpMutators(config)
  }

  wrapHttpMutators(config = {}) {
    if (typeof config.patchNode === 'function') {
      this.httpPatchNode = (uid, body) =>
        this.wrapHttpMutation('node.update', { ...(body || {}), uid }, payload =>
          config.patchNode(uid, payload)
        )
    }
    if (typeof config.addNode === 'function') {
      this.httpAddNode = body =>
        this.wrapHttpMutation('node.insert', body || {}, payload =>
          config.addNode(payload)
        )
    }
    if (typeof config.deleteNode === 'function') {
      this.httpDeleteNode = (uid, options) =>
        this.wrapHttpMutation(
          'node.delete',
          { ...(options || {}), uid },
          payload => config.deleteNode(uid, payload)
        )
    }
    if (typeof config.replaceTree === 'function') {
      this.httpReplaceTree = tree =>
        this.wrapHttpMutation('map.replace', { tree }, payload =>
          config.replaceTree(payload.tree)
        )
    }
  }

  wrapHttpMutation(type, body, send) {
    const operationId =
      (body && (body.operationId || body.operation_id)) ||
      this.collabStore.createId()
    const payload = { ...(body || {}), operationId }
    this.collabStore.trackPending({
      operationId,
      type,
      payload,
      send: () => send(payload)
    })
    return Promise.resolve()
      .then(() => send(payload))
      .then(result => {
        this.acknowledgeLocalVersion(result && result.version, {
            operationId,
            duplicate: !!(result && result.duplicate)
          })
        this.collabStore.confirmPending(
          operationId,
          result && result.version,
          result || {}
        )
        if (this.collabStore.getSnapshot().status === 'recovering') {
          // keep recovering until recoverHttpCollab finishes
        } else {
          this.collabStore.setStatus('live')
        }
        return result
      })
      .catch(err => {
        this.collabStore.rejectPending(operationId, err)
        throw err
      })
  }

  getCollaborationSnapshot() {
    return this.collabStore.getSnapshot()
  }

  subscribeCollaboration(listener) {
    return this.collabStore.subscribe(listener)
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
    this.httpReplaceTree = null
    this.httpUndoOperation = null
    this.httpRedoOperation = null
    this.httpFetchOperations = null
    this.httpFetchVersion = null
    this.httpUpdatedAt = ''
    this.httpReplacing = false
    this.lastAppliedVersion = 0
    this.localUndoStack = []
    this.localRedoStack = []
    this.dirtySubtrees = new Map()
    this.httpRecovering = false
    this.httpPendingRecoverVersion = 0
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    this.httpHistorySyncing = false
    this.httpRefreshing = false
    this.httpPendingRefreshAt = ''
    this.httpPendingRefreshForce = false
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    this.httpInsertRescan = false
    if (this.collabStore) this.collabStore.reset('', 0)
  }

  beginHttpReplace() {
    this.httpReplacing = true
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
  }

  endHttpReplace() {
    this.httpReplacing = false
  }

  afterHttpReplace(result) {
    this.lastPushed = {}
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.dirtySubtrees = new Map()
    this.pendingHttpDeletes = []
    this.hydrateFailedUids = new Set()
    const tree =
      (this.mindMap.renderer && this.mindMap.renderer.renderTree) || null
    if (tree) this.markTreeUids(tree)
    this.hydratedUids = this.collectLoadedUids()
    if (result && result.updated_at) this.httpUpdatedAt = result.updated_at
    if (result && result.version != null) {
      this.acknowledgeLocalVersion(result.version, {
        duplicate: true,
        operationId: result.operationId || result.operation_id
      })
      this.stampLoadedSubtreeVersions(this.lastAppliedVersion)
    }
  }

  async persistHttpReplace(fullData) {
    if (!this.httpReplaceTree) {
      throw new Error('replaceTree not configured')
    }
    const tree = (fullData && fullData.root) || fullData
    const result = await this.httpReplaceTree(tree)
    this.afterHttpReplace(result)
    return result
  }

  async restoreHttpTree() {
    if (!this.httpFetchExportTree) return false
    const exported = await this.httpFetchExportTree()
    const tree = exported && exported.tree
    if (!tree) return false
    this.isSetData = true
    try {
      this.mindMap.setFullData({
        ...exported,
        root: tree
      })
      this.afterHttpReplace(exported)
    } finally {
      this.isSetData = false
    }
    return true
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

  seedPreviewHydration(root) {
    const walk = node => {
      if (!node || !node.data) return
      const uid = node.data.uid
      const live = Array.isArray(node.children) ? node.children.length : 0
      const count = Number(node.data.childCount) || 0
      if (uid && live > 0 && (!count || live >= count)) {
        this.hydratedUids.add(uid)
      }
      ;(node.children || []).forEach(walk)
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
    if (uid && this.dirtySubtrees && this.dirtySubtrees.has(uid)) return true
    if (!count) return false
    if (!live) return true
    return count > live
  }

  collectLoadedUids() {
    const loaded = new Set(this.hydratedUids)
    this.collectVisibleUids().forEach(uid => loaded.add(uid))
    return loaded
  }

  markCollapsedLoadedDirty(version) {
    const ver = Number(version) || 0
    const walk = node => {
      if (!node || !node.data) return
      const uid = node.data.uid
      const count = Number(node.data.childCount) || 0
      const live = Array.isArray(node.children) ? node.children.length : 0
      if (uid && count > live) this.dirtySubtrees.set(uid, ver)
      ;(node.children || []).forEach(walk)
    }
    walk(this.mindMap.renderer && this.mindMap.renderer.renderTree)
  }

  stampLoadedSubtreeVersions(version) {
    const ver = Number(version) || 0
    if (!ver) return
    const walk = node => {
      if (node && node.data && node.data.uid) {
        if (!this.dirtySubtrees.has(node.data.uid)) {
          node.data.subtreeVersion = ver
        }
      }
      ;(node.children || []).forEach(walk)
    }
    walk(this.mindMap.renderer && this.mindMap.renderer.renderTree)
  }

  async hydrateFromHttp(node) {
    if (!node || !this.httpFetchSubtree) return
    const uid = node.getData && node.getData('uid')
    const data = node.nodeData
    if (!uid || !data) return
    const liveLen = Array.isArray(data.children) ? data.children.length : 0
    const count = Number(data.data && data.data.childCount) || 0
    const dirtyAt = this.dirtySubtrees.get(uid)
    const alreadyHydrated =
      liveLen > 0 &&
      this.hydratedUids.has(uid) &&
      (count <= 0 || liveLen >= count)
    if (alreadyHydrated && !dirtyAt) return
    this.httpHydrating = true
    try {
      const fetchSubtree = (options = {}) =>
        this.httpFetchSubtree(uid, {
          knownVersion: options.knownVersion ?? 0,
          deep: options.deep
        })
      const knownVersion = alreadyHydrated
        ? Number((data.data && data.data.subtreeVersion) || 0) || 0
        : 0
      let result = await fetchSubtree({ knownVersion })
      const needsLocalChildren = count > 0 && liveLen < count
      if (result && result.unchanged && needsLocalChildren) {
        result = await fetchSubtree({ knownVersion: 0 })
      }
      if (result && result.unchanged) {
        if (!needsLocalChildren) {
          this.dirtySubtrees.delete(uid)
          if (result.version && data.data) {
            data.data.subtreeVersion =
              Number(result.version) || data.data.subtreeVersion
          }
          return
        }
        result = await fetchSubtree({ knownVersion: 0 })
      }
      if (
        (!result || !result.children || !result.children.length) &&
        count > 0 &&
        this.httpFetchDeepSubtree
      ) {
        const deep = await this.httpFetchDeepSubtree(uid, { knownVersion: 0 })
        if (deep && deep.tree) {
          result = {
            children: deep.tree.children || [],
            total: count,
            version: deep.version,
            has_more: false
          }
        }
      }
      this.mergeHttpChildren(data, result && result.children)
      if (data.data) {
        data.data.hasMore = !!(result && result.has_more)
        data.data.childCount =
          (result && result.total) || data.data.childCount || 0
        if (result && result.version != null) {
          data.data.subtreeVersion = Number(result.version) || 0
        }
      }
      if (data.children && data.children.length) {
        this.hydratedUids.add(uid)
        this.hydrateFailedUids.delete(uid)
      } else if (count > 0) {
        this.hydrateFailedUids.add(uid)
        const err = new Error('subtree empty')
        err.code = 'SUBTREE_EMPTY'
        throw err
      }
      this.dirtySubtrees.delete(uid)
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
    const dirtyAt = uid && this.dirtySubtrees && this.dirtySubtrees.get(uid)
    if (live && (!count || live >= count) && !dirtyAt) return data
    const knownVersion = live
      ? Number((data.data && data.data.subtreeVersion) || 0) || 0
      : 0
    let result = await this.httpFetchSubtree(uid, { knownVersion })
    const needsLocalChildren = count > 0 && live < count
    if (result && result.unchanged && needsLocalChildren) {
      result = await this.httpFetchSubtree(uid, { knownVersion: 0 })
    }
    if (result && result.unchanged && !needsLocalChildren) {
      this.dirtySubtrees.delete(uid)
      if (result.version && data.data) {
        data.data.subtreeVersion = Number(result.version)
      }
      return data
    }
    if (!data.children || !data.children.length) {
      data.children = (result && result.children) || []
    } else {
      this.mergeHttpChildren(data, result && result.children)
    }
    if (data.data) {
      data.data.hasMore = !!(result && result.has_more)
      data.data.childCount = (result && result.total) || count || 0
      if (result && result.version != null) {
        data.data.subtreeVersion = Number(result.version) || 0
      }
    }
    this.dirtySubtrees.delete(uid)
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
    if (name === 'BACK' || name === 'FORWARD') {
      this.httpHistorySyncing = true
      return
    }
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
    if (name === 'BACK' || name === 'FORWARD') {
      try {
        this.syncHttpUndoRedo(name)
      } finally {
        this.httpHistorySyncing = false
      }
      return
    }
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

  historyTreePayload(data) {
    const text = treeDataPlain(data)
    const payload = {
      text,
      note: (data && data.note) || ''
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
      const value = data && data[key]
      if (value !== undefined && value !== null && value !== '') {
        payload[key] = value
      }
    })
    return payload
  }

  syncHttpUndoRedo(name) {
    if (!this.httpCollabMode) return
    if (name === 'BACK' && this.httpUndoOperation && this.localUndoStack.length) {
      const last = this.localUndoStack.pop()
      Promise.resolve(this.httpUndoOperation(last.operationId))
        .then(result => {
          if (result && result.version != null) {
            this.acknowledgeLocalVersion(result.version, {
              duplicate: true
            })
          }
          this.localRedoStack.push({ operationId: last.operationId })
          return this.refreshVisibleFromHttp('', { force: true })
        })
        .catch(err => {
          this.localUndoStack.push(last)
          console.error('[mind-map] undo operation failed', err)
          this.refreshVisibleFromHttp('', { force: true }).catch(() => {})
        })
      return
    }
    if (name === 'FORWARD' && this.httpRedoOperation && this.localRedoStack.length) {
      const last = this.localRedoStack.pop()
      Promise.resolve(this.httpRedoOperation(last.operationId))
        .then(result => {
          if (result && result.version != null) {
            this.acknowledgeLocalVersion(result.version, {
              duplicate: true
            })
          }
          this.localUndoStack.push({ operationId: last.operationId })
          return this.refreshVisibleFromHttp('', { force: true })
        })
        .catch(err => {
          this.localRedoStack.push(last)
          console.error('[mind-map] redo operation failed', err)
          this.refreshVisibleFromHttp('', { force: true }).catch(() => {})
        })
      return
    }
    const command = this.mindMap.command
    if (!command || !Array.isArray(command.history)) {
      this.scheduleHttpStructureSync(0)
      return
    }
    const idx = command.activeHistoryIndex
    const other = name === 'BACK' ? idx + 1 : idx - 1
    const currentStr = command.history[idx]
    const previousStr = command.history[other]
    if (!currentStr || !previousStr) {
      this.scheduleHttpStructureSync(0)
      return
    }
    let current
    let previous
    try {
      current = JSON.parse(currentStr)
      previous = JSON.parse(previousStr)
    } catch (err) {
      this.scheduleHttpStructureSync(0)
      return
    }
    const diff = diffHttpHistoryTrees(previous, current)
    diff.removed.forEach(item => {
      this.forgetHttpUid(item.uid)
      this.recentHttpDeleted.set(item.uid, Date.now())
      if (!this.httpDeleteNode) return
      this.httpDeleteNode(item.uid, { keepChildren: item.keepChildren }).catch(
        () => {}
      )
    })
    diff.added.forEach(item => {
      this.recentHttpDeleted.delete(item.uid)
    })
    diff.moved.forEach(item => {
      if (!this.httpPatchNode || !item.uid) return
      const sameParent =
        item.fromParent == null ||
        item.parent == null ||
        String(item.fromParent) === String(item.parent)
      if (sameParent) {
        this.httpPatchNode(item.uid, {
          index: item.index < 0 ? 0 : item.index,
          reorder: true
        }).catch(err => console.error('[mind-map] reorder failed', err))
        return
      }
      if (!item.parent) return
      this.httpPatchNode(item.uid, {
        parent: item.parent,
        index: item.index < 0 ? 0 : item.index
      }).catch(err => console.error('[mind-map] undo move failed', err))
    })
    diff.updated.forEach(item => {
      if (!this.httpPatchNode || !item.uid) return
      const payload = this.historyTreePayload(item.data)
      const snap = JSON.stringify(payload)
      this.lastPushed[item.uid] = {
        text: payload.text,
        note: payload.note,
        snap
      }
      this.httpPatchNode(item.uid, payload).catch(() => {})
    })
    if (diff.added.length) this.scheduleHttpStructureSync(0)
  }

  nodePlain(node) {
    if (!node || typeof node.getData !== 'function') return ''
    const text = node.getData('text')
    return node.getData('richText') ? getTextFromHtml(text) : String(text || '')
  }

  nodePatchPayload(node, options = {}) {
    const uid = node.getData && node.getData('uid')
    const full = {
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
        full[key] = value
      }
    })
    if (!options.onlyChanged || !uid) return full
    const prev = this.lastPushed[uid]
    if (!prev || !prev.full) return full
    const delta = patchDelta(prev.full, full)
    return Object.keys(delta).length ? delta : null
  }

  flushHttpText() {
    if (this.httpReplacing || !this.httpPatchNode) return
    const nodes =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    nodes.forEach(node => {
      const uid = node.getData && node.getData('uid')
      if (!uid) return
      const full = this.nodePatchPayload(node)
      const delta = this.nodePatchPayload(node, { onlyChanged: true })
      if (!delta) return
      const snap = JSON.stringify(full)
      this.lastPushed[uid] = {
        text: full.text,
        note: full.note,
        full,
        snap
      }
      this.httpPatchNode(uid, delta).catch(() => {})
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
    if (this.httpReplacing || !this.httpAddNode) return
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

  acknowledgeLocalVersion(version, extra = {}) {
    const next = Number(version)
    if (Number.isFinite(next) && next > this.lastAppliedVersion) {
      this.lastAppliedVersion = next
    }
    if (this.collabStore && Number.isFinite(next)) {
      this.collabStore.setLastAppliedVersion(next)
    }
    const operationId = extra.operationId || extra.operation_id
    if (operationId && extra.duplicate !== true) {
      this.localUndoStack.push({
        operationId,
        version: Number.isFinite(next) ? next : 0
      })
      if (this.localUndoStack.length > 200) this.localUndoStack.shift()
      this.localRedoStack = []
    }
  }

  async recoverHttpCollab(targetVersion, options = {}) {
    if (!this.httpCollabMode) return
    const plan = planCollabRecovery(this.lastAppliedVersion, targetVersion)
    if (plan.type === 'ignore') return
    if (this.httpRecovering) {
      this.httpPendingRecoverVersion = Math.max(
        this.httpPendingRecoverVersion || 0,
        Number(targetVersion) || 0
      )
      return
    }
    this.httpRecovering = true
    if (this.collabStore) this.collabStore.setStatus('recovering')
    try {
      let action = plan
      if (plan.type === 'fetch_operations' && this.httpFetchOperations) {
        try {
          const payload = await this.httpFetchOperations(plan.afterVersion)
          action = planAfterOperations(this.lastAppliedVersion, payload)
        } catch (err) {
          action = { type: 'resnapshot', version: plan.version }
        }
      } else if (plan.type === 'fetch_operations') {
        action = { type: 'resnapshot', version: plan.version }
      }
      if (action.type === 'ignore') return
      if (action.type === 'apply' && action.operations) {
        if (this.collabStore) {
          action.operations.forEach(op => {
            this.collabStore.enqueueRemoteEvent({
              version: Number(op.version),
              operationId: op.operationId || op.operation_id,
              type: op.type || (op.event && op.event.type),
              event: op.event || op
            })
          })
          this.collabStore.drainReadyEvents()
        }
        const dirty = markDirtySubtrees(
          this.collectLoadedUids(),
          action.operations
        )
        Object.keys(dirty).forEach(uid => {
          this.dirtySubtrees.set(
            uid,
            Math.max(this.dirtySubtrees.get(uid) || 0, dirty[uid])
          )
        })
      } else if (action.type === 'resnapshot') {
        this.markCollapsedLoadedDirty(action.version)
      }
      const started = Date.now()
      while (
        (this.httpRefreshing || this.httpHydrating || this.isApplyingRemote) &&
        Date.now() - started < 8000
      ) {
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      await this.refreshVisibleFromHttp('', { force: true })
      const applied = Number(action.version)
      if (Number.isFinite(applied) && applied > this.lastAppliedVersion) {
        this.lastAppliedVersion = applied
      }
      if (this.collabStore && Number.isFinite(applied)) {
        this.collabStore.setLastAppliedVersion(applied)
      }
      if (Number.isFinite(applied)) this.stampLoadedSubtreeVersions(applied)
    } finally {
      this.httpRecovering = false
      if (this.collabStore) this.collabStore.setStatus('live')
      const pending = this.httpPendingRecoverVersion
      this.httpPendingRecoverVersion = 0
      if (pending > this.lastAppliedVersion) {
        Promise.resolve().then(() => {
          this.recoverHttpCollab(pending, options).catch(() => {})
        })
      }
    }
  }

  async refreshVisibleFromHttp(updatedAt, options = {}) {
    if (!this.httpCollabMode || !this.httpFetchNodes) return
    const force = !!options.force
    if (this.httpHydrating || this.isApplyingRemote || this.httpRefreshing) {
      this.httpPendingRefreshAt = updatedAt || this.httpPendingRefreshAt
      this.httpPendingRefreshForce = force || this.httpPendingRefreshForce
      return
    }
    if (!force && updatedAt && sameHttpStamp(updatedAt, this.httpUpdatedAt)) return
    const pendingUpdatedAt = updatedAt || this.httpUpdatedAt
    if (!this.httpUpdatedAt) {
      this.httpUpdatedAt = pendingUpdatedAt
      return
    }
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    if (!tree) return
    const uids = this.collectVisibleUids()
    if (!uids.length) return
    pruneRecentMap(this.recentHttpDeleted)
    pruneRecentMap(this.recentPushed, RECENT_PUSH_GRACE_MS)
    this.httpRefreshing = true
    try {
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
            const localData = (node.getData && node.getData()) || {}
            const merged = applyRemoteNodeData(localData, data)
            const next = publicNodeData(merged.data)
            const text = next.richText
              ? getTextFromHtml(next.text)
              : String(next.text || '')
            const note = next.note || ''
            const prev = this.lastPushed[item.uid]
            const fv = readFieldVersions(merged.data)
            const sameTextNote =
              prev && prev.text === text && (prev.note || '') === note
            if (!sameTextNote || (merged.appliedKeys && merged.appliedKeys.length)) {
              renderer.setNodeData(node, {
                text: next.text,
                note: next.note,
                richText: next.richText,
                image: next.image,
                imageTitle: next.imageTitle,
                imageSize: next.imageSize,
                icon: next.icon,
                tag: next.tag,
                hyperlink: next.hyperlink,
                hyperlinkTitle: next.hyperlinkTitle
              })
              if (typeof renderer.reRenderNodeCheckChange === 'function') {
                renderer.reRenderNodeCheckChange(node, true)
              }
              this.lastPushed[item.uid] = {
                text,
                note,
                full: {
                  text,
                  note,
                  image: next.image,
                  imageTitle: next.imageTitle,
                  imageSize: next.imageSize,
                  icon: next.icon,
                  tag: next.tag,
                  hyperlink: next.hyperlink,
                  hyperlinkTitle: next.hyperlinkTitle
                },
                fieldVersions: fv
              }
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
            treeNode.data.childCount = Math.max(
              next.length,
              serverKids.length,
              Number(item.data && item.data.childCount) || 0
            )
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
        // Only acknowledge a revision after every fetch and merge completed.
        // A transient request/render failure must remain retryable by polling.
        this.httpUpdatedAt = pendingUpdatedAt
      } finally {
        try {
          this.mindMap.command.recovery()
        } catch (e) {
          // ignore
        }
        this.suppressLocalUntil = Date.now() + 250
        this.isApplyingRemote = false
      }
    } finally {
      this.httpRefreshing = false
      const queuedAt = this.httpPendingRefreshAt
      const queuedForce = this.httpPendingRefreshForce
      this.httpPendingRefreshAt = ''
      this.httpPendingRefreshForce = false
      if (
        queuedAt &&
        (queuedForce || !sameHttpStamp(queuedAt, this.httpUpdatedAt))
      ) {
        Promise.resolve().then(() => {
          this.refreshVisibleFromHttp(queuedAt, { force: queuedForce }).catch(
            () => {}
          )
        })
      }
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
    const selected = Array.isArray(nodeIdList)
      ? nodeIdList
      : this.localPresence.selectedUids || []
    this.awareness.setLocalStateField('user', {
      userInfo: { ...this.userInfo },
      nodeIdList: selected,
      selectedUids: selected,
      editingUid: this.localPresence.editingUid || null,
      cursor: this.localPresence.cursor || null
    })
  }

  // 监听感知数据同步事件
  onAwareness() {
    const states = Array.from(this.awareness.getStates().values())
    const peers = []
    states.forEach(value => {
      const legacyKey = Object.keys(value).find(key => {
        return value[key] && value[key].userInfo
      })
      const data = value.user || (legacyKey && value[legacyKey])
      if (!data || !data.userInfo) return
      const selectedUids = data.selectedUids || data.nodeIdList || []
      peers.push({
        id: data.userInfo.id,
        name: data.userInfo.name,
        color: data.userInfo.color,
        avatar: data.userInfo.avatar,
        selectedUids,
        editingUid: data.editingUid || null,
        cursor: data.cursor || null
      })
    })
    this.currentAwarenessData = states
    this.applyPresenceUsers(peers)
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
