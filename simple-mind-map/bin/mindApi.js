const crypto = require('crypto')
const Y = require('yjs')
const mindDoc = require('./mindDoc')
const { applyNodeCommand, dataFields } = require('./roomCommands')
const {
  listRooms,
  getRoom,
  getRoomSnapshot,
  removeRoom,
  ensureDoc,
  saveDoc,
  upsertRoom,
  persistHotSnapshot,
  getLiveDoc,
  getMemoryDoc,
  getLiveObject,
  rememberRoomNodes,
  sendJson,
  readBody,
  safeRoomKey,
  shareUrl,
  getSaveStatus,
  isDeletedRoom,
  reviveRoom,
  scheduleSave,
  pickLatestTimestamp,
  commitRoomOperation,
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
  purgeDeletedNodes
} = require('./storage')
const { beatPresence, listPresence, leavePresence, getPresenceStatus } = require('./presence')
const { applyCollabEvents } = require('./collabRecovery')
const { evaluateUndo, evaluateRedo, reconstructByInverses } = require('./collabUndo')
const {
  assertRateLimit,
  assertBatchSize,
  assertPatchSize,
  bodyLimitForPath,
  getRateLimitStatus
} = require('./rateLimit')
const {
  recordOperation,
  recordRecovery,
  getMetricsSnapshot,
  logCollab
} = require('./collabMetrics')

const roomMutationQueues = new Map()
const pausedRooms = new Map()

function isRoomWritePaused(roomKey) {
  const until = pausedRooms.get(String(roomKey || ''))
  if (!until) return false
  if (until === true) return true
  if (Number(until) > Date.now()) return true
  pausedRooms.delete(String(roomKey || ''))
  return false
}

function setRoomWritePaused(roomKey, paused, ttlMs) {
  const key = String(roomKey || '')
  if (!paused) {
    pausedRooms.delete(key)
    return { room_key: key, paused: false }
  }
  if (ttlMs && Number(ttlMs) > 0) {
    pausedRooms.set(key, Date.now() + Number(ttlMs))
  } else {
    pausedRooms.set(key, true)
  }
  return {
    room_key: key,
    paused: true,
    until: pausedRooms.get(key) === true ? null : pausedRooms.get(key)
  }
}

function assertRoomWritable(roomKey) {
  if (!isRoomWritePaused(roomKey)) return
  const err = new Error('该房间已暂停写入')
  err.statusCode = 423
  err.code = 'ROOM_WRITE_PAUSED'
  throw err
}

async function withRoomMutation(roomKey, mutation) {
  const previous = roomMutationQueues.get(roomKey) || Promise.resolve()
  const current = previous.catch(() => {}).then(mutation)
  roomMutationQueues.set(roomKey, current)
  try {
    return await current
  } finally {
    if (roomMutationQueues.get(roomKey) === current) {
      roomMutationQueues.delete(roomKey)
    }
  }
}

function nodesFromSnapshotOrLive(snapshot, live) {
  if (snapshot && snapshot.nodes && Object.keys(snapshot.nodes).length) {
    return snapshot.nodes
  }
  if (live && Object.keys(live).length) return live
  return null
}

function requestActor(req, body = {}) {
  return String(
    (req.authUser && req.authUser.id) || body.actorId || body.actor_id || 'anonymous'
  ).slice(0, 160)
}

function normalizeOperationId(req, body = {}) {
  const value = String(
    body.operationId ||
      body.operation_id ||
      req.headers['x-operation-id'] ||
      crypto.randomUUID()
  ).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const err = new Error('operationId必须是UUID')
    err.statusCode = 400
    throw err
  }
  return value
}

function normalizeCommand(req, roomKey, body, fallbackType, fallbackPayload) {
  const base = body || {}
  const baseVersionRaw = base.baseVersion ?? base.base_version
  return {
    operationId: normalizeOperationId(req, base),
    mapId: roomKey,
    actorId: requestActor(req, base),
    clientId: String(base.clientId || base.client_id || '').slice(0, 160),
    baseVersion:
      baseVersionRaw === undefined || baseVersionRaw === null
        ? null
        : Number(baseVersionRaw),
    type: String(base.type || fallbackType || ''),
    payload: base.payload || fallbackPayload || {}
  }
}

async function applyCommittedLive(roomKey, command, committed) {
  const nodes =
    committed.nodes ||
    ((await getRoomSnapshot(roomKey)) || {}).nodes ||
    null
  if (nodes) rememberRoomNodes(roomKey, nodes)
  if (committed.duplicate) return committed
  if (command.type === 'map.update') return committed
  // Prefer the in-memory doc even when still empty (warmup race): otherwise the
  // first HTTP mutation can land in PG while ensureDoc later hydrates a stale
  // snapshot into live Y.Doc, and GET /nodes would keep serving old content.
  const liveDoc = getMemoryDoc(roomKey)
  if (liveDoc) {
    const replace =
      command.type === 'batch.apply' ||
      command.type === 'map.replace' ||
      !liveDoc.getMap().size
    try {
      if (replace) {
        mindDoc.applyObjectToDoc(liveDoc, nodes || {}, { replace: true })
      } else {
        applyNodeCommand(liveDoc, command, {
          version: Number(
            (committed.operation && committed.operation.version) || 0
          ),
          allowUidReuse:
            command.type === 'node.restore' ||
            command.type === 'operation.undo' ||
            command.type === 'operation.redo'
        })
      }
    } catch (err) {
      mindDoc.applyObjectToDoc(liveDoc, nodes || {}, { replace: true })
    }
    scheduleSave(roomKey, liveDoc)
  }
  return committed
}

async function executeOperation(req, roomKey, command) {
  assertRoomWritable(roomKey)
  assertRateLimit(roomKey)
  if (command.type === 'node.update' || command.type === 'node.move') {
    assertPatchSize(
      (command.payload && (command.payload.patch || command.payload.data)) ||
        command.payload
    )
  }
  const started = Date.now()
  try {
    const committed = await withRoomMutation(roomKey, async () => {
      return commitRoomOperation(
        roomKey,
        command,
        async ({ room, currentVersion, deletedUids, allowUidReuse }) => {
          const base =
            room.nodes && Object.keys(room.nodes).length
              ? room.nodes
              : getLiveObject(roomKey) || {}
          const tempDoc = new Y.Doc()
          try {
            mindDoc.applyObjectToDoc(tempDoc, base, { replace: true })
            const applied = applyNodeCommand(tempDoc, command, {
              version: currentVersion + 1,
              deletedUids: deletedUids || new Set(),
              allowUidReuse: !!allowUidReuse
            })
            return { ...applied, nodes: mindDoc.readObject(tempDoc) }
          } finally {
            tempDoc.destroy()
          }
        }
      )
    })
    const live = await applyCommittedLive(roomKey, command, committed)
    const version = Number(
      (live.operation && live.operation.version) ||
        (committed.operation && committed.operation.version) ||
        0
    )
    const durationMs = Date.now() - started
    recordOperation({
      mapId: roomKey,
      version,
      ok: true,
      duplicate: !!committed.duplicate,
      durationMs
    })
    logCollab('operation.commit', {
      mapId: roomKey,
      operationId: command.operationId,
      version,
      actorId: command.actorId,
      durationMs,
      duplicate: !!committed.duplicate,
      code: command.type
    })
    return live
  } catch (err) {
    const durationMs = Date.now() - started
    recordOperation({
      mapId: roomKey,
      ok: false,
      durationMs,
      code: err.code || 'OPERATION_REJECTED'
    })
    logCollab('operation.reject', {
      mapId: roomKey,
      operationId: command.operationId,
      actorId: command.actorId,
      durationMs,
      code: err.code || 'OPERATION_REJECTED',
      message: err.message,
      level: 'warn'
    })
    throw err
  }
}

async function executeUndo(req, roomKey, operationId, body = {}) {
  const actorId = requestActor(req, body)
  const target = await getRoomOperation(roomKey, operationId)
  if (!target) {
    const err = new Error('operation not found')
    err.statusCode = 404
    err.code = 'NOT_FOUND'
    throw err
  }
  const later = await listRoomOperations(roomKey, target.version, 1000)
  const verdict = evaluateUndo(target, later, actorId)
  if (!verdict.ok) {
    const err = new Error(verdict.error)
    err.statusCode = verdict.code === 'NOT_FOUND' ? 404 : 409
    err.code = verdict.code
    err.details = {
      overlappingUids: verdict.overlappingUids || [],
      blockingVersion: verdict.blockingVersion || null,
      blockingActorId: verdict.blockingActorId || null
    }
    throw err
  }
  const command = normalizeCommand(
    req,
    roomKey,
    {
      ...body,
      type: 'operation.undo',
      payload: {
        targetOperationId: target.operation_id,
        targetVersion: target.version,
        inverse: verdict.inverse,
        forward: {
          type: target.operation_type,
          payload: target.payload || {}
        },
        confirm_sop_change: true
      }
    },
    'operation.undo'
  )
  command.actorId = actorId
  return executeOperation(req, roomKey, command)
}

async function executeRedo(req, roomKey, operationId, body = {}) {
  const actorId = requestActor(req, body)
  const target = await getRoomOperation(roomKey, operationId)
  if (!target) {
    const err = new Error('operation not found')
    err.statusCode = 404
    err.code = 'NOT_FOUND'
    throw err
  }
  const later = await listRoomOperations(roomKey, target.version, 1000)
  const verdict = evaluateRedo(target, later, actorId)
  if (!verdict.ok) {
    const err = new Error(verdict.error)
    err.statusCode = verdict.code === 'NOT_FOUND' ? 404 : 409
    err.code = verdict.code
    err.details = {
      overlappingUids: verdict.overlappingUids || [],
      blockingVersion: verdict.blockingVersion || null,
      blockingActorId: verdict.blockingActorId || null
    }
    throw err
  }
  const command = normalizeCommand(
    req,
    roomKey,
    {
      ...body,
      type: 'operation.redo',
      payload: {
        targetOperationId: target.operation_id,
        undoOperationId: verdict.undoOperationId,
        undoVersion: verdict.undoVersion,
        forward: verdict.forward,
        confirm_sop_change: true
      }
    },
    'operation.redo'
  )
  command.actorId = actorId
  return executeOperation(req, roomKey, command)
}

async function loadNodesAtVersion(roomKey, version) {
  const currentVersion = await getRoomVersion(roomKey)
  if (currentVersion === null) return null
  const ver = Number(version)
  if (!Number.isFinite(ver) || ver < 0 || ver > currentVersion) {
    const err = new Error('version out of range')
    err.statusCode = 400
    err.code = 'VERSION_RANGE'
    throw err
  }
  const loaded = await loadSnapshot(roomKey)
  if (!loaded) return null
  if (ver === currentVersion) {
    return { obj: loaded.obj, row: loaded.row, version: ver }
  }
  const checkpoint = await getNearestSnapshot(roomKey, ver)
  if (checkpoint) {
    const ops = await listRoomOperations(roomKey, checkpoint.version, 1000, {
      untilVersion: ver
    })
    const applied = applyCollabEvents(checkpoint.nodes, ops)
    if (applied.type === 'resnapshot') {
      const err = new Error('该区间包含需要重快照的操作，无法精确重建')
      err.statusCode = 409
      err.code = 'SNAPSHOT_UNAVAILABLE'
      throw err
    }
    return {
      obj: applied.nodes,
      row: { ...loaded.row, version: ver },
      version: ver
    }
  }
  const later = await listRoomOperations(roomKey, ver, 5000)
  const nodes = reconstructByInverses(loaded.obj, later)
  return {
    obj: nodes,
    row: { ...loaded.row, version: ver },
    version: ver
  }
}

async function executeSnapshotOperation(
  req,
  roomKey,
  command,
  nextNodes,
  extra = {}
) {
  assertRoomWritable(roomKey)
  assertRateLimit(roomKey)
  const committed = await commitRoomOperation(roomKey, command, async ({ room }) => {
    return {
      nodes: extra.keepNodes ? room.nodes : nextNodes,
      result: extra.result || {},
      title: extra.title || null,
      event: {
        type: extra.eventType || 'batch.applied',
        payload: {
          source: extra.source || command.type,
          nodeCount: Object.keys(nextNodes || {}).length,
          ...(extra.eventPayload || {}),
          resnapshot: extra.resnapshot !== false
        },
        affectedUids: extra.affectedUids || []
      },
      inversePayload: extra.inversePayload || { type: 'resnapshot' }
    }
  })
  return applyCommittedLive(roomKey, command, committed)
}

function operationResponse(roomKey, committed) {
  const operation = committed.operation
  const payload = (operation.event && operation.event.payload) || {}
  return {
    ok: true,
    duplicate: !!committed.duplicate,
    room_key: roomKey,
    mapId: roomKey,
    version: operation.version,
    operationId: operation.operation_id,
    event: operation.event,
    uid: (committed.result && committed.result.uid) || payload.uid || '',
    parent_uid:
      (committed.result && committed.result.parent_uid) || payload.parentUid || '',
    position: (committed.result && committed.result.position) || payload.position || '',
    index:
      committed.result && committed.result.index != null
        ? committed.result.index
        : payload.index,
    removed: (committed.result && committed.result.removed) || payload.removed || []
  }
}

async function nodeMutationResponse(roomKey, committed) {
  const op = operationResponse(roomKey, committed)
  const row = await getRoom(roomKey)
  return {
    ...op,
    title: (row && row.title) || '未命名',
    share_url: shareUrl(roomKey),
    updated_at: row && row.updated_at
  }
}

function normalizeTree(input, title) {
  if (!input) return mindDoc.createEmptyTree(title)
  if (input.data) return input
  if (input.root && input.root.data) return input.root
  return mindDoc.createEmptyTree(title)
}

function createRoomKey() {
  return 'room-' + Math.random().toString(36).slice(2, 10)
}

function withShare(row) {
  if (!row) return row
  return {
    ...row,
    share_url: shareUrl(row.room_key)
  }
}

async function loadMap(roomKey) {
  if (isDeletedRoom(roomKey)) return null
  const ydoc = await ensureDoc(roomKey)
  const obj = mindDoc.readObject(ydoc)
  const row = await getRoom(roomKey)
  if (!row && !Object.keys(obj).length) return null
  return { ydoc, obj, row }
}

async function loadSnapshot(roomKey) {
  if (isDeletedRoom(roomKey)) return null
  const snapshot = await getRoomSnapshot(roomKey)
  const live = getLiveObject(roomKey)
  const obj = nodesFromSnapshotOrLive(snapshot, live)
  if (obj) return { obj, row: snapshot }
  return loadMap(roomKey)
}

function mapTitle(obj, row) {
  if (row && row.title) return row.title
  const rootUid = mindDoc.findRootUid(obj)
  const root = rootUid && obj[rootUid]
  return mindDoc.stripHtml(root && root.data && root.data.text) || '未命名'
}

function mapMeta(roomKey, obj, row) {
  return {
    room_key: roomKey,
    version: Number((row && row.version) || 0),
    title: mapTitle(obj, row),
    share_url: shareUrl(roomKey),
    updated_at: row && row.updated_at
  }
}

function sendVersionedSubtree(res, roomKey, loaded, uid, url) {
  const deep =
    url.searchParams.get('deep') === '1' ||
    url.searchParams.get('deep') === 'true'
  const payload = mindDoc.versionedSubtree(loaded.obj, uid, {
    version: Number((loaded.row && loaded.row.version) || 0),
    knownVersion:
      Number(
        url.searchParams.get('knownVersion') ||
          url.searchParams.get('known_version') ||
          0
      ) || 0,
    deep,
    maxNodes: url.searchParams.get('max_nodes'),
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit')
  })
  if (!payload || (deep && !payload.unchanged && !payload.tree)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  sendJson(res, 200, {
    room_key: roomKey,
    updated_at: loaded.row && loaded.row.updated_at,
    ...payload
  })
}

function mapPayload(roomKey, obj, row, extra = {}) {
  const { format = 'outline', max_nodes, maxNodes, ...rest } = extra
  const meta = { ...mapMeta(roomKey, obj, row), ...rest }
  if (format === 'meta') return meta
  if (format === 'full') {
    const size = Object.keys(obj).length
    const limit = Math.min(
      10000,
      Math.max(0, Number(max_nodes || maxNodes || 0) || 0)
    )
    if (!limit && size > 1200) {
      return {
        ...meta,
        truncated: true,
        node_count: size,
        hint:
          'Map too large for format=full. Returned outline. Use search_nodes or pass max_nodes.',
        outline: mindDoc.toOutline(obj, { maxNodes: 800 })
      }
    }
    const stats = {}
    const tree = mindDoc.objectToTree(obj, {
      maxNodes: limit || 0,
      stats
    })
    const payload = { ...meta, tree, node_count: stats.node_count || size }
    if (stats.truncated) {
      payload.truncated = true
      payload.hint =
        'Tree truncated. Use search_nodes or raise max_nodes (max 10000).'
    }
    return payload
  }
  if (format === 'nodes') {
    return { ...meta, nodes: mindDoc.flattenNodes(obj) }
  }
  const limit = Math.min(
    10000,
    Math.max(0, Number(max_nodes || maxNodes || 0) || 0)
  )
  return {
    ...meta,
    outline: mindDoc.toOutline(obj, limit ? { maxNodes: limit } : {})
  }
}

async function persist(roomKey, ydoc, obj, title, options = {}) {
  const {
    responseFormat = 'meta',
    persistNow = false,
    ...applyOptions
  } = options
  mindDoc.applyObjectToDoc(ydoc, obj, applyOptions)
  const hasExplicitTitle = title !== undefined && title !== null
  const row = await upsertRoom(roomKey, title || mapTitle(obj, null), {
    // 节点增删改和未指定 title 的 replace 只保存文档；保留已有的导图标题。
    // 只有创建导图、rename_map 或 replace_tree 显式传 title 才更新该标题。
    preserveExistingTitle: !hasExplicitTitle
  })
  if (persistNow) await saveDoc(roomKey, ydoc)
  else scheduleSave(roomKey, ydoc)
  return mapPayload(roomKey, obj, row, {
    format: responseFormat
  })
}

async function persistPatch(roomKey, ydoc, extra = {}) {
  await persistHotSnapshot(roomKey, ydoc)
  const row = await getRoom(roomKey)
  const title = (row && row.title) || extra.title || '未命名'
  return {
    uid: extra.uid || '',
    room_key: roomKey,
    title,
    share_url: shareUrl(roomKey),
    updated_at: row && row.updated_at,
    version: Number((row && row.version) || 0)
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/api/health') {
    let outbox = { pending: 0, failed: 0, oldestAgeMs: 0 }
    try {
      outbox = await require('./outbox').getOutboxStats()
    } catch (err) {
      outbox = { pending: 0, failed: 0, oldestAgeMs: 0, error: err.message }
    }
    const metrics = getMetricsSnapshot()
    const alerts = []
    if (outbox.failed > 0) {
      alerts.push({
        type: 'outbox_failed',
        failed: outbox.failed,
        oldestAgeMs: outbox.oldestAgeMs
      })
    }
    if (outbox.oldestAgeMs > 60000) {
      alerts.push({
        type: 'outbox_backlog',
        pending: outbox.pending,
        oldestAgeMs: outbox.oldestAgeMs
      })
    }
    if (metrics.lastVersionGap) {
      alerts.push({ type: 'version_gap', ...metrics.lastVersionGap })
    }
    sendJson(res, 200, {
      ok: alerts.length === 0,
      service: 'mind-map-collab',
      outbox,
      presence: getPresenceStatus(),
      bus: require('./eventBus').getEventBusStatus(),
      rateLimit: getRateLimitStatus(),
      metrics,
      alerts: alerts.concat(metrics.alerts || []).slice(0, 30)
    })
    return true
  }

  if (pathname === '/api/ops/metrics' && req.method === 'GET') {
    sendJson(res, 200, {
      metrics: getMetricsSnapshot(),
      rateLimit: getRateLimitStatus()
    })
    return true
  }

  if (pathname === '/api/ops/outbox') {
    const outbox = require('./outbox')
    if (req.method === 'GET') {
      const stats = await outbox.getOutboxStats()
      const items = await outbox.listOutbox(undefined, {
        pending: url.searchParams.get('pending') !== '0',
        limit: url.searchParams.get('limit')
      })
      sendJson(res, 200, { ...stats, items })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const result = await outbox.replayOutbox(undefined, {
        id: body.id,
        roomKey: body.room_key || body.roomKey || body.mapId,
        version: body.version
      })
      await outbox.kickOutboxPublisher()
      sendJson(res, 200, result)
      return true
    }
  }

  if (pathname === '/api/ops/archive') {
    if (req.method === 'GET') {
      const rooms = await listRooms()
      const stats = []
      for (const room of rooms) {
        const item = await getRoomArchiveStats(room.room_key)
        if (item) stats.push(item)
      }
      sendJson(res, 200, { rooms: stats })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      const dryRun = body.dry_run === true || body.dryRun === true
      const results = await archiveAllRoomOperations({ dryRun })
      sendJson(res, 200, { dryRun, results })
      return true
    }
  }

  if (pathname === '/api/ops/tombstones/purge' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}))
    const result = await purgeDeletedNodes({
      days: body.days != null ? body.days : undefined
    })
    sendJson(res, 200, result)
    return true
  }

  const opsRoomMatch = pathname.match(/^\/api\/ops\/rooms\/([^/]+)(\/[^/]+)?$/)
  if (opsRoomMatch) {
    const roomKey = safeRoomKey(decodeURIComponent(opsRoomMatch[1]))
    const action = opsRoomMatch[2] || ''
    if (req.method === 'GET' && (action === '/diagnostics' || action === '')) {
      const report = await auditRoomNodes(roomKey)
      if (!report) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const version = await getRoomVersion(roomKey)
      const archive = await getRoomArchiveStats(roomKey)
      sendJson(res, 200, {
        room_key: roomKey,
        version,
        consistency: report,
        presence: getPresenceStatus(),
        archive,
        writePaused: isRoomWritePaused(roomKey)
      })
      return true
    }
    if (req.method === 'POST' && action === '/pause') {
      const body = await readBody(req).catch(() => ({}))
      const paused = body.paused !== false && body.pause !== false
      const result = setRoomWritePaused(
        roomKey,
        paused,
        body.ttlMs || body.ttl_ms || body.ttl
      )
      sendJson(res, 200, result)
      return true
    }
    if (req.method === 'POST' && action === '/repair') {
      const result = await repairRoomNodes(roomKey)
      if (!result) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      sendJson(res, 200, result)
      return true
    }
    if (req.method === 'POST' && action === '/snapshot') {
      const result = await forceRoomSnapshot(roomKey)
      if (!result) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      sendJson(res, 200, result)
      return true
    }
    if (req.method === 'POST' && action === '/archive') {
      const body = await readBody(req).catch(() => ({}))
      const result = await archiveRoomOperations(roomKey, {
        dryRun: body.dry_run === true || body.dryRun === true,
        forceSnapshot: body.force_snapshot !== false && body.forceSnapshot !== false
      })
      if (!result) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      sendJson(res, 200, result)
      return true
    }
  }

  const presenceMatch = pathname.match(/^\/api\/files\/([^/]+)\/presence$/)
  if (presenceMatch) {
    const roomKey = decodeURIComponent(presenceMatch[1])
    if (req.method === 'GET') {
      const list = await listPresence(roomKey)
      sendJson(res, 200, { list })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const list = await beatPresence(roomKey, body)
      sendJson(res, 200, { list })
      return true
    }
    if (req.method === 'DELETE') {
      const body = await readBody(req).catch(() => ({}))
      const list = await leavePresence(
        roomKey,
        body.id || body.userId,
        body.clientId || body.client_id
      )
      sendJson(res, 200, { list })
      return true
    }
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const list = (await listRooms()).map(withShare)
    sendJson(res, 200, { list })
    return true
  }

  const mapVersionMatch = pathname.match(/^\/api\/maps\/([^/]+)\/version$/)
  if (mapVersionMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapVersionMatch[1]))
    const version = await getRoomVersion(roomKey)
    if (version === null) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, { mapId: roomKey, version })
    return true
  }

  const mapConsistencyMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/consistency$/
  )
  if (mapConsistencyMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapConsistencyMatch[1]))
    const report = await auditRoomNodes(roomKey)
    if (!report) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, report)
    return true
  }

  const undoMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/operations\/([^/]+)\/undo$/
  )
  if (undoMatch && req.method === 'POST') {
    const roomKey = safeRoomKey(decodeURIComponent(undoMatch[1]))
    const operationId = decodeURIComponent(undoMatch[2])
    const body = await readBody(req).catch(() => ({}))
    try {
      const committed = await executeUndo(req, roomKey, operationId, body)
      sendJson(res, 201, operationResponse(roomKey, committed))
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'UNDO_REJECTED',
        overlappingUids: (err.details && err.details.overlappingUids) || [],
        blockingVersion: err.details && err.details.blockingVersion,
        blockingActorId: err.details && err.details.blockingActorId
      })
    }
    return true
  }

  const redoMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/operations\/([^/]+)\/redo$/
  )
  if (redoMatch && req.method === 'POST') {
    const roomKey = safeRoomKey(decodeURIComponent(redoMatch[1]))
    const operationId = decodeURIComponent(redoMatch[2])
    const body = await readBody(req).catch(() => ({}))
    try {
      const committed = await executeRedo(req, roomKey, operationId, body)
      sendJson(res, 201, operationResponse(roomKey, committed))
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'REDO_REJECTED',
        overlappingUids: (err.details && err.details.overlappingUids) || [],
        blockingVersion: err.details && err.details.blockingVersion,
        blockingActorId: err.details && err.details.blockingActorId
      })
    }
    return true
  }

  const mapAuditMatch = pathname.match(/^\/api\/maps\/([^/]+)\/audit$/)
  if (mapAuditMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapAuditMatch[1]))
    const currentVersion = await getRoomVersion(roomKey)
    if (currentVersion === null) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const afterVersion = Number(url.searchParams.get('after') || 0) || 0
    const limit = Number(url.searchParams.get('limit') || 100) || 100
    const actorId = url.searchParams.get('actor') || url.searchParams.get('actorId')
    const operations = await listRoomOperations(roomKey, afterVersion, limit, {
      actorId: actorId || undefined
    })
    sendJson(res, 200, {
      mapId: roomKey,
      currentVersion,
      afterVersion,
      items: operations.map(item => ({
        version: item.version,
        operationId: item.operation_id,
        actorId: item.actor_id,
        clientId: item.client_id,
        type: item.operation_type,
        eventType: item.event && item.event.type,
        affectedUids: (item.event && item.event.affectedUids) || [],
        created_at: item.created_at
      }))
    })
    return true
  }

  const mapOperationsMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/operations$/
  )
  if (mapOperationsMatch) {
    const roomKey = safeRoomKey(decodeURIComponent(mapOperationsMatch[1]))
    if (req.method === 'GET') {
      const currentVersion = await getRoomVersion(roomKey)
      if (currentVersion === null) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const afterVersion = Number(url.searchParams.get('after') || 0) || 0
      const limit = Number(url.searchParams.get('limit') || 500) || 500
      const safeLimit = Math.min(1000, Math.max(1, limit))
      const actorId = url.searchParams.get('actor') || url.searchParams.get('actorId')
      const minVersion = await getMinOperationVersion(roomKey)
      if (
        minVersion != null &&
        afterVersion > 0 &&
        afterVersion < minVersion
      ) {
        sendJson(res, 409, {
          error: 'requested operations were archived',
          code: 'RESNAPSHOT_REQUIRED',
          mapId: roomKey,
          afterVersion,
          minVersion,
          currentVersion
        })
        recordRecovery('resnapshot')
        return true
      }
      const operations = await listRoomOperations(roomKey, afterVersion, safeLimit, {
        actorId: actorId || undefined
      })
      if (operations.length) recordRecovery('operations')
      const lastVersion = operations.length
        ? operations[operations.length - 1].version
        : afterVersion
      sendJson(res, 200, {
        mapId: roomKey,
        afterVersion,
        currentVersion,
        operations,
        events: operations.map(item => item.event),
        hasMore:
          lastVersion < currentVersion && operations.length >= safeLimit
      })
      return true
    }
    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req, { maxBytes: bodyLimitForPath(pathname) })
      } catch (err) {
        sendJson(res, err.statusCode || 400, {
          error: err.message || 'bad request',
          code: err.code || 'BAD_BODY'
        })
        return true
      }
      try {
        const command = normalizeCommand(req, roomKey, body)
        const committed = await executeOperation(req, roomKey, command)
        sendJson(
          res,
          committed.duplicate ? 200 : 201,
          operationResponse(roomKey, committed)
        )
      } catch (err) {
        sendJson(res, err.statusCode || 400, {
          error: err.message || 'bad request',
          code: err.code || 'OPERATION_REJECTED',
          retryAfterMs: err.retryAfterMs
        })
      }
      return true
    }
  }

  const mapBatchMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/operations\/batch$/
  )
  if (mapBatchMatch && req.method === 'POST') {
    const roomKey = safeRoomKey(decodeURIComponent(mapBatchMatch[1]))
    let body
    try {
      body = await readBody(req, { maxBytes: bodyLimitForPath(pathname) })
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'BAD_BODY'
      })
      return true
    }
    const ops = Array.isArray(body.operations)
      ? body.operations
      : Array.isArray(body.ops)
        ? body.ops
        : []
    try {
      assertBatchSize(ops)
      assertRateLimit(roomKey)
      const results = []
      for (const item of ops) {
        const command = normalizeCommand(req, roomKey, {
          ...body,
          ...item,
          payload: item.payload || item
        })
        const committed = await executeOperation(req, roomKey, command)
        results.push(operationResponse(roomKey, committed))
      }
      sendJson(res, 200, { mapId: roomKey, results })
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'BATCH_REJECTED',
        retryAfterMs: err.retryAfterMs
      })
    }
    return true
  }

  const mapSnapshotMatch = pathname.match(/^\/api\/maps\/([^/]+)\/snapshot$/)
  if (mapSnapshotMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapSnapshotMatch[1]))
    const requested = url.searchParams.get('version')
    try {
      const loaded =
        requested == null || requested === ''
          ? await loadSnapshot(roomKey)
          : await loadNodesAtVersion(roomKey, requested)
      if (!loaded) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const depth = Math.min(8, Math.max(0, Number(url.searchParams.get('depth') || 2)))
      const version = Number(
        loaded.version != null
          ? loaded.version
          : (loaded.row && loaded.row.version) || 0
      )
      const preview = mindDoc.buildPreview(loaded.obj, {
        keepDepth: depth,
        largeAt: 200,
        version
      })
      sendJson(res, 200, {
        mapId: roomKey,
        room_key: roomKey,
        version,
        historical: requested != null && requested !== '',
        title: (loaded.row && loaded.row.title) || '未命名',
        ...preview
      })
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'SNAPSHOT_FAILED'
      })
    }
    return true
  }

  const mapSubtreeMatch = pathname.match(
    /^\/api\/maps\/([^/]+)\/subtrees\/([^/]+)$/
  )
  if (mapSubtreeMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapSubtreeMatch[1]))
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendVersionedSubtree(
      res,
      roomKey,
      loaded,
      decodeURIComponent(mapSubtreeMatch[2]),
      url
    )
    return true
  }

  if (req.method === 'POST' && pathname === '/api/files') {
    const body = await readBody(req)
    const roomKey = safeRoomKey(body.room_key || createRoomKey())
    if (isDeletedRoom(roomKey)) await reviveRoom(roomKey)
    const title =
      String(body.title || '未命名')
        .trim()
        .slice(0, 80) || '未命名'
    const existed = await loadMap(roomKey)
    if (existed && Object.keys(existed.obj).length) {
      sendJson(res, 409, { error: '房间已存在', room_key: roomKey })
      return true
    }
    const tree = mindDoc.treeToObject(normalizeTree(body.tree, title))
    const ydoc = await ensureDoc(roomKey)
    const payload = await persist(
      roomKey,
      ydoc,
      mindDoc.ensureRoot(tree, title),
      title,
      { replace: true, responseFormat: 'outline', persistNow: true }
    )
    sendJson(res, 201, payload)
    return true
  }

  const nodeMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/nodes(?:\/([^/]+))?$/
  )
  if (nodeMatch) {
    const roomKey = decodeURIComponent(nodeMatch[1])
    const nodeRef = nodeMatch[2] ? decodeURIComponent(nodeMatch[2]) : ''
    if (isDeletedRoom(roomKey)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    if (req.method === 'GET' && !nodeRef) {
      const uids = String(url.searchParams.get('uids') || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
      // Always read from authoritative snapshot/cache. Live Y.Doc can lag behind
      // HTTP commits during ensureDoc warmup and would poison remote recover.
      const loaded = await loadSnapshot(roomKey)
      if (!loaded) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      sendJson(res, 200, {
        room_key: roomKey,
        version: Number((loaded.row && loaded.row.version) || 0),
        updated_at: loaded.row && loaded.row.updated_at,
        nodes: mindDoc.nodesByUids(loaded.obj, uids)
      })
      return true
    }
    const row = await getRoom(roomKey)
    if (!row && !getLiveDoc(roomKey)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      if (req.method === 'POST' && !nodeRef) {
        const body = await readBody(req)
        const command = normalizeCommand(req, roomKey, body, 'node.insert', {
          parentUid: body.parent || body.parent_uid || 'root',
          uid: body.uid,
          text: body.text,
          note: body.note,
          index: body.index,
          data: dataFields(body),
          confirm_sop_change: body.confirm_sop_change === true
        })
        const committed = await executeOperation(req, roomKey, command)
        sendJson(res, 200, await nodeMutationResponse(roomKey, committed))
        return true
      }
      if (req.method === 'PATCH' && nodeRef) {
        const body = await readBody(req)
        const hasParent =
          body.parent !== undefined || body.parent_uid !== undefined
        const hasIndex = body.index !== undefined
        const patchFields = dataFields(body)
        const hasData = Object.keys(patchFields).length > 0
        let fallbackType = 'node.update'
        if (hasParent) fallbackType = 'node.move'
        else if (body.reorder === true || body.type === 'node.reorder') {
          fallbackType = 'node.reorder'
        } else if (hasIndex && !hasData) fallbackType = 'node.reorder'
        else if (hasIndex) fallbackType = 'node.move'
        const command = normalizeCommand(
          req,
          roomKey,
          body,
          fallbackType,
          {
            uid: nodeRef,
            parentUid: body.parent || body.parent_uid,
            index: body.index,
            patch: patchFields,
            confirm_sop_change: body.confirm_sop_change === true
          }
        )
        const committed = await executeOperation(req, roomKey, command)
        sendJson(res, 200, await nodeMutationResponse(roomKey, committed))
        return true
      }
      if (req.method === 'DELETE' && nodeRef) {
        const body = await readBody(req).catch(() => ({}))
        const command = normalizeCommand(req, roomKey, body, 'node.delete', {
          uid: nodeRef,
          keepChildren: !!(body && (body.keep_children || body.keepChildren)),
          confirm_sop_change: !!(body && body.confirm_sop_change)
        })
        const committed = await executeOperation(req, roomKey, command)
        sendJson(res, 200, await nodeMutationResponse(roomKey, committed))
        return true
      }
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'OPERATION_REJECTED'
      })
      return true
    }
  }

  const todosMatch = pathname.match(/^\/api\/files\/([^/]+)\/todos$/)
  if (todosMatch) {
    const roomKey = decodeURIComponent(todosMatch[1])
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      if (req.method === 'GET') {
        const result = mindDoc.listTodos(loaded.obj)
        const includeCompleted =
          url.searchParams.get('include_completed') === 'true'
        sendJson(res, 200, {
          room_key: roomKey,
          pending: result.pending,
          completed: includeCompleted ? result.completed : undefined,
          pending_count: result.pending.length,
          completed_count: result.completed.length
        })
        return true
      }
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'bad request' })
      return true
    }
  }

  const prepareTodoMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/todos\/prepare$/
  )
  if (prepareTodoMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(prepareTodoMatch[1])
    const body = await readBody(req)
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      if (!body.task) throw new Error('缺少task')
      sendJson(res, 200, {
        room_key: roomKey,
        ...mindDoc.prepareTodo(loaded.obj, body.task, body.sop)
      })
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'bad request' })
    }
    return true
  }

  const completeTodoMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/todos\/complete$/
  )
  if (completeTodoMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(completeTodoMatch[1])
    const body = await readBody(req)
    try {
      const result = await withRoomMutation(roomKey, async () => {
        const snapshot = await getRoomSnapshot(roomKey)
        const live = getLiveObject(roomKey)
        const base =
          live && Object.keys(live).length
            ? live
            : (snapshot && snapshot.nodes) || {}
        if (!snapshot && !Object.keys(base).length) throw new Error('not found')
        const completed = mindDoc.completeTodo(base, {
          ...body,
          completed_at: new Date().toISOString()
        })
        const publicResult = Object.fromEntries(
          Object.entries(completed).filter(([key]) => key !== 'obj')
        )
        if (completed.already_completed) {
          return {
            ...publicResult,
            version: Number((snapshot && snapshot.version) || 0)
          }
        }
        const command = normalizeCommand(req, roomKey, body, 'batch.apply', {
          source: 'todo.complete',
          resnapshot: true
        })
        const committed = await executeSnapshotOperation(
          req,
          roomKey,
          command,
          completed.obj,
          {
            source: 'todo.complete',
            eventType: 'batch.applied',
            eventPayload: { taskUid: completed.task_uid },
            affectedUids: [completed.task_uid].filter(Boolean),
            result: { uid: completed.task_uid }
          }
        )
        return {
          ...publicResult,
          version: committed.operation.version
        }
      })
      sendJson(res, 200, { room_key: roomKey, ...result })
    } catch (err) {
      sendJson(res, err.message === 'not found' ? 404 : 400, {
        error: err.message || 'bad request'
      })
    }
    return true
  }

  const proposalMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/sop\/proposals$/
  )
  if (proposalMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(proposalMatch[1])
    const body = await readBody(req)
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      sendJson(res, 200, {
        room_key: roomKey,
        proposal: mindDoc.proposeSopImprovement(loaded.obj, body)
      })
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'bad request' })
    }
    return true
  }

  const applyProposalMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/sop\/proposals\/apply$/
  )
  if (applyProposalMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(applyProposalMatch[1])
    const body = await readBody(req)
    try {
      const result = await withRoomMutation(roomKey, async () => {
        const snapshot = await getRoomSnapshot(roomKey)
        const live = getLiveObject(roomKey)
        const base =
          live && Object.keys(live).length
            ? live
            : (snapshot && snapshot.nodes) || {}
        if (!snapshot && !Object.keys(base).length) throw new Error('not found')
        const applied = mindDoc.applySopImprovement(base, body)
        const command = normalizeCommand(req, roomKey, body, 'batch.apply', {
          source: 'sop.apply',
          resnapshot: true,
          confirm_sop_change: true
        })
        const committed = await executeSnapshotOperation(
          req,
          roomKey,
          command,
          applied.obj,
          {
            source: 'sop.apply',
            eventType: 'batch.applied',
            eventPayload: { sopUid: applied.sop_uid, changedUid: applied.changed_uid },
            affectedUids: [applied.sop_uid, applied.changed_uid].filter(Boolean),
            result: { uid: applied.changed_uid }
          }
        )
        return {
          ...Object.fromEntries(
            Object.entries(applied).filter(([key]) => key !== 'obj')
          ),
          version: committed.operation.version
        }
      })
      sendJson(res, 200, { room_key: roomKey, ...result })
    } catch (err) {
      sendJson(res, err.message === 'not found' ? 404 : 400, {
        error: err.message || 'bad request'
      })
    }
    return true
  }

  const replaceMatch = pathname.match(/^\/api\/files\/([^/]+)\/replace$/)
  if (replaceMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(replaceMatch[1])
    let body
    try {
      body = await readBody(req, { maxBytes: bodyLimitForPath(pathname) })
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        error: err.message || 'bad request',
        code: err.code || 'BAD_BODY'
      })
      return true
    }
    if (!body.tree) {
      sendJson(res, 400, { error: '缺少 tree' })
      return true
    }
    try {
      assertRateLimit(roomKey)
      const payload = await withRoomMutation(roomKey, async () => {
        const snapshot = await getRoomSnapshot(roomKey)
        const live = getLiveObject(roomKey)
        const current = nodesFromSnapshotOrLive(snapshot, live) || {}
        if (
          Object.keys(current).length &&
          mindDoc.isWithinSop(current, 'SOP') &&
          body.confirm_sop_change !== true
        ) {
          const err = new Error('整树覆盖会修改SOP，必须设置confirm_sop_change=true')
          err.statusCode = 400
          throw err
        }
        if (!(await getRoom(roomKey))) {
          await upsertRoom(roomKey, body.title || '未命名')
        }
        const obj = mindDoc.treeToObject(normalizeTree(body.tree, body.title))
        const command = normalizeCommand(req, roomKey, body, 'map.replace', {
          resnapshot: true,
          confirm_sop_change: body.confirm_sop_change === true
        })
        const committed = await executeSnapshotOperation(
          req,
          roomKey,
          command,
          obj,
          {
            source: 'map.replace',
            eventType: 'map.replaced',
            title: body.title
          }
        )
        const row = await getRoom(roomKey)
        return mapPayload(roomKey, obj, { ...row, version: committed.operation.version })
      })
      sendJson(res, 200, payload)
    } catch (err) {
      sendJson(res, err.statusCode || (err.message === 'not found' ? 404 : 400), {
        error: err.message || 'bad request',
        code: err.code || undefined,
        retryAfterMs: err.retryAfterMs
      })
    }
    return true
  }

  const previewMatch = pathname.match(/^\/api\/files\/([^/]+)\/preview$/)
  if (previewMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(previewMatch[1])
    if (isDeletedRoom(roomKey)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const obj = loaded.obj
    const row = loaded.row
    const keepDepth = Number(url.searchParams.get('depth') || 2) || 2
    const preview = mindDoc.buildPreview(obj, {
      keepDepth,
      largeAt: 200,
      version: Number((row && row.version) || 0)
    })
    sendJson(res, 200, {
      ...mapMeta(roomKey, obj, row),
      ...preview
    })
    setImmediate(() => {
      ensureDoc(roomKey).catch(err => {
        console.error('[persist] warmup failed', roomKey, err.message)
      })
    })
    return true
  }

  const subtreeMatch = pathname.match(/^\/api\/files\/([^/]+)\/subtree$/)
  if (subtreeMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(subtreeMatch[1])
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const uid = url.searchParams.get('uid') || 'root'
    sendVersionedSubtree(res, roomKey, loaded, uid, url)
    return true
  }

  const locateMatch = pathname.match(/^\/api\/files\/([^/]+)\/locate$/)
  if (locateMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(locateMatch[1])
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const located = mindDoc.locateNode(
      loaded.obj,
      url.searchParams.get('uid') || url.searchParams.get('q') || 'root'
    )
    if (!located) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const version = Number((loaded.row && loaded.row.version) || 0)
    Object.keys(located.nodes || {}).forEach(id => {
      const node = located.nodes[id]
      if (node && node.data && version) node.data.subtreeVersion = version
    })
    sendJson(res, 200, {
      room_key: roomKey,
      version,
      updated_at: loaded.row && loaded.row.updated_at,
      ...located
    })
    return true
  }

  const saveStatusMatch = pathname.match(/^\/api\/files\/([^/]+)\/save-status$/)
  if (saveStatusMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(saveStatusMatch[1])
    const local = getSaveStatus(roomKey)
    const row = await getRoom(roomKey)
    sendJson(res, 200, {
      room_key: roomKey,
      ...local,
      version: Number((row && row.version) || 0),
      updated_at: pickLatestTimestamp(
        row && row.updated_at,
        local.updated_at
      )
    })
    return true
  }

  const searchMatch = pathname.match(/^\/api\/files\/([^/]+)\/search$/)
  if (searchMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(searchMatch[1])
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, {
      room_key: roomKey,
      version: Number((loaded.row && loaded.row.version) || 0),
      matches: mindDoc.searchNodes(
        loaded.obj,
        url.searchParams.get('q') || '',
        { limit: url.searchParams.get('limit') }
      )
    })
    return true
  }

  const outlineMatch = pathname.match(/^\/api\/files\/([^/]+)\/outline$/)
  if (outlineMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(outlineMatch[1])
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, {
      room_key: roomKey,
      version: Number((loaded.row && loaded.row.version) || 0),
      title: (loaded.row && loaded.row.title) || '未命名',
      share_url: shareUrl(roomKey),
      outline: mindDoc.toOutline(loaded.obj, {
        maxNodes: Number(url.searchParams.get('max_nodes') || 0) || 0
      })
    })
    return true
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/)
  if (fileMatch) {
    const roomKey = decodeURIComponent(fileMatch[1])
    if (req.method === 'GET') {
      const loaded = await loadMap(roomKey)
      if (!loaded) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const format = url.searchParams.get('format') || 'outline'
      sendJson(
        res,
        200,
        mapPayload(roomKey, loaded.obj, loaded.row, {
          format,
          max_nodes: url.searchParams.get('max_nodes')
        })
      )
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      try {
        const snapshot = await getRoomSnapshot(roomKey)
        if (!snapshot) {
          sendJson(res, 404, { error: 'not found' })
          return true
        }
        const title =
          String(body.title || '').trim().slice(0, 80) || '未命名'
        const command = normalizeCommand(req, roomKey, body, 'map.update', {
          title
        })
        const committed = await executeSnapshotOperation(
          req,
          roomKey,
          command,
          snapshot.nodes || {},
          {
            title,
            eventType: 'map.updated',
            resnapshot: false,
            keepNodes: true,
            source: 'map.update',
            inversePayload: {
              type: 'map.update',
              payload: { title: snapshot.title }
            },
            result: { title }
          }
        )
        const row = await getRoom(roomKey)
        sendJson(res, 200, {
          ...withShare(row),
          version: committed.operation.version,
          duplicate: !!committed.duplicate,
          operationId: committed.operation.operation_id
        })
      } catch (err) {
        sendJson(res, err.statusCode || 400, {
          error: err.message || 'bad request',
          code: err.code || 'OPERATION_REJECTED'
        })
      }
      return true
    }
    if (req.method === 'DELETE') {
      await removeRoom(roomKey)
      sendJson(res, 200, { ok: true })
      return true
    }
  }

  return false
}

module.exports = { handleApi }
