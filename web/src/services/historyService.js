import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { normalizeVersionDto } from './roomDto'

function versionsFrom(data) {
  return (data.versions || data.list || []).map(item =>
    normalizeVersionDto(item)
  )
}

export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.History,
  listVersions: async (roomKey, query = {}) => {
    try {
      const params = new URLSearchParams()
      if (query.limit != null) params.set('limit', String(query.limit))
      if (query.cursor) params.set('cursor', query.cursor)
      if (query.type) params.set('type', query.type)
      const qs = params.toString()
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions${
          qs ? `?${qs}` : ''
        }`
      )
      const list = versionsFrom(data)
      return Object.assign(list, {
        list,
        currentRevision: Number(data.currentRevision || 0),
        earliestAvailableRevision: Number(data.earliestAvailableRevision || 0),
        viewingHistory: true
      })
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  createVersion: async (roomKey, payload = {}) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: payload.name,
            description: payload.description || '',
            revision: payload.revision
          })
        }
      )
      return normalizeVersionDto(data.version || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  getVersion: async (roomKey, versionId) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
          versionId
        )}`
      )
      return normalizeVersionDto(data.version || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  getVersionTree: async (roomKey, versionId) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
          versionId
        )}/tree`
      )
      return {
        ...data,
        viewingHistory: true,
        readOnly: true,
        version: normalizeVersionDto(data.version || {})
      }
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  restoreVersion: async (roomKey, versionId, expectedCurrentRevision) => {
    try {
      return await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
          versionId
        )}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedCurrentRevision: Number(expectedCurrentRevision)
          })
        }
      )
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  }
}
