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
  console.log('fileSystem.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
