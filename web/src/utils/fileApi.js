import { getRuntimeConfig } from './runtimeConfig'

function apiBase() {
  return getRuntimeConfig().collabApi
}

async function request(path, options = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    credentials: 'include',
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
