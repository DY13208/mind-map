import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { normalizeFolderDto } from './roomDto'
import roomService from './roomService'

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
  createFolder: async name => {
    try {
      const data = await productRequest('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ name })
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
  moveRoom: (roomKey, folderId) => roomService.moveRoom(roomKey, folderId)
}
