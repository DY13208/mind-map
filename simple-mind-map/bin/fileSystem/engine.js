const roomAcl = require('../roomAcl')
const {
  DEFAULT_METADATA,
  fsError,
  normalizeTitle,
  normalizeFolderName,
  createRoomKey,
  defaultRootGraph,
  parseFolderId,
  encodeCursor,
  decodeCursor,
  publicFile,
  publicFolder,
  newFolderId
} = require('./model')

function createFileSystem(options = {}) {
  const store = options.store
  const history = options.history || null

  function accessFromRole(role, legacyOpen, bypass) {
    return roomAcl.accessSummary(role, { legacyOpen: !!legacyOpen, bypass: !!bypass })
  }

  function withAccess(row, userId, bypass) {
    const summary = accessFromRole(row.role, row.legacy_open, bypass)
    return publicFile(row, summary)
  }

  async function assertFolderExists(folderId) {
    if (!folderId) return null
    const folder = await store.getFolder(folderId)
    if (!folder) throw fsError('FOLDER_NOT_FOUND', 'folder not found', 404)
    return folder
  }

  async function createRoom(input = {}) {
    const title = normalizeTitle(input.title)
    let roomKey = String(input.roomKey || input.room_key || createRoomKey())
    try {
      const { safeRoomKey } = require('../storage')
      roomKey = safeRoomKey(roomKey)
    } catch (err) {
      throw fsError('INVALID_ROOM_KEY', err.message, 400)
    }
    const userId = roomAcl.normalizeUserId(input.userId || '')
    const folderId = parseFolderId(input.folderId || input.folder_id)
    if (await store.isDeleted(roomKey)) {
      throw fsError('ROOM_DELETED', '房间已删除，如需重建请使用新房间号', 409)
    }
    const existing = await store.getRoom(roomKey)
    if (existing) throw fsError('ROOM_ALREADY_EXISTS', '房间已存在', 409)
    if (folderId) await assertFolderExists(folderId)
    const graph = defaultRootGraph(title)
    const created = await store.withTx(async db => {
      const row = await store.insertRoom(
        {
          room_key: roomKey,
          title,
          cos_key: roomKey + '.yjs',
          nodes: graph,
          version: 0,
          metadata: DEFAULT_METADATA,
          folder_id: folderId,
          owner_id: userId || ''
        },
        db
      )
      await store.writeNodes(roomKey, graph, db)
      if (userId) {
        await store.insertMember(
          { room_key: roomKey, user_id: userId, role: 'owner' },
          db
        )
      }
      return row
    })
    let historyBaseline = null
    if (history && typeof history.ensureHistoryBaseline === 'function') {
      historyBaseline = await history.ensureHistoryBaseline(roomKey, {
        reason: 'ROOM_INITIAL',
        createdBy: userId
      })
    }
    const nodes = await store.getNodes(roomKey)
    return {
      room: withAccess(
        {
          ...created,
          role: userId ? 'owner' : null,
          legacy_open: !userId,
          owner_user_id: userId,
          owner_name: userId
        },
        userId,
        !userId
      ),
      nodes,
      historyBaseline,
      rootValid: !!(nodes && nodes.root)
    }
  }

  function sortValue(row, sort) {
    if (sort === 'title') return String(row.title || '')
    if (sort === 'createdAt') return new Date(row.created_at).getTime()
    const stamp = row.content_updated_at || row.updated_at
    return new Date(stamp).getTime()
  }

  function applySort(rows, sort, order) {
    const dir = order === 'asc' ? 1 : -1
    return rows.sort((a, b) => {
      const av = sortValue(a, sort)
      const bv = sortValue(b, sort)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return String(a.room_key).localeCompare(String(b.room_key)) * dir
    })
  }

  async function listRooms(input = {}) {
    const userId = roomAcl.normalizeUserId(input.userId || '')
    const bypass = !!input.bypass || !userId
    const q = String(input.q || input.search || '').trim()
    const folderRaw = input.folderId
    const folderFilter =
      folderRaw === undefined || folderRaw === null || folderRaw === ''
        ? undefined
        : parseFolderId(folderRaw)
    const sort = ['title', 'createdAt', 'updatedAt'].includes(input.sort)
      ? input.sort
      : 'updatedAt'
    const order = String(input.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20))
    const offset = Math.max(0, Number(input.offset) || 0)
    if (store.kind === 'pg') {
      return listRoomsPg({
        userId,
        bypass,
        q,
        folderFilter,
        folderSpecified: folderRaw !== undefined && folderRaw !== null && folderRaw !== '',
        sort,
        order,
        limit,
        offset,
        cursor: input.cursor
      })
    }
    store.resetQueryCount && store.resetQueryCount()
    let rows = await store.listRooms({
      q,
      folderId: folderRaw !== undefined && folderRaw !== null && folderRaw !== ''
        ? folderFilter
        : undefined
    })
    const memberRows = await store.listMembersForRooms(rows.map(item => item.room_key))
    const byRoom = {}
    memberRows.forEach(item => {
      if (!byRoom[item.room_key]) byRoom[item.room_key] = []
      byRoom[item.room_key].push(item)
    })
    rows = rows.map(row => {
      const list = byRoom[row.room_key] || []
      const mine = userId ? list.find(item => item.user_id === userId) : null
      const owner = list.find(item => item.role === 'owner')
      return {
        ...row,
        role: mine ? mine.role : null,
        legacy_open: list.length === 0,
        owner_user_id: (owner && owner.user_id) || row.owner_id || '',
        owner_name: (owner && owner.user_id) || row.owner_id || ''
      }
    })
    if (!bypass) {
      rows = rows.filter(row => row.role || row.legacy_open)
    }
    rows = applySort(rows, sort, order)
    const total = rows.length
    let sliced = rows
    if (input.cursor) {
      const cur = decodeCursor(input.cursor)
      if (cur && cur.roomKey) {
        const idx = sliced.findIndex(item => item.room_key === cur.roomKey)
        sliced = idx >= 0 ? sliced.slice(idx + 1) : sliced
      }
    } else {
      sliced = sliced.slice(offset)
    }
    const page = sliced.slice(0, limit)
    const last = page[page.length - 1]
    return {
      list: page.map(row => withAccess(row, userId, bypass)),
      total,
      limit,
      offset,
      nextCursor: page.length === limit && last
        ? encodeCursor({ roomKey: last.room_key, sort })
        : null,
      queryCount: store.queryCount
    }
  }

  async function listRoomsPg(opts) {
    store.resetQueryCount && store.resetQueryCount()
    const params = []
    let where = 't.room_key is null'
    if (opts.q) {
      params.push('%' + opts.q.replace(/[%_\\]/g, ch => '\\' + ch) + '%')
      where += ` and r.title ilike $${params.length} escape '\\'`
    }
    if (opts.folderSpecified) {
      if (opts.folderFilter == null) {
        where += ' and r.folder_id is null'
      } else {
        params.push(opts.folderFilter)
        where += ` and r.folder_id = $${params.length}`
      }
    }
    let userParam = 0
    if (!opts.bypass && opts.userId) {
      params.push(opts.userId)
      userParam = params.length
      where += ` and (
        exists (
          select 1 from room_members m
          where m.room_key = r.room_key and m.user_id = $${userParam}
        )
        or not exists (
          select 1 from room_members m where m.room_key = r.room_key
        )
      )`
    }
    const orderSql =
      opts.sort === 'title'
        ? `lower(r.title) ${opts.order}, r.room_key ${opts.order}`
        : opts.sort === 'createdAt'
          ? `r.created_at ${opts.order}, r.room_key ${opts.order}`
          : `coalesce(r.content_updated_at, r.updated_at) ${opts.order}, r.room_key ${opts.order}`
    const countRes = await store.query(
      `select count(*)::int as total
       from rooms r
       left join room_tombstones t on t.room_key = r.room_key
       where ${where}`,
      params
    )
    const listParams = params.slice()
    listParams.push(opts.limit, opts.offset)
    const roleJoin = userParam
      ? `left join room_members my on my.room_key = r.room_key and my.user_id = $${userParam}`
      : ''
    const roleSelect = userParam
      ? `, my.role as role,
         (not exists (select 1 from room_members mx where mx.room_key = r.room_key)) as legacy_open`
      : `, null::text as role, true as legacy_open`
    const listRes = await store.query(
      `select r.room_key, r.title, r.folder_id, r.owner_id, r.version,
              r.created_at, r.updated_at, r.content_updated_at
              ${roleSelect},
              own.user_id as owner_user_id,
              coalesce(u.name, own.user_id, r.owner_id, '') as owner_name
       from rooms r
       left join room_tombstones t on t.room_key = r.room_key
       ${roleJoin}
       left join lateral (
         select user_id from room_members
         where room_key = r.room_key and role = 'owner'
         order by created_at asc
         limit 1
       ) own on true
       left join wecom_users u on u.user_id = own.user_id
       where ${where}
       order by ${orderSql}
       limit $${listParams.length - 1} offset $${listParams.length}`,
      listParams
    )
    const rows = listRes.rows
    const last = rows[rows.length - 1]
    return {
      list: rows.map(row => withAccess(row, opts.userId, opts.bypass)),
      total: Number((countRes.rows[0] && countRes.rows[0].total) || 0),
      limit: opts.limit,
      offset: opts.offset,
      nextCursor:
        rows.length === opts.limit && last
          ? encodeCursor({ roomKey: last.room_key, sort: opts.sort })
          : null,
      queryCount: store.queryCount
    }
  }

  async function getRoom(roomKey, input = {}) {
    const row = await store.getRoom(roomKey)
    if (!row) throw fsError('ROOM_NOT_FOUND', 'room not found', 404)
    const userId = roomAcl.normalizeUserId(input.userId || '')
    const bypass = !!input.bypass || !userId
    let role = null
    let legacyOpen = true
    if (store.kind === 'memory') {
      const members = await store.listMembersForRooms([roomKey])
      legacyOpen = members.length === 0
      const mine = members.find(item => item.user_id === userId)
      role = mine ? mine.role : null
      const owner = members.find(item => item.role === 'owner')
      row.owner_user_id = (owner && owner.user_id) || row.owner_id
      row.owner_name = row.owner_user_id
      row.role = role
      row.legacy_open = legacyOpen
    } else {
      const access = await roomAcl.getAccess(require('../storage').getPool(), roomKey, userId)
      role = access.role
      legacyOpen = access.legacyOpen
      row.role = role
      row.legacy_open = legacyOpen
      row.owner_user_id = row.owner_id
      row.owner_name = row.owner_id
    }
    if (!bypass && !role && !legacyOpen) {
      throw fsError('FORBIDDEN', '没有权限执行该操作', 403)
    }
    return withAccess(row, userId, bypass)
  }

  async function renameRoom(roomKey, title, input = {}) {
    const access = input.access
    if (access && !access.canEdit && !access.bypass) {
      throw fsError('FORBIDDEN', '没有权限执行该操作', 403)
    }
    const row = await store.updateTitle(roomKey, title)
    if (!row) throw fsError('ROOM_NOT_FOUND', 'room not found', 404)
    return publicFile({
      ...row,
      role: access && access.role,
      owner_user_id: row.owner_id
    }, access || {})
  }

  async function moveRoom(roomKey, targetFolderId, input = {}) {
    const access = input.access
    if (access && !access.canEdit && !access.bypass) {
      throw fsError('FORBIDDEN', '没有权限执行该操作', 403)
    }
    const folderId = parseFolderId(targetFolderId)
    if (folderId) await assertFolderExists(folderId)
    const before = await store.getRoom(roomKey)
    if (!before) throw fsError('ROOM_NOT_FOUND', 'room not found', 404)
    const moved = await store.updateFolder(roomKey, folderId)
    if (!moved || !moved.row) throw fsError('ROOM_NOT_FOUND', 'room not found', 404)
    return {
      file: publicFile(
        {
          ...moved.row,
          role: access && access.role,
          owner_user_id: moved.row.owner_id
        },
        access || {}
      ),
      roomKey: moved.row.room_key,
      versionBefore: Number(before.version || 0),
      versionAfter: Number(moved.row.version || 0),
      nodesBefore: input.captureNodes ? await Promise.resolve(moved.nodes) : null
    }
  }

  async function createFolder(input = {}) {
    const name = normalizeFolderName(input.name)
    const parentId = parseFolderId(input.parentId || input.parent_id)
    if (parentId) {
      throw fsError('INVALID_MOVE', 'first version only supports root folders', 400)
    }
    if (await store.folderNameTaken(name, null)) {
      throw fsError('FOLDER_NAME_CONFLICT', 'a folder with this name already exists', 409)
    }
    const row = await store.insertFolder({
      id: newFolderId(),
      parent_id: null,
      name,
      created_by: roomAcl.normalizeUserId(input.userId || '')
    })
    return publicFolder({ ...row, room_count: 0 })
  }

  async function listFolders(input = {}) {
    const userId = roomAcl.normalizeUserId(input.userId || '')
    const bypass = !!input.bypass || !userId
    const rows = await store.listFolders({ userId, bypass })
    let counts = {}
    if (store.kind === 'memory') counts = await store.roomCountsByFolder()
    let accessibleFolderIds = null
    if (!bypass && store.kind === 'memory') {
      const rooms = await store.listRooms({})
      const members = await store.listMembersForRooms(rooms.map(item => item.room_key))
      const mine = new Set(
        members.filter(item => item.user_id === userId).map(item => item.room_key)
      )
      accessibleFolderIds = new Set()
      rooms.forEach(room => {
        const list = members.filter(item => item.room_key === room.room_key)
        const allowed = mine.has(room.room_key) || list.length === 0
        if (allowed && room.folder_id) accessibleFolderIds.add(room.folder_id)
      })
    }
    const visible = rows.filter(row => {
      if (bypass || store.kind === 'pg') return true
      if (row.created_by === userId) return true
      return accessibleFolderIds && accessibleFolderIds.has(row.id)
    })
    return {
      list: visible.map(row =>
        publicFolder({
          ...row,
          room_count: row.room_count != null ? row.room_count : counts[row.id] || 0
        })
      )
    }
  }

  async function renameFolder(id, name, input = {}) {
    const folder = await store.getFolder(id)
    if (!folder) throw fsError('FOLDER_NOT_FOUND', 'folder not found', 404)
    const userId = roomAcl.normalizeUserId(input.userId || '')
    if (userId && folder.created_by && folder.created_by !== userId && !input.bypass) {
      throw fsError('FORBIDDEN', '没有权限执行该操作', 403)
    }
    const nextName = normalizeFolderName(name)
    if (await store.folderNameTaken(nextName, folder.parent_id || null, id)) {
      throw fsError('FOLDER_NAME_CONFLICT', 'a folder with this name already exists', 409)
    }
    const row = await store.updateFolderName(id, nextName)
    return publicFolder(row)
  }

  async function deleteFolder(id, input = {}) {
    const folder = await store.getFolder(id)
    if (!folder) throw fsError('FOLDER_NOT_FOUND', 'folder not found', 404)
    const userId = roomAcl.normalizeUserId(input.userId || '')
    if (userId && folder.created_by && folder.created_by !== userId && !input.bypass) {
      throw fsError('FORBIDDEN', '没有权限执行该操作', 403)
    }
    const count = await store.countRoomsInFolder(id)
    if (count > 0) {
      throw fsError('FOLDER_NOT_EMPTY', 'folder still contains rooms', 409)
    }
    await store.deleteFolder(id)
    return { ok: true, id }
  }

  return {
    store,
    createRoom,
    listRooms,
    getRoom,
    renameRoom,
    moveRoom,
    createFolder,
    listFolders,
    renameFolder,
    deleteFolder
  }
}

module.exports = { createFileSystem }
