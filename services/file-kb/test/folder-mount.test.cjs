const test = require('node:test')
const assert = require('node:assert/strict')
const { callTool, TOOLS } = require('../src/read')
const folderId = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'
test('folder contents use recursive, permission-filtered keyset pagination', async () => {
  const queries = []
  const db = {query: async (sql, params) => {
    queries.push({sql, params})
    if (sql.startsWith('select kb.effective_role')) return {rows: [{role:'viewer'}]}
    return {rows: [1, 2].map(n => ({id: folderId, name: 'file'+n, size: 1, updated_at: new Date('2026-11-02T00:00:00Z')}))}
  }}
  assert.ok(TOOLS.some(t => t.name === 'list_knowledge_folder_files'))
  const page = await callTool(db, {id:'reader'}, 'list_knowledge_folder_files', {folderId, limit: 1})
  assert.equal(page.items.length, 1)
  assert.ok(page.nextCursor)
  assert.match(queries.at(-1).sql, /with recursive/)
  assert.match(queries.at(-1).sql, /effective_role/)
  assert.match(queries.at(-1).sql, /deleted_at is null/)
  await callTool(db, {id:'reader'}, 'list_knowledge_folder_files', {folderId, cursor: page.nextCursor})
  assert.match(queries.at(-1).sql, /\(f.updated_at, f.id\) </)
})
test('revoked folder permission prevents reading descendants', async () => {
  const db = {query: async sql => { assert.match(sql, /select kb.effective_role/); return {rows: [{role:null}]} }}
  await assert.rejects(callTool(db, {id:'reader'}, 'list_knowledge_folder_files', {folderId}), e => e.code === 'missing')
})
