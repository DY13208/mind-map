const { randomUUID } = require('crypto')

const TITLE_MAX = 80
const FOLDER_NAME_MAX = 80
// Keep the persisted default in sync with the editor placeholder/example data.
// Otherwise a newly-created room first paints classic4/logicalStructure and then
// jumps to classic/mindMap when collaboration metadata arrives.
const DEFAULT_METADATA = { theme: 'classic4', layout: 'logicalStructure' }

function fsError(code, message, status) {
  const err = new Error(message)
  err.code = code
  err.statusCode = status || 400
  return err
}

function normalizeTitle(title) {
  const plain = String(title || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
  return plain || '未命名'
}

function normalizeFolderName(name) {
  const next = String(name || '').trim().slice(0, FOLDER_NAME_MAX)
  if (!next) throw fsError('INVALID_FOLDER_NAME', 'folder name is required', 400)
  return next
}

function createRoomKey() {
  return 'room-' + Math.random().toString(36).slice(2, 10)
}

function defaultRootGraph(title) {
  const text = normalizeTitle(title)
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text, expand: true },
      children: []
    }
  }
}

function parseFolderId(value) {
  if (value == null || value === '' || value === 'root' || value === 'null') {
    return null
  }
    const id = String(value).trim()
    if (id === 'root') return null
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id
      )
    ) {
      throw fsError('INVALID_MOVE', 'invalid folder id', 400)
    }
    return id
}

function encodeCursor(parts) {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  } catch (err) {
    return null
  }
}

function publicFile(row, access = {}) {
  if (!row) return null
  return {
    roomKey: row.room_key || row.roomKey,
    title: row.title || '未命名',
    folderId: row.folder_id || row.folderId || null,
    owner: {
      userId: row.owner_user_id || row.owner_id || (row.owner && row.owner.userId) || '',
      name: row.owner_name || (row.owner && row.owner.name) || row.owner_id || '',
      avatar: row.owner_avatar || (row.owner && row.owner.avatar) || ''
    },
    role: access.role || row.role || null,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.content_updated_at || row.contentUpdatedAt || row.updated_at || row.updatedAt,
    contentUpdatedAt: row.content_updated_at || row.contentUpdatedAt || row.updated_at || row.updatedAt,
    resourceUpdatedAt: row.updated_at || row.updatedAt,
    revision: Number(row.version != null ? row.version : row.revision || 0),
    canView: access.canView != null ? access.canView : true,
    canEdit: !!access.canEdit,
    canManage: !!access.canManage,
    favorite: !!(row.is_favorite != null ? row.is_favorite : row.favorite),
    lastOpenedAt: row.last_opened_at || row.lastOpenedAt || null,
    deletedAt: row.deleted_at || row.deletedAt || null,
    deletedBy: row.deleted_by || row.deletedBy || null,
    deletedFromFolderId:
      row.deleted_from_folder_id || row.deletedFromFolderId || null
  }
}

function publicFolder(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || row.parentId || null,
    createdBy: row.created_by || row.createdBy || '',
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
    roomCount: Number(row.room_count != null ? row.room_count : row.roomCount || 0),
    role: row.folder_role || row.role || (row.can_manage ? 'owner' : null),
    canManage: row.can_manage != null ? !!row.can_manage : true
  }
}

function newFolderId() {
  return randomUUID()
}

module.exports = {
  TITLE_MAX,
  FOLDER_NAME_MAX,
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
}
