// Catalog templates have explicit markers. A directly selected node may instead
// declare its form with 提交要求; it is never discovered by fuzzy matching.
const leave = require('./core')
const { plain, label } = leave
const TYPE = {
  文本: 'text',
  多行文本: 'text',
  日期: 'date',
  时间: 'datetime',
  日期时间: 'datetime',
  数值: 'number',
  金额: 'number',
  成员: 'member',
  人员: 'member',
  附件: 'attachment',
  选项: 'enum'
}
const marker = text => plain(text).match(/^流程标识\s*[:：]\s*([^\n]{1,80})$/)
function compile(nodes, rootUid, kind = 'generic') {
  if (kind === 'leave')
    return { ...leave.compileTemplate(nodes, rootUid), kind: 'leave' }
  if (!nodes.length || nodes.length > 500)
    throw leave.failure('TEMPLATE_LIMIT', '审批模板不存在或超过500节点')
  const rows = nodes.map(n => ({ ...n, text: plain(n.data.text) }))
  const children = uid =>
    rows
      .filter(n => n.parent_uid === uid)
      .sort(
        (a, b) =>
          String(a.position).localeCompare(String(b.position)) ||
          a.uid.localeCompare(b.uid)
      )
  const descendants = uid => {
    const result = []
    const walk = (id, trail = new Set()) => {
      if (trail.has(id)) throw leave.failure('TEMPLATE_CYCLE', '模板存在循环')
      for (const n of children(id)) {
        result.push(n)
        walk(n.uid, new Set([...trail, id]))
      }
    }
    walk(uid)
    return result
  }
  const root = rows.find(n => n.uid === rootUid),
    top = children(rootUid)
  if (!root)
    throw leave.failure('TEMPLATE_NOT_FOUND', '审批模板节点不存在', 404)
  const markers = top.filter(n => marker(n.text))
  const requirementsNode = top.find(n => label(n.text) === '提交要求')
  if (!markers.length && !requirementsNode)
    throw leave.failure(
      'SUBMISSION_REQUIREMENTS_REQUIRED',
      '请先在该流程节点下填写“提交要求”，再发起审批'
    )
  if (markers.length > 1)
    throw leave.failure(
      'TEMPLATE_NOT_REGISTERED',
      '请在模板直属子节点登记唯一的“流程标识：名称或编号”'
    )
  const errors = []
  const fieldGroups = top.filter(n => /^(申请字段|必要条件|提交要求)$/.test(label(n.text)))
  const fieldsNode = fieldGroups[0]
  if (fieldGroups.length > 1) errors.push('提交要求或申请字段存在多个分支，请合并后再提交')
  const flowNode = top.find(n => label(n.text) === '审批流程')
  const ruleGroup = text => /^(默认同意|以下情况拒绝|须确认)$/.test(label(text))
  const implicitSteps = requirementsNode ? top.filter(n => children(n.uid).some(c => ruleGroup(c.text))) : []
  const ccNode = top.find(n => /^抄送/.test(label(n.text)))
  const ccRoles = ccNode
    ? label(ccNode.text) === '抄送'
      ? children(ccNode.uid).map(n => label(n.text))
      : label(ccNode.text).replace(/^抄送/, '').replace(/^[:：\s]+/, '').split(/[、,，]/).map(role => role.trim()).filter(Boolean)
    : []
  const config = top.find(n => /^(审批配置|审批人员配置|人员配置)$/.test(label(n.text)))
  const aliasNode = top.find(n => label(n.text) === '触发词')
  const autoRules = top.filter(n => label(n.text) === '发起后全部流程默认同意')
  // A form plus CC is a registration/notification flow. An empty explicit
  // approval flow, unfinished reviewer node, or manual-review instruction must
  // never silently become notification-only.
  const notificationOnly = !!fieldsNode && ccRoles.length > 0 && !flowNode && !implicitSteps.length && !autoRules.length &&
    (!config || children(config.uid).every(n=>label(n.text)==='抄送')) &&
    top.every(n => n === fieldsNode || n === ccNode || n === config || n === aliasNode || markers.includes(n))
  const autoApprove = autoRules.length === 1 || notificationOnly
  // 「AI预审」显式开启；「人工审批」显式关闭（AI 预审默认对全部流程生效）。
  const aiReviewNode = top.find(n => /^AI预审$/.test(label(n.text)))
  const aiReview = !!aiReviewNode
  const humanOnlyNode = top.find(n =>
    /^(人工审批|禁用AI预审|不使用AI预审)$/.test(label(n.text))
  )
  const humanOnly = !!humanOnlyNode
  if (flowNode && implicitSteps.length) errors.push('显式审批流程与直属审批角色同时存在，请明确唯一的执行顺序')
  if (autoApprove && implicitSteps.some(n => descendants(n.uid).some(c => /^(以下情况拒绝|须确认)$/.test(label(c.text)))))
    errors.push('全流程默认同意与角色的拒绝或须确认条件冲突，请先明确规则')
  if (autoRules.length > 1) errors.push('默认同意规则重复，请合并后重新发布')
  const title = label(root.text),
    flowId = markers.length ? marker(markers[0].text)[1].trim() : 'node:' + rootUid
  const materialUids = new Set()
  if (requirementsNode) {
    for (const field of children(requirementsNode.uid)) for (const child of children(field.uid)) {
      if (/^(?:类型|最小值|最大值)\s*[:：]/.test(child.text) || label(child.text) === '选项') continue
      materialUids.add(child.uid)
      descendants(child.uid).forEach(n => materialUids.add(n.uid))
    }
  }
  const fields = (fieldsNode ? children(fieldsNode.uid) : []).map(n => {
    const meta = children(n.uid),
      fieldLabel = label(n.text),
      typeNode = meta.find(c => /^类型\s*[:：]/.test(c.text))
    const typeLabel = typeNode
      ? typeNode.text.replace(/^类型\s*[:：]\s*/, '')
      : /附件$/.test(fieldLabel) || (requirementsNode && meta.some(c => /附件$/.test(label(c.text))))
      ? '附件'
      : '文本'
    const type = TYPE[typeLabel]
    if (!type)
      errors.push(
        `字段“${fieldLabel}”的类型“${typeLabel}”尚不支持，请明确登记可用类型`
      )
    const optionsNode = meta.find(c => label(c.text) === '选项')
    const options = optionsNode
      ? children(optionsNode.uid).map(c => c.text)
      : []
    if (type === 'enum' && !options.length)
      errors.push(`字段“${fieldLabel}”的选项待配置`)
    const bound = prefix => {
      const item = meta.find(
        c => c.text.startsWith(prefix + '：') || c.text.startsWith(prefix + ':')
      )
      if (!item) return null
      const num = Number(item.text.replace(/^[^:：]+[:：]\s*/, ''))
      if (!Number.isFinite(num)) errors.push(`字段“${fieldLabel}”${prefix}无效`)
      return num
    }
    return {
      uid: n.uid,
      key: 'f_' + leave.digest(n.uid).slice(0, 20),
      label: fieldLabel,
      type: type || 'text',
      required: !/[〔\[]选填[〕\]]/.test(n.text),
      options,
      min: bound('最小值'),
      max: bound('最大值'),
      requirements: descendants(n.uid)
        .filter(c => !materialUids.has(c.uid) && !children(c.uid).length && !/^类型[:：]/.test(c.text))
        .map(c => ({ uid: c.uid, text: c.text }))
    }
  })
  if (!fields.length) errors.push(requirementsNode ? '请先填写该流程的提交要求' : '申请字段待登记')
  if (fields.length > 50) errors.push('申请字段超过50项，请拆分模板')
  if (new Set(fields.map(f => f.label)).size !== fields.length)
    errors.push('申请字段名称重复，请先合并')
  if (!flowNode && !implicitSteps.length && !autoApprove) errors.push('审批流程待登记')
  if (
    [...top, ...(flowNode ? descendants(flowNode.uid) : []), ...implicitSteps.flatMap(n => descendants(n.uid))].some(n =>
      /^(条件分支|条件路由|并行|会签|或签|分支条件)/.test(label(n.text))
    )
  )
    errors.push(
      '本版支持顺序审批；条件分支、并行或会签需先配置受支持的执行规则，不能自动忽略'
    )
  const configuration = config ? descendants(config.uid) : []
  const account = n =>
    (n.text.match(/^(?:账号|user_id|成员ID)\s*[:：]\s*([^\s]+)$/i) || [])[1] ||
    ''
  const binding = (role, cc = false) => {
    const ccParent =
      config && children(config.uid).find(n => label(n.text) === '抄送')
    const parent = cc ? ccParent && ccParent.uid : config && config.uid
    const matches = configuration.filter(
      n => n.parent_uid === parent && label(n.text) === role
    )
    if (matches.length > 1) errors.push(`角色“${role}”重复配置`)
    const n = matches[0],
      below = n ? descendants(n.uid) : []
    return {
      bindingUid: n && n.uid,
      accounts: [
        ...new Set(
          below.map(account).filter(id => id && !/待配置|待补/.test(id))
        )
      ],
      bindingNodes: below.map(c => ({
        uid: c.uid,
        parent_uid: c.parent_uid,
        text: c.text,
        account: account(c)
      }))
    }
  }
  const steps = (!autoApprove ? (flowNode ? children(flowNode.uid) : implicitSteps) : []).map(n => {
    const role = label(n.text),
      criteriaNode = children(n.uid).find(c => label(c.text) === '审核要点')
    const below = descendants(criteriaNode ? criteriaNode.uid : n.uid)
    const inline = children(n.uid).map(account).filter(Boolean)
    if (implicitSteps.includes(n)) {
      for (const group of children(n.uid).filter(c => /^(以下情况拒绝|须确认)$/.test(label(c.text)))) {
        if (!descendants(group.uid).some(c => !children(c.uid).length && label(c.text) && !account(c)))
          errors.push(`${role}的“${label(group.text)}”条件待填写`)
      }
    }
    const criteria = below
      .filter(c => !children(c.uid).length && !account(c))
      .map(c => {
        const context = []
        let p = rows.find(x => x.uid === c.parent_uid)
        while (p && p.uid !== n.uid && context.length < 20) {
          if (label(p.text) !== '审核要点') context.unshift(p.text)
          p = rows.find(x => x.uid === p.parent_uid)
        }
        return { uid: c.uid, text: c.text, context }
      })
    if (
      !criteria.length ||
      criteria.some(c => /^待(?:补充|配置|确认)/.test(c.text))
    )
      errors.push(`${role}的审核要点待配置`)
    const configured = binding(role)
    return { uid: n.uid, role, ...configured, accounts: [...new Set([...configured.accounts, ...inline])], criteria,
      ...(implicitSteps.includes(n) ? {decisionMode:'human',requiresHumanConfirmation:true,defaultDecision:children(n.uid).some(c=>label(c.text)==='默认同意')?'approve':null} : {}) }
  })
  if (!steps.length && !autoApprove) errors.push('审批步骤待登记')
  if (steps.length > 20) errors.push('审批步骤超过20步')
  if (new Set(steps.map(s => s.role)).size !== steps.length)
    errors.push('审批步骤名称重复，请使用明确的角色名称')
  const ccBindings = ccRoles.map(role => ({ role, ...binding(role, true) }))
  const aliases = [
    ...new Set(
      [
        title,
        flowId,
        title.replace(/(?:审批|申请)$/, ''),
        ...(aliasNode ? children(aliasNode.uid).map(n => n.text) : [])
      ].filter(s => s.length >= 2 && s.length <= 80)
    )
  ]
  return {
    kind: 'generic',
    title,
    flowId,
    rootUid,
    markerUid: markers.length ? markers[0].uid : null,
    requirementsNodeUid: requirementsNode ? requirementsNode.uid : null,
    notificationOnly,
    autoApprove,
    autoApproveRule: notificationOnly ? {uid:ccNode.uid,text:'仅抄送，无需审批'} : autoApprove ? { uid: autoRules[0].uid, text: autoRules[0].text } : null,
    aiReview,
    aiReviewNodeUid: aiReviewNode ? aiReviewNode.uid : null,
    humanOnly,
    aliases,
    fields,
    steps,
    types: [],
    calendar: { periods: [], holidays: [], workdays: [] },
    ccBindings,
    ccRequired: !!ccNode,
    cc: [...new Set(ccBindings.flatMap(c => c.accounts))],
    ccMissing: ccBindings.filter(c => !c.accounts.length).map(c => c.role),
    configurationErrors: errors,
    warnings: implicitSteps.length ? ['直属角色的默认同意及拒绝／须确认条件将交由实际审核人逐项核验，不自动推断条件已满足'] : [],
    fingerprint: leave.digest(
      rows.filter(n => !materialUids.has(n.uid)).map(n => ({
        uid: n.uid,
        parent: n.parent_uid,
        position: n.position,
        text: n.text
      })).concat(requirementsNode ? [{ fieldSchema: fields.map(f => ({uid:f.uid,type:f.type,required:f.required,options:f.options,min:f.min,max:f.max})) }] : []).concat(notificationOnly ? [{workflowMode:'notification_only'}] : [])
    )
  }
}
function evaluate(tpl, fields) {
  if (tpl.kind !== 'generic') return leave.evaluate(tpl, fields)
  const blockers = [...(tpl.configurationErrors || [])],
    missing = []
  for (const f of tpl.fields) {
    const value = fields[f.key],
      empty =
        f.type === 'attachment'
          ? !(value || []).length
          : !String(value || '').trim()
    if (empty) {
      if (f.required) {
        missing.push(f.label)
        blockers.push(`请补充${f.label}`)
      }
      continue
    }
    if (f.type === 'number') {
      const number = Number(value)
      if (!/^-?\d+(?:\.\d+)?$/.test(String(value)) || !Number.isFinite(number))
        blockers.push(`${f.label}请填写明确数值`)
      else {
        if (f.min != null && number < f.min)
          blockers.push(`${f.label}不能小于${f.min}`)
        if (f.max != null && number > f.max)
          blockers.push(`${f.label}不能大于${f.max}`)
      }
    }
    if (f.type === 'date' || f.type === 'datetime')
      try {
        if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value))
          throw Error('日期须为YYYY-MM-DD')
        leave.dateValue(f.type === 'date' ? value + 'T00:00' : value)
      } catch (e) {
        blockers.push(`${f.label}：${e.message}`)
      }
    if (f.type === 'enum' && !f.options.includes(value))
      blockers.push(`${f.label}不在模板登记的选项中`)
  }
  return {
    missing,
    blockers: [...new Set(blockers)],
    warnings: [],
    minutes: null,
    hours: null,
    days: null,
    stages: tpl.steps.map(s => ({
      role: s.role,
      uid: s.uid,
      criteria: s.criteria.map(c => ({
        ...c,
        result: 'needs_review',
        basis: '根据模板原文人工核验，AI仅提供建议'
      }))
    }))
  }
}
module.exports = { compile, evaluate, marker }
