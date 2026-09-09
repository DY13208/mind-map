/**
 * sopNotify 识别 / 阻塞判断 / 代办人解析冒烟
 * node scripts/smoke-sop-notify.js
 */
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(
  path.join(__dirname, '../web/src/utils/sopNotify.js'),
  'utf8'
)
const titleSrc = fs.readFileSync(
  path.join(__dirname, '../web/src/utils/wecomTodoTitle.js'),
  'utf8'
)
const titleApi = new Function(
  `${titleSrc.replace(/export /g, '')}\nreturn { normalizeWecomTodoTitle, prepareWecomTodoDraft };`
)()
// 去掉 import，只测纯函数
const body = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*/gm, '')
  .replace(/export /g, '')

const api = new Function(
  'normalizeWecomTodoTitle',
  `${body}
  return {
    isNotifyTitle,
    shouldBlockNotify,
    parseAssigneeFromNotifyTitle,
    extractNotifyNodesFromOutline,
    extractWecomTodoNotifyNodesFromOutline,
    parseAssigneesFromExtraNote,
    resolveNotifyAssignee,
    isRoleAssignee,
    buildWecomTodoTitle,
    isWecomTodoOrientedSop
  };`
)(titleApi.normalizeWecomTodoTitle)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed')
}

assert(api.isNotifyTitle('AI发起通知：排产确认'), 'AI发起通知')
assert(api.isNotifyTitle('知会：本周目标'), '知会')
assert(api.isNotifyTitle('AI: 通知对应的HRBP'), 'AI: 通知')
assert(api.isNotifyTitle('AI:通知对应的HRBP'), 'AI:通知无空格')
assert(api.isNotifyTitle('提醒：行政核对入库'), '提醒')
assert(api.isNotifyTitle('请提醒HRBP跟进'), '请提醒')
assert(api.isNotifyTitle('催办：供应商回传合同'), '催办')
assert(api.isNotifyTitle('AI:总经理审批、抄送副总、人事'), '抄送')
assert(!api.isNotifyTitle('D：销售目标'), '普通 SOP 不是通知')
assert(
  !api.isNotifyTitle('如果没有，AI查询对应其他公司类似岗位并结合招聘需求生成JD'),
  '长叙述不应当通知'
)

assert(api.shouldBlockNotify('AI发起通知：请确认排产'), '确认→阻塞')
assert(api.shouldBlockNotify('发起通知：等待审批'), '等待→阻塞')
assert(!api.shouldBlockNotify('知会：本周进度'), '知会→不阻塞')
assert(!api.shouldBlockNotify('提醒：仅提醒结果'), '仅提醒→不阻塞')
assert(!api.shouldBlockNotify('AI发起通知：仅通知结果'), '仅通知→不阻塞')

assert(
  api.parseAssigneeFromNotifyTitle('提醒：行政准备工位') === '',
  '提醒：任务内容不整句当接收人'
)
assert(
  api.parseAssigneeFromNotifyTitle('提醒行政核对') === '行政',
  '提醒行政'
)
assert(
  api.parseAssigneeFromNotifyTitle('AI:通知对应的HRBP') === 'HRBP',
  '代办人 HRBP'
)
assert(
  api.parseAssigneeFromNotifyTitle('提醒行政、人事').includes('行政'),
  '代办人 行政'
)
assert(
  api
    .parseAssigneeFromNotifyTitle('AI:发offer给:行政、人事、IT')
    .includes('行政'),
  '给: 列表'
)

const outline = [
  '- D：刘欢：招聘',
  '  - 需求方:提交招聘需求',
  '  - AI:通知对应的HRBP',
  '  - AI:发布boss直聘JD',
  '  - 提醒：行政准备工位',
  '    - 代办人：行政',
  '  - AI:总经理审批、抄送副总、人事'
].join('\n')

const nodes = api.extractNotifyNodesFromOutline(outline)
assert(nodes.length >= 3, `应抽出通知/提醒节点，got ${nodes.length}`)
const hrbp = nodes.find(n => /HRBP/.test(n.text))
assert(hrbp && hrbp.assignee === 'HRBP', 'HRBP 代办人')
const remind = nodes.find(n => /提醒/.test(n.text))
assert(remind && /行政/.test(remind.assignee), '提醒代办人')

assert(
  api.parseAssigneesFromExtraNote('黄炜龙').join() === '黄炜龙',
  '纯人名备注'
)
assert(
  api.parseAssigneesFromExtraNote('其它说明：给黄炜龙发个代办').join() ===
    '黄炜龙',
  '提交资料其它说明'
)
assert(
  api.parseAssigneesFromExtraNote('代办人：黄炜龙').join() === '黄炜龙',
  '备注解析 代办人'
)
assert(api.isRoleAssignee('HRBP'), 'HRBP 是角色')
assert(
  api.resolveNotifyAssignee('HRBP', '给黄炜龙发个代办') === '黄炜龙',
  '运行前备注覆盖角色'
)
assert(
  api.resolveNotifyAssignee('HRBP', '') === 'HRBP',
  '无备注时保留角色'
)
assert(
  api.parseAssigneesFromExtraNote('给胡晓龙建一个测试待办').join() ===
    '胡晓龙',
  '创建式指令解析接收人'
)

assert(
  titleApi.normalizeWecomTodoTitle('给胡晓龙创建一个测试待办') === '测试待办',
  '创建式派发指令只保留任务标题'
)
assert(
  titleApi.normalizeWecomTodoTitle('给胡晓龙建一个测试待办') === '测试待办',
  '口语建一个派发指令只保留任务标题'
)
assert(
  titleApi.normalizeWecomTodoTitle(
    '给胡炫创建待办，提醒他测试一下（负责人）'
  ) === '测试',
  '后置口语事项应去掉接收人、动作、语气词和负责人标记'
)
assert(
  titleApi.normalizeWecomTodoTitle('麻烦给胡炫建个测试待办') === '测试待办',
  '自然口语前缀不进入标题'
)
assert(
  titleApi.normalizeWecomTodoTitle('给胡炫创建待办，内容是核对报价单') ===
    '核对报价单',
  '待办后的内容说明可作为标题'
)
assert(
  titleApi.normalizeWecomTodoTitle('提醒胡炫处理测试待办') === '处理测试待办',
  '提醒式指令去掉接收人但保留业务动作'
)
assert(
  titleApi.normalizeWecomTodoTitle('请提醒胡炫确认报价') === '确认报价',
  '确认等业务动词不能被过度清洗'
)
assert(
  titleApi.normalizeWecomTodoTitle('安排线下复盘') === '安排线下复盘',
  '普通事项中的线下不能被当成语气词截断'
)
assert(
  titleApi.normalizeWecomTodoTitle('标题：给客户创建待办流程') ===
    '给客户创建待办流程',
  '显式标题应尊重用户原文'
)
assert(
  !titleApi.prepareWecomTodoDraft({
    title: '需要给胡炫建个任务，测试一下'
  }).ok,
  '命令式文本解析失败时应拒绝创建，不能原样发送'
)
assert(
  !titleApi.prepareWecomTodoDraft({ title: '帮我给胡炫弄个事情' }).ok,
  '模糊口语没有具体事项时应拒绝创建'
)
assert(
  titleApi.normalizeWecomTodoTitle('给胡炫创建一个核对报价单的待办') ===
    '核对报价单待办',
  '事项与待办之间的结构助词不进入标题'
)
assert(
  titleApi.normalizeWecomTodoTitle('标题：测试待办；请立即发送') === '测试待办',
  '显式标题不带后续说明'
)
assert(
  titleApi.normalizeWecomTodoTitle('处理：采购报价') === '采购报价',
  '通用入口去掉处理前缀'
)
assert(
  !titleApi.prepareWecomTodoDraft({ title: '给胡晓龙创建一个待办' }).ok,
  '纯派发指令必须阻止创建，而不是降级成泛标题'
)
assert(
  titleApi.prepareWecomTodoDraft({
    title: '标题：核对报价单',
    description: '给胡晓龙创建待办'
  }).title === '核对报价单',
  '描述中的派发指令不得污染标题'
)
assert(
  api.buildWecomTodoTitle(
    { text: '给胡晓龙建一个测试待办' },
    { title: '给胡晓龙建一个测试待办' },
    '胡晓龙'
  ) === '测试待办',
  'SOP 派发标题不含接收人和指令外壳'
)
assert(
  api.isWecomTodoOrientedSop({ title: '给胡晓龙建一个测试待办' }),
  '创建式 SOP 应走专用企微待办路径'
)
const creationNodes = api.extractWecomTodoNotifyNodesFromOutline(
  '- 给胡晓龙建一个测试待办',
  { title: '给胡晓龙建一个测试待办' }
)
assert(
  creationNodes.length === 1 &&
    creationNodes[0].assignee === '胡晓龙' &&
    creationNodes[0].todoTitle === '测试待办' &&
    creationNodes[0].text === '测试待办',
  '创建式大纲应在解析阶段生成结构化标题，而不是保留原始指令'
)
const naturalNodes = api.extractWecomTodoNotifyNodesFromOutline(
  '- 给胡炫创建待办，提醒他测试一下（负责人）',
  { title: '给胡炫创建待办，提醒他测试一下（负责人）' }
)
assert(
  naturalNodes.length === 1 &&
    naturalNodes[0].assignee === '胡炫' &&
    naturalNodes[0].todoTitle === '测试' &&
    naturalNodes[0].text === '测试' &&
    naturalNodes[0].originalText.includes('给胡炫创建待办'),
  '自然语言节点必须结构化为接收人和事项，原句只能保留在审计说明'
)

console.log('sopNotify smoke OK', {
  count: nodes.length,
  assignees: nodes.map(n => `${n.text.slice(0, 20)}→${n.assignee}`)
})
