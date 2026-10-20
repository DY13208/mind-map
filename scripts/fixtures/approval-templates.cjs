// Synthetic policies used only by isolated database/browser verification.
function template(kind = 'contract', prefix = kind) {
  const nodes = []
  let count = 0
  const add = (parent, text, uid = prefix + '-' + ++count) => {
    nodes.push({
      uid,
      parent_uid: parent,
      position: String(count).padStart(6, '0'),
      data: { text }
    })
    return uid
  }
  const root = add(
    null,
    kind === 'contract' ? '合同签约审批' : '渠道关停申请',
    prefix + '-template'
  )
  add(root, '流程标识：' + prefix)
  const aliases = add(root, '触发词')
  add(aliases, kind === 'contract' ? '签合同' : '关停渠道')
  add(aliases, kind === 'contract' ? '合同签约' : '渠道关停')
  const fields = add(root, '申请字段')
  const field = (name, type, options) => {
    const f = add(fields, name)
    add(f, '类型：' + type)
    if (options) {
      const group = add(f, '选项')
      options.forEach(v => add(group, v))
    }
    return f
  }
  if (kind === 'contract') {
    field('合作方〔必填〕', '文本')
    const amount = field('合同金额〔必填〕', '金额')
    add(amount, '最小值：0')
    field('品牌〔必填〕', '选项', ['测试品牌A', '测试品牌B'])
    field('生效日期〔必填〕', '日期')
    field('业务联系人〔必填〕', '成员')
    field('合同文件〔必填〕', '附件')
    field('申请说明〔选填〕', '文本')
  } else {
    field('渠道名称〔必填〕', '文本')
    field('申请措施〔必填〕', '选项', ['关停', '调整'])
    field('预计日期〔必填〕', '日期')
    field('库存及结款说明〔必填〕', '文本')
  }
  const flow = add(root, '审批流程')
  const roles = kind === 'contract' ? ['法务审核', '财务审核'] : ['渠道负责人']
  for (const role of roles) {
    const step = add(flow, role),
      checks = add(step, '审核要点')
    add(
      checks,
      kind === 'contract'
        ? '核对测试合同主体、金额与附件一致'
        : '核对渠道、库存交接与未结款安排'
    )
  }
  const config = add(root, '审批配置')
  roles.forEach((role, i) => {
    const person = add(config, role)
    add(person, '账号：' + (i ? 'ssc' : 'manager'))
  })
  const cc = add(root, '抄送')
  add(cc, '老板')
  const ccConfig = add(config, '抄送'),
    boss = add(ccConfig, '老板')
  add(boss, '账号：ceo')
  return { nodes, root }
}
module.exports = { template }
