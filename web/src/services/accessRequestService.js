import { productRequest } from './productHttp'
const query = filters => new URLSearchParams(filters || {}).toString()
export default {
  request(roomKey, role = 'viewer', reason = '') {
    return productRequest('/api/access-requests', {
      method: 'POST',
      body: JSON.stringify({ roomKey, role, reason })
    })
  },
  mine(roomKey) {
    return productRequest(`/api/access-requests/mine?${query({ roomKey })}`)
  },
  inbox(filters) {
    return productRequest(
      `/api/notifications/access-requests?${query(filters)}`
    )
  },
  results(filters) {
    return productRequest(`/api/notifications/access-results?${query(filters)}`)
  },
  history(filters) {
    return productRequest(`/api/notifications/access-history?${query(filters)}`)
  },
  seen(ids) {
    return productRequest('/api/notifications/access-results/seen', {
      method: 'POST',
      body: JSON.stringify({ ids })
    })
  },
  decide(id, decision, role, reason = '') {
    return productRequest(`/api/access-requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision, role, reason })
    })
  }
}
