const mindDoc = require('./mindDoc')
const {
  listRooms,
  getRoom,
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
  reviveRoom
} = require('./storage')

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
  const { format = 'outline', ...rest } = extra
  const meta = { ...mapMeta(roomKey, obj, row), ...rest }
  if (format === 'meta') return meta
  if (format === 'full') {
    return { ...meta, tree: mindDoc.objectToTree(obj) }
  }
  if (format === 'nodes') {
    return { ...meta, nodes: mindDoc.flattenNodes(obj) }
  }
  return { ...meta, outline: mindDoc.toOutline(obj) }
}

async function persist(roomKey, ydoc, obj, title, options = {}) {
  mindDoc.applyObjectToDoc(ydoc, obj, options)
  const name = title || mapTitle(obj, null)
  await upsertRoom(roomKey, name)
  await saveDoc(roomKey, ydoc)
  return mapPayload(roomKey, obj, { title: name, room_key: roomKey })
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
    const title = String(body.title || '未命名').trim().slice(0, 80) || '未命名'
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
      { replace: true }
    )
    sendJson(res, 201, payload)
    return true
  }

  const nodeMatch = pathname.match(/^\/api\/files\/([^/]+)\/nodes(?:\/([^/]+))?$/)
  if (nodeMatch) {
    const roomKey = decodeURIComponent(nodeMatch[1])
    const nodeRef = nodeMatch[2] ? decodeURIComponent(nodeMatch[2]) : ''
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    try {
      if (req.method === 'POST' && !nodeRef) {
        const body = await readBody(req)
        const result = mindDoc.addNode(loaded.obj, {
          parent: body.parent || body.parent_uid || 'root',
          text: body.text,
          note: body.note
        })
        const payload = await persist(roomKey, loaded.ydoc, result.obj, null, {
          previousObject: loaded.obj
        })
        sendJson(res, 200, {
          ...payload,
          uid: result.uid,
          parent_uid: result.parent_uid
        })
        return true
      }
      if (req.method === 'PATCH' && nodeRef) {
        const body = await readBody(req)
        const result = mindDoc.updateNode(loaded.obj, nodeRef, body)
        const payload = await persist(roomKey, loaded.ydoc, result.obj, null, {
          previousObject: loaded.obj
        })
        sendJson(res, 200, { ...payload, uid: result.uid })
        return true
      }
      if (req.method === 'DELETE' && nodeRef) {
        const result = mindDoc.deleteNode(loaded.obj, nodeRef)
        const payload = await persist(roomKey, loaded.ydoc, result.obj, null, {
          previousObject: loaded.obj
        })
        sendJson(res, 200, { ...payload, uid: result.uid, removed: result.removed })
        return true
      }
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'bad request' })
      return true
    }
  }

  const replaceMatch = pathname.match(/^\/api\/files\/([^/]+)\/replace$/)
  if (replaceMatch && req.method === 'POST') {
    const roomKey = decodeURIComponent(replaceMatch[1])
    const body = await readBody(req)
    if (!body.tree) {
      sendJson(res, 400, { error: '缺少 tree' })
      return true
    }
    const ydoc = await ensureDoc(roomKey)
    const obj = mindDoc.treeToObject(normalizeTree(body.tree, body.title))
    const payload = await persist(roomKey, ydoc, obj, body.title, {
      replace: true
    })
    sendJson(res, 200, payload)
    return true
  }

  const saveStatusMatch = pathname.match(
    /^\/api\/files\/([^/]+)\/save-status$/
  )
  if (saveStatusMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(saveStatusMatch[1])
    sendJson(res, 200, { room_key: roomKey, ...getSaveStatus(roomKey) })
    return true
  }

  const searchMatch = pathname.match(/^\/api\/files\/([^/]+)\/search$/)
  if (searchMatch && req.method === 'GET') {
    const roomKey = decodeURIComponent(searchMatch[1])
    const loaded = await loadMap(roomKey)
    if (!loaded) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    sendJson(res, 200, {
      room_key: roomKey,
      matches: mindDoc.searchNodes(loaded.obj, url.searchParams.get('q') || '')
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
      outline: mindDoc.toOutline(loaded.obj)
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
        mapPayload(roomKey, loaded.obj, loaded.row, { format })
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
