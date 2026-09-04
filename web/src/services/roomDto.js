function isRootFolderId(value) {
  return value == null || value === '' || value === 'root' || value === 'null'
}

export function normalizeFolderId(value) {
  return isRootFolderId(value) ? null : String(value)
}

export function folderIdForApi(value) {
  const id = normalizeFolderId(value)
  return id == null ? 'root' : id
}

export function normalizeRole(role) {
  return String(role || '').trim().toLowerCase()
}

export function displayRole(role) {
  const raw = normalizeRole(role)
  if (raw === 'owner') return 'Owner'
  if (raw === 'editor') return 'Editor'
  if (raw === 'viewer') return 'Viewer'
  return role || ''
}

export function isSharedWithMe({
  role,
  ownerUserId,
  currentUserId,
  legacyOpen
} = {}) {
  if (legacyOpen) return false
  const ownerId = String(ownerUserId || '').trim()
  const me = String(currentUserId || '').trim()
  if (!ownerId || !me) return false
  return normalizeRole(role) !== 'owner' && ownerId !== me
}

export function normalizeRoomDto(apiRoom = {}, extras = {}) {
  const roomKey = String(
    apiRoom.roomKey || apiRoom.room_key || apiRoom.id || extras.roomKey || ''
  )
  const ownerSrc = apiRoom.owner || {}
  const ownerId = String(
    ownerSrc.userId || ownerSrc.user_id || ownerSrc.id || ''
  )
  const ownerName = String(ownerSrc.name || ownerId || '')
  const folderId = normalizeFolderId(apiRoom.folderId)
  const role = normalizeRole(apiRoom.role)
  return {
    id: roomKey,
    roomKey,
    title: apiRoom.title || '未命名',
    folderId,
    folderName:
      extras.folderName ||
      apiRoom.folderName ||
      (folderId ? '' : '根目录'),
    owner: {
      id: ownerId,
      userId: ownerId,
      name: ownerName,
      avatar: ownerSrc.avatar || (ownerName ? ownerName.slice(0, 1) : '用')
    },
    collaborators: Array.isArray(apiRoom.collaborators)
      ? apiRoom.collaborators
      : [],
    role,
    roleLabel:
      role === 'owner' ? 'Owner' : role === 'editor' ? 'Editor' : role === 'viewer' ? 'Viewer' : role,
    favorite: !!(apiRoom.favorite || extras.favorite),
    lastOpenedAt: apiRoom.lastOpenedAt || apiRoom.last_opened_at || extras.lastOpenedAt || null,
    deletedAt: apiRoom.deletedAt || apiRoom.deleted_at || extras.deletedAt || null,
    sharedWithMe: isSharedWithMe({
      role,
      ownerUserId: ownerId,
      currentUserId: extras.currentUserId,
      legacyOpen: apiRoom.legacyOpen
    }),
    createdAt: apiRoom.createdAt || apiRoom.created_at || '',
    updatedAt: apiRoom.updatedAt || apiRoom.updated_at || '',
    contentUpdatedAt:
      apiRoom.contentUpdatedAt ||
      apiRoom.content_updated_at ||
      apiRoom.updatedAt ||
      '',
    revision: Number(apiRoom.revision || apiRoom.version || 0),
    canView: apiRoom.canView !== false,
    canEdit:
      apiRoom.canEdit != null
        ? !!apiRoom.canEdit
        : role === 'owner' || role === 'editor',
    canManage:
      apiRoom.canManage != null ? !!apiRoom.canManage : role === 'owner'
  }
}

export function normalizeFolderDto(apiFolder = {}) {
  return {
    id: String(apiFolder.id || ''),
    name: apiFolder.name || '',
    parentId: normalizeFolderId(apiFolder.parentId),
    createdAt: apiFolder.createdAt || '',
    updatedAt: apiFolder.updatedAt || '',
    roomCount: Number(apiFolder.roomCount || 0)
  }
}

export function normalizeVersionDto(apiVersion = {}, extras = {}) {
  const versionId = String(
    apiVersion.versionId || apiVersion.id || extras.versionId || ''
  )
  const type = String(apiVersion.type || '').toUpperCase()
  const summary = apiVersion.summary
  const summaryText =
    typeof summary === 'string'
      ? summary
      : summary
      ? `新增 ${summary.inserted || 0} · 更新 ${summary.updated || 0} · 删除 ${
          summary.deleted || 0
        }`
      : ''
  return {
    id: versionId,
    versionId,
    revision: Number(apiVersion.revision || 0),
    name: apiVersion.name || '',
    type,
    createdBy: apiVersion.createdBy || apiVersion.created_by || '',
    createdAt: apiVersion.createdAt || apiVersion.created_at || '',
    description: apiVersion.description || '',
    summary: summaryText,
    operator: apiVersion.createdBy || apiVersion.operator || '',
    version: apiVersion.name || ('R' + Number(apiVersion.revision || 0)),
    readOnly: true,
    viewingHistory: true
  }
}

export function normalizeMemberDto(row = {}) {
  const userId = String(row.user_id || row.userId || row.id || '')
  const name = String(row.name || userId)
  const role = normalizeRole(row.role)
  return {
    id: userId,
    userId,
    name,
    avatar: row.avatar || (name ? name.slice(0, 1) : '用'),
    email: row.email || userId,
    role: displayRole(role),
    joinedAt: row.created_at || row.joinedAt || ''
  }
}
