import { getCurrentUser } from '../utils/auth'

export default {
  backendStatus: 'REAL',
  getProfile: async () => {
    const user = getCurrentUser()
    if (!user || !user.id) {
      const err = new Error('请先使用企业微信登录')
      err.code = 'unauthorized'
      throw err
    }
    return {
      id: user.id,
      name: user.name || user.id,
      avatar: user.avatar || ''
    }
  }
}
