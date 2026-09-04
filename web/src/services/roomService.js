import { getCurrentUser } from '../utils/auth'
import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import {
  folderIdForApi,
  normalizeFolderId,
  normalizeRoomDto
} from './roomDto'
import {
  mockRequest,
  mockStore,
  requiredItem,
  validName
} from './mockStore'

const find = id => requiredItem(mockStore.rooms, id, '脑图')
const update = (id, changes) => Object.assign(find(id), changes)

function wrapList(list, extra = {}) {
  const rows = list || []
  return {
    list: rows,
    total: extra.total != null ? extra.total : rows.length,
    limit: extra.limit != null ? extra.limit : rows.length,
    offset: extra.offset != null ? extra.offset : 0,
    nextCursor: extra.nextCursor || null
  }
}

function applyFavorite(room) {
  const key = room.roomKey || room.id
  return { ...room, favorite: mockStore.favoriteKeys.has(key) }
}

function currentUserId() {
  const user = getCurrentUser()
  return (user && user.id) || ''
}

function toRoomDto(item, extras = {}) {
  return applyFavorite(
    normalizeRoomDto(item, { currentUserId: currentUserId(), ...extras })
  )
}

function isMockListMode(filters = {}) {
  return !!(filters.trash || filters.favorite || filters.recent)
}

async function listRealRooms(filters = {}) {
  const params = new URLSearchParams()
  if (filters.q || filters.search) params.set('q', filters.q || filters.search)
  if (filters.folderId !== undefined) {
    const id = normalizeFolderId(filters.folderId)
    if (id) params.set('folderId', id)
    else params.set('folderId', 'root')
  }
  if (filters.sort) params.set('sort', filters.sort)
  if (filters.order) params.set('order', filters.order)
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.offset != null) params.set('offset', String(filters.offset))
  if (filters.cursor) params.set('cursor', filters.cursor)
  const query = params.toString()
  const data = await productRequest(`/api/files${query ? `?${query}` : ''}`)
  const foldersById = filters.foldersById || {}
  let list = (data.list || []).map(item =>
    toRoomDto(item, {
      folderName: item.folderId
        ? (foldersById[item.folderId] && foldersById[item.folderId].name) || ''
        : '根目录'
    })
  )
  if (filters.shared) list = list.filter(room => room.sharedWithMe)
  if (filters.role) {
    const want = String(filters.role).toLowerCase()
    list = list.filter(room => room.role === want)
  }
  return wrapList(list, data)
}

async function getRoom(roomKey) {
  try {
    const data = await productRequest(
      `/api/files/${encodeURIComponent(roomKey)}/info`
    )
    return toRoomDto(data.file || data.room || data)
  } catch (error) {
    error.message = userMessageFromError(error)
    throw error
  }
}

export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.Room,
  listRooms: async (filters = {}) => {
    if (isMockListMode(filters)) {
      return mockRequest(() =>
        wrapList(
          mockStore.rooms.filter(
            room =>
              (filters.trash ? !!room.deletedAt : !room.deletedAt) &&
              (!filters.favorite || room.favorite) &&
              (!filters.recent || !!room.lastOpenedAt) &&
              (!filters.role ||
                String(room.role).toLowerCase() ===
                  String(filters.role).toLowerCase()) &&
              (filters.folderId === undefined ||
                room.folderId === filters.folderId)
          )
        )
      )
    }
    try {
      return await listRealRooms(filters)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  getRoom,
  getRoomInfo: getRoom,
  createRoom: async (title, folderId = null) => {
    try {
      const data = await productRequest('/api/files', {
        method: 'POST',
        body: JSON.stringify({
          title: validName(title),
          folderId: normalizeFolderId(folderId)
        })
      })
      const created = data.room || data.file
      if (!created || !created.roomKey) {
        throw new Error('创建脑图未返回 roomKey')
      }
      return toRoomDto(created)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  renameRoom: async (roomKey, title) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title: validName(title) })
        }
      )
      return toRoomDto(data.file || data.room || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  moveRoom: async (roomKey, folderId) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/move`,
        {
          method: 'POST',
          body: JSON.stringify({ folderId: folderIdForApi(folderId) })
        }
      )
      return toRoomDto(data.file || data.room || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  markOpened: id =>
    mockRequest(() => {
      try {
        return update(id, { lastOpenedAt: new Date().toISOString() })
      } catch (error) {
        return { ok: true, backendStatus: 'MOCK_PENDING' }
      }
    }),
  deleteRoom: id =>
    mockRequest(() => {
      try {
        return update(id, { deletedAt: new Date().toISOString() })
      } catch (error) {
        const err = new Error('回收站尚未接入，暂不可删除真实脑图')
        err.code = 'TRASH_BACKEND_PENDING'
        throw err
      }
    }),
  restoreRoom: id => mockRequest(() => update(id, { deletedAt: null })),
  permanentDelete: id =>
    mockRequest(() => {
      if (!find(id).deletedAt) throw new Error('只能永久删除回收站中的脑图')
      mockStore.rooms.splice(
        mockStore.rooms.findIndex(room => room.id === id),
        1
      )
      delete mockStore.roomMembers[id]
      mockStore.versions = mockStore.versions.filter(
        version => version.roomId !== id
      )
      return { ok: true }
    }),
  toggleFavorite: id =>
    mockRequest(() => {
      if (mockStore.favoriteKeys.has(id)) mockStore.favoriteKeys.delete(id)
      else mockStore.favoriteKeys.add(id)
      try {
        return update(id, { favorite: mockStore.favoriteKeys.has(id) })
      } catch (error) {
        return { id, roomKey: id, favorite: mockStore.favoriteKeys.has(id) }
      }
    })
}
