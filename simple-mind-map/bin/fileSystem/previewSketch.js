const MAX_DEPTH = 2
const MAX_LEVEL1 = 6
const MAX_LEVEL2 = 2

function stripText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function nodeText(node) {
  if (!node) return ''
  const data = node.data || {}
  return stripText(data.text || data.title || node.text || '') || '未命名'
}

function findRootUid(obj) {
  const uids = Object.keys(obj || {})
  const marked = uids.find(uid => obj[uid] && obj[uid].isRoot)
  if (marked) return marked
  if (obj.root) return 'root'
  return uids[0] || null
}

function nestedChildren(node) {
  if (!node) return []
  if (Array.isArray(node.children)) return node.children
  return []
}

function sketchFromNested(node, depth) {
  if (!node) return null
  const kids = nestedChildren(node)
  const limit = depth === 0 ? MAX_LEVEL1 : MAX_LEVEL2
  return {
    text: nodeText(node),
    children:
      depth >= MAX_DEPTH
        ? []
        : kids.slice(0, limit).map(child => sketchFromNested(child, depth + 1)).filter(Boolean)
  }
}

function sketchFromFlat(obj) {
  const rootUid = findRootUid(obj)
  if (!rootUid || !obj[rootUid]) return null

  function walk(uid, depth) {
    const node = obj[uid]
    if (!node) return null
    const childUids = Array.isArray(node.children) ? node.children : []
    const limit = depth === 0 ? MAX_LEVEL1 : MAX_LEVEL2
    return {
      text: nodeText(node),
      children:
        depth >= MAX_DEPTH
          ? []
          : childUids
              .slice(0, limit)
              .map(childUid =>
                typeof childUid === 'string'
                  ? walk(childUid, depth + 1)
                  : sketchFromNested(childUid, depth + 1)
              )
              .filter(Boolean)
    }
  }

  return walk(rootUid, 0)
}

function buildPreviewSketch(nodes) {
  if (!nodes || typeof nodes !== 'object') {
    return { text: '未命名', children: [] }
  }
  if (nodes.data || (Array.isArray(nodes.children) && !nodes.root)) {
    return sketchFromNested(nodes, 0) || { text: '未命名', children: [] }
  }
  if (nodes.root) {
    const kids = nodes.root.children
    const nested =
      !Array.isArray(kids) ||
      !kids.length ||
      typeof kids[0] === 'object'
    if (nested && (nodes.root.data || Array.isArray(kids))) {
      // Nested tree uses object children; flat maps keep uid strings.
      if (!Array.isArray(kids) || !kids.length || typeof kids[0] === 'object') {
        return sketchFromNested(nodes.root, 0) || { text: '未命名', children: [] }
      }
    }
  }
  return sketchFromFlat(nodes) || { text: '未命名', children: [] }
}

function sketchFromPreviewRows(rows) {
  const live = (rows || []).filter(row => !row.deleted_at)
  if (!live.length) return { text: '未命名', children: [] }
  const byUid = {}
  live.forEach(row => {
    byUid[row.uid] = {
      uid: row.uid,
      parent: row.parent_uid || null,
      isRoot: !!row.is_root,
      text: stripText((row.data && row.data.text) || row.text || '') || '未命名',
      position: row.position || '',
      children: []
    }
  })
  live
    .slice()
    .sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')) || String(a.uid).localeCompare(String(b.uid)))
    .forEach(row => {
      if (row.parent_uid && byUid[row.parent_uid] && byUid[row.uid]) {
        byUid[row.parent_uid].children.push(byUid[row.uid])
      }
    })
  const root =
    live.find(row => row.is_root) ||
    live.find(row => !row.parent_uid) ||
    live[0]
  const rootNode = byUid[root.uid]
  return {
    text: rootNode.text,
    children: rootNode.children.slice(0, MAX_LEVEL1).map(child => ({
      text: child.text,
      children: (child.children || []).slice(0, MAX_LEVEL2).map(grand => ({
        text: grand.text,
        children: []
      }))
    }))
  }
}

module.exports = {
  buildPreviewSketch,
  sketchFromPreviewRows,
  MAX_DEPTH,
  MAX_LEVEL1,
  MAX_LEVEL2
}
