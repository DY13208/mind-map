// 展开/收起属于当前用户的工作区视图偏好，不应写入协同树数据。
const STORAGE_PREFIX = 'mind-map-personal-expand:v1:'

function storageKey(roomKey, userId) {
  return `${STORAGE_PREFIX}${encodeURIComponent(String(userId || 'local'))}:${encodeURIComponent(
    String(roomKey || '')
  )}`
}

function nodeDataOf(node) {
  if (!node) return null
  return node.data || (node.nodeData && node.nodeData.data) || null
}

function childrenOf(node) {
  if (!node) return []
  return Array.isArray(node.children)
    ? node.children
    : node.nodeData && Array.isArray(node.nodeData.children)
      ? node.nodeData.children
      : []
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

