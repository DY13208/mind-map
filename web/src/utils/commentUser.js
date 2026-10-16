import { getCurrentUser } from '@/utils/auth'
import { displayName } from '@/utils/displayName'

// 评论使用的当前用户信息（id / 名称 / 头像）
export function currentCommentUser() {
  const user = (typeof getCurrentUser === 'function' && getCurrentUser()) || {}
  return {
    userId: String(user.id || user.user_id || user.userid || user.name || ''),
    userName: String(displayName(user, '我')),
    avatar: String(user.avatar || '')
  }
}
