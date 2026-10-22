// Browser-safe request validation. Never fetch or replace an editing baseline here.
const { commandError } = require('./conflictErrors')
const { fieldGroupOf } = require('./fieldMerge')
const { normalizeType } = require('./collabV2/protocol')
const PRECONDITION_REQUIRED = 'PRECONDITION_REQUIRED'
const PRECONDITION_INVALID = 'PRECONDITION_INVALID'
const REPLACE_CONFLICT = 'REPLACE_CONFLICT'
const PROTECTED_FIELD_GROUPS = new Set(['text', 'note', 'hyperlink'])
const MOVE_EXPECTED_KEYS = [
  ['target_uid', 'target_parent_uid', 'target_position'],
  ['anchor_uid', 'anchor_parent_uid', 'anchor_position', 'anchor_side']
]
function preconditionError(message, code, statusCode) { throw commandError(message, code, statusCode) }
function expectedFor(payload = {}) {
  const expected = payload.expected || payload.expectedValue
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null
  return expected
}

function patchFor(payload = {}) {
  return payload.patch || payload.data || payload
}

function protectedGroupsForPatch(patch = {}) {
  return Array.from(new Set(Object.keys(patch || {}).map(fieldGroupOf)
    .filter(group => PROTECTED_FIELD_GROUPS.has(group))))
}

function assertExpectedUid(expected, uid) {
  if (!expected || expected.uid == null || String(expected.uid).trim() === '') {
    preconditionError(
      '受保护的节点写入必须提供 expected.uid',
      PRECONDITION_REQUIRED,
      428
    )
  }
  if (String(expected.uid) !== String(uid)) {
    preconditionError('expected.uid 与目标节点不一致', REPLACE_CONFLICT, 409)
  }
}

function assertExpectedVersion(expected, group) {
  const key = `__fv.${group}`
  if (!Object.prototype.hasOwnProperty.call(expected, key)) {
    preconditionError(
      `受保护的 ${group} 修改必须提供 expected.${key}`,
      PRECONDITION_REQUIRED,
      428
    )
  }
  const value = Number(expected[key])
  if (!Number.isSafeInteger(value) || value < 0) {
    preconditionError(
      `expected.${key} 必须是非负整数`,
      PRECONDITION_INVALID,
      400
    )
  }
}

function assertExpectedTuple(expected, keys, label) {
  const present = keys.filter(key => Object.prototype.hasOwnProperty.call(expected, key))
  if (!present.length) return false
  if (present.length !== keys.length) {
    preconditionError(
      `${label}结构校验字段必须成组提供`,
      PRECONDITION_REQUIRED,
      428
    )
  }
  return true
}

function assertExpectedLocationTuple(expected, keys, label) {
  if (!assertExpectedTuple(expected, keys, label)) return false
  const [uidKey, parentKey, positionKey] = keys
  if (typeof expected[uidKey] !== 'string' || !expected[uidKey].trim()) {
    preconditionError(`expected.${uidKey} 必须是非空 UID 字符串`, PRECONDITION_INVALID, 400)
  }
  if (expected[parentKey] != null && typeof expected[parentKey] !== 'string') {
    preconditionError(`expected.${parentKey} 必须是 UID 字符串或 null`, PRECONDITION_INVALID, 400)
  }
  if (typeof expected[positionKey] !== 'string') {
    preconditionError(`expected.${positionKey} 必须是字符串`, PRECONDITION_INVALID, 400)
  }
  return true
}

function assertTargetEmpty(expected) {
  if (!Object.prototype.hasOwnProperty.call(expected, 'target_empty')) return false
  if (expected.target_empty !== true) {
    preconditionError('expected.target_empty 只能为 true', PRECONDITION_INVALID, 400)
  }
  return true
}

function assertMoveTargetMode(expected, payload) {
  const hasAnchor = assertExpectedLocationTuple(expected, MOVE_EXPECTED_KEYS[1], '锚点节点')
  const targetEmpty = assertTargetEmpty(expected)
  if (targetEmpty && payload.index === undefined) {
    preconditionError('expected.target_empty 只能与明确的 index 一起使用', PRECONDITION_INVALID, 400)
  }
  if (hasAnchor && targetEmpty) {
    preconditionError('expected.anchor_* 与 expected.target_empty 不能同时提供', PRECONDITION_INVALID, 400)
  }
  if (payload.index !== undefined && !hasAnchor && !targetEmpty) {
    preconditionError('指定 index 的移动必须提供 expected 锚点与 anchor_side，或 expected.target_empty=true', PRECONDITION_REQUIRED, 428)
  }
  if (hasAnchor && !['before', 'after'].includes(expected.anchor_side)) {
    preconditionError('expected.anchor_side 只能是 before 或 after', PRECONDITION_INVALID, 400)
  }
  return { hasAnchor, targetEmpty }
}

function preflightNodeWritePreconditions({ type, payload = {}, uid, allowNewUid = false } = {}) {
  const normalizedType = String(type || '')
  const expected = expectedFor(payload)
  const groups = protectedGroupsForPatch(patchFor(payload))
  const moving = ['node.move', 'node.reorder'].includes(normalizedType) ||
    (normalizedType === 'node.update' && (
      payload.parentUid !== undefined || payload.parent_uid !== undefined ||
      payload.parent !== undefined || payload.index !== undefined ||
      payload.position !== undefined || payload.order !== undefined
    ))
  const deleting = normalizedType === 'node.delete'
  if (!groups.length && !moving && !deleting) return
  if (allowNewUid) {
    if (moving && expected) {
      assertExpectedLocationTuple(expected, MOVE_EXPECTED_KEYS[0], '目标父节点')
      assertMoveTargetMode(expected, payload)
    } else if (moving && payload.index !== undefined) {
      preconditionError('指定 index 的移动必须提供 expected 锚点与 anchor_side，或 expected.target_empty=true', PRECONDITION_REQUIRED, 428)
    }
    return
  }
  if (!expected) {
    preconditionError('受保护的节点写入缺少 expected 校验信息', PRECONDITION_REQUIRED, 428)
  }
  assertExpectedUid(expected, uid || payload.uid)
  groups.forEach(group => assertExpectedVersion(expected, group))
  if (moving) {
    for (const key of ['parent_uid', 'position']) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        preconditionError(`移动操作必须提供 expected.${key}`, PRECONDITION_REQUIRED, 428)
      }
    }
    if (expected.parent_uid != null && typeof expected.parent_uid !== 'string') {
      preconditionError('expected.parent_uid 必须是 UID 字符串或 null', PRECONDITION_INVALID, 400)
    }
    if (typeof expected.position !== 'string') {
      preconditionError('expected.position 必须是字符串', PRECONDITION_INVALID, 400)
    }
    assertExpectedLocationTuple(expected, MOVE_EXPECTED_KEYS[0], '目标父节点')
    assertMoveTargetMode(expected, payload)
  }
  if (deleting && (!Object.prototype.hasOwnProperty.call(expected, 'subtree_token') || !String(expected.subtree_token || '').trim())) {
    preconditionError('删除操作必须提供 expected.subtree_token', PRECONDITION_REQUIRED, 428)
  }
}

function assertOperationPreconditions(op, inserted = new Set()) {
  const type = normalizeType(op.type)
  const payload = { ...(op.payload || {}) }
  if (!payload.uid && op.targetId) payload.uid = op.targetId
  if (type === 'node.batch') {
    for (const [index, child] of (payload.ops || []).entries()) {
      try { assertOperationPreconditions(child, inserted) }
      catch (error) { error.details = { ...error.details, operationIndex: index }; throw error }
    }
    return
  }
  if (type === 'node.insert') { if (payload.uid) inserted.add(payload.uid); return }
  if (!['node.update', 'node.move', 'node.reorder', 'node.delete'].includes(type)) return
  try {
    preflightNodeWritePreconditions({ type, payload, uid: payload.uid, allowNewUid: inserted.has(payload.uid) })
  } catch (error) {
    error.details = { operationType: type, nodeUid: payload.uid || '',
      modifiedFields: Object.keys(payload.patch || payload.data || {}),
      expectedPresent: !!expectedFor(payload), ...error.details }
    throw error
  }
}
module.exports = { preflightNodeWritePreconditions, assertOperationPreconditions }
