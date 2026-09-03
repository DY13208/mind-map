const SOFT_LOCK_MS = 15000

function createPresenceHub() {
  const rooms = new Map()

  function state(roomKey) {
    let room = rooms.get(roomKey)
    if (!room) {
      room = { peers: new Map(), locks: new Map() }
      rooms.set(roomKey, room)
    }
    return room
  }

  function pruneLocks(room) {
    const now = Date.now()
    room.locks.forEach((lock, uid) => {
      if (now - lock.at > SOFT_LOCK_MS) room.locks.delete(uid)
    })
  }

  function setPeer(roomKey, clientId, patch) {
    const room = state(roomKey)
    const prev = room.peers.get(clientId) || { clientId }
    const next = {
      ...prev,
      ...patch,
      clientId,
      updatedAt: Date.now()
    }
    room.peers.set(clientId, next)
    if (prev.editingUid && prev.editingUid !== next.editingUid) {
      const lock = room.locks.get(prev.editingUid)
      if (lock && lock.clientId === clientId) room.locks.delete(prev.editingUid)
    }
    if (next.editingUid) {
      const owner = room.locks.get(next.editingUid)
      if (!owner || owner.clientId === clientId || Date.now() - owner.at > SOFT_LOCK_MS) {
        room.locks.set(next.editingUid, {
          clientId,
          userId: next.userId,
          name: next.name,
          color: next.color,
          at: Date.now()
        })
      }
    }
    return list(roomKey)
  }

  function removePeer(roomKey, clientId) {
    const room = rooms.get(roomKey)
    if (!room) return []
    const prev = room.peers.get(clientId)
    room.peers.delete(clientId)
    if (prev && prev.editingUid) {
      const lock = room.locks.get(prev.editingUid)
      if (lock && lock.clientId === clientId) room.locks.delete(prev.editingUid)
    }
    if (!room.peers.size) rooms.delete(roomKey)
    return list(roomKey)
  }

  function list(roomKey) {
    const room = rooms.get(roomKey)
    if (!room) return []
    pruneLocks(room)
    return Array.from(room.peers.values())
  }

  function lockOwner(roomKey, nodeId) {
    const room = rooms.get(roomKey)
    if (!room || !nodeId) return null
    pruneLocks(room)
    return room.locks.get(nodeId) || null
  }

  return { setPeer, removePeer, list, lockOwner, SOFT_LOCK_MS }
}

module.exports = { createPresenceHub, SOFT_LOCK_MS }
