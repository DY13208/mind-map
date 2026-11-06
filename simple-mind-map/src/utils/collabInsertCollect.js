/* global module:readonly */

function snapshotNodeDataUids(roots) {
  const set = new Set()
  const walk = item => {
    if (!item) return
    const uid = item.data && item.data.uid
    if (uid) set.add(uid)
    const kids = item.children || []
    for (let i = 0; i < kids.length; i++) walk(kids[i])
  }
  ;(roots || []).forEach(walk)
  return set
}

function collectNodeDataUids(item, out = []) {
  if (!item) return out
  const uid = item.data && item.data.uid
  if (uid) out.push(uid)
  const kids = item.children || []
  for (let i = 0; i < kids.length; i++) collectNodeDataUids(kids[i], out)
  return out
}

function findInsertPlacement(root, uid) {
  const target = String(uid || '')
  if (!root || !target) return null
  let found = null
  const visit = node => {
    if (!node || found) return
    const kids = node.children || []
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      const id = child && child.data && child.data.uid
      if (String(id || '') === target) {
        const explicit = child && child._insertAnchorUid ? String(child._insertAnchorUid) : ''
        if (explicit) {
          const anchorIndex = kids.findIndex(
            item => item && item.data && String(item.data.uid || '') === explicit
          )
          if (anchorIndex >= 0) {
            found = { index: anchorIndex + 1, anchorUid: explicit }
            return
          }
        }
        const prev = i > 0 ? kids[i - 1] : null
        found = {
          index: i,
          anchorUid: prev && prev.data && prev.data.uid ? String(prev.data.uid) : ''
        }
        return
      }
      visit(child)
    }
  }
  visit(root)
  return found
}

function removeUidsFromNodeData(parent, uids) {
  const drop = uids instanceof Set ? uids : new Set(uids || [])
  if (!parent || !Array.isArray(parent.children) || !drop.size) return false
  const next = parent.children.filter(child => {
    const uid = child && child.data && child.data.uid
    return !uid || !drop.has(uid)
  })
  if (next.length === parent.children.length) return false
  parent.children = next
  return true
}

function collectNewNodeDataInserts(roots, opts = {}) {
  const knownUids = opts.knownUids || new Set()
  const isAcked = opts.isAcked || (() => false)
  const isPending = opts.isPending || (() => false)
  const isTombstoned = opts.isTombstoned || (() => false)
  const isAbandoned = opts.isAbandoned || (() => false)
  const skipUid = opts.skipUid || (() => false)
  const textOf =
    opts.textOf || (data => String((data && data.text) || ''))
  const out = []
  const seen = new Set()

  const consider = (item, parentUid, index, depth) => {
    if (!item || !item.data) return
    const uid = item.data.uid
    const kids = item.children || []
    if (!uid) {
      for (let i = 0; i < kids.length; i++) {
        consider(kids[i], parentUid, i, depth)
      }
      return
    }
    const isRoot = !!(item.isRoot || item.data.isRoot)
    if (
      !isRoot &&
      parentUid &&
      !seen.has(uid) &&
      !knownUids.has(uid) &&
      !isAcked(uid) &&
      !isPending(uid) &&
      !isTombstoned(uid) &&
      !isAbandoned(uid) &&
      !skipUid(uid) &&
      !isTombstoned(parentUid)
    ) {
      seen.add(uid)
      const row = {
        uid,
        parent: parentUid,
        text: textOf(item.data),
        note: item.data.note || '',
        index,
        depth,
        data: item.data
      }
      if (item._insertAnchorUid) row.anchorUid = String(item._insertAnchorUid)
      out.push(row)
    }
    const nextDepth = isRoot ? depth : depth + 1
    for (let i = 0; i < kids.length; i++) {
      consider(kids[i], uid, i, nextDepth)
    }
  }

  ;(roots || []).forEach(root => {
    if (!root) return
    consider(root, null, 0, 0)
  })
  out.sort((a, b) => (a.depth || 0) - (b.depth || 0))
  return out
}

const api = {
  snapshotNodeDataUids,
  collectNodeDataUids,
  removeUidsFromNodeData,
  findInsertPlacement,
  collectNewNodeDataInserts
}

module.exports = api
module.exports.default = api
