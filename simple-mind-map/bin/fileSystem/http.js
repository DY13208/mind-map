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

function folderMembers(pathname) {
  const match = String(pathname || '').match(/^\/api\/folders\/([^/]+)\/members(?:\/([^/]+))?$/)
  return match
    ? { id: decodeURIComponent(match[1]), userId: match[2] ? decodeURIComponent(match[2]) : '' }
    : null
}
function folderMembersBulk(pathname) {
  const match = String(pathname || '').match(/^\/api\/folders\/([^/]+)\/members\/bulk$/)
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

function filePreview(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/(?:files|maps|rooms)\/([^/]+)\/card-preview$/
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
      folderMembers(pathname) ||
      folderMembersBulk(pathname) ||
      folderItem(pathname) ||
      fileMove(pathname) ||
      fileInfo(pathname) ||
      filePreview(pathname) ||
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
    const bulkFolderId = folderMembersBulk(pathname)
    if (bulkFolderId && method === 'POST') {
      const folder = await fs.store.getFolder(bulkFolderId)
      if (!folder) throw Object.assign(new Error('文件夹不存在'), { code: 'FOLDER_NOT_FOUND', statusCode: 404 })
      if (!bypass && folder.created_by !== userId) throw Object.assign(new Error('只有文件夹所有者可以设置权限'), { code: 'FORBIDDEN', statusCode: 403 })
      const body = options.body || (await readBody(req))
      const role = String(body.role || '').trim().toLowerCase()
      if (!['manager', 'editor', 'viewer'].includes(role)) throw Object.assign(new Error('文件夹权限必须是可管理、可编辑或可查看'), { code: 'BAD_REQUEST', statusCode: 400 })
      const params = [req.authUser && req.authUser.corpId]
      let where = ['corp_id = $1']
      if (body.departmentId) {
        const departments = await require('../auth').listWecomDepartments()
        const selected = new Set([Number(body.departmentId)])
        if (body.includeChildren !== false) {
          let changed = true
          while (changed) { changed = false; departments.forEach(d => { if (selected.has(Number(d.parentId)) && !selected.has(Number(d.id))) { selected.add(Number(d.id)); changed = true } }) }
        }
        params.push(Array.from(selected).map(String))
        where.push(`departments ?| $${params.length}::text[]`)
      }
      const rows = fs.store.kind === 'pg' ? (await fs.store.query(`select user_id from wecom_users where ${where.join(' and ')}`, params)).rows : []
      for (const row of rows) {
        if (!row.user_id || row.user_id === folder.created_by) continue
        await fs.store.setFolderMember(bulkFolderId, row.user_id, role)
        for (const roomKey of await fs.store.roomKeysInFolder(bulkFolderId)) {
          const room = await fs.store.getRoom(roomKey)
          if (room && room.owner_id === row.user_id) continue
          if (role !== 'manager') await roomAcl.setMember(fs.store, roomKey, row.user_id, role, userId, req.authUser && req.authUser.corpId)
        }
      }
      sendJson(res, 200, { ok: true, list: await fs.store.listFolderMembers(bulkFolderId), added: rows.length })
      return true
    }
    const folderAcl = folderMembers(pathname)
    if (folderAcl) {
      const folder = await fs.store.getFolder(folderAcl.id)
      if (!folder) throw Object.assign(new Error('文件夹不存在'), { code: 'FOLDER_NOT_FOUND', statusCode: 404 })
      const folderMember = !bypass && userId && fs.store.listFolderMembers
        ? (await fs.store.listFolderMembers(folderAcl.id)).find(item => item.user_id === userId)
        : null
      const canManage = bypass || folder.created_by === userId || (folderMember && folderMember.role === 'manager')
      if (!canManage && method !== 'GET') {
        throw Object.assign(new Error('只有文件夹所有者可以设置权限'), { code: 'FORBIDDEN', statusCode: 403 })
      }
      if (method === 'GET' && !folderAcl.userId) {
        const list = await fs.store.listFolderMembers(folderAcl.id)
        sendJson(res, 200, { ok: true, list, canManage })
        return true
      }
      if ((method === 'POST' || method === 'PATCH') && (!folderAcl.userId || method === 'PATCH')) {
        const body = options.body || (await readBody(req))
        const role = String(body.role || '').trim().toLowerCase()
        if (!['manager', 'editor', 'viewer'].includes(role)) {
          throw Object.assign(new Error('文件夹权限必须是可编辑或可查看'), { code: 'BAD_REQUEST', statusCode: 400 })
        }
        const requestedUser = folderAcl.userId || body.userId || body.user_id
        const targetId = await roomAcl.resolveUserId(
          fs.store,
          requestedUser,
          req.authUser && req.authUser.corpId
        )
        if (!targetId || targetId === folder.created_by) {
          throw Object.assign(new Error('请选择其他企业成员'), { code: 'BAD_REQUEST', statusCode: 400 })
        }
        if (folderMember && folderMember.role === 'manager' && role === 'manager') {
          throw Object.assign(new Error('可管理权限只能由文件夹创建人授予'), { code: 'FORBIDDEN', statusCode: 403 })
        }
        const currentMember = (await fs.store.listFolderMembers(folderAcl.id)).find(item => item.user_id === targetId)
        if (currentMember && currentMember.role === 'owner') {
          throw Object.assign(new Error('文件夹所有者权限不能修改'), { code: 'FORBIDDEN', statusCode: 403 })
        }
        await fs.store.setFolderMember(folderAcl.id, targetId, role)
        const roomKeys = await fs.store.roomKeysInFolder(folderAcl.id)
        for (const roomKey of roomKeys) {
          if (role !== 'manager') await roomAcl.setMember(fs.store, roomKey, targetId, role, userId,
            req.authUser && req.authUser.corpId)
        }
        const list = await fs.store.listFolderMembers(folderAcl.id)
        sendJson(res, 200, { ok: true, list })
        return true
      }
      if (method === 'DELETE' && folderAcl.userId) {
        const targetId = await roomAcl.resolveUserId(
          fs.store,
          folderAcl.userId,
          req.authUser && req.authUser.corpId
        )
        await fs.store.removeFolderMember(folderAcl.id, targetId)
        const roomKeys = await fs.store.roomKeysInFolder(folderAcl.id)
        for (const roomKey of roomKeys) {
          await roomAcl.removeMember(fs.store, roomKey, targetId,
            req.authUser && req.authUser.corpId).catch(() => {})
        }
        sendJson(res, 200, { ok: true })
        return true
      }
    }
    if (method === 'GET' && collectionPath(pathname)) {
      const sharedParam = String(
        url.searchParams.get('shared') || url.searchParams.get('scope') || ''
      )
        .trim()
        .toLowerCase()
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
        shared:
          sharedParam === '1' ||
          sharedParam === 'true' ||
          sharedParam === 'shared',
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
    const previewKey = filePreview(pathname)
    if (previewKey && method === 'GET') {
      const preview = await fs.getRoomPreview(safeRoomKey(previewKey), {
        userId,
        bypass
      })
      sendJson(res, 200, { ok: true, preview })
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
