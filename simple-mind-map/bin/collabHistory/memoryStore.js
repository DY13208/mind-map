const { randomUUID } = require('crypto')
const { cloneJson } = require('./canonical')

function emptyRoom(roomKey) {
  return {
    roomKey,
    revision: 0,
    nodes: {
      root: { isRoot: true, data: { uid: 'root', text: '未命名' }, children: [] }
    },
    metadata: {}
  }
}

function createMemoryHistoryStore(seed = {}) {
  const rooms = new Map()
  const ops = []
  const checkpoints = []
  const versions = []
  const audits = []
  const locks = new Map()
  let failNextRestore = false

  function roomOf(roomKey) {
    const key = String(roomKey || '')
    if (!rooms.has(key)) rooms.set(key, emptyRoom(key))
    return rooms.get(key)
  }

  if (seed.room) {
    const room = roomOf(seed.room.roomKey)
    Object.assign(room, cloneJson(seed.room))
  }

  return {
    kind: 'memory',
    roomOf,
    setFailNextRestore(value) {
      failNextRestore = !!value
    },
    async withRoomLock(roomKey, fn) {
      const key = String(roomKey || '')
      const prev = locks.get(key) || Promise.resolve()
      const curr = prev.then(() => fn(), () => fn())
      locks.set(key, curr.catch(() => {}))
      return curr
    },
    async getLiveState(roomKey) {
      return cloneJson(roomOf(roomKey))
    },
    async setLiveState(roomKey, next) {
      if (failNextRestore) {
        const err = new Error('injected restore failure')
        err.code = 'RESTORE_INJECTED_FAIL'
        throw err
      }
      const room = roomOf(roomKey)
      room.revision = Number(next.revision)
      room.nodes = cloneJson(next.nodes)
      room.metadata = cloneJson(next.metadata || {})
      return cloneJson(room)
    },
    async appendOperation(row) {
      ops.push(cloneJson(row))
      return row
    },
    async listOperations(roomKey, afterRevision, toRevision) {
      const after = Number(afterRevision || 0)
      const to = toRevision == null ? Infinity : Number(toRevision)
      return ops
        .filter(
          op =>
            op.room_key === roomKey &&
            Number(op.version) > after &&
            Number(op.version) <= to
        )
        .sort((a, b) => Number(a.version) - Number(b.version))
        .map(cloneJson)
    },
    async getOperation(roomKey, operationId) {
      return cloneJson(
        ops.find(
          op => op.room_key === roomKey && String(op.operation_id) === String(operationId)
        ) || null
      )
    },
    async insertCheckpoint(row) {
      const dup = checkpoints.find(
        item =>
          item.room_key === row.room_key &&
          Number(item.revision) === Number(row.revision)
      )
      if (dup) return cloneJson(dup)
      const next = { id: row.id || randomUUID(), ...cloneJson(row) }
      checkpoints.push(next)
      return next
    },
    async hasAnyCheckpoint(roomKey) {
      return checkpoints.some(item => item.room_key === roomKey)
    },
    async earliestCheckpoint(roomKey) {
      const hit = checkpoints
        .filter(item => item.room_key === roomKey)
        .sort((a, b) => Number(a.revision) - Number(b.revision))[0]
      return hit ? cloneJson(hit) : null
    },
    async latestCheckpointRevision(roomKey) {
      const hit = checkpoints
        .filter(item => item.room_key === roomKey)
        .sort((a, b) => Number(b.revision) - Number(a.revision))[0]
      return hit ? Number(hit.revision) : null
    },
    async operationStats(roomKey) {
      const versions = ops
        .filter(op => op.room_key === roomKey)
        .map(op => Number(op.version))
        .filter(n => Number.isFinite(n))
      if (!versions.length) {
        return { min: null, max: null, count: 0 }
      }
      return {
        min: Math.min(...versions),
        max: Math.max(...versions),
        count: versions.length
      }
    },
    async latestCheckpointAt(roomKey, revision) {
      const target = Number(revision)
      const hit = checkpoints
        .filter(item => item.room_key === roomKey && Number(item.revision) <= target)
        .sort((a, b) => Number(b.revision) - Number(a.revision))[0]
      return hit ? cloneJson(hit) : null
    },
    async getCheckpoint(id) {
      return cloneJson(checkpoints.find(item => item.id === id) || null)
    },
    async insertVersion(row) {
      const next = { id: row.id || randomUUID(), hidden: false, ...cloneJson(row) }
      versions.push(next)
      return next
    },
    async getVersion(roomKey, versionId) {
      return cloneJson(
        versions.find(
          item => item.room_key === roomKey && String(item.id) === String(versionId)
        ) || null
      )
    },
    async listVersions(roomKey, query = {}) {
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 20))
      let rows = versions.filter(item => item.room_key === roomKey && !item.hidden)
      if (query.type) rows = rows.filter(item => item.type === query.type)
      if (query.createdBy) {
        rows = rows.filter(item => item.created_by === query.createdBy)
      }
      if (query.from) {
        const from = new Date(query.from).getTime()
        rows = rows.filter(item => new Date(item.created_at).getTime() >= from)
      }
      if (query.to) {
        const to = new Date(query.to).getTime()
        rows = rows.filter(item => new Date(item.created_at).getTime() <= to)
      }
      rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      if (query.cursor) {
        const idx = rows.findIndex(item => item.id === query.cursor)
        if (idx >= 0) rows = rows.slice(idx + 1)
      }
      const slice = rows.slice(0, limit)
      return {
        versions: slice.map(cloneJson),
        nextCursor: slice.length === limit ? slice[slice.length - 1].id : null
      }
    },
    async hideVersion(roomKey, versionId) {
      const row = versions.find(
        item => item.room_key === roomKey && String(item.id) === String(versionId)
      )
      if (row) row.hidden = true
      return row ? cloneJson(row) : null
    },
    async lastAutoVersionAt(roomKey) {
      const row = versions
        .filter(item => item.room_key === roomKey && item.type === 'AUTO')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      return row ? new Date(row.created_at).getTime() : 0
    },
    async insertAudit(row) {
      const next = { id: row.id || randomUUID(), created_at: new Date().toISOString(), ...row }
      audits.push(next)
      return next
    },
    async listAudit(roomKey) {
      return audits.filter(item => item.room_key === roomKey).map(cloneJson)
    },
    capture() {
      const roomDump = {}
      rooms.forEach((value, key) => {
        roomDump[key] = cloneJson(value)
      })
      return {
        rooms: roomDump,
        ops: cloneJson(ops),
        checkpoints: cloneJson(checkpoints),
        versions: cloneJson(versions),
        audits: cloneJson(audits)
      }
    },
    restoreCapture(cap) {
      rooms.clear()
      Object.keys(cap.rooms || {}).forEach(key => rooms.set(key, cloneJson(cap.rooms[key])))
      ops.splice(0, ops.length, ...cloneJson(cap.ops || []))
      checkpoints.splice(0, checkpoints.length, ...cloneJson(cap.checkpoints || []))
      versions.splice(0, versions.length, ...cloneJson(cap.versions || []))
      audits.splice(0, audits.length, ...cloneJson(cap.audits || []))
    },
    ops,
    checkpoints,
    versions,
    audits
  }
}

module.exports = { createMemoryHistoryStore }
