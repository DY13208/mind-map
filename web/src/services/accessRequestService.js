import { productRequest } from './productHttp'

export default {
  request(roomKey, role = 'viewer') {
    return productRequest('/api/access-requests', {
      method: 'POST',
      body: JSON.stringify({ roomKey, role })
    })
  },
  mine(roomKey) {
    const query = new URLSearchParams({ roomKey }).toString()
    return productRequest(`/api/access-requests/mine?${query}`)
  },
  inbox() {
    return productRequest('/api/notifications/access-requests')
  },
  decide(id, decision) {
    return productRequest(`/api/access-requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision })
    })
  }
}
