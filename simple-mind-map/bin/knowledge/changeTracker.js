// Notifications are hints only. PostgreSQL revisions are the recovery authority.
class ChangeTracker {
  constructor() { this.rooms = new Map(); this.sourceRooms = new Map() }
  markSource(roomId, revision) {
    this.sourceRooms.set(roomId, Math.max(Number(revision) || 0, this.sourceRooms.get(roomId) || 0))
  }
  acknowledgeSource(roomId, revision) {
    if ((this.sourceRooms.get(roomId) || 0) <= revision) this.sourceRooms.delete(roomId)
  }
  mark(roomId, version, uids = []) {
    if (!roomId) return
    let pending = this.rooms.get(roomId)
    if (!pending) this.rooms.set(roomId, pending = new Map())
    for (const uid of uids.length ? uids : ['*']) {
      pending.set(String(uid), Math.max(Number(version) || 0, pending.get(String(uid)) || 0))
    }
  }
  acknowledge(roomId, version) {
    const pending = this.rooms.get(roomId)
    if (!pending) return
    for (const [uid, v] of pending) if (v <= version) pending.delete(uid)
    if (!pending.size) this.rooms.delete(roomId)
  }
  count(roomId) { return (this.rooms.get(roomId)?.size || 0) + (this.sourceRooms.has(roomId) ? 1 : 0) }
}
function affectedUids(operation) {
  const out = new Set()
  function visit(obj) {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { obj.forEach(visit); return }
    for (const [key, value] of Object.entries(obj)) {
      if (['uid', 'targetId', 'parentUid', 'parent_uid', 'oldParentUid', 'newParentUid'].includes(key) && typeof value === 'string') out.add(value)
      else if (['affectedUids', 'removedUids', 'uids', 'children'].includes(key) && Array.isArray(value)) value.filter(v => typeof v === 'string').forEach(v => out.add(v))
      // Do not traverse node text, binary images, or arbitrary semantic data.
      else if (['event', 'payload', 'operations', 'ops', 'inverse_payload', 'inversePayload', 'nodes', 'rows'].includes(key)) visit(value)
      else if (key === 'siblingPositions' && value && typeof value === 'object') Object.keys(value).forEach(v => out.add(v))
    }
  }
  visit(operation)
  return [...out]
}
module.exports = { ChangeTracker, affectedUids }
