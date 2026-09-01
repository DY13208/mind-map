require('./loadEnv')
const { EventEmitter } = require('events')
const { Pool } = require('pg')
const COS = require('cos-nodejs-sdk-v5')
const Y = require('yjs')
const { setPersistence, getYDoc, docs } = require('y-websocket/bin/utils')
const { applyObjectToDoc } = require('./collabYjs')
const {
  graphsEqual,
  nodesDualWriteEnabled,
  nodesReadPreferEnabled,
  nodesTableAuthorityEnabled,
  canonicalizeNodes,
  pickAuthoritativeNodes,
  auditRoomNodesState,
  replaceRoomNodes,
  readRoomNodes,
  listDeletedNodeUids,
  purgeDeletedNodes,
  validateNodeGraph
} = require('./roomNodes')
const mindDoc = require('./mindDoc')

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  application_name: process.env.COLLAB_PG_APP_NAME || 'mind-map-collab'
})

pool.on('error', err => {
  console.error('[pg] idle client error:', err && err.message ? err.message : err)
})

const operationEvents = new EventEmitter()
operationEvents.setMaxListeners(50)

function getPool() {
  return pool
}

const TRANSIENT_PG_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08003',
  '08006',
  '08001',
  '53300',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE'
])

function isTransientPgError(err) {
  if (!err) return false
  const code = String(err.code || err.errno || '')
  if (TRANSIENT_PG_CODES.has(code)) return true
  const msg = String(err.message || err)
  return /Connection terminated|server closed the connection|not queryable|ECONNRESET|ECONNREFUSED|connect ETIMEDOUT|Connection refused/i.test(
    msg
  )
}

async function withPgRetry(fn, options = {}) {
  const retries = Math.max(
    0,
    Number(
      options.retries != null
        ? options.retries
        : process.env.COLLAB_PG_RETRY != null
          ? process.env.COLLAB_PG_RETRY
          : 3
    )
  )
  const baseDelayMs = Math.max(
    20,
    Number(options.delayMs != null ? options.delayMs : 80)
  )
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      if (!isTransientPgError(err) || attempt >= retries) throw err
      const wait = baseDelayMs * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
  throw lastErr
}

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY
})

const Bucket = process.env.TENCENT_COS_BUCKET
const Region = process.env.TENCENT_COS_REGION
const location = String(process.env.TENCENT_COS_LOCATION || 'mind-map').replace(
  /^\/+|\/+$/g,
  ''
)
const acl = process.env.TENCENT_COS_ACL || 'private'

const saveTimers = new Map()
const pendingSaves = new Map()
const saveWorkers = new Map()
const preloadCache = new Map()
const deletedRooms = new Set()
const roomSaveStates = new Map()
const MAX_SAVE_CONCURRENCY = 1
const IDLE_EVICT_MS = 10 * 60 * 1000
const LARGE_MAP_NODES = 400

function isPresenceDocName(roomKey) {
  return String(roomKey || '').endsWith('__presence')
}

/** Once the op-log owns the room (version>0), live Y.Doc must not rewrite nodes. */
function shouldWriteLiveNodesToPg(pgVersion) {
  return !(Number(pgVersion) > 0)
}
let activeSaves = 0
const saveGate = []
const idleTimers = new Map()

function cancelIdleEvict(roomKey) {
  const key = String(roomKey || '')
  const timer = idleTimers.get(key)
  if (timer) clearTimeout(timer)
  idleTimers.delete(key)
}

function scheduleIdleEvict(roomKey) {
  const key = String(roomKey || '')
  cancelIdleEvict(key)
  idleTimers.set(
    key,
    setTimeout(() => {
      idleTimers.delete(key)
      const doc = docs.get(key)
      if (!doc || (doc.conns && doc.conns.size > 0)) return
      queueSave(key, doc)
        .catch(err => {
          console.error('[persist] idle save failed', key, err.message)
        })
        .finally(() => {
          const current = docs.get(key)
          if (!current || (current.conns && current.conns.size > 0)) return
          docs.delete(key)
          try {
            current.destroy()
          } catch (e) {
            // ignore
          }
        })
    }, IDLE_EVICT_MS)
  )
}

function saveDelay(ydoc) {
  try {
    return ydoc.getMap().size > LARGE_MAP_NODES ? 5000 : 1500
  } catch (e) {
    return 1500
  }
}

const COMPACT_MIN_BYTES = 512 * 1024

function compactYjsUpdate(raw) {
  const fresh = new Y.Doc({ gc: true })
  try {
    Y.applyUpdate(fresh, raw)
    return Buffer.from(Y.encodeStateAsUpdate(fresh))
  } finally {
    try {
      fresh.destroy()
    } catch (e) {
      // ignore
    }
  }
}

function acquireSaveSlot() {
  if (activeSaves < MAX_SAVE_CONCURRENCY) {
    activeSaves += 1
    return Promise.resolve()
  }
  return new Promise(resolve => {
    saveGate.push(resolve)
  })
}

function releaseSaveSlot() {
  const next = saveGate.shift()
  if (next) {
    next()
    return
  }
  activeSaves = Math.max(0, activeSaves - 1)
}

function timestampMs(value) {
  if (!value) return 0
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function pickLatestTimestamp(a, b) {
  return timestampMs(a) >= timestampMs(b) ? a || b || null : b || a || null
}

function setSaveState(roomKey, status, error = '') {
  roomSaveStates.set(roomKey, {
    status,
    error: error ? String(error) : '',
    updated_at: new Date().toISOString()
  })
}

function getSaveStatus(roomKey) {
  if (deletedRooms.has(roomKey)) {
    return { status: 'deleted', error: '', updated_at: new Date().toISOString() }
  }
  return (
    roomSaveStates.get(roomKey) || {
      status: 'saved',
      error: '',
      updated_at: null
    }
  )
}

function isDeletedRoom(roomKey) {
  return deletedRooms.has(String(roomKey || ''))
}

async function reviveRoom(roomKey) {
  const key = String(roomKey || '')
  await pool.query('delete from room_tombstones where room_key = $1', [key])
  deletedRooms.delete(key)
  roomSaveStates.delete(key)
}

function safeRoomKey(roomKey) {
  const key = String(roomKey || '').trim()
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
    throw new Error('房间号只能包含字母、数字、点、下划线和短横线，且不能超过80个字符')
  }
  return key
}

function cosKey(roomKey) {
  return `${location}/${safeRoomKey(roomKey)}.yjs`
}

function titleFromObj(obj) {
  try {
    const root = Object.values(obj || {}).find(item => item && item.isRoot)
    const raw = root && root.data && root.data.text
    if (!raw) return '未命名'
    const text = String(raw)
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, 80) || '未命名'
  } catch (e) {
    return '未命名'
  }
}

function nodesFromJson(value) {
  if (!value) return null
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return Object.keys(obj).length ? obj : null
  } catch (e) {
    return null
  }
}

function payloadToObject(payload) {
  if (!payload || payload.type === 'empty') return null
  if (payload.type === 'nodes') return nodesFromJson(payload.nodes)
  if (payload.type === 'yjs' && payload.buf && payload.buf.length) {
    const tmp = new Y.Doc({ gc: true })
    try {
      Y.applyUpdate(
        tmp,
        Buffer.isBuffer(payload.buf)
          ? payload.buf
          : new Uint8Array(payload.buf)
      )
      return nodesFromJson(tmp.getMap().toJSON())
    } finally {
      try {
        tmp.destroy()
      } catch (e) {
        // ignore
      }
    }
  }
  return null
}

function applyPayload(ydoc, payload) {
  const obj = payloadToObject(payload)
  if (!obj) return null
  applyObjectToDoc(ydoc, obj, { replace: true, previousObject: {} })
  return obj
}

function cosCall(method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

async function getYjsBuffer(roomKey) {
  try {
    const data = await cosCall('getObject', {
      Bucket,
      Region,
      Key: cosKey(roomKey)
    })
    const body = data.Body
    if (!body) return null
    if (Buffer.isBuffer(body)) return body
    return Buffer.from(body)
  } catch (err) {
    const code = err && (err.statusCode || err.code)
    if (code === 404 || code === 'NoSuchKey' || String(err.message).includes('404')) {
      return null
    }
    throw err
  }
}

async function putYjsBuffer(roomKey, buf) {
  await cosCall('putObject', {
    Bucket,
    Region,
    Key: cosKey(roomKey),
    Body: buf,
    ContentType: 'application/octet-stream',
    ACL: acl
  })
}

async function deleteYjsBuffer(roomKey) {
  try {
    await cosCall('deleteObject', {
      Bucket,
      Region,
      Key: cosKey(roomKey)
    })
  } catch (err) {
    const code = err && (err.statusCode || err.code)
    if (code === 404 || code === 'NoSuchKey') return
    throw err
  }
}

function normalizeTitle(title) {
  return String(title || '').trim().slice(0, 80) || '未命名'
}

async function writeRoomNodeRows(db, roomKey, nodes, version, options = {}) {
  if (!nodesDualWriteEnabled()) return { wrote: false, skipped: true }
  if (nodes == null) return { wrote: false, skipped: true }
  const result = await replaceRoomNodes(db, roomKey, nodes, version, options)
  if (!result.wrote) {
    console.error(
      '[room_nodes] skip invalid graph',
      roomKey,
      (result.errors || []).slice(0, 5).join('; ')
    )
  }
  return result
}

function snapshotNodesForStorage(nodes) {
  const canonical = canonicalizeNodes(nodes || {})
  return canonical.ok ? canonical.nodes : nodes || {}
}

async function upsertRoom(roomKey, title, options = {}) {
  const preserveExistingTitle = options.preserveExistingTitle === true
  const nodes = nodesFromJson(options.nodes)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const res = await client.query(
      `insert into rooms (room_key, title, cos_key, nodes, updated_at)
       values ($1, $2, $3, $4::jsonb, now())
       on conflict (room_key) do update set
         title = case when $5 then rooms.title else excluded.title end,
         cos_key = excluded.cos_key,
         nodes = case when $6 then excluded.nodes else rooms.nodes end,
         updated_at = now()
       returning room_key, title, cos_key, version, created_at, updated_at`,
      [
        roomKey,
        normalizeTitle(title),
        cosKey(roomKey),
        nodes ? JSON.stringify(nodes) : null,
        preserveExistingTitle,
        !!nodes
      ]
    )
    const row = res.rows[0]
    if (nodes) {
      const snapshot = snapshotNodesForStorage(nodes)
      await writeRoomNodeRows(
        client,
        roomKey,
        snapshot,
        Number((row && row.version) || 0)
      )
      if (nodesTableAuthorityEnabled() && snapshot !== nodes) {
        await client.query(
          `update rooms set nodes = $2::jsonb where room_key = $1`,
          [roomKey, JSON.stringify(snapshot)]
        )
      }
    }
    await client.query('commit')
    return row
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function backupYjsToCos(roomKey, ydoc) {
  const raw = Y.encodeStateAsUpdate(ydoc)
  const shouldCompact = raw.byteLength >= COMPACT_MIN_BYTES
  const buf = shouldCompact ? compactYjsUpdate(raw) : Buffer.from(raw)
  if (shouldCompact && buf.length < raw.byteLength) {
    console.log(
      '[persist] compacted',
      roomKey,
      raw.byteLength,
      '->',
      buf.length
    )
  }
  return putYjsBuffer(roomKey, buf)
}

async function saveDoc(roomKey, ydoc) {
  if (isDeletedRoom(roomKey) || isPresenceDocName(roomKey)) return
  if (!ydoc || typeof ydoc.getMap !== 'function' || !ydoc.getMap().size) return
  setSaveState(roomKey, 'saving')
  await acquireSaveSlot()
  try {
    if (isDeletedRoom(roomKey) || typeof ydoc.getMap !== 'function') return
    const obj = ydoc.getMap().toJSON()
    if (!obj || !Object.keys(obj).length) return
    const row = await getRoom(roomKey)
    const pgVersion = Number((row && row.version) || 0)
    // HTTP op-log is authoritative after version advances. A concurrent live Y.Doc
    // save (toJSON then upsert) can otherwise clobber a newer insert/update and
    // make newly added children disappear after refresh.
    if (!shouldWriteLiveNodesToPg(pgVersion)) {
      setSaveState(roomKey, 'saved')
      const nodeCount = Object.keys(obj).length
      if (nodeCount < LARGE_MAP_NODES) {
        backupYjsToCos(roomKey, ydoc).catch(err => {
          console.error('[persist] cos backup failed', roomKey, err.message)
        })
      }
      return
    }
    await upsertRoom(roomKey, titleFromObj(obj), {
      preserveExistingTitle: true,
      nodes: obj
    })
    if (isDeletedRoom(roomKey)) {
      await purgeRoomStorage(roomKey)
      return
    }
    setSaveState(roomKey, 'saved')
    const nodeCount = Object.keys(obj).length
    if (nodeCount < LARGE_MAP_NODES) {
      backupYjsToCos(roomKey, ydoc).catch(err => {
        console.error('[persist] cos backup failed', roomKey, err.message)
      })
    }
  } catch (err) {
    setSaveState(
      roomKey,
      isDeletedRoom(roomKey) ? 'deleted' : 'error',
      isDeletedRoom(roomKey) ? '' : err.message || err
    )
    throw err
  } finally {
    releaseSaveSlot()
  }
}

function queueSave(roomKey, ydoc) {
  if (isDeletedRoom(roomKey)) return Promise.resolve()
  pendingSaves.set(roomKey, ydoc)
  const currentWorker = saveWorkers.get(roomKey)
  if (currentWorker) return currentWorker
  const worker = (async () => {
    while (pendingSaves.has(roomKey) && !isDeletedRoom(roomKey)) {
      const latestDoc = pendingSaves.get(roomKey)
      pendingSaves.delete(roomKey)
      await saveDoc(roomKey, latestDoc)
    }
  })().finally(() => {
    saveWorkers.delete(roomKey)
  })
  saveWorkers.set(roomKey, worker)
  return worker
}

async function purgeRoomStorage(roomKey) {
  await deleteYjsBuffer(roomKey)
  preloadCache.delete(roomKey)
  await pool.query('delete from rooms where room_key = $1', [roomKey])
}

async function persistHotSnapshot(roomKey, ydoc) {
  if (
    isDeletedRoom(roomKey) ||
    isPresenceDocName(roomKey) ||
    !ydoc ||
    typeof ydoc.getMap !== 'function'
  ) {
    return
  }
  const size = ydoc.getMap().size
  if (!size) return
  const row = await getRoom(roomKey)
  const pgVersion = Number((row && row.version) || 0)
  if (!shouldWriteLiveNodesToPg(pgVersion)) {
    setSaveState(roomKey, 'saved')
    return
  }
  if (size >= LARGE_MAP_NODES) {
    await pool.query('update rooms set updated_at = now() where room_key = $1', [
      roomKey
    ])
    setSaveState(roomKey, 'saved')
    return
  }
  const obj = ydoc.getMap().toJSON()
  await upsertRoom(roomKey, titleFromObj(obj), {
    preserveExistingTitle: true,
    nodes: obj
  })
  setSaveState(roomKey, 'saved')
  scheduleSave(roomKey, ydoc)
}

function getMemoryDoc(roomKey) {
  const doc = docs.get(String(roomKey || ''))
  if (!doc || typeof doc.getMap !== 'function') return null
  return doc
}

function getLiveDoc(roomKey) {
  const doc = getMemoryDoc(roomKey)
  if (!doc || !doc.getMap().size) return null
  return doc
}

function getLiveObject(roomKey) {
  const doc = getLiveDoc(roomKey)
  if (!doc) return null
  return doc.getMap().toJSON()
}

function invalidateRoomCache(roomKey) {
  preloadCache.delete(String(roomKey || ''))
}

function rememberRoomNodes(roomKey, nodes) {
  const obj = nodesFromJson(nodes)
  if (!obj) {
    invalidateRoomCache(roomKey)
    return
  }
  preloadCache.set(String(roomKey || ''), { type: 'nodes', nodes: obj })
}

function scheduleSave(roomKey, ydoc) {
  if (isDeletedRoom(roomKey)) return
  const prev = saveTimers.get(roomKey)
  if (prev) clearTimeout(prev)
  setSaveState(roomKey, 'saving')
  saveTimers.set(
    roomKey,
    setTimeout(() => {
      saveTimers.delete(roomKey)
      queueSave(roomKey, ydoc).catch(err => {
        console.error('[persist] save failed', roomKey, err.message)
      })
    }, saveDelay(ydoc))
  )
}

async function loadPersistedPayload(roomKey) {
  const res = await pool.query(
    'select nodes, version from rooms where room_key = $1',
    [roomKey]
  )
  const json = nodesFromJson(res.rows[0] && res.rows[0].nodes)
  const version = Number((res.rows[0] && res.rows[0].version) || 0)
  const fromTable = await nodesFromTableIfCurrent(roomKey, json, version)
  if (fromTable) return { type: 'nodes', nodes: fromTable }
  if (json) {
    if (nodesDualWriteEnabled()) {
      writeRoomNodeRows(pool, roomKey, json, version).catch(err => {
        console.error('[room_nodes] backfill failed', roomKey, err.message)
      })
    }
    return { type: 'nodes', nodes: json }
  }
  const buf = await getYjsBuffer(roomKey)
  if (buf && buf.length) return { type: 'yjs', buf }
  return { type: 'empty' }
}

async function preloadRoom(roomKey) {
  if (isDeletedRoom(roomKey)) {
    throw new Error('room deleted')
  }
  if (preloadCache.has(roomKey)) return preloadCache.get(roomKey)
  const task = loadPersistedPayload(roomKey)
    .then(payload => {
      const current = preloadCache.get(roomKey)
      // A concurrent commit may have written fresher nodes via rememberRoomNodes
      // while this query was in flight — never clobber that cache entry.
      if (current !== task && current && typeof current.then !== 'function') {
        return current
      }
      preloadCache.set(roomKey, payload)
      return payload
    })
    .catch(err => {
      if (preloadCache.get(roomKey) === task) preloadCache.delete(roomKey)
      throw err
    })
  preloadCache.set(roomKey, task)
  return task
}

async function ensureDoc(roomKey) {
  const key = String(roomKey || '')
  cancelIdleEvict(key)
  const payload = await preloadRoom(key)
  const fresh = preloadCache.get(key)
  const usePayload =
    fresh && typeof fresh.then !== 'function' ? fresh : payload
  const ydoc = getYDoc(key)
  if (ydoc.getMap().size === 0) applyPayload(ydoc, usePayload)
  return ydoc
}

function shareUrl(roomKey) {
  const host = process.env.PUBLIC_HOST || '127.0.0.1'
  const webPort = Number(process.env.WEB_PORT || 8081)
  const gateway = process.env.GATEWAY === '1' || process.env.GATEWAY === 'true'
  const portPart =
    gateway && (webPort === 80 || webPort === 443) ? '' : `:${webPort}`
  return `http://${host}${portPart}/#/?room=${encodeURIComponent(roomKey)}`
}

async function getRoom(roomKey) {
  const res = await pool.query(
    `select room_key, title, cos_key, version, created_at, updated_at
     from rooms
     where room_key = $1`,
    [roomKey]
  )
  return res.rows[0] || null
}

async function nodesFromTableIfCurrent(roomKey, json, version) {
  try {
    const table = await readRoomNodes(pool, roomKey)
    const picked = pickAuthoritativeNodes(json, table, version)
    if (picked.source === 'table') return picked.nodes
    if (
      nodesReadPreferEnabled() &&
      table.nodes &&
      table.count &&
      Number(table.version || 0) >= Number(version || 0) &&
      graphsEqual(table.nodes, json || {})
    ) {
      return table.nodes
    }
    return null
  } catch (err) {
    console.error('[room_nodes] read failed', roomKey, err.message)
    return null
  }
}

async function auditRoomNodes(roomKey) {
  const res = await pool.query(
    `select room_key, title, nodes, version, updated_at
     from rooms where room_key = $1`,
    [roomKey]
  )
  const row = res.rows[0]
  if (!row) return null
  const json = nodesFromJson(row.nodes) || {}
  const version = Number(row.version || 0)
  const table = await readRoomNodes(pool, roomKey)
  return {
    mapId: roomKey,
    title: row.title,
    ...auditRoomNodesState(json, table, version)
  }
}

async function repairRoomNodes(roomKey) {
  const before = await auditRoomNodes(roomKey)
  if (!before) return null
  if (before.ok) {
    return {
      repaired: false,
      ok: true,
      reason: 'already_consistent',
      report: before
    }
  }
  const snapshot = await getRoomSnapshot(roomKey)
  if (!snapshot) return null
  const table = await readRoomNodes(pool, roomKey)
  const picked = pickAuthoritativeNodes(snapshot.nodes || {}, table, snapshot.version)
  const check = validateNodeGraph(picked.nodes || {})
  if (!check.ok) {
    return {
      repaired: false,
      ok: false,
      errors: check.errors,
      report: before
    }
  }
  await pool.query(
    `update rooms set nodes = $2::jsonb, updated_at = now() where room_key = $1`,
    [roomKey, JSON.stringify(picked.nodes)]
  )
  await replaceRoomNodes(pool, roomKey, picked.nodes, snapshot.version)
  rememberRoomNodes(roomKey, picked.nodes)
  const liveDoc = getLiveDoc(roomKey)
  if (liveDoc) {
    mindDoc.applyObjectToDoc(liveDoc, picked.nodes, { replace: true })
  }
  const after = await auditRoomNodes(roomKey)
  return {
    repaired: true,
    ok: !!(after && after.ok),
    source: picked.source,
    nodeCount: check.nodeCount,
    report: after
  }
}

async function forceRoomSnapshot(roomKey) {
  const snapshot = await getRoomSnapshot(roomKey)
  if (!snapshot) return null
  await pool.query(
    `insert into room_snapshots (room_key, version, nodes)
     values ($1, $2, $3::jsonb)
     on conflict (room_key, version) do update set nodes = excluded.nodes`,
    [roomKey, snapshot.version, JSON.stringify(snapshot.nodes || {})]
  )
  return {
    room_key: roomKey,
    version: snapshot.version,
    nodeCount: Object.keys(snapshot.nodes || {}).length
  }
}

const OPS_KEEP_BUFFER = Math.max(
  0,
  Number(process.env.COLLAB_OPS_KEEP_AFTER_SNAPSHOT || 200)
)
const OPS_ARCHIVE_MIN = Math.max(
  100,
  Number(process.env.COLLAB_OPS_ARCHIVE_MIN_COUNT || 500)
)

async function getLatestSnapshotVersion(roomKey) {
  const res = await pool.query(
    `select max(version) as version from room_snapshots where room_key = $1`,
    [roomKey]
  )
  if (!res.rows[0] || res.rows[0].version == null) return null
  return Number(res.rows[0].version)
}

async function getMinOperationVersion(roomKey) {
  const res = await pool.query(
    `select min(version) as version from room_operations where room_key = $1`,
    [roomKey]
  )
  if (!res.rows[0] || res.rows[0].version == null) return null
  return Number(res.rows[0].version)
}

async function countArchivableOperations(roomKey, archiveUpTo) {
  const res = await pool.query(
    `select count(*)::int as count from room_operations
     where room_key = $1 and version <= $2`,
    [roomKey, archiveUpTo]
  )
  return res.rows[0] ? Number(res.rows[0].count) : 0
}

async function getRoomArchiveStats(roomKey) {
  const version = await getRoomVersion(roomKey)
  if (version === null) return null
  const snapshotVersion = await getLatestSnapshotVersion(roomKey)
  const minVersion = await getMinOperationVersion(roomKey)
  const archiveUpTo =
    snapshotVersion == null
      ? null
      : Math.max(0, snapshotVersion - OPS_KEEP_BUFFER)
  const archivable =
    archiveUpTo == null ? 0 : await countArchivableOperations(roomKey, archiveUpTo)
  const archivedRes = await pool.query(
    `select count(*)::int as count, coalesce(max(version), 0) as max_version
     from room_operations_archive where room_key = $1`,
    [roomKey]
  )
  const activeRes = await pool.query(
    `select count(*)::int as count from room_operations where room_key = $1`,
    [roomKey]
  )
  return {
    room_key: roomKey,
    currentVersion: version,
    snapshotVersion,
    minActiveVersion: minVersion,
    archiveUpTo,
    archivable,
    activeCount: activeRes.rows[0] ? Number(activeRes.rows[0].count) : 0,
    archivedCount: archivedRes.rows[0] ? Number(archivedRes.rows[0].count) : 0,
    archivedMaxVersion: archivedRes.rows[0]
      ? Number(archivedRes.rows[0].max_version)
      : 0
  }
}

async function archiveRoomOperations(roomKey, options = {}) {
  const dryRun = !!options.dryRun
  const version = await getRoomVersion(roomKey)
  if (version === null) return null
  let snapshotVersion = await getLatestSnapshotVersion(roomKey)
  if (snapshotVersion == null && !dryRun && options.forceSnapshot !== false) {
    await forceRoomSnapshot(roomKey)
    snapshotVersion = await getLatestSnapshotVersion(roomKey)
  }
  if (snapshotVersion == null) {
    return {
      room_key: roomKey,
      archived: 0,
      skipped: true,
      reason: 'no_snapshot'
    }
  }
  const archiveUpTo = Math.max(0, snapshotVersion - OPS_KEEP_BUFFER)
  const archivable = await countArchivableOperations(roomKey, archiveUpTo)
  if (archivable < OPS_ARCHIVE_MIN) {
    return {
      room_key: roomKey,
      archived: 0,
      skipped: true,
      reason: 'below_threshold',
      archivable,
      archiveUpTo,
      snapshotVersion
    }
  }
  if (dryRun) {
    return {
      room_key: roomKey,
      archived: archivable,
      dryRun: true,
      archiveUpTo,
      snapshotVersion
    }
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const inserted = await client.query(
      `insert into room_operations_archive
       (room_key, version, operation_id, actor_id, client_id,
        operation_type, payload, event, inverse_payload, created_at, archived_at)
       select room_key, version, operation_id, actor_id, client_id,
              operation_type, payload, event, inverse_payload, created_at, now()
       from room_operations
       where room_key = $1 and version <= $2
       on conflict (room_key, version) do nothing
       returning version`,
      [roomKey, archiveUpTo]
    )
    await client.query(
      `delete from room_operations
       where room_key = $1 and version <= $2`,
      [roomKey, archiveUpTo]
    )
    await client.query('commit')
    return {
      room_key: roomKey,
      archived: inserted.rowCount,
      archiveUpTo,
      snapshotVersion,
      minVersion: (await getMinOperationVersion(roomKey)) || archiveUpTo + 1
    }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function archiveAllRoomOperations(options = {}) {
  const rooms = await listRooms()
  const results = []
  for (const room of rooms) {
    try {
      results.push(await archiveRoomOperations(room.room_key, options))
    } catch (err) {
      results.push({
        room_key: room.room_key,
        error: err.message
      })
    }
  }
  return results
}

function startOperationsArchiver() {
  const intervalMs = Math.max(
    60000,
    Number(process.env.COLLAB_ARCHIVE_INTERVAL_MS || 3600000)
  )
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const results = await archiveAllRoomOperations()
      const archived = results.filter(item => item && item.archived > 0)
      if (archived.length) {
        console.log(`[archive] compressed logs for ${archived.length} room(s)`)
      }
      const purged = await purgeDeletedNodes(pool)
      if (purged.purged > 0) {
        console.log(
          `[tombstone] purged ${purged.purged} soft-deleted node(s) older than ${purged.days}d`
        )
      }
    } catch (err) {
      console.error('[archive] tick failed:', err.message)
    } finally {
      running = false
    }
  }
  setTimeout(tick, 30000)
  return setInterval(tick, intervalMs)
}

async function getRoomSnapshot(roomKey) {
  const res = await pool.query(
    `select room_key, title, nodes, version, updated_at
     from rooms
     where room_key = $1`,
    [roomKey]
  )
  const row = res.rows[0]
  if (!row) return null
  const json = nodesFromJson(row.nodes)
  const version = Number(row.version || 0)
  const fromTable = await nodesFromTableIfCurrent(roomKey, json, version)
  if (!fromTable && json && nodesDualWriteEnabled()) {
    writeRoomNodeRows(pool, roomKey, json, version).catch(err => {
      console.error('[room_nodes] backfill failed', roomKey, err.message)
    })
  }
  return {
    room_key: row.room_key,
    title: row.title,
    version,
    updated_at: row.updated_at,
    nodes: fromTable || json
  }
}

function attachPersistence() {
  setPersistence({
    bindState: (docName, ydoc) => {
      const roomKey = decodeURIComponent(docName)
      if (isPresenceDocName(roomKey)) return
      const cached = preloadCache.get(roomKey)
      const payload =
        cached && typeof cached.then !== 'function' ? cached : null
      const obj = applyPayload(ydoc, payload)
      preloadCache.delete(roomKey)
      ydoc.on('update', () => scheduleSave(roomKey, ydoc))
      if (payload && payload.type === 'yjs' && obj) {
        getRoom(roomKey)
          .then(row => {
            if (!shouldWriteLiveNodesToPg(Number((row && row.version) || 0))) {
              return null
            }
            return upsertRoom(roomKey, titleFromObj(obj), {
              preserveExistingTitle: true,
              nodes: obj
            })
          })
          .catch(err => {
            console.error('[persist] pg snapshot failed', roomKey, err.message)
          })
      }
    },
    writeState: async (docName, ydoc) => {
      const roomKey = decodeURIComponent(docName)
      if (isPresenceDocName(roomKey)) return
      const timer = saveTimers.get(roomKey)
      if (timer) {
        clearTimeout(timer)
        saveTimers.delete(roomKey)
      }
      await queueSave(roomKey, ydoc)
    }
  })
}

async function initSchema() {
  let lastErr = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await initSchemaOnce()
      return
    } catch (err) {
      lastErr = err
      if (err.code !== '23505' && err.code !== '42P07') throw err
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function initSchemaOnce() {
  await pool.query(`
    create table if not exists rooms (
      room_key text primary key,
      title text not null default '未命名',
      cos_key text not null,
      nodes jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
  await pool.query(`
    alter table rooms add column if not exists nodes jsonb
  `)
  await pool.query(`
    alter table rooms add column if not exists version bigint not null default 0
  `)
  await pool.query(`
    create table if not exists room_operations (
      room_key text not null,
      version bigint not null,
      operation_id uuid not null,
      actor_id text not null,
      client_id text,
      operation_type text not null,
      payload jsonb not null default '{}'::jsonb,
      event jsonb not null default '{}'::jsonb,
      inverse_payload jsonb,
      created_at timestamptz not null default now(),
      primary key (room_key, version),
      unique (room_key, operation_id)
    )
  `)
  await pool.query(`
    create index if not exists room_operations_lookup_idx
    on room_operations(room_key, version)
  `)
  await pool.query(`
    create table if not exists room_nodes (
      room_key text not null references rooms(room_key) on delete cascade,
      uid text not null,
      parent_uid text,
      position text not null default '00000000',
      data jsonb not null default '{}'::jsonb,
      is_root boolean not null default false,
      node_version bigint not null default 0,
      deleted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (room_key, uid)
    )
  `)
  await pool.query(`
    create index if not exists room_nodes_parent_position_idx
    on room_nodes(room_key, parent_uid, position)
    where deleted_at is null
  `)
  await pool.query(`
    create unique index if not exists room_nodes_one_root_idx
    on room_nodes(room_key)
    where is_root and deleted_at is null
  `)
  await pool.query(`
    create table if not exists room_tombstones (
      room_key text primary key,
      deleted_at timestamptz not null default now()
    )
  `)
  await pool.query(`
    create sequence if not exists room_outbox_id_seq
  `)
  await pool.query(`
    create table if not exists room_outbox (
      id bigint primary key default nextval('room_outbox_id_seq'),
      room_key text not null,
      version bigint not null,
      event jsonb not null,
      created_at timestamptz not null default now(),
      published_at timestamptz,
      attempts integer not null default 0,
      last_error text,
      available_at timestamptz not null default now(),
      unique (room_key, version)
    )
  `)
  await pool.query(`
    create index if not exists room_outbox_pending_idx
    on room_outbox (available_at, id)
    where published_at is null
  `)
  await pool.query(`
    create table if not exists room_snapshots (
      room_key text not null,
      version bigint not null,
      nodes jsonb not null,
      created_at timestamptz not null default now(),
      primary key (room_key, version)
    )
  `)
  await pool.query(`
    create table if not exists room_operations_archive (
      room_key text not null,
      version bigint not null,
      operation_id uuid not null,
      actor_id text not null,
      client_id text,
      operation_type text not null,
      payload jsonb not null default '{}'::jsonb,
      event jsonb not null default '{}'::jsonb,
      inverse_payload jsonb,
      created_at timestamptz not null,
      archived_at timestamptz not null default now(),
      primary key (room_key, version)
    )
  `)
  await pool.query(`
    create index if not exists room_operations_archive_lookup_idx
    on room_operations_archive(room_key, version)
  `)
  const tombstones = await pool.query('select room_key from room_tombstones')
  tombstones.rows.forEach(row => deletedRooms.add(row.room_key))
}

async function listRooms() {
  const res = await pool.query(
    `select r.room_key, r.title, r.cos_key, r.version, r.created_at, r.updated_at
     from rooms r
     left join room_tombstones t on t.room_key = r.room_key
     where t.room_key is null
     order by r.updated_at desc`
  )
  return res.rows.filter(row => !deletedRooms.has(row.room_key))
}

async function renameRoom(roomKey, title) {
  const name = normalizeTitle(title)
  const res = await pool.query(
    `update rooms set title = $2, updated_at = now()
     where room_key = $1
     returning room_key, title, cos_key, version, created_at, updated_at`,
    [roomKey, name]
  )
  return res.rows[0] || null
}

function operationRow(row) {
  if (!row) return null
  return {
    room_key: row.room_key,
    version: Number(row.version || 0),
    operation_id: row.operation_id,
    actor_id: row.actor_id,
    client_id: row.client_id || '',
    operation_type: row.operation_type,
    payload: row.payload || {},
    event: row.event || {},
    inverse_payload: row.inverse_payload || null,
    created_at: row.created_at
  }
}

async function commitRoomOperation(roomKey, command, apply) {
  return withPgRetry(async () => {
    const client = await pool.connect()
    try {
      return await commitRoomOperationOnce(client, roomKey, command, apply)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}

async function commitRoomOperationOnce(client, roomKey, command, apply) {
  await client.query('begin')
  const roomResult = await client.query(
    `select room_key, title, nodes, version, updated_at
     from rooms where room_key = $1 for update`,
    [roomKey]
  )
  const room = roomResult.rows[0]
  if (!room) {
    const err = new Error('not found')
    err.statusCode = 404
    throw err
  }
  const existing = await client.query(
    `select room_key, version, operation_id, actor_id, client_id,
            operation_type, payload, event, inverse_payload, created_at
     from room_operations
     where room_key = $1 and operation_id = $2`,
    [roomKey, command.operationId]
  )
  if (existing.rows[0]) {
    await client.query('commit')
    return { duplicate: true, operation: operationRow(existing.rows[0]) }
  }
  const currentVersion = Number(room.version || 0)
  if (
    command.baseVersion !== null &&
    command.baseVersion !== undefined &&
    Number(command.baseVersion) > currentVersion
  ) {
    const err = new Error('baseVersion不能大于房间当前版本')
    err.statusCode = 409
    err.code = 'VERSION_AHEAD'
    throw err
  }
  const json = nodesFromJson(room.nodes) || {}
  const table = await readRoomNodes(client, roomKey)
  const picked = pickAuthoritativeNodes(json, table, currentVersion)
  const deletedUids = await listDeletedNodeUids(client, roomKey)
  const allowRestore =
    command.type === 'node.restore' ||
    command.type === 'operation.undo' ||
    command.type === 'operation.redo'
  const applied = await apply({
    room: { ...room, nodes: picked.nodes },
    currentVersion,
    deletedUids,
    allowUidReuse: allowRestore
  })
  const version = currentVersion + 1
  const event = {
    ...(applied.event || {}),
    mapId: roomKey,
    version,
    operationId: command.operationId,
    actorId: command.actorId
  }
  const snapshot = snapshotNodesForStorage(applied.nodes || {})
  await writeRoomNodeRows(client, roomKey, snapshot, version, {
    allowRestore
  })
  await client.query(
    `update rooms
     set nodes = $2::jsonb,
         version = $3,
         title = coalesce($4, title),
         updated_at = now()
     where room_key = $1`,
    [
      roomKey,
      JSON.stringify(snapshot),
      version,
      applied.title ? String(applied.title).trim().slice(0, 80) : null
    ]
  )
  const inserted = await client.query(
    `insert into room_operations
     (room_key, version, operation_id, actor_id, client_id,
      operation_type, payload, event, inverse_payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     returning room_key, version, operation_id, actor_id, client_id,
               operation_type, payload, event, inverse_payload, created_at`,
    [
      roomKey,
      version,
      command.operationId,
      command.actorId,
      command.clientId || null,
      command.type,
      JSON.stringify(command.payload || {}),
      JSON.stringify(event),
      applied.inversePayload == null
        ? null
        : JSON.stringify(applied.inversePayload)
    ]
  )
  await client.query(
    `insert into room_outbox (room_key, version, event)
     values ($1, $2, $3::jsonb)
     on conflict (room_key, version) do nothing`,
    [roomKey, version, JSON.stringify(event)]
  )
  const snapshotEvery = Math.max(
    1,
    Number(process.env.COLLAB_SNAPSHOT_EVERY || 100)
  )
  if (version === 1 || version % snapshotEvery === 0) {
    await client.query(
      `insert into room_snapshots (room_key, version, nodes)
       values ($1, $2, $3::jsonb)
       on conflict (room_key, version) do nothing`,
      [roomKey, version, JSON.stringify(snapshot)]
    )
  }
  await client.query('select pg_notify($1, $2)', [
    'collab_events',
    JSON.stringify({
      type: 'event',
      mapId: roomKey,
      version,
      operationId: command.operationId
    }).slice(0, 7900)
  ])
  // Test-only: abort before COMMIT so PG rolls back ops + outbox + notify.
  if (process.env.COLLAB_FAULT_INJECT === 'before_commit_once') {
    process.env.COLLAB_FAULT_INJECT = ''
    const err = new Error('injected fault before commit')
    err.statusCode = 500
    err.code = 'FAULT_INJECTED'
    throw err
  }
  await client.query('commit')
  const operation = operationRow(inserted.rows[0])
  setImmediate(() => {
    operationEvents.emit('committed', {
      roomKey,
      version,
      operation
    })
  })
  return {
    duplicate: false,
    operation,
    result: applied.result || {},
    nodes: snapshot
  }
}

async function getRoomVersion(roomKey) {
  const res = await pool.query(
    'select version from rooms where room_key = $1',
    [roomKey]
  )
  return res.rows[0] ? Number(res.rows[0].version || 0) : null
}

async function getRoomOperation(roomKey, operationId) {
  const res = await pool.query(
    `select room_key, version, operation_id, actor_id, client_id,
            operation_type, payload, event, inverse_payload, created_at
     from room_operations
     where room_key = $1 and operation_id = $2`,
    [roomKey, operationId]
  )
  return operationRow(res.rows[0])
}

async function listRoomOperations(roomKey, afterVersion = 0, limit = 500, options = {}) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500))
  const after = Math.max(0, Number(afterVersion) || 0)
  const params = [roomKey, after, safeLimit]
  let sql = `select room_key, version, operation_id, actor_id, client_id,
                    operation_type, payload, event, inverse_payload, created_at
             from room_operations
             where room_key = $1 and version > $2`
  if (options.actorId) {
    params.push(String(options.actorId))
    sql += ` and actor_id = $${params.length}`
  }
  if (options.untilVersion != null && Number.isFinite(Number(options.untilVersion))) {
    params.push(Number(options.untilVersion))
    sql += ` and version <= $${params.length}`
  }
  sql += ` order by version asc limit $3`
  const res = await pool.query(sql, params)
  return res.rows.map(operationRow)
}

async function getNearestSnapshot(roomKey, version) {
  const res = await pool.query(
    `select room_key, version, nodes, created_at
     from room_snapshots
     where room_key = $1 and version <= $2
     order by version desc
     limit 1`,
    [roomKey, Number(version)]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    room_key: row.room_key,
    version: Number(row.version || 0),
    nodes: row.nodes || {},
    created_at: row.created_at
  }
}

async function removeRoom(roomKey) {
  deletedRooms.add(roomKey)
  setSaveState(roomKey, 'deleted')
  await pool.query(
    `insert into room_tombstones (room_key, deleted_at)
     values ($1, now())
     on conflict (room_key) do update set deleted_at = now()`,
    [roomKey]
  )
  const timer = saveTimers.get(roomKey)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(roomKey)
  }
  pendingSaves.delete(roomKey)
  cancelIdleEvict(roomKey)
  const doc = docs.get(roomKey)
  if (doc) {
    const connections = Array.from(doc.conns ? doc.conns.keys() : [])
    if (doc.conns) doc.conns.clear()
    connections.forEach(conn => {
      try {
        conn.close(1008, 'room deleted')
      } catch (e) {
        // ignore
      }
    })
    docs.delete(roomKey)
    try {
      doc.destroy()
    } catch (e) {
      // ignore
    }
  }
  await purgeRoomStorage(roomKey)
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes)
  const limit =
    Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : Number(process.env.COLLAB_MAX_BODY_BYTES || 2 * 1024 * 1024)
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        const err = new Error(`请求体过大（最多 ${limit} 字节）`)
        err.statusCode = 413
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        try {
          req.destroy()
        } catch (e) {
          // ignore
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req, res) {
  const {
    applyCorsHeaders,
    isAllowedOrigin
  } = require('./auth')
  applyCorsHeaders(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(isAllowedOrigin(req) ? 204 : 403)
    res.end()
    return true
  }
  const mindApi = require('./mindApi')
  return mindApi.handleApi(req, res)
}

module.exports = {
  initSchema,
  attachPersistence,
  preloadRoom,
  ensureDoc,
  handleApi,
  safeRoomKey,
  listRooms,
  getRoom,
  getRoomSnapshot,
  renameRoom,
  removeRoom,
  saveDoc,
  upsertRoom,
  sendJson,
  readBody,
  shareUrl,
  getSaveStatus,
  isDeletedRoom,
  reviveRoom,
  queueSave,
  scheduleIdleEvict,
  cancelIdleEvict,
  scheduleSave,
  persistHotSnapshot,
  getLiveDoc,
  getMemoryDoc,
  getLiveObject,
  invalidateRoomCache,
  rememberRoomNodes,
  shouldWriteLiveNodesToPg,
  isPresenceDocName,
  applyPayload,
  payloadToObject,
  pickLatestTimestamp,
  commitRoomOperation,
  isTransientPgError,
  withPgRetry,
  getRoomVersion,
  listRoomOperations,
  getRoomOperation,
  getNearestSnapshot,
  auditRoomNodes,
  repairRoomNodes,
  forceRoomSnapshot,
  getMinOperationVersion,
  getRoomArchiveStats,
  archiveRoomOperations,
  archiveAllRoomOperations,
  startOperationsArchiver,
  purgeDeletedNodes: options => purgeDeletedNodes(pool, options),
  listDeletedNodeUids: roomKey => listDeletedNodeUids(pool, roomKey),
  getPool,
  operationEvents,
  readRoomNodes: roomKey => readRoomNodes(pool, roomKey),
  replaceRoomNodes: (roomKey, nodes, version) =>
    replaceRoomNodes(pool, roomKey, nodes, version)
}
