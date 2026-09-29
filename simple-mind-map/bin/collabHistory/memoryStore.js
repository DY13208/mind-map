const { randomUUID } = require('crypto')
const { cloneJson } = require('./canonical')
const { encodeCursor, decodeCursor } = require('./pgStore')

function emptyRoom(roomKey) {
  return {
    roomKey,
    revision: 0,
    restoreEpochRevision: 0,
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
  const legacyMaps = []
  const autoJobs = new Map()
  const restoreKeys = new Map()
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

  const api = {
    kind: 'memory',
    roomOf,
    setFailNextRestore(value) {
      failNextRestore = !!value
    },
    async withTx(fn) {
      return fn(api)
    },
    async withRoomLock(roomKey, fn) {
      const key = String(roomKey || '')
      const prev = locks.get(key) || Promise.resolve()
      const curr = prev.then(
        () => fn(api),
        () => fn(api)
      )
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
      if (next.restoreEpochRevision != null) {
        room.restoreEpochRevision = Number(next.restoreEpochRevision)
      }
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
          op =>
            op.room_key === roomKey &&
            String(op.operation_id) === String(operationId)
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
      const list = ops
        .filter(op => op.room_key === roomKey)
        .map(op => Number(op.version))
        .filter(n => Number.isFinite(n))
      if (!list.length) {
        return { min: null, max: null, count: 0 }
      }
      return {
        min: Math.min(...list),
        max: Math.max(...list),
        count: list.length
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
      if (String(row.type || '').toUpperCase() === 'AUTO' && row.revision != null) {
        const dup = versions.find(
          item =>
            item.room_key === row.room_key &&
            item.type === 'AUTO' &&
            !item.hidden &&
            Number(item.revision) === Number(row.revision)
        )
        if (dup) return cloneJson(dup)
      }
      const next = {
        id: row.id || randomUUID(),
        hidden: false,
        summary: {},
        summary_status: 'pending',
        editors: [],
        source_kind: '',
        availability: 'readable',
        legacy_source: '',
        ...cloneJson(row)
      }
      versions.push(next)
      return cloneJson(next)
    },
    async getVersion(roomKey, versionId, options = {}) {
      const row = versions.find(
        item => item.room_key === roomKey && String(item.id) === String(versionId)
      )
      if (!row) return null
      if (!options.includeHidden && row.hidden) return null
      return cloneJson(row)
    },
    async getLegacySnapshot(roomKey, versionId) {
      return cloneJson(
        legacyMaps.find(
          item =>
            item.room_key === roomKey && String(item.version_id) === String(versionId)
        ) || null
      )
    },
    async previousVisibleVersion(roomKey, before) {
      const rows = versions
        .filter(item => item.room_key === roomKey && !item.hidden)
        .sort((a, b) => {
          const dt = new Date(b.created_at) - new Date(a.created_at)
          if (dt) return dt
          // Consecutive snapshots can share the same millisecond. Their room
          // revision, not a random UUID, determines which came later.
          const dr = Number(b.revision ?? -1) - Number(a.revision ?? -1)
          if (dr) return dr
          return String(b.id).localeCompare(String(a.id))
        })
      if (!before) return rows[0] ? cloneJson(rows[0]) : null
      const idx = rows.findIndex(item => String(item.id) === String(before.id))
      const hit = idx >= 0 ? rows[idx + 1] : rows.find(item => {
        const dt = new Date(item.created_at) - new Date(before.created_at)
        const dr = Number(item.revision ?? -1) - Number(before.revision ?? -1)
        return (
          dt < 0 ||
          (dt === 0 &&
            (dr < 0 || (dr === 0 && String(item.id) < String(before.id))))
        )
      })
      return hit ? cloneJson(hit) : null
    },
    async updateVersionMeta(roomKey, versionId, patch) {
      const row = versions.find(
        item => item.room_key === roomKey && String(item.id) === String(versionId)
      )
      if (!row) return null
      if (patch.summary != null) row.summary = patch.summary
      if (patch.summary_status) row.summary_status = patch.summary_status
      if (patch.editors) row.editors = patch.editors
      if (patch.availability) row.availability = patch.availability
      return cloneJson(row)
    },
    async resolveUserNames() {
      return {}
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
      rows.sort((a, b) => {
        const dt = new Date(b.created_at) - new Date(a.created_at)
        if (dt) return dt
        return String(b.id).localeCompare(String(a.id))
      })
      if (query.cursor) {
        const cur = decodeCursor(query.cursor)
        const idx = rows.findIndex(item => String(item.id) === String(cur.id))
        if (idx >= 0) rows = rows.slice(idx + 1)
      }
      const slice = rows.slice(0, limit)
      return {
        versions: slice.map(cloneJson),
        nextCursor:
          slice.length === limit ? encodeCursor(slice[slice.length - 1]) : null
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
    async lastAutoVersionRevision(roomKey) {
      const row = versions
        .filter(
          item =>
            item.room_key === roomKey &&
            item.type === 'AUTO' &&
            item.revision != null
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      return row ? Number(row.revision) : null
    },
    async latestVisibleRevision(roomKey) {
      let max = null
      versions.forEach(item => {
        if (item.room_key !== roomKey || item.hidden || item.revision == null) return
        const n = Number(item.revision)
        if (!Number.isFinite(n)) return
        if (max == null || n > max) max = n
      })
      return max
    },
    async insertAudit(row) {
      const next = {
        id: row.id || randomUUID(),
        created_at: new Date().toISOString(),
        ...row
      }
      audits.push(next)
      return next
    },
    async listAudit(roomKey) {
      return audits.filter(item => item.room_key === roomKey).map(cloneJson)
    },
    async upsertAutoJob(row) {
      const prev = autoJobs.get(row.room_key)
      const editors = Array.from(
        new Set([...(prev && prev.editors ? prev.editors : []), ...(row.editors || [])])
      )
      autoJobs.set(row.room_key, {
        room_key: row.room_key,
        last_revision: Number(row.last_revision || 0),
        last_activity_at: row.last_activity_at || new Date().toISOString(),
        due_at: row.due_at || new Date().toISOString(),
        editors,
        status: 'pending',
        attempts: Number((prev && prev.attempts) || 0),
        last_error: null
      })
    },
    async claimDueAutoJobs(now, limit, workerId, maxAttempts) {
      const ts = new Date(now).getTime()
      const due = []
      autoJobs.forEach(job => {
        if (
          job.status === 'pending' &&
          new Date(job.due_at).getTime() <= ts &&
          Number(job.attempts || 0) < Number(maxAttempts || 5)
        ) {
          due.push(job)
        }
      })
      due.sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
      return due.slice(0, Math.max(1, Number(limit) || 8)).map(job => {
        job.status = 'running'
        job.attempts = Number(job.attempts || 0) + 1
        job.locked_by = workerId || 'memory'
        return cloneJson(job)
      })
    },
    async completeAutoJob(roomKey, revision) {
      const job = autoJobs.get(roomKey)
      if (!job) return
      if (revision == null || Number(job.last_revision || 0) <= Number(revision)) {
        autoJobs.delete(roomKey)
      }
    },
    async failAutoJob(roomKey, error) {
      const job = autoJobs.get(roomKey)
      if (!job) return
      job.status = 'pending'
      job.last_error = String((error && error.message) || error || '')
      job.due_at = new Date(Date.now() + 15000).toISOString()
    },
    async getRestoreIdempotency(roomKey, key) {
      const hit = restoreKeys.get(roomKey + '\0' + key)
      return hit ? cloneJson(hit) : null
    },
    async putRestoreIdempotency(roomKey, key, result) {
      const id = roomKey + '\0' + key
      if (!restoreKeys.has(id)) restoreKeys.set(id, cloneJson(result || {}))
      return cloneJson(restoreKeys.get(id))
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
      Object.keys(cap.rooms || {}).forEach(key =>
        rooms.set(key, cloneJson(cap.rooms[key]))
      )
      ops.splice(0, ops.length, ...cloneJson(cap.ops || []))
      checkpoints.splice(0, checkpoints.length, ...cloneJson(cap.checkpoints || []))
      versions.splice(0, versions.length, ...cloneJson(cap.versions || []))
      audits.splice(0, audits.length, ...cloneJson(cap.audits || []))
    },
    ops,
    checkpoints,
    versions,
    audits,
    legacyMaps
  }
  return api
}

module.exports = { createMemoryHistoryStore }
