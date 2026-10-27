const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')

function load() {
  const file = path.join(__dirname, '../src/features/knowledge-base/services/kbBatchPermissions.js')
  assert.ok(fs.existsSync(file), 'batch permission service exists')
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
  const module = { exports: {} }
  new Function('module', 'exports', code)(module, module.exports)
  return module.exports
}

test('preflight checks each distinct file/folder and reports view-only resources', async () => {
  const { prepareBatchTargets } = load()
  const rows = await prepareBatchTargets({ getAcl: async (type, id) => {
    if (id === 'gone') throw new Error('资源不存在')
    return { capabilities: id === 'view' ? [] : ['grant', 'revoke'] }
  } }, [{ type: 'folder', id: 'one' }, { type: 'folder', id: 'one' }, { type: 'file', id: 'view' }, { type: 'file', id: 'gone' }])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.ready), [true, false, false])
  assert.match(rows[1].message, /管理权限/)
  assert.equal(rows[2].message, '资源不存在')
})

test('grants only manageable resources and reports partial failures and owner skips', async () => {
  const { applyBatchPermissions } = load()
  const calls = []
  const api = { putGrant: async (type, id, body) => {
    calls.push([type, id, body])
    if (id === 'broken') throw new Error('权限已变化')
  } }
  const rows = await applyBatchPermissions(api, [
    { type: 'file', id: 'ok', ready: true, acl: { ownerUserId: 'owner' } },
    { type: 'folder', id: 'broken', ready: true, acl: {} },
    { type: 'folder', id: 'no', ready: false, message: '无管理权限' }
  ], [{ id: 'owner', name: '所有者' }, { id: 'reader', name: '同事' }], { mode: 'grant', role: 'viewer' })
  assert.equal(rows.length, 6)
  assert.equal(rows.filter(r => r.status === 'success').length, 1)
  assert.equal(rows.filter(r => r.status === 'skipped').length, 1)
  assert.equal(rows.filter(r => r.status === 'failed').length, 4)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(c => c[2].role === 'viewer' && c[2].subjectType === 'user'))
})

test('removal touches direct grants only, never inherited grants or owners', async () => {
  const { applyBatchPermissions } = load()
  const removed = []
  const acl = { ownerUserId: 'owner', grants: [
    { subjectType: 'user', subjectId: 'direct', source: 'direct' },
    { subjectType: 'user', subjectId: 'inherited', source: 'inherited' }
  ] }
  const rows = await applyBatchPermissions({ deleteGrant: async (...args) => removed.push(args) }, [{ type: 'file', id: 'one', ready: true, acl }], ['owner', 'direct', 'inherited'].map(id => ({ id })), { mode: 'revoke' })
  assert.equal(removed.length, 1)
  assert.equal(removed[0][2].subjectId, 'direct')
  assert.deepEqual(rows.map(r => r.status), ['skipped', 'success', 'skipped'])
})

test('invalid modes, owner role and oversized batches fail before mutation', async () => {
  const { prepareBatchTargets, applyBatchPermissions } = load()
  await assert.rejects(prepareBatchTargets({}, Array.from({ length: 101 }, (_, id) => ({ type: 'file', id: String(id) }))), /100/)
  await assert.rejects(applyBatchPermissions({}, [], [{ id: 'u' }], { mode: 'grant', role: 'owner' }))
  await assert.rejects(applyBatchPermissions({}, [], [{ id: 'u' }], { mode: 'replace', role: 'viewer' }))
})

test('a department with more than 20 current members can be authorized', async () => {
  const { applyBatchPermissions } = load()
  let granted = 0
  const members = Array.from({ length: 25 }, (_, i) => ({ id: 'member-' + i }))
  const rows = await applyBatchPermissions({ putGrant: async () => { granted++ } }, [{ type: 'folder', id: 'dept', ready: true, acl: {} }], members, { mode: 'grant', role: 'viewer' })
  assert.equal(granted, 25)
  assert.equal(rows.filter(r => r.status === 'success').length, 25)
})
