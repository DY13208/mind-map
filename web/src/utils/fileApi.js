import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout'
import { getRuntimeConfig } from './runtimeConfig'
import { createOperationId } from 'simple-mind-map/src/utils/operationId'
import { collabTrace, collabPersistSnapshot } from 'simple-mind-map/src/utils/collabTrace'
import { stringifyJsonOffMainThread } from '@/utils/importTree'

const DEFAULT_TIMEOUT_MS = 20000
const CPD_CHECK_TIMEOUT_MS = 120000
const SUBTREE_TIMEOUT_MS = 12000
const MAX_API_INFLIGHT = 2
const REPLACE_TIMEOUT_MIN_MS = 120000
const REPLACE_TIMEOUT_MAX_MS = 600000

export function localKnowledgeStatus() { return request('/api/local-knowledge/status') }
export function refreshLocalKnowledge(roomId) {
  return request('/api/local-knowledge/refresh', {method:'POST',body:JSON.stringify({roomId,titles:['刷新索引']})})
}

export async function fillLocalKnowledge(body, { signal, onStatus } = {}) {
  const response = await fetch(`${apiBase()}/api/local-knowledge/fill`, {
    method: 'POST', credentials: 'include', signal,
    headers: clientHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw Object.assign(new Error(data.error || '本地资料检索失败'), { code: data.code, statusCode: response.status })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''; let result
  const parse = line => {
    if (!line.trim()) return
    const data = JSON.parse(line)
    if (data.status && onStatus) onStatus(data.status)
    if (data.error) throw Object.assign(new Error(data.error), { code: data.code })
    if (data.result) result = data.result
  }
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
      if (chunk.done) break
    }
    parse(buffer)
    if (!result) throw new Error('本地资料读取未完成')
    return result
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

let apiActive = 0
const apiHighWait = []
const apiLowWait = []
const inflightSubtree = new Map()
let apiFailCount = 0
let apiPauseUntil = 0

function acquireApiSlot(priority = 'high') {
  return new Promise(resolve => {
    const start = () => {
      apiActive += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        apiActive -= 1
        const next = apiHighWait.shift() || apiLowWait.shift()
        if (next) next()
      })
    }
    if (apiActive < MAX_API_INFLIGHT) {
      start()
      return
    }
    if (priority === 'low') apiLowWait.push(start)
    else apiHighWait.push(start)
  })
}

function requestPriority(options = {}) {
  if (options.priority) return options.priority
  const method = String(options.method || 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD' ? 'high' : 'low'
}

function noteApiSuccess() {
  apiFailCount = 0
  apiPauseUntil = 0
}

function noteApiFailure(err) {
  const msg = String((err && err.message) || err || '')
  const network =
    (err && err.name === 'FetchTimeoutError') ||
    msg.includes('超时') ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('网络错误')
  if (!network) return
  apiFailCount += 1
  if (apiFailCount >= 3) {
    apiPauseUntil = Date.now() + Math.min(15000, 2000 * apiFailCount)
  }
}

function subtreeDedupeKey(roomKey, uid, options = {}) {
  return [
    roomKey,
    uid || '',
    options.deep ? '1' : '0',
    options.maxNodes == null ? '' : String(options.maxNodes),
    options.offset == null ? '' : String(options.offset),
    options.limit == null ? '' : String(options.limit),
    options.knownVersion == null ? '0' : String(options.knownVersion)
  ].join('|')
}

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

function currentClientId() {
  try {
    if (typeof window === 'undefined') return ''
    const debug = window.__COLLAB_V2_STATE__
    if (debug && debug.clientId) return String(debug.clientId)
    const snap =
      window.__COLLAB_V2_STATUS__ &&
      typeof window.__COLLAB_V2_STATUS__ === 'function' &&
      window.__COLLAB_V2_STATUS__()
    if (snap && snap.clientId) return String(snap.clientId)
    const key = 'mind-map-collab-v2-client'
    let id = sessionStorage.getItem(key)
    if (!id && typeof crypto !== 'undefined' && crypto.randomUUID) {
      id = crypto.randomUUID()
      sessionStorage.setItem(key, id)
    }
    return id || ''
  } catch (err) {
    return ''
  }
}

function clientHeaders(extra = {}) {
  const clientId = currentClientId()
  return {
    ...(clientId ? { 'x-client-id': clientId } : {}),
    ...extra
  }
}

async function request(path, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  const priority = requestPriority(options)
  if (priority === 'low' && Date.now() < apiPauseUntil) {
    const err = new Error('协作服务繁忙，请稍后重试')
    err.code = 'API_BACKOFF'
    throw err
  }
  if (options.onUploadProgress) {
    return requestWithUploadProgress(path, { ...options, timeoutMs })
  }
  const release = await acquireApiSlot(priority)
  let res
  try {
    res = await fetchWithTimeout(
      `${apiBase()}${path}`,
      {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...clientHeaders(options.headers || {})
        },
        method: options.method,
        body: options.body,
        signal: options.signal
      },
      timeoutMs
    )
  } catch (err) {
    noteApiFailure(err)
    if (err instanceof FetchTimeoutError) {
      throw new Error('协作服务响应超时，请稍后重试')
    }
    throw err
  } finally {
    release()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'request failed')
    if (data.code) err.code = data.code
    if (data.retryAfterMs != null) err.retryAfterMs = data.retryAfterMs
    err.statusCode = res.status
    if (res.status >= 500) noteApiFailure(err)
    throw err
  }
  noteApiSuccess()
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
      ...clientHeaders(options.headers || {})
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
      error.statusCode = xhr.status
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
  // `null` represents the root directory.  Keep the key in that case so the
  // server can distinguish it from an unfiltered list request.
  if (Object.prototype.hasOwnProperty.call(extra, 'folderId')) {
    params.set('folderId', extra.folderId == null ? '' : String(extra.folderId))
  }
  if (extra.limit != null) params.set('limit', String(extra.limit))
  if (extra.offset != null) params.set('offset', String(extra.offset))
  if (extra.cursor) params.set('cursor', String(extra.cursor))
  const query = params.toString()
  return request(`/api/files${query ? `?${query}` : ''}`)
}

/** 按游标拉完当前用户可访问的全部脑图（引擎单页上限 100） */
export async function listAllAccessibleFiles(extra = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(extra.limit) || 100))
  const all = []
  let cursor = ''
  let guard = 0
  while (guard < 200) {
    guard += 1
    const data = await listFiles({
      ...extra,
      limit: pageSize,
      ...(cursor ? { cursor } : { offset: cursor ? undefined : 0 })
    })
    const list = (data && data.list) || []
    all.push(...list)
    cursor = (data && data.nextCursor) || ''
    if (!cursor || !list.length) {
      return {
        ok: true,
        list: all,
        total: (data && data.total) != null ? data.total : all.length,
        limit: pageSize
      }
    }
  }
  return { ok: true, list: all, total: all.length, limit: pageSize }
}

export function authorizeSopRun(roomKey, uid = '') {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/sop-runs/authorize`,
    {
      method: 'POST',
      body: JSON.stringify({ uid: uid || undefined })
    }
  )
}

function cpdChecksPath(roomKey, suffix = '') {
  return `/api/files/${encodeURIComponent(roomKey)}/cpd-checks${suffix}`
}

/** Create a read-only CPD check run for one selected node. */
export function createCpdCheckRun(roomKey, { nodeUid, requestId, signal, mode } = {}) {
  return request(cpdChecksPath(roomKey), {
    method: 'POST',
    timeoutMs: CPD_CHECK_TIMEOUT_MS,
    signal,
    body: JSON.stringify({ nodeUid, requestId, mode })
  })
}

/** List persisted CPD check runs for the selected node. */
export function listCpdCheckRuns(roomKey, nodeUid, { signal } = {}) {
  const query = new URLSearchParams()
  if (nodeUid) query.set('nodeUid', String(nodeUid))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(cpdChecksPath(roomKey, suffix), { signal })
}

/** Load one persisted CPD check report. */
export function getCpdCheckRun(roomKey, checkRunId, { signal } = {}) {
  return request(
    cpdChecksPath(roomKey, `/${encodeURIComponent(checkRunId)}`),
    { signal, timeoutMs: CPD_CHECK_TIMEOUT_MS }
  )
}

/** Confirm the user-selected candidate process and continue the same check. */
export function confirmCpdCheckCandidate(
  roomKey,
  checkRunId,
  candidateId,
  { signal } = {}
) {
  return request(
    cpdChecksPath(roomKey, `/${encodeURIComponent(checkRunId)}/confirm`),
    {
      method: 'POST',
      timeoutMs: CPD_CHECK_TIMEOUT_MS,
      signal,
      body: JSON.stringify({ candidateId })
    }
  )
}

export function submitCpdCheckReview(roomKey, checkRunId, body, { signal } = {}) {
  return request(cpdChecksPath(roomKey, `/${encodeURIComponent(checkRunId)}/reviews`), {
    method: 'POST', timeoutMs: CPD_CHECK_TIMEOUT_MS, signal, body: JSON.stringify(body || {})
  })
}

export function getCpdCheckSource(roomKey, checkRunId, sourceId, { signal } = {}) {
  return request(cpdChecksPath(roomKey, `/${encodeURIComponent(checkRunId)}/sources/${encodeURIComponent(sourceId)}`), { signal, timeoutMs: CPD_CHECK_TIMEOUT_MS })
}

export function retryCpdCheckSource(roomKey, checkRunId, sourceId, body, { signal } = {}) {
  return request(cpdChecksPath(roomKey, `/${encodeURIComponent(checkRunId)}/sources/${encodeURIComponent(sourceId)}/retry`), {
    method: 'POST', timeoutMs: CPD_CHECK_TIMEOUT_MS, signal, body: JSON.stringify(body || {})
  })
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
  return request(`/api/files/${encodeURIComponent(roomKey)}/trash`, {
    method: 'POST'
  })
}

export function getSaveStatus(roomKey) {
  const persistBefore = collabPersistSnapshot()
  let statusBefore = null
  try {
    statusBefore =
      typeof window !== 'undefined' &&
      window.__COLLAB_V2_STATUS__ &&
      window.__COLLAB_V2_STATUS__()
  } catch (err) {
    statusBefore = null
  }
  collabTrace('save-status.request', {
    roomKey,
    lastPushedCount: persistBefore.lastPushedCount,
    lastServerRevision: statusBefore && statusBefore.lastServerRevision,
    outboxPending: statusBefore && statusBefore.outboxPending,
    pendingCount: statusBefore && statusBefore.pendingCount,
    saveState: statusBefore && statusBefore.saveState
  })
  return request(`/api/files/${encodeURIComponent(roomKey)}/save-status`, {
    timeoutMs: 8000,
    priority: 'low'
  }).then(data => {
    const persistAfter = collabPersistSnapshot()
    let statusAfter = null
    try {
      statusAfter =
        typeof window !== 'undefined' &&
        window.__COLLAB_V2_STATUS__ &&
        window.__COLLAB_V2_STATUS__()
    } catch (err) {
      statusAfter = null
    }
    collabTrace('save-status.response', {
      roomKey,
      status: data && data.status,
      replacing: data && data.replacing,
      version: data && data.version,
      lastPushedCount: persistAfter.lastPushedCount,
      lastPushedChanged:
        persistBefore.lastPushedCount !== persistAfter.lastPushedCount,
      lastServerRevision: statusAfter && statusAfter.lastServerRevision,
      lastServerRevisionChanged:
        (statusBefore && statusBefore.lastServerRevision) !==
        (statusAfter && statusAfter.lastServerRevision),
      outboxPending: statusAfter && statusAfter.outboxPending,
      outboxChanged:
        (statusBefore && statusBefore.outboxPending) !==
        (statusAfter && statusAfter.outboxPending)
    })
    return data
  })
}

export function beatPresence(roomKey, user) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'POST',
    timeoutMs: 8000,
    priority: 'low',
    body: JSON.stringify(user || {})
  })
}

export function leavePresence(roomKey, userId, clientId) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/presence`, {
    method: 'DELETE',
    body: JSON.stringify({ id: userId, clientId })
  })
}

export function getFileMeta(roomKey) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/meta`, {
    timeoutMs: 8000
  })
}

export function getPersonalViewState(roomKey) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/view-state`, {
    timeoutMs: 8000,
    priority: 'low'
  })
}

export function savePersonalViewState(roomKey, state) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/view-state`, {
    method: 'PATCH',
    timeoutMs: 8000,
    priority: 'low',
    body: JSON.stringify({ state: state || {} })
  })
}

export function recoverFileRoom(roomKey, body = {}) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/recover`, {
    method: 'POST',
    timeoutMs: 20000,
    body: JSON.stringify(body || {})
  })
}

export function getFilePreview(roomKey, depth = 2, options = {}) {
  const params = new URLSearchParams()
  if (Number(depth) > 0) params.set('depth', String(Number(depth)))
  if (options.safe) params.set('safe', '1')
  const query = params.toString()
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/preview${query ? `?${query}` : ''}`,
    {
      timeoutMs: options.timeoutMs || 12000
    }
  )
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
  const key = subtreeDedupeKey(roomKey, uid, options)
  const pending = inflightSubtree.get(key)
  if (pending) return pending
  const job = request(
    `/api/files/${encodeURIComponent(roomKey)}/subtree${query ? `?${query}` : ''}`,
    {
      timeoutMs: options.timeoutMs || SUBTREE_TIMEOUT_MS,
      priority: options.priority || 'high'
    }
  ).finally(() => {
    if (inflightSubtree.get(key) === job) inflightSubtree.delete(key)
  })
  inflightSubtree.set(key, job)
  return job
}

export function getFileExport(roomKey, maxNodes = 10000) {
  const limit = Math.min(10000, Math.max(0, Number(maxNodes) || 0))
  return request(
    `/api/files/${encodeURIComponent(roomKey)}?format=full${
      limit ? `&max_nodes=${limit}` : ''
    }`
  )
}

/** 服务端全量大纲（不依赖画布展开/懒加载） */
export function getFileOutline(roomKey, maxNodes = 5000) {
  const limit = Math.min(10000, Math.max(1, Number(maxNodes) || 5000))
  return request(
    `/api/files/${encodeURIComponent(roomKey)}?format=outline&max_nodes=${limit}`
  )
}

/** 扁平化全部节点（底层 room 数据，不依赖画布展开） */
export function getFileFlatNodes(roomKey) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}?format=nodes`
  )
}

export function locateFileNode(roomKey, uid) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/locate?uid=${encodeURIComponent(
      uid || ''
    )}`
  )
}

export function resolveFileRef(roomKey, uid) {
  const params = new URLSearchParams()
  if (uid) params.set('uid', uid)
  const query = params.toString()
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/ref-resolve${
      query ? `?${query}` : ''
    }`,
    { timeoutMs: 8000, priority: 'high' }
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

export function operationHeaders(body = {}) {
  const operationId =
    body.operationId || body.operation_id || createOperationId()
  if (!body.operationId && !body.operation_id) {
    body.operationId = operationId
  }
  const clientId = currentClientId()
  if (clientId && !body.clientId && !body.client_id) {
    body.clientId = clientId
  }
  return {
    ...(operationId ? { 'X-Operation-Id': operationId } : {}),
    ...clientHeaders()
  }
}

export function searchFile(roomKey, q, limit = 200, offset = 0, extra = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (limit) params.set('limit', String(limit))
  if (offset) params.set('offset', String(offset))
  if (extra.all) params.set('all', '1')
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/search?${params.toString()}`
  )
}

export async function searchFileAll(roomKey, q) {
  const data = await searchFile(roomKey, q, 500, 0, { all: true })
  const matches = data.matches || []
  return {
    ...data,
    matches,
    total: Number(data.total != null ? data.total : matches.length)
  }
}

export async function replaceFileTree(roomKey, tree, extra = {}) {
  const payload = {
    tree,
    title: extra.title,
    baseVersion: extra.baseVersion,
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

export function saveSopOutputRules(roomKey, sopUid, rules) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/sop/${encodeURIComponent(
      sopUid
    )}/output-rules`,
    {
      method: 'POST',
      body: JSON.stringify({ rules: Array.isArray(rules) ? rules : [] })
    }
  )
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

export function getFileMembers(roomKey) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/members`)
}

export function addFileMember(roomKey, userId, role) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role })
  })
}

export function updateFileMember(roomKey, userId, role) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/members/${encodeURIComponent(
      userId
    )}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ role })
    }
  )
}

export function removeFileMember(roomKey, userId) {
  return request(
    `/api/files/${encodeURIComponent(roomKey)}/members/${encodeURIComponent(
      userId
    )}`,
    { method: 'DELETE' }
  )
}

export function searchUsers(q, limit = 20) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (limit) params.set('limit', String(limit))
  return request(`/api/users?${params.toString()}`)
}

/** 本地 output 产物预览 / 下载 URL */
export function searchLocalArtifacts(query) {
  const params = new URLSearchParams()
  params.set('q', String(query || '').trim())
  return request(`/api/artifacts/search?${params.toString()}`)
}

export function artifactLocalUrl(filePath, { download = false, name = '' } = {}) {
  const params = new URLSearchParams()
  const raw = String(filePath || '').trim()
  if (raw) params.set('path', raw)
  const base =
    String(name || '').trim() ||
    raw
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() ||
    ''
  if (base) params.set('name', base)
  if (download) params.set('download', '1')
  return `${apiBase()}/api/artifacts/local?${params.toString()}`
}

/** 列出房间 CPDA 待办树 */
export function listRoomTodos(roomKey, { includeCompleted = false } = {}) {
  const q = includeCompleted ? '?include_completed=true' : ''
  return request(`/api/files/${encodeURIComponent(roomKey)}/todos${q}`)
}

/** 在「待办」下新建一条任务 */
export function createRoomTodo(roomKey, body = {}) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/todos`, {
    method: 'POST',
    headers: operationHeaders(body),
    body: JSON.stringify({ ...(body || {}), confirm_sop_change: true })
  })
}

export { request as apiRequest }
