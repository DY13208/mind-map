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

// 正在编辑/激活的节点及其祖先：恢复偏好时不得把它们收起，否则会出现
// 「搜索能找到、画布上看不见，刷新才回来」的假丢失。
export function collectExpandProtectUids(mindMap) {
  const protect = new Set()
  const renderer = mindMap && mindMap.renderer
  if (!renderer) return protect
  const addAncestors = node => {
    let cur = node
    while (cur) {
      const uid =
        (cur.getData && cur.getData('uid')) ||
        (cur.nodeData && cur.nodeData.data && cur.nodeData.data.uid) ||
        (cur.data && cur.data.uid)
      if (uid) protect.add(uid)
      cur = cur.parent || null
    }
  }
  ;(renderer.activeNodeList || []).forEach(addAncestors)
  if (
    renderer.textEdit &&
    typeof renderer.textEdit.isShowTextEdit === 'function' &&
    renderer.textEdit.isShowTextEdit() &&
    renderer.textEdit.currentNode
  ) {
    addAncestors(renderer.textEdit.currentNode)
  }
  const richText = mindMap.richText
  if (richText && richText.showTextEdit && richText.node) {
    addAncestors(richText.node)
  }
  return protect
}

export function applyPersonalExpandState(mindMap, state, options = {}) {
  if (!mindMap || !state || typeof state !== 'object') return false
  const renderer = mindMap.renderer
  const protect =
    options.protectUids instanceof Set
      ? options.protectUids
      : new Set(options.protectUids || [])
  let changed = false
  walkTree(renderer && renderer.renderTree, node => {
    const data = nodeDataOf(node)
    const uid = data && data.uid
    if (!uid || !Object.prototype.hasOwnProperty.call(state, uid)) return
    const next = state[uid] !== false
    if ((data.expand !== false) !== next) {
      // 保护路径只挡「收起」，仍允许按偏好展开
      if (!next && protect.has(uid)) return
      data.expand = next
      changed = true
    }
  })
  return changed
}

