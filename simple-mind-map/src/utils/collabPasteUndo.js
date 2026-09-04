/* global module:readonly */

function parentOfInsert(payload = {}) {
  return String(
    payload.parentUid || payload.parent_uid || payload.parent || ''
  ).trim()
}

function typeOf(op) {
  return String((op && (op.type || op.operation_type || op.operationType)) || '')
}

function payloadOf(op) {
  return (op && (op.payload || op)) || {}
}

function collectInsertOps(op) {
  if (!op) return []
  const type = typeOf(op)
  if (type === 'node.insert' || type === 'node.inserted') {
    return [{ type: 'node.insert', payload: payloadOf(op) }]
  }
  if (type === 'node.batch' || type === 'batch.applied') {
    const inner = payloadOf(op)
    const ops = Array.isArray(inner.ops)
      ? inner.ops
      : Array.isArray(inner.events)
        ? inner.events
        : []
    return ops
      .filter(item => {
        const kind = typeOf(item)
        return kind === 'node.insert' || kind === 'node.inserted'
      })
      .map(item => ({ type: 'node.insert', payload: payloadOf(item) }))
  }
  return []
}

function collectInsertedUids(op) {
  const uids = []
  const seen = new Set()
  collectInsertOps(op).forEach(item => {
    const uid = String((item.payload && item.payload.uid) || '').trim()
    if (!uid || seen.has(uid)) return
    seen.add(uid)
    uids.push(uid)
  })
  return uids
}

function forestRootsFromInserts(ops = []) {
  const items = Array.isArray(ops) ? ops : []
  const uids = new Set()
  const rows = items.map(item => {
    const payload = payloadOf(item)
    const uid = String(payload.uid || '').trim()
    if (uid) uids.add(uid)
    return { uid, parent: parentOfInsert(payload), payload }
  })
  const roots = []
  const seen = new Set()
  rows.forEach(row => {
    if (!row.uid || seen.has(row.uid)) return
    if (!row.parent || !uids.has(row.parent)) {
      seen.add(row.uid)
      roots.push(row.uid)
    }
  })
  return roots
}

function pasteUndoInverse(ops) {
  const roots = forestRootsFromInserts(ops)
  if (!roots.length) return null
  if (roots.length === 1) {
    return { type: 'node.delete', payload: { uid: roots[0] } }
  }
  return {
    type: 'node.batch',
    payload: {
      ops: roots.map(uid => ({ type: 'node.delete', payload: { uid } }))
    }
  }
}

function isInsertLikeOperation(op) {
  const type = typeOf(op)
  if (type === 'node.insert' || type === 'node.inserted') return true
  if (type === 'node.batch' || type === 'batch.applied') {
    const inner = payloadOf(op)
    const ops = Array.isArray(inner.ops)
      ? inner.ops
      : Array.isArray(inner.events)
        ? inner.events
        : []
    return (
      ops.length > 0 &&
      ops.every(item => {
        const kind = typeOf(item)
        return kind === 'node.insert' || kind === 'node.inserted'
      })
    )
  }
  return false
}

function collectDeleteUids(op) {
  if (!op) return []
  const type = typeOf(op)
  const payload = payloadOf(op)
  const out = []
  const add = uid => {
    const id = String(uid || '').trim()
    if (id) out.push(id)
  }
  if (type === 'node.delete' || type === 'node.deleted') {
    add(payload.uid)
    ;(payload.removed || payload.deletedUids || []).forEach(add)
  } else if (type === 'node.batch' || type === 'batch.applied') {
    const ops = Array.isArray(payload.ops)
      ? payload.ops
      : Array.isArray(payload.events)
        ? payload.events
        : []
    ops.forEach(item => collectDeleteUids(item).forEach(add))
  } else if (type === 'map.replace' || type === 'map.replaced') {
    add('__full_tree__')
  }
  return Array.from(new Set(out))
}

function pasteUndoFullTreeForbidden(reason, extra = {}) {
  const row = { reason, ...extra }
  try {
    if (typeof window !== 'undefined') {
      window.__PASTE_UNDO_FULL_TREE_HITS__ =
        Number(window.__PASTE_UNDO_FULL_TREE_HITS__ || 0) + 1
      window.__PASTE_UNDO_FULL_TREE_FORBIDDEN__ = row
    }
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.error) {
    console.error('PASTE_UNDO_FULL_TREE_FORBIDDEN', row)
  }
  const err = new Error('PASTE_UNDO_FULL_TREE_FORBIDDEN')
  err.code = 'PASTE_UNDO_FULL_TREE_FORBIDDEN'
  err.details = row
  return err
}

function rewriteInsertInverse(target, inverse) {
  if (!isInsertLikeOperation(target)) return inverse
  if (
    inverse &&
    (typeOf(inverse) === 'map.replace' || typeOf(inverse) === 'map.replaced')
  ) {
    throw pasteUndoFullTreeForbidden('rewriteInsertInverse', {
      targetType: typeOf(target)
    })
  }
  const ops = collectInsertOps(target)
  return pasteUndoInverse(ops) || inverse
}

function assertPasteUndoSafe(target, generated) {
  if (!isInsertLikeOperation(target)) return generated
  if (
    generated &&
    (typeOf(generated) === 'map.replace' || typeOf(generated) === 'map.replaced')
  ) {
    throw pasteUndoFullTreeForbidden('assertPasteUndoSafe', {
      targetType: typeOf(target)
    })
  }
  const inserted = new Set(collectInsertedUids(target))
  const deleting = collectDeleteUids(generated).filter(uid => uid !== '__full_tree__')
  const extra = deleting.filter(uid => !inserted.has(uid))
  if (extra.length) {
    const err = new Error('PASTE_UNDO_SCOPE_VIOLATION')
    err.code = 'PASTE_UNDO_SCOPE_VIOLATION'
    err.extraUids = extra
    throw err
  }
  return rewriteInsertInverse(target, generated)
}

function collapseDeleteOpsToForestRoots(ops, parentOf) {
  const list = Array.isArray(ops) ? ops : []
  const deletes = list.filter(item => {
    const kind = typeOf(item)
    return kind === 'node.delete' || kind === 'node.deleted'
  })
  if (!deletes.length || deletes.length === list.length) {
    const uids = deletes
      .map(item => String((payloadOf(item) && payloadOf(item).uid) || '').trim())
      .filter(Boolean)
    const set = new Set(uids)
    const roots = uids.filter(uid => {
      let parent = parentOf ? parentOf(uid) : ''
      const seen = new Set()
      while (parent && !seen.has(parent)) {
        seen.add(parent)
        if (set.has(parent)) return false
        parent = parentOf ? parentOf(parent) : ''
      }
      return true
    })
    if (roots.length && roots.length < uids.length) {
      return roots.map(uid => ({ type: 'node.delete', payload: { uid } }))
    }
  }
  return list
}

function publishPasteUndoTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('PASTE_UNDO_TRACE', next)
  }
  if (typeof window === 'undefined') return next
  window.__PASTE_UNDO_TRACE__ = next
  window.__PASTE_UNDO_TRACE_LOG__ = window.__PASTE_UNDO_TRACE_LOG__ || []
  window.__PASTE_UNDO_TRACE_LOG__.push(next)
  if (window.__PASTE_UNDO_TRACE_LOG__.length > 40) {
    window.__PASTE_UNDO_TRACE_LOG__.shift()
  }
  return next
}

function publishUndoTargetTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('UNDO_TARGET_TRACE', next)
  }
  if (typeof window === 'undefined') return next
  window.__UNDO_TARGET_TRACE__ = next
  window.__UNDO_TARGET_TRACE_LOG__ = window.__UNDO_TARGET_TRACE_LOG__ || []
  window.__UNDO_TARGET_TRACE_LOG__.push(next)
  if (window.__UNDO_TARGET_TRACE_LOG__.length > 40) {
    window.__UNDO_TARGET_TRACE_LOG__.shift()
  }
  return next
}

const api = {
  parentOfInsert,
  collectInsertOps,
  collectInsertedUids,
  forestRootsFromInserts,
  pasteUndoInverse,
  isInsertLikeOperation,
  collectDeleteUids,
  pasteUndoFullTreeForbidden,
  rewriteInsertInverse,
  assertPasteUndoSafe,
  collapseDeleteOpsToForestRoots,
  publishPasteUndoTrace,
  publishUndoTargetTrace
}

module.exports = api
module.exports.default = api
