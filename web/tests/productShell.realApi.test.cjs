const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const root = path.resolve(__dirname, '../src')
const repo = path.resolve(__dirname, '../..')
const cache = new Map()

function load(filename) {
  if (!filename.endsWith('.js')) filename += '.js'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  new Function('require', 'module', 'exports', code)(
    relative => load(path.resolve(path.dirname(filename), relative)),
    module,
    module.exports
  )
  return module.exports
}

const service = name => load(path.join(root, 'services', name)).default
const { setProductHttp } = load(path.join(root, 'services/productHttp'))
const { wrapHttpError } = load(path.join(root, 'services/apiError'))
const { normalizeRoomDto, folderIdForApi, isSharedWithMe } = load(
  path.join(root, 'services/roomDto')
)
const room = service('roomService')
const folder = service('folderService')
const history = service('historyService')
const share = service('shareService')
const team = service('teamService')
const { mockStore } = load(path.join(root, 'services/mockStore'))

function fail(code, status) {
  throw wrapHttpError({ code, error: code }, status)
}

function parseBody(options) {
  return options && options.body ? JSON.parse(options.body) : {}
}

function qs(path) {
  const url = new URL(path, 'http://local.test')
  return { pathname: url.pathname, search: url.searchParams }
}

async function main() {
  const calls = []
  const files = []
  const folders = []
  const versions = {}
  const members = {}
  let seq = 0
  const now = () => new Date().toISOString()

  setProductHttp(async (path, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase()
    calls.push({ method, path })
    const { pathname, search } = qs(path)
    const fileItem = pathname.match(/^\/api\/files\/([^/]+)$/)
    const fileInfo = pathname.match(/^\/api\/files\/([^/]+)\/info$/)
    const fileMove = pathname.match(/^\/api\/files\/([^/]+)\/move$/)
    const membersPath = pathname.match(/^\/api\/files\/([^/]+)\/members(?:\/([^/]+))?$/)
    const versionsPath = pathname.match(
      /^\/api\/files\/([^/]+)\/versions(?:\/([^/]+)(?:\/(tree|restore))?)?$/
    )
    const folderItem = pathname.match(/^\/api\/folders\/([^/]+)$/)

    if (method === 'GET' && pathname === '/api/files') {
      let list = files.slice()
      const folderId = search.has('folderId') ? search.get('folderId') : undefined
      if (folderId === 'root' || folderId === 'null')
        list = list.filter(item => !item.folderId)
      else if (folderId) list = list.filter(item => item.folderId === folderId)
      const q = search.get('q') || search.get('search') || ''
      if (q) list = list.filter(item => item.title.includes(q))
      const sort = search.get('sort') || 'updatedAt'
      const order = search.get('order') || 'desc'
      list.sort((a, b) => {
        const av = a[sort] || a.title
        const bv = b[sort] || b.title
        return order === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av))
      })
      const limit = Number(search.get('limit') || 50)
      const offset = Number(search.get('offset') || 0)
      const slice = list.slice(offset, offset + limit)
      return {
        list: slice,
        total: list.length,
        limit,
        offset,
        nextCursor: offset + slice.length < list.length ? 'next' : null
      }
    }

    if (method === 'POST' && pathname === '/api/files') {
      const body = parseBody(options)
      const roomKey = 'room-' + (++seq).toString(36)
      const row = {
        roomKey,
        title: body.title,
        folderId: body.folderId || null,
        owner: { userId: 'u-owner', name: 'owner' },
        role: 'owner',
        createdAt: now(),
        updatedAt: now(),
        contentUpdatedAt: now(),
        revision: 0,
        canView: true,
        canEdit: true,
        canManage: true
      }
      files.push(row)
      versions[roomKey] = []
      members[roomKey] = [
        { userId: 'u-owner', name: 'owner', role: 'owner' }
      ]
      return { room: row }
    }

    if (method === 'GET' && fileInfo) {
      const row = files.find(item => item.roomKey === decodeURIComponent(fileInfo[1]))
      if (!row) fail('ROOM_NOT_FOUND', 404)
      return { file: row }
    }

    if (method === 'PATCH' && fileItem) {
      const row = files.find(item => item.roomKey === decodeURIComponent(fileItem[1]))
      if (!row) fail('ROOM_NOT_FOUND', 404)
      const body = parseBody(options)
      if (Object.keys(body).some(key => key !== 'title')) fail('INVALID_MOVE', 400)
      row.title = body.title
      return { file: row }
    }

    if (method === 'POST' && fileMove) {
      const row = files.find(item => item.roomKey === decodeURIComponent(fileMove[1]))
      if (!row) fail('ROOM_NOT_FOUND', 404)
      const body = parseBody(options)
      row.folderId =
        body.folderId == null || body.folderId === 'root' ? null : body.folderId
      return { file: row }
    }

    if (method === 'DELETE' && fileItem) {
      fail('TRASH_BACKEND_PENDING', 501)
    }

    if (method === 'GET' && pathname === '/api/folders') {
      return {
        list: folders.map(item => ({
          ...item,
          roomCount: files.filter(file => file.folderId === item.id).length
        }))
      }
    }

    if (method === 'POST' && pathname === '/api/folders') {
      const body = parseBody(options)
      if (body.parentId) fail('INVALID_MOVE', 400)
      const row = {
        id: '11111111-1111-4111-8111-11111111111' + String(++seq).slice(-1),
        name: body.name,
        parentId: null,
        createdAt: now(),
        updatedAt: now()
      }
      folders.push(row)
      return { folder: row }
    }

    if (method === 'PATCH' && folderItem) {
      const row = folders.find(item => item.id === decodeURIComponent(folderItem[1]))
      if (!row) fail('FOLDER_NOT_FOUND', 404)
      row.name = parseBody(options).name
      return { folder: row }
    }

    if (method === 'DELETE' && folderItem) {
      const id = decodeURIComponent(folderItem[1])
      if (files.some(item => item.folderId === id)) fail('FOLDER_NOT_EMPTY', 409)
      const idx = folders.findIndex(item => item.id === id)
      if (idx < 0) fail('FOLDER_NOT_FOUND', 404)
      folders.splice(idx, 1)
      return { ok: true }
    }

    if (versionsPath) {
      const roomKey = decodeURIComponent(versionsPath[1])
      const versionId = versionsPath[2] ? decodeURIComponent(versionsPath[2]) : ''
      const extra = versionsPath[3]
      const actor = options.headers && options.headers['x-role']
      const file = files.find(item => item.roomKey === roomKey)
      if (!file) fail('ROOM_NOT_FOUND', 404)
      if (method === 'GET' && !versionId) {
        return {
          versions: versions[roomKey] || [],
          currentRevision: file.revision,
          viewingHistory: true
        }
      }
      if (method === 'POST' && !versionId) {
        if (file.role === 'viewer' || actor === 'viewer') fail('FORBIDDEN', 403)
        const body = parseBody(options)
        const row = {
          versionId: 'ver-' + ++seq,
          revision: file.revision,
          name: body.name,
          type: 'MANUAL',
          createdBy: 'u-owner',
          createdAt: now(),
          description: body.description || '',
          summary: { inserted: 0, updated: 0, deleted: 0 }
        }
        versions[roomKey].unshift(row)
        return { version: row }
      }
      if (method === 'GET' && versionId && !extra) {
        const row = (versions[roomKey] || []).find(item => item.versionId === versionId)
        if (!row) fail('VERSION_NOT_FOUND', 404)
        return { version: row }
      }
      if (method === 'GET' && extra === 'tree') {
        return { viewingHistory: true, readOnly: true, tree: { root: {} } }
      }
      if (method === 'POST' && extra === 'restore') {
        if (file.role !== 'owner' || actor === 'editor') fail('FORBIDDEN', 403)
        const body = parseBody(options)
        if (body.expectedCurrentRevision !== file.revision)
          fail('RESTORE_CONFLICT', 409)
        file.revision += 1
        return { ok: true, newRevision: file.revision, fullTreeReason: 'VERSION_RESTORE' }
      }
    }

    if (membersPath) {
      const roomKey = decodeURIComponent(membersPath[1])
      const userId = membersPath[2] ? decodeURIComponent(membersPath[2]) : ''
      if (method === 'GET' && !userId) return { list: members[roomKey] || [] }
      if (method === 'POST' && !userId) {
        const body = parseBody(options)
        const row = { userId: body.userId, name: body.userId, role: body.role }
        members[roomKey].push(row)
        return row
      }
      if (method === 'PATCH' && userId) {
        const row = members[roomKey].find(item => item.userId === userId)
        row.role = parseBody(options).role
        return row
      }
      if (method === 'DELETE' && userId) {
        members[roomKey] = members[roomKey].filter(item => item.userId !== userId)
        return { ok: true }
      }
    }

    fail('ROOM_NOT_FOUND', 404)
  })

  const listed0 = await room.listRooms({})
  assert.equal(listed0.list.length, 0)

  const created = await room.createRoom('验收脑图')
  assert.ok(created.roomKey.startsWith('room-'))
  assert.equal(created.id, created.roomKey)
  assert.equal(created.title, '验收脑图')
  const createdAgain = await room.createRoom('另一张')
  assert.notEqual(created.roomKey, createdAgain.roomKey)

  const listed = await room.listRooms({})
  assert.equal(listed.list.length, 2)
  assert.ok(!listed.list[0].nodes)

  const info = await room.getRoomInfo(created.roomKey)
  assert.equal(info.roomKey, created.roomKey)

  const renamed = await room.renameRoom(created.roomKey, '已重命名')
  assert.equal(renamed.title, '已重命名')
  assert.equal(renamed.roomKey, created.roomKey)

  const dir = await folder.createFolder('Q4')
  await folder.renameFolder(dir.id, 'Q4 SOP')
  const foldersListed = await folder.listFolders()
  assert.equal(foldersListed[0].name, 'Q4 SOP')

  await room.moveRoom(created.roomKey, dir.id)
  assert.equal((await room.getRoomInfo(created.roomKey)).folderId, dir.id)
  try {
    await folder.deleteFolder(dir.id)
    assert.fail('expected FOLDER_NOT_EMPTY')
  } catch (error) {
    assert.equal(error.code, 'FOLDER_NOT_EMPTY')
    assert.match(error.message, /请先移动脑图后再删除/)
  }

  const movedRoot = await room.moveRoom(created.roomKey, null)
  assert.equal(movedRoot.folderId, null)
  const moveCall = calls.filter(item => item.path.includes('/move')).pop()
  assert.match(moveCall.path, /\/move$/)
  assert.equal(folderIdForApi(null), 'root')

  await folder.deleteFolder(dir.id)

  await room.createRoom('搜索目标 Alpha')
  const searched = await room.listRooms({ q: 'Alpha' })
  assert.equal(searched.list.length, 1)

  const sorted = await room.listRooms({ sort: 'title', order: 'asc', limit: 10 })
  const titles = sorted.list.map(item => item.title)
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)))

  const page1 = await room.listRooms({ limit: 1, offset: 0 })
  const page2 = await room.listRooms({ limit: 1, offset: 1 })
  assert.equal(page1.list.length, 1)
  assert.notEqual(page1.list[0].roomKey, page2.list[0].roomKey)
  assert.equal(page1.total, files.length)

  const versionList = await history.listVersions(created.roomKey)
  assert.equal(versionList.list.length, 0)
  const manual = await history.createVersion(created.roomKey, { name: '上线前' })
  assert.equal(manual.name, '上线前')
  assert.equal(manual.type, 'MANUAL')
  const listedVersions = await history.listVersions(created.roomKey)
  assert.equal(listedVersions.list.length, 1)
  const detail = await history.getVersion(created.roomKey, manual.versionId)
  assert.equal(detail.versionId, manual.versionId)
  assert.ok(detail.viewingHistory)

  const restoreFn = String(history.restoreVersion)
  assert.doesNotMatch(restoreFn, /setData/)
  const restored = await history.restoreVersion(
    created.roomKey,
    manual.versionId,
    listedVersions.currentRevision
  )
  assert.equal(restored.fullTreeReason, 'VERSION_RESTORE')
  assert.doesNotMatch(JSON.stringify(calls), /setData/)

  files.find(item => item.roomKey === created.roomKey).role = 'viewer'
  await assert.rejects(
    history.createVersion(created.roomKey, { name: 'nope' }),
    err => err.statusCode === 403
  )
  files.find(item => item.roomKey === created.roomKey).role = 'editor'
  await assert.rejects(
    history.restoreVersion(created.roomKey, manual.versionId, 1),
    err => err.statusCode === 403
  )
  files.find(item => item.roomKey === created.roomKey).role = 'owner'

  const routerSrc = fs.readFileSync(path.join(root, 'router.js'), 'utf8')
  assert.match(routerSrc, /path: '\/files'/)
  assert.match(routerSrc, /path: 'folder\/:id'/)
  assert.match(routerSrc, /path: 'recent'/)
  assert.match(routerSrc, /path: 'favorites'/)
  assert.match(routerSrc, /path: 'shared'/)
  assert.match(routerSrc, /path: 'trash'/)
  assert.match(routerSrc, /path: '\/spaces'/)
  assert.match(routerSrc, /name: 'Edit'/)
  assert.doesNotMatch(routerSrc, /redirect: '\/files'/)
  assert.match(routerSrc, /room: to\.params\.roomKey/)

  const recentCalls = calls.length
  await room.listRooms({ recent: true })
  assert.equal(calls.length, recentCalls, 'Recent stays mock and must not hit /api/files')

  const favCalls = calls.length
  await room.toggleFavorite(created.roomKey)
  assert.equal(calls.length, favCalls, 'Favorite overlay must not PATCH rooms')
  assert.equal((await room.getRoomInfo(created.roomKey)).favorite, true)

  const beforeDelete = calls.slice()
  await assert.rejects(room.deleteRoom(created.roomKey), err => {
    return err.code === 'TRASH_BACKEND_PENDING'
  })
  assert.ok(
    !calls
      .slice(beforeDelete.length)
      .some(item => item.method === 'DELETE' && item.path.includes('/api/files/')),
    'Trash must not call real DELETE'
  )

  const teamCalls = calls.length
  await team.listSpaces()
  assert.equal(calls.length, teamCalls)

  const added = await share.addMember(created.roomKey, 'u-editor', 'Editor')
  assert.equal(added.role, 'Editor')
  await share.updateMemberRole(created.roomKey, 'u-editor', 'Viewer')
  await share.removeMember(created.roomKey, 'u-editor')

  const dto = normalizeRoomDto({
    roomKey: 'room-x',
    title: 't',
    folderId: null,
    role: 'owner',
    owner: { userId: 'me' },
    canView: true,
    canEdit: true,
    canManage: true
  }, { currentUserId: 'me' })
  assert.equal(dto.id, 'room-x')
  assert.equal(dto.favorite, false)
  assert.equal(dto.sharedWithMe, false)
  assert.ok(!('lastOpenedAt' in dto) || dto.lastOpenedAt == null)

  assert.equal(
    isSharedWithMe({
      role: 'owner',
      ownerUserId: 'me',
      currentUserId: 'me'
    }),
    false
  )
  assert.equal(
    normalizeRoomDto(
      { role: 'editor', owner: { userId: 'other' } },
      { currentUserId: 'me' }
    ).sharedWithMe,
    true
  )
  assert.equal(
    normalizeRoomDto(
      { role: 'viewer', owner: { userId: 'other' } },
      { currentUserId: 'me' }
    ).sharedWithMe,
    true
  )
  assert.equal(
    normalizeRoomDto(
      { role: 'editor', owner: {} },
      { currentUserId: 'me' }
    ).sharedWithMe,
    false
  )
  assert.equal(
    normalizeRoomDto(
      { role: 'editor', owner: { userId: 'ghost' }, legacyOpen: true },
      { currentUserId: 'me' }
    ).sharedWithMe,
    false
  )

  const schemaSrc =
    fs.readFileSync(path.join(repo, 'simple-mind-map/bin/storage.js'), 'utf8') +
    fs.readFileSync(path.join(repo, 'simple-mind-map/bin/fileSystem/schema.js'), 'utf8')
  assert.doesNotMatch(schemaSrc, /CREATE TABLE\s+files\b/i)
  assert.doesNotMatch(schemaSrc, /file_permissions|share_permissions/i)
  assert.doesNotMatch(schemaSrc, /CREATE TABLE\s+mind_maps\b/i)

  const historySrc = fs.readFileSync(
    path.join(root, 'services/historyService.js'),
    'utf8'
  )
  assert.doesNotMatch(historySrc, /setData/)
  assert.match(historySrc, /expectedCurrentRevision/)

  const pages = fs.readFileSync(
    path.join(root, 'pages/ProductShell/FilesPage.vue'),
    'utf8'
  )
  assert.doesNotMatch(pages, /axios|fetch\(/)

  assert.equal(mockStore.rooms.some(item => item.roomKey === created.roomKey), false)

  console.log('Product shell real API integration coverage passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
