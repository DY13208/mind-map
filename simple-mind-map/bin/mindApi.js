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
  listRoomOperations
} = require('./storage')
const { beatPresence, listPresence, leavePresence } = require('./presence')

const roomMutationQueues = new Map()

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
  const liveDoc = getLiveDoc(roomKey)
  if (liveDoc) {
    const replace =
      command.type === 'batch.apply' || command.type === 'map.replace'
    try {
      if (replace) {
        mindDoc.applyObjectToDoc(liveDoc, nodes || {}, { replace: true })
      } else {
        applyNodeCommand(liveDoc, command)
      }
    } catch (err) {
      mindDoc.applyObjectToDoc(liveDoc, nodes || {}, { replace: true })
    }
    scheduleSave(roomKey, liveDoc)
  }
  return committed
}

async function executeOperation(req, roomKey, command) {
  return withRoomMutation(roomKey, async () => {
    const committed = await commitRoomOperation(
      roomKey,
      command,
      async ({ room }) => {
        const live = getLiveObject(roomKey)
        const base =
          live && Object.keys(live).length ? live : room.nodes || {}
        const tempDoc = new Y.Doc()
        try {
          mindDoc.applyObjectToDoc(tempDoc, base, { replace: true })
          const applied = applyNodeCommand(tempDoc, command)
          return { ...applied, nodes: mindDoc.readObject(tempDoc) }
        } finally {
          tempDoc.destroy()
        }
      }
    )
    return applyCommittedLive(roomKey, command, committed)
  })
}

async function executeSnapshotOperation(
  req,
  roomKey,
  command,
  nextNodes,
  extra = {}
) {
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
  const live = getLiveObject(roomKey)
  const snapshot = await getRoomSnapshot(roomKey)
  if (live) return { obj: live, row: snapshot }
  if (snapshot && snapshot.nodes && Object.keys(snapshot.nodes).length) {
    return { obj: snapshot.nodes, row: snapshot }
  }
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
    sendJson(res, 200, { ok: true, service: 'mind-map-collab' })
    return true
  }

  const presenceMatch = pathname.match(/^\/api\/files\/([^/]+)\/presence$/)
  if (presenceMatch) {
    const roomKey = decodeURIComponent(presenceMatch[1])
    if (req.method === 'GET') {
      sendJson(res, 200, { list: listPresence(roomKey) })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      sendJson(res, 200, { list: beatPresence(roomKey, body) })
      return true
    }
    if (req.method === 'DELETE') {
      const body = await readBody(req).catch(() => ({}))
      sendJson(res, 200, { list: leavePresence(roomKey, body && body.id) })
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
      const operations = await listRoomOperations(roomKey, afterVersion, safeLimit)
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
      const body = await readBody(req)
      try {
        const command = normalizeCommand(req, roomKey, body)
        const committed = await executeOperation(req, roomKey, command)
        sendJson(res, committed.duplicate ? 200 : 201, operationResponse(roomKey, committed))
      } catch (err) {
        sendJson(res, err.statusCode || 400, {
          error: err.message || 'bad request',
          code: err.code || 'OPERATION_REJECTED'
        })
      }
      return true
    }
  }

  const mapSnapshotMatch = pathname.match(/^\/api\/maps\/([^/]+)\/snapshot$/)
  if (mapSnapshotMatch && req.method === 'GET') {
    const roomKey = safeRoomKey(decodeURIComponent(mapSnapshotMatch[1]))
    const loaded = await loadSnapshot(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const depth = Math.min(8, Math.max(0, Number(url.searchParams.get('depth') || 2)))
    const preview = mindDoc.buildPreview(loaded.obj, {
      keepDepth: depth,
      largeAt: 200
    })
    sendJson(res, 200, {
      mapId: roomKey,
      room_key: roomKey,
      version: Number((loaded.row && loaded.row.version) || 0),
      title: (loaded.row && loaded.row.title) || '未命名',
      ...preview
    })
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
      const liveDoc = getLiveDoc(roomKey)
      if (liveDoc) {
        const row = await getRoom(roomKey)
        sendJson(res, 200, {
          room_key: roomKey,
          version: Number((row && row.version) || 0),
          updated_at: row && row.updated_at,
          nodes: mindDoc.nodesByUidsFromDoc(liveDoc, uids)
        })
        return true
      }
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
        const moving =
          body.parent !== undefined ||
          body.parent_uid !== undefined ||
          body.index !== undefined
        const command = normalizeCommand(
          req,
          roomKey,
          body,
          moving ? 'node.move' : 'node.update',
          {
            uid: nodeRef,
            parentUid: body.parent || body.parent_uid,
            index: body.index,
            patch: dataFields(body),
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
    const body = await readBody(req)
    if (!body.tree) {
      sendJson(res, 400, { error: '缺少 tree' })
      return true
    }
    try {
      const payload = await withRoomMutation(roomKey, async () => {
        const snapshot = await getRoomSnapshot(roomKey)
        const live = getLiveObject(roomKey)
        const current =
          live && Object.keys(live).length
            ? live
            : (snapshot && snapshot.nodes) || {}
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
        error: err.message || 'bad request'
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
    const preview = mindDoc.buildPreview(obj, { keepDepth, largeAt: 200 })
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
    const resolved = mindDoc.resolveNode(loaded.obj, uid)
    const deep =
      url.searchParams.get('deep') === '1' ||
      url.searchParams.get('deep') === 'true'
    const subtree = deep
      ? mindDoc.subtreeTree(loaded.obj, resolved, {
          maxNodes: url.searchParams.get('max_nodes')
        })
      : mindDoc.subtreeChildren(loaded.obj, resolved, {
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit')
        })
    if (!subtree || (deep && !subtree.tree)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, {
      room_key: roomKey,
      updated_at: loaded.row && loaded.row.updated_at,
      ...subtree
    })
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
    sendJson(res, 200, {
      room_key: roomKey,
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
