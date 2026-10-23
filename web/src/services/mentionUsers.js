import { productRequest } from './productHttp'

export async function searchMentionUsers(q = '', offset = 0) {
  const params = new URLSearchParams({ search: q, offset: String(offset), limit: '50' })
  const result = await productRequest(`/api/wecom/contacts?${params}`)
  return {
    list: (result.list || result.items || []).map(u => ({ userId: String(u.id || u.user_id || u.userId || ''), name: u.name || u.user_id, avatar: u.avatar || '' })),
    nextOffset: result.nextCursor != null ? Number(result.nextCursor) : null
  }
}
