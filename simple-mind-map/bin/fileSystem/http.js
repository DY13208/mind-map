const { sendJson, readBody, safeRoomKey } = require('../storage')
const { isAuthEnabled } = require('../auth')
const roomAcl = require('../roomAcl')

function collectionPath(pathname) {
  return /^\/api\/(?:files|maps|rooms)$/.test(String(pathname || ''))
}

function folderCollection(pathname) {
  return pathname === '/api/folders'
}

function folderItem(pathname) {
  const match = String(pathname || '').match(/^\/api\/folders\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : ''
}

function fileMove(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/move$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function fileInfo(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/info$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function fileFavorite(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/favorite$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function fileOpen(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/open$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function fileTrash(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/trash$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function fileRestore(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/restore$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function filePermanent(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/permanent$/
  )
  return match ? decodeURIComponent(match[1]) : ''
}

function namedCollection(pathname, name) {
  return new RegExp('^/api/(?:files|maps|rooms)/' + name + '$').test(
    String(pathname || '')
  )
}

function fileItem(pathname) {
  const match = String(pathname || '').match(/^\/api\/(?:files|maps|rooms)\/([^/]+)$/)
  if (!match) return ''
  const key = decodeURIComponent(match[1])
  if (key === 'recent' || key === 'favorites' || key === 'trash') return ''
  return key
}

function actorOf(req) {
  return roomAcl.actorFromReq(req)
}

async function handleFileSystemApi(req, res, options = {}) {
  const url = options.url || new URL(req.url, 'http://127.0.0.1')
  const pathname = options.pathname || url.pathname
  const method = String(req.method || 'GET').toUpperCase()
  const fs = options.engine
  if (!fs) return false

  const actor = actorOf(req)
  if (
    isAuthEnabled() &&
    !actor.bypass &&
    !actor.id &&
    (collectionPath(pathname) ||
      namedCollection(pathname, 'recent') ||
      namedCollection(pathname, 'favorites') ||
      namedCollection(pathname, 'trash') ||
      folderCollection(pathname) ||
      folderItem(pathname) ||
      fileMove(pathname) ||
      fileInfo(pathname) ||
      fileFavorite(pathname) ||
      fileOpen(pathname) ||
      fileTrash(pathname) ||
      fileRestore(pathname) ||
      filePermanent(pathname))
  ) {
    sendJson(res, 401, { ok: false, code: 'unauthorized', error: '请先使用企业微信扫码登录' })
    return true
  }
  const userId = actor.bypass ? actor.id : actor.id
  const bypass = !!actor.bypass || !isAuthEnabled()

  try {
    if (method === 'GET' && collectionPath(pathname)) {
      const listed = await fs.listRooms({
        q: url.searchParams.get('q') || url.searchParams.get('search') || '',
        folderId: url.searchParams.has('folderId')
          ? url.searchParams.get('folderId')
          : undefined,
        sort: url.searchParams.get('sort') || 'updatedAt',
        order: url.searchParams.get('order') || 'desc',
        limit: url.searchParams.get('limit') || 200,
        offset: url.searchParams.get('offset') || 0,
        cursor: url.searchParams.get('cursor') || '',
        userId,
        bypass
      })
      sendJson(res, 200, {
        ok: true,
        list: listed.list,
        total: listed.total,
        limit: listed.limit,
        offset: listed.offset,
        nextCursor: listed.nextCursor
      })
      return true
    }
    if (method === 'GET' && namedCollection(pathname, 'recent')) {
      const listed = await fs.listRecent({
        q: url.searchParams.get('q') || '',
        limit: url.searchParams.get('limit') || 200,
        offset: url.searchParams.get('offset') || 0,
        cursor: url.searchParams.get('cursor') || '',
        userId,
        bypass
      })
      sendJson(res, 200, {
        ok: true,
        list: listed.list,
        total: listed.total,
        limit: listed.limit,
        offset: listed.offset,
        nextCursor: listed.nextCursor
      })
      return true
    }
    if (method === 'GET' && namedCollection(pathname, 'favorites')) {
      const listed = await fs.listFavorites({
        q: url.searchParams.get('q') || '',
        limit: url.searchParams.get('limit') || 200,
        offset: url.searchParams.get('offset') || 0,
        cursor: url.searchParams.get('cursor') || '',
        userId,
        bypass
      })
      sendJson(res, 200, {
        ok: true,
        list: listed.list,
        total: listed.total,
        limit: listed.limit,
        offset: listed.offset,
        nextCursor: listed.nextCursor
      })
      return true
    }
    if (method === 'GET' && namedCollection(pathname, 'trash')) {
      const listed = await fs.listTrash({
        q: url.searchParams.get('q') || '',
        limit: url.searchParams.get('limit') || 200,
        offset: url.searchParams.get('offset') || 0,
        cursor: url.searchParams.get('cursor') || '',
        userId,
        bypass
      })
      sendJson(res, 200, {
        ok: true,
        list: listed.list,
        total: listed.total,
        limit: listed.limit,
        offset: listed.offset,
        nextCursor: listed.nextCursor
      })
      return true
    }
    if (method === 'POST' && collectionPath(pathname)) {
      const body = options.body || (await readBody(req))
      const created = await fs.createRoom({
        title: body.title,
        roomKey: body.room_key || body.roomKey,
        folderId: body.folderId || body.folder_id,
        userId
      })
      sendJson(res, 201, { ok: true, file: created.room, room: created.room })
      return true
    }
    if (method === 'GET' && folderCollection(pathname)) {
      const listed = await fs.listFolders({ userId, bypass })
      sendJson(res, 200, { ok: true, list: listed.list })
      return true
    }
    if (method === 'POST' && folderCollection(pathname)) {
      const body = options.body || (await readBody(req))
      const folder = await fs.createFolder({
        name: body.name,
        parentId: body.parentId || body.parent_id,
        userId,
        bypass
      })
      sendJson(res, 201, { ok: true, folder })
      return true
    }
    const folderId = folderItem(pathname)
    if (folderId && method === 'PATCH') {
      const body = options.body || (await readBody(req))
      const folder = await fs.renameFolder(folderId, body.name, { userId, bypass })
      sendJson(res, 200, { ok: true, folder })
      return true
    }
    if (folderId && method === 'DELETE') {
      const result = await fs.deleteFolder(folderId, { userId, bypass })
      sendJson(res, 200, result)
      return true
    }
    const moveKey = fileMove(pathname)
    if (moveKey && method === 'POST') {
      const body = options.body || (await readBody(req))
      const access = req.roomAccess || {
        canEdit: bypass,
        bypass,
        role: (req.roomAccess && req.roomAccess.role) || (bypass ? 'owner' : null)
      }
      const result = await fs.moveRoom(
        safeRoomKey(moveKey),
        body.folderId || body.folder_id || body.targetFolderId,
        { access, userId }
      )
      sendJson(res, 200, { ok: true, file: result.file })
      return true
    }
    const infoKey = fileInfo(pathname)
    if (infoKey && method === 'GET') {
      const file = await fs.getRoom(safeRoomKey(infoKey), { userId, bypass })
      sendJson(res, 200, { ok: true, viewingHistory: false, file })
      return true
    }
    const favKey = fileFavorite(pathname)
    if (favKey && (method === 'POST' || method === 'DELETE')) {
      const file = await fs.setFavorite(safeRoomKey(favKey), userId, method === 'POST', {
        bypass
      })
      sendJson(res, 200, { ok: true, file })
      return true
    }
    const openKey = fileOpen(pathname)
    if (openKey && method === 'POST') {
      const file = await fs.recordRoomOpened(safeRoomKey(openKey), userId, { bypass })
      sendJson(res, 200, { ok: true, file })
      return true
    }
    const trashKey = fileTrash(pathname)
    if (trashKey && method === 'POST') {
      const access = req.roomAccess || {
        canManage: bypass,
        bypass,
        role: bypass ? 'owner' : null
      }
      const result = await fs.trashRoom(safeRoomKey(trashKey), { access, userId })
      sendJson(res, 200, { ok: true, file: result.file })
      return true
    }
    const restoreKey = fileRestore(pathname)
    if (restoreKey && method === 'POST') {
      const access = req.roomAccess || {
        canManage: bypass,
        bypass,
        role: bypass ? 'owner' : null
      }
      const file = await fs.restoreRoom(safeRoomKey(restoreKey), { access, userId })
      sendJson(res, 200, { ok: true, file })
      return true
    }
    const permKey = filePermanent(pathname)
    if (permKey && method === 'DELETE') {
      const access = req.roomAccess || {
        canManage: bypass,
        bypass,
        role: bypass ? 'owner' : null
      }
      const result = await fs.permanentDeleteRoom(safeRoomKey(permKey), {
        access,
        userId
      })
      sendJson(res, 200, result)
      return true
    }
    const itemKey = fileItem(pathname)
    if (itemKey && method === 'PATCH') {
      const body = options.body || (await readBody(req))
      const collabRename =
        body.tree ||
        body.nodes ||
        body.type === 'map.update' ||
        body.operation ||
        body.clientId
      if (collabRename) return false
      const access = req.roomAccess || {
        canEdit: bypass,
        bypass,
        role: bypass ? 'owner' : null
      }
      const file = await fs.renameRoom(safeRoomKey(itemKey), body.title, { access })
      sendJson(res, 200, { ok: true, file })
      return true
    }
    if (itemKey && method === 'GET' && url.searchParams.get('view') === 'file') {
      const file = await fs.getRoom(safeRoomKey(itemKey), { userId, bypass })
      sendJson(res, 200, { ok: true, file })
      return true
    }
    return false
  } catch (error) {
    sendJson(res, error.statusCode || 400, {
      ok: false,
      code: error.code || 'FILE_SYSTEM_ERROR',
      error: error.message
    })
    return true
  }
}

module.exports = {
  handleFileSystemApi,
  collectionPath
}
