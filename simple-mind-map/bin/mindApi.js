const mindDoc = require('./mindDoc')
const {
  listRooms,
  getRoom,
  getRoomSnapshot,
  renameRoom,
  removeRoom,
  ensureDoc,
  saveDoc,
  upsertRoom,
  sendJson,
  readBody,
  safeRoomKey,
  shareUrl,
  getSaveStatus,
  isDeletedRoom,
  reviveRoom,
  scheduleSave
} = require('./storage')

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
  const row = await getRoom(roomKey)
  const title = (row && row.title) || extra.title || '未命名'
  await upsertRoom(roomKey, title)
  scheduleSave(roomKey, ydoc)
  return {
    uid: extra.uid || '',
    room_key: roomKey,
    title,
    share_url: shareUrl(roomKey)
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'mind-map-collab' })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const list = (await listRooms()).map(withShare)
    sendJson(res, 200, { list })
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
      const loaded = await loadSnapshot(roomKey)
      if (!loaded) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      const uids = String(url.searchParams.get('uids') || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
      sendJson(res, 200, {
        room_key: roomKey,
        updated_at: loaded.row && loaded.row.updated_at,
        nodes: mindDoc.nodesByUids(loaded.obj, uids)
      })
      return true
    }
    const ydoc = await ensureDoc(roomKey)
    const row = await getRoom(roomKey)
    if (!row && ydoc.getMap().size === 0) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      if (req.method === 'POST' && !nodeRef) {
        const body = await readBody(req)
        if (
          mindDoc.isWithinSopOnDoc(
            ydoc,
            body.parent || body.parent_uid || 'root'
          ) &&
          body.confirm_sop_change !== true
        ) {
          throw new Error(
            '修改SOP前必须获得用户确认并设置confirm_sop_change=true'
          )
        }
        const result = mindDoc.addNodeOnDoc(ydoc, {
          parent: body.parent || body.parent_uid || 'root',
          text: body.text,
          note: body.note,
          uid: body.uid
        })
        const payload = await persistPatch(roomKey, ydoc, result)
        sendJson(res, 200, {
          ...payload,
          uid: result.uid,
          parent_uid: result.parent_uid
        })
        return true
      }
      if (req.method === 'PATCH' && nodeRef) {
        const body = await readBody(req)
        if (
          mindDoc.isWithinSopOnDoc(ydoc, nodeRef) &&
          body.confirm_sop_change !== true
        ) {
          throw new Error(
            '修改SOP前必须获得用户确认并设置confirm_sop_change=true'
          )
        }
        const result = mindDoc.updateNodeOnDoc(ydoc, nodeRef, body)
        const payload = await persistPatch(roomKey, ydoc, result)
        sendJson(res, 200, { ...payload, uid: result.uid })
        return true
      }
      if (req.method === 'DELETE' && nodeRef) {
        const body = await readBody(req).catch(() => ({}))
        if (
          mindDoc.isWithinSopOnDoc(ydoc, nodeRef) &&
          (!body || body.confirm_sop_change !== true)
        ) {
          throw new Error(
            '修改SOP前必须获得用户确认并设置confirm_sop_change=true'
          )
        }
        const result = mindDoc.deleteNodeOnDoc(ydoc, nodeRef)
        const payload = await persistPatch(roomKey, ydoc, result)
        sendJson(res, 200, {
          ...payload,
          uid: result.uid,
          removed: result.removed
        })
        return true
      }
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'bad request' })
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
        const loaded = await loadMap(roomKey)
        if (!loaded) throw new Error('not found')
        const completed = mindDoc.completeTodo(loaded.obj, {
          ...body,
          completed_at: new Date().toISOString()
        })
        if (!completed.already_completed) {
          await persist(roomKey, loaded.ydoc, completed.obj, null, {
            previousObject: loaded.obj,
            persistNow: true
          })
        }
        return Object.fromEntries(
          Object.entries(completed).filter(([key]) => key !== 'obj')
        )
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
        const loaded = await loadMap(roomKey)
        if (!loaded) throw new Error('not found')
        const applied = mindDoc.applySopImprovement(loaded.obj, body)
        await persist(roomKey, loaded.ydoc, applied.obj, null, {
          previousObject: loaded.obj,
          persistNow: true
        })
        return Object.fromEntries(
          Object.entries(applied).filter(([key]) => key !== 'obj')
        )
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
    const current = await loadMap(roomKey)
    if (
      current &&
      mindDoc.isWithinSop(current.obj, 'SOP') &&
      body.confirm_sop_change !== true
    ) {
      sendJson(res, 400, {
        error: '整树覆盖会修改SOP，必须设置confirm_sop_change=true'
      })
      return true
    }
    const ydoc = await ensureDoc(roomKey)
    const obj = mindDoc.treeToObject(normalizeTree(body.tree, body.title))
    const payload = await persist(roomKey, ydoc, obj, body.title, {
      replace: true,
      persistNow: true
    })
    sendJson(res, 200, payload)
    return true
  }

  const previewMatch = pathname.match(/^\/api\/files\/([^/]+)\/preview$/)
  if (previewMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(previewMatch[1])
    if (isDeletedRoom(roomKey)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const snapshot = await getRoomSnapshot(roomKey)
    let obj = snapshot && snapshot.nodes
    let row = snapshot
    if (!obj) {
      const loaded = await loadMap(roomKey)
      if (!loaded) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      obj = loaded.obj
      row = loaded.row
    }
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
    const subtree = mindDoc.subtreeChildren(loaded.obj, resolved, {
      offset: url.searchParams.get('offset'),
      limit: url.searchParams.get('limit')
    })
    if (!subtree) {
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
      updated_at: (row && row.updated_at) || local.updated_at
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
      const row = await renameRoom(roomKey, body.title)
      if (!row) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      sendJson(res, 200, withShare(row))
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
