'use strict'

// Presentation only: never supplies conditions to a writer or fetches a newer baseline.
const GROUPS = ['text', 'note', 'hyperlink']
const FALLBACK_REASONS = new Set([
  'collab_v2_disabled', 'event_bridge_disabled', 'mcp_direct_disabled',
  'room_nodes_not_initialized', 'direct_policy_unsupported', 'direct_unavailable'
])
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function buildNodeWriteHints(uid, data = {}) {
  const update = {}
  const warnings = []
  const raw = data && data.__fv
  const malformed = raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))
  for (const group of GROUPS) {
    const value = raw && raw[group]
    const missing = !malformed && (raw === undefined || value === undefined)
    const number = missing ? 0 : Number(value)
    if (malformed || (!missing && typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim()) || !Number.isSafeInteger(number) || number < 0) {
      warnings.push(`write_hints：${group} 字段版本异常，未生成该组写入条件`)
      continue
    }
    update[group] = { uid: String(uid), [`__fv.${group}`]: number }
  }
  return { writeHints: Object.keys(update).length ? { update } : null, warnings }
}

function buildWriteGuidance(error = {}, context = {}) {
  const code = String(error.code || '')
  if (error.outcomeUnknown === true || error.outcome === 'unknown') {
    return {
      reason: 'outcome_unknown',
      next_action: 'verify_same_operation',
      auto_retry_allowed: false,
      message: '结果未知；使用原 operation_id、原内容和原 base_revision 核验重放，不得换新 ID 重复新增。'
    }
  }
  if (code === 'MCP_DIRECT_UNAVAILABLE') {
    const rawReason = error.details && error.details.fallbackReason
    const fallbackReason = FALLBACK_REASONS.has(rawReason) ? rawReason : null
    return {
      reason: 'capability_unavailable',
      ...(typeof fallbackReason === 'string' ? { fallback_reason: fallbackReason } : {}),
      next_action: 'report_and_stop',
      auto_retry_allowed: false,
      message: `当前批量通道不可用${fallbackReason ? `（${fallbackReason}）` : '（服务端未返回具体原因）'}；报告服务端条件，不得循环单项工具代替批量。`
    }
  }
  if (!['PRECONDITION_REQUIRED', 'PRECONDITION_INVALID', 'REPLACE_CONFLICT'].includes(code)) return null
  const args = context.args || {}
  const isUpdate = context.tool === 'update_node' || args.op === 'update'
  const groups = isUpdate ? GROUPS.filter(group => group === 'hyperlink'
    ? args.hyperlink !== undefined || args.hyperlinkTitle !== undefined
    : args[group] !== undefined) : []
  const expected = args.expected && typeof args.expected === 'object' ? args.expected : {}
  const moving = args.op === 'move'
  const deleting = args.op === 'delete'
  const required = isUpdate ? ['uid', ...groups.map(group => `__fv.${group}`)]
    : moving ? ['uid', 'parent_uid', 'position'] : deleting ? ['uid', 'subtree_token'] : []
  const missing = required.filter(key => !hasOwn(expected, key) || (key === 'uid' && !String(expected.uid || '').trim()))
  const nested = groups.some(group => !hasOwn(expected, `__fv.${group}`) && expected.__fv && hasOwn(expected.__fv, group))
  const conflict = code === 'REPLACE_CONFLICT'
  return {
    reason: conflict ? 'concurrent_conflict' : nested ? 'nested_field_version' : 'invalid_precondition',
    required_expected_keys: required,
    missing_expected_keys: missing,
    condition_source: isUpdate
      ? 'query_nodes(include_write_hints=true) 的 items[i].write_hints.update；原始版本来自 items[i].data.__fv，顶层 version 仅为房间修订号'
      : deleting ? 'query_nodes(scope=self, selector.type=uid, include_subtree_token=true) 返回的 uid 和 subtree_token'
        : moving ? 'query_nodes 返回的 uid、parent_uid、position；指定 index 时还需 anchor_* 与 anchor_side，或 target_empty=true'
          : '按失败项目及对应工具说明核对条件；批级错误不能据此确定某个项目或字段',
    next_action: 'report_and_wait',
    auto_retry_allowed: false,
    message: conflict
      ? '节点标识或并发基线不匹配；报告冲突并等待用户指示，不得读取最新条件覆盖旧内容。'
      : `${nested ? '检测到嵌套 __fv；' : ''}${required.length ? `expected 需要完整键名 ${required.map(key => JSON.stringify(key)).join('、')}；` : ''}${isUpdate ? '"__fv.text" 等是完整 JSON 键名，不可拆为嵌套对象。按所改字段组使用查询返回的条件，base_revision 不能替代字段版本；' : moving ? '指定 index 时提供 anchor_* 与 anchor_side，或 target_empty=true；' : deleting ? '删除前按 UID 查询自身并请求 include_subtree_token=true；' : '核对失败项目和对应工具的并发条件；'}报告问题并等待用户指示，不自动换基线重写。`
  }
}

function decorateBatchResult(data, context = {}) {
  if (!data || !Array.isArray(data.items)) return data
  return {
    ...data,
    items: data.items.map(item => {
      if (!item || item.status !== 'failed') return item
      const args = context.args && context.args.operations && context.args.operations[item.index]
      const guidance = buildWriteGuidance(item, { tool: 'apply_nodes', args })
      return guidance ? { ...item, guidance } : item
    })
  }
}

module.exports = { buildNodeWriteHints, buildWriteGuidance, decorateBatchResult }
