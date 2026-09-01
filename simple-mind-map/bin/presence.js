const PRESENCE_TTL_MS = 8000
const rooms = new Map()

function prune(roomKey, now = Date.now()) {
  const map = rooms.get(roomKey)
  if (!map) return
  map.forEach((user, id) => {
    if (!user || now - user.at > PRESENCE_TTL_MS) map.delete(id)
  })
  if (!map.size) rooms.delete(roomKey)
}

function beatPresence(roomKey, user = {}) {
  const key = String(roomKey || '')
  const id = String(user.id || '').trim()
  if (!key || !id) return listPresence(key)
  if (!rooms.has(key)) rooms.set(key, new Map())
  const map = rooms.get(key)
  map.set(id, {
    id,
    name: String(user.name || id).slice(0, 40),
    color: String(user.color || '#409EFF').slice(0, 20),
    at: Date.now()
  })
  return listPresence(key)
}

function listPresence(roomKey) {
  const key = String(roomKey || '')
  prune(key)
  const map = rooms.get(key)
  if (!map) return []
  return Array.from(map.values()).map(user => ({
    id: user.id,
    name: user.name,
    color: user.color
  }))
}

function leavePresence(roomKey, userId) {
  const map = rooms.get(String(roomKey || ''))
  if (!map) return listPresence(roomKey)
  map.delete(String(userId || ''))
  return listPresence(roomKey)
}

module.exports = {
  PRESENCE_TTL_MS,
  beatPresence,
  listPresence,
  leavePresence
}
