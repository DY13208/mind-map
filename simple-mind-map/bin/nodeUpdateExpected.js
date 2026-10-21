const { commandError } = require('./conflictErrors')
const { stripSearchHtml } = require('./roomNodes')
const { fieldGroupOf } = require('./fieldMerge')

const PRECONDITION_REQUIRED = 'PRECONDITION_REQUIRED'
const PRECONDITION_INVALID = 'PRECONDITION_INVALID'
const PRECONDITION_UNSUPPORTED = 'PRECONDITION_UNSUPPORTED'
const REPLACE_CONFLICT = 'REPLACE_CONFLICT'
const PROTECTED_FIELD_GROUPS = new Set(['text', 'note', 'hyperlink'])
const MOVE_EXPECTED_KEYS = [
  ['target_uid', 'target_parent_uid', 'target_position'],
  ['anchor_uid', 'anchor_parent_uid', 'anchor_position', 'anchor_side']
]

function stableValue(value) {
  try {
    return JSON.stringify(value === undefined ? null : value)
  } catch (err) {
    return String(value)
  }
}

function expectedValueForKey(data, key) {
  if (key.startsWith('__fv.')) {
    const group = key.slice('__fv.'.length)
    const versions = data && data.__fv
    return Number(versions && typeof versions === 'object' ? versions[group] : 0) || 0
  }
  return data && data[key]
}

function preconditionError(message, code, statusCode) {
  throw commandError(message, code, statusCode)
}

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

function normalizeNullableUid(value) {
  return value == null || value === '' ? null : String(value)
}

function assertLocationValue(actual, expected, field, label) {
  const matches = field === 'parent_uid'
    ? normalizeNullableUid(actual) === normalizeNullableUid(expected)
    : String(actual == null ? '' : actual) === String(expected == null ? '' : expected)
  if (!matches) {
    preconditionError(`${label}已发生变化`, REPLACE_CONFLICT, 409)
  }
}

function rowFromBaseline(baseline, uid) {
  if (!baseline) return null
  const nodes = baseline.nodes || baseline
  if (nodes instanceof Map) return nodes.get(String(uid)) || null
  return nodes && nodes[String(uid)] || null
}

function assertMoveExpected(expected, payload, baselineNode, baseline) {
  assertLocationValue(baselineNode.parent_uid, expected.parent_uid, 'parent_uid', '源节点父级')
  assertLocationValue(baselineNode.position, expected.position, 'position', '源节点位置')

  const destinationUid = normalizeNullableUid(
    payload.parentUid !== undefined ? payload.parentUid
      : payload.parent_uid !== undefined ? payload.parent_uid
        : payload.parent !== undefined ? payload.parent
          : baselineNode.parent_uid
  )

  if (assertExpectedTuple(expected, MOVE_EXPECTED_KEYS[0], '目标父节点')) {
    if (String(expected.target_uid) !== String(destinationUid)) {
      preconditionError('expected.target_uid 与移动目标父节点不一致', REPLACE_CONFLICT, 409)
    }
    const target = rowFromBaseline(baseline, expected.target_uid)
    if (!target) preconditionError('移动目标父节点已不存在', REPLACE_CONFLICT, 409)
    assertLocationValue(target.parent_uid, expected.target_parent_uid, 'parent_uid', '移动目标父节点')
    assertLocationValue(target.position, expected.target_position, 'position', '移动目标父节点')
  }

  const { hasAnchor } = assertMoveTargetMode(expected, payload)
  if (hasAnchor) {
    if (!['before', 'after'].includes(expected.anchor_side)) {
      preconditionError('expected.anchor_side 只能是 before 或 after', PRECONDITION_INVALID, 400)
    }
    const anchor = rowFromBaseline(baseline, expected.anchor_uid)
    if (!anchor) preconditionError('移动锚点已不存在', REPLACE_CONFLICT, 409)
    if (normalizeNullableUid(anchor.parent_uid) !== destinationUid) {
      preconditionError('移动锚点已不在目标父节点下', REPLACE_CONFLICT, 409)
    }
    assertLocationValue(anchor.parent_uid, expected.anchor_parent_uid, 'parent_uid', '移动锚点')
    assertLocationValue(anchor.position, expected.anchor_position, 'position', '移动锚点')
  }
}

/** Validate public strict preconditions against the immutable transaction baseline.
 * `allowNewUid` is reserved for a UID successfully inserted earlier in this batch.
 */
function assertNodeWritePreconditions({
  type,
  payload = {},
  uid,
  baselineNode,
  baseline,
  subtreeToken,
  allowNewUid = false
} = {}) {
  const normalizedType = String(type || '')
  const expected = expectedFor(payload)
  const patch = patchFor(payload)
  const groups = protectedGroupsForPatch(patch)
  const moving = ['node.move', 'node.reorder'].includes(normalizedType) ||
    (normalizedType === 'node.update' && (
      payload.parentUid !== undefined || payload.parent_uid !== undefined ||
      payload.parent !== undefined || payload.index !== undefined ||
      payload.position !== undefined || payload.order !== undefined
    ))
  const deleting = normalizedType === 'node.delete'
  if (!groups.length && !moving && !deleting) return

  preflightNodeWritePreconditions({ type: normalizedType, payload, uid, allowNewUid })

  if (allowNewUid) {
    // A successfully created UID has no external baseline. Optional destination
    // and anchor guards still apply when supplied by the caller.
    if (moving && expected) {
      if (Object.prototype.hasOwnProperty.call(expected, 'target_uid')) {
        const tupleExpected = { ...expected, parent_uid: baselineNode && baselineNode.parent_uid, position: baselineNode && baselineNode.position }
        assertExpectedTuple(tupleExpected, MOVE_EXPECTED_KEYS[0], '目标父节点')
        const destinationUid = normalizeNullableUid(
          payload.parentUid !== undefined ? payload.parentUid
            : payload.parent_uid !== undefined ? payload.parent_uid
              : payload.parent !== undefined ? payload.parent
                : baselineNode && baselineNode.parent_uid
        )
        if (String(expected.target_uid) !== String(destinationUid)) {
          preconditionError('expected.target_uid 与移动目标父节点不一致', REPLACE_CONFLICT, 409)
        }
        const target = rowFromBaseline(baseline, expected.target_uid)
        if (!target) preconditionError('移动目标父节点已不存在', REPLACE_CONFLICT, 409)
        assertLocationValue(target.parent_uid, expected.target_parent_uid, 'parent_uid', '移动目标父节点')
        assertLocationValue(target.position, expected.target_position, 'position', '移动目标父节点')
      }
      if (Object.prototype.hasOwnProperty.call(expected, 'anchor_uid')) {
        if (!['before', 'after'].includes(expected.anchor_side)) {
          preconditionError('expected.anchor_side 只能是 before 或 after', PRECONDITION_INVALID, 400)
        }
        const anchor = rowFromBaseline(baseline, expected.anchor_uid)
        if (!anchor) preconditionError('移动锚点已不存在', REPLACE_CONFLICT, 409)
        const destinationUid = normalizeNullableUid(
          payload.parentUid !== undefined ? payload.parentUid
            : payload.parent_uid !== undefined ? payload.parent_uid
              : payload.parent !== undefined ? payload.parent
                : baselineNode && baselineNode.parent_uid
        )
        if (normalizeNullableUid(anchor.parent_uid) !== destinationUid) {
          preconditionError('移动锚点已不在目标父节点下', REPLACE_CONFLICT, 409)
        }
        assertLocationValue(anchor.parent_uid, expected.anchor_parent_uid, 'parent_uid', '移动锚点')
        assertLocationValue(anchor.position, expected.anchor_position, 'position', '移动锚点')
      }
      assertMoveTargetMode(expected, payload)
    }
    return
  }

  if (!expected) {
    preconditionError('受保护的节点写入缺少 expected 校验信息', PRECONDITION_REQUIRED, 428)
  }
  assertExpectedUid(expected, uid || payload.uid)

  if (groups.length) {
    groups.forEach(group => assertExpectedVersion(expected, group))
    const fieldExpected = {}
    groups.forEach(group => { fieldExpected[`__fv.${group}`] = expected[`__fv.${group}`] })
    assertExpectedNodeData(baselineNode && baselineNode.data || {}, {
      expected: fieldExpected
    })
  }

  if (moving) {
    for (const key of ['parent_uid', 'position']) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        preconditionError(`移动操作必须提供 expected.${key}`, PRECONDITION_REQUIRED, 428)
      }
    }
    if (expected.position == null) {
      preconditionError('expected.position 必须是字符串', PRECONDITION_INVALID, 400)
    }
    if (!baselineNode) {
      preconditionError('无法读取移动源节点的事务基线', PRECONDITION_UNSUPPORTED, 503)
    }
    assertMoveExpected(expected, payload, baselineNode, baseline)
  }

  if (deleting) {
    if (!Object.prototype.hasOwnProperty.call(expected, 'subtree_token') || !String(expected.subtree_token || '').trim()) {
      preconditionError('删除操作必须提供 expected.subtree_token', PRECONDITION_REQUIRED, 428)
    }
    if (!subtreeToken) {
      preconditionError('当前写入路径无法计算删除子树校验值', PRECONDITION_UNSUPPORTED, 503)
    }
    if (String(expected.subtree_token) !== String(subtreeToken)) {
      preconditionError('目标子树已发生变化', REPLACE_CONFLICT, 409)
    }
  }
}

function assertExpectedNodeData(data, payload = {}) {
  const expected = payload.expected || payload.expectedValue
  if (!expected || typeof expected !== 'object') return

  const conflict = Object.keys(expected)
    .filter(key => key !== 'revision' && key !== 'uid' && !key.startsWith('target_') && !key.startsWith('anchor_') && key !== 'parent_uid' && key !== 'position' && key !== 'subtree_token')
    .find(key => {
      const currentValue = expectedValueForKey(data || {}, key)
      if (key === 'text') {
        return stripSearchHtml(currentValue) !== stripSearchHtml(expected[key])
      }
      return stableValue(currentValue) !== stableValue(expected[key])
    })

  if (conflict) {
    throw commandError('目标已被其他协作者修改', 'REPLACE_CONFLICT', 409)
  }
}

function withExpectedCondition(body, payload) {
  const next = { ...(payload || {}) }
  if (next.expected !== undefined || next.expectedValue !== undefined) return next
  if (body && body.expected !== undefined) next.expected = body.expected
  else if (body && body.expectedValue !== undefined) {
    next.expectedValue = body.expectedValue
  }
  return next
}

module.exports = {
  assertExpectedNodeData,
  assertNodeWritePreconditions,
  preflightNodeWritePreconditions,
  protectedGroupsForPatch,
  patchFor,
  withExpectedCondition,
  PRECONDITION_REQUIRED,
  PRECONDITION_INVALID,
  PRECONDITION_UNSUPPORTED,
  REPLACE_CONFLICT
}
