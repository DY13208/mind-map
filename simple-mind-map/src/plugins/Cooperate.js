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
  copyNodeTree,
  formatGetNodeGeneralization,
  checkIsNodeStyleDataKey
} from '../utils/index'
import {
  pickLiveMetaPatch,
  hydrateSharedMetadata,
  collectStyleFields,
  canonicalStructureFromTree,
  structureSignature,
  publishMapMetaState,
  warnStructuralMutation,
  STYLE_COMMAND_MATRIX
} from '../utils/collabMapMeta'
import {
  publishLayoutApplyTrace,
  inspectLayoutRenderer
} from '../utils/collabLayoutCleanup'
import { applyObjectToYMap, migrateLegacyNodes } from './cooperateYjs'
import {
  planCollabRecovery,
  planAfterOperations,
  markDirtySubtrees,
  affectedUidsFromOperation,
  applyCollabEvent
} from './cooperateRecovery'
import {
  applyRemoteNodeData,
  patchDelta,
  publicNodeData,
  readFieldVersions,
  FV_KEY
} from '../utils/fieldMerge'
import { createCollaborationStore } from '../utils/collaborationStore'
import mapRefUtil from '../utils/mapRef'
import collabInsertCollect from '../utils/collabInsertCollect'
import collabGeneralization from '../utils/collabGeneralization'
import collabMove from '../utils/collabMove'
import {
  collabTrace,
  createTraceId,
  setCollabTraceSnapshotProvider,
  undoTrace,
  undoFullTreeForbidden,
  moveFullTreeForbidden
} from '../utils/collabTrace'

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
const GEN_INTENT_MS = 30000
const PATCH_CONCURRENCY = 2
const NULLABLE_PATCH_KEYS = [
  'image',
  'imageTitle',
  'imageSize',
  'icon',
  'tag',
  'hyperlink',
  'hyperlinkTitle',
  'outerFrame',
  'generalization',
  'mapRef',
  'associativeLineTargets',
  'associativeLineTargetControlOffsets',
  'associativeLinePoint',
  'associativeLineText',
  'associativeLineStyle',
  'formula',
  'attachmentUrl',
  'attachmentName',
  'customLeft',
  'customTop'
]

const FIELD_COMMANDS = {
  SET_NODE_TEXT: true,
  SET_NODE_DATA: true,
  SET_NODE_NOTE: true,
  SET_NODE_STYLE: true,
  SET_NODE_STYLES: true,
  SET_NODE_IMAGE: true,
  SET_NODE_ICON: true,
  SET_NODE_HYPERLINK: true,
  SET_NODE_MAP_REF: true,
  SET_NODE_ATTACHMENT: true,
  SET_NODE_TAG: true,
  SET_NODE_SHAPE: true,
  SET_NODE_CUSTOM_POSITION: true,
  INSERT_FORMULA: true,
  ADD_OUTER_FRAME: true,
  ADD_ASSOCIATIVE_LINE: true,
  REMOVE_CUSTOM_STYLES: true,
  REMOVE_ALL_NODE_CUSTOM_STYLES: true
}

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

function isPermanentNodeError(err) {
  const msg = String((err && err.message) || err || '')
  const code = String((err && err.code) || '')
  return (
    code === 'PARENT_DELETED' ||
    code === 'NODE_DELETED' ||
    code === 'TARGET_DELETED' ||
    code === 'MOVE_CONFLICT' ||
    code === 'UID_REUSED' ||
    code === 'DROPPED_DELETED' ||
    /父节点已删除|PARENT_DELETED|missing parent/i.test(msg) ||
    /节点已删除或不存在|NODE_DELETED|MOVE_CONFLICT|UID_REUSED|禁止复用已删除节点/i.test(
      msg
    )
  )
}

function isPermanentInsertError(err) {
  return isPermanentNodeError(err)
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

function stableFieldValue(value) {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch (err) {
    return String(value)
  }
}

function generalizationSignature(generalization) {
  return collabGeneralization.generalizationSignature(generalization)
}

function generalizationUidsOf(data) {
  return new Set(
    formatGetNodeGeneralization(data || {})
      .map(item => item && item.uid)
      .filter(Boolean)
  )
}

function v2Trace(layer, detail) {
  collabTrace(layer, detail)
}

function payloadParentUid(payload) {
  return (
    (payload &&
      (payload.parentUid || payload.parent_uid || payload.parent)) ||
    ''
  )
}

function uidsFromPayload(type, payload) {
  const uids = []
  if (!payload || typeof payload !== 'object') return uids
  if (payload.uid) uids.push(payload.uid)
  if (Array.isArray(payload.ops)) {
    payload.ops.forEach(item => {
      const inner = (item && item.payload) || item || {}
      if (inner.uid) uids.push(inner.uid)
    })
  }
  void type
  return uids.filter(Boolean)
}

function payloadNodeData(payload) {
  const data =
    (payload && (payload.data || payload.patch) && {
      ...(payload.data || {}),
      ...(payload.patch || {})
    }) ||
    {}
  if (payload && payload.text != null && data.text == null) data.text = payload.text
  if (payload && payload.note != null && data.note == null) data.note = payload.note
  if (
    payload &&
    Object.prototype.hasOwnProperty.call(payload, 'generalization') &&
    data.generalization === undefined
  ) {
    data.generalization = payload.generalization
  }
  if (payload && payload.uid && !data.uid) data.uid = payload.uid
  return data
}

function isRateLimitedError(err) {
  return (
    (err && err.code === 'RATE_LIMITED') ||
    Number(err && err.statusCode) === 429
  )
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

async function runPromisePool(jobs, size = PATCH_CONCURRENCY) {
  const list = (jobs || []).filter(job => typeof job === 'function')
  if (!list.length) return
  let index = 0
  const workers = new Array(Math.min(size, list.length)).fill(0).map(async () => {
    while (index < list.length) {
      const job = list[index++]
      await job()
    }
  })
  await Promise.all(workers)
}

function nodeDataSyncChanged(before = {}, after = {}) {
  if (treeDataPlain(before) !== treeDataPlain(after)) return true
  if (
    String((before && before.note) || '') !== String((after && after.note) || '')
  ) {
    return true
  }
  if (
    generalizationSignature(before.generalization) !==
    generalizationSignature(after.generalization)
  ) {
    return true
  }
  if (
    stableFieldValue(before.outerFrame) !== stableFieldValue(after.outerFrame)
  ) {
    return true
  }
  return false
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
      nodeDataSyncChanged(before.data, info.data)
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
    this.collabV2Only = !!(this.mindMap.opt && this.mindMap.opt.collabV2Only)
    // yjs文档 — V2 运行时不创建、不连接 Yjs
    this.ydoc = this.collabV2Only ? null : new Y.Doc()
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
    this.collabV2Adapter = null
    this._v2UndoActive = false
    this._v2UndoAllowReplace = false
    this._v2HistoryBaselined = false
    this._undoFullTreeHits = 0
    this._v2MoveActive = false
    this._v2MoveAllowReplace = false
    this._moveFullTreeHits = 0
    this.pendingMoveCommand = null
    this._pasteTraceId = ''
    setCollabTraceSnapshotProvider(() => this.persistTraceSnapshot())
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
    this.httpSettlingAfterReplace = false
    this.httpSettleTimer = null
    this.httpReplaceNodeCount = 0
    this.lastAppliedVersion = 0
    this.localUndoStack = []
    this.localRedoStack = []
    this.dirtySubtrees = new Map()
    this.httpRecovering = false
    this.httpPendingRecoverVersion = 0
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    this.pendingHttpGeneralizationOwners = []
    this.pendingGenIntent = new Map()
    this.httpTextTimer = null
    this.httpTextFlushing = false
    this.httpTextFlushQueued = false
    this.httpStructureTimer = null
    this.httpInsertPromise = null
    this.httpInsertRescan = false
    this.abandonedInsertUids = new Set()
    this.deletedUids = new Set()
    this.httpHydrating = false
    this.httpReplaceInFlight = false
    this.httpRefreshing = false
    this.httpPendingRefreshAt = ''
    this.httpPendingRefreshForce = false
    this.httpRemoteRecoverTimer = null
    this.httpPendingRemoteVersion = 0
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
    if (this.collabV2Only || !this.ydoc) {
      this.currentData = transformTreeDataToObject(data)
      return
    }
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
    const overflow =
      data &&
      data.data &&
      Array.isArray(data.data._overflowChildren) &&
      data.data._overflowChildren
    if (overflow && overflow.length && !this.httpFetchSubtree) {
      const chunk = overflow.splice(0, 48)
      data.children = (data.children || []).concat(chunk)
      if (!overflow.length) {
        delete data.data._overflowChildren
        data.data.hasMore = false
      }
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
    this.ydoc = this.collabV2Only ? null : new Y.Doc()
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
    setCollabTraceSnapshotProvider(() => this.persistTraceSnapshot())
    this.onExpandBtnClick = this.onExpandBtnClick.bind(this)
    this.mindMap.on('expand_btn_click', this.onExpandBtnClick)
    this.onBeforeShowTextEdit = this.onBeforeShowTextEdit.bind(this)
    this.onHideTextEdit = this.onHideTextEdit.bind(this)
    this.mindMap.on('before_show_text_edit', this.onBeforeShowTextEdit)
    this.mindMap.on('hide_text_edit', this.onHideTextEdit)
    this.onThemeChange = this.onThemeChange.bind(this)
    this.onLayoutChange = this.onLayoutChange.bind(this)
    this.mindMap.on('view_theme_change', this.onThemeChange)
    this.mindMap.on('layout_change', this.onLayoutChange)
    this.wrapSearchReplace()
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
    setCollabTraceSnapshotProvider(null)
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
    if (this.onThemeChange) this.mindMap.off('view_theme_change', this.onThemeChange)
    if (this.onLayoutChange) this.mindMap.off('layout_change', this.onLayoutChange)
    clearTimeout(this.httpTextTimer)
    clearTimeout(this.httpStructureTimer)
    clearTimeout(this._v2InsertRetryTimer)
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
    if (this._v2UndoActive && !this._v2UndoAllowReplace) {
      this._undoFullTreeHits = Number(this._undoFullTreeHits || 0) + 1
      undoFullTreeForbidden('applyRemoteTree')
      return
    }
    if (this._v2MoveActive && !this._v2MoveAllowReplace) {
      this.markMoveFullTreeForbidden('applyRemoteTree')
      return
    }
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
    if (this.isSetData || this.isApplyingRemote || this.httpReplacing) {
      return
    }
    if (this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil) {
      return
    }
    if (
      this.previewApplied ||
      this.hydratingCurrentData ||
      this.httpHydrating
    ) {
      // Render-driven data_change during hydrate must not PATCH every node.
      // Real user edits still go through onAfterExecCommand.
      return
    }
    if (this.httpCollabMode) {
      if (this.httpHistorySyncing || this.httpReplaceAllActive) return
      this.scheduleHttpTextSync()
      // Scan is recovery only. Normal inserts submit from the command path.
      this.scheduleHttpStructureSync(2500)
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

  persistTraceSnapshot() {
    const adapter = this.collabV2Adapter
    const status = adapter && adapter.getStatus ? adapter.getStatus() : null
    return {
      lastPushedCount: Object.keys(this.lastPushed || {}).length,
      lastAppliedVersion: this.lastAppliedVersion || 0,
      pendingUidCount: this.pendingUids ? this.pendingUids.size : 0,
      ackedUidCount: this.ackedUids ? this.ackedUids.size : 0,
      saveState: status && status.saveState,
      lastServerRevision: status && status.lastServerRevision,
      pendingAckCount: status && status.pendingCount,
      outboxPending: status && status.outboxPending,
      socketStatus: status && status.status,
      phase: status && status.phase
    }
  }

  onAfterExecCommand(name) {
    if (name === 'PASTE_NODE') {
      this._pasteTraceId = this._commandTraceId || createTraceId()
      collabTrace('paste.command', {
        generated: true,
        traceId: this._pasteTraceId,
        command: name
      })
    }
    if ((name === 'BACK' || name === 'FORWARD') && this.collabV2Adapter) {
      this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
      return
    }
    const lazyPending = !!(
      this.mindMap.renderer && this.mindMap.renderer._lazyCommandPending
    )
    if (
      this.httpCollabMode &&
      INSERT_COMMANDS[name] &&
      !this.httpReplacing &&
      !this.isSetData &&
      (lazyPending || this.httpHydrating || this.previewApplied)
    ) {
      // V2: command path is the only insert writer. Scanner is warn-only.
      if (!this.collabV2Adapter) this.scheduleHttpStructureSync(400)
    }
    const historyCmd = name === 'BACK' || name === 'FORWARD'
    const busy =
      this.isSetData ||
      this.isApplyingRemote ||
      this.previewApplied ||
      this.hydratingCurrentData ||
      this.httpHydrating ||
      this.httpReplacing ||
      Date.now() < this.suppressLocalUntil ||
      (lazyPending && !INSERT_COMMANDS[name])
    if (busy) {
      if (this.httpCollabMode && historyCmd) this.httpHistorySyncing = false
      if (
        this.httpCollabMode &&
        !this.isApplyingRemote &&
        !this.httpReplacing &&
        !this.isSetData &&
        (name === 'REMOVE_NODE' ||
          name === 'REMOVE_CURRENT_NODE' ||
          name === 'CUT_NODE')
      ) {
        this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
        return
      }
      if (
        this.httpCollabMode &&
        !this.isApplyingRemote &&
        !this.httpReplacing &&
        !this.isSetData
      ) {
        const settling =
          this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil
        if (settling) {
          if (
            (INSERT_COMMANDS[name] || MOVE_COMMANDS[name]) &&
            this.collabV2Adapter
          ) {
            this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
          } else if (INSERT_COMMANDS[name] || MOVE_COMMANDS[name]) {
            this.scheduleHttpStructureSync(80)
          }
          if (
            FIELD_COMMANDS[name] ||
            name === 'ADD_GENERALIZATION' ||
            name === 'REMOVE_GENERALIZATION'
          ) {
            this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
          } else if (name === 'SET_NODE_TEXT' || name === 'SET_NODE_NOTE') {
            this.scheduleHttpTextSync()
          }
          return
        }
        if (STRUCTURE_COMMANDS[name] && !this.httpHydrating) {
          if (
            this.collabV2Adapter &&
            (INSERT_COMMANDS[name] || MOVE_COMMANDS[name])
          ) {
            this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
          } else {
            this.scheduleHttpStructureSync(80)
          }
        }
        if (
          FIELD_COMMANDS[name] ||
          name === 'ADD_GENERALIZATION' ||
          name === 'REMOVE_GENERALIZATION'
        ) {
          this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
        } else if (name === 'SET_NODE_TEXT' || name === 'SET_NODE_NOTE') {
          this.scheduleHttpTextSync()
        }
      }
      return
    }
    if (this.httpCollabMode) {
      this.onHttpCommand(name, Array.prototype.slice.call(arguments, 1))
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
    if (selectedUids.length) {
      this.lastActiveUids = selectedUids.slice()
    }
    this.setLocalPresence({ selectedUids })
    if (node) this.repairEmptyExpand(node)
  }

  ensureActiveSelection() {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer) return false
    if (renderer.activeNodeList && renderer.activeNodeList.length) return true
    const uids = this.lastActiveUids || []
    if (!uids.length || typeof renderer.findNodeByUid !== 'function') return false
    let restored = 0
    uids.forEach(uid => {
      const live = renderer.findNodeByUid(uid)
      if (!live) return
      if (typeof renderer.addNodeToActiveList === 'function') {
        renderer.addNodeToActiveList(live)
        restored += 1
      }
    })
    if (restored && typeof renderer.emitNodeActiveEvent === 'function') {
      renderer.emitNodeActiveEvent()
    }
    return restored > 0
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
    if (uid && this.collabV2Adapter) {
      const snap = this.collabV2Adapter.getStatus()
      const mine = this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
      const other = (snap.peers || []).find(
        peer =>
          peer.editingUid === uid &&
          peer.clientId &&
          peer.clientId !== mine
      )
      if (other) {
        const editor =
          this.mindMap.renderer && this.mindMap.renderer.textEdit
        if (editor && typeof editor.hideEditTextBox === 'function') {
          setTimeout(() => editor.hideEditTextBox(), 0)
        }
        this.mindMap.emit('collab_lock_denied', other)
        return
      }
    }
    this.setLocalPresence({ editingUid: uid || null })
  }

  onHideTextEdit() {
    this.setLocalPresence({ editingUid: null })
    if (this.httpCollabMode) {
      this.flushHttpTextNow().catch(err => {
        console.error('[mind-map] text sync failed', err)
      })
    }
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
    if (this.collabV2Adapter && typeof this.collabV2Adapter.updatePresence === 'function') {
      this.collabV2Adapter.updatePresence(this.getLocalPresence())
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
    const renderer = this.mindMap && this.mindMap.renderer
    if (renderer && renderer._lastRenderWasLayoutSwitch) {
      inspectLayoutRenderer(
        this.mindMap,
        '',
        this.mindMap.getLayout && this.mindMap.getLayout()
      )
    }
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

  setCollabV2Adapter(adapter) {
    this.collabV2Adapter = adapter || null
  }

  establishV2HistoryBaseline() {
    if (this._v2HistoryBaselined) return
    const command = this.mindMap && this.mindMap.command
    if (!command) return
    this._v2HistoryBaselined = true
    command.pause()
    command.clearHistory()
    command.recovery()
    try {
      if (typeof command.originAddHistory === 'function') {
        command.originAddHistory()
      }
    } catch (err) {
      // ignore
    }
    undoTrace('history.baseline', {
      historyLength: command.history.length,
      historyIndex: command.activeHistoryIndex
    })
  }

  submitV2(type, payload) {
    if (!this.collabV2Adapter) {
      return Promise.reject(new Error('collab v2 adapter missing'))
    }
    if (type === 'node.update' && payload) {
      const keys = ['parentUid', 'parent_uid', 'parent', 'index', 'position', 'order']
      const hit = keys.filter(key => payload[key] !== undefined)
      if (hit.length) {
        v2Trace('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', {
          uid: payload.uid,
          keys: hit
        })
        payload = { ...payload }
        keys.forEach(key => {
          delete payload[key]
        })
      }
    }
    const traceId =
      (payload && payload.traceId) ||
      this._commandTraceId ||
      this._pasteTraceId ||
      createTraceId()
    if (payload && !payload.traceId) payload.traceId = traceId
    if (this._pasteTraceId && traceId === this._pasteTraceId) {
      collabTrace('paste.operation', {
        generated: true,
        traceId,
        type
      })
    }
    const uids = uidsFromPayload(type, payload)
    uids.forEach(uid => this.pendingUids.add(uid))
    collabTrace('2.adapter.submit', {
      traceId,
      type,
      roomKey: this.httpRoomKey,
      uids,
      clientId: this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
    })
    const clientId =
      this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
    return this.collabV2Adapter
      .submitOperation({
        type,
        payload,
        roomKey: this.httpRoomKey,
        clientId,
        traceId
      })
      .then(result => {
        this.acknowledgeLocalVersion(result && result.serverRevision, {
          operationId: result && result.opId,
          duplicate: !!(result && result.duplicate)
        })
        this.markAckedFromPayload(type, payload)
        collabTrace('8.ack', {
          traceId,
          opId: result && result.opId,
          revision: result && result.serverRevision,
          type
        })
        return {
          version: result && result.serverRevision,
          duplicate: !!(result && result.duplicate),
          operationId: result && result.opId,
          operation: result && result.operation
        }
      })
      .catch(err => {
        uids.forEach(uid => this.pendingUids.delete(uid))
        collabTrace('8.ack.fail', {
          traceId,
          type,
          message: err && err.message,
          code: err && err.code
        })
        throw err
      })
  }

  async applyV2RemoteOperation(op, meta = {}) {
    const event = (op && op.event) || op || {}
    const type = event.type || op.type
    const payload = event.payload || op.payload || {}
    const mine =
      this.collabV2Adapter &&
      this.collabV2Adapter.getClientId &&
      this.collabV2Adapter.getClientId()
    const opClientId = String(
      (op && op.clientId) ||
        (event && event.clientId) ||
        (payload && payload.clientId) ||
        ''
    ).trim()
    if (mine && opClientId && opClientId === mine && !meta.applySelf) {
      v2Trace('remote.skip-self-client', {
        type,
        opId: op && (op.opId || op.operationId),
        clientId: opClientId
      })
      return true
    }
    v2Trace('remote.recv', {
      type,
      uid: payload.uid,
      parent: payloadParentUid(payload),
      rev: op && (op.serverRevision || op.version),
      clientId: opClientId,
      userId: op && op.userId
    })
    collabTrace('10.remote.recv', {
      traceId: (op && op.traceId) || payload.traceId,
      type,
      uid: payload.uid,
      parent: payloadParentUid(payload),
      rev: op && (op.serverRevision || op.version),
      opId: op && (op.opId || op.operationId)
    })
    if (type === 'batch.applied' && payload.resnapshot) {
      return this.syncHttpRemoteOperations([op])
    }
    if (type === 'batch.applied' && Array.isArray(payload.events)) {
      const pending = payload.events.slice()
      let guard = 0
      while (pending.length && guard < pending.length + 3) {
        guard += 1
        const next = []
        for (const child of pending) {
          const applied = await this.applyV2RemoteOperation(
            {
              event: child,
              serverRevision: op.serverRevision
            },
            { deferFallback: true }
          )
          if (!applied) next.push(child)
        }
        if (next.length === pending.length) break
        pending.splice(0, pending.length, ...next)
      }
      if (pending.length) {
        v2Trace('remote.apply.batch.leftover', { left: pending.length })
        return this.syncHttpRemoteOperations([op])
      }
      return true
    }
    if (type === 'map.updated') {
      this.applyRemoteMapMeta(payload)
      this.lastAppliedVersion = Math.max(
        Number(this.lastAppliedVersion) || 0,
        Number(op.serverRevision) || 0
      )
      return true
    }
    if (type === 'map.replaced' || payload.resnapshot) {
      if (this._v2UndoActive && !this._v2UndoAllowReplace) {
        this._undoFullTreeHits = Number(this._undoFullTreeHits || 0) + 1
        undoFullTreeForbidden('applyV2RemoteOperation.map.replaced')
        return false
      }
      if (this._v2MoveActive && !this._v2MoveAllowReplace) {
        this.markMoveFullTreeForbidden('applyV2RemoteOperation.map.replaced')
        return false
      }
      return this.recoverHttpCollab(op.serverRevision || this.lastAppliedVersion)
    }
    const uid = payload.uid
    const renderer = this.mindMap && this.mindMap.renderer
    if (this.currentData && type && type !== 'map.replaced') {
      try {
        this.currentData = applyCollabEvent(this.currentData, event)
      } catch (err) {
        v2Trace('remote.currentData.fail', { type, uid, message: err && err.message })
      }
    }
    if (type === 'node.inserted' || type === 'node.insert') {
      const inserted = this.applyV2PayloadInsert(payload)
      v2Trace('remote.apply.insert', { uid, ok: inserted })
      if (inserted) {
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (
      type === 'node.moved' ||
      type === 'node.reordered' ||
      type === 'node.move' ||
      type === 'node.reorder'
    ) {
      const moved = await this.applyV2PayloadMove(payload)
      v2Trace('remote.apply.move', { uid, ok: moved, parent: payloadParentUid(payload) })
      if (moved) {
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'node.deleted' || type === 'node.delete') {
      const removed = this.applyV2PayloadDelete(payload)
      v2Trace('remote.apply.delete', { uid, ok: removed })
      if (removed) {
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'node.updated' || type === 'node.update') {
      const updated = this.applyV2PayloadUpdate(payload)
      v2Trace('remote.apply.update', { uid, ok: updated })
      if (updated) {
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'operation.undone' || type === 'operation.redone') {
      const inner = payload.inverse || payload.forward
      if (inner && inner.type) {
        const applied = await this.applyV2RemoteOperation({
          event: {
            type:
              inner.type === 'node.update'
                ? 'node.updated'
                : inner.type === 'node.insert'
                  ? 'node.inserted'
                  : inner.type === 'node.delete'
                    ? 'node.deleted'
                    : inner.type === 'node.move'
                      ? 'node.moved'
                      : inner.type === 'node.reorder'
                        ? 'node.reordered'
                        : inner.type,
            payload: inner.payload || {}
          },
          serverRevision: op.serverRevision
        })
        if (applied) return true
      }
    }
    if (type === 'node.updated' && uid && renderer && typeof renderer.findNodeByUid === 'function') {
      const node = renderer.findNodeByUid(uid)
      const next = this.currentData && this.currentData[uid]
      if (node && next && next.data) {
        this.isApplyingRemote = true
        try {
          this.applyHttpRemoteNodeFields(node, next.data, { data: next.data })
        } finally {
          this.isApplyingRemote = false
        }
        this.notifySearchInvalidate()
        return true
      }
    }
    // Structural remote ops stay node-path incremental (affected uids only).
    // Never reload the whole room / setData(fullTree) on a single op:event.
    const parentUid = payloadParentUid(payload)
    if (
      (type === 'node.inserted' ||
        type === 'node.moved' ||
        type === 'node.deleted') &&
      this.dirtySubtrees
    ) {
      if (parentUid) this.dirtySubtrees.set(parentUid, Date.now())
      if (uid) this.dirtySubtrees.set(uid, Date.now())
    }
    v2Trace('remote.apply.fallback-hydrate', { type, uid, parentUid })
    const applied = this.syncHttpRemoteOperations([op])
    this.notifySearchInvalidate()
    return applied
  }

  isGeneralizationUid(parentUid, uid) {
    if (!parentUid || !uid) return false
    const renderer = this.mindMap && this.mindMap.renderer
    const parentNode =
      renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(parentUid)
        : null
    const parentData = parentNode && parentNode.getData ? parentNode.getData() : null
    if (parentData && generalizationUidsOf(parentData).has(uid)) return true
    const tree = renderer && renderer.renderTree
    const treeNode = tree && this.findTreeNode(tree, parentUid)
    return !!(treeNode && treeNode.data && generalizationUidsOf(treeNode.data).has(uid))
  }

  applyV2PayloadInsert(payload = {}) {
    const uid = payload.uid
    const parentUid = payloadParentUid(payload)
    const renderer = this.mindMap && this.mindMap.renderer
    if (!uid || !parentUid || !renderer || typeof renderer.findNodeByUid !== 'function') {
      return false
    }
    if (this.isGeneralizationUid(parentUid, uid)) {
      v2Trace('remote.apply.insert.skip-gen', { uid, parentUid })
      return true
    }
    if (this.isTombstonedUid(uid)) {
      v2Trace('remote.apply.insert.skip-tombstone', { uid, parentUid })
      const live =
        typeof renderer.findNodeByUid === 'function'
          ? renderer.findNodeByUid(uid)
          : null
      this.removeLocalDeletedUids(new Set([uid]), parentUid, live)
      return true
    }
    if (renderer.findNodeByUid(uid)) return true
    const parentNode = renderer.findNodeByUid(parentUid)
    if (!parentNode) return false
    const data = payloadNodeData(payload)
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      if (!parentNode.nodeData.children) parentNode.nodeData.children = []
      const exists = parentNode.nodeData.children.some(
        child => child && child.data && child.data.uid === uid
      )
      if (!exists) {
        const index = Number(payload.index)
        const child = {
          data: {
            uid,
            text: data.text,
            note: data.note,
            richText: data.richText,
            expand: data.expand !== false,
            ...data
          },
          children: []
        }
        if (Number.isInteger(index) && index >= 0 && index <= parentNode.nodeData.children.length) {
          parentNode.nodeData.children.splice(index, 0, child)
        } else {
          parentNode.nodeData.children.push(child)
        }
      }
      const count = Number(parentNode.getData && parentNode.getData('childCount')) || 0
      const live = parentNode.nodeData.children.length
      renderer.setNodeData(parentNode, {
        expand: true,
        childCount: Math.max(count, live)
      })
      this.mindMap.render()
    } catch (err) {
      v2Trace('remote.apply.insert.err', { uid, message: err && err.message })
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

  markMoveFullTreeForbidden(reason) {
    this._moveFullTreeHits = Number(this._moveFullTreeHits || 0) + 1
    moveFullTreeForbidden(reason, {
      hits: this._moveFullTreeHits
    })
  }

  cleanupDragArtifacts() {
    const drag = this.mindMap && this.mindMap.drag
    if (drag && typeof drag.removeCloneNode === 'function') {
      drag.removeCloneNode()
    }
  }

  snapshotActiveUids() {
    const renderer = this.mindMap && this.mindMap.renderer
    return ((renderer && renderer.activeNodeList) || [])
      .map(node => node && node.getData && node.getData('uid'))
      .filter(Boolean)
  }

  restoreActiveUids(uids = []) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || typeof renderer.findNodeByUid !== 'function') return
    if (typeof renderer.clearActiveNodeList === 'function') {
      renderer.clearActiveNodeList()
    }
    uids.forEach(uid => {
      const node = renderer.findNodeByUid(uid)
      if (node && typeof renderer.setNodeActive === 'function') {
        renderer.setNodeActive(node, true)
      }
    })
  }

  nodeDataHasChild(parent, uid) {
    const kids = (parent && parent.nodeData && parent.nodeData.children) || []
    return kids.some(child => child && child.data && child.data.uid === uid)
  }

  applyNativeMoveCommand(node, nextParent, plan) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || !node || !nextParent || !plan) return false
    if (plan.command === 'MOVE_NODE_TO' && typeof renderer.moveNodeTo === 'function') {
      renderer.moveNodeTo(node, nextParent)
      node.parent = nextParent
      return true
    }
    const anchor =
      plan.anchorUid && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(plan.anchorUid)
        : null
    if (anchor && plan.command === 'INSERT_AFTER' && typeof renderer.insertAfter === 'function') {
      renderer.insertAfter(node, anchor)
      node.parent = nextParent
      return true
    }
    if (anchor && plan.command === 'INSERT_BEFORE' && typeof renderer.insertBefore === 'function') {
      renderer.insertBefore(node, anchor)
      node.parent = nextParent
      return true
    }
    return false
  }

  applyMoveNodeData(node, nextParent, index) {
    const uid = node.getData && node.getData('uid')
    const oldParent = node.parent
    if (oldParent && oldParent !== nextParent) {
      removeFromParentNodeData(node)
    }
    if (!nextParent.nodeData.children) nextParent.nodeData.children = []
    const kids = nextParent.nodeData.children
    const from = kids.findIndex(child => child && child.data && child.data.uid === uid)
    if (from >= 0) kids.splice(from, 1)
    const slot = Number.isInteger(Number(index))
      ? Math.max(0, Math.min(Number(index), kids.length))
      : kids.length
    kids.splice(slot, 0, node.nodeData)
    node.parent = nextParent
    if (oldParent && oldParent !== nextParent && Array.isArray(oldParent.children)) {
      oldParent.children = oldParent.children.filter(item => item !== node)
    }
    if (Array.isArray(nextParent.children) && !nextParent.children.includes(node)) {
      const liveSlot = Math.max(0, Math.min(slot, nextParent.children.length))
      nextParent.children.splice(liveSlot, 0, node)
    }
  }

  waitForMoveRender() {
    return new Promise(resolve => {
      const mm = this.mindMap
      if (!mm) return resolve()
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
        resolve()
      }
      if (typeof mm.once === 'function') mm.once('node_tree_render_end', done)
      else if (typeof mm.on === 'function') mm.on('node_tree_render_end', done)
      if (typeof mm.render === 'function') mm.render()
      setTimeout(done, 120)
    })
  }

  async applyV2PayloadMove(payload = {}) {
    const uid = payload.uid
    const parentUid = payloadParentUid(payload)
    const renderer = this.mindMap && this.mindMap.renderer
    if (!uid || !renderer || typeof renderer.findNodeByUid !== 'function') return false
    const node = renderer.findNodeByUid(uid)
    if (!node || node.isRoot) return false
    if (this.isTombstonedUid && this.isTombstonedUid(uid)) {
      v2Trace('remote.apply.move.skip-tombstone', { uid })
      return true
    }
    let nextParent = parentUid ? renderer.findNodeByUid(parentUid) : node.parent
    if (!nextParent) return false
    if (collabMove.isCycleMove(node, parentUid || (nextParent.getData && nextParent.getData('uid')))) {
      v2Trace('remote.apply.move.cycle', { uid, parentUid })
      return true
    }
    this.isApplyingRemote = true
    this._v2MoveActive = true
    this.mindMap.command.pause()
    let plan = null
    try {
      if (
        typeof this.hydrateLazyChildren === 'function' &&
        nextParent.getData &&
        Number(nextParent.getData('childCount') || 0) >
          ((nextParent.nodeData && nextParent.nodeData.children) || []).length
      ) {
        try {
          await this.hydrateLazyChildren(nextParent)
        } catch (err) {
          v2Trace('remote.apply.move.hydrate.err', {
            uid,
            parentUid,
            message: err && err.message
          })
        }
        nextParent = renderer.findNodeByUid(parentUid) || nextParent
      }
      const oldParent = node.parent
      const oldParentUid = oldParent && oldParent.getData && oldParent.getData('uid')
      const activeUids = this.snapshotActiveUids()
      const plan = collabMove.planNativeMove({
        uid,
        parentUid: parentUid || (nextParent.getData && nextParent.getData('uid')),
        index: payload.index,
        parentKids: (nextParent.nodeData && nextParent.nodeData.children) || [],
        oldParentUid
      })
      const usedNative = this.applyNativeMoveCommand(node, nextParent, plan)
      if (!usedNative || !this.nodeDataHasChild(nextParent, uid)) {
        this.applyMoveNodeData(node, nextParent, payload.index)
        if (typeof this.mindMap.render === 'function') this.mindMap.render()
      }
      const syncChildCount = parent => {
        if (!parent || typeof parent.getData !== 'function') return
        const liveKids = ((parent.nodeData && parent.nodeData.children) || []).length
        if (typeof parent.setData === 'function') {
          parent.setData({ childCount: liveKids })
        }
      }
      syncChildCount(oldParent)
      syncChildCount(nextParent)
      this.cleanupDragArtifacts()
      await this.waitForMoveRender()
      if (oldParent && typeof oldParent.renderLine === 'function') {
        oldParent.renderLine(true)
      }
      if (nextParent && typeof nextParent.renderLine === 'function') {
        nextParent.renderLine(true)
      }
      this.restoreActiveUids(activeUids)
    } catch (err) {
      v2Trace('remote.apply.move.err', { uid, message: err && err.message })
      return false
    } finally {
      try {
        this.mindMap.command.recovery()
      } catch (e) {
        // ignore
      }
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
      this._v2MoveActive = false
    }
    const live = renderer.findNodeByUid(uid)
    const liveParent =
      live && live.parent && live.parent.getData && live.parent.getData('uid')
    const dataOk = this.nodeDataHasChild(nextParent, uid)
    v2Trace('remote.render.move', {
      uid,
      parent: liveParent,
      kind: plan && plan.kind,
      command: plan && plan.command,
      dataOk
    })
    return !!(dataOk || (live && (!parentUid || liveParent === parentUid)))
  }

  applyV2PayloadDelete(payload = {}) {
    const uid = payload.uid
    const renderer = this.mindMap && this.mindMap.renderer
    if (!uid || !renderer) return false
    const node =
      typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
    if (node && node.isRoot) return true
    if (node && node.isGeneralization) {
      v2Trace('remote.apply.delete.skip-gen', { uid })
      return true
    }
    if (this.isGeneralizationUid(payloadParentUid(payload), uid)) {
      v2Trace('remote.apply.delete.skip-gen-uid', { uid })
      return true
    }
    const removed =
      Array.isArray(payload.removed) && payload.removed.length
        ? payload.removed.filter(Boolean)
        : [uid]
    const drop = new Set(removed)
    removed.forEach(id => this.tombstoneDeletedUid(id))
    this.purgeQueuedInserts(drop)
    const dropAdapter =
      this.collabV2Adapter && this.collabV2Adapter.dropPendingInsertsForUid
    if (dropAdapter) {
      removed.forEach(id => {
        Promise.resolve(dropAdapter.call(this.collabV2Adapter, id)).catch(() => {})
      })
    }
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      this.removeLocalDeletedUids(drop, payloadParentUid(payload), node)
      this.mindMap.render()
    } catch (err) {
      v2Trace('remote.apply.delete.err', { uid, message: err && err.message })
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

  removeLocalDeletedUids(drop, parentUid, node) {
    const removed = drop instanceof Set ? drop : new Set(drop || [])
    if (!removed.size && node) {
      const uid = node.getData && node.getData('uid')
      if (uid) removed.add(uid)
    }
    const renderer = this.mindMap && this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    const parentInstance =
      (node && node.parent) ||
      (parentUid &&
        renderer &&
        typeof renderer.findNodeByUid === 'function' &&
        renderer.findNodeByUid(parentUid)) ||
      null
    const parentTree =
      (parentInstance && parentInstance.nodeData) ||
      (tree && parentUid && this.findTreeNode(tree, parentUid))
    if (parentTree && Array.isArray(parentTree.children)) {
      parentTree.children.forEach(child => {
        const id = child && child.data && child.data.uid
        if (id && removed.has(id)) {
          collabInsertCollect.collectNodeDataUids(child).forEach(childUid => {
            removed.add(childUid)
            this.tombstoneDeletedUid(childUid)
          })
        }
      })
      collabInsertCollect.removeUidsFromNodeData(parentTree, removed)
    }
    if (parentInstance) {
      if (
        parentInstance.nodeData &&
        parentInstance.nodeData !== parentTree
      ) {
        collabInsertCollect.removeUidsFromNodeData(
          parentInstance.nodeData,
          removed
        )
      }
      if (Array.isArray(parentInstance.children)) {
        parentInstance.children = parentInstance.children.filter(child => {
          const id = child && child.getData && child.getData('uid')
          if (id && removed.has(id)) return false
          return child !== node
        })
      }
      if (typeof parentInstance.renderLine === 'function') parentInstance.renderLine()
    }
    if (tree && parentUid) {
      const treeParent = this.findTreeNode(tree, parentUid)
      if (treeParent && treeParent !== parentTree) {
        collabInsertCollect.removeUidsFromNodeData(treeParent, removed)
      }
    }
    if (tree && (!parentTree || !parentUid)) {
      const stack = [{ node: tree, parent: null }]
      while (stack.length) {
        const item = stack.pop()
        const cur = item.node
        const parent = item.parent
        const id = cur && cur.data && cur.data.uid
        if (id && removed.has(id) && parent) {
          collabInsertCollect.collectNodeDataUids(cur).forEach(childUid => {
            removed.add(childUid)
            this.tombstoneDeletedUid(childUid)
          })
          collabInsertCollect.removeUidsFromNodeData(parent, removed)
        }
        const kids = (cur && cur.children) || []
        for (let i = 0; i < kids.length; i++) {
          stack.push({ node: kids[i], parent: cur })
        }
      }
    }
  }

  purgeQueuedInserts(uids) {
    const drop = uids instanceof Set ? uids : new Set(uids || [])
    if (!drop.size) return
    if (this._insertFlushQueue) {
      this._insertFlushQueue.forEach(item => {
        if (!item || !Array.isArray(item.preRecords)) return
        item.preRecords = item.preRecords.filter(
          row => row && !drop.has(row.uid)
        )
      })
    }
    drop.forEach(uid => {
      if (this.pendingUids) this.pendingUids.delete(uid)
    })
  }

  applyV2PayloadUpdate(payload = {}) {
    const uid = payload.uid
    const renderer = this.mindMap && this.mindMap.renderer
    if (!uid || !renderer || typeof renderer.findNodeByUid !== 'function') return false
    let node = renderer.findNodeByUid(uid)
    if (!node) return false
    if (
      payload.parentUid !== undefined ||
      payload.parent_uid !== undefined ||
      payload.parent !== undefined ||
      payload.index !== undefined ||
      payload.position !== undefined ||
      payload.order !== undefined
    ) {
      v2Trace('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', {
        uid,
        keys: ['parent', 'index', 'position'].filter(
          () =>
            payload.parentUid !== undefined ||
            payload.index !== undefined ||
            payload.position !== undefined
        )
      })
    }
    let next = payloadNodeData(payload)
    if (node.isGeneralization && node.generalizationBelongNode) {
      const owner = node.generalizationBelongNode
      const genUid = (node.getData && node.getData('uid')) || uid
      if (!Object.prototype.hasOwnProperty.call(next, 'generalization')) {
        next = {
          generalization: collabGeneralization.mergeVirtualEditIntoOwner(
            owner.getData && owner.getData('generalization'),
            genUid,
            next
          )
        }
      }
      node = owner
      v2Trace('remote.apply.update.gen-remap', {
        virtualUid: uid,
        ownerUid: owner.getData && owner.getData('uid')
      })
    }
    const before = {
      parent:
        (node.parent && node.parent.getData && node.parent.getData('uid')) ||
        null,
      position: node.getData && node.getData('position')
    }
    this.isApplyingRemote = true
    try {
      this.applyHttpRemoteNodeFields(node, next, { data: next })
      this.rememberPushedNode(node)
    } finally {
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
    const afterParent =
      (node.parent && node.parent.getData && node.parent.getData('uid')) || null
    if (afterParent !== before.parent) {
      console.error('STYLE_STRUCTURAL_MUTATION', {
        uid,
        parent: [before.parent, afterParent]
      })
    }
    return true
  }

  applyRemoteMapMeta(payload = {}, options = {}) {
    if (!this.mindMap || this.isApplyingRemote) return
    const hydrate = !!options.hydrate
    const patch = hydrate
      ? hydrateSharedMetadata(payload)
      : {
          ...pickLiveMetaPatch(payload),
          source: 'remote apply'
        }
    const theme = patch.theme
    const themeConfig = patch.themeConfig
    const layout = patch.layout
    if (theme == null && themeConfig == null && layout == null) return
    const before = canonicalStructureFromTree(
      this.mindMap.renderer && this.mindMap.renderer.renderTree
    )
    const beforeSig = structureSignature(before)
    this.isApplyingRemote = true
    try {
      if (theme != null && this.mindMap.opt) {
        this.mindMap.opt.theme = theme
      }
      if (themeConfig !== undefined && this.mindMap.opt) {
        this.mindMap.opt.themeConfig = themeConfig || {}
      }
      const currentLayout =
        this.mindMap.getLayout && this.mindMap.getLayout()
      const layoutChanged = !!(layout && layout !== currentLayout)
      if (layoutChanged && this.mindMap.opt && this.mindMap.renderer) {
        this.mindMap.opt.layout = layout
        if (typeof this.mindMap.renderer.setLayout === 'function') {
          this.mindMap.renderer.setLayout()
        }
      }
      if (theme != null || themeConfig !== undefined) {
        if (typeof this.mindMap.initTheme === 'function') this.mindMap.initTheme()
      }
      const shouldRender =
        theme != null || themeConfig !== undefined || layoutChanged
      if (shouldRender && typeof this.mindMap.render === 'function') {
        this.mindMap.render(
          null,
          theme != null || themeConfig !== undefined
            ? 'changeTheme'
            : 'changeLayout'
        )
      }
      if (theme != null) this.mindMap.emit('view_theme_change', theme)
      if (layoutChanged) this.mindMap.emit('layout_change', layout)
      if (layoutChanged || (hydrate && layout)) {
        publishLayoutApplyTrace({
          layout: layout || currentLayout,
          source: hydrate ? 'server metadata' : 'remote apply',
          revision: Number(payload.version || this.lastAppliedVersion || 0),
          renderCount:
            this.mindMap.renderer && this.mindMap.renderer._layoutRenderCount,
          layoutCount:
            this.mindMap.renderer && this.mindMap.renderer._layoutSwitchCount
        })
      }
      const after = canonicalStructureFromTree(
        this.mindMap.renderer && this.mindMap.renderer.renderTree
      )
      if (beforeSig !== structureSignature(after)) {
        warnStructuralMutation(layout && theme == null ? 'layout' : 'theme', before, after)
      }
      publishMapMetaState({
        roomKey: this.httpRoomKey || '',
        serverMetadata: payload.metadata || {
          ...(theme != null ? { theme } : {}),
          ...(themeConfig !== undefined ? { themeConfig } : {}),
          ...(layout ? { layout } : {})
        },
        appliedTheme: this.mindMap.getTheme ? this.mindMap.getTheme() : theme,
        appliedLayout: this.mindMap.getLayout ? this.mindMap.getLayout() : layout,
        lastMetaRevision: Number(payload.version || this.lastAppliedVersion || 0),
        source: hydrate ? 'server metadata' : 'remote apply'
      })
    } finally {
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
  }

  hydrateRoomMetadata(input = {}, options = {}) {
    if (!this.mindMap) return
    if (typeof window !== 'undefined') {
      window.__STYLE_COMMAND_MATRIX__ = STYLE_COMMAND_MATRIX
    }
    const shared = hydrateSharedMetadata(input)
    if (shared.source !== 'server metadata') {
      publishMapMetaState({
        roomKey: this.httpRoomKey || options.roomKey || '',
        serverMetadata: shared.metadata,
        appliedTheme: this.mindMap.getTheme ? this.mindMap.getTheme() : '',
        appliedLayout: this.mindMap.getLayout ? this.mindMap.getLayout() : '',
        lastMetaRevision: Number(input.version || 0),
        source: 'default'
      })
      if (typeof window !== 'undefined') {
        window.__STYLE_COMMAND_MATRIX__ = STYLE_COMMAND_MATRIX
      }
      return
    }
    this.applyRemoteMapMeta(
      {
        metadata: shared.metadata,
        theme: shared.theme,
        themeConfig: shared.themeConfig,
        layout: shared.layout,
        version: input.version
      },
      { hydrate: true }
    )
  }

  setHttpCollab(config = {}) {
    this.setLazyLoaders(config)
    this.httpCollabMode = true
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.abandonedInsertUids = new Set()
    this.deletedUids = new Set()
    this.dirtySubtrees = new Map()
    this.localUndoStack = []
    this.localRedoStack = []
    this.pendingGenIntent = new Map()
    this.enableLargeMapMode(Number(config.nodeCount) || 0)
    const roomKey = config.roomKey || this.httpRoomKey || ''
    if (roomKey) this.httpRoomKey = roomKey
    this.collabStore.reset(roomKey, Number(config.version) || 0)
    this.collabStore.setStatus('live')
    this.wrapHttpMutators(config)
    this.wrapSearchReplace()
    this.publishTreeAuthorityState(config)
  }

  publishTreeAuthorityState(extra = {}) {
    if (typeof window === 'undefined') return
    const adapter = this.collabV2Adapter
    const status = adapter && adapter.getStatus ? adapter.getStatus() : null
    window.__TREE_AUTHORITY_STATE__ = {
      roomKey: extra.roomKey || this.httpRoomKey || '',
      treeSource: extra.treeSource || 'room_nodes',
      roomNodesInitialized: extra.roomNodesInitialized !== false,
      roomNodesCount: extra.roomNodesCount,
      roomNodesHash: extra.roomNodesHash || '',
      roomsJsonCount: extra.roomsJsonCount,
      roomsJsonHash: extra.roomsJsonHash || '',
      roomsVersion: extra.version || extra.roomsVersion || this.lastAppliedVersion || 0,
      lastServerRevision:
        (status && status.lastServerRevision) || extra.version || 0,
      legacyFallback: !!extra.legacyFallback,
      legacyFallbackReason: extra.legacyFallbackReason || ''
    }
  }

  submitMapMeta(patch) {
    if (!this.httpCollabMode || !this.collabV2Adapter || !patch) return
    if (this.isApplyingRemote || this.httpReplacing) return
    this.submitV2('map.meta.update', patch).catch(err => {
      console.error('[mind-map] map meta sync failed', err)
    })
  }

  onThemeChange(theme) {
    if (!this.httpCollabMode || this.isApplyingRemote) return
    this.submitMapMeta({
      theme,
      themeConfig: this.mindMap.getCustomThemeConfig
        ? this.mindMap.getCustomThemeConfig()
        : undefined
    })
  }

  onLayoutChange(layout) {
    if (this.isApplyingRemote) return
    publishLayoutApplyTrace({
      layout,
      source: 'local setLayout',
      revision: Number(this.lastAppliedVersion || 0),
      renderCount:
        this.mindMap.renderer && this.mindMap.renderer._layoutRenderCount,
      layoutCount:
        this.mindMap.renderer && this.mindMap.renderer._layoutSwitchCount
    })
    if (!this.httpCollabMode) return
    this.submitMapMeta({ layout })
  }

  wrapSearchReplace() {
    const search = this.mindMap && this.mindMap.search
    if (!search || search._v2Wrapped) return
    search._v2Wrapped = true
    const origOne = search.replace.bind(search)
    const origAll = search.replaceAll.bind(search)
    search.replace = (replaceText, jumpNext = false) => {
      if (!this.httpCollabMode || !this.collabV2Adapter) {
        return origOne(replaceText, jumpNext)
      }
      return this.replaceOneViaV2(search, replaceText, jumpNext, origOne)
    }
    search.replaceAll = replaceText => {
      if (!this.httpCollabMode || !this.collabV2Adapter) {
        return origAll(replaceText)
      }
      return this.replaceAllViaV2(search, replaceText, origAll)
    }
  }

  resolveSearchNode(search, node) {
    if (!node) return null
    if (search && typeof search.isNodeInstance === 'function' && search.isNodeInstance(node)) {
      return node
    }
    const uid =
      (node.getData && node.getData('uid')) ||
      (node.data && node.data.uid) ||
      node.uid
    const renderer = this.mindMap && this.mindMap.renderer
    if (uid && renderer && typeof renderer.findNodeByUid === 'function') {
      return renderer.findNodeByUid(uid)
    }
    return null
  }

  replacedSearchText(source, needle, replacement) {
    const text = String(source == null ? '' : source)
    const from = String(needle || '')
    if (!from) return text
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replace(new RegExp(escaped, 'g'), String(replacement == null ? '' : replacement))
  }

  collectLocalSearchMatches(query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer) return []
    const seen = new Set()
    const out = []
    const take = (uid, text) => {
      if (!uid || seen.has(uid)) return
      const plain = getTextFromHtml(String(text == null ? '' : text))
      const hay = (plain || String(text || '')).toLowerCase()
      if (!hay.includes(q)) return
      seen.add(uid)
      out.push({
        uid,
        text: plain || String(text || ''),
        name: plain || String(text || '')
      })
    }
    const visitTree = node => {
      if (!node) return
      if (typeof node.getData === 'function') {
        const data = node.getData() || {}
        take(data.uid, data.text)
        ;(node.children || []).forEach(visitTree)
        return
      }
      const data = node.data || {}
      take(data.uid, data.text)
      ;(node.children || []).forEach(child => {
        if (child && typeof child === 'object') visitTree(child)
      })
    }
    if (renderer.root) visitTree(renderer.root)
    if (renderer.renderTree) visitTree(renderer.renderTree)
    return out
  }

  matchExpectedText(match) {
    if (!match) return ''
    if (match.name != null && String(match.name) !== '') return String(match.name)
    const data = match.data || {}
    if (data.text != null) return String(data.text)
    if (match.text != null && String(match.text).indexOf('<') === -1) {
      return String(match.text)
    }
    return ''
  }

  applyLocalReplaceText(uid, nextText) {
    const renderer = this.mindMap && this.mindMap.renderer
    const live =
      uid && renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
    if (!live || typeof live.setText !== 'function') return false
    this.isApplyingRemote = true
    try {
      live.setText(nextText, live.getData && live.getData('richText'))
    } finally {
      this.suppressLocalUntil = Date.now() + 250
      this.isApplyingRemote = false
    }
    return true
  }

  replaceOneBySearchMatch(match, searchText, replaceText) {
    const uid = match && (match.uid || match.id)
    if (!uid) return Promise.resolve({ replaced: 0, skipped: 0 })
    const renderer = this.mindMap && this.mindMap.renderer
    const live =
      renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
    const oldText = live ? this.nodePlain(live) : this.matchExpectedText(match)
    const nextText = this.replacedSearchText(oldText, searchText, replaceText)
    if (oldText === nextText) return Promise.resolve({ replaced: 0, skipped: 0 })
    this.applyLocalReplaceText(uid, nextText)
    return this.submitV2('node.update', {
      uid,
      text: nextText,
      expected: { text: oldText }
    }).then(result => {
      this.notifySearchInvalidate()
      return result
    })
  }

  replaceAllBySearchMatches(matches, searchText, replaceText) {
    const list = Array.isArray(matches) ? matches : []
    const renderer = this.mindMap && this.mindMap.renderer
    const ops = []
    const seen = new Set()
    this.httpReplaceAllActive = true
    try {
      list.forEach(match => {
        const uid = match && (match.uid || match.id)
        if (!uid || seen.has(uid)) return
        seen.add(uid)
        const live =
          renderer && typeof renderer.findNodeByUid === 'function'
            ? renderer.findNodeByUid(uid)
            : null
        const oldText = live ? this.nodePlain(live) : this.matchExpectedText(match)
        const nextText = this.replacedSearchText(oldText, searchText, replaceText)
        if (oldText === nextText) return
        this.applyLocalReplaceText(uid, nextText)
        ops.push({
          type: 'node.update',
          payload: {
            uid,
            text: nextText,
            expected: { text: oldText }
          }
        })
      })
    } catch (err) {
      this.httpReplaceAllActive = false
      throw err
    }
    if (!ops.length) {
      this.httpReplaceAllActive = false
      return Promise.resolve({ replaced: 0, skipped: 0 })
    }
    const batchId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'replace-all-' + Date.now()
    return this.submitV2('node.batch', { ops, batchId })
      .then(result => {
        const skipped =
          (result &&
            result.operation &&
            result.operation.event &&
            result.operation.event.payload &&
            result.operation.event.payload.skipped) ||
          (result && result.result && result.result.skipped) ||
          0
        this.mindMap.emit('collab_replace_all_done', {
          replaced: Math.max(0, ops.length - Number(skipped || 0)),
          skipped: Number(skipped || 0)
        })
        this.notifySearchInvalidate()
        return result
      })
      .finally(() => {
        this.httpReplaceAllActive = false
      })
  }

  replaceOneViaV2(search, replaceText, jumpNext, origOne) {
    const current = search.matchNodeList && search.matchNodeList[search.currentIndex]
    const node = this.resolveSearchNode(search, current)
    const uid =
      (node && node.getData && node.getData('uid')) ||
      (current && current.uid) ||
      (current && current.data && current.data.uid)
    if (!uid) {
      const orig = origOne(replaceText, jumpNext)
      return orig
    }
    const oldText = node ? this.nodePlain(node) : this.matchExpectedText(current)
    const nextText = node
      ? search.getReplacedText(node, search.searchText, String(replaceText))
      : this.replacedSearchText(oldText, search.searchText, replaceText)
    if (oldText === nextText) return { replaced: 0, skipped: 0 }
    this.applyLocalReplaceText(uid, nextText)
    return this.submitV2('node.update', {
      uid,
      text: nextText,
      expected: { text: oldText }
    }).then(result => {
      this.notifySearchInvalidate()
      return result
    })
  }

  replaceAllViaV2(search, replaceText, origAll) {
    const matches = (search.matchNodeList || []).slice()
    if (!matches.length) return origAll(replaceText)
    return this.replaceAllBySearchMatches(
      matches.map(node => {
        const resolved = this.resolveSearchNode(search, node) || node
        const uid =
          (resolved && resolved.getData && resolved.getData('uid')) ||
          (node && node.uid) ||
          (node && node.data && node.data.uid)
        const oldText = resolved && resolved.getData ? this.nodePlain(resolved) : this.matchExpectedText(node)
        return { uid, name: oldText }
      }),
      search.searchText,
      replaceText
    )
  }

  notifySearchInvalidate() {
    if (!this.mindMap) return
    this.mindMap.emit('collab_search_invalidate')
    if (this.httpCollabMode && this.httpRoomKey) return
    const search = this.mindMap.search
    if (search && search.isSearching && search.searchText) {
      search.search(search.searchText)
    }
  }

  wrapHttpMutators(config = {}) {
    if (this.collabV2Adapter) {
      this.httpPatchNode = (uid, body) => {
        const next = { ...(body || {}), uid }
        ;['parentUid', 'parent_uid', 'parent', 'index', 'position', 'order'].forEach(
          key => {
            delete next[key]
          }
        )
        return this.submitV2('node.update', next)
      }
      this.httpAddNode = body => this.submitV2('node.insert', body || {})
      this.httpDeleteNode = (uid, options) =>
        this.submitV2('node.delete', { ...(options || {}), uid })
      this.httpReplaceTree = (tree, extra) =>
        this.submitV2('map.replace', { tree, ...(extra || {}) })
      return
    }
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
      this.httpReplaceTree = (tree, extra) =>
        this.wrapHttpMutation('map.replace', { tree }, payload =>
          config.replaceTree(payload.tree, extra)
        )
    }
  }

  wrapHttpMutation(type, body, send) {
    if (this.mindMap && this.mindMap.opt && this.mindMap.opt.readonly) {
      const err = new Error('当前为只读权限，无法修改')
      err.code = 'FORBIDDEN'
      err.statusCode = 403
      return Promise.reject(err)
    }
    if (this.httpReplacing && type !== 'map.replace') {
      const err = new Error('正在保存整图，请稍候再试')
      err.code = 'REPLACE_IN_PROGRESS'
      return Promise.reject(err)
    }
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
    const run = async () => {
      let lastErr
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await send(payload)
        } catch (err) {
          lastErr = err
          if (err && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
            this.mindMap.emit('room_acl_denied', err)
            throw err
          }
          if (!isRateLimitedError(err) || attempt === 3) throw err
          await sleepMs(
            Math.min(8000, Number(err.retryAfterMs) || 400 * Math.pow(2, attempt))
          )
        }
      }
      throw lastErr
    }
    return Promise.resolve()
      .then(() => run())
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
    this.httpSettlingAfterReplace = false
    this.httpReplaceNodeCount = 0
    this.lastAppliedVersion = 0
    this.localUndoStack = []
    this.localRedoStack = []
    this.dirtySubtrees = new Map()
    this.httpRecovering = false
    this.httpPendingRecoverVersion = 0
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    this.pendingHttpGeneralizationOwners = []
    this.pendingGenIntent = new Map()
    this.abandonedInsertUids = new Set()
    this.deletedUids = new Set()
    this.httpHistorySyncing = false
    this.httpRefreshing = false
    this.httpPendingRefreshAt = ''
    this.httpPendingRefreshForce = false
    clearTimeout(this.httpRemoteRecoverTimer)
    this.httpRemoteRecoverTimer = null
    this.httpPendingRemoteVersion = 0
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    clearTimeout(this.httpSettleTimer)
    this.httpSettleTimer = null
    this.httpSettlingAfterReplace = false
    this.httpInsertRescan = false
    if (this.collabStore) this.collabStore.reset('', 0)
  }

  beginHttpReplace() {
    this.httpReplacing = true
    this.httpSettlingAfterReplace = false
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    clearTimeout(this.httpSettleTimer)
    this.httpSettleTimer = null
  }

  isHttpSettling() {
    return !!(
      this.httpReplacing ||
      this.httpReplaceInFlight ||
      this.httpSettlingAfterReplace ||
      Date.now() < this.suppressLocalUntil
    )
  }

  postReplaceSettleMs() {
    const count = Number(this.httpReplaceNodeCount) || 0
    if (count >= 400) return 12000
    if (count >= 100) return 6000
    return 3000
  }

  endHttpReplace() {
    this.httpReplacing = false
    this.httpReplaceInFlight = false
    this.httpSettlingAfterReplace = true
    const settleMs = this.postReplaceSettleMs()
    this.suppressLocalUntil = Date.now() + settleMs
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    clearTimeout(this.httpSettleTimer)
    this.httpSettleTimer = setTimeout(() => {
      this.httpSettleTimer = null
      this.captureHttpBaselineFromRenderer()
      this.httpPendingRefreshAt = ''
      this.httpPendingRefreshForce = false
      this.httpSettlingAfterReplace = false
    }, settleMs)
  }

  afterHttpReplace(result, treeOverride) {
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.dirtySubtrees = new Map()
    this.abandonedInsertUids = new Set()
    this.deletedUids = new Set()
    this.pendingHttpDeletes = []
    this.pendingHttpGeneralizationOwners = []
    this.pendingGenIntent = new Map()
    this.hydrateFailedUids = new Set()
    const tree =
      treeOverride ||
      (this.mindMap.renderer && this.mindMap.renderer.renderTree) ||
      null
    this.httpReplaceNodeCount = 0
    if (tree) {
      this.markTreeUids(tree)
      this.httpReplaceNodeCount = Object.keys(this.lastPushed || {}).length
    }
    this.hydratedUids = new Set()
    if (result && result.updated_at) this.httpUpdatedAt = result.updated_at
    if (result && result.version != null) {
      this.acknowledgeLocalVersion(result.version, {
        duplicate: true,
        operationId: result.operationId || result.operation_id
      })
      this.stampLoadedSubtreeVersions(this.lastAppliedVersion)
    }
  }

  resyncHttpBaseline(tree) {
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.recentPushed = new Map()
    if (tree) this.markTreeUids(tree)
  }

  captureHttpBaselineFromRenderer() {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer) return
    const walk = node => {
      if (!node || typeof node.getData !== 'function') return
      if (node.isGeneralization) return
      const uid = node.getData('uid')
      if (uid && this.isPersistAcked(uid)) {
        const full = this.nodePatchPayload(node)
        this.lastPushed[uid] = {
          text: full.text,
          note: full.note,
          full
        }
      }
      ;(node.children || []).forEach(walk)
    }
    if (renderer.root) walk(renderer.root)
  }

  async persistHttpReplace(fullData, extra = {}) {
    if (!this.httpReplaceTree) {
      throw new Error('replaceTree not configured')
    }
    const allowed =
      extra.allowFullTree === true ||
      extra.source === 'import' ||
      extra.source === 'restore' ||
      extra.source === 'legacy-migrate'
    if (this.collabV2Adapter && !allowed) {
      const row = {
        feature: extra.feature || 'persistHttpReplace',
        caller: extra.caller || 'Cooperate.persistHttpReplace',
        roomKey: this.httpRoomKey,
        stack: new Error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION').stack
      }
      console.error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION', row)
      const err = new Error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION')
      err.code = 'UNEXPECTED_FULL_TREE_MUTATION'
      throw err
    }
    if (this.httpReplaceInFlight) {
      const err = new Error('正在保存整图，请稍候再试')
      err.code = 'REPLACE_IN_PROGRESS'
      throw err
    }
    this.httpReplaceInFlight = true
    const tree = (fullData && fullData.root) || fullData
    try {
      const result = await this.httpReplaceTree(tree, extra)
      this.afterHttpReplace(result, tree)
      return result
    } finally {
      this.httpReplaceInFlight = false
    }
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
      if (!uid || have.has(uid) || this.isTombstonedUid(uid)) return
      data.children.push(child)
      have.add(uid)
      this.markUidPushed(uid, child.data, 'server')
    })
  }

  markUidPushed(uid, data, source = 'server') {
    if (!uid || !data) return
    if (source !== 'server' && source !== 'ack') return
    const text =
      data.richText ? getTextFromHtml(data.text) : String(data.text || '')
    const note = data.note || ''
    const full = { text, note, ...collectStyleFields(data) }
    NULLABLE_PATCH_KEYS.forEach(key => {
      const value = data[key]
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      if (!empty) full[key] = collabGeneralization.snapshotValue(value)
    })
    if (!this.ackedUids) this.ackedUids = new Set()
    if (!this.pendingUids) this.pendingUids = new Set()
    this.ackedUids.add(uid)
    this.pendingUids.delete(uid)
    this.lastPushed[uid] = { text, note, full }
  }

  rememberPushedNode(node) {
    const target = this.resolveHttpPatchNode(node)
    const uid = target && target.getData && target.getData('uid')
    if (!uid) return
    const full = this.nodePatchPayload(target)
    this.lastPushed[uid] = {
      text: full.text,
      note: full.note,
      full: collabGeneralization.snapshotValue(full),
      snap: JSON.stringify(full)
    }
  }

  markAckedFromPayload(type, payload) {
    const uids = uidsFromPayload(type, payload)
    uids.forEach(uid => {
      if (!this.ackedUids) this.ackedUids = new Set()
      this.ackedUids.add(uid)
      if (this.pendingUids) this.pendingUids.delete(uid)
      if (!this.lastPushed[uid]) {
        const text = payload && (payload.text != null ? String(payload.text) : '')
        this.lastPushed[uid] = {
          text,
          note: (payload && payload.note) || '',
          full: { text, note: (payload && payload.note) || '' }
        }
      }
    })
  }

  isPersistAcked(uid) {
    return !!(uid && this.ackedUids && this.ackedUids.has(uid))
  }

  resolveHttpPatchNode(node) {
    if (node && node.isGeneralization && node.generalizationBelongNode) {
      return node.generalizationBelongNode
    }
    return node
  }

  generalizationRemoteChanged(localData = {}, next = {}) {
    return (
      generalizationSignature(localData.generalization) !==
      generalizationSignature(next.generalization)
    )
  }

  normalizeGeneralizationData(generalization) {
    const list = collabGeneralization.ownerGeneralizationPayload(generalization)
    if (!list) return null
    return list.map(item => {
      if (!item || typeof item !== 'object') return item
      if (Array.isArray(item.range) && item.range.length >= 2) {
        item.range = [Number(item.range[0]), Number(item.range[1])]
      } else {
        delete item.range
      }
      return item
    })
  }

  stampLocalFieldVersion(node, group) {
    if (!node || !group) return
    const uid = node.getData && node.getData('uid')
    const fv = { ...readFieldVersions(node.getData && node.getData()) }
    const pushed =
      uid && this.lastPushed[uid] && this.lastPushed[uid].fieldVersions
    fv[group] = Math.max(
      Number(fv[group] || 0),
      Number((pushed && pushed[group]) || 0)
    ) + 1
    const renderer = this.mindMap && this.mindMap.renderer
    if (renderer && typeof renderer.setNodeData === 'function') {
      renderer.setNodeData(node, { [FV_KEY]: fv })
    } else if (typeof node.setData === 'function') {
      node.setData({ [FV_KEY]: fv })
    }
    if (uid && this.lastPushed[uid]) {
      this.lastPushed[uid].fieldVersions = {
        ...(this.lastPushed[uid].fieldVersions || {}),
        [group]: fv[group]
      }
    }
  }

  setGenIntent(uid, generalization) {
    if (!uid) return
    if (!this.pendingGenIntent) this.pendingGenIntent = new Map()
    this.pendingGenIntent.set(uid, {
      gen: this.normalizeGeneralizationData(generalization),
      at: Date.now()
    })
  }

  getGenIntent(uid) {
    if (!uid || !this.pendingGenIntent) return null
    const pending = this.pendingGenIntent.get(uid)
    if (!pending) return null
    if (Date.now() - pending.at > GEN_INTENT_MS) {
      this.pendingGenIntent.delete(uid)
      return null
    }
    return pending
  }

  stampGenIntentFromLocal() {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || typeof renderer.findNodeByUid !== 'function') return
    Object.keys(this.lastPushed || {}).forEach(uid => {
      const node = renderer.findNodeByUid(uid)
      if (!node || typeof node.getData !== 'function') return
      const localGen = node.getData('generalization')
      const pushed =
        this.lastPushed[uid] &&
        this.lastPushed[uid].full &&
        this.lastPushed[uid].full.generalization
      if (generalizationSignature(localGen) === generalizationSignature(pushed)) {
        return
      }
      this.setGenIntent(uid, localGen)
      this.stampLocalFieldVersion(node, 'generalization')
    })
  }

  applyLocalGeneralization(node, generalization) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!node || !renderer) return false
    const localData = (node.getData && node.getData()) || {}
    const nextGen = this.normalizeGeneralizationData(generalization)
    const empty = nextGen == null || (Array.isArray(nextGen) && nextGen.length === 0)
    if (
      generalizationSignature(localData.generalization) ===
      generalizationSignature(empty ? null : nextGen)
    ) {
      return false
    }
    if (empty) {
      renderer.setNodeData(node, { generalization: null })
      if (typeof node.removeGeneralization === 'function') {
        node.removeGeneralization()
      }
      if (typeof renderer.reRenderNodeCheckChange === 'function') {
        renderer.reRenderNodeCheckChange(node, false)
      }
      return true
    }
    renderer.setNodeData(node, { generalization: nextGen })
    if (typeof node.removeGeneralization === 'function') {
      node.removeGeneralization()
    }
    if (typeof node.createGeneralizationNode === 'function') {
      node.createGeneralizationNode()
    }
    if (typeof node.renderGeneralization === 'function') {
      node.renderGeneralization(true)
    } else if (typeof node.updateGeneralization === 'function') {
      node.updateGeneralization()
    }
    if (typeof renderer.reRenderNodeCheckChange === 'function') {
      renderer.reRenderNodeCheckChange(node, false)
    }
    this.hydrateGeneralizationParent(node, nextGen)
      .then(hydrated => {
        if (hydrated && this.mindMap) this.mindMap.render()
      })
      .catch(() => {})
    return true
  }

  generalizationNeedsHydrate(node, generalization) {
    if (!node || !generalization) return false
    const list = formatGetNodeGeneralization({ generalization })
    let maxIndex = -1
    list.forEach(item => {
      if (!item || !Array.isArray(item.range) || item.range.length < 2) return
      maxIndex = Math.max(maxIndex, Number(item.range[1]))
    })
    if (maxIndex < 0) return false
    const live = node.children ? node.children.length : 0
    const childCount = Number(node.getData && node.getData('childCount')) || 0
    return live <= maxIndex && childCount > live
  }

  async hydrateGeneralizationParent(node, generalization) {
    if (!node || !this.httpFetchSubtree) return false
    const uid = node.getData && node.getData('uid')
    if (!uid) return false
    if (!this.generalizationNeedsHydrate(node, generalization)) return false
    node.setData({ expand: true })
    const treeNode = this.findTreeNode(
      this.mindMap.renderer && this.mindMap.renderer.renderTree,
      uid
    )
    if (treeNode && treeNode.data) treeNode.data.expand = true
    try {
      const result = await this.httpFetchSubtree(uid, {
        knownVersion: 0,
        priority: 'high'
      })
      if (treeNode) {
        this.mergeHttpChildren(treeNode, (result && result.children) || [])
        if (treeNode.data) {
          treeNode.data.childCount =
            (result && result.total) ||
            Number(treeNode.data.childCount) ||
            (treeNode.children || []).length
        }
      }
      this.dirtySubtrees.delete(uid)
      this.hydratedUids.add(uid)
      return true
    } catch (err) {
      console.error('[mind-map] hydrate generalization parent failed', uid, err)
      return false
    }
  }

  shouldIgnoreRemoteGeneralization(uid, nextGen) {
    const pending = this.getGenIntent(uid)
    if (!pending) return false
    if (
      generalizationSignature(pending.gen) ===
      generalizationSignature(nextGen)
    ) {
      this.pendingGenIntent.delete(uid)
      return false
    }
    return true
  }

  applyHttpRemoteNodeFields(node, next = {}, merged = {}) {
    const renderer = this.mindMap.renderer
    if (!node || !renderer) return false
    let changed = false
    const stylePayload = {
      text: next.text,
      note: next.note,
      richText: next.richText,
      image: next.image,
      imageTitle: next.imageTitle,
      imageSize: next.imageSize,
      icon: next.icon,
      tag: next.tag,
      hyperlink: next.hyperlink,
      hyperlinkTitle: next.hyperlinkTitle,
      outerFrame: next.outerFrame,
      mapRef: next.mapRef,
      associativeLineTargets: next.associativeLineTargets,
      associativeLineTargetControlOffsets: next.associativeLineTargetControlOffsets,
      associativeLinePoint: next.associativeLinePoint,
      associativeLineText: next.associativeLineText,
      associativeLineStyle: next.associativeLineStyle,
      formula: next.formula,
      attachmentUrl: next.attachmentUrl,
      attachmentName: next.attachmentName,
      customLeft: next.customLeft,
      customTop: next.customTop
    }
    Object.keys(next || {}).forEach(key => {
      if (checkIsNodeStyleDataKey(key)) stylePayload[key] = next[key]
    })
    Object.keys(stylePayload).forEach(key => {
      if (stylePayload[key] === undefined) delete stylePayload[key]
    })
    if (Object.keys(stylePayload).length) {
      const data = node.nodeData && node.nodeData.data
      Object.keys(stylePayload).forEach(key => {
        if (!data) return
        if (stylePayload[key] === null) delete data[key]
        else data[key] = stylePayload[key]
      })
      if (typeof renderer.reRenderNodeCheckChange === 'function') {
        renderer.reRenderNodeCheckChange(node, false)
      } else if (node.reRender) {
        node.reRender()
      }
      if (node.parent && typeof node.parent.renderLine === 'function') {
        node.parent.renderLine(true)
      } else if (typeof node.renderLine === 'function') {
        node.renderLine(true)
      }
      changed = true
    }
    if (merged.data && merged.data[FV_KEY]) {
      renderer.setNodeData(node, { [FV_KEY]: merged.data[FV_KEY] })
    }
    if (Object.prototype.hasOwnProperty.call(next, 'generalization')) {
      const nextGen = this.normalizeGeneralizationData(next.generalization)
      const ownerUid = node.getData && node.getData('uid')
      const pending = this.getGenIntent(ownerUid)
      if (this.shouldIgnoreRemoteGeneralization(ownerUid, nextGen)) {
        if (this.applyLocalGeneralization(node, pending && pending.gen)) {
          changed = true
        }
      } else if (this.applyLocalGeneralization(node, next.generalization)) {
        changed = true
      }
    }
    return changed
  }

  syncGeneralizationChildStubs(treeNode, localData = {}, remoteData = {}) {
    if (!treeNode || !Array.isArray(treeNode.children)) return false
    const genUids = new Set(
      [...formatGetNodeGeneralization(localData), ...formatGetNodeGeneralization(remoteData)]
        .map(item => item && item.uid)
        .filter(Boolean)
    )
    if (!genUids.size) return false
    const next = treeNode.children.filter(child => {
      const id = child && child.data && child.data.uid
      return !genUids.has(id)
    })
    if (next.length === treeNode.children.length) return false
    treeNode.children = next
    return true
  }

  markTreeUids(root) {
    // Server-authoritative trees only. Never walk the live renderer
    // after a local edit — that would mark un-ACKed uids as persisted.
    const walk = node => {
      if (!node) return
      const data = node.data || (node.nodeData && node.nodeData.data)
      const uid = data && data.uid
      this.markUidPushed(uid, data, 'server')
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
    const pending = this.hydrateInflight && this.hydrateInflight.get(uid)
    if (pending) return pending
    const job = (async () => {
      this.httpHydrating = true
      try {
        const fetchSubtree = (options = {}) =>
          this.httpFetchSubtree(uid, {
            knownVersion: options.knownVersion ?? 0,
            deep: options.deep,
            priority: 'high'
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
          const deep = await this.httpFetchDeepSubtree(uid, {
            knownVersion: 0,
            maxNodes: 400,
            priority: 'high'
          })
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
      } finally {
        this.httpHydrating = false
        this.flushPendingHttpRefresh()
      }
    })()
    if (this.hydrateInflight) this.hydrateInflight.set(uid, job)
    try {
      return await job
    } finally {
      if (this.hydrateInflight && this.hydrateInflight.get(uid) === job) {
        this.hydrateInflight.delete(uid)
      }
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
    let result = await this.httpFetchSubtree(uid, {
      knownVersion,
      priority: 'low'
    })
    const needsLocalChildren = count > 0 && live < count
    if (result && result.unchanged && needsLocalChildren) {
      result = await this.httpFetchSubtree(uid, {
        knownVersion: 0,
        priority: 'low'
      })
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
    this.markUidPushed(uid, data.data, 'server')
    const serverKids = (result && result.children) || []
    serverKids.forEach(child => {
      const childUid = child && child.data && child.data.uid
      this.markUidPushed(childUid, child && child.data, 'server')
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

  expandTreeNode(node) {
    if (!node || !node.data || node.data.expand === true) return false
    node.data.expand = true
    return true
  }

  async ensureHttpNodePath(uid, locatedCache) {
    if (!uid || uid === 'root') return false
    if (this.isTombstonedUid(uid)) return false
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    if (!tree) return false
    if (this.findTreeNode(tree, uid)) return true
    if (!this.httpFetchLocate) return false
    let located = locatedCache
    if (!located) {
      try {
        located = await this.httpFetchLocate(uid)
      } catch (err) {
        console.error('[mind-map] locate node failed', uid, err)
        return false
      }
    }
    if (!located || !Array.isArray(located.ancestors) || !located.ancestors.length) {
      return false
    }
    let changed = false
    for (let i = 0; i < located.ancestors.length; i++) {
      const id = located.ancestors[i]
      let treeNode = this.findTreeNode(tree, id)
      if (!treeNode && i > 0) {
        const parentId = located.ancestors[i - 1]
        const parent = this.findTreeNode(tree, parentId)
        const stub = located.nodes && located.nodes[id]
        if (parent && stub && !this.isTombstonedUid(id)) {
          this.mergeHttpChildren(parent, [stub])
          if (this.expandTreeNode(parent)) changed = true
          treeNode = this.findTreeNode(tree, id)
        }
      }
      if (treeNode) {
        try {
          await this.hydrateNodeData(treeNode)
        } catch (err) {
          console.error('[mind-map] hydrate path failed', id, err)
        }
        if (this.expandTreeNode(treeNode)) changed = true
        this.hydratedUids.add(id)
        this.dirtySubtrees.delete(id)
      }
    }
    return changed || !!this.findTreeNode(tree, uid)
  }

  async syncHttpDirtySubtrees() {
    if (!this.httpCollabMode || !this.httpFetchSubtree) return false
    const tree = this.mindMap.renderer && this.mindMap.renderer.renderTree
    if (!tree) return false
    const roots = Array.from(this.dirtySubtrees.keys())
    if (!roots.length) return false
    let changed = false
    for (const uid of roots) {
      if (this.isTombstonedUid(uid)) {
        this.dirtySubtrees.delete(uid)
        continue
      }
      let treeNode = this.findTreeNode(tree, uid)
      if (!treeNode) {
        await this.ensureHttpNodePath(uid)
        treeNode = this.findTreeNode(tree, uid)
      }
      if (!treeNode) continue
      const before = (treeNode.children || []).length
      try {
        await this.hydrateNodeData(treeNode)
      } catch (err) {
        console.error('[mind-map] dirty subtree sync failed', uid, err)
        continue
      }
      this.hydratedUids.add(uid)
      this.dirtySubtrees.delete(uid)
      if ((treeNode.children || []).length !== before) changed = true
      if (this.expandTreeNode(treeNode)) changed = true
    }
    return changed
  }

  async syncHttpRemoteOperations(operations) {
    if (!this.httpCollabMode || !operations || !operations.length) return false
    const uids = new Set()
    operations.forEach(op => {
      affectedUidsFromOperation(op).forEach(uid => uids.add(uid))
    })
    if (!uids.size) return false
    this.httpHydrating = true
    let changed = false
    try {
      for (const uid of uids) {
        if (this.isTombstonedUid(uid)) continue
        if (await this.ensureHttpNodePath(uid)) changed = true
      }
      if (await this.syncHttpDirtySubtrees()) changed = true
    } finally {
      this.httpHydrating = false
      this.flushPendingHttpRefresh()
    }
    if (changed && this.mindMap) this.mindMap.render()
    return changed
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
      Number(options.maxFetches) > 0 ? Number(options.maxFetches) : 40
    const concurrency = Math.min(
      4,
      Math.max(1, Number(options.concurrency) || 2)
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
      this.flushPendingHttpRefresh()
    }
    return root
  }

  onBeforeExecCommand(name) {
    if (!this.httpCollabMode) return
    const args = Array.prototype.slice.call(arguments, 1)
    if (MOVE_COMMANDS[name] && name !== 'INSERT_PARENT_NODE') {
      this.pendingMoveCommand = {
        name,
        args,
        origins: collabMove.snapshotMoveOrigins(args)
      }
    }
    if (
      INSERT_COMMANDS[name] ||
      name === 'SET_NODE_TEXT' ||
      name === 'SET_NODE_DATA'
    ) {
      const traceId = createTraceId()
      this._commandTraceId = traceId
      const active =
        (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
      collabTrace('1.local.command', {
        traceId,
        command: name,
        roomKey: this.httpRoomKey,
        uids: active
          .map(node => node && node.getData && node.getData('uid'))
          .filter(Boolean),
        clientId:
          this.collabV2Adapter &&
          this.collabV2Adapter.getClientId &&
          this.collabV2Adapter.getClientId()
      })
    }
    if (INSERT_COMMANDS[name] && this.collabV2Adapter) {
      this.snapshotV2InsertCollect()
    }
    if (name === 'BACK' || name === 'FORWARD') {
      this.httpHistorySyncing = true
      return
    }
    if (name === 'ADD_GENERALIZATION' || name === 'REMOVE_GENERALIZATION') {
      const genList =
        (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
      const owners = []
      const seen = new Set()
      genList.forEach(node => {
        if (!node) return
        const owner =
          node.isGeneralization && node.generalizationBelongNode
            ? node.generalizationBelongNode
            : node
        const uid = owner.getData && owner.getData('uid')
        if (!uid || seen.has(uid)) return
        seen.add(uid)
        owners.push(owner)
      })
      this.pendingHttpGeneralizationOwners = owners
      return
    }
    if (
      name !== 'REMOVE_NODE' &&
      name !== 'REMOVE_CURRENT_NODE' &&
      name !== 'CUT_NODE'
    ) {
      return
    }
    const list =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    const deletes = []
    const owners = []
    const seenOwner = new Set()
    list.forEach(node => {
      if (!node) return
      if (node.isGeneralization && node.generalizationBelongNode) {
        const owner = node.generalizationBelongNode
        const ownerUid = owner.getData && owner.getData('uid')
        if (ownerUid && !seenOwner.has(ownerUid)) {
          seenOwner.add(ownerUid)
          owners.push(owner)
        }
        return
      }
      const uid = node.getData && node.getData('uid')
      if (uid) {
        const keepChildren = name === 'REMOVE_CURRENT_NODE'
        const walkData = item => {
          if (!item) return
          const id = item.data && item.data.uid
          if (id) deletes.push(id)
          if (keepChildren) return
          ;(item.children || []).forEach(walkData)
        }
        const walk = current => {
          if (!current) return
          const id = current.getData && current.getData('uid')
          if (id) deletes.push(id)
          if (keepChildren) return
          const dataKids = (current.nodeData && current.nodeData.children) || []
          dataKids.forEach(walkData)
          ;(current.children || []).forEach(walk)
        }
        walk(node)
      }
    })
    this.pendingHttpDeletes = [...new Set(deletes)]
    this.pendingHttpGeneralizationOwners = owners
  }

  collectGeneralizationOwners(name, args = []) {
    const owners = []
    const seen = new Set()
    const addOwner = owner => {
      if (!owner || owner.isGeneralization) return
      const uid = owner.getData && owner.getData('uid')
      if (!uid || seen.has(uid)) return
      seen.add(uid)
      owners.push(owner)
    }
    const consider = node => {
      if (!node) return
      if (node.isGeneralization && node.generalizationBelongNode) {
        addOwner(node.generalizationBelongNode)
      }
    }
    consider(args[0])
    if (
      name === 'SET_NODE_DATA' &&
      args[0] &&
      !args[0].isGeneralization &&
      args[1] &&
      Object.prototype.hasOwnProperty.call(args[1], 'generalization')
    ) {
      addOwner(args[0])
    }
    const active =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    active.forEach(consider)
    return owners
  }

  syncHttpGeneralization(owner) {
    if (!this.httpCollabMode || !this.httpPatchNode || !owner) return
    const uid = owner.getData && owner.getData('uid')
    if (!uid) return
    let generalization = owner.getData && owner.getData('generalization')
    const active =
      (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    active.forEach(node => {
      if (
        !node ||
        !node.isGeneralization ||
        node.generalizationBelongNode !== owner
      ) {
        return
      }
      const genUid = (node.getData && node.getData('uid')) || node.uid
      const liveData = (node.getData && node.getData()) || {}
      const merged = collabGeneralization.mergeVirtualEditIntoOwner(
        generalization,
        genUid,
        liveData
      )
      if (merged) generalization = merged
    })
    if (Array.isArray(generalization) && generalization.length === 0) {
      generalization = null
    }
    if (generalization == null) generalization = null
    const cloned = collabGeneralization.ownerGeneralizationPayload(
      generalization
    )
    const prev = this.lastPushed[uid] || {
      text: this.nodePlain(owner),
      note: (owner.getData && owner.getData('note')) || ''
    }
    const prevFull = prev.full || { text: prev.text, note: prev.note }
    if (
      Object.prototype.hasOwnProperty.call(prevFull, 'generalization') &&
      generalizationSignature(prevFull.generalization) ===
        generalizationSignature(cloned)
    ) {
      return
    }
    if (!this.pendingGenIntent) this.pendingGenIntent = new Map()
    const prevSnapshot = {
      text: prev.text,
      note: prev.note,
      full: collabGeneralization.snapshotValue(prevFull),
      fieldVersions: prev.fieldVersions
    }
    this.setGenIntent(uid, cloned)
    this.stampLocalFieldVersion(owner, 'generalization')
    const full = {
      ...collabGeneralization.snapshotValue(prevFull),
      generalization: cloned
    }
    this.lastPushed[uid] = {
      text: full.text,
      note: full.note,
      full
    }
    this.httpPatchNode(uid, { generalization: cloned })
      .then(() => {
        const latest = this.nodePatchPayload(owner) || full
        latest.generalization = cloned
        this.lastPushed[uid] = {
          text: latest.text,
          note: latest.note,
          full: collabGeneralization.snapshotValue(latest)
        }
        if (this.pendingGenIntent) this.pendingGenIntent.delete(uid)
      })
      .catch(err => {
        this.lastPushed[uid] = prevSnapshot
        console.error('[mind-map] generalization sync failed', err)
      })
  }

  onHttpCommand(name, args = []) {
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
      const owners = (this.pendingHttpGeneralizationOwners || []).splice(0)
      const uids = this.pendingHttpDeletes.splice(0)
      const tombstone = uid => {
        this.tombstoneDeletedUid(uid)
      }
      this.purgeQueuedInserts(uids)
      if (this.collabV2Adapter && uids.length > 1) {
        uids.forEach(tombstone)
        const drop = this.collabV2Adapter.dropPendingInsertsForUid
        Promise.resolve(
          drop
            ? Promise.all(uids.map(uid => drop.call(this.collabV2Adapter, uid)))
            : null
        )
          .then(() =>
            this.submitV2('node.batch', {
              ops: uids.map(uid => ({
                type: 'node.delete',
                payload: { uid, keepChildren }
              }))
            })
          )
          .catch(() => {})
      } else {
        uids.forEach(uid => {
          if (!this.httpDeleteNode) return
          tombstone(uid)
          const drop =
            this.collabV2Adapter && this.collabV2Adapter.dropPendingInsertsForUid
          Promise.resolve(drop ? drop.call(this.collabV2Adapter, uid) : null)
            .then(() => this.httpDeleteNode(uid, { keepChildren }))
            .catch(() => {})
        })
      }
      owners.forEach(owner => this.syncHttpGeneralization(owner))
      return
    }
    if (INSERT_COMMANDS[name]) {
      this._v2InsertFromCommand = true
      const inserted = this.flushHttpInsert()
      if (name === 'INSERT_PARENT_NODE') {
        Promise.resolve(inserted)
          .then(() => this.flushHttpMove(name, args))
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
      this.flushHttpMove(name, args)
      return
    }
    if (this.httpReplaceAllActive) return
    if (
      FIELD_COMMANDS[name] ||
      name === 'ADD_GENERALIZATION' ||
      name === 'REMOVE_GENERALIZATION'
    ) {
      if (name === 'ADD_GENERALIZATION' || name === 'REMOVE_GENERALIZATION') {
        const owners = (this.pendingHttpGeneralizationOwners || []).splice(0)
        if (owners.length) {
          owners.forEach(owner => this.syncHttpGeneralization(owner))
        } else {
          this.collectGeneralizationOwners(name, args).forEach(owner =>
            this.syncHttpGeneralization(owner)
          )
        }
        return
      }
      const genOwners = this.collectGeneralizationOwners(name, args)
      if (genOwners.length) {
        genOwners.forEach(owner => this.syncHttpGeneralization(owner))
        return
      }
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

  scheduleRemoteRecover(version) {
    const target = Number(version) || 0
    if (!target || !this.httpCollabMode) return
    if (target <= (Number(this.lastAppliedVersion) || 0)) return
    this.httpPendingRemoteVersion = Math.max(
      this.httpPendingRemoteVersion || 0,
      target
    )
    clearTimeout(this.httpRemoteRecoverTimer)
    this.httpRemoteRecoverTimer = setTimeout(() => {
      this.httpRemoteRecoverTimer = null
      const pending = this.httpPendingRemoteVersion
      this.httpPendingRemoteVersion = 0
      if (!pending || pending <= (Number(this.lastAppliedVersion) || 0)) return
      this.recoverHttpCollab(pending).catch(() => {})
    }, 150)
  }

  scheduleHttpStructureSync(delay = 180) {
    if (this.collabV2Adapter) {
      this.warnLocalNodesWithoutOperation()
      return
    }
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
    NULLABLE_PATCH_KEYS.forEach(key => {
      const value = data && data[key]
      if (value !== undefined && value !== null && value !== '') {
        payload[key] = value
      } else if (data && Object.prototype.hasOwnProperty.call(data, key)) {
        payload[key] = null
      }
    })
    return payload
  }

  sanitizeHistoryTree(root) {
    if (!root) return root
    const walk = node => {
      if (!node) return
      const genUids = generalizationUidsOf(node.data || {})
      if (genUids.size && Array.isArray(node.children)) {
        node.children = node.children.filter(child => {
          const id = child && child.data && child.data.uid
          return !id || !genUids.has(id)
        })
      }
      ;(node.children || []).forEach(walk)
    }
    walk(root)
    return root
  }

  syncHttpUndoRedo(name) {
    if (!this.httpCollabMode) return
    this.stampGenIntentFromLocal()
    if (this.collabV2Adapter && typeof this.collabV2Adapter.undo === 'function') {
      const isUndo = name === 'BACK'
      const status =
        this.collabV2Adapter.getStatus && this.collabV2Adapter.getStatus()
      undoTrace('cooperate.v2-authority', {
        name,
        call: isUndo ? 'undoLastLocalOperation' : 'redoLastLocalOperation',
        undoDepth: status && status.undoDepth,
        redoDepth: status && status.redoDepth,
        nativeHistory: 'skipped'
      })
      this._v2UndoActive = true
      this._v2UndoAllowReplace = false
      const run = isUndo
        ? this.collabV2Adapter.undoLastLocalOperation()
        : this.collabV2Adapter.redoLastLocalOperation()
      Promise.resolve(run)
        .then(result => {
          if (result && result.serverRevision != null) {
            this.acknowledgeLocalVersion(result.serverRevision, {
              duplicate: true
            })
          }
          const op = result && result.operation
          const evType = op && ((op.event && op.event.type) || op.type)
          if (evType === 'map.replaced' || evType === 'map.replace') {
            this._v2UndoAllowReplace = true
          }
          if (op && (op.event || op.type)) {
            return this.applyV2RemoteOperation(op, { applySelf: true })
          }
        })
        .catch(err => {
          if (err && (err.code === 'UNDO_EMPTY' || err.code === 'REDO_EMPTY' || err.code === 'UNDO_PENDING')) {
            undoTrace('cooperate.undo.skip', { code: err.code, name })
            return
          }
          console.error('[mind-map] v2 undo/redo failed', err)
          if (
            this.mindMap &&
            err &&
            (err.code === 'UNDO_CONFLICT' || err.code === 'REDO_CONFLICT')
          ) {
            this.mindMap.emit('undo_conflict', err)
          }
        })
        .finally(() => {
          this._v2UndoActive = false
          this._v2UndoAllowReplace = false
        })
      return
    }
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
          this.stampGenIntentFromLocal()
          if (isRateLimitedError(err)) {
            const wait = Math.min(
              8000,
              Number(err.retryAfterMs) || 1000
            )
            setTimeout(() => {
              Promise.resolve(this.httpUndoOperation(last.operationId))
                .then(result => {
                  if (result && result.version != null) {
                    this.acknowledgeLocalVersion(result.version, {
                      duplicate: true
                    })
                  }
                  this.localUndoStack = this.localUndoStack.filter(
                    item => item.operationId !== last.operationId
                  )
                  this.localRedoStack.push({ operationId: last.operationId })
                })
                .catch(() => {
                  this.flushHttpTextNow().catch(() => {})
                })
            }, wait)
            return
          }
          this.flushHttpTextNow().catch(() => {})
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
          this.stampGenIntentFromLocal()
          this.flushHttpTextNow().catch(() => {})
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

  hasUnsyncedLocalText(node) {
    if (!node) return false
    return !!this.nodePatchPayload(node, { onlyChanged: true })
  }

  collectNodesWithPendingText() {
    const renderer = this.mindMap.renderer
    if (!renderer) return []
    const byUid = new Map()
    const skipUid = uid =>
      uid && this.abandonedInsertUids && this.abandonedInsertUids.has(uid)
    ;(renderer.activeNodeList || []).forEach(node => {
      const target = this.resolveHttpPatchNode(node)
      const uid = target.getData && target.getData('uid')
      if (uid && !skipUid(uid)) byUid.set(uid, target)
    })
    this.collectVisibleUids().forEach(uid => {
      if (byUid.has(uid) || skipUid(uid)) return
      const node = renderer.findNodeByUid(uid)
      if (node && this.hasUnsyncedLocalText(node)) byUid.set(uid, node)
    })
    return Array.from(byUid.values())
  }

  collectActivePendingText() {
    const renderer = this.mindMap.renderer
    if (!renderer) return []
    const byUid = new Map()
    ;(renderer.activeNodeList || []).forEach(node => {
      const target = this.resolveHttpPatchNode(node)
      const uid = target.getData && target.getData('uid')
      if (!uid || !this.lastPushed[uid]) return
      if (this.hasUnsyncedLocalText(target)) byUid.set(uid, target)
    })
    return Array.from(byUid.values())
  }

  nodePatchPayload(node, options = {}) {
    const target = this.resolveHttpPatchNode(node)
    const uid = target.getData && target.getData('uid')
    const prevFull =
      uid && this.lastPushed[uid] && this.lastPushed[uid].full
        ? this.lastPushed[uid].full
        : null
    const data = (target.getData && target.getData()) || {}
    const full = {
      text: this.nodePlain(target),
      note: (target.getData && target.getData('note')) || '',
      ...collectStyleFields(data, prevFull)
    }
    NULLABLE_PATCH_KEYS.forEach(key => {
      const value = target.getData && target.getData(key)
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (key === 'mapRef' && !mapRefUtil.normalizeMapRef(value))
      if (!empty) {
        full[key] = collabGeneralization.snapshotValue(value)
      } else if (
        prevFull &&
        prevFull[key] !== undefined &&
        prevFull[key] !== null &&
        prevFull[key] !== ''
      ) {
        full[key] = null
      }
    })
    if (!options.onlyChanged || !uid) return full
    const prev = this.lastPushed[uid]
    if (!prev || !prev.full) return full
    const delta = patchDelta(prev.full, full)
    return Object.keys(delta).length ? delta : null
  }

  flushHttpText() {
    this.flushHttpTextNow().catch(err => {
      console.error('[mind-map] text sync failed', err)
    })
  }

  async flushHttpTextNow() {
    if (this.httpReplacing || !this.httpPatchNode) return
    if (this.httpTextFlushing) {
      this.httpTextFlushQueued = true
      return
    }
    this.httpTextFlushing = true
    try {
      do {
        this.httpTextFlushQueued = false
        await this.flushHttpTextOnce()
      } while (this.httpTextFlushQueued)
    } finally {
      this.httpTextFlushing = false
    }
  }

  async flushHttpTextOnce() {
    const settling =
      this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil
    const pending = settling
      ? this.collectActivePendingText()
      : this.collectNodesWithPendingText()
    if (settling && !pending.length) return
    const jobs = []
    const items = []
    let droppedGhosts = false
    let skipGhostRefresh = false
    pending.forEach(node => {
      const target = this.resolveHttpPatchNode(node)
      const uid = target.getData && target.getData('uid')
      if (!uid) return
      // New local nodes are inserted (with text) by flushHttpInsert; patching
      // them first returns NODE_DELETED and would drop the orphan incorrectly.
      if (!this.isPersistAcked(uid)) return
      const full = this.nodePatchPayload(node)
      const delta = this.nodePatchPayload(node, { onlyChanged: true })
      if (!delta) return
      const snap = JSON.stringify(full)
      items.push({ uid, node, target, full, delta, snap })
    })
    if (this.collabV2Adapter && items.length > 1) {
      try {
        await this.submitV2('node.batch', {
          ops: items.map(item => ({
            type: 'node.update',
            payload: { uid: item.uid, ...item.delta }
          }))
        })
        items.forEach(item => {
          this.lastPushed[item.uid] = {
            text: item.full.text,
            note: item.full.note,
            full: collabGeneralization.snapshotValue(item.full),
            snap: item.snap
          }
        })
      } catch (err) {
        console.error('[mind-map] batch style/text sync failed', err)
      }
      return
    }
    items.forEach(item => {
      const { uid, node, full, delta, snap } = item
      jobs.push(() =>
        this.httpPatchNode(uid, delta)
          .then(() => {
            this.lastPushed[uid] = {
              text: full.text,
              note: full.note,
              full: collabGeneralization.snapshotValue(full),
              snap
            }
          })
          .catch(err => {
            if (isPermanentNodeError(err)) {
              droppedGhosts = true
              this.abandonGhostNodeByUid(uid, node)
              if (
                this.isTombstonedUid(uid) ||
                /UID_REUSED|DROPPED_DELETED|TARGET_DELETED|NODE_DELETED|PARENT_DELETED/.test(
                  String((err && err.code) || '') + ' ' + String((err && err.message) || '')
                )
              ) {
                skipGhostRefresh = true
              }
              console.warn('[mind-map] dropped ghost node patch', uid, err.message || err)
            } else {
              console.error('[mind-map] patch node failed', err)
            }
          })
      )
    })
    if (jobs.length) await runPromisePool(jobs, PATCH_CONCURRENCY)
    if (droppedGhosts && !skipGhostRefresh) {
      this.refreshVisibleFromHttp('', { force: true }).catch(() => {})
    }
  }

  snapshotV2InsertCollect() {
    const renderer = this.mindMap && this.mindMap.renderer
    const active = (renderer && renderer.activeNodeList) || []
    const collectNodes = []
    const seen = new Set()
    const add = node => {
      if (!node || seen.has(node)) return
      seen.add(node)
      collectNodes.push(node)
    }
    active.forEach(node => {
      add(node)
      if (node && node.parent) add(node.parent)
    })
    this._insertCollectNodes = collectNodes
    this._insertKnownUids = collabInsertCollect.snapshotNodeDataUids(
      collectNodes.map(node => node && node.nodeData).filter(Boolean)
    )
  }

  collectV2CommandInsertRecords(opts = {}) {
    const knownUids = opts.knownUids || this._insertKnownUids || new Set()
    let nodes = opts.collectNodes || this._insertCollectNodes || []
    if (!nodes.length) {
      const renderer = this.mindMap && this.mindMap.renderer
      const list = (renderer && renderer.activeNodeList) || []
      nodes = list.slice()
      list.forEach(node => {
        if (node && node.parent) nodes.push(node.parent)
      })
      if (!nodes.length && this.lastActiveUids && renderer && renderer.findNodeByUid) {
        this.lastActiveUids.forEach(uid => {
          const live = renderer.findNodeByUid(uid)
          if (live) {
            nodes.push(live)
            if (live.parent) nodes.push(live.parent)
          }
        })
      }
    }
    const roots = []
    const seenRoot = new Set()
    nodes.forEach(node => {
      const data = node && node.nodeData
      if (!data || seenRoot.has(data)) return
      seenRoot.add(data)
      roots.push(data)
    })
    const rows = collabInsertCollect.collectNewNodeDataInserts(roots, {
      knownUids,
      isAcked: uid => this.isPersistAcked(uid),
      isPending: uid => !!(this.pendingUids && this.pendingUids.has(uid)),
      isTombstoned: uid => this.isTombstonedUid(uid),
      isAbandoned: uid =>
        !!(this.abandonedInsertUids && this.abandonedInsertUids.has(uid)),
      textOf: data =>
        data && data.richText
          ? getTextFromHtml(data.text)
          : String((data && data.text) || '')
    })
    const filtered = rows.filter(row => {
      if (!row || !row.uid || !row.parent) return false
      return !this.isGeneralizationUid(row.parent, row.uid)
    })
    if (knownUids && knownUids.size) return filtered
    return filtered.filter(row => row.data && row.data.inserting)
  }

  recordsFromMindMapNodes(nodes) {
    return (nodes || [])
      .map(node => {
        if (!node || node.isGeneralization || node.isRoot) return null
        const uid = node.getData && node.getData('uid')
        const parent =
          node.parent && node.parent.getData && node.parent.getData('uid')
        if (!uid || !parent) return null
        if (this.isGeneralizationUid(parent, uid)) return null
        const kids =
          (node.parent &&
            node.parent.nodeData &&
            node.parent.nodeData.children) ||
          []
        const index = kids.findIndex(
          item => item && item.data && item.data.uid === uid
        )
        const data = (node.getData && node.getData()) || {}
        return {
          uid,
          parent,
          text: this.nodePlain(node),
          note: data.note || '',
          index: index < 0 ? undefined : index,
          depth: this.nodeDepth(node),
          data
        }
      })
      .filter(Boolean)
  }

  collectUnpushedNodes(node, out = []) {
    if (!node) return out
    if (node.isGeneralization) return out
    if (node.isRoot) {
      ;(node.children || []).forEach(child => this.collectUnpushedNodes(child, out))
      return out
    }
    const uid = node.getData && node.getData('uid')
    if (
      uid &&
      (this.isTombstonedUid(uid) ||
        (this.abandonedInsertUids && this.abandonedInsertUids.has(uid)))
    ) {
      const kids = node.children || []
      kids.forEach(child => this.collectUnpushedNodes(child, out))
      return out
    }
    const parentUid =
      node.parent && node.parent.getData && node.parent.getData('uid')
    if (parentUid && this.isTombstonedUid(parentUid)) {
      return out
    }
    if (uid && !this.isPersistAcked(uid) && !(this.pendingUids && this.pendingUids.has(uid))) {
      out.push(node)
    }
    const kids = node.children || []
    kids.forEach(child => this.collectUnpushedNodes(child, out))
    return out
  }

  warnLocalNodesWithoutOperation() {
    if (!this.collabV2Adapter) return
    const now = Date.now()
    if (this._localNodeWarnAt && now - this._localNodeWarnAt < 4000) return
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || !renderer.root) return
    const pending = []
    this.collectUnpushedNodes(renderer.root, pending)
    const uids = pending
      .map(node => node && node.getData && node.getData('uid'))
      .filter(Boolean)
    if (!uids.length) return
    this._localNodeWarnAt = now
    const row = { count: uids.length, uids: uids.slice(0, 20) }
    v2Trace('LOCAL_NODE_WITHOUT_OPERATION', row)
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('LOCAL_NODE_WITHOUT_OPERATION', row)
    }
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

  scheduleV2InsertRetry(opts, delay = 48) {
    if (!this.collabV2Adapter || !opts || !opts.fromCommand) return
    clearTimeout(this._v2InsertRetryTimer)
    this._v2InsertRetryTimer = setTimeout(() => {
      this._v2InsertRetryTimer = null
      this._v2InsertFromCommand = true
      this._insertKnownUids = opts.knownUids
      this._insertCollectNodes = opts.collectNodes
      this.flushHttpInsert().catch(() => {})
    }, delay)
  }

  async flushHttpInsert() {
    if (
      this.httpReplacing ||
      !this.httpAddNode ||
      this.previewApplied ||
      this.isSetData
    ) {
      this._v2InsertFromCommand = false
      return
    }
    if (this.collabV2Adapter && !this._v2InsertFromCommand) {
      this.warnLocalNodesWithoutOperation()
      return
    }
    const fromCommand = this._v2InsertFromCommand
    this._v2InsertFromCommand = false
    const knownUids = this._insertKnownUids
    const collectNodes = this._insertCollectNodes
    const flushOpts = { fromCommand, knownUids, collectNodes }
    if (this.collabV2Adapter && fromCommand) {
      flushOpts.preRecords = this.collectV2CommandInsertRecords(flushOpts)
    }
    const settling =
      this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil
    if (!fromCommand && settling) {
      const renderer = this.mindMap.renderer
      const active = (renderer && renderer.activeNodeList) || []
      const hasUnpushed = active.some(node => {
        const uid = node && node.getData && node.getData('uid')
        return (
          uid &&
          !this.isPersistAcked(uid) &&
          !(this.pendingUids && this.pendingUids.has(uid)) &&
          !node.isRoot &&
          !node.isGeneralization
        )
      })
      if (!hasUnpushed) return
    }
    if (this.httpInsertPromise) {
      this._insertFlushQueue = this._insertFlushQueue || []
      this._insertFlushQueue.push(flushOpts)
      return this.httpInsertPromise
    }
    this.httpInsertPromise = (async () => {
      let current = flushOpts
      while (current) {
        await this.flushHttpInsertNow(current)
        current = (this._insertFlushQueue || []).shift() || null
      }
    })()
    try {
      await this.httpInsertPromise
    } finally {
      this.httpInsertPromise = null
    }
  }

  async flushHttpInsertNow(opts = {}) {
    const fromCommand = !!opts.fromCommand
    let records =
      this.collabV2Adapter && fromCommand && Array.isArray(opts.preRecords)
        ? opts.preRecords.slice()
        : []
    await this.flushHttpTextNow()
    if (!records.length && this.collabV2Adapter && fromCommand) {
      records = this.collectV2CommandInsertRecords(opts)
    }
    if (!records.length && !(this.collabV2Adapter && fromCommand)) {
      const renderer = this.mindMap && this.mindMap.renderer
      const pending = []
      const list = (renderer && renderer.activeNodeList) || []
      list.forEach(node => this.collectUnpushedNodes(node, pending))
      const settling =
        this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil
      if (!this.collabV2Adapter && !settling && renderer && renderer.root) {
        this.collectUnpushedNodes(renderer.root, pending)
      }
      const seen = new Set()
      const unique = pending.filter(node => {
        if (node.isGeneralization) return false
        const uid = node.getData && node.getData('uid')
        if (!uid || seen.has(uid)) return false
        if (this.isTombstonedUid(uid)) return false
        const parentUid =
          node.parent && node.parent.getData && node.parent.getData('uid')
        if (parentUid && this.isGeneralizationUid(parentUid, uid)) return false
        seen.add(uid)
        return true
      })
      records = this.recordsFromMindMapNodes(unique)
    }
    records = records.filter(row => {
      if (!row || !row.uid || !row.parent) return false
      if (this.isPersistAcked(row.uid) || this.isTombstonedUid(row.uid)) return false
      if (this.abandonedInsertUids && this.abandonedInsertUids.has(row.uid)) {
        return false
      }
      return true
    })
    v2Trace('local.insert.flush', {
      count: records.length,
      uids: records.map(row => row.uid)
    })
    records.sort((a, b) => (a.depth || 0) - (b.depth || 0))
    records.forEach(row => {
      if (row.uid && this.pendingUids) this.pendingUids.add(row.uid)
    })
    if (!records.length) {
      this._insertEmptyRetries = (this._insertEmptyRetries || 0) + 1
      if (this.collabV2Adapter && fromCommand && this._insertEmptyRetries < 5) {
        this.scheduleV2InsertRetry(opts, 32 * this._insertEmptyRetries)
      } else if (!this.collabV2Adapter && this._insertEmptyRetries < 6) {
        this.scheduleHttpStructureSync(1600)
      }
      return
    }
    this._insertEmptyRetries = 0
    let droppedOrphans = false
    let skipOrphanRefresh = false
    if (this.collabV2Adapter && records.length > 1) {
      const ops = records.map(row => ({
        type: 'node.insert',
        payload: {
          parent: row.parent,
          uid: row.uid,
          text: row.text,
          note: row.note || '',
          index: row.index
        }
      }))
      try {
        await this.submitV2('node.batch', { ops })
        records.forEach(row => {
          this.markUidPushed(row.uid, row.data || { text: row.text, note: row.note }, 'ack')
          this.recentPushed.set(row.uid, Date.now())
        })
        return
      } catch (err) {
        if (!isPermanentNodeError(err)) {
          console.error('[mind-map] batch insert failed', err)
          if (this.collabV2Adapter && fromCommand) {
            records.forEach(row => {
              if (this.pendingUids) this.pendingUids.delete(row.uid)
            })
            this.scheduleV2InsertRetry(opts, 600)
          } else {
            this.scheduleHttpStructureSync(600)
          }
          return
        }
      }
    }
    for (const row of records) {
      const uid = row.uid
      const parent = row.parent
      const text = row.text
      const note = row.note || ''
      try {
        if (!parent) {
          throw new Error('missing parent for insert')
        }
        await this.httpAddNode({
          parent,
          uid,
          text,
          note,
          index: row.index
        })
        this.markUidPushed(uid, row.data || { text, note }, 'ack')
        this.recentPushed.set(uid, Date.now())
      } catch (err) {
        const msg = String((err && err.message) || err)
        if (/节点已存在/.test(msg)) {
          this.markUidPushed(uid, row.data || { text, note }, 'ack')
          this.recentPushed.set(uid, Date.now())
        } else if (isPermanentNodeError(err)) {
          this.abandonGhostNodeByUid(uid)
          droppedOrphans = true
          if (
            /UID_REUSED|DROPPED_DELETED|TARGET_DELETED|NODE_DELETED|PARENT_DELETED/.test(
              String((err && err.code) || '') + ' ' + msg
            )
          ) {
            skipOrphanRefresh = true
          }
          console.warn('[mind-map] dropped orphan insert', uid, msg)
        } else {
          console.error('[mind-map] add node failed', err)
          if (this.pendingUids) this.pendingUids.delete(uid)
          if (this.collabV2Adapter && fromCommand) {
            this.scheduleV2InsertRetry(opts, 600)
          } else {
            this.scheduleHttpStructureSync(600)
          }
        }
      }
    }
    if (droppedOrphans && !skipOrphanRefresh) {
      this.refreshVisibleFromHttp('', { force: true }).catch(() => {})
    }
  }

  abandonGhostNodeByUid(uid, node) {
    if (!uid) return
    const renderer = this.mindMap.renderer
    const target =
      node ||
      (renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null)
    if (target && !target.isRoot) {
      this.abandonOrphanInsert(target)
      return
    }
    if (!this.abandonedInsertUids) this.abandonedInsertUids = new Set()
    this.tombstoneDeletedUid(uid)
    delete this.lastPushed[uid]
  }

  abandonOrphanInsert(node) {
    if (!node) return
    if (!this.abandonedInsertUids) this.abandonedInsertUids = new Set()
    const walk = current => {
      if (!current) return
      const id = current.getData && current.getData('uid')
      if (id) this.tombstoneDeletedUid(id)
      ;(current.children || []).forEach(walk)
    }
    walk(node)
    const uid = node.getData && node.getData('uid')
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    const parentUid =
      node.parent && node.parent.getData && node.parent.getData('uid')
    if (tree && uid && parentUid) {
      const parentTree = this.findTreeNode(tree, parentUid)
      if (parentTree && Array.isArray(parentTree.children)) {
        parentTree.children = parentTree.children.filter(
          child => child && child.data && child.data.uid !== uid
        )
      }
      const parentNode = node.parent
      if (parentNode) {
        if (parentNode.nodeData && parentNode.nodeData.children) {
          parentNode.nodeData.children = parentNode.nodeData.children.filter(
            child => child && child.data && child.data.uid !== uid
          )
        }
        if (Array.isArray(parentNode.children)) {
          parentNode.children = parentNode.children.filter(child => child !== node)
        }
      }
      if (renderer && typeof renderer.reRender === 'function') {
        renderer.reRender()
      }
    }
  }

  collectMovesFromCommand(name, args = []) {
    const fromArgs = collabMove.collectMovesAfterCommand(name, args)
    if (fromArgs.length) {
      v2Trace('local.move.collect', {
        name,
        count: fromArgs.length,
        uids: fromArgs.map(item => item.uid),
        parent: fromArgs[0] && fromArgs[0].parent,
        index: fromArgs[0] && fromArgs[0].index,
        source: 'command-args'
      })
      return fromArgs
    }
    const pending =
      this.pendingMoveCommand && this.pendingMoveCommand.name === name
        ? this.pendingMoveCommand.origins || []
        : []
    if (pending.length && name !== 'UP_NODE' && name !== 'DOWN_NODE' && name !== 'MOVE_UP_ONE_LEVEL') {
      v2Trace('local.move.collect', {
        name,
        count: pending.length,
        uids: pending.map(item => item.uid),
        source: 'before-command'
      })
      return pending.map(item => {
        const live = collabMove.snapshotMoveOrigins([item.node])[0]
        return live || item
      })
    }
    if (name === 'UP_NODE' || name === 'DOWN_NODE' || name === 'MOVE_UP_ONE_LEVEL') {
      const active =
        (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
      const fromActive = collabMove.snapshotMoveOrigins([active])
      v2Trace('local.move.collect', {
        name,
        count: fromActive.length,
        uids: fromActive.map(item => item.uid),
        source: 'active-fallback'
      })
      return fromActive
    }
    v2Trace('local.move.collect', { name, count: 0, uids: [], source: 'empty' })
    return []
  }

  revertLocalMove(origin) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!origin || !renderer || typeof renderer.findNodeByUid !== 'function') return
    const node = renderer.findNodeByUid(origin.uid)
    const parent = origin.parent ? renderer.findNodeByUid(origin.parent) : null
    if (!node || !parent) return
    this.isApplyingRemote = true
    this._v2MoveActive = true
    try {
      this.applyMoveNodeData(node, parent, origin.index)
      if (typeof this.mindMap.render === 'function') this.mindMap.render()
    } finally {
      this.isApplyingRemote = false
      this._v2MoveActive = false
    }
  }

  flushHttpMove(name, args = []) {
    if (!this.httpPatchNode) return Promise.resolve()
    if (this.isApplyingRemote) {
      v2Trace('local.move.skip', { name, reason: 'applying-remote' })
      return Promise.resolve()
    }
    const origins = (this.pendingMoveCommand && this.pendingMoveCommand.origins) || []
    const originByUid = new Map(origins.map(item => [item.uid, item]))
    const moves = this.collectMovesFromCommand(name, args)
    this.pendingMoveCommand = null
    if (!moves.length) {
      v2Trace('local.move.skip', { name, reason: 'no-nodes' })
      return Promise.resolve()
    }
    const submitOne = item => {
      const origin = originByUid.get(item.uid)
      const kind =
        origin && origin.parent === item.parent ? 'reorder' : 'move'
      if (collabMove.isCycleMove(item.node, item.parent)) {
        v2Trace('local.move.cycle', { uid: item.uid, parent: item.parent })
        this.revertLocalMove(origin || item)
        return Promise.resolve()
      }
      v2Trace('local.move.submit', {
        uid: item.uid,
        parent: item.parent,
        index: item.index,
        kind,
        oldParent: origin && origin.parent
      })
      const payload = {
        uid: item.uid,
        parent: item.parent,
        parentUid: item.parent,
        newParentUid: item.parent,
        index: item.index,
        oldParentUid: origin && origin.parent,
        oldIndex: origin && origin.index,
        kind
      }
      const send = this.collabV2Adapter
        ? this.submitV2('node.move', payload)
        : this.httpPatchNode(item.uid, {
            parent: item.parent,
            index: item.index
          })
      return send
        .then(result => {
          this.cleanupDragArtifacts()
          return result
        })
        .catch(err => {
          const code = String((err && err.code) || '')
          if (code === 'CYCLE_REJECTED') {
            this.revertLocalMove(origin)
            return
          }
          if (isPermanentNodeError(err)) {
            if (code === 'TARGET_DELETED' || code === 'NODE_DELETED') {
              this.revertLocalMove(origin)
            }
            this.abandonGhostNodeByUid(item.uid, item.node)
            this.refreshVisibleFromHttp('', { force: true }).catch(() => {})
            console.warn('[mind-map] dropped ghost node move', item.uid, err.message || err)
          } else {
            console.error('[mind-map] move node failed', err)
          }
        })
    }
    if (this.collabV2Adapter && moves.length > 1) {
      return this.submitV2('node.batch', {
        ops: moves.map(item => ({
          type: 'node.move',
          payload: {
            uid: item.uid,
            parent: item.parent,
            parentUid: item.parent,
            newParentUid: item.parent,
            index: item.index,
            oldParentUid: originByUid.get(item.uid) && originByUid.get(item.uid).parent,
            oldIndex: originByUid.get(item.uid) && originByUid.get(item.uid).index,
            kind:
              originByUid.get(item.uid) &&
              originByUid.get(item.uid).parent === item.parent
                ? 'reorder'
                : 'move'
          }
        }))
      }).catch(err => {
        console.error('[mind-map] batch move failed', err)
        return Promise.all(moves.map(submitOne))
      })
    }
    return Promise.all(moves.map(submitOne))
  }

  flushHttpReparentChildren(node) {
    if (!this.httpPatchNode || !node) return Promise.resolve()
    const parentUid = node.getData && node.getData('uid')
    const kids = (node.nodeData && node.nodeData.children) || []
    if (this.collabV2Adapter && kids.length > 1) {
      return this.submitV2('node.batch', {
        ops: kids.map((child, index) => ({
          type: 'node.move',
          payload: {
            uid: child && child.data && child.data.uid,
            parent: parentUid,
            index
          }
        }))
      }).catch(err => {
        console.error('[mind-map] batch reparent failed', err)
      })
    }
    return Promise.all(
      kids.map((child, index) => {
        const childUid = child && child.data && child.data.uid
        if (!childUid) return Promise.resolve()
        return this.httpPatchNode(childUid, {
          parent: parentUid,
          index
        }).catch(err => {
          if (isPermanentNodeError(err)) {
            this.abandonGhostNodeByUid(childUid)
            console.warn(
              '[mind-map] dropped ghost node reparent',
              childUid,
              err.message || err
            )
          } else {
            console.error('[mind-map] reparent failed', err)
          }
        })
      })
    )
  }

  forgetHttpUid(uid) {
    if (!uid) return
    delete this.lastPushed[uid]
    if (this.ackedUids) this.ackedUids.delete(uid)
    if (this.pendingUids) this.pendingUids.delete(uid)
    this.recentPushed.delete(uid)
    this.hydratedUids.delete(uid)
  }

  isTombstonedUid(uid) {
    if (!uid) return false
    if (this.deletedUids && this.deletedUids.has(uid)) return true
    if (this.abandonedInsertUids && this.abandonedInsertUids.has(uid)) return true
    return this.isRecentlyHttpDeleted(uid)
  }

  tombstoneDeletedUid(uid) {
    if (!uid) return
    this.forgetHttpUid(uid)
    if (!this.deletedUids) this.deletedUids = new Set()
    this.deletedUids.add(uid)
    if (!this.abandonedInsertUids) this.abandonedInsertUids = new Set()
    this.abandonedInsertUids.add(uid)
    this.recentHttpDeleted.set(uid, Date.now())
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
    return uids.slice(0, 200)
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
        await this.syncHttpRemoteOperations(action.operations)
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
      const refreshed = await this.refreshVisibleFromHttp('', { force: true })
      if (refreshed && refreshed.deferred) {
        // Keep version open so the next poll/presence event retries.
        this.httpPendingRecoverVersion = Math.max(
          this.httpPendingRecoverVersion || 0,
          Number(action.version) || Number(targetVersion) || 0
        )
        return
      }
      if (refreshed && refreshed.skipped && !refreshed.applied) {
        this.httpPendingRecoverVersion = Math.max(
          this.httpPendingRecoverVersion || 0,
          Number(action.version) || Number(targetVersion) || 0
        )
        return
      }
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
    if (!this.httpCollabMode || !this.httpFetchNodes) {
      return { applied: false, skipped: true }
    }
    const force = !!options.force
    if (this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil) {
      this.httpPendingRefreshAt = updatedAt || this.httpPendingRefreshAt || '1'
      this.httpPendingRefreshForce = force || this.httpPendingRefreshForce
      return { applied: false, deferred: true }
    }
    if (this.httpHydrating || this.isApplyingRemote || this.httpRefreshing) {
      this.httpPendingRefreshAt = updatedAt || this.httpPendingRefreshAt || '1'
      this.httpPendingRefreshForce = force || this.httpPendingRefreshForce
      return { applied: false, deferred: true }
    }
    if (!force && updatedAt && sameHttpStamp(updatedAt, this.httpUpdatedAt)) {
      return { applied: false, skipped: true }
    }
    const pendingUpdatedAt = updatedAt || this.httpUpdatedAt || ''
    // force=true must always fetch. Previously an empty httpUpdatedAt caused a
    // no-op return, then recover stamped lastAppliedVersion and blocked retries.
    if (!force && !this.httpUpdatedAt) {
      this.httpUpdatedAt = pendingUpdatedAt
      return { applied: false, skipped: true }
    }
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    if (!tree) return { applied: false, skipped: true }
    const uids = [
      ...new Set([
        ...this.collectVisibleUids(),
        ...Array.from(this.dirtySubtrees.keys())
      ])
    ].slice(0, 200)
    if (!uids.length) return { applied: false, skipped: true }
    pruneRecentMap(this.recentHttpDeleted)
    pruneRecentMap(this.recentPushed, RECENT_PUSH_GRACE_MS)
    this.httpRefreshing = true
    let applied = false
    try {
      const remoteNodes = await this.fetchHttpNodes(uids)
      if (!remoteNodes.length) return { applied: false, skipped: true }
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
            const localText = this.nodePlain(node)
            const localNote = (node.getData && node.getData('note')) || ''
            const sameTextNote =
              prev && prev.text === text && (prev.note || '') === note
            const localMatchesRemote =
              localText === text && String(localNote || '') === String(note || '')
            const localMatchesLastPushed =
              prev &&
              localText === String(prev.text || '') &&
              String(localNote || '') === String(prev.note || '')
            const hasLocalPending = this.hasUnsyncedLocalText(node)
            if (
              !localMatchesRemote &&
              (localMatchesLastPushed || hasLocalPending)
            ) {
              const remoteFv = readFieldVersions(data)
              const localFv = readFieldVersions(localData)
              const remoteFieldNewer = Object.keys(remoteFv).some(
                group =>
                  Number(remoteFv[group] || 0) > Number(localFv[group] || 0)
              )
              if (!remoteFieldNewer) {
                this.scheduleHttpTextSync()
                return
              }
            }
            if (
              force ||
              !localMatchesRemote ||
              !sameTextNote ||
              (merged.appliedKeys && merged.appliedKeys.length) ||
              this.generalizationRemoteChanged(localData, next, merged)
            ) {
              if (
                this.applyHttpRemoteNodeFields(node, next, merged)
              ) {
                const fv = readFieldVersions(merged.data)
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
                    hyperlinkTitle: next.hyperlinkTitle,
                    outerFrame: next.outerFrame,
                    mapRef: next.mapRef,
                    generalization: node.getData
                      ? node.getData('generalization')
                      : next.generalization
                  },
                  fieldVersions: fv
                }
                changed = true
              }
            }
          }
          const treeNode = this.findTreeNode(tree, item.uid)
          if (!treeNode) return
          if (
            this.syncGeneralizationChildStubs(
              treeNode,
              treeNode.data || {},
              item.data || {}
            )
          ) {
            changed = true
          }
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
            const nextCount = Math.max(
              next.length,
              serverKids.length,
              Number(item.data && item.data.childCount) || 0
            )
            if (Number(treeNode.data.childCount || 0) !== nextCount) {
              treeNode.data.childCount = nextCount
              changed = true
            } else {
              treeNode.data.childCount = nextCount
            }
          }
        })
        if (missing.length) {
          let byUid = new Map()
          const extraNodes = await this.fetchHttpNodes(missing.slice(0, 200))
          extraNodes.forEach(item => byUid.set(item.uid, item))
          // Fallback: parent subtree when batch node fetch misses newly inserted kids.
          for (const [parentUid, childIds] of missingFor) {
            const stillMissing = childIds.filter(id => !byUid.has(id))
            if (!stillMissing.length || !this.httpFetchSubtree) continue
            try {
              const subtree = await this.httpFetchSubtree(parentUid, {
                knownVersion: 0,
                priority: 'low'
              })
              ;(subtree && subtree.children ? subtree.children : []).forEach(
                child => {
                  const id = child && child.data && child.data.uid
                  if (!id) return
                  byUid.set(id, {
                    uid: id,
                    data: child.data || {},
                    children: (child.children || [])
                      .map(item => item && item.data && item.data.uid)
                      .filter(Boolean)
                  })
                }
              )
            } catch (err) {
              console.error('[mind-map] subtree fallback failed', err)
            }
          }
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
                    : Number((item.data && item.data.childCount) || 0)
                },
                children: []
              }))
            const before = (parent.children || []).length
            this.mergeHttpChildren(parent, stubs)
            if ((parent.children || []).length !== before) {
              if (this.expandTreeNode(parent)) changed = true
            }
            // Keep local child order aligned with server when possible.
            if (Array.isArray(parent.children) && childIds.length) {
              const order = new Map(childIds.map((id, index) => [id, index]))
              parent.children.sort((a, b) => {
                const ai = order.get(a && a.data && a.data.uid)
                const bi = order.get(b && b.data && b.data.uid)
                if (ai == null && bi == null) return 0
                if (ai == null) return 1
                if (bi == null) return -1
                return ai - bi
              })
            }
          })
        }
        if (changed) {
          await this.syncHttpDirtySubtrees()
          this.mindMap.render()
        }
        // Only acknowledge a revision after every fetch and merge completed.
        // A transient request/render failure must remain retryable by polling.
        this.httpUpdatedAt =
          pendingUpdatedAt || this.httpUpdatedAt || new Date().toISOString()
        applied = true
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
    return { applied, skipped: !applied }
  }

  flushPendingHttpRefresh() {
    const queuedAt = this.httpPendingRefreshAt
    const queuedForce = this.httpPendingRefreshForce
    if (!queuedAt && !queuedForce) return
    if (this.httpHydrating || this.httpRefreshing || this.isApplyingRemote) return
    this.httpPendingRefreshAt = ''
    this.httpPendingRefreshForce = false
    this.refreshVisibleFromHttp(queuedAt || '', { force: queuedForce }).catch(
      () => {}
    )
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
      this.flushPendingHttpRefresh()
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
