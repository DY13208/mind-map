import { createUid } from 'simple-mind-map/src/utils/index'
import { normalizeMapRef, isMirrorMapRef } from '@/utils/mapRefNav'
import {
  getFileSubtree,
  getMapVersion,
  addFileNode,
  patchFileNode,
  deleteFileNode
} from '@/utils/fileApi'

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

const STRIP_DATA_KEYS = [
  'mapRef',
  'attachment',
  'attachmentId',
  'attachmentName',
  'attachmentMime',
  'attachmentSize',
  'attachmentUrl',
  'attachmentError',
  'comments',
  'comment',
  'imgMap',
  'subtreeVersion',
  'hasMore',
  '_mirrorOrigin'
]

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
  const data = await getFileSubtree(mapId, nodeId, {
    deep: true,
    maxNodes,
    timeoutMs: options.timeoutMs || 60000
  })
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
    return { children: [], uidMap, rootText: '', rootNote: '' }
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
    rootNote: String((peerTree.data && peerTree.data.note) || '')
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
  const { children, uidMap, rootText, rootNote } = buildRemappedChildren(
    fetched.tree,
    hostUid,
    ref.nodeId
  )

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
      expand: true
    })
    mindMap.execCommand('SET_NODE_MAP_REF', node, nextRef)

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
      mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], children)
    }

    return {
      ok: true,
      mapRef: nextRef,
      truncated: fetched.truncated,
      nodeCount: fetched.nodeCount,
      childCount: children.length
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

  _onAfterExecCommand({ name, args } = {}) {
    if (
      this._applyingRemote ||
      this._forwarding ||
      this._stopped ||
      suppressForwardDepth > 0
    ) {
      return
    }
    if (!name) return
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

  async _persistUidMap(host) {
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
    this._applyingRemote = true
    try {
      live.setData({ mapRef: next })
      this.mindMap.execCommand('SET_NODE_MAP_REF', live, next)
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
      } catch (err) {
        console.warn('[mapRefMirror] patch peer failed', err)
      }
    }
  }

  async _pollPeers() {
    if (this._busy || this._stopped || this._forwarding || this._applyingRemote) {
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
          for (const host of roomHosts) {
            await this._pullHostSubtree(host)
          }
          this._peerCursor.set(mapId, current)
        } catch (err) {
          console.warn('[mapRefMirror] poll peer failed', mapId, err)
        }
      }
    } finally {
      this._busy = false
    }
  }

  async _pullHostSubtree(host) {
    const ref = host.ref
    if (!isMirrorMapRef(ref)) return
    let fetched
    try {
      fetched = await fetchMirrorTree(ref.mapId, ref.nodeId, {
        maxNodes: MAX_MIRROR_NODES
      })
    } catch (err) {
      return
    }
    if (fetched.unchanged || !fetched.tree) return

    this._applyingRemote = true
    try {
      const live =
        (this.mindMap.renderer &&
          this.mindMap.renderer.findNodeByUid &&
          this.mindMap.renderer.findNodeByUid(host.uid)) ||
        host.node
      if (!live) return

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
      await this._syncChildren(live, fetched.tree.children || [], reverse, host)

      // 写回 peerVersion
      const nextRef = {
        ...normalizeMapRef(live.getData('mapRef')),
        uidMap: { ...(host.ref.uidMap || {}) },
        peerVersion: fetched.version || null
      }
      host.ref = nextRef
      live.setData({ mapRef: nextRef })
      this.mindMap.execCommand('SET_NODE_MAP_REF', live, nextRef)
    } finally {
      this._applyingRemote = false
    }
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

      if (!localNode) {
        // 目标新增 → 本地插入
        const data = cloneData(peerChild.data)
        const newUid = createUid()
        data.uid = newUid
        data.text = stripHtml(data.text) || '(空)'
        data.richText = false
        data.resetRichText = true
        data.expand = false
        const childTrees = [
          {
            data,
            children: []
          }
        ]
        this.mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [localParent], childTrees)
        host.ref.uidMap = { ...(host.ref.uidMap || {}), [newUid]: peerUid }
        reverse[peerUid] = newUid
        localUid = newUid
        localNode =
          this.mindMap.renderer.findNodeByUid &&
          this.mindMap.renderer.findNodeByUid(newUid)
        usedLocal.add(newUid)
      } else {
        usedLocal.add(localUid)
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

      if (localNode) {
        await this._syncChildren(
          localNode,
          peerChild.children || [],
          reverse,
          host
        )
      }
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
}

export default {
  fetchMirrorTree,
  buildRemappedChildren,
  implantMirrorSubtree,
  MapRefMirrorSync,
  MAX_MIRROR_NODES
}
