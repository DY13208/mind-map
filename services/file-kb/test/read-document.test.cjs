'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { callTool, TOOLS } = require('../src/read')
const fileId = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'
const user = { id: 'reader' }
function fixture(blocks) {
  const state = { role: 'viewer', version: 1, status: 'done', reads: 0, change: false }
  const db = { async query(sql, params) {
    if (sql.includes('effective_role')) return { rows: [{ role: state.role }] }
    if (sql.includes('select * from kb.files')) return { rows: [{ id: fileId, name: '全文.txt', status: state.status, size: 100, current_run_id: 'run-1', parse_version: state.version }] }
    if (sql.includes('from kb.blocks')) {
      state.reads++
      if (state.change) state.version++
      return { rows: blocks.filter(b => b.seq >= params[2]).slice(0, 101) }
    }
    throw new Error(sql)
  } }
  return { state, db }
}
test('reads all pages including long blocks, emoji and data-only blocks', async () => {
  const blocks = Array.from({ length: 220 }, (_, seq) => ({ id: seq + 1, seq, text: seq === 0 ? '正文😀'.repeat(8000) : `末段${seq}\n` }))
  blocks.push({ id: 222, seq: 220, text: '', data: { table: '完整表格' } })
  const { db } = fixture(blocks)
  let cursor, text = '', pages = 0
  do {
    const page = await callTool(db, user, 'read_knowledge_document', { fileId, cursor, length: 137 })
    text += page.blocks.map(b => b.text).join('')
    cursor = page.next_cursor
    assert.equal(page.has_more, !!cursor)
    assert.equal(page.complete, !cursor)
    assert.ok(++pages < 500)
  } while (cursor)
  assert.equal(text, blocks.map(b => b.text || JSON.stringify(b.data)).join(''))
  assert.ok(TOOLS.some(t => t.name === 'read_knowledge_document'))
})
test('checks permissions, parsing and cursor parse version on every page', async () => {
  const { db, state } = fixture([{ id: 1, seq: 0, text: 'abcdef' }])
  const page = await callTool(db, user, 'read_knowledge_document', { fileId, length: 2 })
  state.role = null
  await assert.rejects(callTool(db, user, 'read_knowledge_document', { fileId, cursor: page.next_cursor }), { code: 'missing' })
  state.role = 'viewer'; state.version++
  await assert.rejects(callTool(db, user, 'read_knowledge_document', { fileId, cursor: page.next_cursor }), { code: 'parse_changed' })
  state.change = true
  await assert.rejects(callTool(db, user, 'read_knowledge_document', { fileId }), { code: 'parse_changed' })
  state.change = false; state.status = 'processing'
  const notReady = await callTool(db, user, 'read_knowledge_document', { fileId })
  assert.equal(notReady.complete, false)
  assert.deepEqual(notReady.blocks, [])
  assert.equal(state.reads, 2)
})
test('rejects invalid and cross-file cursors', async () => {
  const { db } = fixture([])
  await assert.rejects(callTool(db, user, 'read_knowledge_document', { fileId, cursor: 'invalid' }), { code: 'bad_cursor' })
  const cursor = Buffer.from(JSON.stringify({ fileId: 'other', seq: 0, offset: 0 })).toString('base64url')
  await assert.rejects(callTool(db, user, 'read_knowledge_document', { fileId, cursor }), { code: 'bad_cursor' })
})
