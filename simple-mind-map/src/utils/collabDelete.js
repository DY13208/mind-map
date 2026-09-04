/* global module:readonly */

function nodeUid(node) {
  if (!node) return ''
  if (typeof node.getData === 'function') return node.getData('uid') || ''
  return (node.data && node.data.uid) || node.uid || ''
}

function nodeChildren(node) {
  if (!node) return []
  const dataKids = (node.nodeData && node.nodeData.children) || []
  if (dataKids.length) return dataKids
  return node.children || []
}

function walkDescendantUids(node, out = []) {
  const kids = nodeChildren(node)
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]
    if (!child) continue
    if (child.isGeneralization) continue
    const uid = nodeUid(child)
    if (uid) out.push(uid)
    walkDescendantUids(child, out)
  }
  return out
}

function collectDeleteRoots(activeNodes = [], commandName = 'REMOVE_NODE') {
  const keepChildren = commandName === 'REMOVE_CURRENT_NODE'
  const roots = []
  const owners = []
  const seen = new Set()
  const seenOwner = new Set()
  ;(activeNodes || []).forEach(node => {
    if (!node) return
    if (node.isGeneralization && node.generalizationBelongNode) {
      const owner = node.generalizationBelongNode
      const ownerUid = nodeUid(owner)
      if (ownerUid && !seenOwner.has(ownerUid)) {
        seenOwner.add(ownerUid)
        owners.push(owner)
      }
      return
    }
    if (node.isRoot) return
    const uid = nodeUid(node)
    if (!uid || seen.has(uid)) return
    seen.add(uid)
    const descendantUids = keepChildren ? [] : walkDescendantUids(node)
    roots.push({
      uid,
      keepChildren,
      descendantUids,
      node
    })
  })
  const descendantOfSelected = new Set()
  roots.forEach(item => {
    item.descendantUids.forEach(id => descendantOfSelected.add(id))
  })
  const filtered = roots.filter(item => !descendantOfSelected.has(item.uid))
  return {
    command: commandName,
    roots: filtered,
    owners,
    rootUids: filtered.map(item => item.uid),
    descendantUids: filtered.reduce((list, item) => list.concat(item.descendantUids), [])
  }
}

function deleteOperationsFromRoots(selection) {
  return (selection.roots || []).map(item => ({
    type: 'node.delete',
    payload: {
      uid: item.uid,
      keepChildren: !!item.keepChildren
    }
  }))
}

function buildSubtreeFromRows(rows = [], rootUid) {
  const list = Array.isArray(rows) ? rows : []
  const byUid = new Map()
  const kids = new Map()
  list.forEach(row => {
    if (!row || !row.uid) return
    byUid.set(row.uid, {
      data: { ...(row.data || {}), uid: row.uid },
      children: []
    })
    const parent = row.parent_uid || row.parentUid || row.parent || ''
    if (!kids.has(parent)) kids.set(parent, [])
    kids.get(parent).push(row)
  })
  kids.forEach(group => {
    group.sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')))
  })
  byUid.forEach((node, uid) => {
    const childRows = kids.get(uid) || []
    node.children = childRows
      .map(row => byUid.get(row.uid))
      .filter(Boolean)
  })
  return byUid.get(rootUid) || null
}

function publishDeleteTrace(row = {}) {
  const next = {
    timestamp: Date.now(),
    ...row
  }
  if (typeof window === 'undefined') return next
  window.__DELETE_TRACE__ = next
  if (!Array.isArray(window.__DELETE_TRACE_LOG__)) {
    window.__DELETE_TRACE_LOG__ = []
  }
  window.__DELETE_TRACE_LOG__.push(next)
  if (window.__DELETE_TRACE_LOG__.length > 50) {
    window.__DELETE_TRACE_LOG__.shift()
  }
  return next
}

const api = {
  collectDeleteRoots,
  deleteOperationsFromRoots,
  buildSubtreeFromRows,
  walkDescendantUids,
  publishDeleteTrace
}

module.exports = api
module.exports.default = api
