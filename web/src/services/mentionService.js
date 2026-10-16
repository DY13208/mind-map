import { productRequest } from './productHttp'

// 「@我的」：提及当前用户的评论（服务端按用户保存已读状态，多端同步）
export default {
  list({ limit = 20, before = '' } = {}) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before) params.set('before', before)
    return productRequest(`/api/users/me/mentions?${params.toString()}`)
  },
  unreadCount() {
    return productRequest('/api/users/me/mentions/unread-count')
  },
  markRead(items) {
    return productRequest('/api/users/me/mentions/read', {
      method: 'POST',
      body: JSON.stringify({ items })
    })
  },
  markAllRead() {
    return productRequest('/api/users/me/mentions/read', {
      method: 'POST',
      body: JSON.stringify({ all: true })
    })
  }
}
