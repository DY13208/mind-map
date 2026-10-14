const { EventEmitter } = require('node:events')
const changes = new EventEmitter()
const TTL_MS = 60000
const rooms = new Map()

function touch(roomKey, user, now = Date.now()) {
  if (!roomKey || !user || !user.id) return
  let peers = rooms.get(roomKey)
  if (!peers) { peers = new Map(); rooms.set(roomKey, peers) }
  const userId = String(user.id)
  const clientId = `mcp:${userId}`
  const previous = peers.get(clientId)
  peers.set(clientId, { clientId, userId, name: user.name || userId,
    source: 'mcp', color: '#7c3aed', updatedAt: now })
  if (!previous) changes.emit('change', roomKey)
}

function list(roomKey, now = Date.now()) {
  prune(now)
  return Array.from((rooms.get(roomKey) || new Map()).values())
}

function prune(now = Date.now()) {
  for (const [roomKey, peers] of rooms) {
    let changed = false
    for (const [key, peer] of peers) {
      if (now - peer.updatedAt >= TTL_MS) { peers.delete(key); changed = true }
    }
    if (!peers.size) rooms.delete(roomKey)
    if (changed) changes.emit('change', roomKey)
  }
}

function observe(req, res, pathname) {
  const match = pathname.match(/^\/api\/files\/([^/]+)(?:\/|$)/)
  if (!match || !req.verifiedMcpSource || !req.authUser || !req.authUser.id) return
  let roomKey
  try { roomKey = decodeURIComponent(match[1]) } catch (_) { return }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(roomKey)) return
  res.once('finish', () => {
    // Failed/forbidden calls never announce an account in a room.
    if (res.statusCode >= 200 && res.statusCode < 300) touch(roomKey, req.authUser)
  })
}

module.exports = { touch, list, prune, observe, changes, TTL_MS }
