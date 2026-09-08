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
// 去掉 import，只测纯函数
const body = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*/gm, '')
  .replace(/export /g, '')

const api = new Function(
  `${body}
  return {
    isNotifyTitle,
    shouldBlockNotify,
    parseAssigneeFromNotifyTitle,
    extractNotifyNodesFromOutline,
    parseAssigneesFromExtraNote,
    resolveNotifyAssignee,
    isRoleAssignee
  };`
)()

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

console.log('sopNotify smoke OK', {
  count: nodes.length,
  assignees: nodes.map(n => `${n.text.slice(0, 20)}→${n.assignee}`)
})
