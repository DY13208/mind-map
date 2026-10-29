import { productRequest } from './productHttp'
export function leaveOperationId() {
  if (window.crypto.randomUUID) return window.crypto.randomUUID()
  const bytes = window.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const h = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20)}`
}
const item = async (path, options) => (await productRequest(path, options)).item
export default {
  resolve: text =>
    item('/api/workflow-resolve', {
      method: 'POST',
      body: JSON.stringify({ text })
    }),
  catalog: cursor =>
    item(
      '/api/workflow-catalog' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
    ),
  prepare: (roomKey, nodeUid, source, useSourceNode = false) =>
    item(source ? '/api/workflow-requests' : '/api/leave-requests', {
      method: 'POST',
      body: JSON.stringify({ roomKey, nodeUid, source, useSourceNode })
    }),
  get: (id, before) =>
    item(
      '/api/leave-requests/' +
        encodeURIComponent(id) +
        (before ? '?before=' + encodeURIComponent(before) : '')
    ),
  template: source =>
    item(
      (source ? '/api/workflow-template' : '/api/leave-template') +
        (source
          ? '?' +
            new URLSearchParams({
              source_room: source.roomKey,
              source_node: source.nodeUid
            })
          : '')
    ),
  members: q => item('/api/leave-members?q=' + encodeURIComponent(q || '')),
  list: filters =>
    item('/api/leave-requests?' + new URLSearchParams(filters || {})),
  notices: () => item('/api/leave-notifications'),
  seen: ids =>
    item('/api/leave-notifications', {
      method: 'POST',
      body: JSON.stringify({ ids })
    }),
  definitions: (room, cursor) => item('/api/workflow-definitions?' + new URLSearchParams({room_key:room,...(cursor?{cursor}:{})})),
  invalidateDefinition: body => item('/api/workflow-definitions/invalidate',{method:'POST',body:JSON.stringify(body)}),
  publish: (fingerprint, source, options = {}) =>
    item('/api/leave-template/publish', {
      method: 'POST',
      body: JSON.stringify({
        source,
        ...options,
        expectedFingerprint: fingerprint,
        operationId: leaveOperationId()
      })
    }),
  act: (id, action, body) =>
    item('/api/leave-requests/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        operationId: body.operationId || leaveOperationId()
      })
    })
}
export function openLeaveRequest(detail) {
  window.dispatchEvent(new CustomEvent('mindmap:leave-open', { detail }))
}
