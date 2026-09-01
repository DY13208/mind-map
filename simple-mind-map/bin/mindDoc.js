const crypto = require('crypto')
const { applyObjectToDoc: applyCollaborativeObject } = require('./collabYjs')

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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function nodePlainText(obj, uid) {
  return stripHtml(obj[uid] && obj[uid].data && obj[uid].data.text)
}

function applyNodeText(data, text) {
  const next = String(text)
  if (data && data.richText) {
    const prev = String(data.text || '')
    const escaped = escapeHtml(next)
    if (/<span\b/i.test(prev)) {
      const replaced = prev.replace(
        /(<span\b[^>]*>)[\s\S]*?(<\/span>)/i,
        `$1${escaped}$2`
      )
      data.text =
        replaced !== prev ? replaced : `<p><span>${escaped}</span></p>`
    } else {
      data.text = `<p><span>${escaped}</span></p>`
    }
    data.resetRichText = true
    return
  }
  data.text = next
}

function uniqueMatch(uids, label, kind) {
  if (uids.length === 1) return uids[0]
  if (uids.length > 1) {
    throw new Error(
      `有 ${uids.length} 个${kind}「${label}」，请改用更完整文字或 uid`
    )
  }
  return null
}

function matchLabel(uids, getText, label) {
  const needle = stripHtml(label)
  if (!needle) return null
  const exact = uids.filter(uid => getText(uid) === needle)
  const exactHit = uniqueMatch(exact, label, '同名节点')
  if (exactHit) return exactHit
  const fuzzy = uids.filter(uid => getText(uid).includes(needle))
  return uniqueMatch(fuzzy, label, '包含该文字的节点')
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

function findParentUid(obj, targetUid, parentOf) {
  if (parentOf) return parentOf[targetUid] || null
  return (
    Object.keys(obj).find(uid =>
      ((obj[uid] && obj[uid].children) || []).includes(targetUid)
    ) || null
  )
}

function buildParentMap(obj) {
  const parentOf = {}
  Object.keys(obj).forEach(uid => {
    const children = (obj[uid] && obj[uid].children) || []
    children.forEach(child => {
      parentOf[child] = uid
    })
  })
  return parentOf
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

function collapseDeepNodes(root, keepDepth = 2) {
  const stack = root ? [{ node: root, depth: 0 }] : []
  while (stack.length) {
    const { node, depth } = stack.pop()
    if (!node || !node.data) continue
    const children = node.children || []
    if (depth >= keepDepth && children.length > 0) {
      node.data.expand = false
    }
    for (let i = 0; i < children.length; i++) {
      stack.push({ node: children[i], depth: depth + 1 })
    }
  }
}

const LARGE_MAP_AT = 200
const HTTP_COLLAB_AT = 200
const CLIP_JSON_AT = 1500
const MAX_PREVIEW_CHILDREN = 120
const MAX_SUBTREE_CHILDREN = 200
const MAX_SEARCH_HITS = 80
const MAX_NODE_FETCH = 200

function stripHeavyFields(data) {
  if (!data || typeof data !== 'object') return data || {}
  const next = { ...data }
  delete next.imgMap
  return next
}

function stubChild(obj, uid) {
  const cur = obj[uid]
  if (!cur) return null
  const kids = cur.children || []
  return {
    data: {
      ...stripHeavyFields(clone(cur.data || {})),
      uid,
      expand: false,
      childCount: kids.length
    },
    children: []
  }
}

function objectToTreeLimited(obj, keepDepth = 2, options = {}) {
  const maxChildren =
    Number(options.maxChildren) > 0
      ? Number(options.maxChildren)
      : MAX_PREVIEW_CHILDREN
  const rootUid = findRootUid(obj)
  if (!rootUid || !obj[rootUid]) return null
  const walk = (uid, depth) => {
    const cur = obj[uid]
    if (!cur) return null
    const childUids = cur.children || []
    const node = {
      data: stripHeavyFields(clone(cur.data || {})),
      children: []
    }
    node.data.uid = uid
    node.data.childCount = childUids.length
    if (depth >= keepDepth) {
      node.data.expand = false
      return node
    }
    const shown = childUids.slice(0, maxChildren)
    node.children = shown
      .map(childUid => walk(childUid, depth + 1))
      .filter(Boolean)
    if (childUids.length > shown.length) node.data.hasMore = true
    return node
  }
  return walk(rootUid, 0)
}

function buildPreview(obj, options = {}) {
  const keepDepth = Number(options.keepDepth) > 0 ? Number(options.keepDepth) : 2
  const largeAt = Number(options.largeAt) > 0 ? Number(options.largeAt) : LARGE_MAP_AT
  const clipAt = Number(options.clipAt) > 0 ? Number(options.clipAt) : CLIP_JSON_AT
  const nodeCount = Object.keys(obj || {}).length
  const collapsed = nodeCount >= largeAt
  const clipped = nodeCount >= clipAt
  let tree
  if (clipped) {
    tree = objectToTreeLimited(obj, keepDepth, { maxChildren: options.maxChildren })
  } else {
    tree = objectToTree(obj)
    if (collapsed && tree) collapseDeepNodes(tree, keepDepth)
  }
  if (tree && tree.data) delete tree.data.imgMap
  return {
    tree,
    node_count: nodeCount,
    collapsed,
    clipped,
    http_collab: nodeCount >= HTTP_COLLAB_AT
  }
}

function subtreeChildren(obj, uid, options = {}) {
  const cur = obj[uid]
  if (!cur) return null
  const childUids = cur.children || []
  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Math.min(
    500,
    Math.max(1, Number(options.limit) || MAX_SUBTREE_CHILDREN)
  )
  const slice = childUids.slice(offset, offset + limit)
  return {
    uid,
    total: childUids.length,
    offset,
    has_more: offset + slice.length < childUids.length,
    children: slice.map(id => stubChild(obj, id)).filter(Boolean)
  }
}

function nodesByUids(obj, uids) {
  const list = Array.isArray(uids) ? uids : []
  return list
    .slice(0, MAX_NODE_FETCH)
    .map(uid => {
      const cur = obj[uid]
      if (!cur) return null
      return {
        uid,
        isRoot: !!cur.isRoot,
        data: stripHeavyFields(clone(cur.data || {})),
        children: cur.children || []
      }
    })
    .filter(Boolean)
}

function locateNode(obj, ref) {
  const uid = resolveNode(obj, ref)
  if (!uid || !obj[uid]) return null
  const parentOf = buildParentMap(obj)
  const ancestors = []
  let current = uid
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    ancestors.unshift(current)
    if (obj[current] && obj[current].isRoot) break
    current = parentOf[current]
  }
  const nodes = {}
  ancestors.forEach(id => {
    const stub = stubChild(obj, id)
    if (!stub) return
    if (obj[id] && obj[id].isRoot) stub.data.expand = true
    nodes[id] = stub
  })
  return {
    uid,
    ancestors,
    path: nodePath(obj, uid, parentOf),
    nodes
  }
}

function objectToTree(obj, options = {}) {
  const maxNodes = Number(options.maxNodes) > 0 ? Number(options.maxNodes) : 0
  const stats = options.stats || {}
  const rootUid = findRootUid(obj)
  if (!rootUid || !obj[rootUid]) return null
  const map = {}
  let count = 0
  let truncated = false
  const walk = uid => {
    if (map[uid]) return map[uid]
    if (maxNodes && count >= maxNodes) {
      truncated = true
      return null
    }
    const cur = obj[uid]
    if (!cur) return null
    count += 1
    const node = {
      data: clone(cur.data || {}),
      children: []
    }
    map[uid] = node
    ;(cur.children || []).forEach(childUid => {
      if (maxNodes && count >= maxNodes) {
        truncated = true
        return
      }
      const child = walk(childUid)
      if (child) node.children.push(child)
    })
    return node
  }
  const tree = walk(rootUid)
  stats.count = count
  stats.truncated = truncated
  stats.node_count = Object.keys(obj).length
  return tree
}

function applyObjectToDoc(ydoc, obj, options = {}) {
  applyCollaborativeObject(ydoc, obj, options)
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

function nodePath(obj, uid, parentOf) {
  const parents = parentOf || buildParentMap(obj)
  const parts = []
  let current = uid
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    const node = obj[current]
    if (!node) break
    parts.unshift(stripHtml(node.data && node.data.text) || current)
    if (node.isRoot) break
    current = parents[current]
  }
  return parts.join(' / ')
}

function flattenNodes(obj) {
  const parentOf = buildParentMap(obj)
  return Object.keys(obj).map(uid => ({
    uid,
    text: stripHtml(obj[uid].data && obj[uid].data.text),
    note: obj[uid].data && obj[uid].data.note ? String(obj[uid].data.note) : '',
    isRoot: !!obj[uid].isRoot,
    parent_uid: parentOf[uid] || null,
    children: obj[uid].children || [],
    path: nodePath(obj, uid, parentOf)
  }))
}

function toOutline(obj, options = {}) {
  const maxNodes = Number(options.maxNodes) > 0 ? Number(options.maxNodes) : 0
  const rootUid = findRootUid(obj)
  if (!rootUid) return '(空导图)'
  const lines = []
  let count = 0
  let truncated = false
  const walk = (uid, depth) => {
    if (maxNodes && count >= maxNodes) {
      truncated = true
      return
    }
    const node = obj[uid]
    if (!node) return
    count += 1
    const text = stripHtml(node.data && node.data.text) || '(无标题)'
    const prefix = depth === 0 ? '# ' : `${'  '.repeat(depth - 1)}- `
    lines.push(`${prefix}${text}  [${uid}]`)
    ;(node.children || []).forEach(child => walk(child, depth + 1))
  }
  walk(rootUid, 0)
  if (truncated) {
    lines.push(
      `\n… truncated at ${maxNodes} nodes. Use search_nodes or get_map format=nodes with uid.`
    )
  }
  return lines.join('\n')
}

function resolveNode(obj, ref) {
  if (!ref || ref === 'root' || ref === '/') return findRootUid(obj)
  if (obj[ref]) return ref
  const raw = String(ref).trim()
  if (!raw) return findRootUid(obj)
  const getText = uid => nodePlainText(obj, uid)

  if (raw.includes('/')) {
    const byPath = raw
      .split('/')
      .map(part => stripHtml(part))
      .filter(Boolean)
    let current = findRootUid(obj)
    let start = 0
    const rootText = getText(current)
    if (byPath[0] === rootText || (rootText && rootText.includes(byPath[0]))) {
      start = 1
    }
    let ok = true
    for (let i = start; i < byPath.length; i++) {
      const node = obj[current]
      const children = (node && node.children) || []
      const next = matchLabel(children, getText, byPath[i])
      if (!next) {
        ok = false
        break
      }
      current = next
    }
    if (ok && current) return current
  }

  return matchLabel(Object.keys(obj), getText, raw)
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
  const parentData = next[parentUid].data || {}
  const data = {
    uid,
    text: String(text || '新节点'),
    expand: true
  }
  if (parentData.richText) {
    data.richText = true
    applyNodeText(data, data.text)
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
  if (patch.text !== undefined) applyNodeText(data, patch.text)
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

function ymapOf(ydoc) {
  return ydoc.getMap()
}

function findRootUidInDoc(ydoc) {
  const ymap = ymapOf(ydoc)
  let found = ''
  ymap.forEach((value, key) => {
    if (found) return
    if (value && typeof value.get === 'function' && value.get('isRoot')) {
      found = key
    }
  })
  return found || null
}

function nodePlainFromDoc(ymap, uid) {
  const n = ymap.get(uid)
  if (!n || typeof n.get !== 'function') return ''
  const data = n.get('data')
  if (!data || typeof data.get !== 'function') return ''
  const text = data.get('text')
  const raw =
    text && typeof text.toString === 'function' ? text.toString() : String(text || '')
  return stripHtml(raw)
}

function childrenFromDoc(ymap, uid) {
  const n = ymap.get(uid)
  if (!n || typeof n.get !== 'function') return []
  const ch = n.get('children')
  if (ch && typeof ch.toArray === 'function') return ch.toArray()
  return []
}

function nodeJsonFromDoc(ymap, uid) {
  const n = ymap.get(uid)
  if (!n || typeof n.toJSON !== 'function') return null
  return n.toJSON()
}

function resolveNodeInDoc(ydoc, ref) {
  const ymap = ymapOf(ydoc)
  if (!ref || ref === 'root' || ref === '/') return findRootUidInDoc(ydoc)
  if (ymap.has(ref)) return ref
  const raw = String(ref).trim()
  if (!raw) return findRootUidInDoc(ydoc)
  const getText = uid => nodePlainFromDoc(ymap, uid)
  if (raw.includes('/')) {
    const byPath = raw.split('/').map(part => stripHtml(part)).filter(Boolean)
    let current = findRootUidInDoc(ydoc)
    let start = 0
    const rootText = getText(current)
    if (byPath[0] === rootText || (rootText && rootText.includes(byPath[0]))) {
      start = 1
    }
    for (let i = start; i < byPath.length; i++) {
      const next = matchLabel(childrenFromDoc(ymap, current), getText, byPath[i])
      if (!next) return null
      current = next
    }
    return current
  }
  return matchLabel(Array.from(ymap.keys()), getText, raw)
}

function findParentInDoc(ymap, uid) {
  let parent = ''
  ymap.forEach((value, key) => {
    if (parent || key === uid || !value || typeof value.get !== 'function') return
    const ch = value.get('children')
    if (ch && typeof ch.toArray === 'function' && ch.toArray().includes(uid)) {
      parent = key
    }
  })
  return parent || null
}

function collectDescendantsInDoc(ymap, uid) {
  const out = []
  const walk = id => {
    out.push(id)
    childrenFromDoc(ymap, id).forEach(walk)
  }
  walk(uid)
  return out
}

function insertChildUid(list, uid, index) {
  const next = Array.isArray(list) ? list.filter(id => id !== uid) : []
  const max = next.length
  let i = index == null || index === '' ? max : Number(index)
  if (!Number.isFinite(i) || i < 0) i = max
  if (i > max) i = max
  next.splice(i, 0, uid)
  return next
}

function addNodeOnDoc(ydoc, { parent, text, note, uid: clientUid, index } = {}) {
  const ymap = ymapOf(ydoc)
  const parentUid = resolveNodeInDoc(ydoc, parent)
  if (!parentUid || !ymap.has(parentUid)) {
    throw new Error('找不到父节点，请先 get_map 查看 uid 或路径')
  }
  const parentJson = nodeJsonFromDoc(ymap, parentUid)
  const uid = String(clientUid || '').trim() || createUid()
  if (ymap.has(uid)) {
    throw new Error('节点已存在')
  }
  const parentData = (parentJson && parentJson.data) || {}
  const data = {
    uid,
    text: String(text || '新节点'),
    expand: true
  }
  if (parentData.richText) {
    data.richText = true
    applyNodeText(data, data.text)
  }
  if (note) data.note = String(note)
  const previousObject = { [parentUid]: parentJson }
  const nextObject = {
    [parentUid]: {
      ...parentJson,
      children: insertChildUid(
        (parentJson && parentJson.children) || [],
        uid,
        index
      )
    },
    [uid]: {
      isRoot: false,
      data,
      children: []
    }
  }
  applyObjectToDoc(ydoc, nextObject, { previousObject })
  return { uid, parent_uid: parentUid }
}

const NODE_DATA_PATCH_KEYS = [
  'note',
  'image',
  'imageTitle',
  'imageSize',
  'icon',
  'tag',
  'hyperlink',
  'hyperlinkTitle',
  'outerFrame',
  'generalization',
  'formula',
  'attachmentUrl',
  'attachmentName'
]

function updateNodeOnDoc(ydoc, ref, patch = {}) {
  const ymap = ymapOf(ydoc)
  const uid = resolveNodeInDoc(ydoc, ref)
  if (!uid || !ymap.has(uid)) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  const prev = nodeJsonFromDoc(ymap, uid)
  const data = { ...(prev.data || {}) }
  if (patch.text !== undefined) applyNodeText(data, patch.text)
  NODE_DATA_PATCH_KEYS.forEach(key => {
    if (patch[key] !== undefined) data[key] = patch[key]
  })
  applyObjectToDoc(
    ydoc,
    { [uid]: { ...prev, data } },
    { previousObject: { [uid]: prev } }
  )
  return { uid }
}

function moveNodeOnDoc(ydoc, { uid: ref, parent: parentRef, index } = {}) {
  const ymap = ymapOf(ydoc)
  const uid = resolveNodeInDoc(ydoc, ref)
  if (!uid || !ymap.has(uid)) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  const json = nodeJsonFromDoc(ymap, uid)
  if (json && json.isRoot) {
    throw new Error('不能移动根节点')
  }
  const oldParentUid = findParentInDoc(ymap, uid)
  const newParentUid = parentRef
    ? resolveNodeInDoc(ydoc, parentRef)
    : oldParentUid
  if (!newParentUid || !ymap.has(newParentUid)) {
    throw new Error('找不到父节点，请先 get_map 查看 uid 或路径')
  }
  if (newParentUid === uid) {
    throw new Error('不能把节点移动到自己下面')
  }
  const descendants = collectDescendantsInDoc(ymap, uid)
  if (descendants.includes(newParentUid)) {
    throw new Error('不能把节点移动到自己的子节点下')
  }
  const patch = {}
  const previousObject = {}
  if (oldParentUid && oldParentUid !== newParentUid) {
    const oldParent = nodeJsonFromDoc(ymap, oldParentUid)
    previousObject[oldParentUid] = oldParent
    patch[oldParentUid] = {
      ...oldParent,
      children: ((oldParent && oldParent.children) || []).filter(id => id !== uid)
    }
  }
  const newParent = nodeJsonFromDoc(ymap, newParentUid)
  previousObject[newParentUid] = newParent
  const from =
    oldParentUid === newParentUid
      ? (newParent && newParent.children) || []
      : ((patch[newParentUid] && patch[newParentUid].children) ||
          (newParent && newParent.children) ||
          [])
  patch[newParentUid] = {
    ...newParent,
    children: insertChildUid(from, uid, index)
  }
  applyObjectToDoc(ydoc, patch, { previousObject })
  return { uid, parent_uid: newParentUid }
}

function deleteCurrentNodeOnDoc(ydoc, ref) {
  const ymap = ymapOf(ydoc)
  const uid = resolveNodeInDoc(ydoc, ref)
  if (!uid || !ymap.has(uid)) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  const json = nodeJsonFromDoc(ymap, uid)
  if (json && json.isRoot) {
    throw new Error('不能删除根节点')
  }
  const parentUid = findParentInDoc(ymap, uid)
  if (!parentUid || !ymap.has(parentUid)) {
    throw new Error('找不到父节点')
  }
  const parentJson = nodeJsonFromDoc(ymap, parentUid)
  const childUids = (json && json.children) || []
  const nextChildren = []
  ;((parentJson && parentJson.children) || []).forEach(id => {
    if (id === uid) nextChildren.push(...childUids)
    else nextChildren.push(id)
  })
  applyObjectToDoc(
    ydoc,
    {
      [parentUid]: {
        ...parentJson,
        children: nextChildren
      }
    },
    {
      previousObject: { [parentUid]: parentJson },
      deleteUids: [uid]
    }
  )
  return { uid, parent_uid: parentUid, promoted: childUids }
}

function deleteNodeOnDoc(ydoc, ref) {
  const ymap = ymapOf(ydoc)
  const uid = resolveNodeInDoc(ydoc, ref)
  if (!uid || !ymap.has(uid)) {
    throw new Error('找不到节点，请先 get_map 查看 uid 或路径')
  }
  const json = nodeJsonFromDoc(ymap, uid)
  if (json && json.isRoot) {
    throw new Error('不能删除根节点')
  }
  const parentUid = findParentInDoc(ymap, uid)
  const removed = collectDescendantsInDoc(ymap, uid)
  const patch = {}
  const previousObject = {}
  if (parentUid) {
    const parentJson = nodeJsonFromDoc(ymap, parentUid)
    previousObject[parentUid] = parentJson
    patch[parentUid] = {
      ...parentJson,
      children: ((parentJson && parentJson.children) || []).filter(id => id !== uid)
    }
  }
  applyObjectToDoc(ydoc, patch, { previousObject, deleteUids: removed })
  return { uid, removed }
}

function searchNodes(obj, query, options = {}) {
  const q = stripHtml(query).toLowerCase()
  if (!q) return []
  const limit =
    Number(options.limit) > 0 ? Number(options.limit) : MAX_SEARCH_HITS
  const parentOf = buildParentMap(obj)
  const matches = []
  const uids = Object.keys(obj || {})
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i]
    const text = stripHtml(obj[uid].data && obj[uid].data.text)
    const note = obj[uid].data && obj[uid].data.note ? String(obj[uid].data.note) : ''
    if (
      !text.toLowerCase().includes(q) &&
      !note.toLowerCase().includes(q)
    ) {
      continue
    }
    matches.push({
      uid,
      text,
      note,
      isRoot: !!obj[uid].isRoot,
      parent_uid: parentOf[uid] || null,
      children: obj[uid].children || [],
      path: nodePath(obj, uid, parentOf)
    })
    if (limit && matches.length >= limit) break
  }
  return matches
}

function baseLabel(text) {
  return stripHtml(text)
    .replace(/\s*[（(]\s*\d+\s*[）)]\s*$/, '')
    .trim()
}

function childWithLabel(obj, parentUid, labels) {
  const accepted = new Set(labels.map(label => String(label).toLowerCase()))
  const children = (obj[parentUid] && obj[parentUid].children) || []
  const matches = children.filter(uid =>
    accepted.has(baseLabel(nodePlainText(obj, uid)).toLowerCase())
  )
  return uniqueMatch(matches, labels.join('/'), '匹配结构的节点')
}

function findTodoBranches(obj) {
  const candidates = Object.keys(obj).filter(uid => {
    if (baseLabel(nodePlainText(obj, uid)) !== '待办') return false
    const children = (obj[uid] && obj[uid].children) || []
    const labels = children.map(childUid =>
      baseLabel(nodePlainText(obj, childUid))
    )
    return labels.includes('待办') && labels.includes('已完成')
  })
  const containerUid = uniqueMatch(candidates, '待办', '待办容器')
  if (!containerUid) {
    throw new Error('找不到同时包含「待办」和「已完成」的待办容器')
  }
  return {
    container_uid: containerUid,
    pending_uid: childWithLabel(obj, containerUid, ['待办']),
    completed_uid: childWithLabel(obj, containerUid, ['已完成'])
  }
}

function subtreePayload(obj, uid) {
  const node = obj[uid]
  if (!node) return null
  return {
    uid,
    text: nodePlainText(obj, uid),
    note: node.data && node.data.note ? String(node.data.note) : '',
    children: (node.children || [])
      .map(childUid => subtreePayload(obj, childUid))
      .filter(Boolean)
  }
}

function listTodos(obj) {
  const branches = findTodoBranches(obj)
  return {
    ...branches,
    pending: (obj[branches.pending_uid].children || [])
      .map(uid => subtreePayload(obj, uid))
      .filter(Boolean),
    completed: (obj[branches.completed_uid].children || [])
      .map(uid => subtreePayload(obj, uid))
      .filter(Boolean)
  }
}

function resolveDirectChild(obj, parentUid, ref) {
  const children = (obj[parentUid] && obj[parentUid].children) || []
  if (obj[ref] && children.includes(ref)) return ref
  return matchLabel(children, uid => nodePlainText(obj, uid), ref)
}

function findSopRootUid(obj) {
  const matches = Object.keys(obj).filter(
    uid => baseLabel(nodePlainText(obj, uid)).toLowerCase() === 'sop'
  )
  const uid = uniqueMatch(matches, 'SOP', 'SOP根节点')
  if (!uid) throw new Error('找不到SOP根节点')
  return uid
}

function isWithinSop(obj, ref) {
  let sopRootUid
  try {
    sopRootUid = findSopRootUid(obj)
  } catch (err) {
    return false
  }
  const uid = resolveNode(obj, ref)
  if (!uid) return false
  return uid === sopRootUid || isDescendantOf(obj, uid, sopRootUid)
}

function isWithinSopOnDoc(ydoc, ref) {
  try {
    const ymap = ymapOf(ydoc)
    const matches = []
    ymap.forEach((_, uid) => {
      if (baseLabel(nodePlainFromDoc(ymap, uid)).toLowerCase() === 'sop') {
        matches.push(uid)
      }
    })
    const sopRootUid = uniqueMatch(matches, 'SOP', 'SOP根节点')
    if (!sopRootUid) return false
    const uid = resolveNodeInDoc(ydoc, ref)
    if (!uid) return false
    if (uid === sopRootUid) return true
    return collectDescendantsInDoc(ymap, sopRootUid).slice(1).includes(uid)
  } catch (err) {
    return false
  }
}

function descendantUids(obj, uid) {
  return collectDescendants(obj, uid).slice(1)
}

function isDescendantOf(obj, uid, ancestorUid) {
  return uid !== ancestorUid && descendantUids(obj, ancestorUid).includes(uid)
}

function sectionUid(obj, goalUid, kind) {
  const aliases =
    kind === 'check' ? ['c', 'check', '检查', '目标'] : ['p', 'plan', '计划']
  const children = (obj[goalUid] && obj[goalUid].children) || []
  for (const alias of aliases) {
    const matches = children.filter(
      uid => baseLabel(nodePlainText(obj, uid)).toLowerCase() === alias
    )
    const match = uniqueMatch(matches, alias, 'SOP分区')
    if (match) return match
  }
  return null
}

function sectionItems(obj, sectionRootUid) {
  const result = []
  const walk = (uid, depth) => {
    const node = obj[uid]
    if (!node) return
    result.push({
      uid,
      text: nodePlainText(obj, uid),
      note: node.data && node.data.note ? String(node.data.note) : '',
      depth,
      leaf: !(node.children || []).length
    })
    ;(node.children || []).forEach(childUid => walk(childUid, depth + 1))
  }
  ;((obj[sectionRootUid] && obj[sectionRootUid].children) || []).forEach(uid =>
    walk(uid, 0)
  )
  return result
}

function sopVersion(obj, goalUid) {
  const payload = collectDescendants(obj, goalUid).map(uid => ({
    uid,
    text: nodePlainText(obj, uid),
    note: obj[uid].data && obj[uid].data.note ? String(obj[uid].data.note) : '',
    children: obj[uid].children || []
  }))
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16)
}

function sopCandidate(obj, goalUid, parentOf) {
  const checkUid = sectionUid(obj, goalUid, 'check')
  const planUid = sectionUid(obj, goalUid, 'plan')
  if (!checkUid || !planUid) return null
  const check = sectionItems(obj, checkUid)
  const plan = sectionItems(obj, planUid)
  return {
    uid: goalUid,
    text: nodePlainText(obj, goalUid),
    path: nodePath(obj, goalUid, parentOf),
    version: sopVersion(obj, goalUid),
    check_root_uid: checkUid,
    plan_root_uid: planUid,
    check,
    plan,
    required_check_uids: check.filter(item => item.leaf).map(item => item.uid)
  }
}

function listSopCandidates(obj) {
  const sopRootUid = findSopRootUid(obj)
  const parentOf = buildParentMap(obj)
  return descendantUids(obj, sopRootUid)
    .map(uid => sopCandidate(obj, uid, parentOf))
    .filter(Boolean)
}

const MATCH_STOP_WORDS = new Set([
  '一个',
  '一下',
  '公司',
  '任务',
  '处理',
  '完成',
  '需要',
  '目标',
  '计划',
  '帮忙'
])

function matchTerms(text) {
  const normalized = stripHtml(text).toLowerCase()
  const segments = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || []
  const terms = new Set()
  segments.forEach(segment => {
    if (/^[a-z0-9]+$/.test(segment)) {
      if (segment.length >= 2) terms.add(segment)
      return
    }
    if (segment.length >= 2 && segment.length <= 8) terms.add(segment)
    for (let size = 2; size <= Math.min(4, segment.length); size++) {
      for (let index = 0; index <= segment.length - size; index++) {
        terms.add(segment.slice(index, index + size))
      }
    }
  })
  MATCH_STOP_WORDS.forEach(term => terms.delete(term))
  return terms
}

function scoreSopCandidate(taskText, candidate) {
  const taskTerms = matchTerms(taskText)
  const targetTerms = matchTerms(candidate.text)
  const pathTerms = matchTerms(candidate.path)
  const detailTerms = matchTerms(
    [...candidate.check, ...candidate.plan].map(item => item.text).join(' ')
  )
  let score = 0
  const matched = []
  taskTerms.forEach(term => {
    let weight = 0
    if (targetTerms.has(term)) weight = Math.max(weight, 8)
    if (pathTerms.has(term)) weight = Math.max(weight, 4)
    if (detailTerms.has(term)) weight = Math.max(weight, 1)
    if (weight) {
      score += weight + Math.max(0, term.length - 2)
      matched.push(term)
    }
  })
  return { score, matched_terms: matched.sort((a, b) => b.length - a.length) }
}

function resolveSopCandidate(obj, ref) {
  const candidates = listSopCandidates(obj)
  if (obj[ref]) {
    const direct = candidates.find(candidate => candidate.uid === ref)
    if (direct) return direct
  }
  const matches = candidates.filter(candidate => {
    const needle = stripHtml(ref)
    return candidate.text === needle || candidate.path === needle
  })
  const exact = uniqueMatch(
    matches.map(item => item.uid),
    ref,
    'SOP目标'
  )
  if (exact) return candidates.find(candidate => candidate.uid === exact)
  const fuzzy = candidates.filter(candidate =>
    `${candidate.text} ${candidate.path}`.includes(stripHtml(ref))
  )
  const fuzzyUid = uniqueMatch(
    fuzzy.map(item => item.uid),
    ref,
    'SOP目标'
  )
  return fuzzyUid
    ? candidates.find(candidate => candidate.uid === fuzzyUid)
    : null
}

function prepareTodo(obj, taskRef, sopRef) {
  const branches = findTodoBranches(obj)
  const pendingUid = resolveDirectChild(obj, branches.pending_uid, taskRef)
  const completedUid = resolveDirectChild(obj, branches.completed_uid, taskRef)
  if (pendingUid && completedUid) {
    throw new Error('待办和已完成中存在同名任务，请改用待办任务uid')
  }
  const taskUid = pendingUid || completedUid
  if (!taskUid) throw new Error('在待办或已完成中找不到该任务')
  const task = subtreePayload(obj, taskUid)
  if (completedUid) {
    return {
      task,
      location: '已完成',
      match_status: 'already_completed',
      matched_sop: null,
      alternatives: []
    }
  }

  if (sopRef) {
    const selected = resolveSopCandidate(obj, sopRef)
    if (!selected) throw new Error('找不到同时包含C和P的指定SOP目标')
    return {
      task,
      location: '待办',
      match_status: 'matched',
      matched_sop: selected,
      alternatives: []
    }
  }

  const taskText = [task.text, task.note]
    .concat(flattenTaskText(task.children))
    .filter(Boolean)
    .join(' ')
  const ranked = listSopCandidates(obj)
    .map(candidate => ({
      ...candidate,
      ...scoreSopCandidate(taskText, candidate)
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const alternatives = ranked.slice(0, 5)
  const top = alternatives[0]
  const second = alternatives[1]
  const ambiguous =
    !top || top.score <= 0 || (second && top.score - second.score < 3)
  return {
    task,
    location: '待办',
    match_status:
      !top || top.score <= 0
        ? 'not_found'
        : ambiguous
        ? 'needs_confirmation'
        : 'matched',
    matched_sop: ambiguous ? null : top,
    alternatives
  }
}

function flattenTaskText(children) {
  const out = []
  const walk = items => {
    const list = items || []
    list.forEach(item => {
      out.push(item.text, item.note)
      walk(item.children)
    })
  }
  walk(children)
  return out
}

function updateCountInLabel(obj, uid) {
  const node = obj[uid]
  if (!node) return
  const current = nodePlainText(obj, uid)
  if (!/[（(]\s*\d+\s*[）)]\s*$/.test(current)) return
  const count = (node.children || []).length
  const nextText = current.replace(
    /([（(])\s*\d+\s*([）)])\s*$/,
    (all, open, close) => `${open}${count}${close}`
  )
  applyNodeText(node.data, nextText)
}

function completeTodo(obj, options = {}) {
  const next = clone(obj)
  const branches = findTodoBranches(next)
  const completedUid = resolveDirectChild(
    next,
    branches.completed_uid,
    options.task
  )
  const taskUid = resolveDirectChild(next, branches.pending_uid, options.task)
  if (taskUid && completedUid) {
    throw new Error('待办和已完成中存在同名任务，请改用待办任务uid')
  }
  if (completedUid) {
    return { obj: next, task_uid: completedUid, already_completed: true }
  }
  if (!taskUid) throw new Error('在待办中找不到该任务')
  const candidate = resolveSopCandidate(next, options.sop_uid)
  if (!candidate) throw new Error('找不到用于验收的SOP目标')
  if (!candidate.required_check_uids.length) {
    throw new Error('SOP的C下面没有可验收的检查项，不能完成任务')
  }
  if (options.sop_version !== candidate.version) {
    throw new Error('SOP已发生变化，请重新读取任务和SOP后再验收')
  }
  const results = new Map(
    (options.check_results || []).map(item => [item.check_uid, item])
  )
  const missing = candidate.required_check_uids.filter(uid => !results.has(uid))
  const failed = candidate.required_check_uids.filter(uid => {
    const result = results.get(uid)
    return result && result.passed !== true
  })
  if (missing.length || failed.length) {
    throw new Error(
      `C检查未全部通过：缺少 ${missing.length} 项，未通过 ${failed.length} 项`
    )
  }

  next[branches.pending_uid].children = next[
    branches.pending_uid
  ].children.filter(uid => uid !== taskUid)
  next[branches.completed_uid].children = [
    ...(next[branches.completed_uid].children || []),
    taskUid
  ]
  const taskData = { ...(next[taskUid].data || {}) }
  taskData.todoCompletion = {
    completedAt: String(options.completed_at || new Date().toISOString()),
    sopUid: candidate.uid,
    sopVersion: candidate.version,
    summary: String(options.summary || '').trim()
  }
  next[taskUid] = { ...next[taskUid], data: taskData }
  updateCountInLabel(next, branches.pending_uid)
  updateCountInLabel(next, branches.completed_uid)
  return {
    obj: next,
    task_uid: taskUid,
    already_completed: false,
    completed_branch_uid: branches.completed_uid,
    sop_uid: candidate.uid,
    sop_version: candidate.version
  }
}

function normalizeProposalInput(input) {
  return {
    sop_uid: String(input.sop_uid || ''),
    sop_version: String(input.sop_version || ''),
    section: String(input.section || '').toUpperCase(),
    action: String(input.action || ''),
    node_uid: String(input.node_uid || ''),
    content: String(input.content || '').trim(),
    reason: String(input.reason || '').trim()
  }
}

function proposalId(proposal) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeProposalInput(proposal)))
    .digest('hex')
    .slice(0, 20)
}

function proposeSopImprovement(obj, input = {}) {
  const candidate = resolveSopCandidate(obj, input.sop_uid)
  if (!candidate) throw new Error('找不到要完善的SOP目标')
  const proposal = normalizeProposalInput({
    ...input,
    sop_uid: candidate.uid,
    sop_version: candidate.version
  })
  if (!['C', 'P'].includes(proposal.section))
    throw new Error('section必须是C或P')
  if (!['add', 'update', 'delete'].includes(proposal.action)) {
    throw new Error('action必须是add、update或delete')
  }
  if (proposal.action === 'add' && !proposal.content) {
    throw new Error('新增SOP节点时必须提供content')
  }
  if (proposal.action !== 'add' && !proposal.node_uid) {
    throw new Error('修改或删除SOP节点时必须提供node_uid')
  }
  if (proposal.action === 'update' && !proposal.content) {
    throw new Error('修改SOP节点时必须提供content')
  }
  const sectionRoot =
    proposal.section === 'C'
      ? candidate.check_root_uid
      : candidate.plan_root_uid
  if (
    proposal.node_uid &&
    !isDescendantOf(obj, proposal.node_uid, sectionRoot)
  ) {
    throw new Error('node_uid不属于指定SOP的C/P内容节点')
  }
  return { ...proposal, proposal_id: proposalId(proposal) }
}

function applySopImprovement(obj, input = {}) {
  if (input.user_confirmed !== true) {
    throw new Error('必须先在对话中获得用户明确确认')
  }
  const proposal = proposeSopImprovement(obj, input)
  if (proposal.proposal_id !== input.proposal_id) {
    throw new Error('SOP建议内容与proposal_id不一致，请重新生成建议')
  }
  if (proposal.sop_version !== input.sop_version) {
    throw new Error('SOP已发生变化，请重新生成建议')
  }
  const candidate = resolveSopCandidate(obj, proposal.sop_uid)
  const sectionRoot =
    proposal.section === 'C'
      ? candidate.check_root_uid
      : candidate.plan_root_uid
  let result
  if (proposal.action === 'add') {
    result = addNode(obj, { parent: sectionRoot, text: proposal.content })
  } else if (proposal.action === 'update') {
    result = updateNode(obj, proposal.node_uid, { text: proposal.content })
  } else {
    result = deleteNode(obj, proposal.node_uid)
  }
  const updatedCandidate = resolveSopCandidate(result.obj, proposal.sop_uid)
  return {
    obj: result.obj,
    changed_uid: result.uid,
    sop_uid: proposal.sop_uid,
    previous_version: proposal.sop_version,
    sop_version: updatedCandidate.version
  }
}

module.exports = {
  createUid,
  createEmptyTree,
  readObject,
  findRootUid,
  treeToObject,
  objectToTree,
  collapseDeepNodes,
  buildPreview,
  subtreeChildren,
  nodesByUids,
  locateNode,
  LARGE_MAP_AT,
  HTTP_COLLAB_AT,
  CLIP_JSON_AT,
  applyObjectToDoc,
  flattenNodes,
  toOutline,
  resolveNode,
  ensureRoot,
  addNode,
  updateNode,
  deleteNode,
  addNodeOnDoc,
  updateNodeOnDoc,
  moveNodeOnDoc,
  deleteCurrentNodeOnDoc,
  deleteNodeOnDoc,
  searchNodes,
  baseLabel,
  findTodoBranches,
  listTodos,
  listSopCandidates,
  isWithinSop,
  isWithinSopOnDoc,
  prepareTodo,
  completeTodo,
  proposeSopImprovement,
  applySopImprovement,
  nodePath,
  stripHtml
}
