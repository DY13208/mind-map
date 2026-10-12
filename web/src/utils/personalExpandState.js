// 展开/收起属于当前用户的工作区视图偏好，不应写入协同树数据。
const STORAGE_PREFIX = 'mind-map-personal-expand:v1:'

function storageKey(roomKey, userId) {
  return `${STORAGE_PREFIX}${encodeURIComponent(String(userId || 'local'))}:${encodeURIComponent(
    String(roomKey || '')
  )}`
}

function nodeDataOf(node) {
  if (!node) return null
  return node.data || (node.nodeData && node.nodeData.data) || (node.uid ? node : null)
}

function childrenOf(node) {
  if (!node) return []
  const children = Array.isArray(node.children)
    ? node.children
    : node.nodeData && Array.isArray(node.nodeData.children)
      ? node.nodeData.children
      : []
  const data = nodeDataOf(node)
  const summaries = data && data.generalization
  return summaries ? children.concat(Array.isArray(summaries) ? summaries : [summaries]) : children
}

function walkTree(root, visit) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    visit(node)
    const children = childrenOf(node)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i])
    }
  }
}

export function isPersonalExpandNodeVisible(mindMap, uid) {
  const root = mindMap && mindMap.renderer && mindMap.renderer.renderTree
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    const data = nodeDataOf(node)
    if (!data) continue
    if (data.uid === uid) return true
    if (data.expand === false) continue
    for (const child of childrenOf(node)) stack.push(child)
  }
  return false
}

export function loadPersonalExpandState(roomKey, userId) {
  if (!roomKey) return {}
  try {
    const raw = localStorage.getItem(storageKey(roomKey, userId))
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (err) {
    return {}
  }
}

export function savePersonalExpandState(roomKey, userId, state) {
  if (!roomKey || !state || typeof state !== 'object') return
  try {
    localStorage.setItem(storageKey(roomKey, userId), JSON.stringify(state))
  } catch (err) {
    // 展开偏好不能阻断编辑；配额不足时保持当前会话状态即可。
  }
}

export function collectPersonalExpandState(mindMap, previous = {}) {
  const result = { ...(previous || {}) }
  const renderer = mindMap && mindMap.renderer
  walkTree(renderer && renderer.renderTree, node => {
    const data = nodeDataOf(node)
    const uid = data && data.uid
    if (uid) result[uid] = data.expand !== false
  })
  return result
}

export function applyPersonalExpandState(mindMap, state) {
  if (!mindMap || !state || typeof state !== 'object') return false
  const renderer = mindMap.renderer
  let changed = false
  walkTree(renderer && renderer.renderTree, node => {
    const data = nodeDataOf(node)
    const uid = data && data.uid
    if (!uid || !Object.prototype.hasOwnProperty.call(state, uid)) return
    const next = state[uid] !== false
    if ((data.expand !== false) !== next) {
      data.expand = next
      changed = true
    }
  })
  return changed
}

// Backend is authoritative across devices; cache and the pending journal cover
// reload/offline operation. Version checks prevent old journals overwriting it.
export function createPersonalExpandPersistence(roomKey, userId, getState, saveState, onReady) {
  const key = storageKey(roomKey, userId) + ':pending'
  let state = loadPersonalExpandState(roomKey, userId)
  let versions = {}
  let pending = {}
  try {
    const journal = JSON.parse(localStorage.getItem(key) || '{}')
    versions = journal.versions || {}
    pending = journal.pending || {}
  } catch (err) { /* Storage may be unavailable. */ }
  let ready = false
  let stopped = false
  let timer = null
  let flight = null
  const cache = () => {
    savePersonalExpandState(roomKey, userId, state)
    try { localStorage.setItem(key, JSON.stringify({ versions, pending })) } catch (err) { /* Storage may be unavailable. */ }
  }
  const schedule = (delay = 350) => {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(() => flush(), delay)
  }
  const flush = (keepalive = false) => {
    clearTimeout(timer)
    if (!ready || flight || !Object.keys(pending).length) return flight || Promise.resolve()
    const batch = { ...pending }
    const expand = {}
    const expandBase = {}
    for (const uid of Object.keys(batch)) {
      expand[uid] = batch[uid].value
      expandBase[uid] = batch[uid].base
    }
    flight = Promise.resolve().then(() => saveState(roomKey, { expand, expandBase }, { keepalive }))
      .then(result => {
        const remote = result && result.state || {}
        versions = remote.expandVersions || versions
        for (const uid of Object.keys(batch)) {
          // A newer command issued during the request stays pending and uses
          // the acknowledged version, even when the first request conflicted.
          if (pending[uid] === batch[uid]) delete pending[uid]
          else if (pending[uid]) pending[uid].base = versions[uid] || 0
        }
        cache()
      })
      .catch(() => { /* Retain journal and retry on reconnect/next open. */ })
      .finally(() => {
        flight = null
        if (Object.keys(pending).length) schedule(1500)
      })
    return flight
  }
  const record = changes => {
    for (const [uid, value] of Object.entries(changes)) {
      state[uid] = value !== false
      pending[uid] = { value: value !== false, base: ready ? versions[uid] || 0 : undefined }
    }
    cache()
    schedule()
  }
  let loadId = 0
  const load = () => {
    const id = ++loadId
    return getState(roomKey).then(result => {
      if (stopped || id !== loadId) return
      const remote = result && result.state || {}
      versions = remote.expandVersions || {}
      state = { ...state, ...(remote.expand || {}) }
      for (const uid of Object.keys(pending)) {
        state[uid] = pending[uid].value
        if (pending[uid].base === undefined) pending[uid].base = versions[uid] || 0
      }
      ready = true
      cache()
      onReady({ ...state })
      if (Object.keys(pending).length) schedule()
    }).catch(() => { if (!stopped && id === loadId) scheduleLoad() })
  }
  let loadTimer = null
  const scheduleLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 3000) }
  const onHide = () => { cache(); flush(true) }
  const onOnline = () => { if (ready) flush(); else load() }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide)
    window.addEventListener('online', onOnline)
  }
  load()
  return {
    record, flush,
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(loadTimer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onHide)
        window.removeEventListener('online', onOnline)
      }
      cache()
      // Finish edits queued during an in-flight write before leaving this map.
      return Promise.resolve(flight).then(() => flush(true))
    }
  }
}
