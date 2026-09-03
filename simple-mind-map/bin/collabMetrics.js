const LATENCY_SAMPLES = Math.max(
  50,
  Number(process.env.COLLAB_METRICS_LATENCY_SAMPLES || 500)
)
const ALERT_LIMIT = Math.max(
  20,
  Number(process.env.COLLAB_METRICS_ALERT_LIMIT || 100)
)

const startedAt = Date.now()
const opLatencies = []
const roomStats = new Map()
const alerts = []

let opsTotal = 0
let opsFailed = 0
let opsDuplicate = 0
let recoveries = 0
let resnapshots = 0
let wsConnections = 0
let wsReconnectHints = 0
let broadcastCount = 0
let broadcastLatencySum = 0
let lastVersionGap = null

function ensureRoom(mapId) {
  const key = String(mapId || '')
  if (!roomStats.has(key)) {
    roomStats.set(key, {
      mapId: key,
      version: 0,
      ops: 0,
      fails: 0,
      lastOpAt: 0,
      lastErrorCode: ''
    })
  }
  return roomStats.get(key)
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  )
  return sorted[idx]
}

function pushLatency(ms) {
  opLatencies.push(Math.max(0, Number(ms) || 0))
  if (opLatencies.length > LATENCY_SAMPLES) {
    opLatencies.splice(0, opLatencies.length - LATENCY_SAMPLES)
  }
}

function recordOperation({
  mapId,
  version,
  ok = true,
  duplicate = false,
  durationMs = 0,
  code = ''
} = {}) {
  opsTotal += 1
  if (duplicate) opsDuplicate += 1
  if (!ok) {
    opsFailed += 1
  }
  pushLatency(durationMs)
  const room = ensureRoom(mapId)
  room.ops += 1
  room.lastOpAt = Date.now()
  if (Number.isFinite(Number(version))) {
    const next = Number(version)
    if (room.version && next > room.version + 1) {
      pushAlert('version_gap', {
        mapId,
        expected: room.version + 1,
        actual: next
      })
      lastVersionGap = { mapId, expected: room.version + 1, actual: next }
    }
    if (room.version && next === room.version) {
      // duplicate version only expected for duplicate ops
      if (!duplicate) {
        pushAlert('duplicate_version', { mapId, version: next })
      }
    }
    room.version = Math.max(room.version, next)
  }
  if (!ok) {
    room.fails += 1
    room.lastErrorCode = String(code || 'ERROR')
  }
}

function recordRecovery(kind = 'operations') {
  if (kind === 'resnapshot') resnapshots += 1
  else recoveries += 1
}

function recordBroadcast(latencyMs = 0) {
  broadcastCount += 1
  broadcastLatencySum += Math.max(0, Number(latencyMs) || 0)
}

function setWsConnections(count) {
  wsConnections = Math.max(0, Number(count) || 0)
}

function noteWsReconnect() {
  wsReconnectHints += 1
}

function pushAlert(type, details = {}) {
  alerts.unshift({
    type,
    at: new Date().toISOString(),
    ...details
  })
  if (alerts.length > ALERT_LIMIT) alerts.length = ALERT_LIMIT
}

function latencyStats() {
  const sorted = opLatencies.slice().sort((a, b) => a - b)
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0
  }
}

function getMetricsSnapshot() {
  const rooms = Array.from(roomStats.values())
    .sort((a, b) => b.lastOpAt - a.lastOpAt)
    .slice(0, 50)
  return {
    uptimeMs: Date.now() - startedAt,
    operations: {
      total: opsTotal,
      failed: opsFailed,
      duplicate: opsDuplicate,
      latencyMs: latencyStats()
    },
    recovery: {
      operationsFetches: recoveries,
      resnapshots
    },
    websocket: {
      connections: wsConnections,
      reconnectHints: wsReconnectHints,
      broadcasts: broadcastCount,
      broadcastAvgLatencyMs: broadcastCount
        ? Math.round(broadcastLatencySum / broadcastCount)
        : 0
    },
    rooms,
    alerts: alerts.slice(0, 20),
    lastVersionGap
  }
}

function logCollab(event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    mapId: fields.mapId || fields.roomKey || undefined,
    operationId: fields.operationId || undefined,
    version: fields.version != null ? Number(fields.version) : undefined,
    actorId: fields.actorId || undefined,
    code: fields.code || undefined,
    durationMs: fields.durationMs != null ? Number(fields.durationMs) : undefined,
    duplicate: fields.duplicate || undefined,
    message: fields.message || undefined
  }
  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) delete payload[key]
  })
  const line = JSON.stringify(payload)
  if (fields.level === 'error') console.error(line)
  else if (fields.level === 'warn') console.warn(line)
  else console.log(line)
}

function redactSensitive(value, depth = 0) {
  if (depth > 4 || value == null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => redactSensitive(item, depth + 1))
  }
  if (typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 500) {
      return `${value.slice(0, 120)}…(${value.length} chars)`
    }
    return value
  }
  const out = {}
  Object.keys(value).forEach(key => {
    const lower = key.toLowerCase()
    if (
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('password') ||
      lower.includes('authorization') ||
      lower.includes('cookie')
    ) {
      out[key] = '[redacted]'
      return
    }
    if (lower === 'image' || lower === 'avatar') {
      const raw = value[key]
      out[key] =
        typeof raw === 'string' && raw.length > 80
          ? `[binary ${raw.length}]`
          : raw
      return
    }
    out[key] = redactSensitive(value[key], depth + 1)
  })
  return out
}

function _resetForTests() {
  opLatencies.length = 0
  roomStats.clear()
  alerts.length = 0
  opsTotal = 0
  opsFailed = 0
  opsDuplicate = 0
  recoveries = 0
  resnapshots = 0
  wsConnections = 0
  wsReconnectHints = 0
  broadcastCount = 0
  broadcastLatencySum = 0
  lastVersionGap = null
}

module.exports = {
  recordOperation,
  recordRecovery,
  recordBroadcast,
  setWsConnections,
  noteWsReconnect,
  pushAlert,
  getMetricsSnapshot,
  logCollab,
  redactSensitive,
  _resetForTests
}
