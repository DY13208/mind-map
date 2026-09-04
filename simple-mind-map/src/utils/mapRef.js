/* global module:readonly */

function normalizeMapRef(value) {
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
