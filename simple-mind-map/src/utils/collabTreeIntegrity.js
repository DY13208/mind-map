function walkTree(root, visit) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    visit(node)
    const kids = node.children || []
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
}

function rowsFromTree(root) {
  const rows = []
  walkTree(root, node => {
    const uid = node && node.data && node.data.uid
    if (!uid) return
    rows.push({
      uid,
      parent_uid: node.parent_uid || (node.data && node.data.parent_uid) || null,
      deleted_at: node.deleted_at || null,
      is_root: !!(node.isRoot || (node.data && node.data.isRoot)),
      text: node.data && node.data.text
    })
  })
  return rows
}

function checkTreeGraph(input = {}, extra = {}) {
  const errors = []
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input.rows)
      ? input.rows
      : input.root
        ? rowsFromTree(input.root)
        : Object.keys(input)
            .filter(key => input[key] && (input[key].uid || (input[key].data && input[key].data.uid)))
            .map(key => {
              const row = input[key]
              return {
                uid: row.uid || (row.data && row.data.uid),
                parent_uid: row.parent_uid || row.parentUid || null,
                deleted_at: row.deleted_at || row.deletedAt || (row.deleted ? true : null),
                is_root: !!(row.is_root || row.isRoot),
                text: (row.data && row.data.text) || row.text
              }
            })
  const live = rows.filter(row => !row.deleted_at)
  const byUid = new Map()
  live.forEach(row => {
    if (byUid.has(row.uid)) {
      errors.push('duplicate_uid:' + row.uid)
    }
    byUid.set(row.uid, row)
  })
  const roots = live.filter(
    row => row.is_root || !row.parent_uid || row.parent_uid === row.uid
  )
  if (roots.length !== 1) errors.push('root_count:' + roots.length)
  live.forEach(row => {
    if (row.is_root) return
    if (!row.parent_uid) {
      errors.push('missing_parent:' + row.uid)
      return
    }
    const parent = byUid.get(row.parent_uid)
    if (!parent) errors.push('parent_missing_or_dead:' + row.uid + '>' + row.parent_uid)
  })
  live.forEach(row => {
    const seen = new Set()
    let cur = row
    while (cur && cur.parent_uid && !cur.is_root) {
      if (seen.has(cur.uid)) {
        errors.push('cycle:' + cur.uid)
        break
      }
      seen.add(cur.uid)
      cur = byUid.get(cur.parent_uid)
    }
  })
  const original = extra.originalUids || []
  const pasted = extra.pastedUids || []
  const originalSet = new Set(original)
  const overlap = pasted.filter(uid => originalSet.has(uid))
  if (overlap.length) errors.push('uid_overlap:' + overlap.join(','))
  if (original.length && pasted.length) {
    pasted.forEach(uid => {
      let cur = byUid.get(uid)
      const seen = new Set()
      while (cur && cur.parent_uid && !seen.has(cur.uid)) {
        seen.add(cur.uid)
        if (originalSet.has(cur.parent_uid) && extra.forbidPasteAsAncestor !== false) {
          // pasted child of original is OK; pasted becoming ancestor of original is not
        }
        cur = byUid.get(cur.parent_uid)
      }
    })
    original.forEach(uid => {
      let cur = byUid.get(uid)
      const seen = new Set()
      const pastedSet = new Set(pasted)
      while (cur && cur.parent_uid && !seen.has(cur.uid)) {
        seen.add(cur.uid)
        if (pastedSet.has(cur.parent_uid)) {
          errors.push('paste_became_ancestor:' + uid + '>' + cur.parent_uid)
          break
        }
        cur = byUid.get(cur.parent_uid)
      }
    })
  }
  const ok = errors.length === 0
  if (!ok) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('TREE_GRAPH_INTEGRITY_FAILED', errors)
    }
    try {
      if (typeof window !== 'undefined') {
        window.__TREE_GRAPH_INTEGRITY_FAILED__ = {
          timestamp: Date.now(),
          errors
        }
      }
    } catch (err) {
      // ignore
    }
  }
  return { ok, errors, liveCount: live.length }
}

function assertTreeGraph(input, extra) {
  const result = checkTreeGraph(input, extra)
  if (!result.ok) {
    const err = new Error('TREE_GRAPH_INTEGRITY_FAILED')
    err.code = 'TREE_GRAPH_INTEGRITY_FAILED'
    err.errors = result.errors
    throw err
  }
  return result
}

const api = {
  checkTreeGraph,
  assertTreeGraph,
  rowsFromTree
}

module.exports = api
module.exports.default = api
