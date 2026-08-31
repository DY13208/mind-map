const assert = require('assert')
const mindDoc = require('../bin/mindDoc')

const node = (uid, text, children = [], extra = {}) => ({
  isRoot: uid === 'root',
  data: { uid, text, ...extra },
  children
})

function fixture() {
  return {
    root: node('root', '良策工程', ['company']),
    company: node('company', '公司模型', ['sop', 'todos']),
    sop: node('sop', 'SOP', ['recruit', 'report', 'legal']),
    recruit: node('recruit', '目标：徐健：招聘分', ['recruit-c', 'recruit-p']),
    'recruit-c': node('recruit-c', 'C（3）', ['rc1', 'rc2', 'rc3']),
    rc1: node('rc1', '招聘需求已经确认'),
    rc2: node('rc2', '候选人面试通过'),
    rc3: node('rc3', '录用和入职已经完成'),
    'recruit-p': node('recruit-p', 'P（3）', ['rp1', 'rp2', 'rp3']),
    rp1: node('rp1', '确认岗位要求'),
    rp2: node('rp2', '筛选并安排面试'),
    rp3: node('rp3', '录用及入职'),
    report: node('report', '目标：徐健：报表分', ['report-c', 'report-p']),
    'report-c': node('report-c', '目标（1）', ['report-check']),
    'report-check': node('report-check', '经营报表数据准确'),
    'report-p': node('report-p', '计划（1）', ['report-plan']),
    'report-plan': node('report-plan', '汇总并复核经营数据'),
    legal: node('legal', '目标：马莹：公司法务分', ['legal-c', 'legal-p']),
    'legal-c': node('legal-c', 'C（1）', ['legal-check']),
    'legal-check': node('legal-check', '合同风险已经检查'),
    'legal-p': node('legal-p', 'P（1）', ['legal-plan']),
    'legal-plan': node('legal-plan', '审核合同条款'),
    todos: node('todos', '待办', ['pending', 'completed']),
    pending: node('pending', '待办（3）', [
      'task-recruit',
      'task-report',
      'task-legal'
    ]),
    'task-recruit': node('task-recruit', '帮徐健招聘一个助理', ['task-detail']),
    'task-detail': node('task-detail', '工作地点：杭州'),
    'task-report': node('task-report', '生成徐健本月经营报表'),
    'task-legal': node('task-legal', '请马莹审核合作合同'),
    completed: node('completed', '已完成（0）')
  }
}

function testListsOnlyDirectTodoTasks() {
  const result = mindDoc.listTodos(fixture())
  assert.deepStrictEqual(
    result.pending.map(item => item.uid),
    ['task-recruit', 'task-report', 'task-legal']
  )
  assert.strictEqual(result.pending[0].children[0].text, '工作地点：杭州')
}

function testMatchesDifferentBusinessSops() {
  const obj = fixture()
  const recruit = mindDoc.prepareTodo(obj, '帮徐健招聘一个助理')
  assert.strictEqual(recruit.match_status, 'matched')
  assert.strictEqual(recruit.matched_sop.uid, 'recruit')
  assert.deepStrictEqual(recruit.matched_sop.required_check_uids, [
    'rc1',
    'rc2',
    'rc3'
  ])

  const report = mindDoc.prepareTodo(obj, 'task-report')
  assert.strictEqual(report.match_status, 'matched')
  assert.strictEqual(report.matched_sop.uid, 'report')

  const legal = mindDoc.prepareTodo(obj, 'task-legal')
  assert.strictEqual(legal.match_status, 'matched')
  assert.strictEqual(legal.matched_sop.uid, 'legal')
}

function testCompletionRequiresEveryCheckAndMovesWholeSubtree() {
  const obj = fixture()
  const prepared = mindDoc.prepareTodo(obj, 'task-recruit')
  assert.throws(
    () =>
      mindDoc.completeTodo(obj, {
        task: 'task-recruit',
        sop_uid: prepared.matched_sop.uid,
        sop_version: prepared.matched_sop.version,
        check_results: [{ check_uid: 'rc1', passed: true }]
      }),
    /C检查未全部通过/
  )

  const completed = mindDoc.completeTodo(obj, {
    task: 'task-recruit',
    sop_uid: prepared.matched_sop.uid,
    sop_version: prepared.matched_sop.version,
    check_results: prepared.matched_sop.required_check_uids.map(checkUid => ({
      check_uid: checkUid,
      passed: true
    })),
    summary: '已完成招聘',
    completed_at: '2026-08-31T12:00:00.000Z'
  })
  assert.deepStrictEqual(completed.obj.pending.children, [
    'task-report',
    'task-legal'
  ])
  assert.deepStrictEqual(completed.obj.completed.children, ['task-recruit'])
  assert.strictEqual(completed.obj.pending.data.text, '待办（2）')
  assert.strictEqual(completed.obj.completed.data.text, '已完成（1）')
  assert(completed.obj['task-detail'], 'task descendants must be preserved')
  assert.strictEqual(
    completed.obj['task-recruit'].data.todoCompletion.summary,
    '已完成招聘'
  )

  const repeated = mindDoc.completeTodo(completed.obj, { task: 'task-recruit' })
  assert.strictEqual(repeated.already_completed, true)
  assert.deepStrictEqual(repeated.obj.completed.children, ['task-recruit'])
}

function testRejectsChangedSop() {
  const obj = fixture()
  const prepared = mindDoc.prepareTodo(obj, 'task-report')
  assert.throws(
    () =>
      mindDoc.completeTodo(obj, {
        task: 'task-report',
        sop_uid: 'report',
        sop_version: `${prepared.matched_sop.version}-old`,
        check_results: [{ check_uid: 'report-check', passed: true }]
      }),
    /SOP已发生变化/
  )
}

function testSopBoundaryAndDuplicateTitles() {
  const obj = fixture()
  assert.strictEqual(mindDoc.isWithinSop(obj, 'legal-check'), true)
  assert.strictEqual(mindDoc.isWithinSop(obj, 'task-legal'), false)

  obj.completed.children.push('completed-copy')
  obj['completed-copy'] = node('completed-copy', '请马莹审核合作合同')
  assert.throws(
    () => mindDoc.prepareTodo(obj, '请马莹审核合作合同'),
    /同名任务/
  )
  const byUid = mindDoc.prepareTodo(obj, 'task-legal')
  assert.strictEqual(byUid.location, '待办')
}

function testSopImprovementRequiresConfirmation() {
  const obj = fixture()
  const proposal = mindDoc.proposeSopImprovement(obj, {
    sop_uid: 'legal',
    section: 'C',
    action: 'add',
    content: '合同主体资质已经核验',
    reason: '执行合同审核任务时发现缺少主体检查'
  })
  assert(proposal.proposal_id)
  assert.throws(
    () => mindDoc.applySopImprovement(obj, proposal),
    /用户明确确认/
  )
  const applied = mindDoc.applySopImprovement(obj, {
    ...proposal,
    user_confirmed: true
  })
  assert.notStrictEqual(applied.sop_version, proposal.sop_version)
  assert(
    applied.obj['legal-c'].children.some(
      uid => applied.obj[uid].data.text === '合同主体资质已经核验'
    )
  )
}

testListsOnlyDirectTodoTasks()
testMatchesDifferentBusinessSops()
testCompletionRequiresEveryCheckAndMovesWholeSubtree()
testRejectsChangedSop()
testSopBoundaryAndDuplicateTitles()
testSopImprovementRequiresConfirmation()

console.log('todo workflow tests passed')
