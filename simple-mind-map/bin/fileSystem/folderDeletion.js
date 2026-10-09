const { createHash } = require('crypto')
const roomAcl = require('../roomAcl')
const { fsError, parseFolderId } = require('./model')

function createFolderDeletion(store, notifyStorage) {
  function revisionOf(contents) {
    const folders = contents.folders.map(f => [f.id, f.parent_id, f.name, f.created_by, f.team_id])
    const rooms = contents.rooms.map(r => [r.room_key, r.folder_id, r.owner_id])
    return createHash('sha256').update(JSON.stringify([
      folders.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      rooms.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ])).digest('hex')
  }

  async function inspect(id, input, db) {
    const contents = await store.getFolderDeletionContents(id, db)
    const root = contents.folders.find(f => f.id === id && !f.deleted_at)
    if (!root) throw fsError('FOLDER_NOT_FOUND', '找不到该文件夹', 404)
    if (input.teamId !== undefined && String(root.team_id || '') !== String(input.teamId || '')) {
      throw fsError('FOLDER_NOT_FOUND', '找不到该空间中的文件夹', 404)
    }
    const userId = roomAcl.normalizeUserId(input.userId || '')
    const bypass = !!input.bypass
    // Keep the existing folder deletion boundary: personal owner or team API.
    if (!bypass && (root.team_id || !userId || root.created_by !== userId)) {
      throw fsError('FORBIDDEN', '没有权限删除该文件夹', 403)
    }
    if (contents.folders.some(f => (f.team_id || null) !== (root.team_id || null)) ||
        contents.rooms.some(r => (r.team_id || null) !== (root.team_id || null))) {
      throw fsError('FOLDER_TEAM_MISMATCH', '文件夹内容不属于同一空间', 409)
    }
    const allowed = (room, action) => {
      if (bypass || room.owner_id === userId) return true
      const member = contents.members.find(m => m.room_key === room.room_key && m.user_id === userId)
      return roomAcl.roleAllows(member && member.role, action)
    }
    const canMove = contents.rooms.filter(r => r.folder_id === id).every(r => allowed(r, 'edit'))
    const canTrash = (bypass || contents.folders.every(f => f.created_by === userId)) &&
      contents.rooms.every(r => allowed(r, 'manage'))
    return { contents, root, userId, bypass, preview: {
      ok: true, folderId: id, roomCount: contents.rooms.length,
      folderCount: contents.folders.length - 1, canMove, canTrash,
      excludedFolderIds: contents.folders.map(f => f.id), revision: revisionOf(contents)
    } }
  }

  async function preview(id, input = {}) {
    return (await inspect(id, input)).preview
  }

  async function execute(id, input = {}) {
    if (!['move', 'trash', 'empty'].includes(input.action) || !input.revision) {
      throw fsError('BAD_REQUEST', '请先查看文件夹内容并选择处理方式', 400)
    }
    if (input.action === 'move' && !Object.prototype.hasOwnProperty.call(input, 'targetFolderId')) {
      throw fsError('BAD_REQUEST', '请选择移动目标', 400)
    }
    const result = await store.withTx(async db => {
      const state = await inspect(id, input, db)
      const { contents, root, userId, bypass } = state
      if (state.preview.revision !== input.revision) {
        throw fsError('FOLDER_CONTENTS_CHANGED', '文件夹内容已变化，请重新确认', 409)
      }
      if (input.action === 'empty' && (contents.rooms.length || contents.folders.length > 1)) {
        throw fsError('FOLDER_NOT_EMPTY', '文件夹中还有内容，请选择移动或全部删除', 409)
      }
      if ((input.action === 'trash' && !state.preview.canTrash) ||
          (input.action === 'move' && !state.preview.canMove)) {
        throw fsError('FORBIDDEN', '没有权限处理文件夹中的全部内容', 403)
      }
      const targetId = input.action === 'move' ? parseFolderId(input.targetFolderId) : null
      let targetMembers = []
      if (targetId) {
        if (state.preview.excludedFolderIds.includes(targetId)) {
          throw fsError('INVALID_MOVE', '不能移入当前文件夹或它的子文件夹', 400)
        }
        const target = await store.getFolder(targetId, db)
        if (!target) throw fsError('FOLDER_NOT_FOUND', '目标文件夹不存在', 404)
        if ((target.team_id || null) !== (root.team_id || null)) {
          throw fsError('FOLDER_TEAM_MISMATCH', '请选择同一空间中的文件夹', 400)
        }
        targetMembers = await store.listFolderMembers(targetId, db)
        let writable = bypass || target.created_by === userId || targetMembers.some(m =>
          m.user_id === userId && ['manager', 'editor'].includes(m.role))
        const visited = new Set([targetId])
        let parentId = target.parent_id
        while (!writable && parentId && !visited.has(parentId)) {
          visited.add(parentId)
          const parent = await store.getFolder(parentId, db)
          if (!parent) break
          writable = parent.created_by === userId
          parentId = parent.parent_id
        }
        if (!writable) {
          throw fsError('FORBIDDEN', '没有目标文件夹的编辑权限', 403)
        }
      }
      if (input.action === 'move') {
        for (const child of contents.folders.filter(f => f.parent_id === id)) {
          if (await store.folderNameTaken(child.name, targetId, child.id, root.team_id, db)) {
            throw fsError('FOLDER_NAME_CONFLICT', '目标位置已有同名子文件夹，请选择其他位置', 409)
          }
        }
        for (const room of contents.rooms.filter(r => r.folder_id === id)) {
          const conn = db || store
          await roomAcl.clearRoomFolderRoles(conn, room.room_key)
          if (targetId) await roomAcl.applyFolderRoles(conn, room.room_key, targetId, targetMembers)
        }
      }
      await store.finishFolderDeletion(id, contents, { action: input.action, targetId, userId }, db)
      return { ...state.preview, action: input.action, targetFolderId: targetId,
        deletedFolderIds: input.action === 'move' ? [id] : state.preview.excludedFolderIds,
        trashedRoomKeys: input.action === 'trash' ? contents.rooms.map(r => r.room_key) : [] }
    })
    result.trashedRoomKeys.forEach(key => notifyStorage(key, 'trash'))
    delete result.trashedRoomKeys
    return result
  }
  return { previewFolderDeletion: preview, deleteFolderContents: execute }
}

module.exports = { createFolderDeletion }
