const crypto = require('crypto')

function createUid() {
  return crypto.randomUUID()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function createEmptyTree(title) {
  const uid = createUid()
  return {
    data: {
      uid,
      text: String(title || '未命名').slice(0, 80) || '未命名',
      expand: true
    },
    children: []
  }
}

function readObject(ydoc) {
  return ydoc.getMap().toJSON()
}

function findRootUid(obj) {
  return (
    Object.keys(obj).find(uid => obj[uid] && obj[uid].isRoot) ||
    Object.keys(obj)[0] ||
    null
  )
}

function findParentUid(obj, targetUid) {
  return (
    Object.keys(obj).find(uid =>
      (obj[uid] && obj[uid].children || []).includes(targetUid)
    ) || null
  )
}

function treeToObject(tree) {
  const res = {}
  const walk = (root, parent) => {
    if (!root || !root.data) return
    const uid = root.data.uid || createUid()
    root.data.uid = uid
    if (parent) parent.children.push(uid)
    res[uid] = {
      isRoot: !parent,
      data: { ...root.data, uid },
      children: []
    }
    ;(root.children || []).forEach(child => walk(child, res[uid]))
  }
  walk(clone(tree), null)
  return res
}

function objectToTree(obj) {
  const rootUid = findRootUid(obj)
  if (!rootUid || !obj[rootUid]) return null
  const map = {}
  const walk = uid => {
    if (map[uid]) return map[uid]
    const cur = obj[uid]
    if (!cur) return null
    const node = {
      data: clone(cur.data || {}),
      children: []
    }
    map[uid] = node
    ;(cur.children || []).forEach(childUid => {
      const child = walk(childUid)
      if (child) node.children.push(child)
    })
    return node
  }
  return walk(rootUid)
}

function applyObjectToDoc(ydoc, obj) {
  const ymap = ydoc.getMap()
  ydoc.transact(() => {
    const keep = new Set(Object.keys(obj))
    Object.keys(obj).forEach(uid => {
      ymap.set(uid, clone(obj[uid]))
    })
    ;[...ymap.keys()].forEach(uid => {
      if (!keep.has(uid)) ymap.delete(uid)
    })
  })
}

function collectDescendants(obj, uid) {
  const out = []
  const walk = id => {
    out.push(id)
    const node = obj[id]
    if (!node) return
    ;(node.children || []).forEach(walk)
  }
  walk(uid)
  return out
}

function nodePath(obj, uid) {
  const parts = []
  let current = uid
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    const node = obj[current]
    if (!node) break
    parts.unshift(stripHtml(node.data && node.data.text) || current)
    if (node.isRoot) break
    current = findParentUid(obj, current)
  }
  return parts.join(' / ')
}

function flattenNodes(obj) {
  return Object.keys(obj).map(uid => ({
    uid,
    text: stripHtml(obj[uid].data && obj[uid].data.text),
    note: obj[uid].data && obj[uid].data.note ? String(obj[uid].data.note) : '',
    isRoot: !!obj[uid].isRoot,
    parent_uid: findParentUid(obj, uid),
    children: obj[uid].children || [],
    path: nodePath(obj, uid)
  }))
}

function toOutline(obj) {
  const rootUid = findRootUid(obj)
  if (!rootUid) return '(空导图)'
  const lines = []
  const walk = (uid, depth) => {
    const node = obj[uid]
    if (!node) return
    const text = stripHtml(node.data && node.data.text) || '(无标题)'
    const prefix = depth === 0 ? '# ' : `${'  '.repeat(depth - 1)}- `
    lines.push(`${prefix}${text}  [${uid}]`)
    ;(node.children || []).forEach(child => walk(child, depth + 1))
  }
  walk(rootUid, 0)
  return lines.join('\n')
}

function resolveNode(obj, ref) {
  if (!ref || ref === 'root' || ref === '/') return findRootUid(obj)
  if (obj[ref]) return ref
  const raw = String(ref).trim()
  if (!raw) return findRootUid(obj)

  if (raw.includes('/')) {
    const byPath = raw
      .split('/')
      .map(part => stripHtml(part))
      .filter(Boolean)
    let current = findRootUid(obj)
    let start = 0
    const rootText = stripHtml(
      obj[current] && obj[current].data && obj[current].data.text
    )
    if (byPath[0] === rootText) start = 1
    let ok = true
    for (let i = start; i < byPath.length; i++) {
      const node = obj[current]
      const next =
        node &&
        (node.children || []).find(childUid => {
          const child = obj[childUid]
          return stripHtml(child && child.data && child.data.text) === byPath[i]
        })
      if (!next) {
        ok = false
        break
      }
      current = next
    }
    if (ok && current) return current
  }

  const matches = Object.keys(obj).filter(uid => {
    return stripHtml(obj[uid].data && obj[uid].data.text) === stripHtml(raw)
  })
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`有 ${matches.length} 个同名节点「${raw}」，请改用 uid`)
  }
  return null
}

function ensureRoot(obj, title) {
  if (findRootUid(obj)) return obj
  const tree = createEmptyTree(title)
  return treeToObject(tree)
}

function addNode(obj, { parent, text, note } = {}) {
  const next = clone(obj)
  const parentUid = resolveNode(next, parent)
  if (!parentUid || !next[parentUid]) {
    throw new Error('找不到父节点，请先 get_map 查看 uid 或路径')
  }
  const uid = createUid()
  const data = {
    uid,
    text: String(text || '新节点'),
    expand: true
  }
  if (note) data.note = String(note)
  next[uid] = {
    isRoot: false,
    data,
    children: []
  }
  next[parentUid] = {
    ...next[parentUid],
    children: [...(next[parentUid].children || []), uid]
  }
  return { obj: next, uid, parent_uid: parentUid }
}

function updateNode(obj, ref, patch = {}) {
  const next = clone(obj)
  const uid = resolveNode(next, ref)
  if (!uid || !next[uid]) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  const data = { ...next[uid].data }
  if (patch.text !== undefined) data.text = String(patch.text)
  if (patch.note !== undefined) data.note = String(patch.note)
  next[uid] = { ...next[uid], data }
  return { obj: next, uid }
}

function deleteNode(obj, ref) {
  const next = clone(obj)
  const uid = resolveNode(next, ref)
  if (!uid || !next[uid]) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  if (next[uid].isRoot) {
    throw new Error('不能删除根节点')
  }
  const parentUid = findParentUid(next, uid)
  const removed = collectDescendants(next, uid)
  if (parentUid && next[parentUid]) {
    next[parentUid] = {
      ...next[parentUid],
      children: (next[parentUid].children || []).filter(id => id !== uid)
    }
  }
  removed.forEach(id => {
    delete next[id]
  })
  return { obj: next, uid, removed }
}

function searchNodes(obj, query) {
  const q = stripHtml(query).toLowerCase()
  if (!q) return []
  return flattenNodes(obj).filter(item => {
    return (
      item.text.toLowerCase().includes(q) ||
      item.note.toLowerCase().includes(q) ||
      item.path.toLowerCase().includes(q)
    )
  })
}

module.exports = {
  createUid,
  createEmptyTree,
  readObject,
  findRootUid,
  treeToObject,
  objectToTree,
  applyObjectToDoc,
  flattenNodes,
  toOutline,
  resolveNode,
  ensureRoot,
  addNode,
  updateNode,
  deleteNode,
  searchNodes,
  nodePath,
  stripHtml
}
