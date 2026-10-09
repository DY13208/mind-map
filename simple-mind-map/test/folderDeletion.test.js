const test = require('node:test')
const assert = require('node:assert/strict')
const { createFileSystem, createMemoryFileStore, handleFileSystemApi } = require('../bin/fileSystem')

async function fixture() {
  const store = createMemoryFileStore()
  const fs = createFileSystem({ store })
  const source = await fs.createFolder({ name: 'source', userId: 'owner' })
  const child = await fs.createFolder({ name: 'child', parentId: source.id, userId: 'owner' })
  const target = await fs.createFolder({ name: 'target', userId: 'owner' })
  const direct = await fs.createRoom({ title: 'direct', folderId: source.id, userId: 'owner' })
  const nested = await fs.createRoom({ title: 'nested', folderId: child.id, userId: 'owner' })
  return { fs, store, source, child, target, direct: direct.room.roomKey, nested: nested.room.roomKey }
}
const rejected = code => err => err.code === code
const input = (preview, action, extra = {}) => ({ userId: 'owner', action, revision: preview.revision, ...extra })

test('preview counts the entire subtree without writing; foreign users cannot inspect it', async () => {
  const f = await fixture()
  const before = JSON.stringify([...f.store.folders])
  const preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  assert.equal(preview.roomCount, 2)
  assert.equal(preview.folderCount, 1)
  assert.equal(preview.canTrash, true)
  assert.equal(JSON.stringify([...f.store.folders]), before)
  await assert.rejects(f.fs.previewFolderDeletion(f.source.id, { userId: 'other' }), rejected('FORBIDDEN'))
})

test('move preserves nested folders, content/version and direct grants, replaces root folder grants', async () => {
  const f = await fixture()
  await f.store.insertMember({ room_key: f.direct, user_id: 'old', role: 'viewer', source: 'folder', source_folder_id: f.source.id })
  await f.store.insertMember({ room_key: f.direct, user_id: 'old', role: 'editor' })
  await f.store.setFolderMember(f.target.id, 'new', 'viewer')
  const graph = await f.store.getNodes(f.direct)
  const preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  const result = await f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: f.target.id }))
  assert.deepEqual(result.deletedFolderIds, [f.source.id])
  assert.equal(await f.store.getFolder(f.source.id), null)
  assert.equal((await f.store.getFolder(f.child.id)).parent_id, f.target.id)
  assert.equal((await f.store.getRoom(f.direct)).folder_id, f.target.id)
  assert.equal((await f.store.getRoom(f.nested)).folder_id, f.child.id)
  assert.deepEqual(await f.store.getNodes(f.direct), graph)
  assert.equal((await f.store.getRoom(f.direct)).version, 0)
  const old = f.store.members.find(m => m.user_id === 'old')
  assert.equal(old.direct_role, 'editor')
  assert.equal(old.folder_role, null)
  assert.equal(f.store.members.find(m => m.user_id === 'new').source_folder_id, f.target.id)
})

test('trash includes nested maps, preserves data and allows restoration to root', async () => {
  const f = await fixture()
  const graph = await f.store.getNodes(f.nested)
  const preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  await f.fs.deleteFolderContents(f.source.id, input(preview, 'trash'))
  assert.equal(await f.store.getFolder(f.child.id), null)
  for (const key of [f.direct, f.nested]) {
    const room = await f.store.getRoom(key)
    assert.ok(room.deleted_at)
    assert.equal(room.folder_id, null)
    assert.equal(room.deleted_by, 'owner')
  }
  assert.deepEqual(await f.store.getNodes(f.nested), graph)
  await f.fs.restoreRoom(f.nested, { userId: 'owner', access: { canManage: true } })
  assert.equal((await f.store.getRoom(f.nested)).folder_id, null)
  assert.equal((await f.store.getRoom(f.nested)).deleted_at, null)
})

test('reject stale preview, descendants, cross-space targets, unwritable targets and name conflicts without mutation', async () => {
  const f = await fixture()
  let preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  await f.fs.createRoom({ userId: 'owner', folderId: f.source.id })
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'trash')), rejected('FOLDER_CONTENTS_CHANGED'))
  preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  for (const id of [f.source.id, f.child.id]) {
    await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: id })), rejected('INVALID_MOVE'))
  }
  const foreign = await f.fs.createFolder({ name: 'foreign', userId: 'other' })
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: foreign.id })), rejected('FORBIDDEN'))
  const team = await f.fs.createFolder({ name: 'team', userId: 'owner', teamId: 'team-a', bypass: true })
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: team.id })), rejected('FOLDER_TEAM_MISMATCH'))
  await f.fs.createFolder({ name: 'child', userId: 'owner', parentId: f.target.id })
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: f.target.id })), rejected('FOLDER_NAME_CONFLICT'))
  assert.ok(await f.store.getFolder(f.source.id))
  assert.equal((await f.store.getRoom(f.direct)).folder_id, f.source.id)
})

test('partial ownership cannot authorize deletion of others maps; team scope is rechecked', async () => {
  const f = await fixture()
  f.store.rooms.get(f.nested).owner_id = 'other'
  f.store.members.find(m => m.room_key === f.nested && m.user_id === 'owner').role = 'editor'
  const preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  assert.equal(preview.canTrash, false)
  assert.equal(preview.canMove, true)
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'trash')), rejected('FORBIDDEN'))
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'trash', { bypass: true, teamId: 'different-team' })), rejected('FOLDER_NOT_FOUND'))
  assert.equal((await f.store.getRoom(f.direct)).deleted_at, null)
})

test('transaction failure rolls back moves and ACL changes; root destination works', async () => {
  const f = await fixture()
  await f.store.insertMember({ room_key: f.direct, user_id: 'old', role: 'viewer', source: 'folder', source_folder_id: f.source.id })
  await f.store.setFolderMember(f.target.id, 'new', 'viewer')
  const preview = await f.fs.previewFolderDeletion(f.source.id, { userId: 'owner' })
  const finish = f.store.finishFolderDeletion
  f.store.finishFolderDeletion = async function (...args) {
    await finish.apply(this, args)
    throw new Error('injected failure')
  }
  await assert.rejects(f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: f.target.id })), /injected failure/)
  assert.ok(await f.store.getFolder(f.source.id))
  assert.equal((await f.store.getFolder(f.child.id)).parent_id, f.source.id)
  assert.equal((await f.store.getRoom(f.direct)).folder_id, f.source.id)
  assert.equal(f.store.members.find(m => m.user_id === 'old').source_folder_id, f.source.id)
  assert.equal(f.store.members.find(m => m.user_id === 'new'), undefined)
  f.store.finishFolderDeletion = finish
  await f.fs.deleteFolderContents(f.source.id, input(preview, 'move', { targetFolderId: null }))
  assert.equal((await f.store.getRoom(f.direct)).folder_id, null)
  assert.equal((await f.store.getFolder(f.child.id)).parent_id, null)
})

test('HTTP preview and confirmation route use authenticated actor instead of body identity', async () => {
  const f = await fixture()
  const res = () => ({ writeHead(code) { this.code = code }, end(body) { this.body = JSON.parse(body) } })
  const url = '/api/folders/' + f.source.id + '/deletion'
  const previewRes = res()
  await handleFileSystemApi({ method: 'GET', url, authUser: { id: 'owner' } }, previewRes, { engine: f.fs })
  assert.equal(previewRes.code, 200)
  const result = res()
  await handleFileSystemApi({ method: 'POST', url, authUser: { id: 'owner' } }, result, {
    engine: f.fs, body: { action: 'trash', revision: previewRes.body.revision, userId: 'other' }
  })
  assert.equal(result.code, 200)
  assert.equal((await f.store.getRoom(f.direct)).deleted_by, 'owner')
})

test('team deletion routes require team management and reject a folder outside that team', async () => {
  const teamSpace = require('../bin/teamSpace')
  const store = createMemoryFileStore()
  const fs = createFileSystem({ store })
  const folder = await fs.createFolder({ name: 'team folder', teamId: 'team-a', userId: 'owner', bypass: true })
  const room = await fs.createRoom({ title: 'team map', folderId: folder.id, teamId: 'team-a', userId: 'other', bypass: true })
  let role = 'member'
  const db = { query: async () => ({ rows: [{ id: 'team-a', role, corp_id: 'corp-a' }] }) }
  const run = async (method, body = {}, team = 'team-a') => {
    const res = {}
    await teamSpace.handleApi({ method, url: `/api/teams/${team}/folders/${folder.id}/deletion`, authUser: { id: 'owner', corpId: 'corp-a' } }, res, {
      db, fileSystem: fs, readBody: async () => body,
      sendJson: (r, code, result) => { r.code = code; r.body = result }
    })
    return res
  }
  assert.equal((await run('GET')).code, 403)
  role = 'admin'
  assert.equal((await run('GET', {}, 'team-other')).code, 404)
  const preview = await run('GET')
  assert.equal(preview.code, 200)
  assert.equal(preview.body.canTrash, true)
  const deleted = await run('POST', { action: 'trash', revision: preview.body.revision, userId: 'forged', bypass: false })
  assert.equal(deleted.code, 200)
  assert.equal((await store.getRoom(room.room.roomKey)).deleted_by, 'owner')
})
