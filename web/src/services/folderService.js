import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { normalizeFolderDto } from './roomDto'
import roomService from './roomService'
import { normalizeMemberDto } from './roomDto'

export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.Folder,
  listFolders: async () => {
    try {
      const data = await productRequest('/api/folders')
      return (data.list || []).map(normalizeFolderDto)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  createFolder: async (name, parentId = null) => {
    try {
      const data = await productRequest('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ name, parentId })
      })
      return normalizeFolderDto(data.folder || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  renameFolder: async (id, name) => {
    try {
      const data = await productRequest(
        `/api/folders/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ name })
        }
      )
      return normalizeFolderDto(data.folder || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  deleteFolder: async id => {
    try {
      return await productRequest(`/api/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  getMembers: async id => {
    const data = await productRequest(`/api/folders/${encodeURIComponent(id)}/members`)
    return { list: (data.list || []).map(normalizeMemberDto), canManage: !!data.canManage }
  },
  setMember: async (id, userId, role) => {
    const data = await productRequest(`/api/folders/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, role })
    })
    return (data.list || []).map(normalizeMemberDto)
  },
  bulkSetMembers: async (id, payload) => {
    const data = await productRequest(`/api/folders/${encodeURIComponent(id)}/members/bulk`, {
      method: 'POST', body: JSON.stringify(payload || {})
    })
    return (data.list || []).map(normalizeMemberDto)
  },
  updateMember: async (id, userId, role) => {
    const data = await productRequest(`/api/folders/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ role })
    })
    return (data.list || []).map(normalizeMemberDto)
  },
  removeMember: (id, userId) => productRequest(
    `/api/folders/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  ),
  moveRoom: (roomKey, folderId) => roomService.moveRoom(roomKey, folderId)
}
