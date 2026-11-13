const { failure } = require('./core')
const { isWecomDiskShare, localDownloadRequired } = require('./wecomDisk')

// This storage namespace is not a map and never has a room ACL or node.
// All access goes through the owning approval request's personal identity checks.
function scope(row) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(row.id || '')))
    throw failure('INVALID_ID', '申请编号无效')
  return `approval-request:${row.id}`
}

function storageScope(row, snapshot) {
  return snapshot && snapshot.storage === 'approval_request' ? scope(row) : row.room_key
}

function assertUpload(row, who, req) {
  if (row.corp_id !== who.corp_id || row.requester_id !== who.user_id)
    throw failure('REQUESTER_ONLY', '只有本次申请的申请人可以上传附件', 403)
  if (row.template.agentInput !== true || row.input_mode !== 'agent')
    throw failure('AGENT_INPUT_REQUIRED', '专属附件仅用于 Agent 对话材料申请', 409)
  if (!req.authUser || (!req.authUser.mcp && !req.verifiedMcpSource))
    throw failure('AGENT_EXECUTION_REQUIRED', '请通过个人 MCP 在 Agent 中上传审批材料', 403)
  if (!['draft', 'returned'].includes(row.status))
    throw failure('LOCKED', '已提交的申请不能上传附件；请先撤回或退回', 409)
}

function field(row, fieldKey) {
  const f = row.template.fields.find(f => f.type === 'attachment' && (f.key === fieldKey || f.label === fieldKey))
  if (!f) throw failure('ATTACHMENT_FIELD_REQUIRED', '请指定本次审批模板中的附件字段 key 或准确名称')
  return f
}

async function validate(db, row, fields) {
  const result = []
  for (const id of fields.attachmentIds || []) {
    const meta = (await db.query(
      'select id,status,content_hash,file_name,source_kind,cos_key from node_attachments where room_key=$1 and id=$2',
      [scope(row), id]
    )).rows[0]
    if (!meta || meta.source_kind !== 'approval_request' || !meta.cos_key)
      throw failure('ATTACHMENT_NOT_BOUND', '附件不属于本次审批申请，不能引用脑图附件或其他申请的材料', 403)
    if (meta.status !== 'ready')
      throw failure('ATTACHMENT_NOT_READY', '审批附件尚未解析完成或解析失败，请重新上传可读取的材料', 409)
    result.push({ id, hash: meta.content_hash, fileName: meta.file_name, storage: 'approval_request' })
  }
  return result
}

async function ingest(db, row, who, body, store = require('../nodeKnowledge/store')) {
  const f = field(row, body.fieldKey)
  if (!store.storeEnabled) throw failure('ATTACHMENT_STORAGE_UNAVAILABLE', '审批附件存储尚未配置', 503)
  const ids = new Set(row.fields.attachmentIds || [])
  if (ids.size >= 10) throw failure('INVALID_ATTACHMENTS', '本次申请证明附件已达到10份上限')
  if (isWecomDiskShare(body.sourceUrl)) throw localDownloadRequired()
  // Never accept caller-controlled nodeUid, roomKey, sourceKind or actor identity.
  const saved = await store.ingestUpload(db, scope(row), {
    fileName: body.fileName,
    mimeType: body.mimeType,
    contentBase64: body.contentBase64,
    sourceUrl: body.sourceUrl,
    sourceKind: 'approval_request'
  }, { id: who.user_id, waitExtract: true, maxBytes: 20 * 1024 * 1024 })
  if (saved.status !== 'ready' || !(saved.extractedChars > 0))
    throw failure('ATTACHMENT_NOT_READY', '审批附件未能提取正文，请重试或上传可读取的文件', 409)
  const fields = { ...row.fields, [f.key]: [...new Set([...(row.fields[f.key] || []), saved.id])] }
  ids.add(saved.id)
  fields.attachmentIds = [...ids].sort()
  return { fields, attachmentId: saved.id, fieldKey: f.key }
}

module.exports = { scope, storageScope, assertUpload, field, validate, ingest }
