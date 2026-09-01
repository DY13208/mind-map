const PRESENCE_TTL_SEC = Math.max(
  5,
  Number(process.env.COLLAB_PRESENCE_TTL_SEC || 30)
)
const PRESENCE_TTL_MS = PRESENCE_TTL_SEC * 1000
const BACKEND = String(process.env.COLLAB_PRESENCE_BACKEND || 'auto').toLowerCase()

const memoryRooms = new Map()
let redisClient = null
let redisInitPromise = null
let redisUnavailable = false

function loadRedisClient() {
  try {
    return require('redis')
  } catch (err) {
    return null
  }
}

function redisUrl() {
  return process.env.REDIS_URL || process.env.COLLAB_REDIS_URL || ''
}

function shouldUseRedis() {
  if (BACKEND === 'memory') return false
  if (BACKEND === 'redis') return true
  return !!redisUrl()
}

function presenceKey(roomKey, clientId) {
  return `presence:${encodeURIComponent(String(roomKey || ''))}:${encodeURIComponent(
    String(clientId || '')
  )}`
}

function presenceScanPattern(roomKey) {
  return `presence:${encodeURIComponent(String(roomKey || ''))}:*`
}

function normalizeUser(user = {}) {
  const id = String(user.id || '').trim()
  const clientId = String(user.clientId || user.client_id || id).trim() || id
  return {
    id,
    clientId,
    name: String(user.name || id).slice(0, 40),
    color: String(user.color || '#409EFF').slice(0, 20)
  }
}

function pruneMemory(roomKey, now = Date.now()) {
  const map = memoryRooms.get(roomKey)
  if (!map) return
  map.forEach((entry, clientId) => {
    if (!entry || now - entry.at > PRESENCE_TTL_MS) map.delete(clientId)
  })
  if (!map.size) memoryRooms.delete(roomKey)
}

function listMemory(roomKey) {
  const key = String(roomKey || '')
  pruneMemory(key)
  const map = memoryRooms.get(key)
  if (!map) return []
  const byUser = new Map()
  map.forEach(entry => {
    if (!entry || !entry.id) return
    const prev = byUser.get(entry.id)
    if (!prev || entry.at >= prev.at) byUser.set(entry.id, entry)
  })
  return Array.from(byUser.values()).map(entry => ({
    id: entry.id,
    name: entry.name,
    color: entry.color,
    clientId: entry.clientId
  }))
}

function beatMemory(roomKey, user = {}) {
  const key = String(roomKey || '')
  const normalized = normalizeUser(user)
  if (!key || !normalized.id || !normalized.clientId) return listMemory(key)
  if (!memoryRooms.has(key)) memoryRooms.set(key, new Map())
  const map = memoryRooms.get(key)
  map.set(normalized.clientId, {
    ...normalized,
    at: Date.now()
  })
  return listMemory(key)
}

function leaveMemory(roomKey, userId, clientId) {
  const map = memoryRooms.get(String(roomKey || ''))
  if (!map) return listMemory(roomKey)
  const id = String(userId || '').trim()
  const cid = String(clientId || userId || '').trim()
  if (cid) map.delete(cid)
  else {
    map.forEach((entry, key) => {
      if (entry && entry.id === id) map.delete(key)
    })
  }
  return listMemory(roomKey)
}

async function getRedisClient() {
  if (!shouldUseRedis()) return null
  if (redisUnavailable) return null
  if (redisClient) return redisClient
  if (redisInitPromise) return redisInitPromise
  redisInitPromise = (async () => {
    const url = redisUrl()
    if (!url) {
      redisUnavailable = true
      return null
    }
    const redis = loadRedisClient()
    if (!redis || typeof redis.createClient !== 'function') {
      redisUnavailable = true
      return null
    }
    const client = redis.createClient({ url })
    client.on('error', err => {
      console.error('[presence] redis error', err.message)
    })
    await client.connect()
    redisClient = client
    return client
  })().catch(err => {
    redisUnavailable = true
    redisInitPromise = null
    console.error('[presence] redis init failed, using memory', err.message)
    return null
  })
  return redisInitPromise
}

async function listRedis(roomKey) {
  const client = await getRedisClient()
  if (!client) return listMemory(roomKey)
  const pattern = presenceScanPattern(roomKey)
  const byUser = new Map()
  let cursor = '0'
  do {
    const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 })
    cursor = reply.cursor
    const keys = reply.keys || []
    if (!keys.length) continue
    const values = await client.mGet(keys)
    values.forEach(raw => {
      if (!raw) return
      try {
        const entry = JSON.parse(raw)
        if (!entry || !entry.id) return
        const prev = byUser.get(entry.id)
        if (!prev || Number(entry.at || 0) >= Number(prev.at || 0)) {
          byUser.set(entry.id, entry)
        }
      } catch (err) {
        // ignore malformed presence entries
      }
    })
  } while (cursor !== '0')
  return Array.from(byUser.values()).map(entry => ({
    id: entry.id,
    name: entry.name,
    color: entry.color,
    clientId: entry.clientId
  }))
}

async function beatRedis(roomKey, user = {}) {
  const client = await getRedisClient()
  const normalized = normalizeUser(user)
  const key = String(roomKey || '')
  if (!client) return beatMemory(key, normalized)
  if (!key || !normalized.id || !normalized.clientId) return listRedis(key)
  await client.set(
    presenceKey(key, normalized.clientId),
    JSON.stringify({
      id: normalized.id,
      clientId: normalized.clientId,
      name: normalized.name,
      color: normalized.color,
      at: Date.now()
    }),
    { EX: PRESENCE_TTL_SEC }
  )
  return listRedis(key)
}

async function leaveRedis(roomKey, userId, clientId) {
  const client = await getRedisClient()
  const key = String(roomKey || '')
  if (!client) return leaveMemory(key, userId, clientId)
  const id = String(userId || '').trim()
  const cid = String(clientId || userId || '').trim()
  if (cid) {
    await client.del(presenceKey(key, cid))
  } else {
    const pattern = presenceScanPattern(key)
    let cursor = '0'
    do {
      const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 })
      cursor = reply.cursor
      const keys = reply.keys || []
      if (!keys.length) continue
      const values = await client.mGet(keys)
      const toDelete = []
      values.forEach((raw, index) => {
        if (!raw) return
        try {
          const entry = JSON.parse(raw)
          if (entry && entry.id === id) toDelete.push(keys[index])
        } catch (err) {
          // ignore
        }
      })
      if (toDelete.length) await client.del(toDelete)
    } while (cursor !== '0')
  }
  return listRedis(key)
}

async function listPresence(roomKey) {
  const client = await getRedisClient()
  if (client) return listRedis(roomKey)
  return listMemory(roomKey)
}

async function beatPresence(roomKey, user = {}) {
  const client = await getRedisClient()
  if (client) return beatRedis(roomKey, user)
  return beatMemory(roomKey, user)
}

async function leavePresence(roomKey, userId, clientId) {
  const client = await getRedisClient()
  if (client) return leaveRedis(roomKey, userId, clientId)
  return leaveMemory(roomKey, userId, clientId)
}

function getPresenceStatus() {
  return {
    backend: shouldUseRedis() && redisClient && !redisUnavailable ? 'redis' : 'memory',
    ttlSec: PRESENCE_TTL_SEC,
    redisConfigured: !!redisUrl()
  }
}

module.exports = {
  PRESENCE_TTL_MS,
  PRESENCE_TTL_SEC,
  beatPresence,
  listPresence,
  leavePresence,
  getPresenceStatus
}
