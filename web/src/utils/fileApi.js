import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout'
import { getRuntimeConfig } from './runtimeConfig'
import { createOperationId } from 'simple-mind-map/src/utils/operationId'
import { stringifyJsonOffMainThread } from '@/utils/importTree'

const DEFAULT_TIMEOUT_MS = 20000
const REPLACE_TIMEOUT_MIN_MS = 120000
const REPLACE_TIMEOUT_MAX_MS = 600000

function countTreeNodes(tree) {
  if (!tree || typeof tree !== 'object') return 0
  if (!tree.data && !tree.children && !Array.isArray(tree)) {
    return Object.keys(tree).length
  }
  let count = 0
  const stack = [tree]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count += 1
    const kids = node.children || []
    for (let i = 0; i < kids.length; i++) stack.push(kids[i])
  }
  return count
}

function replaceTimeoutMs(tree, extra = {}) {
  if (extra.timeoutMs) return extra.timeoutMs
  const nodeCount = countTreeNodes(tree)
  if (nodeCount < 400) return DEFAULT_TIMEOUT_MS
  return Math.min(
    REPLACE_TIMEOUT_MAX_MS,
    Math.max(REPLACE_TIMEOUT_MIN_MS, nodeCount * 20)
  )
}

function apiBase() {
  return getRuntimeConfig().collabApi
}

async function request(path, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  if (options.onUploadProgress) {
    return requestWithUploadProgress(path, { ...options, timeoutMs })
  }
  let res
  try {
    res = await fetchWithTimeout(
      `${apiBase()}${path}`,
      {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        method: options.method,
        body: options.body
      },
      timeoutMs
    )
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw new Error('协作服务响应超时，请稍后重试')
    }
    throw err
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'request failed')
    if (data.code) err.code = data.code
    throw err
  }
  return data
}

function requestWithUploadProgress(path, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(options.method || 'POST', `${apiBase()}${path}`)
    xhr.withCredentials = true
    xhr.timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
    Object.keys(headers).forEach(key => {
      if (headers[key] != null) xhr.setRequestHeader(key, headers[key])
    })
    xhr.upload.onprogress = event => {
      if (!options.onUploadProgress || !event.lengthComputable) return
      const percent = event.total
        ? Math.round((event.loaded / event.total) * 100)
        : 0
      options.onUploadProgress({
        loaded: event.loaded,
        total: event.total,
        percent
      })
    }
    xhr.onload = () => {
      let data = {}
      try {
        data = JSON.parse(xhr.responseText || '{}')
      } catch (err) {
        data = {}
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
        return
      }
      const error = new Error(data.error || xhr.statusText || 'request failed')
      if (data.code) error.code = data.code
      reject(error)
    }
    xhr.onerror = () => reject(new Error('网络错误，请稍后重试'))
    xhr.ontimeout = () => reject(new Error('协作服务响应超时，请稍后重试'))
    xhr.send(options.body)
  })
}

export function listFiles(extra = {}) {
  const params = new URLSearchParams()
  if (extra.q) params.set('q', extra.q)
  if (extra.limit != null) params.set('limit', String(extra.limit))
  if (extra.offset != null) params.set('offset', String(extra.offset))
  const query = params.toString()
  return request(`/api/files${query ? `?${query}` : ''}`)
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
  return request(`/api/files/${encodeURIComponent(roomKey)}/save-status`, {
    timeoutMs: 8000
  })
}

export function beatPresence(roomKey, user) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'POST',
    timeoutMs: 8000,
    body: JSON.stringify(user || {})
  })
}

export function leavePresence(roomKey, userId, clientId) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'DELETE',
    body: JSON.stringify({ id: userId, clientId })
  })
}

export function getFilePreview(roomKey, depth = 2) {
  const query = Number(depth) > 0 ? `?depth=${Number(depth)}` : ''
  return request(`/api/files/${encodeURIComponent(roomKey)}/preview${query}`, {
    timeoutMs: 12000
  })
}

export function getFileSubtree(roomKey, uid, options = {}) {
  const params = new URLSearchParams()
  if (uid) params.set('uid', uid)
  if (options.deep) params.set('deep', '1')
  if (options.maxNodes != null) params.set('max_nodes', String(options.maxNodes))
  if (options.offset != null) params.set('offset', String(options.offset))
  if (options.limit != null) params.set('limit', String(options.limit))
  if (options.knownVersion != null) {
    params.set('knownVersion', String(options.knownVersion))
  }
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

export function getMapVersion(roomKey) {
  return request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
}

export function getMapOperations(roomKey, afterVersion = 0, limit = 500, extra = {}) {
  const params = new URLSearchParams()
  params.set('after', String(Number(afterVersion) || 0))
  if (limit) params.set('limit', String(limit))
  if (extra.actorId) params.set('actor', extra.actorId)
  return request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations?${params.toString()}`
  )
}

export function getMapAudit(roomKey, extra = {}) {
  const params = new URLSearchParams()
  if (extra.after != null) params.set('after', String(extra.after))
  if (extra.limit != null) params.set('limit', String(extra.limit))
  if (extra.actorId) params.set('actor', extra.actorId)
  const query = params.toString()
  return request(
    `/api/maps/${encodeURIComponent(roomKey)}/audit${query ? `?${query}` : ''}`
  )
}

export function undoMapOperation(roomKey, operationId, body = {}) {
  return request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${encodeURIComponent(
      operationId
    )}/undo`,
    {
      method: 'POST',
      headers: operationHeaders(body),
      body: JSON.stringify(body || {})
    }
  )
}

export function redoMapOperation(roomKey, operationId, body = {}) {
  return request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${encodeURIComponent(
      operationId
    )}/redo`,
    {
      method: 'POST',
      headers: operationHeaders(body),
      body: JSON.stringify(body || {})
    }
  )
}

export function getMapSnapshot(roomKey, extra = {}) {
  const params = new URLSearchParams()
  if (extra.depth != null) params.set('depth', String(extra.depth))
  if (extra.version != null) params.set('version', String(extra.version))
  const query = params.toString()
  return request(
    `/api/maps/${encodeURIComponent(roomKey)}/snapshot${query ? `?${query}` : ''}`
  )
}

function operationHeaders(body = {}) {
  const operationId =
    body.operationId || body.operation_id || createOperationId()
  if (!body.operationId && !body.operation_id) {
    body.operationId = operationId
  }
  return operationId ? { 'X-Operation-Id': operationId } : {}
}

export function searchFile(roomKey, q, limit = 80) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (limit) params.set('limit', String(limit))
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/search?${params.toString()}`
  )
}

export async function replaceFileTree(roomKey, tree, extra = {}) {
  const payload = {
    tree,
    title: extra.title,
    confirm_sop_change: extra.confirm_sop_change !== false,
    operationId: extra.operationId
  }
  const nodeCount = countTreeNodes(tree)
  const body =
    nodeCount >= 400
      ? await stringifyJsonOffMainThread(payload)
      : JSON.stringify(payload)
  return request(`/api/files/${encodeURIComponent(roomKey)}/replace`, {
    method: 'POST',
    timeoutMs: replaceTimeoutMs(tree, extra),
    headers: operationHeaders(extra),
    body,
    onUploadProgress: extra.onUploadProgress
  })
}

export function addFileNode(roomKey, body) {
  const payload = { ...(body || {}), confirm_sop_change: true }
  return request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    headers: operationHeaders(payload),
    body: JSON.stringify(payload)
  })
}

export function patchFileNode(roomKey, uid, body) {
  const payload = { ...(body || {}), confirm_sop_change: true }
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}`,
    {
      method: 'PATCH',
      headers: operationHeaders(payload),
      body: JSON.stringify(payload)
    }
  )
}

export function reorderFileNode(roomKey, uid, index, extra = {}) {
  return patchFileNode(roomKey, uid, {
    index,
    reorder: true,
    ...(extra || {})
  })
}

export function deleteFileNode(roomKey, uid, options = {}) {
  const payload = {
    keep_children: !!options.keepChildren,
    confirm_sop_change: true,
    operationId: options.operationId
  }
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}`,
    {
      method: 'DELETE',
      headers: operationHeaders(payload),
      body: JSON.stringify(payload)
    }
  )
}
