const assert = require('node:assert/strict')
const workflow = require('../simple-mind-map/bin/leaveWorkflow/workflowCore')
const { extractFields } = require('../simple-mind-map/src/utils/leaveNodeFields')
const nodes = []
const add = (uid, parent_uid, text) => nodes.push({ uid, parent_uid, position: String(nodes.length).padStart(4, '0'), data: { text } })
add('flow', null, '<p>转正申请表</p>')
add('requirements', 'flow', '<p>提交要求</p>')
add('employee', 'requirements', '<p>员工</p>')
add('start', 'requirements', '试用期开始日')
add('date-type', 'start', '类型：日期')
add('score', 'requirements', '转正评分表')
add('file-type', 'score', '类型：附件')
add('automatic', 'flow', '<p>发起后全部流程默认同意</p>')
add('cc', 'flow', '<p>抄送人事组、IT</p>')
add('cc-note', 'cc', '抄送不审批')
add('config', 'flow', '审批配置')
add('cc-config', 'config', '抄送')
add('hr', 'cc-config', '人事组')
add('hr-id', 'hr', '账号：hr-user')
add('it', 'cc-config', 'IT')
add('it-id', 'it', '账号：it-user')
const template = workflow.compile(nodes, 'flow')
assert.deepEqual(template.fields.map(f => f.label), ['员工', '试用期开始日', '转正评分表'])
assert.equal(template.autoApprove, true)
assert.equal(template.autoApproveRule.uid, 'automatic')
assert.equal(template.steps.length, 0)
assert.deepEqual(template.configurationErrors, [])
assert.deepEqual(template.ccBindings.map(c => c.role), ['人事组', 'IT'])
assert.deepEqual(template.cc, ['hr-user', 'it-user'])
const empty = workflow.evaluate(template, {})
assert.deepEqual(empty.missing, ['员工', '试用期开始日', '转正评分表'])
assert.equal(empty.blockers.length, 3)
const [employee, start, score] = template.fields
const application = [
  {uid:'a', data:{text:'本次申请'}},
  {uid:'g', parent_uid:'a', data:{text:'申请资料'}},
  {uid:'e', parent_uid:'g', data:{text:'员工'}},
  {uid:'v', parent_uid:'e', data:{text:'待填写'}},
  {uid:'s', parent_uid:'g', data:{text:'试用期开始日：2026-10-01'}},
  {uid:'f', parent_uid:'g', data:{text:'转正评分表',attachmentId:'file-1'}}
]
let values = extractFields(application, 'a', template.fields)
assert.deepEqual(workflow.evaluate(template, values).missing, ['员工'])
application.find(n=>n.uid==='v').data.text = '实际员工'
values = extractFields(application, 'a', template.fields)
assert.equal(values[employee.key], '实际员工')
assert.equal(values[start.key], '2026-10-01')
assert.deepEqual(values[score.key], ['file-1'])
assert.deepEqual(workflow.evaluate(template, values).blockers, [])
const withoutFields = workflow.compile(nodes.filter(n=>!['employee','start','date-type','score','file-type'].includes(n.uid)), 'flow')
assert.ok(withoutFields.configurationErrors.some(e=>e.includes('提交要求')))
const withoutAuto = workflow.compile(nodes.filter(n=>n.uid!=='automatic'), 'flow')
assert.equal(withoutAuto.autoApprove, false)
assert.ok(withoutAuto.configurationErrors.includes('审批流程待登记'))
assert.throws(()=>workflow.compile(nodes.filter(n=>n.uid!=='requirements'), 'flow'), e=>e.code==='SUBMISSION_REQUIREMENTS_REQUIRED')
console.log('PASS: node submission requirements, rich text, required fields, placeholders, dates, attachments, explicit auto approval and CC roles')
const original = structuredClone(nodes)
original.push(
  {uid:'person-wrapper',parent_uid:'employee',position:'A',data:{text:'具体人员'}},
  {uid:'person-value',parent_uid:'person-wrapper',position:'A',data:{text:'<p>测试员工</p>'}},
  {uid:'date-wrapper',parent_uid:'start',position:'B',data:{text:'具体日期'}},
  {uid:'date-value',parent_uid:'date-wrapper',position:'A',data:{text:'2026-10-28'}},
  {uid:'file-wrapper',parent_uid:'score',position:'B',data:{text:'评分表附件'}},
  {uid:'file-value',parent_uid:'file-wrapper',position:'A',data:{text:'分支主题',attachmentId:'source-file'}}
)
const originalTemplate = workflow.compile(original,'flow')
const directFields = originalTemplate.fields.map(f=>({...f,instanceUid:f.uid,sourceInput:true}))
const directValues = extractFields(original,'flow',directFields)
assert.equal(directValues[employee.key],'测试员工')
assert.equal(directValues[start.key],'2026-10-28')
assert.deepEqual(directValues[score.key],['source-file'])
assert.deepEqual(directValues.attachmentIds,['source-file'])
original.find(n=>n.uid==='person-value').data.text='另一位员工'
assert.equal(workflow.compile(original,'flow').fingerprint,originalTemplate.fingerprint,'material edits do not change published workflow rules')
original.find(n=>n.uid==='person-value').data.text='待填写'
assert.equal(extractFields(original,'flow',directFields)[employee.key],undefined)
console.log('PASS: original submission subtree, nested wrappers, source attachments and separate rule/material fingerprints')
