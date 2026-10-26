const test = require('node:test')
const assert = require('node:assert/strict')
const { textMentionComments, extractFromNodes } = require('../bin/commentMentions')
const { syncRoom } = require('../bin/commentMentions')
const { listMentions, clearAccessCache } = require('../bin/commentMentions')
const m = { id: 'selected-1', userId: 'recipient', name: '张三', authorId: 'sender', authorName: '作者', time: 123456 }
test('saved node text produces one message-center entry with stable identity', () => {
  const data = { uid: 'n1', text: '<p>请 @张三 完成验收</p>', textMentions: [m, m] }
  const rows = extractFromNodes({ n1: { data } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mention_key, 'recipient')
  assert.equal(rows[0].author_id, 'sender')
  assert.equal(rows[0].created_ms, 123456)
  assert.equal(rows[0].comment_id, 'node-text:n1:selected-1')
  assert.equal(textMentionComments(data, 'n1')[0].source, 'node_text')
  assert.equal(extractFromNodes({ n1: { data: { ...data, text: '修改说明 @张三 完成验收' } } })[0].comment_id, rows[0].comment_id)
})
test('removed, incomplete and prefix-only references do not notify', () => {
  for (const text of ['已删除提及', '请 @张三丰 完成', '']) assert.deepEqual(textMentionComments({ text, textMentions: [m] }, 'n1'), [])
  assert.deepEqual(textMentionComments({ text: '@张三', textMentions: [{ name: '张三' }] }, 'n1'), [])
  assert.equal(textMentionComments({ text: '@张三，完成验收', textMentions: [m] }, 'n1').length, 1)
})
test('comment mentions and node text mentions remain independent', () => {
  const data = { uid: 'n1', text: '@张三 ', textMentions: [m], comments: [{ id: 'c1', content: '@张三 评论', userId: 'sender', userName: '作者', time: 123456, mentions: [{ userId: 'recipient', name: '张三' }] }] }
  const rows = extractFromNodes({ n1: { data } })
  assert.equal(rows.length, 2)
  assert.equal(new Set(rows.map(r => r.comment_id)).size, 2)
})
test('a saved node mention rebuilds the message index from committed text', async () => {
  const queries = []
  const db = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.includes('select version from comment_mention_cursors')) return { rows: [{ version: 1 }] }
    if (sql.includes('from room_operations')) return { rows: [{ version: 2, operation_type: 'node.update', payload: { uid: 'n1', patch: { textMentions: [m] } } }] }
    return { rows: [] }
  } }
  const result = await syncRoom(db, 'test-room', 2, async () => ({ row: { version: 2 }, obj: { n1: { data: { uid: 'n1', text: '@张三 完成任务', textMentions: [m] } } } }))
  assert.equal(result, 'rebuilt')
  const write = queries.find(q => q.sql.includes('insert into comment_mentions\n'))
  assert.ok(write)
  assert.deepEqual(write.params[2], ['recipient'])
  assert.deepEqual(write.params[4], ['n1'])
})
test('message center returns node-text reminders and respects room access', async () => {
  const data = { uid: 'n1', text: '@张三 完成任务', textMentions: [m] }
  const row = { ...extractFromNodes({ n1: { data } })[0], room_key: 'test-mention-room', created_at: new Date(m.time), unread: true }
  const db = { async query(sql) { return { rows: sql.includes('from comment_mentions m') ? [row] : [] } } }
  const req = { authUser: { id: 'recipient', name: '张三' } }
  const deps = { roomAcl: { assertRoomAccess: async () => ({ canView: true }) }, loadSnapshot: async () => ({ row: { title: '验证脑图' }, obj: { n1: { data } } }) }
  clearAccessCache()
  const result = await listMentions(db, req, {}, deps)
  assert.equal(result.list.length, 1)
  assert.equal(result.list[0].source, 'node_text')
  assert.equal(result.list[0].node_uid, 'n1')
  assert.equal(result.list[0].unread, true)
  clearAccessCache()
  deps.roomAcl.assertRoomAccess = async () => ({ canView: false })
  assert.equal((await listMentions(db, req, {}, deps)).list.length, 0)
})
