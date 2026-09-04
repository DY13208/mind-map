import { productRequest } from './productHttp'
import { userMessageFromError } from './apiError'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
import { displayRole, normalizeMemberDto, normalizeRole } from './roomDto'

export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.Share,
  getMembers: async roomKey => {
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/members`
      )
      return (data.list || []).map(normalizeMemberDto)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  addMember: async (roomKey, emailOrUserId, role = 'Viewer') => {
    try {
      const row = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/members`,
        {
          method: 'POST',
          body: JSON.stringify({
            userId: String(emailOrUserId || '').trim(),
            role: normalizeRole(role)
          })
        }
      )
      return normalizeMemberDto(row)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  updateMemberRole: async (roomKey, userId, role) => {
    try {
      const row = await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/members/${encodeURIComponent(
          userId
        )}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: normalizeRole(role) })
        }
      )
      return normalizeMemberDto(row)
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  removeMember: async (roomKey, userId) => {
    try {
      return await productRequest(
        `/api/files/${encodeURIComponent(roomKey)}/members/${encodeURIComponent(
          userId
        )}`,
        { method: 'DELETE' }
      )
    } catch (error) {
      error.message = userMessageFromError(error)
      throw error
    }
  },
  displayRole
}
