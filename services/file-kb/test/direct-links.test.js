'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createApi } = require('../src/api')
const { createHandler } = require('../src/server')
const { AuthError } = require('../src/auth')
const { request } = require('./helpers')

const fileId = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'
// Only the external database is substituted; HTTP, authentication routing,
// ACL checks, token generation and file streaming run through production code.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-direct-link-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'original'), 'original file bytes')
  const state = { role: 'viewer', deleted: false, links: [], user: 'reader' }
  const file = { id: fileId, name: '测试.pdf', ext: 'pdf', mime: 'application/pdf', storage_key: 'original', sha256: 'a'.repeat(64) }
  const pool = { async query(sql, p = []) {
    if (sql.includes('kb.effective_role')) return { rows: [{ role: state.deleted ? null : state.role }] }
    if (sql.startsWith('select * from kb.files')) return { rows: state.deleted ? [] : [file] }
    if (sql.includes('insert into kb.direct_links')) {
      const row = { id: crypto.randomUUID(), file_id: p[0], created_by: p[1], token_hash: p[2], expires_at: p[3], scope_folder_ids: p[4], created_at: new Date(), revoked_at: null }
      state.links.push(row)
      return { rows: [row] }
    }
    if (sql.includes('update kb.direct_links')) {
      const row = state.links.find(l => l.id === p[0] && l.file_id === p[1] && l.created_by === p[2])
      if (row) row.revoked_at = new Date()
      return { rows: row ? [row] : [] }
    }
    if (sql.includes('from kb.direct_links') && sql.includes('token_hash = $1')) {
      return { rows: state.links.filter(l => l.token_hash === p[0] && !l.revoked_at && (!l.expires_at || new Date(l.expires_at) > new Date())) }
    }
    if (sql.includes('from kb.direct_links')) {
      const rows = state.links.filter(l => l.file_id === p[0] && l.created_by === p[1])
      return { rows: /limit 100\b/.test(sql) ? rows.slice(0, 100) : rows }
    }
    throw new Error('Unexpected SQL: ' + sql)
  } }
  const api = createApi({ pool, storage: { resolveKey: key => path.join(dir, key) }, config: {}, queue: {} })
  const handler = createHandler({ config: { enabled: true }, api, authenticator: { async authenticate(req) {
    if (req.headers.cookie !== 'test-session') throw new AuthError(401, 'unauthorized')
    return { id: state.user }
  } } })
  const call = (suffix, method = 'GET', body, authenticated = true) => request(handler, {
    path: suffix.startsWith('/api/') ? suffix : `/api/kb/files/${fileId}/direct-links${suffix}`,
    method, headers: { ...(authenticated ? { cookie: 'test-session' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: '@self' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { state, call }
}

test('a viewer can create a direct link and read the original with no session', async t => {
  const { state, call } = fixture(t)
  const created = await call('', 'POST', { expiresInDays: 7 })
  assert.equal(created.status, 201)
  assert.match(created.body.url, /^\/api\/kb\/public\/files\/[a-f0-9]{64}\//)
  const token = created.body.url.split('/')[5]
  assert.equal(state.links[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'))
  assert.ok(!JSON.stringify(state.links).includes(token))
  assert.equal((await call(created.body.url, 'GET', undefined, false)).body, 'original file bytes')
  assert.equal((await call(created.body.url, 'HEAD', undefined, false)).status, 200)
  assert.equal((await call(`/api/kb/files/${fileId}/raw`, 'GET', undefined, false)).status, 401)
  assert.equal((await call('', 'POST', {}, false)).status, 401)
})

test('view permission is required; expiration values are validated', async t => {
  const { state, call } = fixture(t)
  state.role = null
  assert.equal((await call('', 'POST', {})).status, 404)
  state.role = 'viewer'
  for (const expiresInDays of [-1, '7', 0.5, 366]) {
    assert.equal((await call('', 'POST', { expiresInDays })).status, 400)
  }
  assert.equal(state.links.length, 0)
})

test('only the creator can list and revoke their links; revoked URLs stop working', async t => {
  const { state, call } = fixture(t)
  const created = await call('', 'POST', { expiresInDays: 0 })
  assert.equal(created.status, 201)
  assert.equal(created.body.expiresAt, null)
  state.user = 'other-viewer'
  assert.deepEqual((await call('')).body.items, [])
  assert.equal((await call('/' + created.body.id, 'DELETE')).status, 404)
  state.user = 'reader'
  const listed = await call('')
  assert.equal(listed.body.items.length, 1)
  assert.ok(!JSON.stringify(listed.body).includes(state.links[0].token_hash))
  assert.equal((await call('/' + created.body.id, 'DELETE')).status, 200)
  assert.equal((await call(created.body.url, 'GET', undefined, false)).status, 404)
})

test('expired links, deleted files and revoked viewer access cannot be used anonymously', async t => {
  const { state, call } = fixture(t)
  const created = await call('', 'POST', {})
  assert.equal(created.status, 201)
  state.links[0].expires_at = new Date(Date.now() - 1000)
  assert.equal((await call(created.body.url, 'GET', undefined, false)).status, 404)
  state.links[0].expires_at = null
  state.deleted = true
  assert.equal((await call(created.body.url, 'GET', undefined, false)).status, 404)
  state.deleted = false
  state.role = null
  assert.equal((await call(created.body.url, 'GET', undefined, false)).status, 404)
  assert.equal((await call('/api/kb/public/files/' + '0'.repeat(64) + '/file.pdf', 'GET', undefined, false)).status, 404)
  assert.equal((await call(created.body.url, 'POST', {}, false)).status, 401)
})

test('all generated links remain discoverable for revocation after more than 100 creations', async t => {
  const { state, call } = fixture(t)
  const first = await call('', 'POST', { expiresInDays: 0 })
  assert.equal(first.status, 201)
  for (let i = 0; i < 104; i++) state.links.unshift({ ...state.links[0], id: crypto.randomUUID(), token_hash: crypto.randomBytes(32).toString('hex') })
  const listed = await call('')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 105)
  assert.ok(listed.body.items.some(item => item.id === first.body.id))
  assert.equal((await call('/' + first.body.id, 'DELETE')).status, 200)
  assert.equal((await call(first.body.url, 'GET', undefined, false)).status, 404)
})
