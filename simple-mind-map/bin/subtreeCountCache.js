'use strict'

const MAX_CACHED_ROOMS = 16
const MAX_CACHED_NODE_COUNTS = 100000

const roomsByDatabase = new WeakMap()
const lru = new Map()
let cachedNodeCounts = 0

function isObjectKey(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function roomMapFor(db) {
  let rooms = roomsByDatabase.get(db)
  if (!rooms) {
    rooms = new Map()
    roomsByDatabase.set(db, rooms)
  }
  return rooms
}

function removeState(state) {
  if (!state) return
  if (state.counts !== null) {
    cachedNodeCounts -= state.counts.size
    state.counts = null
  }
  lru.delete(state)
  const rooms = roomsByDatabase.get(state.db)
  if (rooms && rooms.get(state.roomKey) === state) rooms.delete(state.roomKey)
}

function touch(state) {
  lru.delete(state)
  lru.set(state, true)
}

function evictOldestCompleted(protectedState) {
  for (const state of lru.keys()) {
    if (state !== protectedState && state.counts !== null && !state.pending) {
      removeState(state)
      return true
    }
  }
  return false
}

function trim(protectedState) {
  while (lru.size > MAX_CACHED_ROOMS || cachedNodeCounts > MAX_CACHED_NODE_COUNTS) {
    if (!evictOldestCompleted(protectedState)) break
  }
}

async function loadWithoutCache(loader) {
  const counts = await loader()
  return { counts, queryCount: 1 }
}

/**
 * Cache authoritative counts by database identity, room and room version.
 * A stale snapshot may read its own version, but it must not replace a newer
 * version already held for that room.
 */
async function getRoomSubtreeCounts(db, roomKey, version, loader) {
  const normalizedVersion = Number(version)
  if (!isObjectKey(db) || !Number.isFinite(normalizedVersion)) {
    return loadWithoutCache(loader)
  }

  const key = String(roomKey || '')
  const rooms = roomMapFor(db)
  let state = rooms.get(key)

  if (state && state.version > normalizedVersion) {
    return loadWithoutCache(loader)
  }

  if (state && state.version === normalizedVersion) {
    touch(state)
    if (state.counts !== null) return { counts: state.counts, queryCount: 0 }
    if (state.pending) return { counts: await state.pending, queryCount: 0 }
  } else {
    if (state) removeState(state)
    // Reserve a room slot before creating a pending state. If every slot is
    // occupied by an in-flight load, still compute this request but do not
    // let transient concurrency grow the cache beyond its room limit.
    while (lru.size >= MAX_CACHED_ROOMS) {
      if (!evictOldestCompleted()) return loadWithoutCache(loader)
    }
    state = {
      db,
      roomKey: key,
      version: normalizedVersion,
      counts: null,
      pending: null
    }
    rooms.set(key, state)
    touch(state)
    trim(state)
  }

  const currentState = state
  const pending = Promise.resolve().then(loader).then(counts => {
    if (!(counts instanceof Map)) {
      throw new TypeError('Room subtree count loader must return a Map')
    }
    currentState.pending = null
    const currentRooms = roomsByDatabase.get(db)
    if (!currentRooms || currentRooms.get(key) !== currentState) return counts

    if (counts.size > MAX_CACHED_NODE_COUNTS) {
      removeState(currentState)
      return counts
    }

    while (cachedNodeCounts + counts.size > MAX_CACHED_NODE_COUNTS) {
      if (!evictOldestCompleted(currentState)) {
        removeState(currentState)
        return counts
      }
    }
    currentState.counts = counts
    cachedNodeCounts += counts.size
    touch(currentState)
    trim(currentState)
    return counts
  }).catch(error => {
    currentState.pending = null
    removeState(currentState)
    throw error
  })
  currentState.pending = pending
  return { counts: await pending, queryCount: 1 }
}

function resetRoomSubtreeCountsCache() {
  for (const state of lru.keys()) removeState(state)
  lru.clear()
  cachedNodeCounts = 0
}

function roomSubtreeCountsCacheStats() {
  return {
    rooms: lru.size,
    nodeCounts: cachedNodeCounts,
    maxRooms: MAX_CACHED_ROOMS,
    maxNodeCounts: MAX_CACHED_NODE_COUNTS
  }
}

module.exports = {
  getRoomSubtreeCounts,
  resetRoomSubtreeCountsCache,
  roomSubtreeCountsCacheStats
}
