const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSupplementDraft, describe } = require('../bin/workflowDevelopment')

const node = (uid, parent_uid, text, note) => ({ uid, parent_uid, data: { text, note } })
const hiring = [
  node('root', null, '录用'),
  node('requirements', 'root', '提交要求'),
  ...['待入职人员', '待入职人员手机号', '录用部门', '岗位', '试用期薪资', '转正薪资', '试用期时长', '合同公司', '入职工作性质', '待入职人员简历', '年龄', '预计入职日']
    .map((field, index) => node('field-' + index, 'requirements', field)),
  node('manager', 'root', '总经理'),
  node('default', 'manager', '默认同意'),
  node('reject', 'manager', '以下情况拒绝'),
  node('age-rule', 'reject', '在提交要求中如果年龄为40岁则拒绝')
]

function draftFields(tree) {
  const draft = buildSupplementDraft(describe(tree, 'room', 'root', {}))
  return Object.fromEntries(draft.fields.map(entry => [entry.field, entry]))
}

test('derives hiring scope and source from the approval rule even when the field is after the first eight', () => {
  const fields = draftFields(hiring)
  assert.match(fields.适用范围.text, /录用.*总经理/)
  assert.equal(fields.适用范围.review, false)
  assert.equal(fields.数据来源.text, '读取申请中提交的「年龄」。')
  assert.equal(fields.数据来源.review, false)
})

test('leaves the missing-data action blank when the approval rule does not specify one', () => {
  assert.deepEqual(draftFields(hiring).缺数据处理, {
    field: '缺数据处理', text: '', review: true
  })
})

test('uses the stated missing-data action from the relevant rule', () => {
  const fields = draftFields(hiring.map(item => item.uid === 'age-rule'
    ? node('age-rule', 'reject', item.data.text, '年龄未填写时，退回申请人补填。')
    : item))
  assert.equal(fields.缺数据处理.text, '年龄未填写时，退回申请人补填。')
  assert.equal(fields.缺数据处理.review, false)
})

test('uses the longest named field when a shorter field is part of its name', () => {
  const fields = draftFields(hiring.map(item => item.uid === 'age-rule'
    ? node('age-rule', 'reject', '待入职人员手机号与登记号码不一致时拒绝')
    : item))
  assert.equal(fields.数据来源.text, '读取申请中提交的「待入职人员手机号」。')
})

test('leaves data source blank when the rule does not name a submitted field', () => {
  const fields = draftFields(hiring.map(item => item.uid === 'age-rule'
    ? node('age-rule', 'reject', '背景调查不通过时拒绝')
    : item))
  assert.deepEqual(fields.数据来源, { field: '数据来源', text: '', review: true })
})

test('recognizes missing data phrased before the field name', () => {
  const fields = draftFields(hiring.map(item => item.uid === 'age-rule'
    ? node('age-rule', 'reject', item.data.text, '如果未提供年龄，暂停自动判断。')
    : item))
  assert.equal(fields.缺数据处理.text, '如果未提供年龄，暂停自动判断。')
})
