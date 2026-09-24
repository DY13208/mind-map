import { treeTask } from '@/utils/treeWorker'
import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { normalizeVersionDto } from './roomDto'

function versionsFrom(data) {
  return (data.versions || data.list || []).map(item =>
    normalizeVersionDto(item)
  )
}

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'restore-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.History,
  listVersions: async (roomKey, query = {}) => {
    try {
      const params = new URLSearchParams()
      if (query.limit != null) params.set('limit', String(query.limit))
      if (query.cursor) params.set('cursor', query.cursor)
      if (query.type) params.set('type', query.type)
      if (query.from) params.set('from', query.from)
      if (query.to) params.set('to', query.to)
      if (query.createdBy) params.set('createdBy', query.createdBy)
      const qs = params.toString()
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions${
          qs ? `?${qs}` : ''
        }`
      )
      const list = versionsFrom(data)
      return Object.assign(list, {
        list,
        nextCursor: data.nextCursor || null,
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
            description: payload.description || ''
          })
        }
      )
      return normalizeVersionDto(data.version || data)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  flushAutoVersion: async roomKey => {
    try {
      const data = await productRequest(`/api/files/${encodeURIComponent(roomKey)}/versions/auto-flush`, {
        method: 'POST', body: JSON.stringify({})
      })
      return data.version ? normalizeVersionDto(data.version) : null
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
  getVersionTree: async (roomKey, versionId, options = {}) => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
          versionId
        )}/tree`,
        { signal: options.signal, timeoutMs: options.timeoutMs || 30000,
          parseJson: options.sessionId ? raw => treeTask('historyResponse', { raw, sessionId: options.sessionId }, { signal: options.signal, revision: options.sessionId }) : undefined }
      )
      return {
        ...data,
        viewingHistory: true,
        readOnly: true,
        version: normalizeVersionDto(data.version || {})
      }
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      error.message = userMessageFromError(error)
      throw error
    }
  },
  restoreVersion: async (roomKey, versionId, expectedCurrentRevision) => {
    try {
      const key = newIdempotencyKey()
      return await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
          versionId
        )}/restore`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify({
            expectedCurrentRevision: Number(expectedCurrentRevision),
            idempotencyKey: key
          })
        }
      )
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  }
}
