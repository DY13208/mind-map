const assert = require('assert')
const { validateNodeGraph } = require('../bin/roomNodes')
const {
  createFileSystem,
  createMemoryFileStore,
  handleFileSystemApi
} = require('../bin/fileSystem')
const { handleHistoryApi } = require('../bin/collabHistory/http')

const OWNER = 'owner-1'
const EDITOR = 'editor-1'
const VIEWER = 'viewer-1'
const OTHER = 'other-9'

function engineWith(history) {
  const store = createMemoryFileStore()
  const calls = []
  const fs = createFileSystem({
    store,
    history: history || {
      async ensureHistoryBaseline(roomKey, input) {
        calls.push({ roomKey, reason: input && input.reason })
        return { reason: 'ROOM_INITIAL', revision: 0, room_key: roomKey }
      }
    }
  })
  return { fs, store, historyCalls: calls }
}

function mockRes() {
  return {
    code: 0,
    body: null,
    writeHead(code) {
      this.code = code
    },
    end(buf) {
      this.body = JSON.parse(String(buf || '{}'))
    }
  }
}

;(async () => {
  const { fs, store, historyCalls } = engineWith()

  const created = await fs.createRoom({ title: '  销售流程  ', userId: OWNER })
  assert.strictEqual(created.room.title, '销售流程')
  assert.ok(created.room.roomKey)
  assert.strictEqual(created.room.role, 'owner')
  assert.strictEqual(created.room.folderId, null)
  assert.ok(created.nodes.root)
  assert.strictEqual(created.nodes.root.data.uid, 'root')
  const graphOk = validateNodeGraph(created.nodes)
  assert.strictEqual(graphOk.ok, true)
  assert.strictEqual(created.historyBaseline.reason, 'ROOM_INITIAL')
  assert.strictEqual(historyCalls.length, 1)
  const members = store.members.filter(item => item.room_key === created.room.roomKey)
  assert.strictEqual(members.length, 1)
  assert.strictEqual(members[0].user_id, OWNER)
  assert.strictEqual(members[0].role, 'owner')
  assert.strictEqual(Number(store.rooms.get(created.room.roomKey).version), 0)

  await fs.createRoom({ title: 'Alpha', userId: OWNER })
  await fs.createRoom({ title: 'Beta Map', userId: OWNER })

  let nodesReads = 0
  const origNodes = store.getNodes.bind(store)
  store.getNodes = async function () {
    nodesReads += 1
    return origNodes.apply(this, arguments)
  }
  store.resetQueryCount()
  const listed = await fs.listRooms({ userId: OWNER, sort: 'updatedAt', limit: 2 })
  assert.ok(listed.list.length <= 2)
  assert.ok(listed.total >= 3)
  assert.ok(listed.nextCursor)
  assert.strictEqual(nodesReads, 0)
  assert.ok(listed.queryCount <= 4)
  listed.list.forEach(item => {
    assert.strictEqual(item.nodes, undefined)
    assert.ok(item.roomKey)
    assert.ok(item.title)
  })

  const page2 = await fs.listRooms({
    userId: OWNER,
    sort: 'updatedAt',
    limit: 2,
    cursor: listed.nextCursor
  })
  assert.ok(page2.list.length >= 1)

  const byTitle = await fs.listRooms({
    userId: OWNER,
    sort: 'title',
    order: 'asc',
    limit: 50
  })
  const titles = byTitle.list.map(item => item.title)
  const sorted = titles.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  assert.deepStrictEqual(titles, sorted)

  const searched = await fs.listRooms({ userId: OWNER, q: '销售', limit: 50 })
  assert.ok(searched.list.some(item => item.title === '销售流程'))
  assert.ok(searched.list.every(item => /销售/.test(item.title)))

  const hidden = await fs.createRoom({ title: 'secret', userId: OTHER })
  const ownerList = await fs.listRooms({ userId: OWNER, limit: 100 })
  assert.ok(!ownerList.list.some(item => item.roomKey === hidden.room.roomKey))

  const renamed = await fs.renameRoom(created.room.roomKey, '2026销售流程', {
    access: { canEdit: true, role: 'editor' }
  })
  assert.strictEqual(renamed.title, '2026销售流程')
  assert.strictEqual(renamed.roomKey, created.room.roomKey)
  let viewerDenied = ''
  try {
    await fs.renameRoom(created.room.roomKey, 'nope', {
      access: { canEdit: false, role: 'viewer' }
    })
  } catch (err) {
    viewerDenied = err.code
  }
  assert.strictEqual(viewerDenied, 'FORBIDDEN')

  let badName = ''
  try {
    await fs.createFolder({ name: '   ', userId: OWNER })
  } catch (err) {
    badName = err.code
  }
  assert.strictEqual(badName, 'INVALID_FOLDER_NAME')

  const folder = await fs.createFolder({ name: 'Q4', userId: OWNER })
  assert.strictEqual(folder.parentId, null)
  const folders = await fs.listFolders({ userId: OWNER })
  assert.ok(folders.list.some(item => item.name === 'Q4'))

  let nested = ''
  try {
    await fs.createFolder({
      name: 'child',
      parentId: folder.id,
      userId: OWNER
    })
  } catch (err) {
    nested = err.code
  }
  assert.strictEqual(nested, 'INVALID_MOVE')

  const renamedFolder = await fs.renameFolder(folder.id, 'Q4 SOP', { userId: OWNER })
  assert.strictEqual(renamedFolder.name, 'Q4 SOP')

  const versionBefore = store.rooms.get(created.room.roomKey).version
  const nodesBefore = JSON.stringify(store.nodes.get(created.room.roomKey))
  const opsBefore = store.operations.length
  const moved = await fs.moveRoom(created.room.roomKey, folder.id, {
    access: { canEdit: true, role: 'owner' }
  })
  assert.strictEqual(moved.roomKey, created.room.roomKey)
  assert.strictEqual(moved.file.folderId, folder.id)
  assert.strictEqual(Number(store.rooms.get(created.room.roomKey).version), versionBefore)
  assert.strictEqual(JSON.stringify(store.nodes.get(created.room.roomKey)), nodesBefore)
  assert.strictEqual(store.operations.length, opsBefore)

  const back = await fs.moveRoom(created.room.roomKey, 'root', {
    access: { canEdit: true, role: 'owner' }
  })
  assert.strictEqual(back.file.folderId, null)

  await fs.moveRoom(created.room.roomKey, folder.id, {
    access: { canEdit: true, role: 'owner' }
  })
  let notEmpty = ''
  try {
    await fs.deleteFolder(folder.id, { userId: OWNER })
  } catch (err) {
    notEmpty = err.code
  }
  assert.strictEqual(notEmpty, 'FOLDER_NOT_EMPTY')

  const oldRoom = await fs.createRoom({ title: 'legacy', userId: OWNER })
  assert.strictEqual(oldRoom.room.folderId, null)
  const rootList = await fs.listRooms({
    userId: OWNER,
    folderId: 'root',
    limit: 100
  })
  assert.ok(rootList.list.some(item => item.roomKey === oldRoom.room.roomKey))
  assert.ok(!rootList.list.some(item => item.roomKey === created.room.roomKey))

  store.members.push({
    room_key: created.room.roomKey,
    user_id: VIEWER,
    role: 'viewer',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })
  const shared = await fs.listRooms({ userId: VIEWER, limit: 100 })
  assert.ok(shared.list.some(item => item.roomKey === created.room.roomKey))
  const sharedFolders = await fs.listFolders({ userId: VIEWER })
  assert.ok(sharedFolders.list.some(item => item.id === folder.id))

  store.members.push({
    room_key: created.room.roomKey,
    user_id: EDITOR,
    role: 'editor',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })
  const editorRename = await fs.renameRoom(created.room.roomKey, '编辑可改名', {
    access: { canEdit: true, canManage: false, role: 'editor' }
  })
  assert.strictEqual(editorRename.title, '编辑可改名')

  const emptyFolder = await fs.createFolder({ name: 'empty-bin', userId: OWNER })
  const deleted = await fs.deleteFolder(emptyFolder.id, { userId: OWNER })
  assert.strictEqual(deleted.ok, true)

  const http = engineWith()
  const createdHttp = await http.fs.createRoom({ title: 'http', userId: OWNER })
  const resList = mockRes()
  await handleFileSystemApi(
    { method: 'GET', url: '/api/files?limit=10', authUser: { id: OWNER } },
    resList,
    { engine: http.fs }
  )
  assert.strictEqual(resList.code, 200)
  assert.ok(Array.isArray(resList.body.list))

  const resRename = mockRes()
  await handleFileSystemApi(
    {
      method: 'PATCH',
      url: `/api/files/${createdHttp.room.roomKey}`,
      authUser: { id: OWNER },
      roomAccess: { canEdit: true, role: 'owner' }
    },
    resRename,
    { engine: http.fs, body: { title: 'http-renamed' } }
  )
  assert.strictEqual(resRename.code, 200)
  assert.strictEqual(resRename.body.file.title, 'http-renamed')

  assert.strictEqual(typeof handleHistoryApi, 'function')

  const c1 = engineWith()
  const owned = await c1.fs.createRoom({ title: 'c1-owned', userId: OWNER })
  await c1.store.insertMember({
    room_key: owned.room.roomKey,
    user_id: EDITOR,
    role: 'editor'
  })
  await c1.store.insertMember({
    room_key: owned.room.roomKey,
    user_id: VIEWER,
    role: 'viewer'
  })
  const otherUser = await c1.fs.createRoom({ title: 'c1-other', userId: OTHER })

  await c1.fs.setFavorite(owned.room.roomKey, OWNER, true)
  const ownerFav = await c1.fs.listFavorites({ userId: OWNER, limit: 50 })
  const editorFav = await c1.fs.listFavorites({ userId: EDITOR, limit: 50 })
  const otherFav = await c1.fs.listFavorites({ userId: OTHER, limit: 50 })
  assert.ok(ownerFav.list.some(item => item.roomKey === owned.room.roomKey))
  assert.ok(!editorFav.list.some(item => item.roomKey === owned.room.roomKey))
  assert.ok(!otherFav.list.some(item => item.roomKey === owned.room.roomKey))
  let favAcl = ''
  try {
    await c1.fs.setFavorite(owned.room.roomKey, OTHER, true)
  } catch (err) {
    favAcl = err.code
  }
  assert.strictEqual(favAcl, 'FORBIDDEN')

  const stateBeforeList = c1.store.userState.size
  await c1.fs.listRooms({ userId: OWNER, q: 'c1', limit: 50 })
  assert.strictEqual(c1.store.userState.size, stateBeforeList)
  const recentBeforeOpen = await c1.fs.listRecent({ userId: OWNER, limit: 50 })
  assert.ok(!recentBeforeOpen.list.some(item => item.roomKey === owned.room.roomKey))
  await c1.fs.recordRoomOpened(owned.room.roomKey, OWNER)
  const ownerRecent = await c1.fs.listRecent({ userId: OWNER, limit: 50 })
  const editorRecent = await c1.fs.listRecent({ userId: EDITOR, limit: 50 })
  assert.ok(ownerRecent.list.some(item => item.roomKey === owned.room.roomKey))
  assert.ok(!editorRecent.list.some(item => item.roomKey === owned.room.roomKey))

  let editorTrash = ''
  try {
    await c1.fs.trashRoom(owned.room.roomKey, {
      access: { canManage: false, canEdit: true, role: 'editor' },
      userId: EDITOR
    })
  } catch (err) {
    editorTrash = err.code
  }
  assert.strictEqual(editorTrash, 'FORBIDDEN')
  let viewerTrash = ''
  try {
    await c1.fs.trashRoom(owned.room.roomKey, {
      access: { canManage: false, role: 'viewer' },
      userId: VIEWER
    })
  } catch (err) {
    viewerTrash = err.code
  }
  assert.strictEqual(viewerTrash, 'FORBIDDEN')

  const folderHome = await c1.fs.createFolder({ name: 'c1-home', userId: OWNER })
  await c1.fs.moveRoom(owned.room.roomKey, folderHome.id, {
    access: { canEdit: true, canManage: true, role: 'owner' }
  })
  const c1VersionBefore = Number(c1.store.rooms.get(owned.room.roomKey).version)
  const c1NodesBefore = JSON.stringify(c1.store.nodes.get(owned.room.roomKey))
  const c1OpsBefore = c1.store.operations.length
  const historyBefore = c1.historyCalls.length
  const trashed = await c1.fs.trashRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  assert.strictEqual(trashed.file.roomKey, owned.room.roomKey)
  assert.ok(trashed.file.deletedAt)
  assert.strictEqual(Number(c1.store.rooms.get(owned.room.roomKey).version), c1VersionBefore)
  assert.strictEqual(JSON.stringify(c1.store.nodes.get(owned.room.roomKey)), c1NodesBefore)
  assert.strictEqual(c1.store.operations.length, c1OpsBefore)
  assert.strictEqual(c1.historyCalls.length, historyBefore)
  assert.strictEqual(c1.store.rooms.get(owned.room.roomKey).folder_id, null)
  assert.ok(c1.store.nodes.get(owned.room.roomKey).root)

  const filesList = await c1.fs.listRooms({ userId: OWNER, limit: 100 })
  assert.ok(!filesList.list.some(item => item.roomKey === owned.room.roomKey))
  const favHidden = await c1.fs.listFavorites({ userId: OWNER, limit: 50 })
  assert.ok(!favHidden.list.some(item => item.roomKey === owned.room.roomKey))
  const recentHidden = await c1.fs.listRecent({ userId: OWNER, limit: 50 })
  assert.ok(!recentHidden.list.some(item => item.roomKey === owned.room.roomKey))
  const trashList = await c1.fs.listTrash({ userId: OWNER, limit: 50 })
  assert.ok(trashList.list.some(item => item.roomKey === owned.room.roomKey))
  const editorTrashList = await c1.fs.listTrash({ userId: EDITOR, limit: 50 })
  assert.ok(!editorTrashList.list.some(item => item.roomKey === owned.room.roomKey))

  let openTrashed = ''
  try {
    await c1.fs.getRoom(owned.room.roomKey, { userId: OWNER })
  } catch (err) {
    openTrashed = err.code
  }
  assert.strictEqual(openTrashed, 'ROOM_TRASHED')

  let livePermanent = ''
  try {
    await c1.fs.permanentDeleteRoom(otherUser.room.roomKey, {
      access: { canManage: true, role: 'owner' },
      userId: OTHER
    })
  } catch (err) {
    livePermanent = err.code
  }
  assert.strictEqual(livePermanent, 'ROOM_NOT_TRASHED')

  const restored = await c1.fs.restoreRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  assert.strictEqual(restored.roomKey, owned.room.roomKey)
  assert.strictEqual(restored.folderId, folderHome.id)
  const favVisible = await c1.fs.listFavorites({ userId: OWNER, limit: 50 })
  const recentVisible = await c1.fs.listRecent({ userId: OWNER, limit: 50 })
  assert.ok(favVisible.list.some(item => item.roomKey === owned.room.roomKey))
  assert.ok(recentVisible.list.some(item => item.roomKey === owned.room.roomKey))

  await c1.fs.trashRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  await c1.fs.deleteFolder(folderHome.id, { userId: OWNER })
  const restoredRoot = await c1.fs.restoreRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  assert.strictEqual(restoredRoot.folderId, null)

  await c1.fs.trashRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  await c1.fs.permanentDeleteRoom(owned.room.roomKey, {
    access: { canManage: true, role: 'owner' },
    userId: OWNER
  })
  assert.strictEqual(c1.store.rooms.has(owned.room.roomKey), false)
  assert.strictEqual(c1.store.nodes.has(owned.room.roomKey), false)
  assert.ok(!c1.store.members.some(item => item.room_key === owned.room.roomKey))
  assert.ok(
    ![...c1.store.userState.keys()].some(key =>
      key.startsWith(owned.room.roomKey + '\0')
    )
  )

  const httpC1 = engineWith()
  const httpRoom = await httpC1.fs.createRoom({ title: 'http-c1', userId: OWNER })
  const resFav = mockRes()
  await handleFileSystemApi(
    {
      method: 'POST',
      url: `/api/files/${httpRoom.room.roomKey}/favorite`,
      authUser: { id: OWNER }
    },
    resFav,
    { engine: httpC1.fs }
  )
  assert.strictEqual(resFav.code, 200)
  assert.strictEqual(resFav.body.file.favorite, true)
  const resFavList = mockRes()
  await handleFileSystemApi(
    { method: 'GET', url: '/api/files/favorites', authUser: { id: OWNER } },
    resFavList,
    { engine: httpC1.fs }
  )
  assert.ok(resFavList.body.list.some(item => item.roomKey === httpRoom.room.roomKey))
  const resOpen = mockRes()
  await handleFileSystemApi(
    {
      method: 'POST',
      url: `/api/files/${httpRoom.room.roomKey}/open`,
      authUser: { id: OWNER }
    },
    resOpen,
    { engine: httpC1.fs }
  )
  assert.ok(resOpen.body.file.lastOpenedAt)
  const resTrash = mockRes()
  await handleFileSystemApi(
    {
      method: 'POST',
      url: `/api/files/${httpRoom.room.roomKey}/trash`,
      authUser: { id: OWNER },
      roomAccess: { canManage: true, role: 'owner' }
    },
    resTrash,
    { engine: httpC1.fs }
  )
  assert.strictEqual(resTrash.code, 200)
  const resFiles = mockRes()
  await handleFileSystemApi(
    { method: 'GET', url: '/api/files?limit=50', authUser: { id: OWNER } },
    resFiles,
    { engine: httpC1.fs }
  )
  assert.ok(!resFiles.body.list.some(item => item.roomKey === httpRoom.room.roomKey))
  const resTrashList = mockRes()
  await handleFileSystemApi(
    { method: 'GET', url: '/api/files/trash', authUser: { id: OWNER } },
    resTrashList,
    { engine: httpC1.fs }
  )
  assert.ok(resTrashList.body.list.some(item => item.roomKey === httpRoom.room.roomKey))

  console.log('fileSystem.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
