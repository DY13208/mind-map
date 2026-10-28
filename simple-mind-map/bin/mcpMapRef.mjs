import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mapRefUtil = require('../src/utils/mapRef')

const MAX_MIRROR_NODES = 2000
const BATCH_SIZE = 80

const WECOM_CARD_STYLE = {
  shape: 'roundedRectangle',
  fillColor: '#F2F3F5',
  borderColor: 'transparent',
  borderWidth: 0,
  color: '#1F2329',
  fontSize: 14,
  fontWeight: 'normal',
  paddingX: 10,
  paddingY: 8,
  richText: false,
  resetRichText: true
}

function required(value, label) {
  const result = String(value || '').trim()
  if (!result) {
    const err = new Error(`缺少 ${label}`)
    err.code = 'INVALID_ARGUMENT'
    err.statusCode = 400
    throw err
  }
  return result
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

async function locateNodeUid(api, roomKey, nodeRef) {
  const located = await api(
    `/api/files/${encodeURIComponent(roomKey)}/locate?uid=${encodeURIComponent(
      nodeRef
    )}`,
    { timeoutMs: 15000 }
  )
  const uid = String((located && located.uid) || '').trim()
  if (!uid) {
    const err = new Error('找不到唯一节点，请改用节点 uid 或完整路径')
    err.code = 'NODE_NOT_FOUND'
    err.statusCode = 404
    throw err
  }
  return uid
}

async function readNodeData(api, roomKey, uid) {
  const data = await api(
    `/api/files/${encodeURIComponent(roomKey)}/nodes?uids=${encodeURIComponent(
      uid
    )}`,
    { timeoutMs: 15000 }
  )
  const node = data && data.nodes && data.nodes[uid]
  return (node && node.data) || {}
}

async function assertMapReadable(api, mapId) {
  try {
    await api(`/api/files/${encodeURIComponent(mapId)}?format=meta`, {
      timeoutMs: 12000
    })
  } catch (err) {
    if (Number(err.statusCode) === 404) {
      const next = new Error('目标导图不存在或已删除')
      next.code = 'TARGET_MAP_NOT_FOUND'
      next.statusCode = 404
      throw next
    }
    if (Number(err.statusCode) === 403) {
      const next = new Error('没有访问目标导图的权限')
      next.code = 'TARGET_MAP_FORBIDDEN'
      next.statusCode = 403
      throw next
    }
    throw err
  }
}

function buildMapRefPayload({
  mapId,
  nodeId,
  syncMode,
  mirrorRootUid,
  uidMap,
  peerVersion
}) {
  const raw = {
    mapId,
    nodeId: nodeId || null,
    type: nodeId ? 'node' : 'map'
  }
  if (syncMode === 'mirror' && nodeId) {
    raw.syncMode = 'mirror'
    if (mirrorRootUid) raw.mirrorRootUid = mirrorRootUid
    if (uidMap && Object.keys(uidMap).length) raw.uidMap = uidMap
    if (peerVersion != null && Number.isFinite(Number(peerVersion))) {
      raw.peerVersion = Number(peerVersion)
    }
  }
  const normalized = mapRefUtil.normalizeMapRef(raw)
  if (!normalized) {
    const err = new Error('无效的子脑图引用')
    err.code = 'INVALID_MAP_REF'
    err.statusCode = 400
    throw err
  }
  return normalized
}

/**
 * 深读目标子树并 remap 为可批量插入的节点列表（BFS，父先于子）。
 */
function remapSubtreeForInsert(peerTree, hostUid, peerRootUid) {
  const uidMap = {}
  const rootPeerUid = String(
    peerRootUid ||
      (peerTree && peerTree.data && peerTree.data.uid) ||
      ''
  ).trim()
  const host = String(hostUid || '').trim()
  if (!host || !rootPeerUid || !peerTree) {
    return {
      inserts: [],
      uidMap,
      rootText: '',
      rootNote: '',
      truncated: false,
      nodeCount: 0
    }
  }
  uidMap[host] = rootPeerUid

  const inserts = []
  let truncated = false
  let nodeCount = 0

  const walk = (node, parentLocalUid, depth) => {
    if (!node || !node.data) return
    if (nodeCount >= MAX_MIRROR_NODES) {
      truncated = true
      return
    }
    const peerUid = String(node.data.uid || '').trim()
    const localUid = randomUUID()
    if (peerUid) uidMap[localUid] = peerUid
    nodeCount += 1
    inserts.push({
      parent: parentLocalUid,
      uid: localUid,
      text: stripHtml(node.data.text) || '(空)',
      note:
        node.data.note != null && String(node.data.note) !== ''
          ? String(node.data.note)
          : undefined
    })
    ;(node.children || []).forEach(child => walk(child, localUid, depth + 1))
  }

  ;(peerTree.children || []).forEach(child => walk(child, host, 0))

  return {
    inserts,
    uidMap,
    rootText: stripHtml(peerTree.data && peerTree.data.text) || '',
    rootNote: String((peerTree.data && peerTree.data.note) || ''),
    truncated,
    nodeCount
  }
}

async function fetchPeerSubtree(api, mapId, nodeId) {
  const params = new URLSearchParams({
    uid: nodeId,
    deep: '1',
    max_nodes: String(MAX_MIRROR_NODES)
  })
  const data = await api(
    `/api/files/${encodeURIComponent(mapId)}/subtree?${params.toString()}`,
    { timeoutMs: 60000 }
  )
  if (!data || data.missing || data.notFound) {
    const err = new Error('目标节点不存在')
    err.code = 'TARGET_NODE_MISSING'
    err.statusCode = 404
    throw err
  }
  if (!data.tree) {
    const err = new Error('目标子树为空')
    err.code = 'EMPTY_SUBTREE'
    err.statusCode = 404
    throw err
  }
  return {
    tree: data.tree,
    version: Number(data.version) || 0,
    truncated: !!data.truncated,
    nodeCount: Number(data.node_count) || 0
  }
}

async function patchHostMapRef({
  writeNodeMap,
  roomKey,
  hostUid,
  mapRef,
  title,
  note,
  applyStyle,
  confirmSopChange,
  operationId,
  baseRevision,
  signal
}) {
  const body = {
    mapRef,
    ...(title != null ? { text: title, richText: false, resetRichText: true } : {}),
    ...(note != null && note !== '' ? { note } : {}),
    ...(applyStyle ? WECOM_CARD_STYLE : {}),
    ...(confirmSopChange === true ? { confirm_sop_change: true } : {})
  }
  return writeNodeMap(
    roomKey,
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(
      hostUid
    )}`,
    'PATCH',
    body,
    operationId || randomUUID(),
    {
      signal,
      baseRevision,
      writeType: 'node.update'
    }
  )
}

async function insertRemappedChildren({
  writeNodeMap,
  roomKey,
  inserts,
  confirmSopChange,
  operationId,
  baseRevision,
  signal
}) {
  if (!inserts.length) {
    return { inserted: 0, batches: [] }
  }
  const batches = []
  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const slice = inserts.slice(i, i + BATCH_SIZE)
    const ops = slice.map(item => ({
      type: 'node.insert',
      payload: {
        parentUid: item.parent,
        uid: item.uid,
        text: item.text,
        ...(item.note != null ? { note: item.note } : {}),
        ...(confirmSopChange === true ? { confirm_sop_change: true } : {})
      }
    }))
    const result = await writeNodeMap(
      roomKey,
      `/api/maps/${encodeURIComponent(roomKey)}/operations`,
      'POST',
      { type: 'node.batch', payload: { ops } },
      `${operationId || randomUUID()}-mirror-${i}`,
      {
        signal,
        // 首批可用调用方基线；后续批次让 writeNodeMap 拉最新 revision
        baseRevision: i === 0 ? baseRevision : undefined,
        writeType: 'node.batch'
      }
    )
    batches.push(result)
    if (result && result.outcome === 'all_failed') {
      const err = new Error('镜像子树批量插入失败')
      err.code = 'MIRROR_INSERT_FAILED'
      err.statusCode = 500
      err.details = { batch: result }
      throw err
    }
  }
  return { inserted: inserts.length, batches }
}

/**
 * 添加 / 设置子脑图引用。
 * sync_mode=mirror 且提供 target_node 时，默认植入目标子树（不含附件物理复制）。
 */
export async function addMapRef({
  api,
  writeNodeMap,
  roomKey,
  node,
  targetMapId,
  targetNodeId,
  syncMode,
  title,
  implant = true,
  confirmSopChange,
  operationId,
  baseRevision,
  signal
} = {}) {
  const room = required(roomKey, 'room_key')
  const hostRef = required(node, 'node')
  const mapId = required(targetMapId, 'target_map_id')
  if (mapId === room) {
    const err = new Error('不能引用当前导图自身')
    err.code = 'CURRENT_MAP'
    err.statusCode = 400
    throw err
  }
  const hostUid = await locateNodeUid(api, room, hostRef)
  await assertMapReadable(api, mapId)

  let nodeId = String(targetNodeId || '').trim() || null
  if (nodeId) {
    // 校验目标节点在目标图中存在
    await locateNodeUid(api, mapId, nodeId)
  }

  const wantMirror = syncMode === 'mirror' || syncMode === true
  if (wantMirror && !nodeId) {
    const err = new Error('镜像同步模式必须提供 target_node（目标导图中的节点）')
    err.code = 'MIRROR_NEEDS_NODE'
    err.statusCode = 400
    throw err
  }

  let uidMap = null
  let peerVersion = null
  let rootText = ''
  let rootNote = ''
  let truncated = false
  let nodeCount = 0
  let inserts = []

  if (wantMirror && nodeId && implant !== false) {
    const fetched = await fetchPeerSubtree(api, mapId, nodeId)
    const remapped = remapSubtreeForInsert(fetched.tree, hostUid, nodeId)
    uidMap = remapped.uidMap
    peerVersion = fetched.version
    rootText = remapped.rootText
    rootNote = remapped.rootNote
    truncated = remapped.truncated || fetched.truncated
    nodeCount = remapped.nodeCount || fetched.nodeCount
    inserts = remapped.inserts
  }

  const mapRef = buildMapRefPayload({
    mapId,
    nodeId,
    syncMode: wantMirror ? 'mirror' : '',
    mirrorRootUid: wantMirror ? hostUid : '',
    uidMap,
    peerVersion
  })

  const displayTitle =
    String(title || rootText || (nodeId ? nodeId : mapId)).trim() || '子脑图'

  const patchResult = await patchHostMapRef({
    writeNodeMap,
    roomKey: room,
    hostUid,
    mapRef,
    title: displayTitle,
    note: rootNote || undefined,
    applyStyle: true,
    confirmSopChange,
    operationId,
    baseRevision,
    signal
  })

  let insertResult = { inserted: 0, batches: [] }
  if (inserts.length) {
    insertResult = await insertRemappedChildren({
      writeNodeMap,
      roomKey: room,
      inserts,
      confirmSopChange,
      operationId,
      baseRevision,
      signal
    })
  }

  return {
    ok: true,
    uid: hostUid,
    mapRef,
    truncated,
    nodeCount,
    childInserted: insertResult.inserted,
    patch: patchResult
  }
}

/**
 * 编辑已有子脑图引用（改目标图 / 目标节点 / 同步模式）。
 * 默认不重新植入子树；传 reimplant=true 且 mirror 时会先清 mapRef 再按新目标植入。
 */
export async function updateMapRef({
  api,
  writeNodeMap,
  roomKey,
  node,
  targetMapId,
  targetNodeId,
  syncMode,
  title,
  reimplant = false,
  confirmSopChange,
  operationId,
  baseRevision,
  signal
} = {}) {
  const room = required(roomKey, 'room_key')
  const hostUid = await locateNodeUid(api, room, required(node, 'node'))
  const currentData = await readNodeData(api, room, hostUid)
  const current = mapRefUtil.normalizeMapRef(currentData.mapRef)
  if (!current) {
    const err = new Error('该节点没有子脑图引用，请先 add_map_ref')
    err.code = 'MAP_REF_MISSING'
    err.statusCode = 404
    throw err
  }

  const mapId = String(targetMapId || current.mapId).trim()
  const nodeIdRaw =
    targetNodeId === undefined
      ? current.nodeId
      : targetNodeId == null || targetNodeId === ''
        ? null
        : String(targetNodeId).trim()
  const modeRaw =
    syncMode === undefined
      ? current.syncMode || ''
      : syncMode === 'mirror' || syncMode === true
        ? 'mirror'
        : ''

  if (mapId === room) {
    const err = new Error('不能引用当前导图自身')
    err.code = 'CURRENT_MAP'
    err.statusCode = 400
    throw err
  }
  await assertMapReadable(api, mapId)
  if (nodeIdRaw) await locateNodeUid(api, mapId, nodeIdRaw)

  if (reimplant && modeRaw === 'mirror' && nodeIdRaw) {
    return addMapRef({
      api,
      writeNodeMap,
      roomKey: room,
      node: hostUid,
      targetMapId: mapId,
      targetNodeId: nodeIdRaw,
      syncMode: 'mirror',
      title,
      implant: true,
      confirmSopChange,
      operationId,
      baseRevision,
      signal
    })
  }

  const mapRef = buildMapRefPayload({
    mapId,
    nodeId: nodeIdRaw,
    syncMode: modeRaw,
    mirrorRootUid: modeRaw === 'mirror' ? hostUid : '',
    uidMap: modeRaw === 'mirror' ? current.uidMap || null : null,
    peerVersion: modeRaw === 'mirror' ? current.peerVersion : null
  })

  const patchResult = await patchHostMapRef({
    writeNodeMap,
    roomKey: room,
    hostUid,
    mapRef,
    title: title != null ? String(title).trim() : undefined,
    applyStyle: false,
    confirmSopChange,
    operationId,
    baseRevision,
    signal
  })

  return {
    ok: true,
    uid: hostUid,
    mapRef,
    previous: current,
    patch: patchResult
  }
}

/**
 * 移除子脑图引用（保留本地子节点，与网页「移除子脑图」一致）。
 */
export async function removeMapRef({
  api,
  writeNodeMap,
  roomKey,
  node,
  confirmSopChange,
  operationId,
  baseRevision,
  signal
} = {}) {
  const room = required(roomKey, 'room_key')
  const hostUid = await locateNodeUid(api, room, required(node, 'node'))
  const currentData = await readNodeData(api, room, hostUid)
  const current = mapRefUtil.normalizeMapRef(currentData.mapRef)
  if (!current) {
    return {
      ok: true,
      uid: hostUid,
      removed: false,
      message: '节点本来就没有子脑图引用'
    }
  }

  const patchResult = await writeNodeMap(
    room,
    `/api/files/${encodeURIComponent(room)}/nodes/${encodeURIComponent(
      hostUid
    )}`,
    'PATCH',
    {
      mapRef: null,
      ...(confirmSopChange === true ? { confirm_sop_change: true } : {})
    },
    operationId || randomUUID(),
    {
      signal,
      baseRevision,
      writeType: 'node.update'
    }
  )

  return {
    ok: true,
    uid: hostUid,
    removed: true,
    previous: current,
    patch: patchResult
  }
}

export default {
  addMapRef,
  updateMapRef,
  removeMapRef,
  MAX_MIRROR_NODES
}
