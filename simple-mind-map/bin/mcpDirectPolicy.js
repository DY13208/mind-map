'use strict'

function isUidReference(value, knownUids = new Set()) {
  const ref = String(value || '').trim()
  return ref === 'root' || knownUids.has(ref)
}

function isUuidReference(value) {
  const ref = String(value || '').trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
}

function classifyMcpDirectReferences(command, refs, provenUids = new Set()) {
  const knownUids = new Set(
    [...(provenUids || [])].map(value => String(value || '').trim()).filter(Boolean)
  )
  const legacyRefs = []
  const explicitMove = !!command && command.type === 'node.move'
  for (const value of refs || []) {
    const ref = String(value || '').trim()
    if (!ref || ref === 'root' || knownUids.has(ref)) continue
    // MCP node.move is the canonical UID-only move contract. Keep malformed
    // references on Direct so the operation is rejected as a node error rather
    // than guessed as a path by the legacy writer.
    if (explicitMove || isUuidReference(ref)) knownUids.add(ref)
    else legacyRefs.push(ref)
  }
  return { knownUids, legacyRefs }
}

function referenceUnavailableError(fallbackReason = 'reference_resolution_failed') {
  const err = new Error('MCP Direct 无法安全证明节点引用，已拒绝降级到兼容写入路径')
  err.statusCode = 503
  err.code = 'MCP_DIRECT_REFERENCE_UNAVAILABLE'
  err.details = { fallbackReason }
  return err
}

function isPlainData(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowed.has(key))
}

function isExpectedShape(value, allowed) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowed.has(key))
}

const FIELD_EXPECTED_KEYS = new Set([
  'uid', '__fv.text', '__fv.note', '__fv.hyperlink'
])
const MOVE_EXPECTED_KEYS = new Set([
  ...FIELD_EXPECTED_KEYS,
  'parent_uid', 'position',
  'target_uid', 'target_parent_uid', 'target_position',
  'anchor_uid', 'anchor_parent_uid', 'anchor_position', 'anchor_side',
  'target_empty'
])
const DELETE_EXPECTED_KEYS = new Set(['uid', 'subtree_token'])

function isDirectNodeShape(command, knownUids = new Set()) {
  if (!command) return false
  const payload = command.payload || {}
  if (command.type === 'node.insert') {
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    const allowedPayload = new Set([
      'parentUid', 'parent_uid', 'parent', 'uid', 'text', 'note', 'index',
      'hyperlink', 'hyperlinkTitle',
      'data', 'confirm_sop_change'
    ])
    return (
      isUidReference(parent, knownUids) &&
      Object.keys(payload).every(key => allowedPayload.has(key)) &&
      (payload.data === undefined || isPlainData(payload.data, new Set([
        'uid', 'text', 'note', 'hyperlink', 'hyperlinkTitle', 'confirm_sop_change'
      ])))
    )
  }
  if (command.type === 'node.move' || command.type === 'node.reorder') {
    const moveKeys = new Set([
      'uid', 'parentUid', 'parent_uid', 'parent', 'index', 'position',
      'order', 'patch', 'data', 'expected', 'confirm_sop_change'
    ])
    const patch = payload.patch || payload.data || {}
    const parent = payload.parentUid || payload.parent_uid || payload.parent
    return (
      isUidReference(payload.uid, knownUids) &&
      (!parent || isUidReference(parent, knownUids)) &&
      Object.keys(payload).every(key => moveKeys.has(key)) &&
      isExpectedShape(payload.expected, MOVE_EXPECTED_KEYS) &&
      isPlainData(patch, new Set(['text', 'note', 'hyperlink', 'hyperlinkTitle', '__fv']))
    )
  }
  if (command.type === 'node.update') {
    const structuralKeys = [
      'parentUid', 'parent_uid', 'parent', 'index', 'position', 'order'
    ]
    if (structuralKeys.some(key => payload[key] != null)) return false
    const patch = payload.patch || payload.data || payload
    const allowedPayload = new Set([
      'uid', 'patch', 'data', 'expected', 'confirm_sop_change', '__fv', ...structuralKeys
    ])
    return (
      isUidReference(payload.uid, knownUids) &&
      Object.keys(payload).every(key => allowedPayload.has(key)) &&
      isExpectedShape(payload.expected, FIELD_EXPECTED_KEYS) &&
      isPlainData(patch, new Set(['text', 'note', 'hyperlink', 'hyperlinkTitle', '__fv']))
    )
  }
  if (command.type === 'node.delete') {
    const allowedPayload = new Set(['uid', 'keepChildren', 'expected', 'confirm_sop_change'])
    return (
      isUidReference(payload.uid, knownUids) &&
      !payload.keepChildren &&
      Object.keys(payload).every(key => allowedPayload.has(key)) &&
      isExpectedShape(payload.expected, DELETE_EXPECTED_KEYS)
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
  return ops.every((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const deps = item.depends_on
    if (
      deps != null &&
      (!Array.isArray(deps) ||
        deps.some(dep => !Number.isInteger(dep) || dep < 0 || dep >= index) ||
        new Set(deps).size !== deps.length)
    ) return false
    const type = String((item && item.type) || '')
    const payload = (item && item.payload) || {}
    if (type === 'node.insert') {
      const parent = payload.parentUid || payload.parent_uid || payload.parent
      const allowed = new Set([
        'parentUid', 'parent_uid', 'parent', 'uid', 'text', 'note', 'index',
        'hyperlink', 'hyperlinkTitle', 'data', 'confirm_sop_change'
      ])
      return (
        (parent === 'root' || isUidToken(parent)) &&
        Object.keys(payload).every(key => allowed.has(key)) &&
        (payload.data === undefined || isPlainData(payload.data, new Set([
          'uid', 'text', 'note', 'hyperlink', 'hyperlinkTitle', 'confirm_sop_change'
        ])))
      )
    }
    if (type === 'node.update') {
      const allowed = new Set(['uid', 'patch', 'data', 'expected', 'confirm_sop_change'])
      const patch = payload.patch || payload.data || {}
      return (
        isUidToken(payload.uid) &&
        Object.keys(payload).every(key => allowed.has(key)) &&
        isExpectedShape(payload.expected, FIELD_EXPECTED_KEYS) &&
        isPlainData(patch, new Set(['text', 'note', 'hyperlink', 'hyperlinkTitle', '__fv']))
      )
    }
    if (type === 'node.move' || type === 'node.reorder') {
      const allowed = new Set([
        'uid', 'parentUid', 'parent_uid', 'parent', 'index', 'position',
        'order', 'patch', 'data', 'expected', 'confirm_sop_change'
      ])
      const parent = payload.parentUid || payload.parent_uid || payload.parent
      const patch = payload.patch || payload.data || {}
      return (
        isUidToken(payload.uid) &&
        (!parent || parent === 'root' || isUidToken(parent)) &&
        Object.keys(payload).every(key => allowed.has(key)) &&
        isExpectedShape(payload.expected, MOVE_EXPECTED_KEYS) &&
        isPlainData(patch, new Set(['text', 'note', 'hyperlink', 'hyperlinkTitle', '__fv']))
      )
    }
    if (type === 'node.delete') {
      return (
        isUidToken(payload.uid) &&
        Object.keys(payload).every(key => ['uid', 'expected', 'confirm_sop_change'].includes(key)) &&
        isExpectedShape(payload.expected, DELETE_EXPECTED_KEYS)
      )
    }
    return false
  })
}

function isMcpDirectShape(command, source, knownUids = new Set()) {
  return !!(source && source.principalId) && isDirectNodeShape(command, knownUids)
}

module.exports = {
  classifyMcpDirectReferences,
  isMcpDirectShape,
  isDirectNodeShape,
  isUidReference,
  isUuidReference,
  isUidToken,
  isMcpDirectBatch,
  referenceUnavailableError
}
