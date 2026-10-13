'use strict'

function isUidReference(value, knownUids = new Set()) {
  const ref = String(value || '').trim()
  return ref === 'root' || knownUids.has(ref)
}

function isPlainData(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowed.has(key))
}

function isMcpDirectShape(command, source, knownUids = new Set()) {
  if (!source || !source.principalId || !command) return false
  const payload = command.payload || {}
  if (command.type === 'node.insert') {
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    const data = payload.data || payload
    const allowedPayload = new Set([
      'parentUid', 'parent_uid', 'parent', 'uid', 'text', 'note', 'index',
      'data', 'confirm_sop_change'
    ])
    return (
      isUidReference(parent, knownUids) &&
      Object.keys(payload).every(key => allowedPayload.has(key)) &&
      isPlainData(data, new Set(['uid', 'text', 'note', 'confirm_sop_change']))
    )
  }
  if (command.type === 'node.update') {
    if (payload.expected || payload.expectedValue) return false
    const structuralKeys = [
      'parentUid', 'parent_uid', 'parent', 'index', 'position', 'order'
    ]
    if (structuralKeys.some(key => payload[key] != null)) return false
    const patch = payload.patch || payload.data || payload
    const allowedPayload = new Set([
      'uid', 'patch', 'data', 'confirm_sop_change', '__fv', ...structuralKeys
    ])
    return (
      isUidReference(payload.uid, knownUids) &&
      Object.keys(payload).every(key => allowedPayload.has(key)) &&
      isPlainData(patch, new Set(['text', 'note', '__fv']))
    )
  }
  if (command.type === 'node.delete') {
    const allowedPayload = new Set(['uid', 'keepChildren', 'confirm_sop_change'])
    return (
      isUidReference(payload.uid, knownUids) &&
      !payload.keepChildren &&
      Object.keys(payload).every(key => allowedPayload.has(key))
    )
  }
  return false
}

function isUidToken(value) {
  const ref = String(value || '').trim()
  return !!ref && ref !== 'root' && !ref.includes('/')
}

function isMcpDirectBatch(command) {
  const ops = command && command.payload && command.payload.ops
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100) return false
  return ops.every(item => {
    const type = String((item && item.type) || '')
    const payload = (item && item.payload) || {}
    if (type === 'node.insert') {
      const parent = payload.parentUid || payload.parent_uid || payload.parent
      return parent === 'root' || isUidToken(parent)
    }
    if (type === 'node.update' || type === 'node.delete') {
      return isUidToken(payload.uid)
    }
    return false
  })
}

module.exports = { isMcpDirectShape, isUidReference, isMcpDirectBatch }
