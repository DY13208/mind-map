import { getRuntimeConfig } from './runtimeConfig'

function apiBase() {
  return getRuntimeConfig().collabApi
}

async function request(path, options = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || res.statusText || 'request failed')
  }
  return data
}

export function listFiles() {
  return request('/api/files')
}

export function createFile(body = {}) {
  return request('/api/files', {
    method: 'POST',
    body: JSON.stringify(body || {})
  })
}

export function renameFile(roomKey, title) {
  return request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  })
}

export function deleteFile(roomKey) {
  return request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE'
  })
}

export function getSaveStatus(roomKey) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/save-status`)
}

export function beatPresence(roomKey, user) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'POST',
    body: JSON.stringify(user || {})
  })
}

export function leavePresence(roomKey, userId) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'DELETE',
    body: JSON.stringify({ id: userId })
  })
}

export function getFilePreview(roomKey, depth = 2) {
  const query = Number(depth) > 0 ? `?depth=${Number(depth)}` : ''
  return request(`/api/files/${encodeURIComponent(roomKey)}/preview${query}`)
}

export function getFileSubtree(roomKey, uid, options = {}) {
  const params = new URLSearchParams()
  if (uid) params.set('uid', uid)
  if (options.deep) params.set('deep', '1')
  if (options.maxNodes != null) params.set('max_nodes', String(options.maxNodes))
  if (options.offset != null) params.set('offset', String(options.offset))
  if (options.limit != null) params.set('limit', String(options.limit))
  const query = params.toString()
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/subtree${query ? `?${query}` : ''}`
  )
}

export function getFileExport(roomKey) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}?format=full&max_nodes=10000`
  )
}

export function locateFileNode(roomKey, uid) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/locate?uid=${encodeURIComponent(
      uid || ''
    )}`
  )
}

export function getFileNodes(roomKey, uids = []) {
  const list = (uids || []).filter(Boolean).slice(0, 200)
  const query = list.length
    ? `?uids=${encodeURIComponent(list.join(','))}`
    : ''
  return request(`/api/files/${encodeURIComponent(roomKey)}/nodes${query}`)
}

export function searchFile(roomKey, q, limit = 80) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (limit) params.set('limit', String(limit))
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/search?${params.toString()}`
  )
}

export function addFileNode(roomKey, body) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    body: JSON.stringify({ ...(body || {}), confirm_sop_change: true })
  })
}

export function patchFileNode(roomKey, uid, body) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ ...(body || {}), confirm_sop_change: true })
    }
  )
}

export function deleteFileNode(roomKey, uid, options = {}) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        keep_children: !!options.keepChildren,
        confirm_sop_change: true
      })
    }
  )
}
