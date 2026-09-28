import { productRequest } from './productHttp'

const base = '/api/node-shares'
const query = (id, token, suffix = '') =>
  `${base}/${encodeURIComponent(id)}${suffix}?token=${encodeURIComponent(token)}`

export default {
  list(roomKey, rootUid) {
    return productRequest(`${base}?roomKey=${encodeURIComponent(roomKey)}&rootUid=${encodeURIComponent(rootUid)}`).then(res => res.data)
  },
  create(payload) {
    return productRequest(base, { method: 'POST', body: JSON.stringify(payload) }).then(res => res.data)
  },
  redeem(id, token) {
    return productRequest(`${base}/${encodeURIComponent(id)}/redeem`, {
      method: 'POST', body: JSON.stringify({ token })
    }).then(res => res.data)
  },
  update(id, payload) {
    return productRequest(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }).then(res => res.data)
  },
  revoke(id) {
    return productRequest(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(res => res.data)
  },
  rotate(id) {
    return productRequest(`${base}/${encodeURIComponent(id)}/rotate`, { method: 'POST' }).then(res => res.data)
  },
  tree(id, token, knownVersion = 0) {
    const path = query(id, token, '/tree')
    return productRequest(`${path}${knownVersion ? `&knownVersion=${encodeURIComponent(knownVersion)}` : ''}`).then(res => res.data)
  },
  history(id, token) {
    return productRequest(query(id, token, '/history')).then(res => res.data)
  },
  operation(id, token, operation) {
    return productRequest(`${base}/${encodeURIComponent(id)}/operations`, {
      method: 'POST',
      body: JSON.stringify({ token, operation })
    }).then(res => res.data)
  },
  presence(id, token) {
    return productRequest(query(id, token, '/presence')).then(res => res.data)
  },
  beat(id, token, clientId, editingUid) {
    return productRequest(`${base}/${encodeURIComponent(id)}/presence`, {
      method: 'POST', body: JSON.stringify({ token, clientId, editingUid })
    }).then(res => res.data)
  },
  leave(id, token, clientId) {
    return productRequest(`${base}/${encodeURIComponent(id)}/presence`, {
      method: 'DELETE', body: JSON.stringify({ token, clientId })
    }).then(res => res.data)
  }
}
