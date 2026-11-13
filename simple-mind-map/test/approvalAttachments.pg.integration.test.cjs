const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { Pool } = require('pg')
const service = require('../bin/leaveWorkflow/service')
const acl = require('../bin/roomAcl')
const store = require('../bin/nodeKnowledge/store')
const privateAttachments = require('../bin/leaveWorkflow/attachments')
const workflowHttp = require('../bin/leaveWorkflow/http')

test('approval-only upload, ACL, replay, material snapshots and downloads in PostgreSQL', {
  skip: !process.env.APPROVAL_ATTACHMENT_TEST_DB_URL
}, async () => {
  const url = new URL(process.env.APPROVAL_ATTACHMENT_TEST_DB_URL)
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated local test database')
  const schema = 'approval_attachment_test_' + Date.now()
  const admin = new Pool({ connectionString: url.href })
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({ connectionString: url.href, options: '-c search_path=' + schema })
  const originals = { ingestUpload: store.ingestUpload, getContentById: store.getContentById, storeEnabled: store.storeEnabled }
  const binaries = new Map()
  const req = id => ({ forceAcl: true, authUser: { id, mcp: true } })
  let stores = 0
  try {
    await pool.query(`create table rooms(room_key text primary key,owner_id text,folder_id text,deleted_at timestamptz,updated_at timestamptz default now(),title text);
      create table room_tombstones(room_key text primary key);
      create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
      create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,departments jsonb default '[1]');
      create table room_nodes(room_key text,uid text,parent_uid text,position text,data jsonb,deleted_at timestamptz,primary key(room_key,uid));
      insert into rooms(room_key,owner_id,title) values('template-room','owner','测试模板');
      insert into wecom_users(user_id,wecom_userid,corp_id,name) values
      ('owner','owner','corp','模板管理员'),('applicant','applicant','corp','申请人'),
      ('reviewer','reviewer','corp','审核人'),('other','other','corp','其他申请人');`)
    await acl.initSchema(pool)
    await acl.ensureOwner(pool, 'template-room', 'owner')
    for (const id of ['applicant', 'reviewer', 'other']) await acl.setMember(pool, 'template-room', id, 'viewer', 'owner')
    await store.initSchema(pool)
    await service.initSchema(pool)
    for (const [uid, parent, text] of [
      ['root', null, '录用'], ['requirements', 'root', '提交要求'],
      ['resume', 'requirements', '待入职人员简历'], ['resume-type', 'resume', '类型：附件'],
      ['rating', 'requirements', '待入职人员评分'], ['rating-type', 'rating', '类型：附件'],
      ['automatic', 'root', '发起后全部流程默认同意']
    ]) await pool.query('insert into room_nodes values($1,$2,$3,$2,$4,null)', ['template-room', uid, parent, { text }])
    const source = { roomKey: 'template-room', nodeUid: 'root' }
    const tpl = await service.template(pool, req('applicant'), source)
    const pub = (await pool.query(`insert into leave_policy_publications(corp_id,source_room,source_uid,fingerprint,published_by,operation_id,agent_mode,content_fingerprint)
      values('corp',$1,$2,$3,'owner',$4,true,$5) returning id`, [source.roomKey, source.nodeUid, tpl.fingerprint, randomUUID(), tpl.contentFingerprint])).rows[0]
    const prepare = actor => service.prepare(pool, req(actor), {
      inputMode: 'agent', source, fields: {}, expectedDefinitionVersion: String(pub.id)
    })
    const initial = await prepare('applicant')
    const other = await prepare('other')
    const beforeNodes = (await pool.query('select * from room_nodes order by uid')).rows
    const fieldKey = initial.template.fields.find(f => f.label === '待入职人员简历').key
    const ratingKey = initial.template.fields.find(f => f.label === '待入职人员评分').key
    const authorized = await service.authorizeAttachmentUpload(pool, req('applicant'), initial.id, '待入职人员简历')
    assert.equal(authorized.fieldKey, fieldKey)
    assert.equal(authorized.storageScope, privateAttachments.scope(initial))
    await assert.rejects(service.authorizeAttachmentUpload(pool, req('other'), initial.id, fieldKey), e => e.code === 'NOT_FOUND')
    await assert.rejects(service.authorizeAttachmentUpload(pool, { authUser: { id: 'applicant', service: true } }, initial.id, fieldKey), e => e.code === 'PERSONAL_IDENTITY_REQUIRED')

    // Keep real SQL, ACLs, transactions and workflow logic; replace only external object storage/extraction.
    store.storeEnabled = true
    store.ingestUpload = async (db, scope, body, actor) => {
      stores++
      assert(scope.startsWith('approval-request:'))
      assert.equal(body.nodeUid, undefined)
      const buffer = Buffer.from(body.contentBase64, 'base64')
      const hash = createHash('sha256').update(buffer).digest('hex')
      let meta = (await db.query('select * from node_attachments where room_key=$1 and content_hash=$2', [scope, hash])).rows[0]
      if (!meta) {
        const id = randomUUID().replace(/-/g, '')
        const failed = body.fileName === 'unreadable.pdf'
        meta = (await db.query(`insert into node_attachments(id,room_key,node_uid,content_hash,file_name,mime_type,byte_size,cos_key,status,extracted_text,extracted_chars,source_kind,created_by)
          values($1,$2,'',$3,$4,'text/plain',$5,'test-object',$7,$8,$9,'approval_request',$6) returning *`,
        [id, scope, hash, body.fileName, buffer.length, actor.id,
          failed ? 'failed' : 'ready', failed ? '' : '测试材料', failed ? 0 : 4])).rows[0]
        binaries.set(id, buffer)
      }
      return store.rowToDto(meta)
    }
    store.getContentById = async (db, scope, id) => {
      const meta = (await db.query('select * from node_attachments where room_key=$1 and id=$2', [scope, id])).rows[0]
      return meta && { attachment: store.rowToDto(meta), buffer: binaries.get(id) }
    }
    const body = { expectedRevision: initial.revision, operationId: randomUUID(), fieldKey, fileName: 'resume.txt', contentBase64: Buffer.from('resume').toString('base64') }
    await assert.rejects(service.uploadAttachment(pool, req('applicant'), initial.id, {
      ...body, fileName: 'unreadable.pdf', operationId: randomUUID()
    }), e => e.code === 'ATTACHMENT_NOT_READY')
    const afterFailure = await service.get(pool, req('applicant'), initial.id)
    assert.equal(afterFailure.revision, initial.revision)
    assert.deepEqual(afterFailure.fields.attachmentIds, [])
    const rolledBack = await pool.query('select id from node_attachments where room_key=$1', [authorized.storageScope])
    assert.equal(rolledBack.rowCount, 0)

    const uploaded = await service.uploadAttachment(pool, req('applicant'), initial.id, body)
    assert.equal(uploaded.revision, initial.revision + 1)
    assert.equal(uploaded.fields[fieldKey].length, 1)
    assert.equal(uploaded.report.attachments[0].storage, 'approval_request')
    assert.notEqual(uploaded.report.inputHash, initial.report.inputHash)
    assert.ok(!uploaded.report.blockers.includes('请补充待入职人员简历'))
    assert.ok(uploaded.report.blockers.includes('请补充待入职人员评分'))
    const replay = await service.uploadAttachment(pool, req('applicant'), initial.id, body)
    assert.equal(replay.duplicate, true)
    assert.equal(stores, 2, 'operation replay does not upload a second object')
    await assert.rejects(service.uploadAttachment(pool, req('applicant'), initial.id, { ...body, fileName: 'changed.txt' }), e => e.code === 'OPERATION_CONFLICT')
    await assert.rejects(service.uploadAttachment(pool, req('applicant'), initial.id, { ...body, operationId: randomUUID() }), e => e.code === 'REVISION_CONFLICT')
    const id = uploaded.fields[fieldKey][0]
    const visible = await service.get(pool, req('applicant'), initial.id)
    assert.equal(visible.attachmentEvidence[0].readable, true)
    assert.equal((await service.attachment(pool, req('applicant'), initial.id, id)).buffer.toString(), 'resume')
    await assert.rejects(service.attachment(pool, req('other'), initial.id, id), e => e.code === 'NOT_FOUND')
    await assert.rejects(service.mutate(pool, req('other'), other.id, 'save', {
      expectedRevision: other.revision, operationId: randomUUID(), fields: { [fieldKey]: [id] }
    }), e => e.code === 'ATTACHMENT_NOT_BOUND')
    await assert.rejects(acl.assertRoomAccess(pool, req('other'), privateAttachments.scope(initial), 'view'))
    const storedMeta = (await pool.query('select node_uid,room_key from node_attachments where id=$1', [id])).rows[0]
    assert.equal(storedMeta.node_uid, '')
    assert.equal(storedMeta.room_key, privateAttachments.scope(initial))
    let response, bodyLimit
    assert.equal(await workflowHttp.handle({ ...req('applicant'), method: 'POST' }, {}, {
      url: new URL(`http://localhost/api/workflow-requests/${initial.id}/attachments`), db: pool,
      writer: () => { throw new Error('must never write a node') },
      readBody: async (_req, options) => {
        bodyLimit = options.maxBytes
        return { expectedRevision: uploaded.revision, operationId: randomUUID(), fieldKey: ratingKey, fileName: 'rating.txt', contentBase64: Buffer.from('rating').toString('base64') }
      },
      sendJson: (_res, status, body) => { response = { status, body } }
    }), true)
    assert.equal(bodyLimit, 32 * 1024 * 1024)
    assert.equal(response.status, 200)
    const second = response.body.item
    assert.equal(second.fields[ratingKey].length, 1)
    assert.equal(second.report.attachments.length, 2)
    await assert.rejects(service.mutate(pool, req('applicant'), initial.id, 'submit', {
      expectedRevision: second.revision, operationId: randomUUID(), confirmSubmission: true,
      expectedInputHash: uploaded.report.inputHash, expectedDefinitionVersion: String(pub.id)
    }), e => e.code === 'INPUT_DATA_CHANGED')
    const submitted = await service.mutate(pool, req('applicant'), initial.id, 'submit', {
      expectedRevision: second.revision, operationId: randomUUID(), confirmSubmission: true,
      expectedInputHash: second.report.inputHash, expectedDefinitionVersion: String(pub.id)
    })
    assert.equal(submitted.status, 'approved')
    // Large immutable snapshots stay in the audit store, not in detail/list reads.
    const largeSnapshot = 'x'.repeat(2 * 1024 * 1024)
    await pool.query(`insert into leave_events(request_id,operation_id,actor_id,action,payload_hash,revision,detail)
      values($1,$2,'applicant','submit','fixture',$3,$4)`,
    [initial.id, randomUUID(), submitted.revision, { round: 1, snapshot: { proof: largeSnapshot } }])
    const oldHistory = (await pool.query('select detail from leave_events where request_id=$1', [initial.id])).rows
    let historyBytes = 0, templateReads = 0, listBytes = 0
    const measuredPool = { async query(sql, args) {
      if (sql.includes('with recursive branch')) templateReads++
      const result = await pool.query(sql, args)
      if (sql.includes("detail - 'snapshot' as detail")) historyBytes = Buffer.byteLength(JSON.stringify(result.rows))
      if (sql.includes('requester_name')) listBytes = Buffer.byteLength(JSON.stringify(result.rows))
      return result
    } }
    const finished = await service.get(measuredPool, req('applicant'), initial.id)
    assert.equal(templateReads, 0, 'closed request detail must not recompile its live template')
    assert(finished.history.every(e => !e.detail.snapshot))
    const oldHistoryBytes = Buffer.byteLength(JSON.stringify(oldHistory))
    assert(historyBytes < oldHistoryBytes / 100)
    await pool.query('update leave_requests set steps=$2 where id=$1', [initial.id, JSON.stringify([{ role: '审核人', criteria: [{ text: largeSnapshot }], assigneeId: 'reviewer' }])])
    const inbox = await service.list(measuredPool, req('applicant'), { scope: 'mine' })
    assert.equal(inbox.list.length, 1)
    assert.deepEqual(inbox.list[0].steps, [{ role: '审核人' }])
    assert(listBytes < 2000, 'list SQL must return roles without the large review text')
    console.log(`Approval payload evidence: history ${oldHistoryBytes} -> ${historyBytes} bytes; list ${listBytes} bytes; closed-template reads ${templateReads}`)
    await assert.rejects(service.uploadAttachment(pool, req('applicant'), initial.id, {
      ...body, expectedRevision: submitted.revision, operationId: randomUUID()
    }), e => e.code === 'LOCKED')
    await pool.query("update leave_requests set cc='[\"reviewer\"]' where id=$1", [initial.id])
    assert.equal((await service.attachment(pool, req('reviewer'), initial.id, id)).buffer.toString(), 'resume')
    await assert.rejects(service.uploadAttachment(pool, req('reviewer'), initial.id, {
      ...body, expectedRevision: submitted.revision, operationId: randomUUID()
    }), e => e.code === 'REQUESTER_ONLY')
    await pool.query("update node_attachments set content_hash='changed' where id=$1", [id])
    await assert.rejects(service.attachment(pool, req('applicant'), initial.id, id), e => e.code === 'MATERIAL_CHANGED')
    await service.project(pool, () => { throw new Error('must never write a node') }, initial.id)
    assert.deepEqual((await pool.query('select * from room_nodes order by uid')).rows, beforeNodes)
    const audit = (await pool.query("select detail from leave_events where action='upload_attachment' order by id")).rows
    assert.equal(audit.length, 2)
    assert.equal(audit[0].detail.attachmentId, id)
    assert.equal(audit[0].detail.storage, 'approval_request')
    assert.ok(!JSON.stringify(audit).includes(body.contentBase64), 'audit must not duplicate file bytes')

  } finally {
    Object.assign(store, originals)
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
