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
  detachNodeFromParent,
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
import collabNodeFeatures from '../utils/collabNodeFeatures'
import p1PerfPlanModule from '../utils/p1PerfPlan'
const p1PerfPlan = p1PerfPlanModule.planRemoteNodePaint
  ? p1PerfPlanModule
  : p1PerfPlanModule.default
import collabDelete from '../utils/collabDelete'
import collabFullTree from '../utils/collabFullTree'
import collabSpecialObjects from '../utils/collabSpecialObjects'
import collabPaste from '../utils/collabPaste'
import collabPasteUndo from '../utils/collabPasteUndo'
import collabTreeIntegrity from '../utils/collabTreeIntegrity'
import collabImport from '../utils/collabImport'
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
  fieldGroupOf,
  keysForGroups,
  FV_KEY
} from '../utils/fieldMerge'
import { createCollaborationStore } from '../utils/collaborationStore'
import {
  createEditSessionManager,
  editFieldGroup
} from '../utils/collabEditSession'
import mapRefUtil from '../utils/mapRef'
import collabInsertCollect from '../utils/collabInsertCollect'
import collabGeneralization from '../utils/collabGeneralization'
import collabMove from '../utils/collabMove'
import { beginHydration, invalidateHydration, invalidateHydrationSession } from '../utils/hydrationLifecycle'
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

// Selection is local UI state. Lazy subtree payloads can contain stale
// isActive flags from another session; never activate nodes while revealing.
function clearHydratedSelection(root) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    if (node.data) node.data.isActive = false
    ;(node.children || []).forEach(child => stack.push(child))
  }
  return root
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
const REMOTE_GEOMETRY_RENDER_MS = 50
const GEN_INTENT_MS = 30000
const PATCH_CONCURRENCY = 2
const HTTP_RECOVER_RETRY_BASE_MS = 500
const HTTP_RECOVER_RETRY_MAX_MS = 30000
const HTTP_RECOVER_RESTORE_WAIT_MS = 60000
const NULLABLE_PATCH_KEYS = [
  'comments',
  'autoFill',
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
  'knowledgeFiles',
  'textMentions',
  'attachmentName',
  'attachmentId',
  'attachmentMimeType',
  'attachmentStatus',
  'attachmentError',
  'attachmentExtractedText',
  'attachmentErrorIgnored',
  'comments',
  'commentResolved',
  'customLeft',
  'customTop',
  'isFloating'
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
  SET_NODE_COMMENT: true,
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

function indexTreeNodesByUid(root, index = new Map()) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    const uid = node.data && node.data.uid
    if (uid) index.set(uid, node)
    const children = node.children || []
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i])
    }
  }
  return index
}

function removeTreeNodesFromUidIndex(root, index) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    const uid = node.data && node.data.uid
    if (uid && index.get(uid) === node) index.delete(uid)
    ;(node.children || []).forEach(child => stack.push(child))
  }
}

function indexRenderedNodesByUid(root) {
  const index = new Map()
  const visited = new Set()
  const stack = root ? [{ node: root, isGeneralization: false }] : []
  while (stack.length) {
    const { node, isGeneralization } = stack.pop()
    if (!node || visited.has(node)) continue
    visited.add(node)
    const uid =
      (typeof node.getData === 'function' && node.getData('uid')) ||
      (node.nodeData && node.nodeData.data && node.nodeData.data.uid) ||
      (node.data && node.data.uid)
    if (uid && !index.has(uid)) index.set(uid, node)

    const children = node.children || []
    const generalizations = (node._generalizationList || [])
      .map(item => item && item.generalizationNode)
      .filter(Boolean)
    if (isGeneralization) {
      for (let i = generalizations.length - 1; i >= 0; i--) {
        stack.push({ node: generalizations[i], isGeneralization: true })
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], isGeneralization: true })
      }
    } else {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], isGeneralization: false })
      }
      for (let i = generalizations.length - 1; i >= 0; i--) {
        stack.push({ node: generalizations[i], isGeneralization: true })
      }
    }
  }
  return index
}

function hasVersionRestoreOperation(payload = {}) {
  const operations = Array.isArray(payload && payload.operations)
    ? payload.operations
    : []
  return operations.some(operation => {
    const event = (operation && operation.event) || operation || {}
    const type = event.type || (operation && operation.type)
    const eventData = event.payload || {}
    const operationData = (operation && operation.payload) || {}
    return (
      (type === 'map.replaced' || type === 'map.replace') &&
      [
        eventData.reason,
        eventData.fullTreeReason,
        operationData.reason,
        operationData.fullTreeReason
      ].includes('VERSION_RESTORE')
    )
  })
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
    code === 'UID_EXISTS' ||
    code === 'UID_ALREADY_EXISTS' ||
    code === 'DROPPED_DELETED' ||
    /父节点已删除|PARENT_DELETED|missing parent/i.test(msg) ||
    /节点已删除或不存在|NODE_DELETED|MOVE_CONFLICT|UID_REUSED|禁止复用已删除节点/i.test(
      msg
    )
  )
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
  (root.children || []).forEach((child, i) => {
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
  if (payload && payload.richText != null && data.richText == null) {
    data.richText = payload.richText
  }
  if (
    payload &&
    Object.prototype.hasOwnProperty.call(payload, 'generalization') &&
    data.generalization === undefined
  ) {
    data.generalization = payload.generalization
  }
  if (payload && payload.uid && !data.uid) data.uid = payload.uid
  delete data.expand
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
    this.editSessionManager = createEditSessionManager()
    this._pendingEditSessionByFingerprint = new Map()
    this.viewDeferred = false
    this.dirtyUIDSet = new Set()
    this.viewStructureDirtyUIDSet = new Set()
    this.renderedVersion = 0
    this._dragViewDeferred = false
    this._dragStructureBaseline = null
    this._pendingDragExpectedByUid = null
    this._flushingDeferredView = false
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
    this.safeLoadMode = false
    this.collabV2Adapter = null
    this._v2RemoteApplyQueue = Promise.resolve()
    this._v2RemoteApplyEpoch = 0
    this._v2RendererWaiters = new Set()
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
    this.httpFlushHistoryVersion = null
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
    this.httpRecoverQueued = false
    this.httpPendingRecoverVersion = 0
    this.httpPendingRecoverOptions = null
    this.httpRestoreWaiters = []
    this.httpRecoverRetryTimer = null
    this.httpRecoverRetryDelay = HTTP_RECOVER_RETRY_BASE_MS
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this._pendingTextUids = new Set()
    this._pendingAttachmentPatchByUid = new Map()
    this._attachmentPatchIntentSeq = 0
    this._httpTextFlushAfterRender = false
    this._localIntentEpochByUid = new Map()
    this._localIntentSeq = 0
    this._authoritativeRevByUid = new Map()
    this.recentPushed = new Map()
    this.recentHttpDeleted = new Map()
    this.pendingHttpDeletes = []
    this.pendingHttpGeneralizationOwners = []
    this.pendingGenIntent = new Map()
    this.httpTextTimer = null
    this.httpTextFlushing = false
    this.httpTextFlushQueued = false
    this.httpTextFlushPromise = null
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

  getEditSessionSnapshot(uid) {
    const key = String(uid || '')
    if (!key) return null
    const entry = this.currentData && this.currentData[key]
    if (entry && entry.data && !entry.partial) {
      return {
        uid: key,
        data: { ...entry.data },
        fieldVersions: readFieldVersions(entry.data),
        serverRevision:
          (this._authoritativeRevByUid && this._authoritativeRevByUid.get(key)) ||
          Number(this.lastAppliedVersion) ||
          0,
        source: 'currentData'
      }
    }
    const renderer = this.mindMap && this.mindMap.renderer
    const node = renderer && renderer.findNodeByUid && renderer.findNodeByUid(key)
    const data = node && node.getData && node.getData()
    if (!data) return null
    return {
      uid: key,
      data: { ...data },
      fieldVersions: readFieldVersions(data),
      serverRevision:
        (this._authoritativeRevByUid && this._authoritativeRevByUid.get(key)) ||
        Number(this.lastAppliedVersion) ||
        0,
      source: 'renderer'
    }
  }

  beginEditSession({ uid, fields, kind, initialDraft } = {}) {
    if (!uid) return null
    const snapshot = this.getEditSessionSnapshot(uid)
    if (!snapshot) return null
    const session = this.editSessionManager.begin({
      uid,
      fields: fields || ['text'],
      kind: kind || 'field',
      initialDraft,
      snapshot,
      roomKey: this.httpRoomKey || ''
    })
    this.mindMap.emit('edit_session_open', session)
    return session
  }

  getEditSession(id) {
    return this.editSessionManager.get(id)
  }

  listEditSessions() {
    return this.editSessionManager.list()
  }

  onOutboxConflict(op, error) {
    if (op && op.type === 'node.batch') {
      return (op.payload && op.payload.ops || []).map((child, index) =>
        this.onOutboxConflict({ ...op, ...child, opId: `${op.opId}:${index}` }, error)
      )
    }
    if (op && ['node.move', 'node.reorder', 'node.delete'].includes(op.type)) {
      const payload = op.payload || {}
      if (!payload.uid) return null
      const roomKey = String(op.roomKey || this.httpRoomKey || '')
      const id = `outbox-structure:${roomKey}:${op.opId}`
      const session = { id, uid: String(payload.uid), roomKey, kind: 'outbox-structure',
        fields: ['operation'], draft: { operation: { type: op.type, payload } },
        draftRevision: 1, state: 'conflict', outboxOpId: op.opId,
        conflict: { error }, startedAt: Date.now(), updatedAt: Date.now() }
      this.mindMap.emit('edit_session_outbox_conflict', {
        id, opId: op.opId, roomKey, uid: session.uid, session, error,
        patch: session.draft, expected: payload.expected || {}
      })
      return session
    }
    const payload = (op && (op.payload || (op.event && op.event.payload))) || {}
    const uid = String(payload.uid || '')
    if (!uid) return null
    const patch = payload.patch || payload.data || {}
    const fields = Object.keys(patch).filter(field =>
      ['text', 'richText', 'note', 'hyperlink', 'hyperlinkTitle'].includes(field)
    )
    if (!fields.length) return null
    const roomKey = String((op && op.roomKey) || this.httpRoomKey || '')
    const opId = String((op && (op.opId || op.operationId || op.id)) || '')
    const expected = payload.expected || {}
    const fingerprint = this.editSessionOperationFingerprint(uid, patch, expected)
    const linkedSessionId = this._pendingEditSessionByFingerprint.get(fingerprint)
    const linkedSession = linkedSessionId && this.editSessionManager.get(linkedSessionId)
    const fieldVersions = {}
    fields.forEach(field => {
      const group = editFieldGroup(field)
      const version = expected[`__fv.${group}`]
      if (version != null) fieldVersions[group] = Number(version) || 0
    })
    const latestSnapshot = this.getEditSessionSnapshot(uid)
    const stableId = linkedSession
      ? linkedSession.id
      : `outbox-conflict:${roomKey}:${opId || uid}`
    let session = linkedSession
    if (session) {
      // Keep the current draft: this outbox payload may predate later typing.
    } else if (!this.editSessionManager.get(stableId)) {
      const baseValues = {}
      fields.forEach(field => {
        baseValues[field] = undefined
      })
      session = this.editSessionManager.restore({
        id: stableId,
        uid,
        roomKey,
        kind: 'outbox-conflict',
        fields,
        baseValues,
        baseVersions: fieldVersions,
        draft: Object.fromEntries(fields.map(field => [field, patch[field]])),
        draftRevision: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        conflict: { latestSnapshot, restored: true }
      })
    } else {
      session = this.editSessionManager.get(stableId)
    }
    const conflict = this.editSessionManager.retainConflict(stableId, {
      latestSnapshot,
      error
    })
    const safeError = {
      code: String((error && error.code) || ''),
      message: String((error && error.message) || error || ''),
      status: Number((error && (error.status || error.statusCode)) || 0)
    }
    const detail = {
      id: stableId,
      uid,
      roomKey,
      opId,
      patch: Object.fromEntries(fields.map(field => [field, patch[field]])),
      expected,
      error: safeError,
      latestSnapshot,
      session: conflict || session
    }
    this.mindMap.emit('edit_session_outbox_conflict', detail)
    return detail
  }

  editSessionOperationFingerprint(uid, patch, expected) {
    const stableObject = value => {
      const source = value && typeof value === 'object' ? value : {}
      const out = {}
      Object.keys(source).sort().forEach(key => {
        out[key] = source[key]
      })
      return out
    }
    return JSON.stringify({
      uid: String(uid || ''),
      patch: stableObject(patch),
      expected: stableObject(expected)
    })
  }

  updateEditSessionDraft(id, patch) {
    const session = this.editSessionManager.updateDraft(id, patch)
    if (session) this.mindMap.emit('edit_session_draft_change', session)
    return session
  }

  setEditSessionComposing(id, composing) {
    return this.editSessionManager.setComposing(id, composing)
  }

  buildEditSessionExpected(id, fields) {
    return this.editSessionManager.buildExpected(id, fields)
  }

  validateEditSession(id, fields) {
    const session = this.editSessionManager.get(id)
    if (!session) {
      return {
        ok: false,
        code: 'EDIT_SESSION_MISSING',
        conflicts: [],
        latestSnapshot: null
      }
    }
    return this.editSessionManager.validate(
      id,
      this.getEditSessionSnapshot(session.uid),
      fields
    )
  }

  retainEditSessionConflict(id, options = {}) {
    const session = this.editSessionManager.get(id)
    const latestSnapshot =
      options.latestSnapshot ||
      (session && this.getEditSessionSnapshot(session.uid)) ||
      null
    const next = this.editSessionManager.retainConflict(id, {
      ...options,
      latestSnapshot
    })
    if (next) this.mindMap.emit('edit_session_conflict', next, options.error)
    return next
  }

  rebaseEditSession(id) {
    const session = this.editSessionManager.get(id)
    if (!session) return null
    const next = this.editSessionManager.rebase(
      id,
      this.getEditSessionSnapshot(session.uid)
    )
    if (next) this.mindMap.emit('edit_session_draft_change', next)
    return next
  }

  serializeEditSession(id) {
    return this.editSessionManager.serialize(id)
  }

  restoreEditSession(snapshot) {
    const session = this.editSessionManager.restore(snapshot)
    if (session) this.mindMap.emit('edit_session_restored', session)
    return session
  }

  resolveEditSession(id) {
    const session = this.editSessionManager.resolve(id)
    if (session) this.mindMap.emit('edit_session_resolved', session)
    return session
  }

  discardEditSession(id) {
    const session = this.editSessionManager.discard(id)
    const textEdit = this.mindMap && this.mindMap.renderer && this.mindMap.renderer.textEdit
    ;[textEdit, this.mindMap && this.mindMap.richText].forEach(editor => {
      if (editor && typeof editor.discardEditSession === 'function') editor.discardEditSession(id)
    })
    if (session) this.mindMap.emit('edit_session_discarded', session)
    return session
  }

  async commitEditSession(id, patch = {}) {
    const session = this.editSessionManager.get(id)
    if (!session) {
      const err = new Error('edit session missing')
      err.code = 'EDIT_SESSION_MISSING'
      throw err
    }
    if (session.composing) {
      const err = new Error('编辑器仍在输入法合成中')
      err.code = 'IME_COMPOSITION_ACTIVE'
      throw err
    }
    if (!this.collabV2Adapter || !this.httpCollabMode) {
      const err = new Error('协作提交通道不可用')
      err.code = 'COLLAB_WRITE_UNAVAILABLE'
      throw err
    }
    if (session.roomKey && session.roomKey !== this.httpRoomKey) {
      const err = new Error('编辑会话所属房间已切换')
      err.code = 'EDIT_SESSION_SCOPE_CHANGED'
      this.retainEditSessionConflict(id, { error: err })
      throw err
    }
    // An editor opens immediately on a newly inserted local node. Its text
    // update must follow the insert ACK, which establishes its first versions.
    const uninitializedVersion = Object.values(session.baseVersions || {}).every(version => Number(version) === 0)
    if (this.httpInsertPromise && (!this.isPersistAcked(session.uid) || uninitializedVersion)) {
      await this.httpInsertPromise
      if (!this.editSessionManager.get(id) ||
        (session.roomKey && session.roomKey !== this.httpRoomKey)) {
        const err = new Error('编辑会话已结束或所属房间已切换')
        err.code = 'EDIT_SESSION_SCOPE_CHANGED'
        throw err
      }
    }
    const changes = {}
    Object.keys(patch || {}).forEach(field => {
      if (session.fields.includes(field)) changes[field] = patch[field]
    })
    const changedFields = Object.keys(changes)
    if (!changedFields.length) {
      this.resolveEditSession(id)
      return { saved: true, draftSaved: true, unchanged: true }
    }
    const validation = this.validateEditSession(id, changedFields)
    if (!validation.ok) {
      const err = new Error('编辑字段已被其他协作者修改，请先核对最新内容')
      const hasBaseline = !!(
        validation.latestSnapshot &&
        validation.latestSnapshot.data &&
        Object.keys(validation.latestSnapshot.data).length
      )
      err.code = hasBaseline ? 'REPLACE_CONFLICT' : 'PRECONDITION_REQUIRED'
      err.status = hasBaseline ? 409 : 428
      err.details = {
        conflicts: validation.conflicts,
        latest: validation.latestSnapshot
      }
      this.retainEditSessionConflict(id, {
        error: err,
        validation,
        latestSnapshot: validation.latestSnapshot
      })
      throw err
    }
    const expected = this.editSessionManager.buildExpected(id, changedFields)
    const submittedDraftRevision = session.draftRevision
    const fingerprint = this.editSessionOperationFingerprint(
      session.uid,
      changes,
      expected
    )
    this._pendingEditSessionByFingerprint.set(fingerprint, id)
    let result
    try {
      result = await this.submitV2('node.update', {
        uid: session.uid,
        patch: changes,
        expected
      })
    } catch (err) {
      const code = String((err && err.code) || '')
      const status = Number((err && (err.status || err.statusCode)) || 0)
      if (
        code === 'REPLACE_CONFLICT' ||
        code === 'PRECONDITION_REQUIRED' ||
        status === 409 ||
        status === 428
      ) {
        const rejectedOp = {
          type: 'node.update',
          roomKey: session.roomKey,
          payload: { uid: session.uid, patch: changes, expected }
        }
        this.onOutboxConflict(rejectedOp, err)
        this.retainEditSessionConflict(id, {
          error: err,
          latestSnapshot: this.getEditSessionSnapshot(session.uid)
        })
      } else {
        this._pendingEditSessionByFingerprint.delete(fingerprint)
        this.mindMap.emit('edit_session_save_failed', this.getEditSession(id), err)
      }
      throw err
    }
    const latestSession = this.editSessionManager.get(id)
    if (!latestSession) return { ...result, saved: true, draftSaved: true }
    if (latestSession.draftRevision === submittedDraftRevision) {
      this._pendingEditSessionByFingerprint.delete(fingerprint)
      this.resolveEditSession(id)
      return { ...result, saved: true, draftSaved: true }
    }
    const latestSnapshot = this.getEditSessionSnapshot(session.uid)
    const committedVersion = Number(result && result.version) || 0
    const sameCommittedFields = changedFields.every(field => {
      const group = editFieldGroup(field)
      const expectedVersion = Number(
        latestSnapshot && latestSnapshot.fieldVersions[group]
      ) || 0
      const committedData = latestSnapshot && latestSnapshot.data
      return (
        committedData &&
        stableFieldValue(committedData[field]) ===
          stableFieldValue(changes[field]) &&
        committedVersion > 0 && expectedVersion === committedVersion
      )
    })
    if (sameCommittedFields) {
      const rebased = this.editSessionManager.rebase(id, latestSnapshot)
      this.mindMap.emit('edit_session_draft_change', rebased)
      return { ...result, saved: true, draftSaved: false, session: rebased }
    }
    const err = new Error('保存期间草稿发生变化，已保留新草稿，请核对后再次保存')
    err.code = 'EDIT_SESSION_CHANGED_DURING_COMMIT'
    this.retainEditSessionConflict(id, {
      error: err,
      latestSnapshot
    })
    return {
      ...result,
      saved: true,
      draftSaved: false,
      session: this.getEditSession(id)
    }
  }

  expectedFieldVersions(uid, changedFields = []) {
    const snapshot = this.getEditSessionSnapshot(uid)
    const expected = { uid: String(uid || '') }
    const groups = new Set((changedFields || []).map(editFieldGroup).filter(Boolean))
    groups.forEach(group => {
      const fromSnapshot =
        snapshot && snapshot.fieldVersions && snapshot.fieldVersions[group]
      const fromPushed =
        this.lastPushed && this.lastPushed[uid] &&
        this.lastPushed[uid].fieldVersions &&
        this.lastPushed[uid].fieldVersions[group]
      expected[`__fv.${group}`] = Number(
        snapshot
          ? (fromSnapshot != null ? fromSnapshot : 0)
          : fromPushed
      ) || 0
    })
    return expected
  }

  onNodeDragStart() {
    if (this._dragViewDeferred || !this.collabV2Adapter) return
    const loaded = transformTreeDataToObject(this.mindMap.renderer.renderTree)
    if (!this.currentData) this.currentData = loaded
    else {
      Object.keys(loaded).forEach(uid => {
        const entry = this.currentData[uid]
        if (entry && entry.partial) {
          const versions = readFieldVersions(entry.data), loadedVersions = readFieldVersions(loaded[uid].data)
          const data = { ...loaded[uid].data, ...entry.data }
          Object.keys(entry.data || {}).forEach(field => {
            const group = editFieldGroup(field)
            if (field !== FV_KEY && Object.prototype.hasOwnProperty.call(loaded[uid].data, field) &&
              Number(loadedVersions[group] || 0) >= Number(versions[group] || 0)) data[field] = loaded[uid].data[field]
          })
          data[FV_KEY] = { ...versions }
          Object.keys(loadedVersions).forEach(group => { data[FV_KEY][group] = Math.max(Number(versions[group] || 0), Number(loadedVersions[group] || 0)) })
          this.currentData[uid] = { ...loaded[uid], ...entry, partial: false, data,
            children: Array.from(new Set([...(entry.children || []), ...(loaded[uid].children || [])])) }
        }
      })
      const additions = new Set(Object.keys(loaded).filter(uid => !this.currentData[uid] && !this.isTombstonedUid(uid) && !this.pendingUids.has(uid)))
      additions.forEach(uid => { this.currentData[uid] = loaded[uid] })
      Object.keys(loaded).forEach(uid => {
        const entry = this.currentData[uid]
        if (!entry) return
        const children = loaded[uid].children.filter(id => additions.has(id))
        if (children.length) entry.children = Array.from(new Set([...(entry.children || []), ...children]))
      })
    }
    this._dragViewDeferred = true
    this._dragStartRevision = Number(this.lastAppliedVersion) || 0
    this._dragStructureBaseline = indexMindTree(this.mindMap.renderer.renderTree)
  }

  onNodeDragEnd() {
    this._dragViewDeferred = false
    this._dragStructureBaseline = null
    this.projectDeferredView().catch(err => this.mindMap.emit('collab_write_conflict', err))
  }

  onNodeDragCancel() { this.onNodeDragEnd() }

  async projectDeferredView(force = false) {
    if ((!this.viewDeferred && !force) || this._dragViewDeferred || this._disposed) return
    if (this._flushingDeferredView) return this._flushingDeferredView
    const room = this.httpRoomKey, adapter = this.collabV2Adapter
    const task = Promise.resolve(this._v2RemoteApplyQueue).catch(() => {}).then(async () => {
      if (room !== this.httpRoomKey || adapter !== this.collabV2Adapter || this._disposed) return
      const renderer = this.mindMap.renderer
      const root = renderer && renderer.renderTree
      if (!root || !this.currentData || !this.currentData[root.data.uid]) return
      const old = indexTreeNodesByUid(root)
      const activeUids = (renderer.activeNodeList || []).map(node => node.getData && node.getData('uid')).filter(Boolean)
      const visiting = new Set()
      const build = uid => {
        if (visiting.has(uid)) throw new Error('协作树包含循环')
        const entry = this.currentData[uid], previous = old.get(uid)
        if (!entry) return this.pendingUids.has(uid) ? previous : null
        if (entry.partial) return previous || null
        visiting.add(uid)
        const node = previous || { data: { uid }, children: [] }
        const expand = node.data && node.data.expand
        node.data = { ...(node.data || {}), ...(entry.data || {}), uid }
        if (expand !== undefined) node.data.expand = expand
        if (entry.position != null) node.data.position = entry.position
        const children = Array.isArray(entry.children) ? entry.children : []
        node.children = children.map(build).filter(Boolean)
        visiting.delete(uid)
        return node
      }
      this.isApplyingRemote = true
      try {
        build(root.data.uid)
        await new Promise(resolve => this.mindMap.render(resolve))
        if (room !== this.httpRoomKey || adapter !== this.collabV2Adapter) return
        if (typeof this.restoreActiveUids === 'function') this.restoreActiveUids(activeUids)
        this.renderedVersion = Number(this.lastAppliedVersion) || 0
        this.viewDeferred = false
        this.dirtyUIDSet.clear()
        this.viewStructureDirtyUIDSet.clear()
      } finally { this.isApplyingRemote = false }
    })
    this._flushingDeferredView = task
    this._v2RemoteApplyQueue = task.catch(() => {})
    try { return await task } finally { if (this._flushingDeferredView === task) this._flushingDeferredView = false }
  }

  async readWriteGuard(uid, subtree = false) {
    if (!this.httpFetchWriteGuard) throw Object.assign(new Error('请刷新客户端以获取协同校验能力'), { code: 'PRECONDITION_REQUIRED' })
    const result = await this.httpFetchWriteGuard(uid, subtree)
    const row = result && result.items && result.items[0]
    if (!row || row.uid !== uid) throw Object.assign(new Error('目标节点已不存在'), { code: 'NODE_DELETED' })
    return { ...row, revision: Number(result.version) || 0 }
  }

  observeGuardedIntentEvent(type, payload, revision) {
    const watch = this._guardIntentWatch
    if (!watch || revision <= watch.revision || watch.conflict) return
    const within = uid => {
      const visited = new Set()
      while (uid && !visited.has(uid)) {
        if (watch.roots.has(uid)) return true
        visited.add(uid)
        uid = watch.nodes.get(uid)?.parent
      }
      return false
    }
    const uid = payload.uid, parent = payloadParentUid(payload)
    const structural = /insert|move|reorder|delete|restore/.test(type)
    if (type === 'map.replaced' || payload.resnapshot) watch.conflict = true
    else if (within(uid) || (structural && [parent, payload.oldParentUid, payload.fromParentUid].some(within))) watch.conflict = true
    else if (uid && !watch.nodes.has(uid)) {
      // An insert can prove its ancestry via a loaded parent. Unknown content
      // updates cannot prove they are outside a partially loaded delete subtree.
      if (!/insert/.test(type) || !parent || !watch.nodes.has(parent)) watch.conflict = true
    }
  }

  interceptGuardedCommand(name, args = []) {
    if (!this.collabV2Adapter || !this.httpCollabMode || this.isApplyingRemote || this._allowGuardedCommand) return
    const deleting = ['REMOVE_NODE', 'REMOVE_CURRENT_NODE', 'CUT_NODE'].includes(name)
    const moving = MOVE_COMMANDS[name] && name !== 'INSERT_PARENT_NODE'
    if (!deleting && !moving) return
    const room = this.httpRoomKey, revision = this._dragViewDeferred
      ? this._dragStartRevision : Number(this.lastAppliedVersion) || 0
    const renderer = this.mindMap.renderer
    const active = (renderer.activeNodeList || []).slice()
    const explicit = Array.isArray(args[0]) ? args[0] : args[0] && args[0].getData ? [args[0]] : active
    const targets = deleting ? collabDelete.collectDeleteRoots(explicit, name).roots : explicit.map(node => ({ uid: node.getData('uid'), node }))
    if (!targets.length) return
    if (this._guardIntentActive) return Promise.resolve(false)
    this._guardIntentActive = true
    if (deleting) this._guardIntentWatch = {
      revision, nodes: indexMindTree(renderer.renderTree), roots: new Set(targets.map(item => item.uid)), conflict: false
    }
    return (async () => {
      const locations = new Map(), deleteGuards = new Map()
      const ids = new Set(targets.map(item => item.uid))
      if (moving) {
        args.forEach(value => { if (value && value.getData) ids.add(value.getData('uid')) })
        explicit.forEach(node => {
          if (node.parent) {
            ids.add(node.parent.getData('uid'))
            if (node.parent.parent) ids.add(node.parent.parent.getData('uid'))
            const siblings = node.parent.children || [], index = siblings.indexOf(node)
            siblings.slice(Math.max(0, index - 2), index + 3).forEach(item => ids.add(item.getData('uid')))
          }
        })
      }
      for (const uid of ids) {
        const row = await this.readWriteGuard(uid, deleting && targets.some(item => item.uid === uid))
        if (row.revision > Number(this.lastAppliedVersion || 0)) {
          await this.recoverHttpCollab(row.revision)
        }
        const structuralRevision = this._structuralGuardRevisions && this._structuralGuardRevisions.get(uid) || 0
        if (room !== this.httpRoomKey || (deleting && (this._guardIntentWatch.conflict || row.revision > Number(this.lastAppliedVersion || 0))) ||
          (moving && (row.revision > Number(this.lastAppliedVersion || 0) || structuralRevision > revision))) {
          throw Object.assign(new Error('操作期间导图已更新，请核对最新位置后重新操作'), { code: 'REPLACE_CONFLICT' })
        }
        locations.set(uid, row)
        if (deleting) deleteGuards.set(uid, { uid, subtree_token: row.subtree_token })
      }
      this._preparedMoveLocations = locations
      this._preparedDeleteGuards = deleteGuards
      this._guardIntentWatch = null
      const resolveNode = value => {
        if (Array.isArray(value)) return value.map(resolveNode)
        if (!value?.getData) return value
        const node = renderer.findNodeByUid(value.getData('uid'))
        if (!node) throw Object.assign(new Error('操作目标已失效，请重新选择'), { code: 'NODE_DELETED' })
        return node
      }
      const liveArgs = args.map(resolveNode)
      if (!args[0] && (name === 'REMOVE_NODE' || name === 'REMOVE_CURRENT_NODE')) {
        liveArgs[0] = targets.map(item => resolveNode(item.node))
      } else if (!args[0] && active.map(node => node.getData('uid')).join('|') !==
        (renderer.activeNodeList || []).map(node => node.getData('uid')).join('|')) {
        throw Object.assign(new Error('选择已变化，请重新操作'), { code: 'REPLACE_CONFLICT' })
      }
      this._preparedMoveCommand = { name, args: liveArgs, sourceUids: new Set(targets.map(item => item.uid)) }
      this._allowGuardedCommand = true
      this._latestStructuralWrite = null
      let result
      try { result = this.mindMap.execCommand(name, ...liveArgs) }
      finally { this._allowGuardedCommand = false }
      if (this._latestStructuralWrite) await this._latestStructuralWrite
      return result === undefined ? true : result
    })().catch(async err => {
      this.mindMap.emit('collab_write_conflict', err)
      if (!this._dragViewDeferred) await this.projectDeferredView(true)
      return false
    }).finally(() => { this._guardIntentActive = false; this._guardIntentWatch = null })
  }

  guardWritePayload(type, payload = {}) {
    if (type === 'node.batch') {
      const inserted = new Set()
      return { ...payload, ops: (payload.ops || []).map(op => {
        const uid = op.payload && op.payload.uid
        const next = inserted.has(uid) ? op : { ...op, payload: this.guardWritePayload(op.type, op.payload) }
        if (op.type === 'node.insert' && uid) inserted.add(uid)
        return next
      }) }
    }
    if (type === 'node.update') {
      const patch = payload.patch || payload.data || payload
      const fields = Object.keys(patch).filter(field => ['text', 'richText', 'note', 'hyperlink', 'hyperlinkTitle'].includes(field))
      return fields.length ? { ...payload, expected: { ...this.expectedFieldVersions(payload.uid, fields), ...(payload.expected || {}) } } : payload
    }
    if (type === 'node.delete') return { ...payload, expected: { ...(this._preparedDeleteGuards && this._preparedDeleteGuards.get(payload.uid)), ...(payload.expected || {}) } }
    if (!['node.move', 'node.reorder'].includes(type) || payload.expected) return payload
    const locations = this._preparedMoveLocations || new Map()
    const source = locations.get(payload.uid)
    if (!source) return payload // Server rejects an operation without a proved baseline.
    const expected = { uid: payload.uid, parent_uid: source.parent_uid, position: source.position }
    const parentUid = payload.parentUid || payload.parent_uid || payload.parent || source.parent_uid
    const target = locations.get(parentUid)
    if (target) Object.assign(expected, { target_uid: parentUid, target_parent_uid: target.parent_uid, target_position: target.position })
    const command = this._preparedMoveCommand || {}
    const next = { ...payload, expected }
    if (command.name === 'MOVE_NODE_TO') delete next.index // Drop inside a parent appends; no stale numeric slot.
    else if (next.index != null) {
      const anchorNode = command.args && command.args[1]
      let anchor = anchorNode && anchorNode.getData && locations.get(anchorNode.getData('uid'))
      let side = command.name === 'INSERT_AFTER' ? 'after' : 'before'
      if (!anchor) {
        const parent = this.mindMap.renderer.findNodeByUid(parentUid)
        const siblings = (parent && parent.children || []).filter(node => !(command.sourceUids && command.sourceUids.has(node.getData('uid'))))
        const index = Math.max(0, Number(next.index) || 0)
        const node = siblings[index] || siblings[index - 1]
        anchor = node && locations.get(node.getData('uid'))
        side = siblings[index] ? 'before' : 'after'
        if (!siblings.length) expected.target_empty = true
      }
      if (anchor) Object.assign(expected, { anchor_uid: anchor.uid, anchor_parent_uid: anchor.parent_uid, anchor_position: anchor.position, anchor_side: side })
    }
    return next
  }

  largeMapDelay(smallMs, largeMs) {
    return this.mapSize() >= 200 ? largeMs : smallMs
  }

  // 初始化数据
  setAuthoritySnapshot(data) {
    this.currentData = transformTreeDataToObject(data)
  }

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

  setPreviewApplied(applied, options = {}) {
    this.previewApplied = !!applied
    if (applied && options.hydrateExpanded !== false && this.httpCollabMode && this.safeLoadMode) {
      // Defer: renderer root may not exist until setData finishes.
      Promise.resolve()
        .then(() => this.hydrateExpandedPartialParents())
        .catch(err =>
          console.error('[mind-map] expanded partial hydrate failed', err)
        )
    }
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
      data.children = (data.children || []).concat(chunk.map(clearHydratedSelection))
      if (!overflow.length) {
        delete data.data._overflowChildren
        data.data.hasMore = false
      }
      return
    }
    if (this.httpFetchSubtree) {
      // Authoritative empty parent: nothing to fetch.
      if (!live && count <= 0 && !dirty) return
      // Partial or empty-with-total>0 must hydrate (single-flight inside).
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
      data.children.push(clearHydratedSelection({
        data: {
          ...(json.data || {}),
          uid: childUid,
          expand: false,
          childCount: Array.isArray(json.children) ? json.children.length : 0
        },
        children: []
      }))
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
    this._presenceSignature = null
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
    this.cancelV2RemoteApply = this.cancelV2RemoteApply.bind(this)
    this.mindMap.on('before_set_data', this.onBeforeSetData)
    this.mindMap.on('before_update_data', this.cancelV2RemoteApply)
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
    this.onNodeDragStart = this.onNodeDragStart.bind(this)
    this.onNodeDragEnd = this.onNodeDragEnd.bind(this)
    this.onNodeDragCancel = this.onNodeDragCancel.bind(this)
    this.mindMap.on('node_drag_start', this.onNodeDragStart)
    this.mindMap.on('node_dragend', this.onNodeDragEnd)
    this.mindMap.on('node_drag_cancel', this.onNodeDragCancel)
    this.onThemeChange = this.onThemeChange.bind(this)
    this.onLayoutChange = this.onLayoutChange.bind(this)
    this.mindMap.on('view_theme_change', this.onThemeChange)
    this.mindMap.on('layout_change', this.onLayoutChange)
    this.wrapSearchReplace()
  }

  // 解绑事件
  unBindEvent() {
    this.cancelV2RemoteApply()
    this._v2RemoteApplyQueue = Promise.resolve()
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
    this.disconnectProvider({ recreateDoc: false })
    if (this.ymap && this.onObserve) this.ymap.unobserveDeep(this.onObserve)
    if (this.ydoc) this.ydoc.destroy()
    this.ydoc = null
    this.ymap = null
    this.currentData = null
    this.pendingInitData = null
    this.lastPushed = {}
    this.ackedUids && this.ackedUids.clear()
    this.pendingUids && this.pendingUids.clear()
    this.httpTextFlushQueued = false
    this._pendingAttachmentPatchByUid && this._pendingAttachmentPatchByUid.clear()
    this.deletedUids && this.deletedUids.clear()
    this.abandonedInsertUids && this.abandonedInsertUids.clear()
    this.recentHttpDeleted && this.recentHttpDeleted.clear()
    this.pendingGenIntent && this.pendingGenIntent.clear()
    this._pendingTextUids && this._pendingTextUids.clear()
    this._httpTextFlushAfterRender = false
    this.hydrateInflight && this.hydrateInflight.clear()
    this.hydratedUids && this.hydratedUids.clear()
    this.hydrateFailedUids && this.hydrateFailedUids.clear()
    this.collabV2Adapter = null
    this.mindMap.off('data_change', this.onDataChange)
    this.mindMap.off('node_active', this.onNodeActive)
    this.mindMap.off('node_tree_render_end', this.onNodeTreeRenderEnd)
    this.mindMap.off('before_set_data', this.onBeforeSetData)
    this.mindMap.off('before_update_data', this.cancelV2RemoteApply)
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
    if (this.onNodeDragStart) this.mindMap.off('node_drag_start', this.onNodeDragStart)
    if (this.onNodeDragEnd) this.mindMap.off('node_dragend', this.onNodeDragEnd)
    if (this.onNodeDragCancel) this.mindMap.off('node_drag_cancel', this.onNodeDragCancel)
    if (this.onThemeChange) this.mindMap.off('view_theme_change', this.onThemeChange)
    if (this.onLayoutChange) this.mindMap.off('layout_change', this.onLayoutChange)
    clearTimeout(this._remoteGeometryTimer)
    this._remoteGeometryTimer = null
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    clearTimeout(this.httpRecoverRetryTimer)
    clearTimeout(this.httpRemoteRecoverTimer)
    clearTimeout(this.httpSettleTimer)
    this.httpSettleTimer = null
    this.httpRecoverRetryTimer = null
    this.httpRemoteRecoverTimer = null
    this.httpPendingRemoteVersion = 0
    clearTimeout(this._v2InsertRetryTimer)
    if (this._inflightTextKeys) this._inflightTextKeys.clear()
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
    if (parentNode.getData && parentNode.getData('expand') === false) {
      const count = Number(parentNode.getData('childCount')) || 0
      const live = (parentNode.nodeData && parentNode.nodeData.children || []).length
      renderer.setNodeData(parentNode, { childCount: Math.max(count, live) + 1 })
      if (this.currentData) {
        this.currentData[uid] = json
        const parent = this.currentData[parentUid]
        if (parent) {
          const children = parent.children || []
          if (!children.includes(uid)) parent.children = [...children, uid]
        }
      }
      return true
    }
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      if (!parentNode.nodeData.children) parentNode.nodeData.children = []
      const exists = parentNode.nodeData.children.some(
        child => child && child.data && child.data.uid === uid
      )
      if (!exists) {
        const data = { ...(json.data || {}) }
        delete data.expand
        parentNode.nodeData.children.push({
          data: {
            ...data,
            uid,
            expand: false
          },
          children: []
        })
      }
      const count = Number(parentNode.getData && parentNode.getData('childCount')) || 0
      renderer.setNodeData(parentNode, {
        childCount: Math.max(count, parentNode.nodeData.children.length)
      })
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
  onDataChange(data, change) {
    if (change && change.source && change.source !== 'local') return
    // Effective local deltas must stay queued even during the short remote
    // settle/history window. The legacy recovery scan used to rediscover
    // these edits later; an affected-UID queue must remember them explicitly.
    if (change && change.incremental && this.collabV2Adapter) {
      if (!this._pendingTextUids) this._pendingTextUids = new Set()
      change.nodes.forEach(entry => { if (entry.tree && entry.tree.data) this._pendingTextUids.add(entry.tree.data.uid) })
      this.scheduleHttpTextSync()
      return
    }
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

  resetLocalIntentState() {
    this._localIntentEpochByUid = new Map()
    this._localIntentSeq = 0
    this._authoritativeRevByUid = new Map()
  }

  localIntentEpochOf(uid) {
    return (this._localIntentEpochByUid && this._localIntentEpochByUid.get(uid)) || 0
  }

  bumpAuthoritativeUidRev(uid, revision) {
    if (!uid || !revision) return
    if (!this._authoritativeRevByUid) this._authoritativeRevByUid = new Map()
    const next = Number(revision)
    if (next > (this._authoritativeRevByUid.get(uid) || 0)) this._authoritativeRevByUid.set(uid, next)
  }

  // One authoritative per-command local intent epoch. Recorded exactly once per
  // command here (never in onDataChange, which the same command also emits).
  recordLocalIntentUids(uids) {
    if (!this._localIntentEpochByUid) this._localIntentEpochByUid = new Map()
    for (const uid of uids) {
      if (!uid) continue
      this._localIntentSeq = (this._localIntentSeq || 0) + 1
      this._localIntentEpochByUid.set(uid, this._localIntentSeq)
    }
  }

  commandIntentUids(name, args) {
    const uids = []
    const pushNode = node => {
      if (!node) return
      const target = typeof this.resolveHttpPatchNode === 'function' ? this.resolveHttpPatchNode(node) : node
      if (target && typeof target.getData === 'function') {
        const uid = target.getData('uid')
        if (uid) uids.push(uid)
      }
    }
    const structural = name === 'REMOVE_NODE' || name === 'MOVE_NODE_TO' || name === 'MOVE_UP_ONE_LEVEL'
    if (FIELD_COMMANDS[name] || structural) {
      for (const arg of args) {
        if (Array.isArray(arg)) arg.forEach(pushNode)
        else pushNode(arg)
      }
      if (!uids.length && FIELD_COMMANDS[name]) {
        const active = this.mindMap && this.mindMap.renderer && this.mindMap.renderer.activeNodeList
        if (Array.isArray(active)) active.forEach(pushNode)
      }
    }
    return Array.from(new Set(uids))
  }

  onAfterExecCommand(name) {
    if (this.collabV2Adapter && !this.isApplyingRemote && !this.isSetData && !this.httpReplacing) {
      const commandUids = this.commandIntentUids(name, Array.prototype.slice.call(arguments, 1))
      this.recordLocalIntentUids(commandUids)
    }
    if (
      this.httpCollabMode &&
      !this.isApplyingRemote &&
      !this.isSetData &&
      !this.httpReplacing &&
      name === 'SET_NODE_ATTACHMENT'
    ) {
      if (!this._pendingAttachmentPatchByUid) this._pendingAttachmentPatchByUid = new Map()
      if (!this._pendingTextUids) this._pendingTextUids = new Set()
      const commandUids = this.commandIntentUids(name, Array.prototype.slice.call(arguments, 1))
      commandUids.forEach(uid => {
        this._attachmentPatchIntentSeq = (this._attachmentPatchIntentSeq || 0) + 1
        this._pendingAttachmentPatchByUid.set(uid, this._attachmentPatchIntentSeq)
        this._pendingTextUids.add(uid)
      })
      if (commandUids.length) this.scheduleHttpTextSync()
    }
    if (this.collabV2Adapter && (name === 'SET_NODE_TEXT' || name === 'SET_NODE_NOTE')) {
      const node = arguments[1]
      if (node && node.getData) {
        if (!this._pendingTextUids) this._pendingTextUids = new Set()
        this._pendingTextUids.add(node.getData('uid'))
      }
    }
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

  commitOpenTextEdit() {
    const editor =
      this.mindMap &&
      this.mindMap.renderer &&
      this.mindMap.renderer.textEdit
    if (editor && typeof editor.hideEditTextBox === 'function') {
      editor.hideEditTextBox()
    }
  }

  async flushPendingForReload(options = {}) {
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 4000)
    this.commitOpenTextEdit()
    this.flushLocalNow()
    clearTimeout(this.httpTextTimer)
    this.httpTextTimer = null
    clearTimeout(this.httpStructureTimer)
    this.httpStructureTimer = null
    if (this._v2InsertRetryTimer) {
      clearTimeout(this._v2InsertRetryTimer)
      this._v2InsertRetryTimer = null
      this._v2InsertFromCommand = true
    }
    const work = (async () => {
      if (this.httpCollabMode) {
        await Promise.resolve(this.flushHttpTextNow()).catch(() => {})
        if (
          this._v2InsertFromCommand ||
          this.httpInsertPromise ||
          !this.collabV2Adapter
        ) {
          await Promise.resolve(this.flushHttpInsert()).catch(() => {})
        }
      }
      const adapter = this.collabV2Adapter
      if (adapter && typeof adapter.waitForOutboxDurable === 'function') {
        return adapter.waitForOutboxDurable({ timeoutMs })
      }
      return { ok: true }
    })()
    return Promise.race([
      work,
      new Promise(resolve =>
        setTimeout(() => resolve({ ok: true, timeout: true }), timeoutMs)
      )
    ])
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
    // Selection only updates presence. Lazy children are loaded by an
    // explicit expand action (the count badge, menu or keyboard command).
    this.setLocalPresence({ selectedUids })
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

  canBeginNodeEdit(editingNode) {
    const node = editingNode && editingNode.getData ? editingNode : null
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
        this.mindMap.emit('collab_lock_denied', other)
        return false
      }
    }
    return true
  }

  onBeforeShowTextEdit(editingNode) {
    if (!this.canBeginNodeEdit(editingNode)) return
    const node = editingNode && editingNode.getData ? editingNode : null
    const uid = node && node.getData && node.getData('uid')
    this.setLocalPresence({ editingUid: uid || null })
  }

  onHideTextEdit(textEditNode, list, node, options = {}) {
    this.setLocalPresence({ editingUid: null })
    if (this.httpCollabMode && !(options && options.editSessionSaved)) {
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
    // 每次保存确认、每条远端操作都会带着同一份在线名单回来。
    // 名单里没人换编辑节点时，不去动节点上的头像 DOM。
    const signature = JSON.stringify(
      (list || [])
        .filter(item => item && item.id && !(this.userInfo && item.id === this.userInfo.id))
        .map(item => [item.id, item.editingUid || null, item.name || '', item.color || '', item.avatar || ''])
    )
    if (signature === this._presenceSignature && !Object.keys(this.waitNodeUidMap || {}).length) {
      return
    }
    this._presenceSignature = signature
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
      // Selection remains presence data, but a node avatar means that the
      // collaborator is actively editing that node's text.
      const uid = item.editingUid
      if (!uid) return
      const userInfo = {
        id: item.id,
        name: item.name,
        color: item.color,
        avatar: item.avatar,
        editing: true
      }
      const node = renderer.findNodeByUid(uid)
      if (node) node.addUser(userInfo)
      else {
        if (!this.waitNodeUidMap[uid]) this.waitNodeUidMap[uid] = []
        this.waitNodeUidMap[uid].push(userInfo)
      }
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
    if (typeof this.refreshCollapsedNodeCounts === 'function') {
      this.refreshCollapsedNodeCounts().catch(() => {})
    }
    const reorderedParents = []
    if (!this._dragViewDeferred && this._pendingChildOrderParents) {
      this._pendingChildOrderParents.forEach(uid => {
        if (this.projectCanonicalChildOrder(uid)) reorderedParents.push(uid)
      })
    }
    if (reorderedParents.length) this.requestRemoteApplyRender(reorderedParents)
    const pendingVisibleOrder = this._pendingChildOrderParents && Array.from(this._pendingChildOrderParents).some(uid => {
      const parent = this.mindMap.renderer.findNodeByUid(uid)
      return parent && parent.getData && parent.getData('expand') !== false
    })
    if (!reorderedParents.length && !pendingVisibleOrder && !this.viewDeferred && !this._dragViewDeferred) {
      this.renderedVersion = Math.max(Number(this.renderedVersion) || 0,
        Math.min(Number(this._pendingRenderedVersion) || 0, Number(this.lastAppliedVersion) || 0))
    }
    Object.keys(this.waitNodeUidMap).forEach(uid => {
      const node = this.mindMap.renderer.findNodeByUid(uid)
      if (node) {
        this.waitNodeUidMap[uid].forEach(user => node.addUser(user))
      }
    })
    this.waitNodeUidMap = {}
    // 整树重建会换掉节点实例，名单没变也要把编辑头像补回去（只补缺的）。
    ;(this.presenceUsers || []).forEach(item => {
      const uid = item && item.editingUid
      if (!uid) return
      const node = this.mindMap.renderer.findNodeByUid(uid)
      if (!node || !Array.isArray(node.userList)) return
      if (node.userList.some(user => user.id == item.id)) return
      node.addUser({
        id: item.id,
        name: item.name,
        color: item.color,
        avatar: item.avatar,
        editing: true
      })
    })
    if (this._httpTextFlushAfterRender && this.isHttpTextRendererReady()) {
      this._httpTextFlushAfterRender = false
      this.flushHttpText()
    }
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
    this.cancelV2RemoteApply()
    clearTimeout(this.localApplyTimer)
    this.localApplyTimer = null
    this.pendingLocalData = null
    this.isSetData = true
  }

  // 监听思维导图数据的重新设置事件
  onSetData(data) {
    if (this.previewApplied || this.httpCollabMode) {
      if (this.httpCollabMode && (this.isApplyingRemote || this.httpRecovering || !this.currentData)) {
        this.currentData = transformTreeDataToObject(data)
      }
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
    if (config.roomKey) {
      if (this.httpRoomKey !== config.roomKey) {
        invalidateHydrationSession(this)
        this._structuralGuardRevisions = new Map()
        if (this._pendingChildOrderParents) this._pendingChildOrderParents.clear()
        this._dragViewDeferred = false
        this.viewDeferred = false
        this.dirtyUIDSet.clear()
        this.viewStructureDirtyUIDSet.clear()
        this._guardIntentWatch = null
      }
      this.httpRoomKey = config.roomKey
    }
    if (config.fetchSubtree) this.httpFetchSubtree = config.fetchSubtree
    if (config.fetchDeepSubtree) this.httpFetchDeepSubtree = config.fetchDeepSubtree
    if (config.fetchExportTree) this.httpFetchExportTree = config.fetchExportTree
    if (config.fetchNodes) this.httpFetchNodes = config.fetchNodes
    if (config.fetchWriteGuard) this.httpFetchWriteGuard = config.fetchWriteGuard
    if (config.fetchLocate) this.httpFetchLocate = config.fetchLocate
    if (config.patchNode) this.httpPatchNode = config.patchNode
    if (config.addNode) this.httpAddNode = config.addNode
    if (config.flushHistoryVersion) this.httpFlushHistoryVersion = config.flushHistoryVersion
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
    const next = adapter || null
    if (this.collabV2Adapter !== next) this.cancelV2RemoteApply()
    this.collabV2Adapter = next
    if (next && !this.currentData && this.mindMap?.renderer?.renderTree) {
      this.currentData = transformTreeDataToObject(this.mindMap.renderer.renderTree)
    }
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

  getV2RevisionScope() {
    return {
      roomKey: this.httpRoomKey || '',
      adapter: this.collabV2Adapter || null,
      epoch: Number(this._v2RemoteApplyEpoch) || 0
    }
  }

  isV2RevisionScopeCurrent(scope) {
    return !!scope && scope.roomKey === (this.httpRoomKey || '') &&
      scope.adapter === (this.collabV2Adapter || null) &&
      scope.epoch === (Number(this._v2RemoteApplyEpoch) || 0)
  }

  clearV2RevisionCompletions() {
    this._v2RevisionCompletionScope = this.getV2RevisionScope()
    this._v2RevisionCompletions = new Map()
    this._v2RevisionBlockedCompletion = null
  }

  async replayV2AckCompletion(completion, scope, context) {
    if (!completion || completion.kind !== 'ack') return true
    if (!this.isV2RevisionScopeCurrent(scope)) return false
    if (completion.snapshotValid === false) return false

    const renderer = this.mindMap && this.mindMap.renderer
    const meta = {
      applySelf: true,
      fromAck: true,
      originalScope: completion.originalScope,
      capturedIntentEpochs: completion.capturedIntentEpochs || new Map(),
      ackSessionId: completion.ackSessionId,
      deferFallback: true
    }
    for (const event of completion.events || []) {
      if (!this.isV2RevisionScopeCurrent(scope)) return false
      const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(event)
      const uid = normalized.uid
      const patch = normalized.patch || {}
      if (!uid || !Object.keys(patch).length) continue
      const node = renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
      const alreadyEqual = !!(node && typeof node.getData === 'function' &&
        Object.keys(patch).every(key => JSON.stringify(node.getData(key)) === JSON.stringify(patch[key])))
      if (alreadyEqual) continue

      // Replay the ACK's canonical fields after the missing earlier revisions
      // have applied. This stays in the caller's serialized queue task.
      const applied = await this.applyV2RemoteOperationNow(event, meta, context)
      const succeeded = applied === true || !!(applied && typeof applied === 'object' && applied.applied === true)
      if (!succeeded || !this.isV2RevisionScopeCurrent(scope)) return false
    }
    return this.isV2RevisionScopeCurrent(scope)
  }

  // Must be called from the serialized V2 apply/reconcile task. Future ACK
  // records retain only canonical update patches and are replayed before their
  // revision advances the watermark.
  async markV2RevisionComplete(version, scope = this.getV2RevisionScope(), completion = null, context = null) {
    const revision = Number(version)
    if (!Number.isSafeInteger(revision) || revision <= 0 || !this.isV2RevisionScopeCurrent(scope)) return false

    const currentScope = this._v2RevisionCompletionScope
    if (!currentScope || currentScope.roomKey !== scope.roomKey ||
      currentScope.adapter !== scope.adapter || currentScope.epoch !== scope.epoch) {
      this._v2RevisionCompletionScope = { ...scope }
      this._v2RevisionCompletions = new Map()
      this._v2RevisionBlockedCompletion = null
    }
    if (!this._v2RevisionCompletions) this._v2RevisionCompletions = new Map()

    let watermark = Number(this.lastAppliedVersion) || 0
    for (const completed of this._v2RevisionCompletions.keys()) {
      if (completed <= watermark) this._v2RevisionCompletions.delete(completed)
    }
    if (this._v2RevisionBlockedCompletion && this._v2RevisionBlockedCompletion.revision <= watermark) {
      this._v2RevisionBlockedCompletion = null
    }
    const limit = 2000
    let advanced = false
    const record = completion || { kind: 'remote' }
    let currentRecord = null
    if (revision > watermark && revision === watermark + 1) {
      const existing = this._v2RevisionCompletions.get(revision)
      const blocked = this._v2RevisionBlockedCompletion
      const blockedForCurrent = blocked && blocked.revision === revision && blocked.scope &&
        blocked.scope.roomKey === scope.roomKey && blocked.scope.adapter === scope.adapter &&
        blocked.scope.epoch === scope.epoch
      currentRecord = blockedForCurrent
        ? blocked.record
        : (record.kind === 'ack' || !existing ? record : existing)
      if (blockedForCurrent) this._v2RevisionBlockedCompletion = null
      this._v2RevisionCompletions.delete(revision)
    } else if (revision > watermark && !this._v2RevisionCompletions.has(revision) && this._v2RevisionCompletions.size >= limit) {
      v2Trace('revision.completion.overflow', { revision, count: this._v2RevisionCompletions.size })
      if (typeof this.scheduleRemoteRecover === 'function') this.scheduleRemoteRecover(revision)
      return false
    } else if (revision > watermark) {
      const existing = this._v2RevisionCompletions.get(revision)
      // Prefer ACK replay data over a plain remote completion for the same
      // revision, while never replacing one ACK with a weaker record.
      this._v2RevisionCompletions.set(revision,
        record.kind === 'ack' || !existing ? record : existing)
    }

    const renderer = this.mindMap && this.mindMap.renderer
    const applyContext = context || {
      epoch: scope.epoch,
      tree: renderer && renderer.renderTree,
      room: scope.roomKey,
      adapter: scope.adapter,
      revision: watermark
    }
    const complete = async (nextRevision, nextRecord) => {
      if (!this.isV2RevisionScopeCurrent(scope)) return false
      try {
        if (nextRecord && nextRecord.kind === 'ack') {
          const replayed = await this.replayV2AckCompletion(nextRecord, scope, applyContext)
          if (!replayed) {
            if (this.isV2RevisionScopeCurrent(scope) && typeof this.scheduleRemoteRecover === 'function') {
              this.scheduleRemoteRecover(nextRevision)
            }
            return false
          }
        }
      } catch (err) {
        v2Trace('revision.completion.replay-fail', { revision: nextRevision })
        if (this.isV2RevisionScopeCurrent(scope) && typeof this.scheduleRemoteRecover === 'function') {
          this.scheduleRemoteRecover(nextRevision)
        }
        return false
      }
      return this.isV2RevisionScopeCurrent(scope)
    }

    if (currentRecord) {
      if (!await complete(revision, currentRecord)) {
        if (!this.isV2RevisionScopeCurrent(scope)) return false
        if (this._v2RevisionCompletions.size < limit) {
          this._v2RevisionCompletions.set(revision, currentRecord)
        } else {
          // A single blocked head entry is retained separately when the future
          // map is full, keeping memory bounded without discarding its ACK.
          this._v2RevisionBlockedCompletion = { revision, record: currentRecord, scope: { ...scope } }
        }
        return false
      }
      watermark = revision
      advanced = true
    }

    const commitWatermark = () => {
      if (!advanced || !this.isV2RevisionScopeCurrent(scope)) return
      this.lastAppliedVersion = watermark
      this._pendingRenderedVersion = Math.max(Number(this._pendingRenderedVersion) || 0, watermark)
      const view = this.mindMap && this.mindMap.renderer
      if (view && !this.viewDeferred && !this._dragViewDeferred && !view.isRendering &&
        !view.renderTimer && !view.hasWaitRendering && !view._remoteRenderPending &&
        !(view._remoteRenderScheduler && view._remoteRenderScheduler.isPending())) {
        this.renderedVersion = Math.max(Number(this.renderedVersion) || 0, watermark)
      }
      if (this.collabStore) this.collabStore.setLastAppliedVersion(watermark)
      // A remote insert under a collapsed parent can update no layout at all.
      // Its ancestor badges still need the newly committed server totals.
      if (typeof this.refreshCollapsedNodeCounts === 'function') {
        this.refreshCollapsedNodeCounts().catch(() => {})
      }
      advanced = false
    }
    commitWatermark()

    while (true) {
      const nextRevision = watermark + 1
      const blocked = this._v2RevisionBlockedCompletion
      const hasBlocked = blocked && blocked.revision === nextRevision &&
        blocked.scope && blocked.scope.roomKey === scope.roomKey &&
        blocked.scope.adapter === scope.adapter && blocked.scope.epoch === scope.epoch
      const nextRecord = hasBlocked ? blocked.record : this._v2RevisionCompletions.get(nextRevision)
      if (!nextRecord) break
      if (!await complete(nextRevision, nextRecord)) return false
      if (hasBlocked) this._v2RevisionBlockedCompletion = null
      this._v2RevisionCompletions.delete(nextRevision)
      watermark += 1
      advanced = true
      commitWatermark()
    }
    commitWatermark()
    return true
  }

  // On a successful local ACK, reconcile the committed canonical content into
  // the model when a competing remote op may have overwritten the optimistic
  // value. Queue the equality check itself behind prior remote applies; otherwise
  // an optimistic value can look equal before an older queued event overwrites it.
  reconcileAckedLocalOperation(result, capturedIntentEpochs, originalScope, type, payload) {
    const committed = (result && result.operation) || null
    const committedType = (committed && committed.type) || type
    const committedPayload = (committed && committed.payload) || payload || {}
    const committedRev = Number((committed && committed.serverRevision) || (result && result.serverRevision) || 0)
    const clientId = this.collabV2Adapter && this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
    const insertedUids = new Set()
    const collectInserted = (name, body) => {
      if (name === 'node.insert' && body && body.uid) insertedUids.add(String(body.uid))
      if (name === 'node.batch') (body && body.ops || []).forEach(item => collectInserted(item.type, item.payload))
    }
    collectInserted(type, payload)
    const creationEvents = []
    const collectCreationAck = (name, body) => {
      if ((name === 'node.inserted' || name === 'node.insert') && body && insertedUids.has(String(body.uid))) {
        creationEvents.push({ type: 'node.inserted', payload: body })
      }
    }
    if (Array.isArray(committedPayload.events)) {
      committedPayload.events.forEach(item => collectCreationAck(item.type, item.payload))
    } else if (Array.isArray(committedPayload.ops)) {
      committedPayload.ops.forEach(item => collectCreationAck(item.type, item.payload))
    } else {
      collectCreationAck(committedType, committedPayload)
    }
    const ackSessionId = type === 'node.update' && payload && payload.uid
      ? this._pendingEditSessionByFingerprint.get(this.editSessionOperationFingerprint(payload.uid, payload.patch, payload.expected))
      : null
    const isCanonicalUpdate = name => name === 'node.update' || name === 'node.updated'
    const events = []
    if (committedType === 'batch.applied' && Array.isArray(committedPayload.events)) {
      for (const child of committedPayload.events) if (child && isCanonicalUpdate(child.type)) events.push({ event: child, serverRevision: committedRev })
    } else if (Array.isArray(committedPayload.ops)) {
      for (const item of committedPayload.ops) {
        const childType = (item && item.type) || committedType
        if (isCanonicalUpdate(childType)) events.push({ type: childType, payload: (item && item.payload) || item, clientId, serverRevision: committedRev })
      }
    } else if (isCanonicalUpdate(committedType)) {
      events.push({ type: committedType, payload: committedPayload, clientId, serverRevision: committedRev })
    }
    const scope = {
      roomKey: originalScope ? originalScope.roomKey : (this.httpRoomKey || ''),
      adapter: originalScope ? originalScope.adapter : (this.collabV2Adapter || null),
      epoch: originalScope ? Number(originalScope.remoteApplyEpoch) || 0 : (Number(this._v2RemoteApplyEpoch) || 0)
    }
    const meta = { applySelf: true, fromAck: true, originalScope, capturedIntentEpochs: capturedIntentEpochs || new Map(), ackSessionId, deferFallback: true }
    let allSnapshotsValid = true
    const replayEvents = events.map(event => {
      const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(event.event || event)
      let patchSnapshot = {}
      let snapshotValid = true
      try {
        patchSnapshot = JSON.parse(JSON.stringify(normalized.patch || {}))
      } catch (err) {
        snapshotValid = false
        allSnapshotsValid = false
        v2Trace('ack.reconcile.snapshot-fail', {})
      }
      return {
        type: 'node.updated',
        payload: { uid: normalized.uid, patch: patchSnapshot },
        clientId,
        serverRevision: committedRev,
        snapshotValid
      }
    }).filter(event => event.payload.uid && Object.keys(event.payload.patch).length)
    const replayScope = { roomKey: scope.roomKey, adapter: scope.adapter, epoch: scope.epoch }
    const replayIntentEpochs = new Map()
    replayEvents.forEach(event => {
      if (capturedIntentEpochs && capturedIntentEpochs.has(event.payload.uid)) {
        replayIntentEpochs.set(event.payload.uid, capturedIntentEpochs.get(event.payload.uid))
      }
    })
    const completion = {
      kind: 'ack',
      events: replayEvents,
      snapshotValid: allSnapshotsValid,
      originalScope: {
        roomKey: replayScope.roomKey,
        adapter: replayScope.adapter,
        remoteApplyEpoch: replayScope.epoch
      },
      capturedIntentEpochs: replayIntentEpochs,
      ackSessionId
    }
    const task = Promise.resolve(this._v2RemoteApplyQueue).catch(() => {}).then(async () => {
      if (!this.isV2RevisionScopeCurrent(scope)) {
        v2Trace('ack.reconcile.skip-scope-changed', {})
        return false
      }
      creationEvents.forEach(event => this.acknowledgeLocalNodeCreation(event, committedRev))
      const renderer = this.mindMap && this.mindMap.renderer
      const context = {
        epoch: scope.epoch,
        tree: renderer && renderer.renderTree,
        room: scope.roomKey,
        adapter: scope.adapter,
        revision: Number(this.lastAppliedVersion) || 0
      }
      const beginBatch = renderer && renderer.beginRemoteRenderBatch
      const endBatch = renderer && renderer.endRemoteRenderBatch
      if (events.length && typeof beginBatch === 'function') beginBatch.call(renderer)
      try {
        // A non-update optimistic operation has already changed the local model;
        // its ACK still fills the revision only after earlier queued applies finish.
        for (const event of events) {
          if (!this.isV2RevisionScopeCurrent(scope)) return false
          const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(event.event || event)
          const uid = normalized.uid
          const patch = normalized.patch || {}
          if (!uid || !Object.keys(patch).length) continue
          const node = renderer && typeof renderer.findNodeByUid === 'function'
            ? renderer.findNodeByUid(uid)
            : null
          const alreadyEqual = !!(node && typeof node.getData === 'function' &&
            Object.keys(patch).every(key => JSON.stringify(node.getData(key)) === JSON.stringify(patch[key])))
          if (alreadyEqual) continue

          // Call Now directly inside this queue task. Calling the public wrapper
          // here would append behind ourselves and deadlock.
          const applied = await this.applyV2RemoteOperationNow(event, meta, context)
          const succeeded = applied === true || !!(applied && typeof applied === 'object' && applied.applied === true)
          if (!succeeded) {
            return false
          }
        }
        if (!this.isV2RevisionScopeCurrent(scope)) return { reconciled: false, completionRecorded: false }
        const completionRecorded = await this.markV2RevisionComplete(
          committedRev,
          scope,
          completion,
          context
        )
        if (!completionRecorded && (!Number.isSafeInteger(committedRev) || committedRev <= 0) &&
          this.isV2RevisionScopeCurrent(scope) && typeof this.scheduleRemoteRecover === 'function') {
          this.scheduleRemoteRecover(committedRev)
        }
        return { reconciled: true, completionRecorded }
      } finally {
        if (events.length && typeof endBatch === 'function') endBatch.call(renderer)
      }
    }).catch(err => {
      v2Trace('ack.reconcile.fail', { message: err && err.message })
      return { reconciled: false, completionRecorded: false }
    })
    this._v2RemoteApplyQueue = task.catch(() => {})
    return task
  }

  acknowledgeLocalNodeCreation(event, revision) {
    const payload = event && event.payload || {}
    const uid = String(payload.uid || '')
    const data = payload.data
    if (!uid || !data || !this.currentData || !Number.isSafeInteger(revision) || revision <= 0) return
    if (this.isTombstonedUid(uid)) return
    const existing = this.currentData[uid]
    const structureRevision = this._structuralGuardRevisions && this._structuralGuardRevisions.get(uid) || 0
    if (!existing && structureRevision > revision) return
    const versions = readFieldVersions(existing && existing.data)
    if (!existing) {
      this.currentData = applyCollabEvent(this.currentData, event, { allowPartial: true })
    } else {
      // Fill missing creation fields without rewinding any authoritative
      // value. A newer change in another group does not block text editing.
      const mergedVersions = { ...readFieldVersions(data) }
      Object.keys(versions).forEach(group => {
        mergedVersions[group] = Math.max(Number(mergedVersions[group]) || 0, Number(versions[group]) || 0)
      })
      const mergedData = { ...existing.data }
      Object.keys(data).forEach(field => {
        if (field === FV_KEY) return
        const group = editFieldGroup(field)
        const protectedField = ['text', 'note', 'hyperlink'].includes(group)
        if (!Object.prototype.hasOwnProperty.call(mergedData, field) ||
          (protectedField && (Number(versions[group]) || 0) < (Number(mergedVersions[group]) || 0))) {
          mergedData[field] = data[field]
        }
      })
      this.currentData[uid] = {
        ...existing, partial: false,
        data: { ...mergedData, uid, [FV_KEY]: mergedVersions }
      }
    }
    if (structureRevision <= revision) {
      // Optimistic creation has no committed position yet. Reconcile its
      // canonical position without replaying an old insert after a later move.
      const siblingPositions = Object.fromEntries(Object.entries(payload.siblingPositions || {}).filter(([id]) =>
        !this._structuralGuardRevisions || (this._structuralGuardRevisions.get(String(id)) || 0) <= revision
      ))
      this.currentData = applyCollabEvent(this.currentData, {
        ...event, payload: { ...payload, siblingPositions }
      }, { allowPartial: true })
      if (!this._structuralGuardRevisions) this._structuralGuardRevisions = new Map()
      ;[uid, ...Object.keys(siblingPositions)].forEach(id => {
        this._structuralGuardRevisions.set(String(id), Math.max(this._structuralGuardRevisions.get(String(id)) || 0, revision))
      })
    }
    // A later sibling insert may already have superseded this creation's
    // position. Project that latest authority even when the older position
    // itself must be ignored.
    const parentUid = payloadParentUid(payload)
    if (!this._pendingChildOrderParents) this._pendingChildOrderParents = new Set()
    this._pendingChildOrderParents.add(parentUid)
    if (this.projectCanonicalChildOrder(parentUid)) this.requestRemoteApplyRender([uid, parentUid])
    const snapshot = this.getEditSessionSnapshot(uid)
    this.editSessionManager.list().forEach(session => {
      if (session.uid !== uid || (session.roomKey && session.roomKey !== this.httpRoomKey)) return
      if (!snapshot || !session.fields.every(field =>
        (Number(snapshot.fieldVersions[editFieldGroup(field)]) || 0) ===
          (Number(readFieldVersions(data)[editFieldGroup(field)]) || 0) &&
        stableFieldValue(snapshot.data[field]) === stableFieldValue(data[field])
      )) return
      let initialValues = data
      // The existing insert transport can return plain text plus this explicit
      // reset marker for an initially rich node. Match only that known creation
      // normalization; neither the draft nor arbitrary remote HTML is rebased.
      if (data.resetRichText === true && data.richText === true &&
        session.baseValues.richText === true &&
        typeof session.baseValues.text === 'string' &&
        getTextFromHtml(session.baseValues.text) === data.text) {
        initialValues = { ...data, text: session.baseValues.text }
      }
      const initialized = this.editSessionManager.acknowledgeCreation(session.id, {
        uid, data, fieldVersions: readFieldVersions(data)
      }, revision, initialValues)
      if (initialized) this.mindMap.emit('edit_session_draft_change', initialized)
    })
  }

  submitV2(type, payload) {
    if (!this.collabV2Adapter) {
      return Promise.reject(new Error('collab v2 adapter missing'))
    }
    payload = this.guardWritePayload(type, payload)
    if (type === 'map.replace') {
      payload = collabSpecialObjects.buildMapReplacePayload(
        payload && payload.tree,
        payload || {}
      )
    }
    if (type === 'node.update' && payload) {
      const guardedFields = Object.keys(payload.patch || {}).filter(field =>
        ['text', 'richText', 'note', 'hyperlink', 'hyperlinkTitle'].includes(field)
      )
      if (payload.uid && guardedFields.length) {
        payload = {
          ...payload,
          expected: {
            ...this.expectedFieldVersions(payload.uid, guardedFields),
            ...(payload.expected || {}),
            uid: payload.expected && payload.expected.uid
              ? payload.expected.uid
              : String(payload.uid)
          }
        }
      }
      const guarded = collabNodeFeatures.guardFeatureStructuralMutation(payload)
      if (guarded.hit.length) {
        v2Trace('NODE_FEATURE_STRUCTURAL_MUTATION', {
          uid: payload.uid,
          keys: guarded.hit
        })
        v2Trace('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', {
          uid: payload.uid,
          keys: guarded.hit
        })
        payload = guarded.payload
      }
    }
    try {
      collabSpecialObjects.assertStructuredCloneSafeOperation({
        type,
        payload
      })
    } catch (err) {
      v2Trace('OUTBOX_NON_CLONEABLE_PAYLOAD', {
        type,
        paths: err && err.paths
      })
      throw err
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
    // Capture the local intent epoch at submit time. On ACK, canonical content
    // is reconciled only for UIDs whose intent epoch has not advanced since.
    const capturedIntentEpochs = new Map(uids.map(uid => [uid, this.localIntentEpochOf(uid)]))
    const originalScope = { roomKey: this.httpRoomKey, adapter: this.collabV2Adapter, remoteApplyEpoch: this._v2RemoteApplyEpoch || 0 }
    collabTrace('2.adapter.submit', {
      traceId,
      type,
      roomKey: this.httpRoomKey,
      uids,
      clientId: this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
    })
    const clientId =
      this.collabV2Adapter.getClientId && this.collabV2Adapter.getClientId()
    const submitted = this.collabV2Adapter
      .submitOperation({
        type,
        payload,
        roomKey: this.httpRoomKey,
        clientId,
        traceId
      })
      .then(async result => {
        this.submittedVersion = Math.max(Number(this.submittedVersion) || 0, Number(result && result.serverRevision) || 0)
        this.acknowledgeLocalVersion(result && result.serverRevision, {
          operationId: result && result.opId,
          duplicate: !!(result && result.duplicate),
          deferV2Watermark: true
        })
        this.markAckedFromPayload(type, payload)
        const reconciled = await this.reconcileAckedLocalOperation(result, capturedIntentEpochs, originalScope, type, payload)
        if (!reconciled || !reconciled.reconciled) {
          const scope = {
            roomKey: originalScope.roomKey,
            adapter: originalScope.adapter,
            epoch: originalScope.remoteApplyEpoch
          }
          if (this.isV2RevisionScopeCurrent(scope)) {
            this.scheduleRemoteRecover(result && result.serverRevision)
          }
        }
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
    if (['node.move', 'node.reorder', 'node.delete', 'node.batch'].includes(type)) {
      this._latestStructuralWrite = submitted
    }
    return submitted
  }

  cancelV2RemoteApply() {
    this._v2RemoteApplyEpoch = (this._v2RemoteApplyEpoch || 0) + 1
    this.clearV2RevisionCompletions()
    Array.from(this._v2RendererWaiters || []).forEach(cancel => cancel(false))
  }

  isV2RemoteApplyScopeCurrent(context) {
    const mm = this.mindMap
    return !this._disposed && mm && !mm._destroyed && mm.renderer &&
      context.room === (this.httpRoomKey || '') && context.adapter === (this.collabV2Adapter || null)
  }

  isV2RemoteApplyCurrent(context) {
    return this.isV2RemoteApplyScopeCurrent(context) &&
      context.epoch === (this._v2RemoteApplyEpoch || 0) &&
      context.tree === this.mindMap.renderer.renderTree
  }

  rebaseV2RemoteApplyContext(context) {
    if (!this.isV2RemoteApplyScopeCurrent(context)) return false
    context.epoch = this._v2RemoteApplyEpoch || 0
    context.tree = this.mindMap.renderer.renderTree
    return true
  }

  waitV2RendererReady(context) {
    if (!this.isV2RemoteApplyCurrent(context)) return Promise.resolve(false)
    const mm = this.mindMap, renderer = mm.renderer
    const ready = () => renderer.root && !renderer.isRendering &&
      !renderer.renderTimer && !renderer.hasWaitRendering &&
      renderer.root.nodeData === renderer.renderTree
    if (ready()) return Promise.resolve(true)
    return new Promise(resolve => {
      const finish = value => {
        mm.off('node_tree_render_end', onEnd)
        this._v2RendererWaiters.delete(finish)
        resolve(value)
      }
      const onEnd = info => {
        if (!this.isV2RemoteApplyCurrent(context)) return finish(false)
        if (info && (info.reason === 'view' || info.reason === 'export')) return
        if (ready()) finish(true)
      }
      if (!this._v2RendererWaiters) this._v2RendererWaiters = new Set()
      this._v2RendererWaiters.add(finish)
      mm.on('node_tree_render_end', onEnd)
      // A renderer pass may legitimately exceed a network ACK timeout. Keep
      // the operation pending until its actual model is ready or its editor
      // scope is cancelled; rejecting here permanently discards the last op.
    })
  }

  async applyV2RemoteOperation(op, meta = {}) {
    const renderer = this.mindMap && this.mindMap.renderer
    const adapter = this.collabV2Adapter || null
    const context = { epoch: this._v2RemoteApplyEpoch || 0,
      tree: renderer && renderer.renderTree, room: this.httpRoomKey || '', adapter,
      revision: Number(this.lastAppliedVersion) || 0 }
    // Serialize all entry calls, including ones that arrive after a layout-end
    // but before an older renderer waiter resumes. Never let newer text rewind.
    const task = Promise.resolve(this._v2RemoteApplyQueue).catch(() => {})
      .then(async () => {
        const beginBatch = renderer && renderer.beginRemoteRenderBatch
        const endBatch = renderer && renderer.endRemoteRenderBatch
        if (typeof beginBatch === 'function') beginBatch.call(renderer)
        try {
          const applied = await this.applyV2RemoteOperationNow(op, meta, context)
          const event = (op && op.event) || op || {}
          const version = Number(op && (op.serverRevision || op.version) || event.version)
          const succeeded = applied === true || !!(applied && typeof applied === 'object' && applied.applied === true)
          if (succeeded && Number.isSafeInteger(version) && version > 0 && this.isV2RemoteApplyCurrent(context)) {
            await this.markV2RevisionComplete(version, {
              roomKey: context.room,
              adapter: context.adapter,
              epoch: context.epoch
            }, null, context)
          }
          return applied
        } finally {
          if (typeof endBatch === 'function') endBatch.call(renderer)
        }
      })
    this._v2RemoteApplyQueue = task.catch(() => {})
    return task
  }

  async applyV2RemoteOperationNow(op, meta = {}, context) {
    let event = (op && op.event) || op || {}
    const type = event.type || op.type
    let payload = event.payload || op.payload || {}
    const opRevision = Number(op.serverRevision || event.version || op.version) || 0
    if (!this.rebaseV2RemoteApplyContext(context)) return false
    if (type && (type.startsWith('node.') || type.startsWith('operation.'))) {
      // setData/updateData can replace the local tree without advancing the
      // server head. Rebind the queued op to that same room's current model;
      // returning false would still let the adapter acknowledge an unapplied op.
      while (true) {
        if (!this.rebaseV2RemoteApplyContext(context)) return false
        if (await this.waitV2RendererReady(context)) {
          if (this.isV2RemoteApplyCurrent(context)) break
        }
      }
      const currentRevision = Number(this.lastAppliedVersion) || 0
      const revision = opRevision
      if (!meta.forceViewProjection && revision && meta.fromOutbox && currentRevision > revision) {
        v2Trace('remote.skip-authoritative-progress', { type, revision, currentRevision, source: 'applied-watermark' })
        return false
      }
      if (!meta.forceViewProjection && revision && !meta.applySelf && currentRevision >= revision) {
        v2Trace('remote.skip-applied-revision', { type, revision, currentRevision })
        return true
      }
      const intentUid = (payload && payload.uid) || (event && event.payload && event.payload.uid) || ''
      if (meta.originalScope && (
        meta.originalScope.adapter !== this.collabV2Adapter ||
        meta.originalScope.roomKey !== this.httpRoomKey ||
        meta.originalScope.remoteApplyEpoch !== (this._v2RemoteApplyEpoch || 0)
      )) {
        // The ACK belongs to an older room/adapter/apply epoch; never reconcile
        // it into a different current room sharing the same UID.
        v2Trace('ack.reconcile.skip-scope-changed', { uid: intentUid })
        return true
      }
      if (meta.fromAck && meta.applySelf && intentUid && meta.capturedIntentEpochs) {
        const captured = meta.capturedIntentEpochs.get ? (meta.capturedIntentEpochs.get(intentUid) || 0) : 0
        // A field edit owns an independent draft. Its exact successful ACK
        // must update authority even if display normalization emitted a local
        // command meanwhile. The session completion retains any newer draft;
        // ordinary command ACKs still use the newer-intent protection.
        const savingSession = meta.ackSessionId && this.editSessionManager &&
          this.editSessionManager.get(meta.ackSessionId)
        const ownsFieldDraft = savingSession && savingSession.uid === String(intentUid) &&
          (!savingSession.roomKey || savingSession.roomKey === this.httpRoomKey)
        if (this.localIntentEpochOf(intentUid) > captured && !ownsFieldDraft) {
          v2Trace('ack.reconcile.skip-newer-intent', { uid: intentUid, captured, current: this.localIntentEpochOf(intentUid) })
          return true
        }
        const uidRev = this._authoritativeRevByUid ? (this._authoritativeRevByUid.get(intentUid) || 0) : 0
        if (revision && uidRev > revision) {
          v2Trace('ack.reconcile.skip-uid-authoritative', { uid: intentUid, revision, uidRev })
          return true
        }
      }
    }
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
      return this.applyV2RemoteBatchEvents(op, meta, payload.events, context)
    }
    if (type === 'map.updated') {
      this.applyRemoteMapMeta(payload)
      return true
    }
    if (type === 'map.replaced' || payload.resnapshot) {
      this.observeGuardedIntentEvent(type, payload, opRevision)
      if (this._v2UndoActive && !this._v2UndoAllowReplace) {
        this._undoFullTreeHits = Number(this._undoFullTreeHits || 0) + 1
        undoFullTreeForbidden('applyV2RemoteOperation.map.replaced')
        return false
      }
      if (this._v2MoveActive && !this._v2MoveAllowReplace) {
        this.markMoveFullTreeForbidden('applyV2RemoteOperation.map.replaced')
        return false
      }
      const reason = payload.reason || payload.fullTreeReason || ''
      return this.recoverHttpCollab(
        op.serverRevision || this.lastAppliedVersion,
        reason ? { reason } : {}
      )
    }
    const uid = payload.uid
    const renderer = this.mindMap && this.mindMap.renderer
    const previousNode = uid && renderer && renderer.findNodeByUid(uid)
    this.observeGuardedIntentEvent(type, payload, opRevision)
    if (/^node\.(insert|inserted|move|moved|reorder|reordered|delete|deleted|restore|restored)$/.test(type)) {
      if (!this._structuralGuardRevisions) this._structuralGuardRevisions = new Map()
      ;[uid, ...(payload.deletedUids || payload.removed || []), ...Object.keys(payload.siblingPositions || {})]
        .filter(Boolean).forEach(id => this._structuralGuardRevisions.set(String(id), opRevision))
    }
    if (this.currentData && type && type !== 'map.replaced' && !meta.skipAuthority) {
      try {
        const canonicalType = { 'node.insert': 'node.inserted', 'node.update': 'node.updated',
          'node.move': 'node.moved', 'node.reorder': 'node.reordered', 'node.delete': 'node.deleted', 'node.restore': 'node.restored' }[type] || type
        let authorityEvent = { ...event, type: canonicalType }
        if (type === 'node.updated' || type === 'node.update') {
          const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(op)
          const previous = this.currentData[normalized.uid]
          const previousFv = readFieldVersions(previous && previous.data)
          const incomingPatch = normalized.patch || {}
          if (Object.prototype.hasOwnProperty.call(incomingPatch, FV_KEY)) {
            const nextFv = {
              ...previousFv,
              ...readFieldVersions(incomingPatch)
            }
            const mergedPatch = { ...incomingPatch, [FV_KEY]: nextFv }
            authorityEvent = {
              ...authorityEvent,
              payload: {
                ...payload,
                uid: normalized.uid,
                patch: mergedPatch
              }
            }
            event = authorityEvent
            payload = authorityEvent.payload
          }
        }
        this.currentData = applyCollabEvent(this.currentData, authorityEvent, {
          liveFieldUpdate: true, allowPartial: true
        })
        if (canonicalType === 'node.deleted') {
          // Keep the deletion revision even after a later restore clears its
          // tombstone. An older successful edit ACK must never recreate a
          // removed entry or overwrite the restored incarnation of that UID.
          ;[uid, ...(payload.deletedUids || payload.removed || [])]
            .filter(Boolean)
            .forEach(id => this.bumpAuthoritativeUidRev(String(id), opRevision))
        }
        if (uid) {
          this.editSessionManager.list().forEach(session => {
            if (session.uid !== String(uid) || session.state !== 'editing') return
            // This exact session is waiting for its own successful commit.
            // Its completion code resolves it or preserves a newer draft.
            if (meta.fromAck && meta.ackSessionId === session.id) return
            const validation = this.editSessionManager.validate(
              session.id,
              this.getEditSessionSnapshot(uid)
            )
            if (!validation.ok) {
              this.retainEditSessionConflict(session.id, {
                error: Object.assign(new Error('编辑期间收到同字段远端修改'), {
                  code: 'REPLACE_CONFLICT',
                  status: 409
                }),
                validation,
                latestSnapshot: validation.latestSnapshot
              })
            }
          })
        }
      } catch (err) {
        v2Trace('remote.currentData.fail', { type, uid, message: err && err.message })
        return false
      }
    }
    if (
      this._dragViewDeferred &&
      !meta.forceViewProjection &&
      type &&
      (type.startsWith('node.') || type.startsWith('operation.'))
    ) {
      this.viewDeferred = true
      ;[uid, payloadParentUid(payload)].filter(Boolean).forEach(id => this.dirtyUIDSet.add(String(id)))
      if (/^(node\.(insert|inserted|move|moved|reorder|reordered|delete|deleted|restore|restored))$/.test(type)) {
        ;[uid, payloadParentUid(payload), payload.fromParentUid, payload.oldParentUid]
          .filter(Boolean)
          .forEach(id => this.viewStructureDirtyUIDSet.add(String(id)))
        ;(payload.deletedUids || payload.removed || []).forEach(id => this.viewStructureDirtyUIDSet.add(String(id)))
      }
      v2Trace('remote.defer-view-during-drag', { type, uid, revision: opRevision })
      return true
    }
    if (type === 'node.inserted' || type === 'node.insert') {
      const inserted = this.applyV2PayloadInsert(payload)
      v2Trace('remote.apply.insert', { uid, ok: inserted })
      if (inserted) {
        this.notifyV2ContentChange('insert', payload, previousNode)
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
        this.notifyV2ContentChange('move', payload, previousNode)
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'node.deleted' || type === 'node.delete') {
      const removed = this.applyV2PayloadDelete(payload)
      v2Trace('remote.apply.delete', { uid, ok: removed })
      if (removed) {
        this.notifyV2ContentChange('delete', payload, previousNode)
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'node.restored' || type === 'node.restore') {
      const restored = this.applyV2PayloadRestore(payload)
      v2Trace('remote.apply.restore', {
        uid,
        ok: restored,
        rows: Array.isArray(payload.rows) ? payload.rows.length : 0
      })
      if (restored) {
        this.notifyV2ContentChange('restore', payload, previousNode)
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback) return false
    } else if (type === 'node.updated' || type === 'node.update') {
      const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(op)
      const updated = this.applyV2PayloadUpdate(
        normalized.uid
          ? { uid: normalized.uid, patch: normalized.patch }
          : payload
      )
      v2Trace('remote.apply.update', {
        uid: normalized.uid || uid,
        ok: updated,
        keys: Object.keys(normalized.patch || {})
      })
      if (updated) {
        this.bumpAuthoritativeUidRev(normalized.uid || uid, opRevision)
        this.notifyV2ContentChange('update', { ...payload, uid: normalized.uid || uid }, previousNode)
        this.notifySearchInvalidate()
        return true
      }
      if (meta.deferFallback && normalized.uid && renderer && renderer.renderTree) {
        const pendingNode = this.findTreeNode(renderer.renderTree, normalized.uid)
        if (pendingNode && pendingNode.data) {
          Object.assign(pendingNode.data, normalized.patch || {})
          this.notifySearchInvalidate()
          return true
        }
      }
      if (meta.deferFallback) return false
    } else if (
      type === 'operation.undone' ||
      type === 'operation.redone' ||
      type === 'operation.undo' ||
      type === 'operation.redo'
    ) {
      const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(op)
      if (normalized.uid && Object.keys(normalized.patch || {}).length) {
        const updated = this.applyV2PayloadUpdate({
          uid: normalized.uid,
          patch: normalized.patch
        })
        collabNodeFeatures.publishUndoApplyTrace({
          undoOpId: op && (op.opId || op.operationId),
          targetOpId:
            (payload && (payload.targetOperationId || payload.undoOf || payload.redoOf)) ||
            '',
          targetUid: normalized.uid,
          inversePatch: normalized.patch,
          serverAppliedEvent: (op && op.event && op.event.type) || type,
          originNodeDataAfter: !!meta.applySelf,
          remoteNodeDataAfter: !meta.applySelf,
          rendererRefreshed: !!updated
        })
        if (updated) {
          this.notifyV2ContentChange('update', { ...payload, uid: normalized.uid }, previousNode)
          this.notifySearchInvalidate()
          return true
        }
      }
      const inner = payload.inverse || payload.forward || (op && op.inversePayload)
      if (inner && inner.type) {
        const applied = await this.applyV2RemoteOperationNow({
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
                        : inner.type === 'node.restore'
                          ? 'node.restored'
                          : inner.type,
            payload: inner.payload || {}
          },
          serverRevision: op.serverRevision
        }, meta, context)
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
        this.notifyV2ContentChange('update', payload, previousNode)
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
    if (this.deferUnloadedRemote(type, uid, parentUid)) {
      this.notifySearchInvalidate()
      return true
    }
    v2Trace('remote.apply.fallback-hydrate', { type, uid, parentUid })
    const applied = this.syncHttpRemoteOperations([op])
    this.notifySearchInvalidate()
    return applied
  }

  async applyV2RemoteBatchEvents(op, meta = {}, events = [], context) {
    const deferred = []
    for (let index = 0; index < events.length; index += 1) {
      const child = events[index]
      const childOp = { event: child, serverRevision: op.serverRevision }
      const applied = await this.applyV2RemoteOperationNow(childOp, {
        ...meta,
        deferFallback: true
      }, context)
      if (applied) continue
      if (this.deferUnloadedRemoteEvents([child])) {
        deferred.push(child)
        continue
      }
      const unresolved = events.slice(index)
      unresolved.forEach(event => {
        const childPayload = (event && event.payload) || {}
        this.markRemoteDirty(childPayload.uid, payloadParentUid(childPayload))
      })
      v2Trace('remote.apply.batch.reconcile', {
        failedAt: index,
        remaining: unresolved.length
      })
      return this.syncHttpRemoteOperations(
        unresolved.map(event => ({ event, serverRevision: op.serverRevision }))
      )
    }
    if (deferred.length) v2Trace('remote.apply.batch.defer', { count: deferred.length })
    return true
  }

  remoteTargetRendered(uid) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!uid || !renderer || typeof renderer.findNodeByUid !== 'function') return false
    return !!renderer.findNodeByUid(uid)
  }

  markRemoteDirty(uid, parentUid) {
    if (this.httpLocateFailures) {
      if (uid) this.httpLocateFailures.delete(uid)
      if (parentUid) this.httpLocateFailures.delete(parentUid)
    }
    if (!this.dirtySubtrees) return
    if (parentUid) this.dirtySubtrees.set(parentUid, Date.now())
    if (uid) this.dirtySubtrees.set(uid, Date.now())
  }

  unloadedRemoteAnchor(type, uid, parentUid) {
    const name = String(type || '')
    if (/insert|move|reorder/.test(name)) return parentUid || uid
    return uid || parentUid
  }

  deferUnloadedRemote(type, uid, parentUid) {
    const anchor = this.unloadedRemoteAnchor(type, uid, parentUid)
    if (!anchor) return false
    const renderer = this.mindMap && this.mindMap.renderer
    const node =
      renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(anchor)
        : null
    const collapsed =
      node &&
      node.getData &&
      node.getData('expand') === false &&
      /insert|move|reorder/.test(String(type || ''))
    if (node && !collapsed) return false
    this.markRemoteDirty(uid, parentUid)
    v2Trace('remote.apply.defer-unloaded', { type, uid, parentUid, collapsed: !!collapsed })
    return true
  }

  deferUnloadedRemoteEvents(events) {
    const list = Array.isArray(events) ? events : []
    if (!list.length) return false
    const unloaded = list.every(child => {
      const payload = (child && child.payload) || {}
      const parent = payload.parentUid || payload.parent_uid || payload.parent
      return !this.remoteTargetRendered(
        this.unloadedRemoteAnchor(child && child.type, payload.uid, parent)
      )
    })
    if (!unloaded) return false
    list.forEach(child => {
      const payload = (child && child.payload) || {}
      this.markRemoteDirty(
        payload.uid,
        payload.parentUid || payload.parent_uid || payload.parent
      )
    })
    return true
  }

  notifyV2ContentChange(type, payload, previousNode) {
    const command = this.mindMap && this.mindMap.command
    const renderer = this.mindMap && this.mindMap.renderer
    if (!command || !command.recordContentChange || !renderer || this._disposed) return
    const notify = () => {
      if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return
      const uid = payload.uid
      const node = uid && renderer.findNodeByUid(uid)
      const change = { source: 'remote' }
      if (type === 'delete') change.removed = previousNode ? [previousNode] : []
      else if (type === 'insert') change.added = node ? [node] : []
      else if (type === 'restore') {
        change.added = (payload.rows || []).map(row => renderer.findNodeByUid(row.uid)).filter(Boolean)
        if (!change.added.length && node) change.added = [node]
      } else change.nodes = node ? [node] : []
      command.recordContentChange(change)
      command.flushContentChange()
    }
    if ((type === 'insert' || type === 'restore') && (renderer.isRendering || !(payload.uid && renderer.findNodeByUid(payload.uid)))) {
      const done = info => {
        if (info && (info.reason === 'view' || info.reason === 'export')) return
        this.mindMap.off('node_tree_render_end', done)
        notify()
      }
      this.mindMap.on('node_tree_render_end', done)
    } else notify()
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

  requestRemoteApplyRender(uids, callback, source = 'remote apply') {
    const renderer = this.mindMap && this.mindMap.renderer
    if (renderer && typeof renderer.requestRemoteRender === 'function') {
      renderer.requestRemoteRender(uids, callback, source)
      return
    }
    if (this.mindMap && typeof this.mindMap.render === 'function') {
      this.mindMap.render(callback, source)
      return
    }
    if (typeof callback === 'function') callback()
  }

  projectCanonicalChildOrder(parentUid) {
    const entry = this.currentData && this.currentData[parentUid]
    if (!entry || !Array.isArray(entry.children)) {
      if (this._pendingChildOrderParents) this._pendingChildOrderParents.delete(parentUid)
      return false
    }
    if (this._dragViewDeferred) {
      this.viewDeferred = true
      this.dirtyUIDSet.add(String(parentUid))
      this.viewStructureDirtyUIDSet.add(String(parentUid))
      return false
    }
    const renderer = this.mindMap && this.mindMap.renderer
    const parent = renderer && renderer.findNodeByUid && renderer.findNodeByUid(parentUid)
    const children = parent && parent.nodeData && parent.nodeData.children
    if (!Array.isArray(children)) return false
    const canonical = new Set(entry.children.map(String))
    // 懒加载补入画布的旧节点可能还没有合并进 currentData.children。
    // 此时按缓存中的少数新节点排序，会把新节点排到全部旧节点前面。
    // 保留命令/服务端 index 已确定的顺序，等缓存完整后再投影。
    const missingCommittedChild = children.some(node => {
      const uid = String(node && node.data && node.data.uid || '')
      return uid && !canonical.has(uid) && this.isPersistAcked(uid) &&
        !this.isTombstonedUid(uid)
    })
    if (missingCommittedChild) {
      if (!this._pendingChildOrderParents) this._pendingChildOrderParents = new Set()
      this._pendingChildOrderParents.add(parentUid)
      return false
    }
    const loaded = new Set(children.map(node => String(node && node.data && node.data.uid || '')))
    if (entry.children.every(uid => loaded.has(String(uid))) && this._pendingChildOrderParents) {
      this._pendingChildOrderParents.delete(parentUid)
    }
    const ranks = new Map(entry.children.map((uid, index) => [String(uid), index]))
    const ordered = children.map((node, index) => {
      const uid = String(node && node.data && node.data.uid || '')
      const canonical = this.currentData[uid]
      if (canonical && canonical.position != null && node && node.data) {
        node.data.position = canonical.position
      }
      return { node, index, rank: ranks.has(uid) ? ranks.get(uid) : Infinity }
    }).sort((a, b) => a.rank - b.rank || a.index - b.index)
    if (!ordered.some((item, index) => item.node !== children[index])) return false
    // Keep optimistic children and the existing node/data objects, including
    // any open editor; only project the committed sibling order.
    children.splice(0, children.length, ...ordered.map(item => item.node))
    return true
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
    if (renderer.findNodeByUid(uid)) {
      if (this.projectCanonicalChildOrder(parentUid)) this.requestRemoteApplyRender([uid, parentUid])
      return true
    }
    const parentNode = renderer.findNodeByUid(parentUid)
    if (!parentNode) return false
    if (parentNode.getData && parentNode.getData('expand') === false) {
      const count = Number(parentNode.getData('childCount')) || 0
      const live = (parentNode.nodeData && parentNode.nodeData.children || []).length
      renderer.setNodeData(parentNode, { childCount: Math.max(count, live) + 1 })
      this.markRemoteDirty(uid, parentUid)
      if (typeof parentNode.reRender === 'function') parentNode.reRender()
      return true
    }
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
            ...data,
            uid,
            expand: false
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
        childCount: Math.max(count, live)
      })
      this.projectCanonicalChildOrder(parentUid)
      this.requestRemoteApplyRender([uid, parentUid])
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
      detachNodeFromParent(node)
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
    if (Array.isArray(nextParent.children)) {
      nextParent.children = nextParent.children.filter(item => item !== node)
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
      if (this.mindMap.renderer) {
        // Multi-node batch moves must paint synchronously. Async performance
        // paint from an earlier move can redraw connectors using a parent's
        // stale children list and leave ghost lines until refresh.
        this.mindMap.renderer._syncPaintOnce = true
      }
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
        if (typeof renderer.resetMovedNodePosition === 'function') {
          renderer.resetMovedNodePosition(node)
        }
        this.requestRemoteApplyRender([uid, parentUid])
      }
      // Move events can carry restored coordinates when undoing a move.
      const positionData = { ...(payload.data || {}), ...(payload.patch || {}) }
      const positionPatch = {}
      ;['customLeft', 'customTop', 'isFloating'].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(positionData, key)) {
          positionPatch[key] = positionData[key]
          node[key] = positionData[key] == null ? undefined : positionData[key]
        }
      })
      if (Object.keys(positionPatch).length) node.setData(positionPatch)
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
      const finishMovePaint = () => {
        // Rendering may replace both parent instances. Repainting a detached
        // instance recreates its old connectors in the shared SVG line layer.
        const liveRenderer = this.mindMap && this.mindMap.renderer
        const parentUids = new Set([
          oldParentUid,
          parentUid || (nextParent.getData && nextParent.getData('uid'))
        ])
        parentUids.forEach(parentId => {
          const liveParent =
            parentId && liveRenderer && liveRenderer.findNodeByUid(parentId)
          if (liveParent && typeof liveParent.renderLine === 'function') {
            liveParent.renderLine(true)
          }
        })
        this.restoreActiveUids(activeUids)
      }
      if (typeof this.mindMap.render === 'function') {
        this.requestRemoteApplyRender(
          [uid, oldParentUid, parentUid || (nextParent.getData && nextParent.getData('uid'))],
          finishMovePaint
        )
      } else {
        finishMovePaint()
      }
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
    const parentUid = payloadParentUid(payload)
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
      Array.isArray(payload.deletedUids) && payload.deletedUids.length
        ? payload.deletedUids.filter(Boolean)
        : Array.isArray(payload.removed) && payload.removed.length
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
      const assoc = this.mindMap && this.mindMap.associativeLine
      if (assoc && typeof assoc.removeAllLines === 'function') {
        assoc.removeAllLines()
      }
      this.requestRemoteApplyRender([uid, parentUid, ...removed])
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

  applyV2PayloadRestore(payload = {}) {
    const uid = payload.uid
    const renderer = this.mindMap && this.mindMap.renderer
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    if (!uid || !renderer) return false
    const reviveIds = rows.map(row => row && row.uid).filter(Boolean)
    if (!reviveIds.includes(uid)) reviveIds.push(uid)
    reviveIds.forEach(id => this.reviveDeletedUid(id))
    const missing = reviveIds.filter(id => {
      const live =
        typeof renderer.findNodeByUid === 'function' && renderer.findNodeByUid(id)
      return !live
    })
    if (!missing.length) {
      this.postRestoreDecorations(reviveIds)
      return true
    }
    const parentUid = payloadParentUid(payload)
    const parentNode =
      (parentUid &&
        typeof renderer.findNodeByUid === 'function' &&
        renderer.findNodeByUid(parentUid)) ||
      null
    if (!parentNode || !parentNode.nodeData) return false
    const tree = collabDelete.buildSubtreeFromRows(rows, uid)
    if (!tree) return false
    this.isApplyingRemote = true
    this.mindMap.command.pause()
    try {
      if (!parentNode.nodeData.children) parentNode.nodeData.children = []
      const exists = parentNode.nodeData.children.some(
        child => child && child.data && child.data.uid === uid
      )
      if (!exists) {
        const index = Number(payload.index)
        if (Number.isInteger(index) && index >= 0 && index <= parentNode.nodeData.children.length) {
          parentNode.nodeData.children.splice(index, 0, tree)
        } else {
          parentNode.nodeData.children.push(tree)
        }
      }
      renderer.setNodeData(parentNode, { expand: true })
      this.requestRemoteApplyRender([uid, parentUid, ...reviveIds])
    } catch (err) {
      v2Trace('remote.apply.restore.err', { uid, message: err && err.message })
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
    this.postRestoreDecorations(reviveIds)
    return true
  }

  postRestoreDecorations(restoredUidSet) {
    const ids = Array.isArray(restoredUidSet)
      ? restoredUidSet
      : Array.from(restoredUidSet || [])
    const renderer = this.mindMap && this.mindMap.renderer
    const run = () => {
      ids.forEach(id => {
        const node =
          renderer &&
          typeof renderer.findNodeByUid === 'function' &&
          renderer.findNodeByUid(id)
        if (!node) return
        if (typeof node.updateGeneralization === 'function') {
          node.updateGeneralization()
        }
        if (typeof node.renderGeneralization === 'function') {
          node.renderGeneralization(true)
        }
        if (node.parent && typeof node.parent.updateGeneralization === 'function') {
          node.parent.updateGeneralization()
          if (typeof node.parent.renderGeneralization === 'function') {
            node.parent.renderGeneralization(true)
          }
        }
      })
      const assoc = this.mindMap && this.mindMap.associativeLine
      if (assoc && typeof assoc.renderAllLines === 'function') {
        assoc.renderAllLines()
      }
      const frame = this.mindMap && this.mindMap.outerFrame
      if (frame && typeof frame.renderOuterFrames === 'function') {
        frame.renderOuterFrames()
      } else if (frame && typeof frame.render === 'function') {
        frame.render()
      }
    }
    if (this.mindMap && typeof this.mindMap.render === 'function') {
      this.requestRemoteApplyRender(ids, run)
    } else {
      run()
    }
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
    const structuralHit = collabNodeFeatures.featureStructuralHits(payload)
    if (structuralHit.length) {
      v2Trace('NODE_FEATURE_STRUCTURAL_MUTATION', {
        uid,
        keys: structuralHit
      })
      v2Trace('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', {
        uid,
        keys: structuralHit
      })
    }
    const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload({
      payload,
      event: { payload }
    })
    let next =
      normalized.patch && Object.keys(normalized.patch).length
        ? normalized.patch
        : collabNodeFeatures.payloadFeaturePatch(payload)
    if (
      !Object.keys(next || {}).length &&
      payload &&
      !Object.prototype.hasOwnProperty.call(payload, 'patch')
    ) {
      next = payloadNodeData(payload)
    }
    const stripped = collabNodeFeatures.stripFeatureStructuralKeys(next)
    next = stripped.payload
    const previousVersions = readFieldVersions(node.getData && node.getData())
    const incomingVersions = readFieldVersions(next)
    if (Object.keys(incomingVersions).length) {
      const mergedVersions = { ...previousVersions }
      Object.keys(incomingVersions).forEach(group => {
        mergedVersions[group] = Math.max(
          Number(mergedVersions[group] || 0),
          Number(incomingVersions[group] || 0)
        )
      })
      next = { ...next, [FV_KEY]: mergedVersions }
    }
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
      position: node.getData && node.getData('position'),
      siblings: collabNodeFeatures.siblingUids(node.parent)
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
    const afterPosition = node.getData && node.getData('position')
    const afterSiblings = collabNodeFeatures.siblingUids(node.parent)
    if (
      afterParent !== before.parent ||
      afterPosition !== before.position ||
      JSON.stringify(afterSiblings) !== JSON.stringify(before.siblings)
    ) {
      v2Trace('NODE_FEATURE_STRUCTURAL_MUTATION', {
        uid,
        parent: [before.parent, afterParent],
        position: [before.position, afterPosition]
      })
      console.error('NODE_FEATURE_STRUCTURAL_MUTATION', {
        uid,
        parent: [before.parent, afterParent]
      })
    }
    return true
  }

  applyRemoteMapMeta(payload = {}, options = {}) {
    if (!this.mindMap || this.isApplyingRemote) return
    const hydrate = !!options.hydrate
    // 主题和布局属于个人视图；旧共享 metadata 仅用于首次加载的默认值。
    if (this.httpCollabMode && !hydrate) return
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
        this.requestRemoteApplyRender(
          [],
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
    const previousRoom = this.httpRoomKey
    if (config.roomKey && config.roomKey !== this.httpRoomKey) this.cancelV2RemoteApply()
    this.setLazyLoaders(config)
    this.httpCollabMode = true
    if (!this.currentData || previousRoom !== this.httpRoomKey) {
      this.currentData = transformTreeDataToObject(this.mindMap.renderer.renderTree)
    }
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this._pendingAttachmentPatchByUid = new Map()
    this._attachmentPatchIntentSeq = 0
    this.ackedUids = new Set()
    this.pendingUids = new Set()
    this.resetLocalIntentState()
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
    if (roomKey) {
      if (this.httpRoomKey !== roomKey) invalidateHydrationSession(this)
      this.httpRoomKey = roomKey
    }
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
    // 个人主题由 view-state 保存，不再发布 map.meta.update。
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
    // 个人布局由 view-state 保存，不再发布 map.meta.update。
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
      if (typeof config.flushHistoryVersion === 'function') {
        this.httpFlushHistoryVersion = config.flushHistoryVersion
      }
      this.httpPatchNode = (uid, body) => {
        const next = { ...(body || {}), uid }
        const guarded = collabNodeFeatures.guardFeatureStructuralMutation(next)
        return this.submitV2('node.update', guarded.payload)
      }
      this.httpAddNode = body => this.submitV2('node.insert', body || {})
      this.httpDeleteNode = (uid, options) =>
        this.submitV2('node.delete', { ...(options || {}), uid })
      if (typeof config.replaceTree === 'function') {
        this.httpReplaceTree = (tree, extra) =>
          this.submitHttpMapReplace(tree, extra, config.replaceTree)
      } else {
        this.httpReplaceTree = (tree, extra) =>
          this.submitV2(
            'map.replace',
            collabSpecialObjects.buildMapReplacePayload(tree, extra)
          )
      }
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
    invalidateHydrationSession(this)
    this.httpLocateFailures = new Map()
    this.httpLocateInflight = new Map()
    this.cancelV2RemoteApply()
    const restoreWaiters = Array.isArray(this.httpRestoreWaiters)
      ? this.httpRestoreWaiters.splice(0)
      : []
    restoreWaiters.forEach(waiter => {
      clearTimeout(waiter.timer)
      waiter.resolve({
        applied: false,
        skipped: true,
        reason: 'HTTP_COLLAB_DISABLED'
      })
    })
    this.httpCollabMode = false
    this.safeLoadMode = false
    this.httpRoomKey = ''
    this.resetLocalIntentState()
    this.httpFetchSubtree = null
    this.httpFetchDeepSubtree = null
    this.httpFetchExportTree = null
    this.httpFetchNodes = null
    this.httpFetchLocate = null
    this.httpPatchNode = null
    this.httpAddNode = null
    this.httpFlushHistoryVersion = null
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
    this.releaseHttpRecoverTurnWaiters('cancelled')
    this.httpRecovering = false
    this.httpRecoverQueued = false
    this.httpPendingRecoverVersion = 0
    this.httpPendingRecoverOptions = null
    clearTimeout(this.httpRecoverRetryTimer)
    this.httpRecoverRetryTimer = null
    this.httpRecoverRetryDelay = HTTP_RECOVER_RETRY_BASE_MS
    this.hydratedUids = new Set()
    this.hydrateFailedUids = new Set()
    this.hydrateInflight = new Map()
    this.lastPushed = {}
    this._pendingAttachmentPatchByUid && this._pendingAttachmentPatchByUid.clear()
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

  httpRecoverBlocked() {
    return !!(
      this.httpRefreshing ||
      this.httpHydrating ||
      this.isApplyingRemote ||
      this.isHttpSettling()
    )
  }

  async waitUntilHttpRecoverIdle(budgetMs) {
    const started = Date.now()
    const budget = Number(budgetMs) || 8000
    while (this.httpRecoverBlocked() && Date.now() - started < budget) {
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }

  waitForHttpRecoverTurn() {
    if (!this.httpRecovering) return Promise.resolve('idle')
    return new Promise(resolve => {
      if (!Array.isArray(this.httpRecoverTurnWaiters)) {
        this.httpRecoverTurnWaiters = []
      }
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const waiter = { finish }
      const timer = setTimeout(() => {
        this.httpRecoverTurnWaiters = (this.httpRecoverTurnWaiters || []).filter(
          item => item !== waiter
        )
        finish('timeout')
      }, 20000)
      this.httpRecoverTurnWaiters.push(waiter)
    })
  }

  releaseHttpRecoverTurnWaiters(reason) {
    const waiters = Array.isArray(this.httpRecoverTurnWaiters)
      ? this.httpRecoverTurnWaiters.splice(0)
      : []
    waiters.forEach(waiter => waiter.finish(reason || 'released'))
  }

  postReplaceSettleMs() {
    const count = Number(this.httpReplaceNodeCount) || 0
    if (count >= 400) return 12000
    if (count >= 100) return 6000
    return 3000
  }

  endHttpReplace(options = {}) {
    this.httpReplacing = false
    this.httpReplaceInFlight = false
    const liveImmediately =
      !!options.liveImmediately || !!this._liveImmediatelyAfterReplace
    this._liveImmediatelyAfterReplace = false
    if (liveImmediately) {
      this.httpSettlingAfterReplace = false
      this.suppressLocalUntil = 0
      clearTimeout(this.httpSettleTimer)
      this.httpSettleTimer = null
      this.captureHttpBaselineFromRenderer()
      return
    }
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

  applyAuthoritativeTreeReplace(tree, reason = 'IMPORT', extra = {}) {
    const renderer = this.mindMap && this.mindMap.renderer
    const full = extra.fullData || null
    const generation = renderer
      ? (renderer._renderGeneration = (renderer._renderGeneration || 0) + 1)
      : Date.now()
    if (renderer) {
      renderer.nodeCache = {}
      renderer.lastNodeCache = {}
      renderer.activeNodeList = []
      renderer.root = null
    }
    const assoc = this.mindMap && this.mindMap.associativeLine
    if (assoc && typeof assoc.removeAllLines === 'function') {
      assoc.removeAllLines()
    }
    const nodeCount = collabImport.countTreeNodes(tree)
    if (nodeCount >= 200) {
      this.enableLargeMapMode(nodeCount)
    }
    this.isSetData = true
    this._importPhase = 'IMPORT_APPLYING'
    try {
      if (full && typeof this.mindMap.setFullData === 'function') {
        this.mindMap.setFullData({ ...full, root: tree })
      } else if (typeof this.mindMap.setData === 'function') {
        this.mindMap.setData(tree)
      }
    } finally {
      this.isSetData = false
    }
    if (renderer && renderer._renderGeneration !== generation) return false
    this.afterHttpReplace(extra.result || {}, tree)
    const uids = []
    const expandable = []
    const walk = node => {
      if (!node || !node.data) return
      if (node.data.uid) uids.push(node.data.uid)
      if (node.children && node.children.length) expandable.push(node.data.uid)
      ;(node.children || []).forEach(walk)
    }
    walk(tree)
    if (uids.length <= 400) {
      this.postRestoreDecorations(uids)
    } else {
      const chunk = 200
      let offset = 0
      const tick = () => {
        if (renderer && renderer._renderGeneration !== generation) return
        this.postRestoreDecorations(uids.slice(offset, offset + chunk))
        offset += chunk
        if (offset < uids.length) {
          setTimeout(tick, 0)
        }
      }
      setTimeout(tick, 0)
    }
    this._liveImmediatelyAfterReplace = true
    this._importPhase = 'LIVE'
    const cacheCount = renderer ? Object.keys(renderer.nodeCache || {}).length : 0
    collabPaste.publishImportRuntimeTrace({
      reason,
      treeHash: String(uids.length),
      renderTreeNodeCount: uids.length,
      nodeCacheCount: cacheCount,
      expandableNodes: expandable.length,
      staleInstanceCount: 0,
      renderCompleted: true,
      generation
    })
    collabImport.publishLargeImportTrace({
      phase: 'LIVE',
      rendererEnd: Date.now(),
      nodeCount: uids.length
    })
    return true
  }

  afterHttpReplace(result, treeOverride) {
    this.lastPushed = {}
    this._pendingAttachmentPatchByUid && this._pendingAttachmentPatchByUid.clear()
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
    this._pendingAttachmentPatchByUid && this._pendingAttachmentPatchByUid.clear()
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
      (node.children || []).forEach(walk)
    }
    if (renderer.root) walk(renderer.root)
  }

  async submitHttpMapReplace(tree, extra, send) {
    const stats = collabImport.inspectImportTree(tree)
    collabImport.publishLargeImportTrace({
      phase: 'IMPORT_PREPARING',
      fileSize: extra && extra.fileSize,
      ...stats
    })
    if (stats.tooLarge) {
      const err = collabImport.importTooLargeError(stats)
      collabImport.publishLargeImportTrace({
        phase: 'IMPORT_TOO_LARGE',
        ...stats
      })
      throw err
    }
    this._importPhase = 'IMPORT_COMMITTING'
    collabImport.publishLargeImportTrace({
      phase: 'IMPORT_COMMITTING',
      outboxPutStart: Date.now(),
      ...stats
    })
    const started = Date.now()
    const result = await send(tree, extra)
    if (result && result.version != null) {
      this.acknowledgeLocalVersion(result.version, { duplicate: true })
      if (this.collabV2Adapter && this.collabV2Adapter.setLastServerRevision) {
        this.collabV2Adapter.setLastServerRevision(result.version)
      }
    }
    this._importPhase = 'IMPORT_APPLYING'
    collabImport.publishLargeImportTrace({
      phase: 'IMPORT_APPLYING',
      ack: Date.now(),
      durationMs: Date.now() - started,
      serverRevision: result && (result.version || result.serverRevision),
      ...stats
    })
    return result
  }

  async persistHttpReplace(fullData, extra = {}) {
    if (!this.httpReplaceTree) {
      throw new Error('replaceTree not configured')
    }
    const reason = collabFullTree.resolveFullTreeReason({
      ...extra,
      reason: extra.reason || collabFullTree.currentFullTreeReason()
    })
    const allowed = collabFullTree.isFullTreeMutationAllowed({
      ...extra,
      reason
    })
    collabFullTree.publishImportTrace({
      parseResult: extra.parseResult || 'ready',
      fullTreeReason: reason || extra.reason || '',
      allowed,
      feature: extra.feature || extra.source || 'persistHttpReplace'
    })
    if (this.collabV2Adapter && !allowed) {
      const row = {
        feature: extra.feature || 'persistHttpReplace',
        caller: extra.caller || 'Cooperate.persistHttpReplace',
        roomKey: this.httpRoomKey,
        reason: reason || extra.reason || '',
        stack: new Error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION').stack
      }
      console.error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION', row)
      const err = new Error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION')
      err.code = 'UNEXPECTED_FULL_TREE_MUTATION'
      err.stage = 'FULL_TREE_MUTATION_FORBIDDEN'
      throw err
    }
    if (this.httpReplaceInFlight) {
      const err = new Error('正在保存整图，请稍候再试')
      err.code = 'REPLACE_IN_PROGRESS'
      throw err
    }
    this.httpReplaceInFlight = true
    const tree = (fullData && fullData.root) || fullData
    // The server rejects writes based on a pre-restore revision. Carry the
    // revision that this canvas has actually applied, so a later restore
    // cannot be overwritten by an import started from stale content.
    const replaceExtra = {
      ...extra,
      baseVersion:
        extra.baseVersion == null
          ? Number(this.lastAppliedVersion) || 0
          : extra.baseVersion
    }
    try {
      const result = await collabFullTree.withAllowedFullTreeMutation(
        reason || 'IMPORT',
        () => this.httpReplaceTree(tree, replaceExtra)
      )
      this.afterHttpReplace(result, tree)
      collabFullTree.publishImportTrace({
        parseResult: extra.parseResult || 'applied',
        fullTreeReason: reason || extra.reason || '',
        mapReplaceOpId: result && (result.operationId || result.operation_id),
        serverRevision: result && (result.version || result.serverRevision),
        allowed: true
      })
      return result
    } finally {
      this.httpReplaceInFlight = false
    }
  }

  async restoreHttpTree(options = {}) {
    if (!this.httpFetchExportTree) return false
    const exported = await this.httpFetchExportTree()
    const tree = exported && exported.tree
    const failRestore = (code, message) => {
      const err = new Error(message)
      err.code = code
      throw err
    }
    if (
      !tree ||
      !tree.data ||
      !tree.data.uid ||
      (exported && exported.truncated === true)
    ) {
      failRestore(
        'HTTP_HISTORY_EXPORT_INCOMPLETE',
        '历史版本全量数据缺失或已截断'
      )
    }
    let nodeCount = 0
    let invalidNode = false
    const stack = [tree]
    while (stack.length) {
      const node = stack.pop()
      if (!node || !node.data || !node.data.uid) {
        invalidNode = true
        continue
      }
      nodeCount += 1
      if (node.children == null) continue
      if (!Array.isArray(node.children)) {
        invalidNode = true
        continue
      }
      node.children.forEach(child => stack.push(child))
    }
    const declaredNodeCount = Number(exported.node_count)
    if (
      invalidNode ||
      (Number.isFinite(declaredNodeCount) && declaredNodeCount !== nodeCount)
    ) {
      failRestore(
        'HTTP_HISTORY_EXPORT_INCOMPLETE',
        '历史版本全量节点数量不完整'
      )
    }
    const targetVersion = Number(options.targetVersion) || 0
    const serverVersion = Number(exported.version)
    if (
      targetVersion > 0 &&
      (!Number.isFinite(serverVersion) || serverVersion < targetVersion)
    ) {
      failRestore(
        'HTTP_HISTORY_STALE_SNAPSHOT',
        '历史版本全量数据版本落后于恢复目标'
      )
    }
    if (!this.mindMap || typeof this.mindMap.setFullData !== 'function') {
      failRestore(
        'HTTP_HISTORY_RENDER_UNAVAILABLE',
        '历史版本画布尚未准备好'
      )
    }

    let finishRenderWait
    let onRenderEnd
    let resolveRender
    const renderPromise = new Promise(resolve => {
      resolveRender = resolve
    })
    const hasRenderEvent =
      typeof this.mindMap.on === 'function' &&
      typeof this.mindMap.off === 'function'
    if (hasRenderEvent) {
      onRenderEnd = () => {
        if (finishRenderWait) finishRenderWait()
      }
      finishRenderWait = () => {
        if (!onRenderEnd) return
        this.mindMap.off('node_tree_render_end', onRenderEnd)
        onRenderEnd = null
        resolveRender()
      }
      this.mindMap.on('node_tree_render_end', onRenderEnd)
    }
    const previousSetData = this.isSetData
    this.isSetData = true
    try {
      this.mindMap.setFullData({
        ...exported,
        root: tree
      })
      if (!hasRenderEvent) {
        if (typeof this.mindMap.render !== 'function') {
          failRestore(
            'HTTP_HISTORY_RENDER_UNAVAILABLE',
            '历史版本画布无法完成渲染'
          )
        }
        finishRenderWait = resolveRender
        this.mindMap.render(resolveRender)
      }
      await renderPromise
      this.afterHttpReplace(exported)
    } finally {
      if (onRenderEnd) {
        this.mindMap.off('node_tree_render_end', onRenderEnd)
        onRenderEnd = null
      }
      this.isSetData = previousSetData
    }
    return {
      applied: true,
      version: Number.isFinite(serverVersion) ? serverVersion : targetVersion,
      nodeCount,
      updatedAt: exported.updated_at || ''
    }
  }

  mergeHttpChildren(data, incoming) {
    if (!data) return
    if (!data.children) data.children = []
    const have = new Set(
      data.children.map(child => child && child.data && child.data.uid)
    )
    const added = []
    ;(incoming || []).forEach(child => {
      const uid = child && child.data && child.data.uid
      if (!uid || have.has(uid) || this.isTombstonedUid(uid)) return
      const hydrated = clearHydratedSelection(child)
      data.children.push(hydrated)
      added.push(hydrated)
      have.add(uid)
      this.markUidPushed(uid, child.data, 'server')
    })
    if (added.length) this.notifyHttpHydration(data, added)
  }

  notifyHttpHydration(data, added) {
    const node = data._node || this.mindMap.renderer.findNodeByUid(data.data && data.data.uid)
    this.mindMap.command.recordContentChange({ added, source: 'hydrate',
      countable: !node || this.mindMap.command.isCountableNode(node) })
  }

  markUidPushed(uid, data, source = 'server') {
    if (!uid || !data) return
    if (source !== 'server' && source !== 'ack') return
    const content = collabNodeFeatures.buildNodeContentFields(data)
    const text = content.text
    const note = content.note
    const full = { text, note, ...collectStyleFields(data) }
    if (content.richText !== undefined) full.richText = content.richText
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

  resolveHttpPatchNode(node, command) {
    const resolved = collabSpecialObjects.resolveCollaborationTarget(node, command)
    if (resolved.kind === 'generalization' && resolved.owner) return resolved.owner
    if (resolved.kind === 'business-node') return resolved.node || node
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
        if (hydrated && this.mindMap) {
          this.requestRemoteApplyRender(node.getData && node.getData('uid'))
        }
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
    if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return false
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
      if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return false
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
    if (next && Object.prototype.hasOwnProperty.call(next, 'expand')) delete next.expand
    const renderer = this.mindMap.renderer
    if (!node || !renderer) return false
    let changed = false
    const imgMap =
      (renderer.renderTree &&
        renderer.renderTree.data &&
        renderer.renderTree.data.imgMap) ||
      {}
    const imageFields = Object.prototype.hasOwnProperty.call(next, 'image')
      ? collabSpecialObjects.canonicalImageFields(
          next,
          imgMap
        )
      : null
    if (imageFields) {
      collabSpecialObjects.publishImageTrace({
        uid: node.getData && node.getData('uid'),
        command: 'remote.apply',
        imageAfter: imageFields.image,
        storedImageValue: imageFields.storedImageValue,
        imageTitle: imageFields.imageTitle,
        imageSize: imageFields.imageSize,
        remoteEvent: true
      })
    }
    const stylePayload = {
      text: next.text,
      note: next.note,
      richText: next.richText,
      image: imageFields && !imageFields.unresolvedKey ? imageFields.image : next.image,
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
      attachmentId: next.attachmentId,
      attachmentMimeType: next.attachmentMimeType,
      attachmentStatus: next.attachmentStatus,
      attachmentError: next.attachmentError,
      attachmentExtractedText: next.attachmentExtractedText,
      attachmentErrorIgnored: next.attachmentErrorIgnored,
      comments: next.comments,
      commentResolved: next.commentResolved,
      customLeft: next.customLeft,
      customTop: next.customTop,
      isFloating: next.isFloating
    }
    Object.keys(next || {}).forEach(key => {
      if (checkIsNodeStyleDataKey(key)) stylePayload[key] = next[key]
    })
    Object.keys(stylePayload).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        if (stylePayload[key] === undefined) delete stylePayload[key]
      }
    })
    // HTTP recovery includes complete records, including unchanged nodes.
    // Only recreate visual content whose value actually changed.
    const currentData = (node.getData && node.getData()) || {}
    const incomingVersions = readFieldVersions(next)
    if (Object.keys(incomingVersions).length) {
      const mergedVersions = { ...readFieldVersions(currentData) }
      Object.keys(incomingVersions).forEach(group => {
        mergedVersions[group] = Math.max(
          Number(mergedVersions[group] || 0),
          Number(incomingVersions[group] || 0)
        )
      })
      const nodeData = node.nodeData && node.nodeData.data
      if (nodeData) nodeData[FV_KEY] = mergedVersions
    }
    Object.keys(stylePayload).forEach(key => {
      const value = stylePayload[key]
      if (
        (value == null && currentData[key] == null) ||
        JSON.stringify(value) === JSON.stringify(currentData[key])
      ) delete stylePayload[key]
    })
    if (Object.keys(stylePayload).length) {
      const data = node.nodeData && node.nodeData.data
      Object.keys(stylePayload).forEach(key => {
        if (!data) return
        if (stylePayload[key] === null) delete data[key]
        else data[key] = stylePayload[key]
      })
      if (next.text != null && next.richText) {
        collabNodeFeatures.publishRichTextPersistTrace({
          hydrateText: next.text,
          richTextFlag: next.richText
        })
      }
      const recreate = collabNodeFeatures.recreateTypesFromPatch(stylePayload)
      let sizeChanged = false
      if (typeof node.reRender === 'function') {
        sizeChanged = !!node.reRender(recreate.length ? recreate : undefined)
      } else if (typeof renderer.reRenderNodeCheckChange === 'function') {
        renderer.reRenderNodeCheckChange(node, false)
        sizeChanged = true
      }
      const flags = (this.mindMap && this.mindMap.opt && this.mindMap.opt.performanceFlags) || {}
      const plan = p1PerfPlan.planRemoteNodePaint(stylePayload, {
        sizeChanged,
        inheritAncestorLineStyle: !!(
          this.mindMap &&
          this.mindMap.opt &&
          this.mindMap.opt.enableInheritAncestorLineStyle
        ),
        scopedLine: !!flags.scopedRemoteLineRender,
        scopedGeometry: !!flags.scopedRemoteGeometry,
        needsGeometryRefresh: collabNodeFeatures.needsGeometryRefresh(stylePayload)
      })
      p1PerfPlan.applyRemoteLineRefresh(node, plan.lineRefresh)
      if (
        plan.scheduleLayout &&
        this.mindMap &&
        typeof this.mindMap.render === 'function' &&
        !this.httpRefreshing
      ) {
        this.scheduleRemoteGeometryRender(node.getData && node.getData('uid'))
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
      } else       if (this.applyLocalGeneralization(node, next.generalization)) {
        changed = true
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(next, 'associativeLineTargets') ||
      Object.prototype.hasOwnProperty.call(next, 'associativeLinePoint') ||
      Object.prototype.hasOwnProperty.call(next, 'associativeLineTargetControlOffsets')
    ) {
      const assoc = this.mindMap && this.mindMap.associativeLine
      if (assoc && typeof assoc.renderAllLines === 'function') {
        assoc.renderAllLines()
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
      // Only mark complete when authoritative total is known and fully loaded.
      // Never treat clipped children.length as complete when childCount > live.
      if (uid && count > 0 && live >= count) {
        this.hydratedUids.add(uid)
      } else if (uid && count > live) {
        this.hydratedUids.delete(uid)
        this.dirtySubtrees.set(uid, Number(node.data.subtreeVersion) || 1)
      }
      (node.children || []).forEach(walk)
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
    // Authoritative total: 0 means no children. Partial load with unknown
    // total is handled once childCount is stamped from room_nodes.
    if (count > 0 && live < count) return true
    if (!live && count > 0) return true
    return false
  }

  /**
   * After safe_load / F5: hydrate parents that already show incomplete children
   * (or are expanded). Do not hydrate the whole map.
   */
  async hydrateExpandedPartialParents({ render = true } = {}) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (!renderer || !renderer.root || !this.httpFetchSubtree) return { hydrated: 0, changed: false }
    const jobs = []
    const seen = new Set()
    const visit = node => {
      if (!node) return
      const uid = node.getData && node.getData('uid')
      const live =
        (node.nodeData && node.nodeData.children && node.nodeData.children.length) ||
        0
      const expanded = !(node.getData && node.getData('expand') === false)
      const needs = this.nodeNeedsHydrate(node)
      if (
        needs && uid && !seen.has(uid) && (live > 0 || expanded) &&
        (!this.hydrateFailedUids.has(uid) || this.dirtySubtrees.has(uid))
      ) {
        seen.add(uid)
        jobs.push(() =>
          this.hydrateFromHttp(node, { priority: 'low' }).catch(err => {
            this.hydrateFailedUids.add(uid)
            console.error('[mind-map] expanded partial hydrate failed', uid, err)
            return false
          })
        )
      }
      if (Array.isArray(node.children)) node.children.forEach(visit)
    }
    visit(renderer.root)
    if (!jobs.length) return { hydrated: 0, changed: false }
    // Large expanded rooms must not start hundreds of subtree requests at once.
    const results = []
    let nextJob = 0
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (nextJob < jobs.length) {
        const run = jobs[nextJob++]
        results.push(await run())
      }
    }))
    const changed = results.some(Boolean)
    // render_end invokes the personal expand restore again. Rendering after a
    // no-op fetch would otherwise create an endless subtree/render cycle.
    if (render && changed && typeof this.mindMap.render === 'function') this.mindMap.render()
    return { hydrated: jobs.length, changed }
  }

  async ensurePlacementParent(parentNode) {
    if (!parentNode || !this.httpCollabMode) return parentNode
    if (!this.nodeNeedsHydrate(parentNode)) return parentNode
    await this.hydrateFromHttp(parentNode)
    if (typeof this.mindMap.render === 'function') this.mindMap.render()
    return parentNode
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
      (node.children || []).forEach(walk)
    }
    walk(this.mindMap.renderer && this.mindMap.renderer.renderTree)
  }

  async hydrateFromHttp(node, options = {}) {
    if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return
    if (!node || !this.httpFetchSubtree) return
    const uid = node.getData && node.getData('uid')
    const data = node.nodeData
    if (!uid || !data) return
    if (this.isTombstonedUid && this.isTombstonedUid(uid)) return false
    const liveLen = Array.isArray(data.children) ? data.children.length : 0
    const count = Number(data.data && data.data.childCount) || 0
    const dirtyAt = this.dirtySubtrees.get(uid)
    // Completeness: loaded >= authoritative total. Never treat clipped
    // children as complete when childCount is larger.
    const complete = count > 0 && liveLen >= count
    const alreadyHydrated =
      complete && this.hydratedUids.has(uid) && !dirtyAt
    if (alreadyHydrated) return
    // count==0 and live==0: nothing to load (authoritative empty).
    if (!dirtyAt && count <= 0 && liveLen <= 0 && this.hydratedUids.has(uid)) {
      return
    }
    const pending = this.hydrateInflight && this.hydrateInflight.get(uid)
    if (pending && (!pending.hydrationGuard || pending.hydrationGuard.isCurrent())) return pending
    const guard = beginHydration(this, uid)
    const isCurrent = guard.isCurrent
    const job = (async () => {
      this.httpHydrating = true
      try {
        const fetchSubtree = (options = {}) =>
          this.httpFetchSubtree(uid, {
            knownVersion: options.knownVersion ?? 0,
            deep: options.deep,
            offset: options.offset,
            limit: options.limit,
            isCurrent,
            priority: options.priority || 'high'
          })
        const knownVersion = complete
          ? Number((data.data && data.data.subtreeVersion) || 0) || 0
          : 0
        let result = await fetchSubtree({ knownVersion })
        if (!isCurrent() || this._disposed || (this.mindMap && this.mindMap._destroyed)) return false
        const needsLocalChildren = count > 0 && liveLen < count
        if (result && result.unchanged && needsLocalChildren) {
          result = await fetchSubtree({ knownVersion: 0 })
          if (!isCurrent()) return false
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
          if (!isCurrent()) return false
        }
        if (
          (!result || !result.children || !result.children.length) &&
          count > 0 &&
          !(result && Number(result.total) === 0) &&
          this.httpFetchDeepSubtree
        ) {
          const deep = await this.httpFetchDeepSubtree(uid, {
            knownVersion: 0,
            maxNodes: Math.max(400, count + 10),
            isCurrent,
            priority: options.priority || 'high'
          })
          if (!isCurrent()) return false
          if (deep && deep.tree) {
            result = {
              children: deep.tree.children || [],
              total: deep.tree.data && deep.tree.data.childCount != null &&
                Number.isInteger(Number(deep.tree.data.childCount))
                ? Number(deep.tree.data.childCount)
                : count,
              version: deep.version,
              descendantCount: deep.tree.data && deep.tree.data.descendantCount,
              has_more: false
            }
          }
        }
        if (result && result.has_more && Array.isArray(result.children)) {
          const children = result.children.slice()
          let offset = Number(result.offset) || 0
          offset += result.children.length
          // The subtree endpoint pages direct children. Do not leave old maps
          // with >200 siblings permanently "partial" after Undo/Redo.
          for (let page = 0; page < 20 && result.has_more; page += 1) {
            const next = await fetchSubtree({ knownVersion: 0, offset, limit: 500 })
            if (!isCurrent()) return false
            const more = next && Array.isArray(next.children) ? next.children : []
            const versionChanged = next && next.version != null && result.version != null &&
              Number(next.version) !== Number(result.version)
            if (!more.length || versionChanged) break
            children.push(...more)
            offset += more.length
            result = { ...next, children, offset: 0 }
          }
        }
        if (!result || result.missing) {
          const err = new Error('subtree missing')
          err.code = 'SUBTREE_MISSING'
          throw err
        }
        if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return false
        const beforeChildren = Array.isArray(data.children) ? data.children.length : 0
        const beforeCount = Number(data.data && data.data.childCount) || 0
        const beforeDescendants = Number(data.data && data.data.descendantCount) || 0
        this.mergeHttpChildren(data, result && result.children)
        if (data.data) {
          const serverTotal = Number(result && result.total)
          const total = result && result.total != null &&
            Number.isInteger(serverTotal) && serverTotal >= 0
            ? serverTotal
            : beforeCount
          data.data.hasMore = !!(result && result.has_more)
          if (result && Number.isInteger(result.descendantCount)) {
            data.data.descendantCount = result.descendantCount
          }
          // Zero is authoritative too (not a falsy fallback to stale count).
          data.data.childCount = total
          if (result && result.version != null) {
            data.data.subtreeVersion = Number(result.version) || 0
          }
        }
        const afterLen = Array.isArray(data.children) ? data.children.length : 0
        const afterCount = Number(data.data && data.data.childCount) || 0
        const changed = afterLen !== beforeChildren ||
          afterCount !== beforeCount ||
          (Number(data.data && data.data.descendantCount) || 0) !== beforeDescendants
        if (afterCount > 0 && afterLen >= afterCount) {
          this.hydratedUids.add(uid)
          this.hydrateFailedUids.delete(uid)
        } else if (afterCount > 0 && afterLen < afterCount) {
          this.hydrateFailedUids.add(uid)
          // A partial/no-progress response must not trigger a render loop.
          // A newer remote operation marks this subtree dirty for a retry.
        } else if (afterLen > 0) {
          this.hydratedUids.add(uid)
          this.hydrateFailedUids.delete(uid)
        } else {
          this.hydratedUids.add(uid)
          this.hydrateFailedUids.delete(uid)
        }
        this.dirtySubtrees.delete(uid)
        return changed
      } catch (err) {
        // A remotely deleted node may disappear while a hydration is queued
        // or in flight. Do not schedule another read or apply its stale data.
        if (!isCurrent()) return false
        throw err
      } finally {
        this.httpHydrating = false
        if (!this._disposed && !(this.mindMap && this.mindMap._destroyed)) this.flushPendingHttpRefresh()
      }
    })()
    job.hydrationGuard = guard
    if (!this.hydrateInflight) this.hydrateInflight = new Map()
    this.hydrateInflight.set(uid, job)
    try {
      return await job
    } finally {
      guard.release()
      if (this.hydrateInflight && this.hydrateInflight.get(uid) === job) {
        this.hydrateInflight.delete(uid)
      }
    }
  }

  async hydrateNodeData(data) {
    if (this._disposed || (this.mindMap && this.mindMap._destroyed)) return data
    if (!data || !this.httpFetchSubtree) return data
    const uid = data.data && data.data.uid
    if (!uid) return data
    const guard = beginHydration(this, uid)
    const isCurrent = guard.isCurrent
    try {
      if (!isCurrent()) return data
      const live = Array.isArray(data.children) ? data.children.length : 0
      const count = Number(data.data && data.data.childCount) || 0
      const dirtyAt = uid && this.dirtySubtrees && this.dirtySubtrees.get(uid)
      // Only a previous authoritative read establishes that an empty node is
      // complete. A new dirty marker must still trigger a fresh read.
      if (!dirtyAt && count === 0 && live === 0 && !data.data.hasMore && this.hydratedUids.has(uid)) return data
      if (live && (!count || live >= count) && !dirtyAt && !data.data.hasMore) return data
      const knownVersion = live
        ? Number((data.data && data.data.subtreeVersion) || 0) || 0
        : 0
      let result = await Promise.resolve(this.httpFetchSubtree(uid, {
        knownVersion,
        isCurrent,
        priority: 'low'
      })).catch(err => {
        if (!isCurrent()) return null
        throw err
      })
      if (!isCurrent() || this._disposed || (this.mindMap && this.mindMap._destroyed)) return data
      const needsLocalChildren = count > 0 && live < count
      if (result && result.unchanged && needsLocalChildren) {
        result = await Promise.resolve(this.httpFetchSubtree(uid, {
          knownVersion: 0,
          isCurrent,
          priority: 'low'
        })).catch(err => {
          if (!isCurrent()) return null
          throw err
        })
        if (!isCurrent() || this._disposed || (this.mindMap && this.mindMap._destroyed)) return data
      }
      if (result && result.unchanged && !needsLocalChildren) {
        this.dirtySubtrees.delete(uid)
        if (result.version && data.data) {
          data.data.subtreeVersion = Number(result.version)
        }
        return data
      }
      if (result && result.has_more && Array.isArray(result.children)) {
        const children = result.children.slice()
        const pageVersion = result.version
        let offset = (Number(result.offset) || 0) + children.length
        for (let page = 0; page < 20 && result.has_more; page += 1) {
          const next = await this.httpFetchSubtree(uid, {
            knownVersion: 0, offset, limit: 500, isCurrent, priority: 'low'
          })
          if (!isCurrent()) return data
          if (!next || !Array.isArray(next.children) || !next.children.length ||
              (pageVersion != null && next.version != null && Number(pageVersion) !== Number(next.version))) {
            const err = new Error('子树分页已变化或未完成，请重试')
            err.code = 'SUBTREE_PAGE_INCOMPLETE'
            throw err
          }
          children.push(...next.children)
          offset += next.children.length
          result = { ...next, children, offset: 0 }
        }
        if (result.has_more) {
          const err = new Error('子树分页未完成，请重试')
          err.code = 'SUBTREE_PAGE_INCOMPLETE'
          throw err
        }
      }
      if (!data.children || !data.children.length) {
        data.children = ((result && result.children) || []).map(clearHydratedSelection)
        if (data.children.length && typeof this.notifyHttpHydration === 'function') this.notifyHttpHydration(data, data.children)
      } else {
        this.mergeHttpChildren(data, result && result.children)
      }
      if (data.data) {
        data.data.hasMore = !!(result && result.has_more)
        const serverTotal = Number(result && result.total)
        data.data.childCount = result && result.total != null &&
          Number.isInteger(serverTotal) && serverTotal >= 0
          ? serverTotal
          : count
        if (result && Number.isInteger(result.descendantCount)) {
          data.data.descendantCount = result.descendantCount
        }
        if (result && result.version != null) {
          data.data.subtreeVersion = Number(result.version) || 0
        }
      }
      const loaded = Array.isArray(data.children) ? data.children.length : 0
      const authoritativeEmpty = result && result.total != null && Number(result.total) === 0
      const complete = !data.data.hasMore && loaded >= Number(data.data.childCount || 0) &&
        (loaded > 0 || authoritativeEmpty)
      if (complete) {
        this.dirtySubtrees.delete(uid)
        this.hydratedUids.add(uid)
      } else {
        data.data.hasMore = true
        this.hydratedUids.delete(uid)
        if (!this.dirtySubtrees.has(uid)) this.dirtySubtrees.set(uid, Number(result && result.version) || 1)
      }
      this.markUidPushed(uid, data.data, 'server')
      const serverKids = (result && result.children) || []
      serverKids.forEach(child => {
        const childUid = child && child.data && child.data.uid
        this.markUidPushed(childUid, child && child.data, 'server')
      })
      return data
    } catch (err) {
      if (!isCurrent()) return data
      throw err
    } finally {
      guard.release()
    }
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

  async ensureHttpNodePath(uid, locatedCache, options = {}) {
    if (!uid || uid === 'root') return false
    if (this.isTombstonedUid(uid)) return false
    const renderer = this.mindMap.renderer
    const tree = renderer && renderer.renderTree
    if (!tree) return false
    if (this.findTreeNode(tree, uid)) return true
    if (!this.httpFetchLocate) return false
    const locateRoom = this.httpRoomKey
    const fetchLocate = this.httpFetchLocate
    let located = locatedCache
    if (!located) {
      const passive = options.expand === false
      if (!this.httpLocateFailures) this.httpLocateFailures = new Map()
      if (!this.httpLocateInflight) this.httpLocateInflight = new Map()
      const failures = this.httpLocateFailures
      const inflight = this.httpLocateInflight
      const previous = failures.get(uid)
      if (passive && previous && previous.retryAt > Date.now()) return false
      try {
        let job = inflight.get(uid)
        if (!job) {
          job = Promise.resolve().then(() => fetchLocate(uid, { priority: passive ? 'low' : 'high' }))
            .finally(() => { if (inflight.get(uid) === job) inflight.delete(uid) })
          inflight.set(uid, job)
        }
        located = await job
        if (this.httpRoomKey !== locateRoom) return false
        failures.delete(uid)
      } catch (err) {
        const attempts = Math.min(4, (previous && previous.attempts || 0) + 1)
        const missing = err && (err.statusCode === 404 || err.code === 'NODE_NOT_FOUND')
        failures.set(uid, { attempts, retryAt: Date.now() + (missing ? Math.min(60000, 10000 * 2 ** (attempts - 1)) : 2000) })
        if (failures.size > 500) failures.delete(failures.keys().next().value)
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
          if (options.expand !== false && this.expandTreeNode(parent)) changed = true
          treeNode = this.findTreeNode(tree, id)
        }
      }
      if (treeNode) {
        try {
          await this.hydrateNodeData(treeNode)
        } catch (err) {
          console.error('[mind-map] hydrate path failed', id, err)
        }
        if (options.expand !== false && this.expandTreeNode(treeNode)) changed = true
      }
    }
    return changed || !!this.findTreeNode(tree, uid)
  }

  async syncHttpDirtySubtrees(treeNodeIndex) {
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
      let treeNode = treeNodeIndex
        ? treeNodeIndex.get(uid)
        : this.findTreeNode(tree, uid)
      if (!treeNode) {
        // An unloaded branch remains dirty until the user expands it. Passive
        // sync must not locate every invisible UID and hydrate its entire path.
        continue
      }
      if (treeNode.data && treeNode.data.expand === false && !(treeNode.children || []).length) continue
      const previousChildren = new Set(treeNode.children || [])
      const before = previousChildren.size
      try {
        await this.hydrateNodeData(treeNode)
      } catch (err) {
        console.error('[mind-map] dirty subtree sync failed', uid, err)
        continue
      }
      if ((treeNode.data && treeNode.data.hasMore) || !this.hydratedUids.has(uid)) continue
      if (treeNodeIndex) {
        const currentChildren = new Set(treeNode.children || [])
        previousChildren.forEach(child => {
          if (!currentChildren.has(child)) {
            removeTreeNodesFromUidIndex(child, treeNodeIndex)
          }
        })
        currentChildren.forEach(child => {
          if (!previousChildren.has(child)) {
            indexTreeNodesByUid(child, treeNodeIndex)
          }
        })
      }
      if ((treeNode.children || []).length !== before) changed = true
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
        const tree = this.mindMap.renderer && this.mindMap.renderer.renderTree
        if (!this.findTreeNode(tree, uid)) {
          if (await this.ensureHttpNodePath(uid, undefined, { expand: false })) changed = true
        }
      }
      if (await this.syncHttpDirtySubtrees()) changed = true
    } finally {
      this.httpHydrating = false
      this.flushPendingHttpRefresh()
    }
    if (changed && this.mindMap) {
      const renderer = this.mindMap.renderer
      if (renderer && typeof renderer.requestRemoteRender === 'function') {
        renderer.requestRemoteRender(Array.from(uids))
      } else {
        this.mindMap.render()
      }
    }
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
    (data.children || []).forEach(child => this.hydrateYmapTree(child))
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
    if(name==='SET_NODE_DATA' && args[0]?.getData) {
      this.fillRepairGuards ||= new Map()
      const uid=args[0].getData('uid')
      if(args[2]?.fillRepair)this.fillRepairGuards.set(uid,args[2].expected)
      else this.fillRepairGuards.delete(uid)
    }
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
    const list = (name==='REMOVE_NODE' || name==='REMOVE_CURRENT_NODE') && args[0] && (Array.isArray(args[0])?args[0].length:true)
      ? (Array.isArray(args[0])?args[0]:[args[0]])
      : (this.mindMap.renderer && this.mindMap.renderer.activeNodeList) || []
    const selection = collabDelete.collectDeleteRoots(list, name)
    this.pendingHttpDeletes = selection.roots.map(item => ({
      uid: item.uid,
      keepChildren: item.keepChildren,
      descendantUids: item.descendantUids,
      ...(args[1] && args[1].fillRepair ? {
        expected:{text:item.node.getData('text'),note:item.node.getData('note')},expectedLeaf:true
      }:{})
    }))
    this.pendingHttpGeneralizationOwners = selection.owners
    collabDelete.publishDeleteTrace({
      command: name,
      rootUid: selection.rootUids[0] || '',
      rootUids: selection.rootUids,
      descendantUids: selection.descendantUids,
      generatedOperation:
        selection.rootUids.length === 1 ? 'node.delete' : 'node.batch'
    })
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
    // Missing and null both mean no summary. Do not append an empty summary
    // update after a move: it would consume the user's first undo step.
    if (generalizationSignature(prevFull.generalization) === generalizationSignature(cloned)) {
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
      const owners = (this.pendingHttpGeneralizationOwners || []).splice(0)
      const items = this.pendingHttpDeletes.splice(0)
      const roots = items
        .map(item =>
          typeof item === 'string'
            ? { uid: item, keepChildren: name === 'REMOVE_CURRENT_NODE' }
            : item
        )
        .filter(item => item && item.uid)
      const allLocal = []
      roots.forEach(item => {
        allLocal.push(item.uid)
        ;(item.descendantUids || []).forEach(id => allLocal.push(id))
      })
      this.purgeQueuedInserts(allLocal)
      allLocal.forEach(uid => this.tombstoneDeletedUid(uid))
      const drop = this.collabV2Adapter && this.collabV2Adapter.dropPendingInsertsForUid
      const ops = collabDelete.deleteOperationsFromRoots({ roots })
      collabDelete.publishDeleteTrace({
        command: name,
        rootUid: roots[0] && roots[0].uid,
        rootUids: roots.map(item => item.uid),
        descendantUids: roots.reduce(
          (list, item) => list.concat(item.descendantUids || []),
          []
        ),
        generatedOperation:
          ops.length === 1 ? 'node.delete' : ops.length > 1 ? 'node.batch' : ''
      })
      const deleting = Promise.resolve(
        drop ? Promise.all(allLocal.map(uid => drop.call(this.collabV2Adapter, uid))) : null
      )
        .then(() => {
          if (!ops.length) return null
          if (ops.length === 1) {
            return this.httpDeleteNode
              ? this.httpDeleteNode(ops[0].payload.uid, {
                  keepChildren: ops[0].payload.keepChildren
                })
              : this.submitV2('node.delete', ops[0].payload)
          }
          return this.submitV2('node.batch', { ops })
        })
        .then(result => {
          const op = result && result.operation
          const ev = op && op.event && op.event.payload
          collabDelete.publishDeleteTrace({
            command: name,
            rootUid: roots[0] && roots[0].uid,
            generatedOperation: ops.length === 1 ? 'node.delete' : 'node.batch',
            serverDeletedUids: (ev && (ev.deletedUids || ev.removed)) || [],
            ackRevision: result && (result.version || result.serverRevision),
            originApplied: true
          })
        })
        .catch(err => {
          allLocal.forEach(uid => { if (this.currentData[uid]) this.reviveDeletedUid(uid) })
          this.mindMap.emit('collab_write_conflict', err)
          this.projectDeferredView(true).catch(() => {})
          console.error('[mind-map] subtree delete failed', err)
          throw err
        })
      this._latestStructuralWrite = deleting
      deleting.catch(() => {})
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
      }
      if(name==='SET_NODE_DATA' && args[2]?.fillRepair){this.flushHttpText();return}
      if (
        name === 'SET_NODE_TAG' ||
        name === 'SET_NODE_IMAGE' ||
        name === 'SET_NODE_HYPERLINK' ||
        name === 'SET_NODE_COMMENT' ||
        name === 'SET_NODE_MAP_REF' ||
        name === 'SET_NODE_ICON' ||
        name === 'ADD_ASSOCIATIVE_LINE' ||
        (name === 'SET_NODE_DATA' &&
          args[1] &&
          (Object.prototype.hasOwnProperty.call(args[1], 'associativeLineTargets') ||
            Object.prototype.hasOwnProperty.call(args[1], 'image') ||
            Object.prototype.hasOwnProperty.call(args[1], 'imageSize')))
      ) {
        if (name === 'SET_NODE_IMAGE') {
          const store = this.mindMap && this.mindMap.nodeBase64ImageStorage
          if (store && typeof store.storeNodeImage === 'function' && args[0]) {
            store.storeNodeImage(args[0])
          }
        }
        this.flushHttpText()
        return
      }
      this.scheduleHttpTextSync()
    }
  }

  scheduleHttpTextSync() {
    clearTimeout(this.httpTextTimer)
    // 在线的人越多，每次保存要广播给越多人重排；打字停顿后再合并成一次。
    const peers = (this.presenceUsers || []).length
    const delay = peers >= 8 ? 700 : peers >= 3 ? 450 : 280
    this.httpTextTimer = setTimeout(() => {
      this.httpTextTimer = null
      this.flushHttpText()
    }, delay)
  }

  // 节点是逐个改的，但排版要看整棵树。多条远端改字落在同一窗口里只排一次。
  scheduleRemoteGeometryRender(uid) {
    const renderer = this.mindMap && this.mindMap.renderer
    if (renderer && typeof renderer.requestRemoteRender === 'function') {
      renderer.requestRemoteRender(uid)
      return
    }
    if (this._remoteGeometryTimer) return
    this._remoteGeometryTimer = setTimeout(() => {
      this._remoteGeometryTimer = null
      if (this.mindMap && typeof this.mindMap.render === 'function') {
        this.mindMap.render()
      }
    }, REMOTE_GEOMETRY_RENDER_MS)
  }

  scheduleRemoteRecover(version, options = {}) {
    const target = Math.max(
      Number(version) || 0,
      Number(this.httpPendingRecoverVersion) || 0
    )
    if (!target || !this.httpCollabMode) return
    if (target <= (Number(this.lastAppliedVersion) || 0)) return
    if (options && Object.keys(options).length) {
      this.httpPendingRecoverOptions = {
        ...(this.httpPendingRecoverOptions || {}),
        ...options
      }
    }
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
      this.recoverHttpCollab(
        pending,
        this.httpPendingRecoverOptions || {}
      ).catch(() => {})
    }, 150)
  }

  scheduleHttpRecoverRetry(version, options = {}) {
    const target = Math.max(
      Number(version) || 0,
      Number(this.httpPendingRecoverVersion) || 0
    )
    const versionRestore =
      options.reason === 'VERSION_RESTORE' ||
      options.fullTreeReason === 'VERSION_RESTORE'
    if (
      !this.httpCollabMode ||
      (!target && !versionRestore) ||
      (target <= (Number(this.lastAppliedVersion) || 0) && !versionRestore)
    ) {
      return
    }
    if (options && Object.keys(options).length) {
      this.httpPendingRecoverOptions = {
        ...(this.httpPendingRecoverOptions || {}),
        ...options
      }
    }
    if (this.httpRecoverRetryTimer) return
    const delay = Math.max(
      HTTP_RECOVER_RETRY_BASE_MS,
      Number(this.httpRecoverRetryDelay) || HTTP_RECOVER_RETRY_BASE_MS
    )
    this.httpRecoverRetryDelay = Math.min(
      HTTP_RECOVER_RETRY_MAX_MS,
      delay * 2
    )
    this.httpRecoverRetryTimer = setTimeout(() => {
      this.httpRecoverRetryTimer = null
      const pending = Math.max(
        target,
        Number(this.httpPendingRecoverVersion) || 0
      )
      const pendingOptions = this.httpPendingRecoverOptions || options || {}
      const pendingVersionRestore =
        pendingOptions.reason === 'VERSION_RESTORE' ||
        pendingOptions.fullTreeReason === 'VERSION_RESTORE'
      if (
        !this.httpCollabMode ||
        (pending <= (Number(this.lastAppliedVersion) || 0) &&
          !pendingVersionRestore)
      ) {
        return
      }
      this.recoverHttpCollab(
        pending,
        { ...pendingOptions, __httpRecoverRetry: true }
      ).catch(() => {})
    }, delay)
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
      (node.children || []).forEach(walk)
    }
    walk(root)
    return root
  }

  syncHttpUndoRedo(name) {
    if (!this.httpCollabMode) return
    this.stampGenIntentFromLocal()
    if (this.collabV2Adapter && typeof this.collabV2Adapter.undo === 'function') {
      const perform = () => {
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
        const statusNow =
          this.collabV2Adapter.getStatus && this.collabV2Adapter.getStatus()
        const top =
          (this.collabV2Adapter.peekUndoTarget &&
            this.collabV2Adapter.peekUndoTarget()) ||
          (statusNow && statusNow.undoTop) ||
          null
        collabPasteUndo.publishUndoTargetTrace({
          undoOpId: '',
          targetOperationId: top && (top.opId || (top.opIds && top.opIds[top.opIds.length - 1])),
          targetType: top && top.type,
          targetUids: top && top.opIds,
          inversePayload: null,
          undoDepth: statusNow && statusNow.undoDepth
        })
        if (isUndo && top && (top.type === 'map.replace' || top.type === 'map.replaced')) {
          if (this._lastPastedUids && this._lastPastedUids.size) {
            undoFullTreeForbidden('PASTE_UNDO_FULL_TREE_FORBIDDEN')
            this._v2UndoActive = false
            const err = collabPasteUndo.pasteUndoFullTreeForbidden('undo-target-map.replace', {
              targetOperationId: top.opId
            })
            if (this.mindMap) this.mindMap.emit('undo_conflict', err)
            return Promise.resolve()
          }
        }
        const run = isUndo
          ? this.collabV2Adapter.undoLastLocalOperation()
          : this.collabV2Adapter.redoLastLocalOperation()
        return Promise.resolve(run)
          .then(result => {
            if (result && result.serverRevision != null) {
              this.acknowledgeLocalVersion(result.serverRevision, {
                duplicate: true,
                deferV2Watermark: true
              })
            }
            const op = result && result.operation
            const evType = op && ((op.event && op.event.type) || op.type)
            if (evType === 'map.replaced' || evType === 'map.replace') {
              this._v2UndoAllowReplace = true
            }
            if (op && (op.event || op.type || op.payload)) {
              const ackScope = this.getV2RevisionScope()
              const normalized = collabNodeFeatures.normalizeAppliedUpdatePayload(op)
              const applied = this.applyV2RemoteOperation(op, { applySelf: true })
              collabNodeFeatures.publishUndoApplyTrace({
                undoOpId: op.opId || op.operationId,
                targetOpId:
                  (op.payload &&
                    (op.payload.targetOperationId ||
                      op.payload.undoOf ||
                      op.payload.redoOf)) ||
                  '',
                targetUid: normalized.uid,
                inversePatch: normalized.patch,
                serverAppliedEvent: (op.event && op.event.type) || op.type,
                originNodeDataAfter: true,
                rendererRefreshed: true
              })
              return Promise.resolve(applied).then(value => {
                const succeeded = value === true || !!(value && typeof value === 'object' && value.applied === true)
                if (!succeeded && this.isV2RevisionScopeCurrent(ackScope)) {
                  this.scheduleRemoteRecover(result.serverRevision)
                }
                return value
              }, err => {
                if (this.isV2RevisionScopeCurrent(ackScope)) this.scheduleRemoteRecover(result.serverRevision)
                throw err
              })
            }
            if (result && result.serverRevision != null) this.scheduleRemoteRecover(result.serverRevision)
          })
          .catch(err => {
            if (err && (err.code === 'UNDO_EMPTY' || err.code === 'REDO_EMPTY' || err.code === 'UNDO_PENDING')) {
              undoTrace('cooperate.undo.skip', { code: err.code, name })
              if (err.code === 'UNDO_PENDING' && this.mindMap) {
                this.mindMap.emit('undo_conflict', err)
              }
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
      }
      // Keep the canvas application in the same order as the adapter history.
      // Otherwise rapid clicks clear _v2UndoActive during the next operation.
      const previous = this._v2HistoryQueue || Promise.resolve()
      const next = previous.catch(() => {}).then(perform)
      this._v2HistoryQueue = next
      return next
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
    const uid = node.getData && node.getData('uid')
    const attachmentPatchPending =
      uid && this._pendingAttachmentPatchByUid &&
      this._pendingAttachmentPatchByUid.has(uid)
    return !!this.nodePatchPayload(node, {
      onlyChanged: true,
      forceGroups: attachmentPatchPending
        ? [fieldGroupOf('attachmentId')]
        : undefined
    })
  }

  isHttpTextRendererReady() {
    const renderer = this.mindMap && this.mindMap.renderer
    return !this._disposed && renderer && !renderer._destroyed &&
      renderer.root && renderer.root.nodeData === renderer.renderTree &&
      !renderer.isRendering && !renderer.renderTimer && !renderer.hasWaitRendering
  }

  collectNodesWithPendingText() {
    const renderer = this.mindMap.renderer
    if (!renderer) return []
    if (this.collabV2Adapter && this._pendingTextUids) {
      const pending = []
      this._pendingTextUids.forEach(uid => {
        const node = renderer.findNodeByUid(uid)
        if (!node && !this.isHttpTextRendererReady()) {
          // Full layout temporarily clears root/index. A missing instance here
          // is not a deleted model node; retry once a real render completes.
          this._httpTextFlushAfterRender = true
          return
        }
        if (node && this.hasUnsyncedLocalText(node)) pending.push(node)
        else this._pendingTextUids.delete(uid)
      })
      return pending
    }
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
    if (this._pendingAttachmentPatchByUid) {
      this._pendingAttachmentPatchByUid.forEach((_revision, uid) => {
        if (byUid.has(uid) || skipUid(uid)) return
        const node = renderer.findNodeByUid(uid)
        if (node && this.hasUnsyncedLocalText(node)) byUid.set(uid, node)
      })
    }
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
    // Explicitly queued local deltas are real edits. They must still be flushed
    // during the short post-remote settle window even when their node is not the
    // current selection, otherwise a fast exit (or an unselected node) can drop
    // the durable content operation. Key by the resolved owner uid so a queued
    // generalization uid cannot duplicate an already-active owner.
    if (this.collabV2Adapter && this._pendingTextUids) {
      this._pendingTextUids.forEach(uid => {
        const node = renderer.findNodeByUid(uid)
        if (!node) {
          if (!this.isHttpTextRendererReady()) this._httpTextFlushAfterRender = true
          else this._pendingTextUids.delete(uid)
          return
        }
        if (!this.hasUnsyncedLocalText(node)) return
        const target = this.resolveHttpPatchNode(node)
        const targetUid = target.getData && target.getData('uid')
        if (!targetUid || !this.lastPushed[targetUid]) return
        if (!byUid.has(targetUid)) byUid.set(targetUid, target)
      })
    }
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
    const content = collabNodeFeatures.buildNodeContentFields(data, prevFull)
    const imgMap =
      (this.mindMap &&
        this.mindMap.renderer &&
        this.mindMap.renderer.renderTree &&
        this.mindMap.renderer.renderTree.data &&
        this.mindMap.renderer.renderTree.data.imgMap) ||
      {}
    const full = {
      text: content.text,
      note: content.note,
      ...collectStyleFields(data, prevFull)
    }
    if (content.richText !== undefined) full.richText = content.richText
    if (content.richText) {
      collabNodeFeatures.publishRichTextPersistTrace({
        operationText: content.text,
        richTextFlag: true
      })
    }
    const imageFields = collabSpecialObjects.canonicalImageFields(
      data,
      imgMap,
      target.getImageUrl && target.getImageUrl.bind(target)
    )
    collabSpecialObjects.publishImageTrace({
      uid,
      command: 'node.update',
      imageBefore: prevFull && prevFull.image,
      imageAfter: imageFields.image,
      storedImageValue: imageFields.storedImageValue,
      imageTitle: imageFields.imageTitle,
      imageSize: imageFields.imageSize
    })
    NULLABLE_PATCH_KEYS.forEach(key => {
      let value = target.getData && target.getData(key)
      if (key === 'image') {
        if (imageFields.unresolvedKey || imageFields.skipTransient) return
        value = imageFields.image
      }
      if (key === 'generalization') value = collabGeneralization.ownerGeneralizationPayload(value)
      const empty =
        collabNodeFeatures.isEmptyFeatureValue(key, value) ||
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
    collabNodeFeatures.applyNullableGroupClears(full, data, prevFull)
    if (data.resetRichText && prevFull && full.text === prevFull.text) {
      // RichText prepares plain nodes for display on load. That flag alone
      // does not mean the user edited the text field group.
      if (prevFull.richText !== undefined) full.richText = prevFull.richText
      else delete full.richText
    }
    // Editors own independent drafts. Realtime preview/format normalization
    // must not race their guarded save through the background patch channel.
    if (uid && this.editSessionManager) {
      this.editSessionManager.list().forEach(session => {
        if (session.uid !== String(uid) ||
          (session.roomKey && session.roomKey !== this.httpRoomKey) ||
          !['editing', 'conflict'].includes(session.state)) return
        session.fields.forEach(field => {
          const baseline = this.currentData?.[uid]?.data || prevFull || {}
          if (Object.prototype.hasOwnProperty.call(baseline, field)) full[field] = baseline[field]
          else delete full[field]
        })
      })
    }
    if (!options.onlyChanged || !uid) return full
    const prev = this.lastPushed[uid]
    if (!prev || !prev.full) return full
    const previous = { ...prev.full }
    if (Object.prototype.hasOwnProperty.call(previous, 'generalization')) {
      previous.generalization = collabGeneralization.ownerGeneralizationPayload(previous.generalization)
    }
    const delta = patchDelta(previous, full)
    Object.keys(delta).forEach(field => {
      if (delta[field] === undefined) delete delta[field]
    })
    if (Array.isArray(options.forceGroups) && options.forceGroups.length) {
      keysForGroups(options.forceGroups).forEach(key => {
        const value = data[key]
        delta[key] =
          value === undefined || value === null || value === ''
            ? null
            : collabGeneralization.snapshotValue(value)
      })
    }
    return Object.keys(delta).length ? delta : null
  }

  flushHttpText() {
    this.flushHttpTextNow().catch(err => {
      console.error('[mind-map] text sync failed', err)
    })
  }

  // Exit-time durable handoff. The normal flush can be blocked awaiting an
  // earlier ACK (httpTextFlushPromise), which would strand the latest locally
  // edited delta when the editor is destroyed. Submit the latest pending delta
  // directly so its durable outbox row is written before teardown clears timers
  // and queues. The adapter serializes the actual send and the IndexedDB
  // transaction completes independently, so this is intentionally not awaited.
  flushLatestPendingForExit() {
    if (this._disposed || this.httpReplacing || !this.collabV2Adapter || typeof this.httpPatchNode !== 'function') return
    try {
      Promise.resolve(this.flushHttpTextOnce({ forExit: true })).catch(() => {})
    } catch (err) {
      // Exit must never throw.
    }
  }

  async flushHttpTextNow() {
    if (this.httpReplacing || !this.httpPatchNode) return
    if (this.httpTextFlushPromise) {
      this.httpTextFlushQueued = true
      const didFlush = await this.httpTextFlushPromise
      if (this.httpTextFlushQueued && !this.httpTextFlushPromise) {
        return this.flushHttpTextNow()
      }
      return !!didFlush
    }
    this.httpTextFlushing = true
    const run = (async () => {
      let didFlush = false
      try {
        do {
          this.httpTextFlushQueued = false
          didFlush = (await this.flushHttpTextOnce()) || didFlush
        } while (this.httpTextFlushQueued && !this._disposed)
        return didFlush
      } finally {
        this.httpTextFlushing = false
        this.httpTextFlushPromise = null
      }
    })()
    this.httpTextFlushPromise = run
    return run
  }

  async flushHttpTextOnce(options = {}) {
    const settling =
      this.httpSettlingAfterReplace || Date.now() < this.suppressLocalUntil
    const pending = settling
      ? this.collectActivePendingText()
      : this.collectNodesWithPendingText()
    if (options.forExit && !this.isHttpTextRendererReady() && this._pendingTextUids && this._pendingTextUids.size) {
      const renderer = this.mindMap && this.mindMap.renderer
      // Exit cannot wait for the layout that teardown is about to cancel. Reuse
      // only affected cached instances still backed by the exact current model;
      // same-UID replacements and deleted nodes must never become old writes.
      const current = indexTreeNodesByUid(renderer && renderer.renderTree)
      for (let i = pending.length - 1; i >= 0; i--) {
        const target = this.resolveHttpPatchNode(pending[i])
        const uid = target && target.getData && target.getData('uid')
        if (!uid || this.isTombstonedUid(uid) || current.get(uid) !== target.nodeData) pending.splice(i, 1)
      }
      const seen = new Set(pending.map(node => {
        const target = this.resolveHttpPatchNode(node)
        return target.getData && target.getData('uid')
      }))
      this._pendingTextUids.forEach(uid => {
        if (this.isTombstonedUid(uid)) return
        const node = renderer && renderer.nodeIndex && renderer.nodeIndex.get(uid)
        if (!node) return
        const target = this.resolveHttpPatchNode(node)
        const targetUid = target && target.getData && target.getData('uid')
        if (!targetUid || seen.has(targetUid) || this.isTombstonedUid(targetUid)) return
        if (current.get(targetUid) !== target.nodeData || !this.hasUnsyncedLocalText(target)) return
        pending.push(target)
        seen.add(targetUid)
      })
    }
    if (settling && !pending.length) return false
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
      const attachmentPatchRevision = this._pendingAttachmentPatchByUid &&
        this._pendingAttachmentPatchByUid.get(uid)
      const delta = this.nodePatchPayload(node, {
        onlyChanged: true,
        forceGroups: attachmentPatchRevision
          ? [fieldGroupOf('attachmentId')]
          : undefined
      })
      if (!delta) return
      // Skip a payload that is already in flight unchanged. Relying only on the
      // pending Set is not enough: an active node can be re-collected from
      // activeNodeList with a stale lastPushed baseline.
      const deltaKey = uid + '|' + JSON.stringify(delta)
      if (this._inflightTextKeys && this._inflightTextKeys.get(uid) === deltaKey) return
      if(this.fillRepairGuards?.has(uid))delta.expected=this.fillRepairGuards.get(uid)
      const snap = JSON.stringify(full)
      items.push({ uid, node, target, full, delta, snap, deltaKey, attachmentPatchRevision })
    })
    if (!this._inflightTextKeys) this._inflightTextKeys = new Map()
    items.forEach(item => this._inflightTextKeys.set(item.uid, item.deltaKey))
    if (this.collabV2Adapter && items.length > 1) {
      try {
        await this.submitV2('node.batch', {
          ops: items.map(item => ({
            type: 'node.update',
            payload: { uid: item.uid, ...item.delta }
          }))
        })
        if (this._disposed) {
          items.forEach(item => { if (this._inflightTextKeys.get(item.uid) === item.deltaKey) this._inflightTextKeys.delete(item.uid) })
          return true
        }
        items.forEach(item => {
          this.fillRepairGuards?.delete(item.uid)
          if (this._inflightTextKeys.get(item.uid) === item.deltaKey) this._inflightTextKeys.delete(item.uid)
          this.lastPushed[item.uid] = {
            text: item.full.text,
            note: item.full.note,
            full: collabGeneralization.snapshotValue(item.full),
            snap: item.snap
          }
          if (
            item.attachmentPatchRevision &&
            this._pendingAttachmentPatchByUid.get(item.uid) === item.attachmentPatchRevision
          ) {
            this._pendingAttachmentPatchByUid.delete(item.uid)
          }
        })
        return true
      } catch (err) {
        // Keep the delta retryable instead of silently losing it.
        items.forEach(item => { if (this._inflightTextKeys.get(item.uid) === item.deltaKey) this._inflightTextKeys.delete(item.uid) })
        console.error('[mind-map] batch style/text sync failed', err)
      }
      return false
    }
    let succeeded = false
    items.forEach(item => {
      const { uid, node, full, delta, snap } = item
      jobs.push(() =>
        this.httpPatchNode(uid, delta)
          .then(() => {
            // Delete only this submission's own key: an older ACK must not erase
            // a newer same-UID in-flight key.
            if (this._inflightTextKeys && this._inflightTextKeys.get(uid) === item.deltaKey) this._inflightTextKeys.delete(uid)
            if (this._disposed) return
            this.fillRepairGuards?.delete(uid)
            succeeded = true
            this.lastPushed[uid] = {
              text: full.text,
              note: full.note,
              full: collabGeneralization.snapshotValue(full),
              snap
            }
            if (
              item.attachmentPatchRevision &&
              this._pendingAttachmentPatchByUid.get(uid) === item.attachmentPatchRevision
            ) {
              this._pendingAttachmentPatchByUid.delete(uid)
            }
          })
          .catch(err => {
            // Keep the delta retryable rather than dropping it on a transient
            // enqueue/send failure, but do not erase a newer same-UID key.
            if (this._inflightTextKeys && this._inflightTextKeys.get(uid) === item.deltaKey) this._inflightTextKeys.delete(uid)
            if (this._disposed && err && err.code === 'ROOM_LEFT') return
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
    return succeeded
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
      if (this._lastPastedUids && this._lastPastedUids.size) {
        if (!this._lastPastedUids.has(row.uid)) return false
      }
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
      (node.children || []).forEach(child => this.collectUnpushedNodes(child, out))
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
      this.refreshCollapsedNodeCounts().catch(() => {})
    }
  }

  acknowledgeInsertedNode(row) {
    this.markUidPushed(row.uid, row.data || { text: row.text, note: row.note || '' }, 'ack')
    this.recentPushed.set(row.uid, Date.now())
    const renderer = this.mindMap && this.mindMap.renderer
    const node = renderer && renderer.findNodeByUid(row.uid)
    // Typing can finish while the insert ACK is still in flight. Only the
    // submitted snapshot is acknowledged; newer text must get its own update.
    if (node && this.hasUnsyncedLocalText(node)) {
      if (!this._pendingTextUids) this._pendingTextUids = new Set()
      this._pendingTextUids.add(row.uid)
      this.scheduleHttpTextSync()
    }
  }

  async flushHttpInsertNow(opts = {}) {
    const fromCommand = !!opts.fromCommand
    let records =
      this.collabV2Adapter && fromCommand && Array.isArray(opts.preRecords)
        ? opts.preRecords.slice()
        : []
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
    // Records may reference live node data. Freeze exactly what this insert
    // will send before any await, including top-level text/note overrides.
    records = records.map(row => ({
      ...row,
      data: collabGeneralization.snapshotValue({ ...(row.data || {}), text: row.text, note: row.note || '' })
    }))
    if (records.length) {
      const flushed = await this.flushHttpTextNow()
      if (flushed && this.httpFlushHistoryVersion) {
        try {
          await this.httpFlushHistoryVersion()
        } catch (err) {
          console.error('[mind-map] history boundary flush failed', err)
        }
      }
    }
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
          index: row.index,
          data: row.data || undefined
        }
      }))
      try {
        const submitted = await this.submitV2('node.batch', { ops })
        records.forEach(row => {
          this.acknowledgeInsertedNode(row)
        })
        const inverse = collabPasteUndo.pasteUndoInverse(ops)
        const insertedUids = records.map(row => row.uid)
        const roots = collabPasteUndo.forestRootsFromInserts(ops)
        collabPasteUndo.publishPasteUndoTrace({
          pasteOperationId:
            (submitted && (submitted.opId || submitted.operationId)) || '',
          type: 'node.batch',
          batchItems: ops.map(item => ({
            type: item.type,
            uid: item.payload.uid,
            parent: item.payload.parent
          })),
          insertedUids,
          pastedRoots: roots,
          inversePayload: inverse,
          undoGroupId:
            (submitted && submitted.opId) ||
            (this.collabV2Adapter &&
              this.collabV2Adapter.getStatus &&
              this.collabV2Adapter.getStatus().lastOpId) ||
            '',
          originalUids: Array.from(this._lastOriginalUids || [])
        })
        this._lastPastedUids = null
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
          index: row.index,
          data: row.data || undefined
        })
        this.acknowledgeInsertedNode(row)
      } catch (err) {
        const msg = String((err && err.message) || err)
        if (/节点已存在/.test(msg)) {
          this.acknowledgeInsertedNode(row)
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
      if (origin.position) {
        node.setData(origin.position)
        node.customLeft = origin.position.customLeft == null ? undefined : origin.position.customLeft
        node.customTop = origin.position.customTop == null ? undefined : origin.position.customTop
      }
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
      const positionPatch = collabMove.movePositionPatch(item.node)
      item.positionPatch = positionPatch
      const payload = {
        uid: item.uid,
        parent: item.parent,
        parentUid: item.parent,
        newParentUid: item.parent,
        index: item.index,
        oldParentUid: origin && origin.parent,
        oldIndex: origin && origin.index,
        patch: positionPatch,
        kind
      }
      const send = this.collabV2Adapter
        ? this.submitV2('node.move', payload)
        : this.httpPatchNode(item.uid, {
            parent: item.parent,
            index: item.index,
            ...collabMove.movePositionPatch(item.node)
          })
      return send
        .then(result => {
          this.baselineCommittedMovePatch(item, result)
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
            patch: collabMove.movePositionPatch(item.node),
            oldParentUid: originByUid.get(item.uid) && originByUid.get(item.uid).parent,
            oldIndex: originByUid.get(item.uid) && originByUid.get(item.uid).index,
            kind:
              originByUid.get(item.uid) &&
              originByUid.get(item.uid).parent === item.parent
                ? 'reorder'
                : 'move'
          }
        }))
      }).then(result => {
        moves.forEach(item => this.baselineCommittedMovePatch(item, result))
        return result
      }).catch(err => {
        console.error('[mind-map] batch move failed', err)
        this.mindMap.emit('collab_write_conflict', err)
        return this.projectDeferredView(true)
      })
    }
    return Promise.all(moves.map(submitOne))
  }

  // Baseline only the ACK-confirmed position fields of a committed move. Using
  // the committed patch (or the submitted position patch) instead of
  // rememberPushedNode(full live node) avoids marking unsent text as saved while
  // preventing a later flush from re-emitting isFloating/customLeft/customTop.
  baselineCommittedMovePatch(item, result) {
    const uid = item && item.uid
    if (!uid) return
    const prev = this.lastPushed && this.lastPushed[uid]
    if (!prev || !prev.full) return
    let patch = item && item.positionPatch
    const committed = result && result.operation && result.operation.payload
    if (committed) {
      if (committed.patch && (!committed.uid || committed.uid === uid)) patch = committed.patch
      else if (Array.isArray(committed.ops)) {
        const match = committed.ops.find(op => op && op.payload && op.payload.uid === uid)
        if (match && match.payload.patch) patch = match.payload.patch
      }
    }
    if (!patch || typeof patch !== 'object') return
    const fields = {}
    for (const key of ['customLeft', 'customTop', 'isFloating']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) fields[key] = patch[key]
    }
    if (!Object.keys(fields).length) return
    prev.full = { ...prev.full, ...fields }
    if (Object.prototype.hasOwnProperty.call(prev, 'snap')) prev.snap = JSON.stringify(prev.full)
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
    if (this._pendingAttachmentPatchByUid) this._pendingAttachmentPatchByUid.delete(uid)
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
    invalidateHydration(this, uid)
    this.forgetHttpUid(uid)
    if (!this.deletedUids) this.deletedUids = new Set()
    this.deletedUids.add(uid)
    if (!this.abandonedInsertUids) this.abandonedInsertUids = new Set()
    this.abandonedInsertUids.add(uid)
    this.recentHttpDeleted.set(uid, Date.now())
  }

  reviveDeletedUid(uid) {
    if (!uid) return
    invalidateHydration(this, uid)
    if (this.deletedUids) this.deletedUids.delete(uid)
    if (this.abandonedInsertUids) this.abandonedInsertUids.delete(uid)
    if (this.recentHttpDeleted) this.recentHttpDeleted.delete(uid)
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
    const imgMap =
      (this.mindMap &&
        this.mindMap.renderer &&
        this.mindMap.renderer.renderTree &&
        this.mindMap.renderer.renderTree.data &&
        this.mindMap.renderer.renderTree.data.imgMap) ||
      {}
    return trees.length ? collabPaste.cloneCopyTrees(trees, imgMap) : null
  }

  preparePasteTrees(input) {
    const imgMap =
      (this.mindMap &&
        this.mindMap.renderer &&
        this.mindMap.renderer.renderTree &&
        this.mindMap.renderer.renderTree.data &&
        this.mindMap.renderer.renderTree.data.imgMap) ||
      {}
    const prepared = collabPaste.preparePasteTrees(input, { imgMap })
    this._lastPasteIdentity = prepared.trace
    this._lastPastedUids = new Set(prepared.pastedUids || [])
    this._lastOriginalUids = new Set(prepared.originalUids || [])
    try {
      collabTreeIntegrity.checkTreeGraph(
        { root: { data: { uid: 'virtual-root', isRoot: true }, children: prepared.trees } },
        {
          originalUids: prepared.originalUids,
          pastedUids: prepared.pastedUids
        }
      )
    } catch (err) {
      // integrity logs TREE_GRAPH_INTEGRITY_FAILED
    }
    return prepared.trees
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
    return uids
  }

  // Count badges are read-only server projections. Structural events carry
  // node content, but do not refresh cached totals on every collapsed ancestor.
  // Fetch only badge owners and apply only counts; never replace edit baselines.
  async refreshCollapsedNodeCounts() {
    const renderer = this.mindMap && this.mindMap.renderer
    if (this._disposed || !this.httpCollabMode || !this.collabV2Adapter ||
      !this.httpFetchNodes || !renderer || !renderer.renderTree || this.httpInsertPromise) return false
    const status = this.collabV2Adapter.getStatus && this.collabV2Adapter.getStatus()
    if (status && (status.pendingCount || status.phase !== 'LIVE')) return false
    const tree = renderer.renderTree
    const indexed = indexTreeNodesByUid(tree)
    const uids = Array.from(indexed).filter(([, node]) =>
      node.data && node.data.expand === false &&
      ((node.children || []).length || Number(node.data.childCount) > 0 ||
        Number(node.data.descendantCount) > 0 || node.data.hasMore)
    ).map(([uid]) => uid).sort()
    if (!uids.length) return false
    const scope = { tree, room: this.httpRoomKey, adapter: this.collabV2Adapter,
      revision: Number(this.lastAppliedVersion) || 0, key: uids.join('|') }
    const same = other => other && other.tree === tree && other.room === scope.room &&
      other.adapter === scope.adapter && other.revision === scope.revision && other.key === scope.key
    if (same(this._badgeCountRefreshDone)) return false
    if (this._badgeCountRefreshPending) {
      this._badgeCountRefreshPending.queued = true
      return false
    }
    this._badgeCountRefreshPending = scope
    try {
      const nodes = await this.fetchHttpNodes(uids)
      if (this._disposed || renderer !== this.mindMap.renderer || tree !== renderer.renderTree ||
        scope.room !== this.httpRoomKey || scope.adapter !== this.collabV2Adapter ||
        scope.revision !== (Number(this.lastAppliedVersion) || 0)) return false
      nodes.forEach(item => {
        const raw = indexed.get(item.uid)
        if (!raw || !raw.data) return
        const counts = item.data || {}
        ;['childCount', 'descendantCount'].forEach(key => {
          if (Number.isInteger(counts[key]) && counts[key] >= 0) raw.data[key] = counts[key]
        })
        const node = renderer.findNodeByUid(item.uid)
        if (node && node.nodeData === raw && typeof node.updateExpandBtnNode === 'function') {
          node.updateExpandBtnNode()
        }
      })
      this._badgeCountRefreshDone = scope
      return true
    } finally {
      if (this._badgeCountRefreshPending === scope) this._badgeCountRefreshPending = null
      if (scope.queued && !this._disposed) this.refreshCollapsedNodeCounts().catch(() => {})
    }
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
    const last = Number(this.lastAppliedVersion) || 0
    if (extra.deferV2Watermark !== true) {
      if (Number.isFinite(next) && next === last + 1) {
        this.lastAppliedVersion = next
        if (this.collabStore) this.collabStore.setLastAppliedVersion(next)
      } else if (Number.isFinite(next) && next > last + 1) {
        this.scheduleRemoteRecover(next)
      }
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
    if (!this.httpCollabMode) {
      return { applied: false, skipped: true, reason: 'HTTP_COLLAB_DISABLED' }
    }
    options = { ...(this.httpPendingRecoverOptions || {}), ...(options || {}) }
    const backgroundRetry = options.__httpRecoverRetry === true
    delete options.__httpRecoverRetry
    let versionRestore =
      options.reason === 'VERSION_RESTORE' ||
      options.fullTreeReason === 'VERSION_RESTORE'
    const authoritativeRecovery =
      options.reason === 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
    const waitForVersionRestore = () =>
      new Promise(resolve => {
        if (!Array.isArray(this.httpRestoreWaiters)) {
          this.httpRestoreWaiters = []
        }
        const waiter = {
          version: Number(targetVersion) || 0,
          resolve,
          timer: null
        }
        waiter.timer = setTimeout(() => {
          this.httpRestoreWaiters = (this.httpRestoreWaiters || []).filter(
            pending => pending !== waiter
          )
          resolve({
            applied: false,
            timedOut: true,
            code: 'HTTP_HISTORY_RESTORE_TIMEOUT',
            version: waiter.version
          })
        }, HTTP_RECOVER_RESTORE_WAIT_MS)
        this.httpRestoreWaiters.push(waiter)
      })
    let plan = planCollabRecovery(this.lastAppliedVersion, targetVersion)
    // A restore operation can advance the revision before its UI result reaches
    // this editor. Equal revisions still need an authoritative tree refresh.
    if (plan.type === 'ignore' && (versionRestore || authoritativeRecovery)) {
      plan = {
        type: 'resnapshot',
        version: Number(targetVersion) || Number(this.lastAppliedVersion) || 0,
        reason: versionRestore
          ? 'VERSION_RESTORE'
          : 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
      }
    }
    if (plan.type === 'ignore') return { applied: false, skipped: true }
    if (this.httpRecovering) {
      this.httpRecoverQueued = true
      this.httpPendingRecoverVersion = Math.max(
        this.httpPendingRecoverVersion || 0,
        Number(targetVersion) || 0
      )
      if (options && Object.keys(options).length) {
        this.httpPendingRecoverOptions = {
          ...(this.httpPendingRecoverOptions || {}),
          ...options
        }
      }
      if (versionRestore) {
        return backgroundRetry
          ? { applied: false, queued: true }
          : waitForVersionRestore()
      }
      const turn = await this.waitForHttpRecoverTurn()
      if (turn !== 'released' && turn !== 'idle') {
        return {
          applied: false,
          deferred: true,
          queued: true,
          version: Number(targetVersion) || 0
        }
      }
      return this.recoverHttpCollab(
        Math.max(
          Number(targetVersion) || 0,
          Number(this.httpPendingRecoverVersion) || 0
        ),
        this.httpPendingRecoverOptions || options
      )
    }
    this.httpRecovering = true
    this.httpRecoverQueued = false
    clearTimeout(this.httpRecoverRetryTimer)
    this.httpRecoverRetryTimer = null
    if (options && Object.keys(options).length) {
      this.httpPendingRecoverOptions = {
        ...(this.httpPendingRecoverOptions || {}),
        ...options
      }
    }
    if (this.collabStore) this.collabStore.setStatus('recovering')
    let retryVersion = Number(plan.version) || Number(targetVersion) || 0
    let recoveredVersion = retryVersion
    let retryAllowed = true
    let refreshApplied = false
    let recoveryEvents = []
    try {
      let action = plan
      if (plan.type === 'fetch_operations' && this.httpFetchOperations) {
        try {
          const payload = await this.httpFetchOperations(plan.afterVersion)
          action = planAfterOperations(this.lastAppliedVersion, payload)
          if (
            action.type === 'resnapshot' &&
            hasVersionRestoreOperation(payload)
          ) {
            options = { ...options, reason: 'VERSION_RESTORE' }
            versionRestore = true
            this.httpPendingRecoverOptions = {
              ...(this.httpPendingRecoverOptions || {}),
              reason: 'VERSION_RESTORE'
            }
          }
        } catch (err) {
          action = {
            type: 'resnapshot',
            version: plan.version,
            reason: 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
          }
        }
      } else if (plan.type === 'fetch_operations') {
        action = {
          type: 'resnapshot',
          version: plan.version,
          reason: 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
        }
      }
      if (action.type === 'ignore') {
        if (versionRestore) {
          action = {
            type: 'resnapshot',
            version: Number(targetVersion) || Number(this.lastAppliedVersion) || 0
          }
        } else {
          return { applied: false, skipped: true }
        }
      }
      if (action.type === 'resnapshot' && !versionRestore) {
        options = {
          ...options,
          reason:
            action.reason ||
            'AUTHORITATIVE_SNAPSHOT_RECOVERY'
        }
        this.httpPendingRecoverOptions = {
          ...(this.httpPendingRecoverOptions || {}),
          reason: options.reason
        }
      }
      retryVersion = Number(action.version) || retryVersion
      recoveredVersion = retryVersion
      if (
        this.safeLoadMode &&
        action.type === 'resnapshot' &&
        options.reason !== 'AUTHORITATIVE_SNAPSHOT_RECOVERY' &&
        !versionRestore
      ) {
        retryAllowed = false
        return { applied: false, skipped: true, reason: 'SAFE_LOAD_RESNAPSHOT' }
      }
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
          recoveryEvents = this.collabStore.peekReadyEvents()
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
        const pendingRemote = action.operations.filter(op => {
          const event = (op && op.event) || op || {}
          const payload = event.payload || op.payload || {}
          const parent = payload.parentUid || payload.parent_uid || payload.parent
          const type = op.type || event.type
          return !this.deferUnloadedRemote(type, payload.uid, parent)
        })
        if (pendingRemote.length) {
          await this.syncHttpRemoteOperations(pendingRemote)
        }
      } else if (action.type === 'resnapshot') {
        this.markCollapsedLoadedDirty(action.version)
      }
      const busyBudget = authoritativeRecovery || versionRestore ? 20000 : 8000
      await this.waitUntilHttpRecoverIdle(busyBudget)
      let refreshed = await this.refreshVisibleFromHttp('', {
        force: true,
        allowReviveDeleted: versionRestore,
        targetVersion: retryVersion
      })
      if (refreshed && refreshed.deferred && (authoritativeRecovery || versionRestore)) {
        await this.waitUntilHttpRecoverIdle(busyBudget)
        refreshed = await this.refreshVisibleFromHttp('', {
          force: true,
          allowReviveDeleted: versionRestore,
          targetVersion: retryVersion
        })
      }
      if (refreshed && refreshed.deferred) {
        this.httpPendingRecoverVersion = Math.max(
          this.httpPendingRecoverVersion || 0,
          retryVersion
        )
        if (options && Object.keys(options).length) {
          this.httpPendingRecoverOptions = {
            ...(this.httpPendingRecoverOptions || {}),
            ...options
          }
        }
        return versionRestore && !backgroundRetry
          ? waitForVersionRestore()
          : { applied: false, deferred: true, version: retryVersion }
      }
      if (refreshed && refreshed.skipped && !refreshed.applied) {
        this.httpPendingRecoverVersion = Math.max(
          this.httpPendingRecoverVersion || 0,
          retryVersion
        )
        if (options && Object.keys(options).length) {
          this.httpPendingRecoverOptions = {
            ...(this.httpPendingRecoverOptions || {}),
            ...options
          }
        }
        return versionRestore && !backgroundRetry
          ? waitForVersionRestore()
          : { applied: false, skipped: true, version: retryVersion }
      }
      refreshApplied = !!(refreshed && refreshed.applied)
      if (!refreshApplied) {
        this.httpPendingRecoverVersion = Math.max(
          this.httpPendingRecoverVersion || 0,
          retryVersion
        )
        if (options && Object.keys(options).length) {
          this.httpPendingRecoverOptions = {
            ...(this.httpPendingRecoverOptions || {}),
            ...options
          }
        }
        return { applied: false, skipped: true, version: retryVersion }
      }
      const applied = Number(action.version)
      const refreshedVersion = Number(refreshed && refreshed.version)
      if (Number.isFinite(applied)) recoveredVersion = applied
      if (Number.isFinite(refreshedVersion) && refreshedVersion >= recoveredVersion) {
        recoveredVersion = refreshedVersion
      }
      if (this.collabStore && recoveryEvents.length) {
        const eventsToCommit = recoveryEvents.filter(
          event => Number(event.version) <= recoveredVersion
        )
        const committed = this.collabStore.commitReadyEvents(eventsToCommit)
        if (!committed.committed) {
          this.scheduleRemoteRecover(retryVersion)
          return { applied: false, skipped: true, reason: 'EVENT_COMMIT_GAP', version: retryVersion }
        }
      }
      if (Number.isFinite(recoveredVersion) && recoveredVersion > this.lastAppliedVersion) {
        this.lastAppliedVersion = recoveredVersion
      }
      if (this.collabStore && Number.isFinite(recoveredVersion)) {
        this.collabStore.setLastAppliedVersion(recoveredVersion)
      }
      if (Number.isFinite(recoveredVersion)) {
        this.stampLoadedSubtreeVersions(recoveredVersion)
      }
      return {
        applied: refreshApplied,
        skipped: !refreshApplied,
        version: Number(this.lastAppliedVersion) || Number(recoveredVersion) || 0
      }
    } catch (err) {
      this.httpPendingRecoverVersion = Math.max(
        this.httpPendingRecoverVersion || 0,
        retryVersion
      )
      if (options && Object.keys(options).length) {
        this.httpPendingRecoverOptions = {
          ...(this.httpPendingRecoverOptions || {}),
          ...options
        }
      }
      const terminalRestoreError =
        err &&
        (err.code === 'HTTP_HISTORY_NODE_MISSING' ||
          err.code === 'FORBIDDEN' ||
          err.statusCode === 401 ||
          err.statusCode === 403)
      if (versionRestore && !backgroundRetry && !terminalRestoreError) {
        return waitForVersionRestore()
      }
      if (versionRestore && terminalRestoreError) {
        retryAllowed = false
        const restoreWaiters = Array.isArray(this.httpRestoreWaiters)
          ? this.httpRestoreWaiters.splice(0)
          : []
        const result = {
          applied: false,
          code: err.code || 'HTTP_HISTORY_RESTORE_FAILED',
          error: err.message || '历史版本恢复加载失败',
          version: retryVersion
        }
        restoreWaiters.forEach(waiter => {
          clearTimeout(waiter.timer)
          waiter.resolve(result)
        })
      }
      throw err
    } finally {
      this.httpRecovering = false
      if (this.collabStore) this.collabStore.setStatus('live')
      const pending = this.httpPendingRecoverVersion
      const queuedWhileRecovering = this.httpRecoverQueued
      const restoreWaiters = Array.isArray(this.httpRestoreWaiters)
        ? this.httpRestoreWaiters
        : []
      this.httpRecoverQueued = false
      let forcedRestoreStarted = false
      if (restoreWaiters.length && versionRestore && refreshApplied) {
        const completedWaiters = restoreWaiters.filter(
          waiter => Number(waiter.version) <= recoveredVersion
        )
        const uncoveredWaiters = restoreWaiters.filter(
          waiter => Number(waiter.version) > recoveredVersion
        )
        this.httpRestoreWaiters = uncoveredWaiters
        const result = {
          applied: true,
          version: recoveredVersion
        }
        completedWaiters.forEach(waiter => {
          clearTimeout(waiter.timer)
          waiter.resolve(result)
        })
        if (uncoveredWaiters.length) {
          const restoreVersion = Math.max(
            Number(pending) || 0,
            ...uncoveredWaiters.map(waiter => Number(waiter.version) || 0)
          )
          const restoreOptions = {
            ...(this.httpPendingRecoverOptions || {}),
            reason: 'VERSION_RESTORE'
          }
          this.httpPendingRecoverVersion = 0
          this.httpPendingRecoverOptions = null
          forcedRestoreStarted = true
          this.recoverHttpCollab(restoreVersion, restoreOptions).catch(() => {})
        }
      } else if (restoreWaiters.length && !versionRestore) {
        const restoreVersion = Math.max(
          Number(pending) || 0,
          ...restoreWaiters.map(waiter => Number(waiter.version) || 0)
        )
        const restoreOptions = {
          ...(this.httpPendingRecoverOptions || {}),
          reason: 'VERSION_RESTORE'
        }
        this.httpPendingRecoverVersion = 0
        this.httpPendingRecoverOptions = null
        forcedRestoreStarted = true
        this.recoverHttpCollab(restoreVersion, restoreOptions).catch(() => {})
      }
      if (!forcedRestoreStarted) {
        const pendingOptions = this.httpPendingRecoverOptions || options || {}
        const pendingVersionRestore =
          pendingOptions.reason === 'VERSION_RESTORE' ||
          pendingOptions.fullTreeReason === 'VERSION_RESTORE'
        const pendingNeedsRestoreRetry =
          pendingVersionRestore && !refreshApplied
        if (pending <= this.lastAppliedVersion && !pendingNeedsRestoreRetry) {
          this.httpPendingRecoverVersion = 0
          this.httpPendingRecoverOptions = null
          clearTimeout(this.httpRecoverRetryTimer)
          this.httpRecoverRetryTimer = null
          this.httpRecoverRetryDelay = HTTP_RECOVER_RETRY_BASE_MS
        } else if (
          retryAllowed &&
          (pending > retryVersion ||
            (queuedWhileRecovering && pending > this.lastAppliedVersion))
        ) {
          // A newer event queued during recovery should be processed promptly.
          this.httpPendingRecoverVersion = 0
          this.scheduleRemoteRecover(pending, pendingOptions)
        } else if (retryAllowed) {
          // Retry transient failures and deferred refreshes with bounded backoff.
          this.scheduleHttpRecoverRetry(pending, pendingOptions)
        }
      }
      this.releaseHttpRecoverTurnWaiters('released')
    }
  }

  async refreshVisibleFromHttp(updatedAt, options = {}) {
    if (!this.httpCollabMode || !this.httpFetchNodes) {
      return { applied: false, skipped: true }
    }
    const force = !!options.force
    const allowReviveDeleted = options.allowReviveDeleted === true
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
    ]
    if (!uids.length) return { applied: false, skipped: true }
    pruneRecentMap(this.recentHttpDeleted)
    pruneRecentMap(this.recentPushed, RECENT_PUSH_GRACE_MS)
    this.httpRefreshing = true
    let applied = false
    try {
      const remoteNodes = await this.fetchHttpNodes(uids)
      if (allowReviveDeleted) {
        const currentRootUid = tree.data && tree.data.uid
        const serverRoot = remoteNodes.find(item => item && item.isRoot)
        if (!serverRoot || serverRoot.uid !== currentRootUid) {
          const restored = await this.restoreHttpTree({
            targetVersion: options.targetVersion
          })
          if (!restored || !restored.applied) {
            return { applied: false, skipped: true }
          }
          this.httpUpdatedAt = restored.updatedAt || this.httpUpdatedAt
          applied = true
          return {
            applied: true,
            skipped: false,
            version: restored.version,
            nodeCount: restored.nodeCount,
            treeReplaced: true
          }
        }
      }
      if (!remoteNodes.length) return { applied: false, skipped: true }
      const treeNodesByUid = indexTreeNodesByUid(tree)
      // Match Render.findNodeByUid while building the index only once, including
      // rendered summary/generalization nodes and their nested children.
      const renderedNodesByUid = indexRenderedNodesByUid(renderer.root)
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
        const serverChildrenByParent = new Map()
        remoteNodes.forEach(item => {
          const node = renderedNodesByUid.get(item.uid)
          const data = item.data || {}
          if (node && node !== editing) {
            const localData = (node.getData && node.getData()) || {}
            const merged = applyRemoteNodeData(localData, data)
            const next = publicNodeData(merged.data)
            const content = collabNodeFeatures.buildNodeContentFields(next)
            const text = content.text
            const note = content.note
            const prev = this.lastPushed[item.uid]
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
                    richText: next.richText || undefined,
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
          const treeNode = treeNodesByUid.get(item.uid)
          if (!treeNode) return
          const previousGeneralizationChildren = (treeNode.children || []).slice()
          if (
            this.syncGeneralizationChildStubs(
              treeNode,
              treeNode.data || {},
              item.data || {}
            )
          ) {
            const currentGeneralizationChildren = new Set(treeNode.children || [])
            previousGeneralizationChildren.forEach(child => {
              if (!currentGeneralizationChildren.has(child)) {
                removeTreeNodesFromUidIndex(child, treeNodesByUid)
              }
            })
            changed = true
          }
          const serverKids = item.children || []
          serverChildrenByParent.set(item.uid, serverKids)
          if (allowReviveDeleted) {
            serverKids.forEach(uid => this.reviveDeletedUid(uid))
          }
          const keep = new Set(serverKids)
          const have = new Set(
            (treeNode.children || [])
              .map(child => child && child.data && child.data.uid)
              .filter(Boolean)
          )
          const need = serverKids.filter(
            id =>
              id &&
              !have.has(id) &&
              (allowReviveDeleted || !this.isTombstonedUid(id))
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
          const order = new Map(serverKids.map((id, index) => [id, index]))
          next.sort((a, b) => {
            const ai = order.get(a && a.data && a.data.uid)
            const bi = order.get(b && b.data && b.data.uid)
            if (ai == null && bi == null) return 0
            if (ai == null) return 1
            if (bi == null) return -1
            return ai - bi
          })
          const childrenChanged =
            next.length !== prevKids.length ||
            next.some((child, index) => child !== prevKids[index])
          if (childrenChanged) {
            if (next.length !== prevKids.length) {
              prevKids.filter(child => !next.includes(child)).forEach(child => {
                this.dropHttpTree(child)
                removeTreeNodesFromUidIndex(child, treeNodesByUid)
              })
            }
            treeNode.children = next
            changed = true
          }
          if (treeNode.data) {
            const descendantCount = item.data && item.data.descendantCount
            if (Number.isInteger(descendantCount) && descendantCount >= 0 &&
              treeNode.data.descendantCount !== descendantCount) {
              treeNode.data.descendantCount = descendantCount
              if (node && node.nodeData && node.nodeData.data) {
                node.nodeData.data.descendantCount = descendantCount
              }
              changed = true
            }
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
          // Fetch missing nodes a level at a time. Only descend through nodes
          // whose parent and node are expanded, so collapsed branches retain
          // lazy loading while restored expanded branches render completely.
          let frontier = missingFor
          while (frontier.size) {
            const requested = [
              ...new Set(Array.from(frontier.values()).flat())
            ]
            const byUid = new Map()
            const extraNodes = await this.fetchHttpNodes(requested)
            extraNodes.forEach(item => byUid.set(item.uid, item))

            // Fallback to the authoritative parent subtree if a batch lookup
            // misses a just-restored node.
            for (const [parentUid, childIds] of frontier) {
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
                        .map(item =>
                          typeof item === 'string'
                            ? item
                            : item && item.data && item.data.uid
                        )
                        .filter(Boolean)
                    })
                  }
                )
              } catch (err) {
                console.error('[mind-map] subtree fallback failed', err)
              }
            }
            const unresolved = []
            frontier.forEach((childIds, parentUid) => {
              childIds.forEach(id => {
                if (!byUid.has(id)) unresolved.push({ id, parentUid })
              })
            })
            if (unresolved.length) {
              const err = new Error(
                `history refresh could not fetch ${unresolved.length} restored node(s)`
              )
              err.code = 'HTTP_HISTORY_NODE_MISSING'
              err.uids = unresolved.map(item => item.id)
              throw err
            }

            const nextFrontier = new Map()
            frontier.forEach((childIds, parentUid) => {
              const parent = treeNodesByUid.get(parentUid)
              if (!parent) return
              const previousChildren = new Set(parent.children || [])
              const stubs = childIds
                .map(id => byUid.get(id))
                .filter(Boolean)
                .map(item => {
                  const serverKids = Array.isArray(item.children)
                    ? item.children.filter(Boolean)
                    : null
                  return {
                    data: {
                      ...(item.data || {}),
                      uid: item.uid,
                      childCount:
                        serverKids != null
                          ? serverKids.length
                          : Number((item.data && item.data.childCount) || 0)
                    },
                    children: []
                  }
                })
              this.mergeHttpChildren(parent, stubs)
              const addedChildren = (parent.children || []).filter(
                child => !previousChildren.has(child)
              )
              if (addedChildren.length) {
                addedChildren.forEach(child =>
                  indexTreeNodesByUid(child, treeNodesByUid)
                )
                changed = true
              }

              const fullOrder =
                serverChildrenByParent.get(parentUid) || childIds
              const order = new Map(fullOrder.map((id, index) => [id, index]))
              if (Array.isArray(parent.children) && childIds.length) {
                parent.children.sort((a, b) => {
                  const ai = order.get(a && a.data && a.data.uid)
                  const bi = order.get(b && b.data && b.data.uid)
                  if (ai == null && bi == null) return 0
                  if (ai == null) return 1
                  if (bi == null) return -1
                  return ai - bi
                })
              }

              const childrenByUid = new Map(
                (parent.children || [])
                  .map(child => [child && child.data && child.data.uid, child])
                  .filter(([uid]) => !!uid)
              )
              childIds.forEach(id => {
                const item = byUid.get(id)
                const child = childrenByUid.get(id)
                if (!item || !child) return
                const serverKids = Array.isArray(item.children)
                  ? item.children.filter(Boolean)
                  : []
                serverChildrenByParent.set(id, serverKids)
                if (allowReviveDeleted) {
                  serverKids.forEach(uid => this.reviveDeletedUid(uid))
                }
                if (
                  !serverKids.length ||
                  parent.data && parent.data.expand === false ||
                  child.data && child.data.expand === false
                ) {
                  return
                }
                const have = new Set(
                  (child.children || [])
                    .map(current => current && current.data && current.data.uid)
                    .filter(Boolean)
                )
                const need = serverKids.filter(
                  uid =>
                    uid &&
                    !have.has(uid) &&
                    (allowReviveDeleted || !this.isTombstonedUid(uid))
                )
                if (need.length) nextFrontier.set(id, need)
              })
            })
            frontier = nextFrontier
          }
        }
        if (changed) {
          await this.syncHttpDirtySubtrees(treeNodesByUid)
          await new Promise(resolve => {
            this.requestRemoteApplyRender(Array.from(treeNodesByUid.keys()), resolve)
          })
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
    if (!renderer.findNodeByUid(uid) && !this.findTreeNode(renderer.renderTree, uid)) {
      this.httpHydrating = true
      try {
        // Hydrate the data path: collapsed ancestors have no rendered instance.
        await this.ensureHttpNodePath(uid)
        this.mindMap.emit('personal_expand_change', { source: 'reveal' })
        await new Promise(resolve => this.mindMap.render(resolve))
      } finally {
        this.httpHydrating = false
        this.flushPendingHttpRefresh()
      }
    }
    // Wait for every ancestor to be expanded and laid out before resolving UID.
    await new Promise(resolve => renderer.expandToNodeUid(uid, resolve))
    const target = renderer.findNodeByUid(uid)
    if (target) {
      await new Promise(resolve => {
        this.mindMap.execCommand('GO_TARGET_NODE', uid, resolve)
      })
    }
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
    this.flushLatestPendingForExit()
    this._disposed = true
    this.resetLocalIntentState()
    this.unBindEvent()
  }

  // 插件被卸载前做的事情
  beforePluginDestroy() {
    this.flushLatestPendingForExit()
    this._disposed = true
    this.resetLocalIntentState()
    this.unBindEvent()
  }
}

Cooperate.instanceName = 'cooperate'

export default Cooperate
