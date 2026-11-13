const test = require('node:test')
const assert = require('node:assert/strict')
const attachments = require('../bin/leaveWorkflow/attachments')
const workflow = require('../bin/leaveWorkflow/workflowCore')
const { cleanFields } = require('../bin/leaveWorkflow/service')
const ID = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'a0000000-0000-4000-8000-000000000002'
const who = { user_id: 'applicant', corp_id: 'corp' }
const req = { authUser: { id: 'applicant', mcp: true } }
function row() {
  return { id: ID, corp_id: 'corp', requester_id: 'applicant', input_mode: 'agent',
    room_key: 'shared-template-room', status: 'draft', fields: { resume: [], rating: [], attachmentIds: [] },
    template: { agentInput: true, kind: 'generic', fields: [
      { key: 'resume', label: '待入职人员简历', type: 'attachment', required: true },
      { key: 'rating', label: '待入职人员评分', type: 'attachment', required: true }
    ], configurationErrors: [], steps: [], cc: [] }
  }
}
const error = code => e => e.code === code

test('only the requester personal Agent identity can upload editable Agent requests', () => {
  assert.doesNotThrow(() => attachments.assertUpload(row(), who, req))
  assert.doesNotThrow(() => attachments.assertUpload({ ...row(), status: 'returned' }, who, req))
  for (const status of ['pending', 'approved', 'rejected', 'withdrawn'])
    assert.throws(() => attachments.assertUpload({ ...row(), status }, who, req), error('LOCKED'))
  assert.throws(() => attachments.assertUpload(row(), { ...who, user_id: 'reviewer' }, req), error('REQUESTER_ONLY'))
  assert.throws(() => attachments.assertUpload(row(), { ...who, corp_id: 'other' }, req), error('REQUESTER_ONLY'))
  assert.throws(() => attachments.assertUpload(row(), who, { authUser: { id: 'applicant' } }), error('AGENT_EXECUTION_REQUIRED'))
  assert.throws(() => attachments.assertUpload({ ...row(), input_mode: 'node' }, who, req), error('AGENT_INPUT_REQUIRED'))
})

test('uploads are isolated per request and fill the requested material field without a node', async () => {
  const application = row()
  const db = { query: async () => { throw new Error('unexpected query') } }
  const stored = new Map()
  const store = { storeEnabled: true, async ingestUpload(dbArg, roomKey, body, actor) {
    assert.equal(dbArg, db)
    assert.equal(roomKey, `approval-request:${ID}`)
    assert.equal(body.nodeUid, undefined)
    assert.equal(body.sourceKind, 'approval_request')
    assert.equal(actor.id, who.user_id)
    assert.equal(actor.waitExtract, true)
    assert.equal(actor.maxBytes, 20 * 1024 * 1024)
    const id = body.fileName === 'resume.pdf' ? 'resume-id' : 'rating-id'
    stored.set(id, { id, status: 'ready', source_kind: body.sourceKind, cos_key: 'private/file', content_hash: id, file_name: body.fileName })
    return { id, status: 'ready', extractedChars: 4 }
  } }
  const upload = await attachments.ingest(db, application, who, {
    fieldKey: '待入职人员简历', fileName: 'resume.pdf', contentBase64: 'YWJj',
    nodeUid: 'must-not-be-written', roomKey: 'must-not-be-used', sourceKind: 'attachment'
  }, store)
  application.fields = cleanFields(upload.fields, application.template)
  assert.deepEqual(application.fields.resume, ['resume-id'])
  assert.deepEqual(application.fields.rating, [])
  assert.ok(!workflow.evaluate(application.template, application.fields).blockers.includes('请补充待入职人员简历'))
  assert.ok(workflow.evaluate(application.template, application.fields).blockers.includes('请补充待入职人员评分'))
  const validatingDb = { async query(sql, args) {
    assert.equal(args[0], attachments.scope(application))
    return { rows: stored.has(args[1]) ? [stored.get(args[1])] : [] }
  } }
  const snapshot = await attachments.validate(validatingDb, application, application.fields)
  assert.equal(snapshot[0].storage, 'approval_request')
  assert.equal(attachments.storageScope(application, snapshot[0]), attachments.scope(application))
  const otherDb = { async query(sql, args) { return { rows: args[0] === attachments.scope(application) ? [stored.get('resume-id')] : [] } } }
  await assert.rejects(attachments.validate(otherDb, { ...application, id: OTHER }, application.fields), error('ATTACHMENT_NOT_BOUND'))
})

test('cross-application, node attachments, missing binary and unready extraction are rejected', async () => {
  const application = row()
  for (const meta of [null, { source_kind: 'attachment', cos_key: 'key' }, { source_kind: 'approval_request' }]) {
    const db = { query: async () => ({ rows: meta ? [meta] : [] }) }
    await assert.rejects(attachments.validate(db, application, { attachmentIds: ['id'] }), error('ATTACHMENT_NOT_BOUND'))
  }
  const db = { query: async () => ({ rows: [{ source_kind: 'approval_request', cos_key: 'key', status: 'processing' }] }) }
  await assert.rejects(attachments.validate(db, application, { attachmentIds: ['id'] }), error('ATTACHMENT_NOT_READY'))
  assert.equal(attachments.storageScope(application, {}), application.room_key, 'existing node-based approval downloads keep their storage')
})

test('invalid field, unavailable storage and too many attachments fail before storing bytes', async () => {
  const store = { storeEnabled: true, ingestUpload() { throw new Error('must not store') } }
  await assert.rejects(attachments.ingest({}, row(), who, { fieldKey: 'not-in-template' }, store), error('ATTACHMENT_FIELD_REQUIRED'))
  await assert.rejects(attachments.ingest({}, row(), who, { fieldKey: 'resume' }, { ...store, storeEnabled: false }), error('ATTACHMENT_STORAGE_UNAVAILABLE'))
  const full = { ...row(), fields: { attachmentIds: Array.from({ length: 10 }, (_, i) => String(i)) } }
  await assert.rejects(attachments.ingest({}, full, who, { fieldKey: 'resume' }, store), error('INVALID_ATTACHMENTS'))
})

test('approval upload rejects WeCom share pages and fake PDFs before storage', async t => {
  const store = require('../bin/nodeKnowledge/store')
  const db = { query() { throw new Error('reached storage') } }
  const scope = attachments.scope(row())
  const html = '<!doctype html><html>分享页</html>'
  t.mock.method(require('node:dns').promises, 'lookup', async () => [{ address: '93.184.216.34' }])
  const fetch = t.mock.method(global, 'fetch', async () => new Response(html, {
    headers: { 'Content-Type': 'application/octet-stream' }
  }))
  const body = { fileName: 'resume.pdf', mimeType: 'application/pdf', sourceKind: 'approval_request' }
  const url = { ...body, sourceUrl: 'https://example.test/resume.pdf' }
  await assert.rejects(attachments.ingest(db, row(), who, {
    ...body, fieldKey: 'resume', sourceUrl: 'https://drive.weixin.qq.com/s?k=test'
  }, { ...store, storeEnabled: true }), error('WECOM_DISK_LOCAL_DOWNLOAD_REQUIRED'))
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(store.ingestUpload(db, scope, url), error('ATTACHMENT_URL_IS_WEBPAGE'))
  for (const bytes of [html, '%PDF-1.7\n']) {
    await assert.rejects(store.ingestUpload(db, scope, {
      ...body, contentBase64: Buffer.from(bytes).toString('base64')
    }), error('INVALID_APPROVAL_PDF'))
  }
  fetch.mock.mockImplementation(async () => new Response('%PDF-1.7\n%%EOF\n', {
    headers: { 'Content-Type': 'application/pdf' }
  }))
  await assert.rejects(store.ingestUpload(db, scope, url), /reached storage/)
})

test('only successfully extracted uploads can populate an approval attachment field', async () => {
  const application = row()
  for (const [status, extractedChars] of [['processing', 0], ['failed', 0], ['ready', 0]]) {
    const store = { storeEnabled: true, async ingestUpload() {
      return { id: 'unreadable', status, extractedChars }
    } }
    await assert.rejects(attachments.ingest({}, application, who, {
      fieldKey: 'resume', fileName: 'resume.pdf'
    }, store), error('ATTACHMENT_NOT_READY'))
    assert.deepEqual(application.fields.resume, [])
    assert.deepEqual(application.fields.attachmentIds, [])
  }
})

test('approval namespaces cannot be used as normal room keys and uploads enforce 20MiB before object storage', async () => {
  const { safeRoomKey } = require('../bin/storage')
  assert.throws(() => safeRoomKey(attachments.scope(row())))
  const store = require('../bin/nodeKnowledge/store')
  await assert.rejects(store.ingestUpload({}, attachments.scope(row()), {
    fileName: 'large.txt', contentBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')
  }, { maxBytes: 20 * 1024 * 1024 }), e => e.statusCode === 413)
})
