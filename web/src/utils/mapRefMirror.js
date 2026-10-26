import { createUid } from 'simple-mind-map/src/utils/index'
import { normalizeMapRef, isMirrorMapRef } from '@/utils/mapRefNav'
import {
  getFileSubtree,
  getMapVersion,
  addFileNode,
  patchFileNode,
  deleteFileNode
} from '@/utils/fileApi'
import { copyNodeAttachments } from '@/utils/copyNodeAttachments'

const MAX_MIRROR_NODES = 2000
const POLL_MS = 2500
let suppressForwardDepth = 0

export function withMirrorForwardSuppressed(fn) {
  suppressForwardDepth += 1
  try {
    return fn()
  } finally {
    suppressForwardDepth -= 1
  }
}

async function withMirrorForwardSuppressedAsync(fn) {
  suppressForwardDepth += 1
  try {
    return await fn()
  } finally {
    suppressForwardDepth -= 1
  }
}

/**
 * 镜像 poll/apply 期间：禁止 Cooperate 把 execCommand 当成本地协同写出，
 * 否则源图变更会被翻成宿主房间的 insert/patch，引发冲突与重复子树。
 */
function withCollabRemoteApply(mindMap, fn) {
  const cooperate = mindMap && mindMap.cooperate
  const prev = cooperate ? !!cooperate.isApplyingRemote : false
  if (cooperate) cooperate.isApplyingRemote = true
  try {
    return fn()
  } finally {
    if (cooperate) cooperate.isApplyingRemote = prev
  }
}

async function withCollabRemoteApplyAsync(mindMap, fn) {
  const cooperate = mindMap && mindMap.cooperate
  const prev = cooperate ? !!cooperate.isApplyingRemote : false
  if (cooperate) cooperate.isApplyingRemote = true
  try {
    return await fn()
  } finally {
    if (cooperate) cooperate.isApplyingRemote = prev
  }
}

/** 给整棵待插入树打 inserting，避免 V2 在 knownUids 为空时过滤掉新节点 */
function markInsertingTree(trees) {
  const walk = list => {
    ;(list || []).forEach(node => {
      if (!node || !node.data) return
      node.data.inserting = true
      if (node.children && node.children.length) walk(node.children)
    })
  }
  walk(trees)
  return trees
}

function ensureHostActive(mindMap, node) {
  const renderer = mindMap && mindMap.renderer
  if (!renderer || !node) return
  const list = renderer.activeNodeList || []
  if (list.indexOf(node) >= 0) return
  if (typeof renderer.addNodeToActiveList === 'function') {
    renderer.addNodeToActiveList(node)
    if (typeof renderer.emitNodeActiveEvent === 'function') {
      renderer.emitNodeActiveEvent()
    }
  }
}

// 保留 attachment*：引用子节点时要把产物附件一起带过来（跨房再物理复制）
const STRIP_DATA_KEYS = [
  'mapRef',
  'comments',
  'comment',
  'imgMap',
  'subtreeVersion',
  'hasMore',
  '_mirrorOrigin'
]

const ATTACHMENT_META_KEYS = [
  'attachmentId',
  'attachmentUrl',
  'attachmentName',
  'attachmentMime',
  'attachmentMimeType',
  'attachmentSize',
  'attachmentStatus',
  'attachmentError',
  'attachmentExtractedText',
  'attachmentProgress',
  'attachmentErrorIgnored',
  'attachment'
]

function pickAttachmentMeta(data) {
  const src = data && typeof data === 'object' ? data : {}
  const out = {}
  ATTACHMENT_META_KEYS.forEach(key => {
    if (src[key] != null && src[key] !== '') out[key] = src[key]
  })
  return out
}

function stripAttachmentMetaDeep(trees) {
  const walk = list => {
    ;(list || []).forEach(node => {
      if (!node || !node.data) return
      ATTACHMENT_META_KEYS.forEach(key => {
        delete node.data[key]
      })
      if (node.children && node.children.length) walk(node.children)
    })
  }
  walk(trees)
  return trees
}

function countAttachmentNodes(trees) {
  let n = 0
  const walk = list => {
    ;(list || []).forEach(node => {
      if (!node || !node.data) return
      if (node.data.attachmentId) n += 1
      if (node.children && node.children.length) walk(node.children)
    })
  }
  walk(trees)
  return n
}

function currentRoomKey(mindMap) {
  return String(
    (mindMap && mindMap.cooperate && mindMap.cooperate.httpRoomKey) ||
      (mindMap && mindMap.opt && (mindMap.opt.roomKey || mindMap.opt.room_key)) ||
      ''
  ).trim()
}

/**
 * 把源房附件复制到当前房，并改写树上的 attachmentId。
 * 失败时剥掉附件字段，避免指向源房失效 ID。
 */
async function transferTreeAttachments(
  trees,
  sourceRoom,
  destRoom,
  onTransferStart
) {
  const list = Array.isArray(trees) ? trees : trees ? [trees] : []
  if (!list.length) {
    return { trees: list, copied: 0, error: '' }
  }
  const src = String(sourceRoom || '').trim()
  const dest = String(destRoom || '').trim()
  if (!src || !dest || src === dest) {
    return { trees: list, copied: countAttachmentNodes(list), error: '' }
  }
  const before = countAttachmentNodes(list)
  if (!before) return { trees: list, copied: 0, error: '' }
  try {
    const copiedTrees = await copyNodeAttachments(
      { data: list, sourceRoom: src },
      dest,
      onTransferStart
    )
    return {
      trees: copiedTrees,
      copied: countAttachmentNodes(copiedTrees),
      error: ''
    }
  } catch (err) {
    stripAttachmentMetaDeep(list)
    return {
      trees: list,
      copied: 0,
      error: (err && err.message) || '附件复制失败'
    }
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function cloneData(data) {
  const src = data && typeof data === 'object' ? data : {}
  const next = { ...src }
  STRIP_DATA_KEYS.forEach(key => {
    delete next[key]
  })
  return next
}

function invertUidMap(uidMap) {
  const out = {}
  Object.keys(uidMap || {}).forEach(local => {
    const peer = uidMap[local]
    if (peer) out[String(peer)] = String(local)
  })
  return out
}

/**
 * 深读目标节点子树（含根）。
 */
export async function fetchMirrorTree(mapId, nodeId, options = {}) {
  const maxNodes = Math.min(
    MAX_MIRROR_NODES,
    Math.max(1, Number(options.maxNodes) || MAX_MIRROR_NODES)
  )
  const params = {
    deep: true,
    maxNodes,
    timeoutMs: options.timeoutMs || 60000
  }
  if (options.knownVersion != null) {
    params.knownVersion = options.knownVersion
  }
  const data = await getFileSubtree(mapId, nodeId, params)
  if (!data || data.missing || data.notFound) {
    const err = new Error('target node missing')
    err.code = 'MISSING_NODE'
    throw err
  }
  if (data.unchanged) {
    return {
      tree: null,
      truncated: false,
      version: Number(data.version) || 0,
      unchanged: true,
      nodeCount: 0
    }
  }
  const tree = (data && data.tree) || null
  if (!tree) {
    const err = new Error('empty subtree')
    err.code = 'EMPTY_SUBTREE'
    throw err
  }
  return {
    tree,
    truncated: !!data.truncated,
    version: Number(data.version) || 0,
    unchanged: false,
    nodeCount: Number(data.node_count) || 0
  }
}

/**
 * 把目标根节点映射到宿主，子树全部 remap 新 uid。
 * 返回可 INSERT_MULTI_CHILD_NODE 的 children，以及完整 uidMap（含宿主↔目标根）。
 */
export function buildRemappedChildren(peerTree, hostUid, peerRootUid) {
  const uidMap = {}
  const rootPeerUid = String(
    peerRootUid ||
      (peerTree && peerTree.data && peerTree.data.uid) ||
      ''
  ).trim()
  const host = String(hostUid || '').trim()
  if (!host || !rootPeerUid || !peerTree) {
    return {
      children: [],
      uidMap,
      rootText: '',
      rootNote: '',
      rootAttachment: {}
    }
  }
  uidMap[host] = rootPeerUid

  const remapNode = (node, depth) => {
    if (!node || !node.data) return null
    const peerUid = String(node.data.uid || '').trim()
    const localUid = createUid()
    if (peerUid) uidMap[localUid] = peerUid
    const data = cloneData(node.data)
    data.uid = localUid
    data.richText = false
    data.resetRichText = true
    data.inserting = true
    data.text = stripHtml(data.text) || '(空)'
    data.expand = depth < 2
    const children = (node.children || [])
      .map(child => remapNode(child, depth + 1))
      .filter(Boolean)
    data.childCount = children.length
    return { data, children }
  }

  const children = (peerTree.children || [])
    .map(child => remapNode(child, 0))
    .filter(Boolean)

  return {
    children,
    uidMap,
    rootText: stripHtml(peerTree.data && peerTree.data.text) || '',
    rootNote: String((peerTree.data && peerTree.data.note) || ''),
    rootAttachment: pickAttachmentMeta(peerTree.data)
  }
}

function collectMirrorHosts(mindMap) {
  const hosts = []
  if (!mindMap || !mindMap.renderer) return hosts
  const root = mindMap.renderer.root
  if (!root) return hosts
  const walk = node => {
    if (!node || typeof node.getData !== 'function') return
    const ref = normalizeMapRef(node.getData('mapRef'))
    if (isMirrorMapRef(ref) && ref.uidMap) {
      hosts.push({
        node,
        uid: String(node.getData('uid') || ''),
        ref
      })
    }
    ;(node.children || []).forEach(walk)
  }
  walk(root)
  return hosts
}

function findMirrorForLocalUid(hosts, localUid) {
  const uid = String(localUid || '')
  if (!uid) return null
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]
    const map = host.ref && host.ref.uidMap
    if (map && map[uid]) return { ...host, peerUid: map[uid] }
  }
  return null
}

function findMirrorForPeerUid(hosts, peerUid, mapId) {
  const uid = String(peerUid || '')
  const room = String(mapId || '')
  if (!uid) return null
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]
    if (room && host.ref.mapId !== room) continue
    const map = host.ref && host.ref.uidMap
    if (!map) continue
    const local = Object.keys(map).find(k => map[k] === uid)
    if (local) return { ...host, localUid: local, peerUid: uid }
  }
  return null
}

function extractCommandUids(name, args, mindMap) {
  const uids = []
  const pushNode = node => {
    if (!node) return
    if (typeof node.getData === 'function') {
      const uid = node.getData('uid')
      if (uid) uids.push(String(uid))
      return
    }
    if (typeof node === 'string') uids.push(node)
    if (node && node.data && node.data.uid) uids.push(String(node.data.uid))
  }
  const list = args && args[0]
  if (Array.isArray(list)) list.forEach(pushNode)
  else pushNode(list)
  if (
    !uids.length &&
    mindMap &&
    mindMap.renderer &&
    mindMap.renderer.activeNodeList
  ) {
    mindMap.renderer.activeNodeList.forEach(pushNode)
  }
  // INSERT: parent is args[0], new nodes may be in tree under parent after command
  return [...new Set(uids.filter(Boolean))]
}

function parentUidOf(node) {
  if (!node || !node.parent || typeof node.parent.getData !== 'function') {
    return ''
  }
  return String(node.parent.getData('uid') || '')
}

/**
 * 绑定后植入镜像子树：挂到宿主下，并写回带 uidMap 的 mapRef。
 */
export async function implantMirrorSubtree({
  mindMap,
  node,
  mapRef,
  title,
  onProgress
}) {
  const ref = normalizeMapRef(mapRef)
  if (!isMirrorMapRef(ref)) {
    return { ok: false, error: 'not mirror', mapRef: ref }
  }
  const hostUid = String((node && node.getData && node.getData('uid')) || '')
  if (!hostUid) return { ok: false, error: 'host uid missing', mapRef: ref }

  if (typeof onProgress === 'function') onProgress('fetch')
  const fetched = await fetchMirrorTree(ref.mapId, ref.nodeId)
  let {
    children,
    uidMap,
    rootText,
    rootNote,
    rootAttachment
  } = buildRemappedChildren(fetched.tree, hostUid, ref.nodeId)

  const destRoom = currentRoomKey(mindMap)
  let attachmentCopied = 0
  let attachmentError = ''
  if (typeof onProgress === 'function') onProgress('attachments')
  // 子树产物：跨房复制附件文件，改写为当前房 attachmentId
  {
    const transferred = await transferTreeAttachments(
      children,
      ref.mapId,
      destRoom,
      () => typeof onProgress === 'function' && onProgress('attachments')
    )
    children = transferred.trees
    attachmentCopied += transferred.copied
    if (transferred.error) attachmentError = transferred.error
  }
  // 定位根自身若挂了产物，一并复制到宿主节点
  if (rootAttachment && rootAttachment.attachmentId) {
    const rootShell = [{ data: { ...rootAttachment }, children: [] }]
    const transferred = await transferTreeAttachments(
      rootShell,
      ref.mapId,
      destRoom,
      () => typeof onProgress === 'function' && onProgress('attachments')
    )
    rootAttachment = pickAttachmentMeta(
      transferred.trees[0] && transferred.trees[0].data
    )
    attachmentCopied += transferred.copied
    if (transferred.error && !attachmentError) {
      attachmentError = transferred.error
    }
  } else {
    rootAttachment = {}
  }

  const nextRef = {
    mapId: ref.mapId,
    nodeId: ref.nodeId,
    type: 'node',
    syncMode: 'mirror',
    mirrorRootUid: hostUid,
    uidMap,
    peerVersion: fetched.version || null
  }

  const displayText =
    String(title || rootText || ref.nodeId || '子脑图').trim() || '子脑图'

  // 植入过程禁止转发，避免删旧子树 / 批量插入时误改原图
  return withMirrorForwardSuppressedAsync(async () => {
    const existingKids = [...((node && node.children) || [])]
    if (existingKids.length) {
      mindMap.execCommand('REMOVE_NODE', existingKids)
    }

    mindMap.renderer.setNodeDataRender(node, {
      mapRef: nextRef,
      text: displayText,
      note: rootNote || undefined,
      richText: false,
      resetRichText: true,
      shape: 'roundedRectangle',
      fillColor: '#F2F3F5',
      borderColor: 'transparent',
      borderWidth: 0,
      color: '#1F2329',
      fontSize: 14,
      fontWeight: 'normal',
      paddingX: 10,
      paddingY: 8,
      expand: true,
      ...rootAttachment
    })
    mindMap.execCommand('SET_NODE_MAP_REF', node, nextRef)
    if (rootAttachment && rootAttachment.attachmentId) {
      mindMap.execCommand(
        'SET_NODE_ATTACHMENT',
        node,
        rootAttachment.attachmentUrl || '',
        rootAttachment.attachmentName || '',
        rootAttachment
      )
    }

    if (children.length) {
      if (typeof onProgress === 'function') onProgress('insert')
      const cooperate = mindMap.cooperate
      if (
        cooperate &&
        typeof cooperate.ensurePlacementParent === 'function'
      ) {
        try {
          await cooperate.ensurePlacementParent(node)
        } catch (e) {
          /* continue */
        }
      }
      // 宿主必须进 activeNodeList，否则 V2 snapshot 拿不到 knownUids，
      // INSERT_MULTI_CHILD_NODE 又没带 inserting 时整树会被滤掉 →「节点没引用过来」
      ensureHostActive(mindMap, node)
      markInsertingTree(children)
      mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], children)
    }

    return {
      ok: true,
      mapRef: nextRef,
      truncated: fetched.truncated,
      nodeCount: fetched.nodeCount,
      childCount: children.length,
      attachmentCopied,
      attachmentError
    }
  })
}

export class MapRefMirrorSync {
  constructor({ mindMap, sourceRoomKey, onMessage } = {}) {
    this.mindMap = mindMap
    this.sourceRoomKey = String(sourceRoomKey || '')
    this.onMessage = typeof onMessage === 'function' ? onMessage : null
    this._timer = null
    this._busy = false
    this._applyingRemote = false
    this._forwarding = false
    this._stopped = false
    this._peerCursor = new Map() // mapId -> version
    this._bound = false
    this._onAfterExecCommand = this._onAfterExecCommand.bind(this)
  }

  start() {
    if (this._stopped) return
    if (!this.mindMap || this._bound) return
    this.mindMap.on('afterExecCommand', this._onAfterExecCommand)
    this._bound = true
    this._scanPeerCursors()
    this._timer = setInterval(() => this._pollPeers(), POLL_MS)
    // 首次稍延迟拉一次
    setTimeout(() => this._pollPeers(), 800)
  }

  stop() {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._bound && this.mindMap) {
      try {
        this.mindMap.off('afterExecCommand', this._onAfterExecCommand)
      } catch (e) {
        /* ignore */
      }
    }
    this._bound = false
  }

  refreshHosts() {
    this._scanPeerCursors()
  }

  _notify(type, detail) {
    if (this.onMessage) {
      try {
        this.onMessage(type, detail)
      } catch (e) {
        /* ignore */
      }
    }
  }

  _scanPeerCursors() {
    const hosts = collectMirrorHosts(this.mindMap)
    hosts.forEach(host => {
      const mapId = host.ref.mapId
      if (!this._peerCursor.has(mapId)) {
        const v = Number(host.ref.peerVersion) || 0
        this._peerCursor.set(mapId, v)
      }
    })
  }

  // Command 发出的是 (name, ...args)，不是 { name, args }
  _onAfterExecCommand(name, ...args) {
    if (
      this._applyingRemote ||
      this._forwarding ||
      this._stopped ||
      suppressForwardDepth > 0
    ) {
      return
    }
    if (!name || typeof name !== 'string') return
    // 等本房间协同刷完再转发，避免抢在本地 insert ack 前
    Promise.resolve()
      .then(() => this._forwardLocalCommand(name, args))
      .catch(err => {
        console.warn('[mapRefMirror] forward failed', err)
        this._notify('forwardError', { error: (err && err.message) || String(err) })
      })
  }

  async _forwardLocalCommand(name, args) {
    if (this._applyingRemote || this._stopped || suppressForwardDepth > 0) return
    const hosts = collectMirrorHosts(this.mindMap)
    if (!hosts.length) return

    const structuralInsert =
      name === 'INSERT_CHILD_NODE' ||
      name === 'INSERT_MULTI_CHILD_NODE' ||
      name === 'INSERT_NODE' ||
      name === 'INSERT_MULTI_NODE'
    const structuralRemove =
      name === 'REMOVE_NODE' || name === 'REMOVE_CURRENT_NODE'
    const textLike =
      name === 'SET_NODE_TEXT' ||
      name === 'SET_NODE_NOTE' ||
      name === 'SET_NODE_DATA' ||
      name === 'SET_NODE_STYLES' ||
      name === 'SET_NODE_STYLE'

    if (!structuralInsert && !structuralRemove && !textLike) return

    this._forwarding = true
    try {
      if (structuralInsert) {
        await this._forwardInserts(hosts, args)
        return
      }
      if (structuralRemove) {
        await this._forwardRemoves(hosts, args)
        return
      }
      await this._forwardPatches(hosts, name, args)
    } finally {
      this._forwarding = false
    }
  }

  async _persistUidMap(host, { asRemote = false } = {}) {
    const node = host.node
    if (!node || typeof node.getData !== 'function') return
    const live =
      (this.mindMap.renderer &&
        this.mindMap.renderer.findNodeByUid &&
        this.mindMap.renderer.findNodeByUid(host.uid)) ||
      node
    const ref = normalizeMapRef(live.getData('mapRef'))
    if (!isMirrorMapRef(ref)) return
    const next = {
      ...ref,
      uidMap: { ...(host.ref.uidMap || {}) },
      mirrorRootUid: host.uid || ref.mirrorRootUid
    }
    // 同步内存中的 host.ref
    host.ref = next
    const apply = () => {
      live.setData({ mapRef: next })
      this.mindMap.execCommand('SET_NODE_MAP_REF', live, next)
    }
    this._applyingRemote = true
    try {
      if (asRemote) withCollabRemoteApply(this.mindMap, apply)
      else apply()
    } finally {
      this._applyingRemote = false
    }
  }

  async _forwardInserts(hosts, args) {
    const parents = Array.isArray(args && args[0])
      ? args[0]
      : args && args[0]
        ? [args[0]]
        : (this.mindMap.renderer.activeNodeList || [])
    for (const parent of parents) {
      if (!parent || typeof parent.getData !== 'function') continue
      const parentUid = String(parent.getData('uid') || '')
      const hit = findMirrorForLocalUid(hosts, parentUid)
      if (!hit) continue
      const kids = parent.children || []
      for (const child of kids) {
        if (!child || typeof child.getData !== 'function') continue
        const localUid = String(child.getData('uid') || '')
        if (!localUid) continue
        if (hit.ref.uidMap && hit.ref.uidMap[localUid]) continue
        // 新插入的本地节点 → 在目标房创建
        const text = stripHtml(child.getData('text'))
        const note = child.getData('note')
        const peerParent = hit.ref.uidMap[parentUid]
        if (!peerParent) continue
        try {
          const res = await addFileNode(hit.ref.mapId, {
            parent: peerParent,
            parent_uid: peerParent,
            text: text || '(空)',
            note: note || undefined,
            originMirror: this.sourceRoomKey
          })
          const peerUid =
            (res && (res.uid || res.node_uid || (res.node && res.node.uid))) ||
            ''
          if (!peerUid) continue
          hit.ref.uidMap = { ...(hit.ref.uidMap || {}), [localUid]: String(peerUid) }
          await this._persistUidMap(hit)
          // 递归：若插入时带了整棵子树
          await this._forwardNewSubtree(hit, child)
          await this._bumpPeerCursor(hit.ref.mapId)
        } catch (err) {
          console.warn('[mapRefMirror] add peer node failed', err)
        }
      }
    }
  }

  async _forwardNewSubtree(host, localNode) {
    const kids = (localNode && localNode.children) || []
    for (const child of kids) {
      if (!child || typeof child.getData !== 'function') continue
      const localUid = String(child.getData('uid') || '')
      const parentUid = parentUidOf(child)
      if (!localUid || !parentUid) continue
      if (host.ref.uidMap && host.ref.uidMap[localUid]) {
        await this._forwardNewSubtree(host, child)
        continue
      }
      const peerParent = host.ref.uidMap[parentUid]
      if (!peerParent) continue
      try {
        const res = await addFileNode(host.ref.mapId, {
          parent: peerParent,
          parent_uid: peerParent,
          text: stripHtml(child.getData('text')) || '(空)',
          note: child.getData('note') || undefined,
          originMirror: this.sourceRoomKey
        })
        const peerUid =
          (res && (res.uid || res.node_uid || (res.node && res.node.uid))) ||
          ''
        if (!peerUid) continue
        host.ref.uidMap = {
          ...(host.ref.uidMap || {}),
          [localUid]: String(peerUid)
        }
        await this._persistUidMap(host)
        await this._forwardNewSubtree(host, child)
        await this._bumpPeerCursor(host.ref.mapId)
      } catch (err) {
        console.warn('[mapRefMirror] add peer subtree node failed', err)
      }
    }
  }

  async _forwardRemoves(hosts, args) {
    const targets = Array.isArray(args && args[0])
      ? args[0]
      : args && args[0]
        ? [args[0]]
        : (this.mindMap.renderer.activeNodeList || [])
    for (const node of targets) {
      const uid =
        typeof node === 'string'
          ? node
          : node && typeof node.getData === 'function'
            ? String(node.getData('uid') || '')
            : ''
      if (!uid) continue
      const hit = findMirrorForLocalUid(hosts, uid)
      if (!hit) continue
      // 不删目标根（宿主对应的 peer root）
      if (hit.ref.nodeId && hit.peerUid === hit.ref.nodeId) continue
      try {
        await deleteFileNode(hit.ref.mapId, hit.peerUid, {
          keepChildren: false
        })
        if (hit.ref.uidMap) {
          delete hit.ref.uidMap[uid]
          await this._persistUidMap(hit)
        }
        await this._bumpPeerCursor(hit.ref.mapId)
      } catch (err) {
        console.warn('[mapRefMirror] delete peer node failed', err)
      }
    }
  }

  async _forwardPatches(hosts, name, args) {
    const uids = extractCommandUids(name, args, this.mindMap)
    for (const uid of uids) {
      const hit = findMirrorForLocalUid(hosts, uid)
      if (!hit) continue
      const live =
        (this.mindMap.renderer &&
          this.mindMap.renderer.findNodeByUid &&
          this.mindMap.renderer.findNodeByUid(uid)) ||
        null
      if (!live || typeof live.getData !== 'function') continue
      const body = { originMirror: this.sourceRoomKey }
      if (name === 'SET_NODE_TEXT' || name === 'SET_NODE_DATA') {
        body.text = stripHtml(live.getData('text'))
      }
      if (name === 'SET_NODE_NOTE' || name === 'SET_NODE_DATA') {
        const note = live.getData('note')
        if (note != null) body.note = note
      }
      if (body.text == null && body.note == null) continue
      try {
        await patchFileNode(hit.ref.mapId, hit.peerUid, body)
        await this._bumpPeerCursor(hit.ref.mapId)
      } catch (err) {
        console.warn('[mapRefMirror] patch peer failed', err)
      }
    }
  }

  async _pollPeers() {
    if (
      this._busy ||
      this._stopped ||
      this._forwarding ||
      this._applyingRemote ||
      suppressForwardDepth > 0
    ) {
      return
    }
    const hosts = collectMirrorHosts(this.mindMap)
    if (!hosts.length) return
    this._busy = true
    try {
      const byRoom = new Map()
      hosts.forEach(h => {
        const list = byRoom.get(h.ref.mapId) || []
        list.push(h)
        byRoom.set(h.ref.mapId, list)
      })
      for (const [mapId, roomHosts] of byRoom.entries()) {
        let version = this._peerCursor.get(mapId) || 0
        try {
          const verRes = await getMapVersion(mapId)
          const current = Number(
            (verRes && (verRes.version || verRes.currentVersion)) || 0
          )
          if (!current || current <= version) continue
          let allOk = true
          for (const host of roomHosts) {
            const ok = await this._pullHostSubtree(host)
            if (!ok) allOk = false
          }
          // 任一台 host 失败都不推进 cursor，避免跳过未同步窗口
          if (allOk) this._peerCursor.set(mapId, current)
        } catch (err) {
          console.warn('[mapRefMirror] poll peer failed', mapId, err)
        }
      }
    } finally {
      this._busy = false
    }
  }

  /**
   * @returns {Promise<boolean>} 是否成功应用（unchanged 也算成功）
   */
  async _pullHostSubtree(host) {
    const ref = host.ref
    if (!isMirrorMapRef(ref)) return false
    let fetched
    try {
      fetched = await fetchMirrorTree(ref.mapId, ref.nodeId, {
        maxNodes: MAX_MIRROR_NODES,
        knownVersion: Number(ref.peerVersion) || 0
      })
    } catch (err) {
      return false
    }
    if (fetched.unchanged) return true
    if (!fetched.tree) return false

    this._applyingRemote = true
    try {
      return await withCollabRemoteApplyAsync(this.mindMap, async () => {
        const live =
          (this.mindMap.renderer &&
            this.mindMap.renderer.findNodeByUid &&
            this.mindMap.renderer.findNodeByUid(host.uid)) ||
          host.node
        if (!live) return false

        // 更新宿主文案
        const rootText = stripHtml(fetched.tree.data && fetched.tree.data.text)
        const rootNote = (fetched.tree.data && fetched.tree.data.note) || ''
        if (rootText && stripHtml(live.getData('text')) !== rootText) {
          this.mindMap.renderer.setNodeDataRender(live, {
            text: rootText,
            richText: false,
            resetRichText: true
          })
        }
        if (rootNote !== (live.getData('note') || '')) {
          this.mindMap.execCommand('SET_NODE_NOTE', live, rootNote)
        }

        const reverse = invertUidMap(ref.uidMap)
        await this._syncChildren(
          live,
          fetched.tree.children || [],
          reverse,
          host
        )

        // 写回 peerVersion（asRemote：不把巨大 uidMap 当成本地协同写）
        const nextRef = {
          ...normalizeMapRef(live.getData('mapRef')),
          uidMap: { ...(host.ref.uidMap || {}) },
          peerVersion: fetched.version || null
        }
        host.ref = nextRef
        live.setData({ mapRef: nextRef })
        this.mindMap.execCommand('SET_NODE_MAP_REF', live, nextRef)
        return true
      })
    } finally {
      this._applyingRemote = false
    }
  }

  /**
   * 把 peer 子树 remap 成可一次 INSERT 的本地树，并登记 uidMap。
   * 整树插入，避免逐层依赖 findNodeByUid（折叠/未渲染时会丢深层节点）。
   */
  _remapPeerSubtree(peerNode, reverse, host, depth) {
    if (!peerNode || !peerNode.data) return null
    const peerUid = String(peerNode.data.uid || '').trim()
    if (!peerUid) return null
    const data = cloneData(peerNode.data)
    const newUid = createUid()
    data.uid = newUid
    data.text = stripHtml(data.text) || '(空)'
    data.richText = false
    data.resetRichText = true
    data.inserting = true
    data.expand = depth < 1
    host.ref.uidMap = { ...(host.ref.uidMap || {}), [newUid]: peerUid }
    reverse[peerUid] = newUid
    const children = (peerNode.children || [])
      .map(child => this._remapPeerSubtree(child, reverse, host, depth + 1))
      .filter(Boolean)
    data.childCount = children.length
    return { data, children }
  }

  async _syncChildren(localParent, peerChildren, reverse, host) {
    const localKids = [...((localParent && localParent.children) || [])]
    const usedLocal = new Set()

    for (const peerChild of peerChildren) {
      if (!peerChild || !peerChild.data) continue
      const peerUid = String(peerChild.data.uid || '')
      if (!peerUid) continue
      let localUid = reverse[peerUid]
      let localNode =
        localUid &&
        this.mindMap.renderer &&
        this.mindMap.renderer.findNodeByUid
          ? this.mindMap.renderer.findNodeByUid(localUid)
          : null

      // 折叠未实例化时，回退到 nodeData 子树查找
      if (!localNode && localUid && localParent && localParent.nodeData) {
        localNode = this._findDataChild(localParent, localUid)
      }

      if (!localNode) {
        let tree = this._remapPeerSubtree(peerChild, reverse, host, 0)
        if (!tree) continue
        // poll 拉到的新节点若带产物，同样复制到当前房
        const transferred = await transferTreeAttachments(
          [tree],
          host.ref && host.ref.mapId,
          currentRoomKey(this.mindMap)
        )
        tree = (transferred.trees && transferred.trees[0]) || tree
        ensureHostActive(this.mindMap, localParent)
        markInsertingTree([tree])
        this.mindMap.execCommand(
          'INSERT_MULTI_CHILD_NODE',
          [localParent],
          [tree]
        )
        localUid = tree.data.uid
        localNode =
          (this.mindMap.renderer.findNodeByUid &&
            this.mindMap.renderer.findNodeByUid(localUid)) ||
          this._findDataChild(localParent, localUid)
        usedLocal.add(localUid)
        // 整树已插入，不必再递归 children
        continue
      }

      usedLocal.add(localUid)
      if (typeof localNode.getData === 'function') {
        const peerText = stripHtml(peerChild.data.text)
        if (peerText && stripHtml(localNode.getData('text')) !== peerText) {
          this.mindMap.renderer.setNodeDataRender(localNode, {
            text: peerText,
            richText: false,
            resetRichText: true
          })
        }
        const peerNote = peerChild.data.note || ''
        if (peerNote !== (localNode.getData('note') || '')) {
          this.mindMap.execCommand('SET_NODE_NOTE', localNode, peerNote)
        }
      }
      await this._syncChildren(
        localNode,
        peerChild.children || [],
        reverse,
        host
      )
    }

    // 本地多出来的、且在 uidMap 里的 → 对端已删，本地也删
    for (const kid of localKids) {
      if (!kid || typeof kid.getData !== 'function') continue
      const uid = String(kid.getData('uid') || '')
      if (!uid || usedLocal.has(uid)) continue
      if (!(host.ref.uidMap && host.ref.uidMap[uid])) continue
      try {
        this.mindMap.execCommand('REMOVE_NODE', [kid])
        delete host.ref.uidMap[uid]
      } catch (e) {
        /* ignore */
      }
    }
  }

  _findDataChild(parent, uid) {
    if (!parent || !uid) return null
    if (
      this.mindMap.renderer &&
      typeof this.mindMap.renderer.findNodeByUid === 'function'
    ) {
      const live = this.mindMap.renderer.findNodeByUid(uid)
      if (live) return live
    }
    const kids =
      (parent.nodeData && parent.nodeData.children) ||
      (Array.isArray(parent.children) &&
      parent.children[0] &&
      parent.children[0].data &&
      !parent.children[0].getData
        ? parent.children
        : null)
    if (!kids || !kids.length) return null
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      if (!child || !child.data) continue
      if (String(child.data.uid || '') !== uid) continue
      return {
        nodeData: child,
        children: [],
        getData: key => (key ? child.data[key] : child.data),
        setData: patch => Object.assign(child.data, patch || {}),
        parent
      }
    }
    return null
  }

  async _bumpPeerCursor(mapId) {
    const id = String(mapId || '')
    if (!id) return
    try {
      const verRes = await getMapVersion(id)
      const current = Number(
        (verRes && (verRes.version || verRes.currentVersion)) || 0
      )
      if (current) this._peerCursor.set(id, current)
    } catch (e) {
      /* ignore */
    }
  }
}

export default {
  fetchMirrorTree,
  buildRemappedChildren,
  implantMirrorSubtree,
  MapRefMirrorSync,
  MAX_MIRROR_NODES
}
