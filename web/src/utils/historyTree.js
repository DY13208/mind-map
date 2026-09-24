export function historyGraphToMindMap(graph) {
  if (graph && graph.data && Array.isArray(graph.children)) {
    return expandNested(graph)
  }
  const nodes = graph && typeof graph === 'object' ? graph : {}
  const rootUid =
    Object.keys(nodes).find(uid => nodes[uid] && nodes[uid].isRoot) ||
    Object.keys(nodes)[0]
  if (!rootUid) {
    return { data: { uid: 'root', text: '未命名', expand: true }, children: [] }
  }
  const seen = new Set()
  function walk(uid) {
    if (!uid || seen.has(uid) || !nodes[uid]) return null
    seen.add(uid)
    const node = nodes[uid]
    const data = Object.assign({}, node.data || {}, { uid })
    if (data.expand == null) data.expand = true
    const children = (node.children || []).map(child =>
      typeof child === 'string' ? walk(child) : expandNested(child)
    ).filter(Boolean)
    return { data, children }
  }
  return walk(rootUid) || expandNested(graph)
}

function expandNested(node) {
  if (!node || typeof node !== 'object') return null
  const data = Object.assign({}, node.data || {}, {
    uid: (node.data && node.data.uid) || node.uid
  })
  if (data.expand == null) data.expand = true
  const children = (node.children || []).map(expandNested).filter(Boolean)
  return { data, children }
}

export function withExpandMode(tree, mode) {
  let clone = { data: { uid: 'root', text: '未命名', expand: true }, children: [] }
  try {
    clone = JSON.parse(JSON.stringify(tree || clone))
  } catch (err) {
    return clone
  }
  function walk(node, depth) {
    if (!node || typeof node !== 'object') return
    if (!node.data) node.data = {}
    if (mode === 'collapsed' || mode === 'overview') node.data.expand = depth === 0
    else node.data.expand = true
    ;(node.children || []).forEach(child => walk(child, depth + 1))
  }
  walk(clone, 0)
  if (clone.data) clone.data.expand = true
  return clone
}

export function formatLocalDateTime(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  )
}

export function historyDisplayName(item) {
  const type = String((item && item.type) || '').toUpperCase()
  const createdAt = item && item.createdAt
  const name = String((item && item.name) || '')
  if (type === 'AUTO') return '自动保存 ' + formatLocalDateTime(createdAt)
  if (type === 'PRE_IMPORT') return '导入前 ' + formatLocalDateTime(createdAt)
  if (type === 'PRE_RESTORE') return '恢复前 ' + formatLocalDateTime(createdAt)
  const match = name.match(
    /^(恢复到) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/
  )
  if (match) {
    if (match[4] != null) return match[1] + ' ' + match[2] + ' ' + match[3]
    return match[1] + ' ' + formatLocalDateTime(match[2] + 'T' + match[3] + ':00.000Z')
  }
  return name || '未命名版本'
}

export function versionTypeLabel(type) {
  const key = String(type || '').toUpperCase()
  if (key === 'AUTO') return '自动'
  if (key === 'MANUAL') return '手动'
  if (key === 'IMPORT') return '导入'
  if (key === 'PRE_IMPORT') return '导入前备份'
  if (key === 'PRE_RESTORE') return '恢复前备份'
  if (key === 'RESTORE') return '恢复记录'
  if (key === 'LEGACY') return '旧版快照'
  return key || '版本'
}

export function versionTypeTag(type) {
  const key = String(type || '').toUpperCase()
  if (key === 'AUTO') return 'info'
  if (key === 'MANUAL') return 'success'
  if (key === 'IMPORT') return 'warning'
  if (key === 'PRE_IMPORT') return ''
  if (key === 'PRE_RESTORE') return ''
  if (key === 'RESTORE') return 'danger'
  if (key === 'LEGACY') return 'info'
  return ''
}
