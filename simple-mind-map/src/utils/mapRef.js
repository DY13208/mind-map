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
  return {
    mapId,
    nodeId: nodeId || null,
    type: nodeId ? 'node' : String(value.type || 'map')
  }
}

function mapRefEquals(a, b) {
  const left = normalizeMapRef(a)
  const right = normalizeMapRef(b)
  if (!left && !right) return true
  if (!left || !right) return false
  return left.mapId === right.mapId && left.nodeId === right.nodeId
}

const api = {
  normalizeMapRef,
  mapRefEquals
}

module.exports = api
module.exports.default = api
