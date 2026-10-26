'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { callTool, TOOLS } = require('../src/read')
const { createDirectLinks } = require('../src/directLinks')

const fileId = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'
function fixture() {
  const state = { role: 'viewer', inScope: true, deleted: false, links: [], tokenValid: true }
  const db = { async query(sql, p) {
    if (sql.includes('kb.effective_role')) return { rows: [{ role: state.role }] }
    if (sql.includes('kb.folder_in_scope')) return { rows: [{ ok: state.inScope }] }
    if (sql.startsWith('select folder_id')) return { rows: [{ folder_id: fileId }] }
    if (sql.startsWith('select * from kb.files')) return { rows: state.deleted ? [] : [{ id: fileId, name: '执照.pdf', mime: 'application/pdf', size: 42 }] }
    if (sql.includes('insert into kb.direct_links')) {
      const row = { id: 'link-1', file_id: p[0], created_by: p[1], token_hash: p[2], expires_at: p[3], scope_folder_ids: p[4], source_token_hash: p[5], created_at: new Date() }
      state.links.push(row)
      return { rows: [row] }
    }
    if (sql.includes('from kb.direct_links')) return { rows: state.links.filter(l => l.token_hash === p[0] && (!l.source_token_hash || state.tokenValid || !sql.includes('kb.mcp_tokens'))) }
    throw new Error(sql)
  } }
  return { state, db }
}
const options = { publicBaseUrl: 'https://files.example:8989' }
const tool = (db, user, args, opts = options) => callTool(db, user, 'get_knowledge_download_url', args, opts)

test('viewer receives an absolute original-file URL expiring in 15 minutes', async () => {
  const { db, state } = fixture()
  const before = Date.now()
  const result = await tool(db, { id: 'viewer' }, { fileId, expiresInDays: 0, userId: 'owner' })
  assert.equal(result.fileId, fileId)
  assert.equal(result.fileName, '执照.pdf')
  assert.equal(result.mime, 'application/pdf')
  assert.equal(result.size, 42)
  assert.match(result.downloadUrl, /^https:\/\/files.example:8989\/api\/kb\/public\/files\/[a-f0-9]{64}\//)
  assert.ok(new Date(result.expiresAt).getTime() >= before + 899000)
  assert.ok(new Date(result.expiresAt).getTime() <= Date.now() + 900000)
  assert.equal(state.links[0].created_by, 'viewer')
  assert.ok(TOOLS.some(t => t.name === 'get_knowledge_download_url'))
})

test('no URL is issued for inaccessible, deleted or out-of-scope files', async () => {
  const { db, state } = fixture()
  state.role = null
  await assert.rejects(tool(db, { id: 'viewer' }, { fileId }), { code: 'missing' })
  state.role = 'viewer'; state.deleted = true
  await assert.rejects(tool(db, { id: 'viewer' }, { fileId }), { code: 'missing' })
  state.deleted = false; state.inScope = false
  await assert.rejects(tool(db, { id: 'viewer', scopeFolderIds: [fileId] }, { fileId }), { code: 'missing' })
  assert.equal(state.links.length, 0)
})

test('download links retain token folder scope and stop working when the source token is revoked', async () => {
  const { db, state } = fixture()
  const user = { id: 'viewer', via: 'token', tokenHash: 'b'.repeat(64), tokenExpiresAt: new Date(Date.now() + 60000).toISOString(), scopeFolderIds: [fileId] }
  const result = await tool(db, user, { fileId })
  assert.deepEqual(state.links[0].scope_folder_ids, [fileId])
  assert.equal(state.links[0].source_token_hash, user.tokenHash)
  assert.ok(new Date(result.expiresAt).getTime() <= new Date(user.tokenExpiresAt).getTime())
  const token = new URL(result.downloadUrl).pathname.split('/')[5]
  assert.equal((await createDirectLinks(db).resolve(token)).fileId, fileId)
  state.tokenValid = false
  await assert.rejects(createDirectLinks(db).resolve(token), { code: 'missing' })
})

test('missing or invalid public origin fails without creating a broken URL', async () => {
  const { db, state } = fixture()
  for (const publicBaseUrl of ['', 'file:///tmp/file', 'https://user:password@files.example', 'https://files.example/path', 'https://files.example/?secret=1']) {
    await assert.rejects(tool(db, { id: 'viewer' }, { fileId }, { publicBaseUrl }), { code: 'download_url_unavailable' })
  }
  assert.equal(state.links.length, 0)
})
