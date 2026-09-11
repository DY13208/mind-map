import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { folderIdForApi, normalizeRoomDto } from './roomDto'
import { validName } from './mockStore'

const TEAM_ROLES = ['owner', 'admin', 'member']

function unwrapList(data, keys) {
  if (Array.isArray(data)) return data
  for (const key of keys) {
    if (Array.isArray(data && data[key])) return data[key]
  }
  return Array.isArray(data && data.list) ? data.list : []
}

function unwrapItem(data, keys) {
  for (const key of keys) {
    if (data && data[key]) return data[key]
  }
  return data || {}
}

function roleOf(value) {
  const role = String(value || '').trim().toLowerCase()
  return TEAM_ROLES.includes(role) ? role : 'member'
}

function sourceTypeOf(value) {
  const source = String(value || 'custom').trim().toLowerCase()
  return source === 'wecom_department' ? 'WECOM_DEPARTMENT' : 'CUSTOM_TEAM'
}

function firstDepartment(value) {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        item && typeof item === 'object'
          ? item.name || item.departmentName || item.department_name || ''
          : item
      )
      .filter(Boolean)
      .join(' / ')
  }
  if (value && typeof value === 'object') return value.name || value.departmentName || ''
  return value || ''
}

function normalizeTeam(row = {}) {
  const owner = row.owner || {}
  return {
    id: String(row.id || row.teamId || ''),
    name: row.name || row.teamName || '',
    description: row.description || '',
    corpId: row.corpId || row.corp_id || '',
    corpName: row.corpName || row.corp_name || row.enterpriseName || '',
    owner: owner.name || row.ownerName || row.owner_name || (typeof owner === 'string' ? owner : ''),
    ownerId: owner.id || owner.userId || row.ownerId || row.owner_id || '',
    role: roleOf(row.role || row.teamRole || row.team_role),
    memberCount: Number(row.memberCount ?? row.member_count ?? 0),
    roomCount: Number(row.fileCount ?? row.roomCount ?? row.room_count ?? 0),
    fileCount: Number(row.fileCount ?? row.roomCount ?? row.room_count ?? 0),
    sourceType: sourceTypeOf(row.sourceType || row.source_type),
    createdAt: row.createdAt || row.created_at || '',
    updatedAt: row.updatedAt || row.updated_at || ''
  }
}

function normalizeMember(row = {}) {
  const user = row.user || row.member || row
  const name = String(user.name || user.displayName || user.userName || user.user_id || user.userId || '')
  const avatarUrl = user.avatarUrl || user.avatar_url || user.avatar || ''
  return {
    id: String(row.id || row.userId || row.user_id || user.id || user.userId || user.user_id || ''),
    userId: String(row.userId || row.user_id || user.id || user.userId || user.user_id || ''),
    wecomUserId: String(row.wecomUserId || row.wecom_userid || row.wecom_user_id || user.wecomUserId || user.user_id || user.userId || ''),
    name,
    avatar: avatarUrl || (name ? name.slice(0, 1) : '企'),
    avatarUrl,
    department: firstDepartment(
      user.departmentNames ||
        user.department_names ||
        user.department ||
        user.departments ||
        row.departmentNames ||
        row.department_names ||
        row.department ||
        row.departments
    ),
    position: user.position || user.title || row.position || row.title || '',
    teamRole: roleOf(row.teamRole || row.team_role || row.role),
    role: roleOf(row.teamRole || row.team_role || row.role),
    joinedAt: row.joinedAt || row.joined_at || row.createdAt || row.created_at || ''
  }
}

function normalizeContact(row = {}) {
  const member = normalizeMember(row)
  return { ...member, departmentId: row.departmentId || row.department_id || '' }
}

function queryString(filters = {}) {
  const params = new URLSearchParams()
  if (filters.search || filters.q) params.set('search', filters.search || filters.q)
  if (filters.departmentId) params.set('departmentId', String(filters.departmentId))
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.offset != null) params.set('offset', String(filters.offset))
  if (filters.page != null) params.set('page', String(filters.page))
  if (filters.cursor) params.set('cursor', String(filters.cursor))
  const query = params.toString()
  return query ? `?${query}` : ''
}

function handleError(error) {
  error.message = userMessageFromError(error)
  throw error
}

async function request(action) {
  try {
    return await action()
  } catch (error) {
    return handleError(error)
  }
}

async function listRooms(teamId) {
  const data = await productRequest(`/api/teams/${encodeURIComponent(teamId)}/rooms`)
  return unwrapList(data, ['files', 'rooms']).map(room =>
    normalizeRoomDto(room, { folderName: room.folderName || (room.folderId ? '' : '根目录') })
  )
}

const teamService = {
  backendStatus: C3_SERVICE_STATUS_MATRIX.Team,

  listSpaces: () =>
    request(async () => {
      const data = await productRequest('/api/teams')
      return unwrapList(data, ['teams', 'spaces']).map(normalizeTeam)
    }),

  getSpace: id =>
    request(async () => normalizeTeam(unwrapItem(await productRequest(`/api/teams/${encodeURIComponent(id)}`), ['team', 'space']))),

  createSpace: (name, description = '') =>
    request(async () => {
      const data = await productRequest('/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: validName(name),
          description: String(description || '').trim(),
          sourceType: 'CUSTOM_TEAM'
        })
      })
      return normalizeTeam(unwrapItem(data, ['team', 'space']))
    }),

  updateSpace: (id, fields = {}) =>
    request(async () => {
      const data = await productRequest(`/api/teams/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: validName(fields.name),
          description: String(fields.description || '').trim()
        })
      })
      return normalizeTeam(unwrapItem(data, ['team', 'space']))
    }),

  listMembers: id =>
    request(async () => {
      const data = await productRequest(`/api/teams/${encodeURIComponent(id)}/members`)
      return unwrapList(data, ['members', 'contacts']).map(normalizeMember)
    }),

  listContacts: filters =>
    request(async () => {
      const data = await productRequest(`/api/wecom/contacts${queryString(filters)}`)
      return {
        list: unwrapList(data, ['contacts', 'members', 'users']).map(normalizeContact),
        total: Number(data.total ?? data.count ?? 0),
        nextCursor: data.nextCursor || data.next_cursor || null
      }
    }),
  listDepartments: () => request(async () => {
    const data = await productRequest('/api/wecom/departments')
    return unwrapList(data, ['departments']).map(item => ({ id: String(item.id), name: item.name, parentId: String(item.parentId || 0), order: Number(item.order || 0) }))
  }),

  addMembers: (spaceId, wecomUserIds) =>
    request(async () => {
      const ids = Array.from(new Set((wecomUserIds || []).map(String).map(id => id.trim()).filter(Boolean)))
      const data = await productRequest(`/api/teams/${encodeURIComponent(spaceId)}/members`, {
        method: 'POST',
        body: JSON.stringify({ wecomUserIds: ids })
      })
      return unwrapList(data, ['members', 'added']).map(normalizeMember)
    }),

  listRooms: id => request(() => listRooms(id)),

  createRoom: (teamId, title, folderId = null) =>
    request(async () => {
      const data = await productRequest(`/api/teams/${encodeURIComponent(teamId)}/rooms`, {
        method: 'POST',
        body: JSON.stringify({ title: validName(title), folderId: folderIdForApi(folderId) })
      })
      return normalizeRoomDto(unwrapItem(data, ['room', 'file']))
    }),

  assignRoom: (teamId, roomKey) =>
    request(async () => {
      const key = String(roomKey || '').trim()
      if (!key) throw Object.assign(new Error('缺少脑图标识'), { code: 'BAD_REQUEST' })
      return productRequest(`/api/teams/${encodeURIComponent(teamId)}/rooms`, {
        method: 'POST',
        body: JSON.stringify({ roomKey: key })
      })
    }),

  updateMemberRole: (spaceId, id, role) =>
    request(async () => {
      const normalizedRole = roleOf(role)
      const data = await productRequest(`/api/teams/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: normalizedRole })
      })
      return normalizeMember(unwrapItem(data, ['member']))
    }),

  removeMember: (spaceId, id) =>
    request(() => productRequest(`/api/teams/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export default teamService
