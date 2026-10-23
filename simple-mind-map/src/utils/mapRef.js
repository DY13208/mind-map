/* global module:readonly */

function normalizeMapRef(value) {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      value = JSON.parse(trimmed)
    } catch (e) {
      // 也可能直接是 mapId 字符串
      return { mapId: trimmed, nodeId: null, type: 'map' }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mapId = String(
    value.mapId || value.map_id || value.room_key || ''
  ).trim()
  if (!mapId) return null
  const nodeId = String(
    value.nodeId || value.node_id || value.uid || ''
  ).trim()
  const syncMode = String(value.syncMode || value.sync_mode || '').trim()
  const mirrorRootUid = String(
    value.mirrorRootUid || value.mirror_root_uid || ''
  ).trim()
  const uidMap =
    value.uidMap && typeof value.uidMap === 'object' && !Array.isArray(value.uidMap)
      ? { ...value.uidMap }
      : null
  const peerVersionRaw = value.peerVersion != null ? value.peerVersion : value.peer_version
  const peerVersion =
    peerVersionRaw == null || peerVersionRaw === ''
      ? null
      : Number(peerVersionRaw)
  const out = {
    mapId,
    nodeId: nodeId || null,
    type: nodeId ? 'node' : String(value.type || 'map')
  }
  if (syncMode === 'mirror' && nodeId) {
    out.syncMode = 'mirror'
    if (mirrorRootUid) out.mirrorRootUid = mirrorRootUid
    if (uidMap && Object.keys(uidMap).length) out.uidMap = uidMap
    if (Number.isFinite(peerVersion)) out.peerVersion = peerVersion
  }
  return out
}

function isMirrorMapRef(value) {
  const ref = normalizeMapRef(value)
  return !!(ref && ref.syncMode === 'mirror' && ref.nodeId)
}

function mapRefEquals(a, b) {
  const left = normalizeMapRef(a)
  const right = normalizeMapRef(b)
  if (!left && !right) return true
  if (!left || !right) return false
  return (
    left.mapId === right.mapId &&
    left.nodeId === right.nodeId &&
    (left.syncMode || '') === (right.syncMode || '')
  )
}

const api = {
  normalizeMapRef,
  isMirrorMapRef,
  mapRefEquals
}

module.exports = api
module.exports.default = api
