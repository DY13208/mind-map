// Iterative conversion also handles deep imported chains without stack overflow.
export function historyGraphToMindMap(graph) {
  const nested = graph && graph.data && Array.isArray(graph.children)
  const nodes = graph && typeof graph === 'object' ? graph : {}
  const keys = nested ? [] : Object.keys(nodes)
  const rootUid = keys.find(uid => nodes[uid] && nodes[uid].isRoot) || keys[0]
  const source = nested ? graph : nodes[rootUid]
  if (!source)
    return { data: { uid: 'root', text: '未命名', expand: true }, children: [] }
  const seen = new Set()
  const make = (node, uid) => ({
    data: {
      ...(node.data || {}),
      uid: uid || (node.data && node.data.uid) || node.uid,
      expand: !node.data || node.data.expand !== false
    },
    children: []
  })
  const root = make(source, nested ? null : rootUid)
  seen.add(source)
  const queue = [{ source, target: root }]
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    for (const child of item.source.children || []) {
      const node = typeof child === 'string' ? nodes[child] : child
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      const target = make(node, typeof child === 'string' ? child : null)
      item.target.children.push(target)
      queue.push({ source: node, target })
    }
  }
  return root
}

export function withExpandMode(tree, mode) {
  const clone = historyGraphToMindMap(tree)
  const queue = [clone]
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    if (mode !== 'preserve') node.data.expand = mode !== 'collapsed' || i === 0
    queue.push(...node.children)
  }
  clone.data.expand = true
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
  if (type === 'PRE_RESTORE') return '恢复前 ' + formatLocalDateTime(createdAt)
  const match = name.match(
    /^(恢复到) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/
  )
  if (match) {
    if (match[4] != null) return match[1] + ' ' + match[2] + ' ' + match[3]
    return (
      match[1] +
      ' ' +
      formatLocalDateTime(match[2] + 'T' + match[3] + ':00.000Z')
    )
  }
  return name || '未命名版本'
}

export function versionTypeLabel(type) {
  const key = String(type || '').toUpperCase()
  if (key === 'AUTO') return '自动'
  if (key === 'MANUAL') return '手动'
  if (key === 'IMPORT') return '导入'
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
  if (key === 'PRE_RESTORE') return ''
  if (key === 'RESTORE') return 'danger'
  if (key === 'LEGACY') return 'info'
  return ''
}
