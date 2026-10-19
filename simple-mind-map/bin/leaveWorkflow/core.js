const { createHash } = require('crypto')
const plain = value =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
const digest = value =>
  createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
const label = value =>
  plain(value)
    .replace(/〔.*?〕|\[.*?\]/g, '')
    .trim()
const FIELDS = {
  请假类型: 'leaveType',
  开始时间: 'start',
  结束时间: 'end',
  工作替补人: 'replacementId',
  请假事由: 'reason',
  附件: 'attachmentIds'
}
function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}
function compileTemplate(nodes, rootUid) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 500)
    throw failure('TEMPLATE_LIMIT', '请假模板不存在或超过500节点')
  const normalized = nodes.map(n => ({
    uid: n.uid,
    parent_uid: n.parent_uid,
    text: plain((n.data || n).text),
    position: n.position || '',
    data: n.data || n
  }))
  const children = uid =>
    normalized
      .filter(n => n.parent_uid === uid)
      .sort(
        (a, b) =>
          a.position.localeCompare(b.position) || a.uid.localeCompare(b.uid)
      )
  const root = normalized.find(n => n.uid === rootUid)
  if (!root) throw failure('TEMPLATE_NOT_FOUND', '请假模板节点不存在', 404)
  const descendants = uid => {
    const result = []
    const walk = (id, seen = new Set()) => {
      if (seen.has(id)) throw failure('TEMPLATE_CYCLE', '模板有循环')
      seen.add(id)
      for (const n of children(id)) {
        result.push(n)
        walk(n.uid, new Set(seen))
      }
    }
    walk(uid)
    return result
  }
  const top = children(rootUid),
    required = top.find(n => label(n.text) === '必要条件')
  const type =
    required && children(required.uid).find(n => label(n.text) === '请假类型')
  const config = top.find(n =>
    /^(审批配置|审批人员配置|人员配置)$/.test(label(n.text))
  )
  const configuration = config ? descendants(config.uid) : []
  const account = n =>
    String(
      n.data.approvalUserId ||
        (n.text.match(/^(?:账号|user_id|成员ID)\s*[:：]\s*([^\s]+)$/i) ||
          [])[1] ||
        ''
    ).trim()
  const accountsUnder = uid => [
    ...new Set(
      descendants(uid)
        .map(account)
        .filter(id => id && !/待配置|待补/.test(id))
    )
  ]
  const context = (node, stepUid) => {
    const path = []
    let p = normalized.find(n => n.uid === node.parent_uid)
    while (p && p.uid !== stepUid && path.length < 20) {
      path.unshift(p.text)
      p = normalized.find(n => n.uid === p.parent_uid)
    }
    return path
  }
  const steps = top
    .filter(
      n =>
        !/^(必要条件|审批配置|审批人员配置|人员配置|工作时间|工作日历|概要|\[概要\])/.test(
          label(n.text)
        ) && !/^抄送/.test(label(n.text))
    )
    .map(n => {
      const binding = configuration.find(c => label(c.text) === label(n.text))
      return {
        uid: n.uid,
        role: label(n.text),
        bindingUid: binding && binding.uid,
        accounts: binding ? accountsUnder(binding.uid) : [],
        bindingNodes: binding
          ? descendants(binding.uid).map(c => ({
              uid: c.uid,
              parent_uid: c.parent_uid,
              text: c.text,
              account: account(c)
            }))
          : [],
        criteria: descendants(n.uid)
          .filter(c => !children(c.uid).length)
          .map(c => ({ uid: c.uid, text: c.text, context: context(c, n.uid) }))
      }
    })
  const ccNode = top.find(n => /^抄送/.test(label(n.text)))
  const ccBinding = configuration.find(n => /^抄送/.test(label(n.text)))
  const allText = normalized.map(n => n.text).join('\n')
  const calendarNode = normalized.find(
    n =>
      /(?:工作时间|上班时间|工作日)/.test(n.text) &&
      /\d{1,2}:\d{2}\s*[-–—~至]/.test(n.text)
  )
  const periods = calendarNode
    ? [
        ...calendarNode.text.matchAll(
          /(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/g
        )
      ].map(m => [
        Number(m[1]) * 60 + Number(m[2]),
        Number(m[3]) * 60 + Number(m[4])
      ])
    : []
  const dateOverrides = prefix =>
    normalized
      .filter(n => n.text.startsWith(prefix))
      .flatMap(n => n.text.match(/\d{4}-\d{2}-\d{2}/g) || [])
  const calendar = {
    periods,
    holidays: dateOverrides('非工作日'),
    workdays: dateOverrides('补班日'),
    sourceUid: calendarNode && calendarNode.uid,
    holidayCalendarConfigured: normalized.some(n =>
      /^节假日日历已配置/.test(n.text)
    )
  }
  const warnings = []
  if (!required) warnings.push('必要条件未登记')
  if (!periods.length) warnings.push('工作时段待配置')
  const types = type ? children(type.uid).map(n => label(n.text)) : []
  const typeRequirements = type
    ? Object.fromEntries(
        children(type.uid).map(n => [
          label(n.text),
          descendants(n.uid).map(c => c.text)
        ])
      )
    : {}
  if (/病假/.test(allText) && !types.includes('病假'))
    warnings.push('审核规则有病假，但必要条件的类型未登记病假')
  if (!steps.length) warnings.push('审批步骤待配置')
  if (ccNode && !ccBinding) warnings.push('抄送人员待配置')
  const ccRoles = ccNode
    ? label(ccNode.text)
        .replace(/^抄送/, '')
        .split(/[、,，]/)
        .filter(Boolean)
    : []
  const ccMissing = ccRoles.filter(
    role =>
      !ccBinding ||
      !descendants(ccBinding.uid).some(
        n => label(n.text) === role && accountsUnder(n.uid).length
      )
  )
  const ccBindings = ccRoles.map(role => {
    const binding =
      ccBinding && descendants(ccBinding.uid).find(n => label(n.text) === role)
    return {
      role,
      accounts: binding ? accountsUnder(binding.uid) : [],
      bindingUid: binding && binding.uid,
      bindingNodes: binding
        ? descendants(binding.uid).map(c => ({
            uid: c.uid,
            parent_uid: c.parent_uid,
            text: c.text,
            account: account(c)
          }))
        : []
    }
  })
  return {
    title: root.text,
    rootUid,
    fingerprint: digest(
      normalized.map(n => ({
        uid: n.uid,
        parent: n.parent_uid,
        text: n.text,
        position: n.position,
        approvalUserId: n.data.approvalUserId || ''
      }))
    ),
    fields: required
      ? children(required.uid)
          .filter(n => FIELDS[label(n.text)])
          .map(n => ({
            uid: n.uid,
            label: label(n.text),
            key: FIELDS[label(n.text)],
            requirements: descendants(n.uid).map(c => ({
              uid: c.uid,
              text: c.text
            }))
          }))
      : [],
    types,
    typeRequirements,
    steps,
    cc: ccBinding ? accountsUnder(ccBinding.uid) : [],
    ccRequired: !!ccNode,
    ccMissing,
    ccBindings,
    calendar,
    warnings
  }
}
function dateValue(value) {
  const s = String(value || '')
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(s)
  )
    throw failure(
      'INVALID_DATE',
      '时间请使用明确的日期和时刻，不使用“明天”等相对日期'
    )
  const result = new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + '+08:00')
  if (!Number.isFinite(result.getTime()))
    throw failure('INVALID_DATE', '日期时间无效')
  const [year, month, day] = s
    .slice(0, 10)
    .split('-')
    .map(Number)
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    Number(s.slice(11, 13)) > 23 ||
    Number(s.slice(14, 16)) > 59
  )
    throw failure('INVALID_DATE', '日期时间无效')
  return result
}
function workingMinutes(start, end, calendar) {
  const a = dateValue(start).getTime(),
    b = dateValue(end).getTime()
  if (b <= a || b - a > 366 * 86400000)
    throw failure('INVALID_RANGE', '结束时间须晚于开始时间，区间不得超过一年')
  const periods = calendar.periods || []
  if (
    !periods.length ||
    periods.some(
      ([x, y], i) => x < 0 || y > 1440 || x >= y || (i && x < periods[i - 1][1])
    )
  )
    throw failure('CALENDAR_NOT_CONFIGURED', '请先在脑图登记不重叠的工作时段')
  const offset = 8 * 3600000,
    midnight = Math.floor((a + offset) / 86400000) * 86400000 - offset
  let total = 0
  for (let day = midnight; day < b; day += 86400000) {
    const local = new Date(day + offset),
      key = local.toISOString().slice(0, 10),
      weekday = local.getUTCDay()
    const working =
      (calendar.workdays || []).includes(key) ||
      (weekday !== 0 &&
        weekday !== 6 &&
        !(calendar.holidays || []).includes(key))
    if (working)
      for (const [x, y] of periods)
        total +=
          Math.max(
            0,
            Math.min(b, day + y * 60000) - Math.max(a, day + x * 60000)
          ) / 60000
  }
  return Math.round(total)
}
function extractFields(nodes, rootUid) {
  const children = uid => nodes.filter(n => n.parent_uid === uid)
  const data = n => plain((n.data || n).text)
  const group = children(rootUid).find(n => /^申请资料$/.test(data(n)))
  const values = {}
  for (const n of group ? children(group.uid) : children(rootUid)) {
    const text = data(n),
      split = text.match(/^([^:：]+)[:：](.*)$/),
      name = label(split ? split[1] : text),
      key = FIELDS[name]
    if (!key) continue
    const raw =
      (split && split[2].trim()) ||
      children(n.uid)
        .map(data)
        .filter(s => !/待填写/.test(s))
        .join('\n')
    if (!raw || raw === '待填写') continue
    if (key === 'attachmentIds') continue // Attachments must be resolved from actual metadata, never arbitrary text IDs.
    values[key] =
      key === 'replacementId'
        ? raw.replace(/^(账号|user_id)[:：]\s*/i, '')
        : raw.replace(' ', key === 'start' || key === 'end' ? 'T' : ' ')
  }
  return values
}
function evaluate(template, fields, now = new Date()) {
  const missing = template.fields
    .filter(
      f => f.key !== 'attachmentIds' && !String(fields[f.key] || '').trim()
    )
    .map(f => f.label)
  const blockers = [...missing.map(name => `请补充${name}`)],
    warnings = [...template.warnings]
  for (const key of ['leaveType', 'start', 'end', 'replacementId', 'reason'])
    if (!template.fields.some(f => f.key === key))
      blockers.push(
        `模板必要条件缺少${Object.keys(FIELDS).find(n => FIELDS[n] === key)}`
      )
  if (!template.steps.length) blockers.push('审批步骤待配置')
  if (fields.leaveType && !template.types.includes(fields.leaveType))
    blockers.push('请假类型不在当前必要条件中')
  if (
    (template.typeRequirements[fields.leaveType] || []).some(text =>
      /附件.*(?:需要|必须)/.test(text)
    ) &&
    !(fields.attachmentIds || []).length
  )
    blockers.push('该假种的必要条件要求上传证明附件')
  let minutes = null
  if (fields.start && fields.end) {
    try {
      minutes = workingMinutes(fields.start, fields.end, template.calendar)
      if (!minutes) blockers.push('所选时间不包含工作时段')
    } catch (e) {
      blockers.push(e.message)
    }
  }
  if (!template.calendar.holidayCalendarConfigured)
    warnings.push('节假日/补班日历尚未完整登记，时长须人工核验')
  if (
    fields.start &&
    (() => {
      try {
        return dateValue(fields.start) - now < 86400000
      } catch (_) {
        return false
      }
    })()
  )
    warnings.push('未提前1天：需按脑图制度核验是否紧急及例外依据')
  const allCriteria = template.steps.flatMap(s => s.criteria)
  for (const c of allCriteria) {
    const min = c.text.match(
      /(事假|调休).*?(?:最小|单次[≥>=]+)\s*(\d+(?:\.\d+)?)\s*小时/
    )
    if (
      min &&
      minutes != null &&
      fields.leaveType.startsWith(min[1]) &&
      minutes < Number(min[2]) * 60
    )
      blockers.push(`${c.text}（本次${minutes / 60}小时）`)
  }
  if (['年假', '调休假', '调休'].includes(fields.leaveType))
    warnings.push(
      '余额需要可信记录或SSC人工核验，不能采用申请人自填余额作为通过依据'
    )
  const material = template.fields.find(f => f.key === 'leaveType')
  if (material && !Array.isArray(fields.attachmentIds))
    fields = { ...fields, attachmentIds: [] }
  if (fields.leaveType === '病假')
    warnings.push(
      '病假证明可按制度在当月补交；缺证、转换假种及3天材料边界由SSC核验，不自动扣薪或记违纪'
    )
  const dailyMinutes = template.calendar.periods.reduce(
    (sum, [a, b]) => sum + b - a,
    0
  )
  return {
    minutes,
    hours: minutes == null ? null : minutes / 60,
    days: minutes == null || !dailyMinutes ? null : minutes / dailyMinutes,
    missing,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    stages: template.steps.map(s => ({
      role: s.role,
      uid: s.uid,
      criteria: s.criteria.map(c => ({
        ...c,
        result: 'needs_review',
        basis: '请结合本次申请与制度原文人工核验；AI分析仅供参考'
      }))
    }))
  }
}
function projectionId(id) {
  const h = digest(['leave-projection', id])
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(
    17,
    20
  )}-${h.slice(20, 32)}`
}
const statusText = s =>
  ({
    draft: '待填写',
    pending: '审批中',
    returned: '退回修改',
    approved: '已通过',
    rejected: '未通过',
    withdrawn: '已撤回'
  }[s] || s)
module.exports = {
  plain,
  label,
  digest,
  FIELDS,
  failure,
  compileTemplate,
  dateValue,
  workingMinutes,
  extractFields,
  evaluate,
  projectionId,
  statusText
}
