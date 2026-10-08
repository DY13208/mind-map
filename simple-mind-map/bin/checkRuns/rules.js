'use strict'

const chainUtils = require('./chain')

const RULE_VERSION = 'cpd-check-v5-evidence-review-2026-09-29'
const CARD_FIELDS = Object.freeze([
  'sop_id', 'title', 'cpd_path', 'role', 'objective', 'frequency', 'inputs',
  'steps', 'owner', 'outputs', 'project', 'version', 'status'
])

const FIELD_LABELS = Object.freeze({
  targetValue: '目标值',
  frequency: '频率',
  inputs: '输入源',
  criterion: '判据',
  owner: '责任人',
  outputs: '产物',
  remediation: '未达标处置',
  reference: '材料来源',
  cpd_path: 'cpd_path'
})

const SOURCE_FAILURE_STATUSES = new Set([
  'unavailable', 'forbidden', 'error', 'failed', 'parse_failed', 'not_connected',
  'no_permission', 'not_found', 'conflict', 'partial', 'incomplete'
])

const SOURCE_STATUS_LABELS = Object.freeze({
  ok: '已读取',
  ready: '已读取',
  no_results: '无结果',
  unavailable: '来源不可用',
  forbidden: '无权限',
  no_permission: '无权限',
  error: '读取失败',
  failed: '读取失败',
  parse_failed: '解析失败',
  not_connected: '未接入',
  not_found: '无法读取',
  conflict: '内容冲突',
  partial: '结果部分可用',
  incomplete: '读取不完整',
  truncated: '读取超限',
  processing: '尚未解析',
  pending: '等待解析',
  attachment_read_failed: '附件读取失败',
  attachment_limit_reached: '附件超出上限',
  attachment_record_missing: '附件记录缺失',
  attachments_not_ready: '附件未就绪',
  attachment_text_missing: '附件正文缺失',
  source_truncated: '来源被截断',
  map_read_failed: '图资料读取失败',
  map_read_unavailable: '图资料读取不可用',
  map_search_failed: '图资料检索失败',
  map_search_unavailable: '图资料检索不可用',
  source_read_failed: '来源读取失败',
  source_node_missing: '来源节点不存在',
  source_body_missing: '来源正文缺失',
  selected_flow_incomplete: '选定流程不完整',
  search_failed: '检索失败',
  request_aborted: '请求已取消',
  wiki_timeout: 'Wiki 请求超时',
  wiki_unreachable: 'Wiki 无法连接',
  wiki_url_invalid: 'Wiki 地址无效',
  wiki_not_configured: 'Wiki 未配置',
  knowledge_mcp_timeout: '知识库超时',
  knowledge_mcp_unreachable: '知识库无法连接',
  knowledge_mcp_unauthorized: '知识库未授权',
  knowledge_mcp_invalid_json: '知识库响应异常',
  knowledge_mcp_auth_unconfigured: '知识库鉴权未配置',
  knowledge_mcp_url_invalid: '知识库地址无效',
  knowledge_mcp_error: '知识库错误',
  canonical_storage_permission_denied: '房间资料目录无读取权限',
  invalid_room_or_query: '检索参数无效',
  missing_user_identity: '缺少用户身份',
  invalid_source_ref: '来源标识无效',
  cross_room_source_ref: '来源属于其他脑图'
})

const SCOPE_LABELS = Object.freeze({
  map_knowledge: '当前图资料',
  company_ai: '房间绑定知识库',
  wiki: 'Wiki',
  selected_flow: '选定流程'
})

function fieldLabel(field) {
  if (!field) return ''
  return FIELD_LABELS[field] || String(field)
}

function sourceStatusLabel(status, error) {
  const code = String(error || '').toLowerCase()
  if (code && SOURCE_STATUS_LABELS[code]) return SOURCE_STATUS_LABELS[code]
  const value = String(status || '').toLowerCase()
  if (SOURCE_STATUS_LABELS[value]) return SOURCE_STATUS_LABELS[value]
  return value || '未知状态'
}

function sourceProblem(item) {
  if (!item) return false
  if (SOURCE_FAILURE_STATUSES.has(String(item.status || '').toLowerCase())) return true
  return Boolean(String(item.error || '').trim())
}

const DEFERRED_RULE_IDS = [
  'CK-23','CK-24','CK-25','CK-26','CK-31',
  'CK-35','CK-36','CK-37','CK-38','CK-39','CK-40','CK-41','CK-42','CK-43',
  'CK-44','CK-45','CK-46','CK-47','CK-48','CK-49','CK-50','CK-51','CK-52',
  'CK-53','CK-54','CK-55','CK-56','CK-57','CK-58','CK-59','CK-60','CK-61',
  'CK-62','CK-63','CK-64'
]

const RULE_REGISTRY = Object.freeze([
  { id: 'FLOW-COMPARE', stage: 'static_chain', scope: 'confirmed_reference_comparison' },
  { id: 'CK-01', stage: 'static_chain', scope: 'methodology_core_only' },
  { id: 'CK-02', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-03', stage: 'all', scope: 'confidential_data_guard' },
  { id: 'CK-04', stage: 'whole_map', scope: 'whole_map_only' },
  { id: 'CK-05', stage: 'static_chain', scope: 'role_prefix' },
  { id: 'CK-06', stage: 'static_chain', scope: 'orphan_structure' },
  { id: 'CK-07', stage: 'static_chain', scope: 'plan_measurement' },
  { id: 'CK-08', stage: 'whole_map', scope: 'whole_map_only' },
  { id: 'CK-09', stage: 'static_chain', scope: 'd_five_fields' },
  { id: 'CK-10', stage: 'static_chain', scope: 'execution_granularity' },
  { id: 'CK-11', stage: 'static_chain', scope: 'acceptance_closure' },
  { id: 'CK-12', stage: 'static_chain', scope: 'c_traceability' },
  { id: 'CK-13', stage: 'static_chain', scope: 'progress_disposition' },
  { id: 'CK-14', stage: 'static_chain', scope: 'naming_and_source' },
  { id: 'CK-15', stage: 'whole_map', scope: 'whole_map_only' },
  { id: 'CK-16', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-17', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-18', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-19', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-20', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-21', stage: 'sop_card', scope: 'actual_sop_card_only' },
  { id: 'CK-22', stage: 'sop_card', scope: 'actual_sop_card_only' },
  ...DEFERRED_RULE_IDS.map(id => ({ id, stage: 'execution_or_output', scope: 'deferred_from_static_check' })),
  { id: 'CK-27', stage: 'static_chain', scope: 'c_to_p_correspondence' },
  { id: 'CK-28', stage: 'static_chain', scope: 'p_to_c_correspondence' },
  { id: 'CK-29', stage: 'static_chain', scope: 'chain_materials' },
  { id: 'CK-30', stage: 'static_chain', scope: 'read_only_source_search' },
  { id: 'CK-32', stage: 'static_chain', scope: 'missing_item_report' },
  { id: 'CK-33', stage: 'static_chain', scope: 'knowledge_source_order' },
  { id: 'CK-34', stage: 'static_chain', scope: 'search_query_and_acl' }
])

function evidenceText(item) {
  return [item && item.text, item && item.note].filter(Boolean).join('\n')
}

function normalizedLabelText(value) {
  return String(value || '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|li|div)>/gi, '\n')
}

function hasMetric(text) {
  return /(?:\d+(?:\.\d+)?\s*(?:%|％|元|万元|次|人|天|件|个|倍|小时|分钟|秒|年|月|周|日|级|分|条|家|户|单|项|张|台|套|吨|kg|KG|GB|MB|次\/月|次\/周)|\d+\s*[-~至到]\s*\d+|第[一二三四五六七八九十]+[档级])/i.test(String(text || ''))
}

function meaningfulValue(value) {
  if (value == null) return false
  if (Array.isArray(value)) return value.some(meaningfulValue)
  if (typeof value === 'object') return Object.values(value).some(meaningfulValue)
  const text = String(value).trim()
  return !!text && !/^(?:待补充|待项目补充|【待项目补充】|未知|未定|待确认|暂无|todo|tbd|n\/a|无)$/i.test(text)
}

function labelValue(text, labels) {
  const value = normalizedLabelText(text)
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = value.match(new RegExp(`(?:^|[\\n；;，,])\\s*${escaped}\\s*[:：=]\\s*([^\\n；;，,]*)`, 'i'))
    if (match && meaningfulValue(match[1].trim())) return true
  }
  return false
}

function fieldValue(text, field) {
  const value = normalizedLabelText(text)
  const labels = {
    targetValue: ['目标值', '目标'],
    frequency: ['频率', '周期', '时间要求'],
    inputs: ['输入源', '输入', '数据源', '依赖资料', '所需材料', '参考资料'],
    criterion: ['判据', '检查标准', '验收标准', '完成标准', '合格标准', '判断条件'],
    owner: ['责任人', '负责人', '执行人', '责任角色', '执行者'],
    outputs: ['产物', '输出', '交付物', '输出物', '结果记录'],
    remediation: ['未达标处置', '异常处置', '不通过处置', '处理方式']
  }
  for (const label of labels[field] || []) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = value.match(new RegExp(`(?:^|[\\n；;，,])\\s*${escaped}\\s*[:：=]\\s*([^\\n；;，,]*)`, 'i'))
    if (match && meaningfulValue(match[1])) return match[1].trim()
  }
  return ''
}

function exactFieldPresent(text, field) {
  const value = String(text || '').trim()
  if (!value) return false
  const labels = {
    frequency: ['频率', '周期', '时间要求'],
    inputs: ['输入源', '输入', '数据源', '依赖资料', '所需材料', '参考资料'],
    criterion: ['判据', '检查标准', '验收标准', '完成标准', '合格标准', '判断条件'],
    owner: ['责任人', '负责人', '执行人', '责任角色', '执行者'],
    outputs: ['产物', '输出', '交付物', '输出物', '结果记录']
  }
  const labelled = labelValue(value, labels[field] || [])
  if (labelled) return true
  const cadence = /每日|每周|每月|每季度|每年|每个工作日|每\d+\s*(?:天|周|月|季度|年)|按(?:日|周|月|季度|年|批次)/.test(value)
  if (field === 'frequency') return cadence
  if (field === 'inputs') return /从\s*[^，,；;\n]{1,24}(?:表|系统|文件|平台|数据库|清单|记录)\s*(?:读取|取数|查询|导出)/.test(value)
  if (field === 'criterion') return /达标条件|符合条件|至少\s*\d|不低于\s*\d|不超过\s*\d|≤\s*\d|≥\s*\d|达到\s*\d/.test(value)
  if (field === 'owner') return /(?:执行者|AI|人|人工)\s*[:：]\s*[^，,；;\n]+/i.test(value)
  if (field === 'outputs') return /生成\s*[^，,；;\n]{1,24}(?:报告|清单|记录|文件|表格|看板)/.test(value)
  return false
}

function finding({
  ruleId,
  title,
  status = 'needs_info',
  severity = 'blocker',
  message,
  field = null,
  nodeUid = null,
  evidence = '',
  quote = '',
  sourceRef = null,
  suggestedValue = '',
  checkKey = '',
  requiredQuote = '',
  details = null,
  missingCount = null
}) {
  const rule = RULE_REGISTRY.find(item => item.id === ruleId)
  const stage = rule && rule.stage || 'static_chain'
  const nextStep = status === 'passed' || status === 'not_applicable'
    ? ''
    : status === 'failed'
      ? '修复链路结构后重新检查。'
      : status === 'needs_confirmation'
        ? '确认对应链路后继续检查。'
        : status === 'needs_info'
          ? '核对对应关系或补充完整、可核验的来源。'
          : '补齐该字段或引用来源后重新检查。'
  const result = {
    ruleId,
    stage,
    title,
    status,
    severity,
    message,
    field,
    nodeUid,
    evidence,
    quote,
    sourceRef,
    suggestedValue: String(suggestedValue || ''),
    checkKey,
    requiredQuote: String(requiredQuote || ''),
    nextStep
  }
  if (Array.isArray(details) && details.length) result.details = details
  if (missingCount != null) result.missingCount = Number(missingCount)
  return result
}

function notApplicable(ruleId, title, reason) {
  return finding({ ruleId, title, status: 'not_applicable', severity: 'info', message: reason })
}

function checkStructure(snapshot, chain, data) {
  const result = []
  const { nodes, checkNodes, planNodes, dNodes } = data
  result.push(notApplicable('CK-01', '通用与项目分流', '当前检查对象是单条业务链路，不是方法论内核。'))
  result.push(notApplicable('CK-03', '保密项外流过滤', '当前检查结果仅供有房间查看权限的用户读取；对外分享产物的保密检查不适用。'))
  result.push(notApplicable('CK-04', '北极星 C 唯一', '单链路检查不评整图北极星 C 唯一性。'))
  result.push(notApplicable('CK-08', '业务视角覆盖完整', '业务域覆盖需要整图视角，当前链路不能判定。'))
  result.push(notApplicable('CK-15', '全图评级', 'A/B/C 评级仅适用于整图体检。'))

  const roleNodes = [...checkNodes, ...planNodes, ...dNodes]
  const missingPrefix = roleNodes.filter(item => {
    const text = item.text.trim()
    return item.role && !new RegExp(`^${item.role}：`).test(text)
  })
  result.push(finding({
    ruleId: 'CK-05', title: '角色前缀', status: missingPrefix.length ? 'needs_info' : 'passed',
    severity: 'warning',
    message: missingPrefix.length ? '发现使用别名或半角冒号的 C/P/D 节点；请核对角色前缀。' : '链路角色前缀符合全角冒号规范。',
    nodeUid: missingPrefix[0] && missingPrefix[0].uid,
    quote: missingPrefix[0] && missingPrefix[0].text || ''
  }))

  const chainUidSet = new Set(chain.auditNodeUids || chain.nodeUids || [])
  const badChildRefs = []
  for (const uid of chainUidSet) {
    const node = nodes[uid]
    for (const child of (node && node.children) || []) {
      const childUid = typeof child === 'string' ? child : child && child.uid
      if (childUid && !nodes[childUid]) badChildRefs.push({ uid, childUid })
    }
  }
  result.push(finding({
    ruleId: 'CK-06', title: '节点归属与孤儿节点',
    status: badChildRefs.length ? 'failed' : 'passed', severity: badChildRefs.length ? 'blocker' : 'info',
    message: badChildRefs.length ? '链路包含指向不存在节点的子节点引用，结构无法完整核验。' : '当前链路的父子引用完整。',
    nodeUid: badChildRefs[0] && badChildRefs[0].uid,
    quote: badChildRefs[0] ? `missing child ${badChildRefs[0].childUid}` : ''
  }))

  const planRoots = new Set(chain.planRootUids || [])
  const targets = planNodes.filter(item => item.text && (
    item.role === 'P' && !chainUtils.isBareRoleLabel(item.text) ||
    item.leaf && !planRoots.has(item.uid)
  ))
  if (!targets.length) result.push(finding({
    ruleId: 'CK-07', title: 'P 目标可度量', status: 'needs_supplement', severity: 'blocker', field: 'targetValue',
    evidence: '没有可核验的 P 目标。', message: '没有可核验的 P 目标。'
  }))
  else targets.forEach(item => {
    const measurable = hasMetric(evidenceText(item))
    result.push(finding({
      ruleId: 'CK-07', title: 'P 目标可度量', status: measurable ? 'passed' : 'needs_supplement',
      severity: measurable ? 'info' : 'blocker', field: measurable ? null : 'targetValue',
      nodeUid: item.uid, quote: item.text,
      evidence: measurable ? '' : 'P 目标中未找到明确目标值、比例或档位。',
      message: measurable ? 'P 目标包含可识别的数值或档位。' : 'P 目标缺少明确目标值、比例或档位。'
    }))
  })

  if (!dNodes.length) {
    result.push(finding({
      ruleId: 'CK-12', title: '过程 C 与 D 上溯关系', status: 'needs_info', severity: 'blocker',
      message: '未找到可单独识别的 D 节点或执行步骤，需要确认当前选中任务在链路中的角色。'
    }))
  } else {
    const checkRoots = new Set(chain.checkRootUids || [])
    const orphanD = dNodes.filter(item => {
      let parent = data.parents.get(item.uid)
      const seen = new Set()
      while (parent && !seen.has(parent)) {
        if (checkRoots.has(parent)) return false
        seen.add(parent)
        parent = data.parents.get(parent)
      }
      // CPD may be represented by sibling C/P branches; that relationship is
      // valid only when the candidate was resolved as one explicit pair.
      return !(chain.checkRootUids.length && chain.planRootUids.length)
    })
    result.push(finding({
      ruleId: 'CK-12', title: '过程 C 与 D 上溯关系',
      status: orphanD.length ? 'failed' : 'passed', severity: orphanD.length ? 'blocker' : 'info',
      message: orphanD.length ? '部分 D 找不到关联的 C；该链路存在开环。' : 'D 可沿嵌套或同级 CPD 关系关联到 C。',
      nodeUid: orphanD[0] && orphanD[0].uid,
      quote: orphanD[0] && orphanD[0].text || ''
    }))
  }

  const sourceMarked = roleNodes.filter(item => /(?:推论数据|推测数据|估算值|大概)/.test(evidenceText(item)))
  result.push(finding({
    ruleId: 'CK-14', title: '命名与来源规范', status: sourceMarked.length ? 'needs_info' : 'passed',
    severity: 'warning', nodeUid: sourceMarked[0] && sourceMarked[0].uid,
    quote: sourceMarked[0] && sourceMarked[0].text || '',
    message: sourceMarked.length ? '发现推论或估算数据标记，请补充真实来源并交叉验证。' : '未发现明确的推论数据标记；来源是否充分仍需结合附件和引用核验。'
  }))
  return result
}

function checkDFields(chain, data) {
  const findings = []
  const fields = ['frequency', 'inputs', 'criterion', 'owner', 'outputs']
  const fieldLabels = {
    frequency: '频率', inputs: '输入源', criterion: '判据', owner: '责任人', outputs: '产物'
  }
  if (!data.dNodes.length) {
    findings.push(finding({ ruleId: 'CK-09', title: 'D 五要素齐全', status: 'needs_info', severity: 'blocker', message: '未识别到 D 节点，无法核验五要素。' }))
    return findings
  }
  data.dNodes.forEach(item => {
    const node = data.nodes[item.uid] || {}
    const values = node.data && typeof node.data === 'object' ? node.data : {}
    const text = evidenceText(item)
    fields.forEach(field => {
      const present = meaningfulValue(values[field]) || exactFieldPresent(text, field)
      if (!present) {
        findings.push(finding({
          ruleId: 'CK-09', title: 'D 五要素齐全', status: 'needs_supplement', severity: 'blocker',
          field, nodeUid: item.uid,
          quote: item.text,
          evidence: `D 节点缺少${fieldLabels[field]}。`,
          message: `D 节点缺少${fieldLabels[field]}。`
        }))
      }
    })
  })
  if (!findings.length) findings.push(finding({ ruleId: 'CK-09', title: 'D 五要素齐全', status: 'passed', severity: 'info', message: '每个可识别 D 均包含频率、输入源、判据、责任人和产物。' }))
  return findings
}

function checkAcceptance(chain, data) {
  const checkItems = data.checkNodes.filter(item => item.text)
  if (!checkItems.length) return [finding({
    ruleId: 'CK-11', title: '验收闭环', status: 'needs_info', severity: 'blocker',
    nodeUid: chain.checkRootUids[0] || null,
    message: '未找到可核验的 C 检查项。'
  })]
  return checkItems.flatMap(item => {
    const checkText = evidenceText(item)
    const combined = [checkText, ...data.dNodes.map(evidenceText)].join('\n')
    const hasCriterion = /判据|检查标准|验收标准|完成标准|达标|合格|符合|不低于|不少于|不超过|≤|≥/.test(checkText)
    const hasRemediation = /未达标|不达标|不通过|不符合|异常|偏差/.test(combined) && /(?:时|后|则|应|暂停|调整|返工|重新|升级|通知|处理|补充|纠正|复核)/.test(combined)
    if (!hasCriterion) return [finding({
      ruleId: 'CK-11', title: '验收闭环', status: 'needs_supplement', severity: 'blocker', field: 'criterion',
      nodeUid: item.uid, quote: item.text, checkKey: `CK-11:${item.uid}:criterion`,
      message: '该 C 检查项未找到明确的达标判据。'
    })]
    if (!hasRemediation) return [finding({
      ruleId: 'CK-11', title: '验收闭环', status: 'needs_supplement', severity: 'blocker', field: 'remediation',
      nodeUid: item.uid, quote: item.text, checkKey: `CK-11:${item.uid}:remediation`,
      message: '该 C 检查项未找到未达标时的处置方式。'
    })]
    return [finding({
      ruleId: 'CK-11', title: '验收闭环', status: 'needs_info', severity: 'blocker',
      nodeUid: item.uid, quote: item.text, checkKey: `CK-11:${item.uid}:closure-review`,
      message: '文本包含判据和异常处置关键词，需核验二者确实形成闭环。'
    })]
  })
}

function checkProgress(chain, data) {
  const nodes = [...data.planNodes, ...data.dNodes]
  const text = nodes.map(evidenceText).join('\n')
  if (!/进度|进展|进度目标/.test(text)) {
    return [notApplicable('CK-13', '进度闭环', '当前链路没有明确涉及进度跟踪。')]
  }
  const hasBoth = /进度内/.test(text) && /进度外/.test(text)
  return [finding({
    ruleId: 'CK-13', title: '进度闭环', status: hasBoth ? 'needs_info' : 'needs_supplement',
    severity: 'warning', nodeUid: chain.planRootUids[0] || null,
    message: hasBoth ? '已看到进度内外分支，分支处置是否明确需进一步核验。' : '涉及进度跟踪的链路需要补充进度内和进度外的处置分支。',
    field: hasBoth ? null : 'remediation'
  })]
}

function checkMaterials(chain, snapshot, data) {
  const sources = Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : []
  const relevant = sources.filter(source => {
    const uid = source.nodeUid || source.sourceRef && source.sourceRef.nodeUid
    return !uid || (chain.nodeUids || []).includes(uid)
  })
  const requirements = []
  for (const item of data.dNodes) {
    const rawNode = data.nodes[item.uid] || {}
    const fields = rawNode.data && typeof rawNode.data === 'object' ? rawNode.data : {}
    const inputValue = fields.inputs || fields.input || fields.dataSource || fieldValue(evidenceText(item), 'inputs')
    if (meaningfulValue(inputValue)) {
      const sourceQuote = String(inputValue).trim()
      String(inputValue).split(/[，,、；;|]/).map(value => value.trim()).filter(meaningfulValue).forEach(term => {
        const checkKey = `CK-29:${item.uid}:${cryptoKey(term)}`
        requirements.push({ nodeUid: item.uid, term, quote: sourceQuote, checkKey })
      })
    }
  }
  const completeStatus = source => source && source.complete !== false && !source.truncated &&
    (source.status == null || ['ready','ok'].includes(String(source.status))) && String(source.content || '').trim()
  const linksForRequirement = requirement => {
    const node = data.nodes[requirement.nodeUid] || {}
    const fields = node.data && typeof node.data === 'object' ? node.data : {}
    const attachments = [].concat(fields.attachments || [], fields.attachmentId || []).filter(Boolean).map(item => typeof item === 'object' ? item.id || item.attachmentId : item).map(String)
    const typedRefs = Array.isArray(fields.cpdCheckReferences) ? fields.cpdCheckReferences : []
    return relevant.filter(source => {
      const ref = source.sourceRef || {}
      const sourceNodeUid = String(source.nodeUid || ref.nodeUid || '')
      const attachmentLinked = ref.type === 'attachment' &&
        (sourceNodeUid === requirement.nodeUid || attachments.includes(String(ref.id || '')))
      const typedRef = typedRefs.find(item =>
        item && item.sourceRef && JSON.stringify(item.sourceRef) === JSON.stringify(ref) &&
        (item.field === 'reference' || item.field === 'inputs' || item.field === 'dataSource')
      )
      const knowledgeLinked = !!(typedRef && source.linkedReference === true &&
        String(typedRef.sourceVersion || '') === String(source.version || '') &&
        String(typedRef.quote || typedRef.referenceQuote || '').trim() &&
        String(source.content || '').includes(String(typedRef.quote || typedRef.referenceQuote)))
      return sourceNodeUid === requirement.nodeUid && (attachmentLinked || knowledgeLinked)
    })
  }
  if (!requirements.length) return [notApplicable('CK-29', '整链材料齐备', '当前链路没有明确声明必需材料；未对材料齐备性作通过判定。')]
  const findings = []
  for (const requirement of requirements) {
    const candidates = linksForRequirement(requirement)
    const good = candidates.filter(completeStatus)
    const incomplete = candidates.some(source => !completeStatus(source))
    if (good.length) {
      const matching = good.find(source => `${source.title || ''}\n${source.content || ''}`.toLowerCase().includes(requirement.term.toLowerCase()))
      findings.push(finding({
        ruleId: 'CK-29', title: '整链材料齐备', status: 'needs_info', severity: 'blocker',
        field: 'reference', nodeUid: requirement.nodeUid, quote: requirement.quote,
        requiredQuote: requirement.term,
        sourceRef: matching && matching.sourceRef || good[0].sourceRef || null,
        evidence: matching ? `已读取关联来源，需确认“${requirement.term}”与材料用途相符。` : `已读取关联来源，但无法将“${requirement.term}”与材料正文精确对应。`,
        message: matching ? `材料“${requirement.term}”已完整读取，需核验与此 D 输入的对应关系。` : `已关联材料但正文未识别到“${requirement.term}”。`,
        checkKey: requirement.checkKey
      }))
    } else {
      const node = data.nodes[requirement.nodeUid] || {}
      const fields = node.data && typeof node.data === 'object' ? node.data : {}
      const hasUrl = !!(fields.hyperlink || fields.url || node.hyperlink || node.url)
      findings.push(finding({
        ruleId: 'CK-29', title: '整链材料齐备',
        status: incomplete || hasUrl ? 'needs_info' : 'needs_supplement', severity: 'blocker',
        field: 'reference', nodeUid: requirement.nodeUid, quote: requirement.quote,
        requiredQuote: requirement.term,
        evidence: incomplete || hasUrl ? '链接或附件未能完整读取，不能据预览判定材料齐备。' : `没有可读取的“${requirement.term}”来源。`,
        message: incomplete || hasUrl ? `材料“${requirement.term}”尚未完成正文核验。` : `缺少必需材料“${requirement.term}”。`,
        checkKey: requirement.checkKey
      }))
    }
  }
  return findings
}

function cryptoKey(value) {
  return require('crypto').createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

function deferredFindings() {
  return DEFERRED_RULE_IDS.map(id => notApplicable(id, '执行阶段规则', '这是运行、收口、回填或纪律检查，本次静态链路检查不判定。'))
}

function checkSopCard(snapshot, chain, data) {
  const card = snapshot && (snapshot.sopCard || (snapshot.actualSopCard === true && snapshot.card))
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return [
      notApplicable('CK-02', '项目数值来源', '当前快照不包含实际 SOP 卡。'),
      notApplicable('CK-16', 'SOP 卡必填字段', '当前对象不是 SOP 卡。'),
      ...['CK-17','CK-18','CK-19','CK-20','CK-21','CK-22'].map(id => notApplicable(id, 'SOP 卡来源与定位', '当前对象不是 SOP 卡。'))
    ]
  }
  const missing = CARD_FIELDS.filter(field => !meaningfulValue(card[field]))
  const findings = [finding({
    ruleId: 'CK-16', title: 'SOP 卡必填字段', status: missing.length ? 'needs_supplement' : 'passed',
    severity: missing.length ? 'blocker' : 'info', field: missing[0] || null,
    message: missing.length ? `SOP 卡缺少字段：${missing.join('、')}` : 'SOP 卡的十三个必填字段齐全。'
  })]
  const objective = String(card.objective || '')
  const projectSource = String(card.project_source || card.source || '')
  findings.push(finding({
    ruleId: 'CK-02', title: '项目数值来源',
    status: hasMetric(objective) ? (meaningfulValue(projectSource) ? 'passed' : 'needs_supplement') : 'passed',
    severity: hasMetric(objective) && !meaningfulValue(projectSource) ? 'warning' : 'info', field: 'targetValue',
    message: hasMetric(objective) && !meaningfulValue(projectSource) ? 'SOP 卡 objective 含数值，但未找到项目包来源引用。' : '已核验 objective 与项目来源字段。'
  }))
  const pathValue = Array.isArray(card.cpd_path) ? card.cpd_path.join('/') : String(card.cpd_path || '')
  const pathText = (chain && chain.path || []).map(item => item.text).filter(Boolean).join('/')
  findings.push(finding({
    ruleId: 'CK-17', title: 'cpd_path 沿链取值',
    status: pathValue && chain && (pathValue === pathText || pathValue.includes(chain.chainUid)) ? 'passed' : 'needs_info',
    severity: 'blocker', field: 'cpd_path', nodeUid: chain && chain.chainUid,
    message: pathValue && chain && (pathValue === pathText || pathValue.includes(chain.chainUid))
      ? 'SOP 卡 cpd_path 与本链路一致。'
      : '无法确认 SOP 卡 cpd_path 与当前节点祖先链一致。'
  }))
  const planText = (data && data.planNodes || []).map(evidenceText).join('\n')
  const objectiveText = String(card.objective || '').trim()
  findings.push(finding({
    ruleId: 'CK-18', title: 'objective 取自相关 P',
    status: objectiveText && planText.includes(objectiveText) ? 'passed' : 'needs_info', severity: 'blocker',
    field: 'targetValue', nodeUid: chain && chain.planRootUids && chain.planRootUids[0],
    quote: objectiveText,
    message: objectiveText && planText.includes(objectiveText) ? 'objective 可在相关 P 原文中定位。' : '无法在相关 P 原文中精确定位 objective，不能自行拟定目标值。'
  }))
  const criteria = card.check_standard || card.criteria
  const criteriaText = typeof criteria === 'string' ? criteria : criteria && typeof criteria === 'object' ? JSON.stringify(criteria) : ''
  const checkText = (data && data.checkNodes || []).map(evidenceText).join('\n')
  const criteriaPresent = meaningfulValue(criteria) && checkText.includes(criteriaText)
  findings.push(finding({
    ruleId: 'CK-19', title: '判据只搬不编',
    status: criteriaPresent ? 'passed' : 'needs_info', severity: 'blocker', field: 'criterion',
    nodeUid: chain && chain.checkRootUids && chain.checkRootUids[0], quote: criteriaText,
    message: criteriaPresent ? '判据可在相关 C 原文中定位。' : '无法在相关 C 或项目包来源中核验判据原文。'
  }))
  findings.push(finding({
    ruleId: 'CK-20', title: 'D 只认最近主链',
    status: chain && chain.checkRootUids && chain.checkRootUids.length === 1 ? 'passed' : 'needs_confirmation',
    severity: 'blocker',
    message: chain && chain.checkRootUids && chain.checkRootUids.length === 1
      ? '当前 SOP 卡对应一个明确的主检查链。'
      : '存在多个可能的相关 C，需要确认最近主链。'
  }))
  findings.push(finding({
    ruleId: 'CK-21', title: '相关 C/P 定位',
    status: chain && chain.checkRootUids.length && chain.planRootUids.length ? 'passed' : 'failed',
    severity: 'blocker', nodeUid: chain && chain.chainUid,
    message: chain && chain.checkRootUids.length && chain.planRootUids.length
      ? '相关 C 和 P 已从链路结构定位。'
      : '无法沿链路定位到相关 C/P。'
  }))
  const title = String(card.title || '')
  const namingOkay = /^(?:C|P|D)：/.test(title) || /执行者:|AI:|人:/.test(String(card.steps || ''))
  findings.push(finding({
    ruleId: 'CK-22', title: '命名规范', status: namingOkay ? 'passed' : 'needs_info', severity: 'warning',
    message: namingOkay ? 'SOP 卡名称或步骤包含规范角色前缀。' : 'SOP 卡命名或执行者前缀需人工核对。'
  }))
  return findings
}

function aggregateMissingFindings(unresolvedFindings) {
  const grouped = new Map()
  for (const item of unresolvedFindings || []) {
    const uid = String(item.nodeUid || '')
    const entry = grouped.get(uid) || { nodeUid: item.nodeUid || null, fields: [], details: [] }
    if (item.field && !entry.fields.includes(item.field)) entry.fields.push(item.field)
    entry.details.push({
      ruleId: item.ruleId,
      field: item.field || null,
      fieldLabel: fieldLabel(item.field),
      message: String(item.message || '')
    })
    grouped.set(uid, entry)
  }
  return [...grouped.values()].map(entry => {
    const labels = entry.fields.map(fieldLabel).filter(Boolean)
    const count = entry.details.length
    const scopeText = labels.length ? `缺少：${labels.join('、')}` : '存在待确认缺项'
    return finding({
      ruleId: 'CK-32', title: '缺项汇总', status: 'needs_supplement', severity: 'warning',
      field: entry.fields[0] || null, nodeUid: entry.nodeUid,
      message: `${scopeText}（共 ${count} 项）。`,
      details: entry.details,
      missingCount: count
    })
  })
}

function sourceSearchFindings(sourceStatuses, unresolvedFindings) {
  const results = [...aggregateMissingFindings(unresolvedFindings)]
  const statuses = Array.isArray(sourceStatuses) ? sourceStatuses : []
  const searchAttempted = statuses.some(item => item.scope)
  const problems = statuses.filter(sourceProblem)
  const scopes = [...new Set(statuses.filter(item => item.scope).map(item => item.scope))]
  const scopeText = scopes.map(scope => SCOPE_LABELS[scope] || scope).join('、')

  results.push(searchAttempted
    ? finding({
      ruleId: 'CK-30', title: '三级检索', status: problems.length ? 'needs_info' : 'passed', severity: 'warning',
      message: problems.length
        ? `部分来源未完成只读检索或读取：${[...new Set(problems.map(item => `${item.candidateId ? '来源' : SCOPE_LABELS[item.scope] || item.scope || '来源'}${sourceStatusLabel(item.status, item.error)}`))].join('；')}。`
        : '按本链路 → 当前图资料 → 房间绑定知识库 → Wiki 顺序执行只读检索，材料足够或需要确认流程时暂停后续检索。'
    })
    : notApplicable('CK-30', '三级检索', '本链路没有未解决的缺项，无需继续检索。'))

  const wikiStatuses = statuses.filter(item => item.scope === 'wiki')
  const wikiFailed = wikiStatuses.some(sourceProblem)
  const wikiAsked = wikiStatuses.length > 0
  const wikiText = !wikiAsked
    ? '本次未检索到 Wiki 阶段'
    : wikiFailed ? 'Wiki 已接入但本次检索或读取失败'
      : wikiStatuses.some(item => item.status === 'no_results') ? 'Wiki 无命中的当前有效主题'
        : 'Wiki 检索可用'
  results.push(searchAttempted
    ? finding({
      ruleId: 'CK-33', title: '知识节点定位',
      status: wikiFailed ? 'needs_info' : 'passed', severity: wikiFailed ? 'warning' : 'info',
      message: `检索范围：${scopeText || '未记录'}；${wikiText}。知识节点定位优先本图，再到房间绑定知识库与 Wiki。`
    })
    : notApplicable('CK-33', '知识节点定位', '本链路没有未解决的缺项，无需检索知识源。'))

  results.push(searchAttempted
    ? finding({
      ruleId: 'CK-34', title: '检索纪律', status: problems.length ? 'needs_info' : 'passed', severity: 'warning',
      message: problems.length
        ? '检索中断、无权限或读取失败只说明当前来源未核验，不能解释为资料不存在；请按来源状态处理。'
        : '检索词取自链路缺项与业务上下文，未只读镜像页或不加区分地复制 D 标题。'
    })
    : notApplicable('CK-34', '检索纪律', '本链路无需检索。'))
  return results
}

module.exports = {
  RULE_VERSION,
  CARD_FIELDS,
  RULE_REGISTRY,
  DEFERRED_RULE_IDS,
  FIELD_LABELS,
  SCOPE_LABELS,
  SOURCE_FAILURE_STATUSES,
  fieldLabel,
  sourceStatusLabel,
  sourceProblem,
  finding,
  notApplicable,
  evidenceText,
  hasMetric,
  exactFieldPresent,
  fieldValue,
  checkStructure,
  checkDFields,
  checkAcceptance,
  checkProgress,
  checkSopCard,
  checkMaterials,
  aggregateMissingFindings,
  sourceSearchFindings,
  deferredFindings
}
