const assert = require('node:assert/strict')
const { test } = require('node:test')
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const { preTasks } = require('../bin/leaveWorkflow/hrSopCheck')
const root = '7df2ad7a-0978-43be-acb7-3d5e4ead6dd7'
const branchUid = '0d37e8b4-09c5-41af-991e-cc363c48e9e1'
const stepUid = 'c3112a9d-9f20-4c79-8f74-78ed4abcc441'
function database(count = 3, role = 'viewer') {
  return { async query(sql) {
    if (sql.includes('room_tombstones')) return { rows: [] }
    if (sql.includes('from rooms')) return { rows: [{ room_key: 'room-yk3tz4aj' }] }
    if (sql.includes('room_members')) return { rows: role ? [{ user_id: 'reader', role }] : [] }
    return { rows: [
      { uid: root, depth: 0, text: '人事流程' },
      { uid: branchUid, depth: 1, parent_uid: root, text: '调岗' },
      { uid: stepUid, depth: 2, parent_uid: branchUid, text: '部门负责人' },
      { uid: 'principle', depth: 3, parent_uid: stepUid, text: '审核原则' },
      { uid: 'todos', depth: 4, parent_uid: 'principle', text: '待办' },
      ...Array.from({ length: count }, (_, i) => ({ uid: `todo-${i}`, depth: 5, parent_uid: 'todos', text: `交接事项${i + 1}` })),
    ] }
  } }
}
test('only opted-in transfer requests receive one checklist containing three handover items', async () => {
  const req = { authUser: { id: 'reader' } }
  assert.deepEqual(await preTasks(database(), req, { branchUid, stepUid }), [])
  const tasks = await preTasks(database(), req, { branchUid, stepUid, transferHandover: true })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].recipient, '当前审批人')
  assert.equal(tasks[0].content, '1、交接事项1\n2、交接事项2\n3、交接事项3')
  await assert.rejects(preTasks(database(2), req, { branchUid, stepUid, transferHandover: true }), /三项/)
  await assert.rejects(preTasks(database(3, ''), req, { branchUid, stepUid, transferHandover: true }))
})
