const crypto = require('crypto')
const COS = require('cos-nodejs-sdk-v5')
const {
  MAX_BYTES,
  isAllowedFile,
  normalizeMime,
  safeFileName,
  kindOf
} = require('./limits')
const { extractBuffer } = require('./extract')
const { fetchSafeUrl } = require('./ssrf')

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY
})
const Bucket = process.env.TENCENT_COS_BUCKET
const Region = process.env.TENCENT_COS_REGION
const location = String(process.env.TENCENT_COS_LOCATION || 'mind-map').replace(
  /^\/+|\/+$/g,
  ''
)
const acl = process.env.TENCENT_COS_ACL || 'private'
const storeEnabled = !!(Bucket && Region && process.env.TENCENT_COS_SECRET_ID)

function cosCall(method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

function attachmentCosKey(roomKey, contentHash) {
  return `${location}/attachments/${roomKey}/${contentHash}`
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function newId() {
  return crypto.randomBytes(16).toString('hex')
}

function rowToDto(row) {
  if (!row) return null
  return {
    id: row.id,
    roomKey: row.room_key,
    nodeUid: row.node_uid || '',
    contentHash: row.content_hash,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size || 0),
    status: row.status,
    errorMessage: row.error_message || '',
    extractedText: row.extracted_text || '',
    extractedChars: Number(row.extracted_chars || 0),
    sourceKind: row.source_kind || 'attachment',
    createdBy: row.created_by || '',
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
  }
}

async function initSchema(db) {
  await db.query(`
    create table if not exists node_attachments (
      id text primary key,
      room_key text not null,
      node_uid text not null default '',
      content_hash text not null,
      file_name text not null default '',
      mime_type text not null default '',
      byte_size integer not null default 0,
      cos_key text,
      status text not null default 'pending',
      error_message text not null default '',
      extracted_text text not null default '',
      extracted_chars integer not null default 0,
      source_kind text not null default 'attachment',
      created_by text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint node_attachments_status_chk
        check (status in ('pending', 'processing', 'ready', 'failed')),
      constraint node_attachments_room_hash_uq unique (room_key, content_hash)
    )`)
  await db.query(
    `create index if not exists node_attachments_room_updated_idx
     on node_attachments(room_key, updated_at desc)`
  )
  await db.query(
    `create index if not exists node_attachments_room_node_idx
     on node_attachments(room_key, node_uid)`
  )
}

async function getById(db, roomKey, id) {
  const res = await db.query(
    `select * from node_attachments where room_key = $1 and id = $2 limit 1`,
    [roomKey, id]
  )
  return rowToDto(res.rows[0])
}

async function getByHash(db, roomKey, contentHash) {
  const res = await db.query(
    `select * from node_attachments where room_key = $1 and content_hash = $2 limit 1`,
    [roomKey, contentHash]
  )
  return rowToDto(res.rows[0])
}

async function listByIds(db, roomKey, ids) {
  const list = (ids || []).map(id => String(id || '').trim()).filter(Boolean)
  if (!list.length) return []
  const res = await db.query(
    `select * from node_attachments
     where room_key = $1 and id = any($2::text[])`,
    [roomKey, list]
  )
  return res.rows.map(rowToDto)
}

async function putObject(cosKey, buffer, mimeType) {
  if (!storeEnabled) return false
  await cosCall('putObject', {
    Bucket,
    Region,
    Key: cosKey,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    ACL: acl
  })
  return true
}

async function updateExtraction(db, id, patch) {
  const res = await db.query(
    `update node_attachments set
       status = $2,
       error_message = $3,
       extracted_text = $4,
       extracted_chars = $5,
       updated_at = now()
     where id = $1
     returning *`,
    [
      id,
      patch.status,
      patch.errorMessage || '',
      patch.extractedText || '',
      Number((patch.extractedText || '').length)
    ]
  )
  return rowToDto(res.rows[0])
}

async function createFromBuffer(db, options = {}) {
  const roomKey = String(options.roomKey || '').trim()
  const buffer = options.buffer
  if (!roomKey || !Buffer.isBuffer(buffer)) {
    const err = new Error('缺少 roomKey 或文件内容')
    err.statusCode = 400
    err.code = 'INVALID_UPLOAD'
    throw err
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`文件过大（最多 ${MAX_BYTES} 字节）`)
    err.statusCode = 413
    err.code = 'FILE_TOO_LARGE'
    throw err
  }
  const fileName = safeFileName(options.fileName || 'file')
  const mimeType = normalizeMime(options.mimeType, fileName)
  if (!isAllowedFile(fileName, mimeType)) {
    const err = new Error(`不支持的文件类型：${fileName}`)
    err.statusCode = 415
    err.code = 'UNSUPPORTED_TYPE'
    throw err
  }

  const contentHash = hashBuffer(buffer)
  const existing = await getByHash(db, roomKey, contentHash)
  if (existing) {
    // Dedup: re-extract only when previous attempt failed and force is set.
    if (
      options.forceExtract &&
      existing.status === 'failed'
    ) {
      return reextract(db, existing, buffer)
    }
    return { ...existing, deduped: true }
  }

  const id = newId()
  const cosKey = attachmentCosKey(roomKey, contentHash)
  let storedKey = null
  try {
    if (await putObject(cosKey, buffer, mimeType)) storedKey = cosKey
  } catch (err) {
    console.warn('[nodeKnowledge] cos put failed', err && err.message)
  }

  await db.query(
    `insert into node_attachments (
       id, room_key, node_uid, content_hash, file_name, mime_type, byte_size,
       cos_key, status, source_kind, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10)`,
    [
      id,
      roomKey,
      String(options.nodeUid || '').slice(0, 120),
      contentHash,
      fileName,
      mimeType,
      buffer.length,
      storedKey,
      options.sourceKind || 'attachment',
      String(options.createdBy || '').slice(0, 160)
    ]
  )

  const extracted = await extractBuffer(buffer, { fileName, mimeType })
  const saved = await updateExtraction(db, id, {
    status: extracted.status,
    errorMessage: extracted.errorMessage,
    extractedText: extracted.extractedText
  })
  return { ...saved, deduped: false, kind: extracted.kind || kindOf(fileName, mimeType) }
}

async function reextract(db, existing, buffer) {
  await updateExtraction(db, existing.id, {
    status: 'processing',
    errorMessage: '',
    extractedText: ''
  })
  const extracted = await extractBuffer(buffer, {
    fileName: existing.fileName,
    mimeType: existing.mimeType
  })
  return updateExtraction(db, existing.id, {
    status: extracted.status,
    errorMessage: extracted.errorMessage,
    extractedText: extracted.extractedText
  })
}

function decodeContentBase64(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const cleaned = raw.replace(/^data:[^;]+;base64,/i, '')
  const buf = Buffer.from(cleaned, 'base64')
  if (!buf.length) {
    const err = new Error('contentBase64 无效')
    err.statusCode = 400
    err.code = 'INVALID_BASE64'
    throw err
  }
  return buf
}

async function ingestUpload(db, roomKey, body, actor = {}) {
  let buffer = decodeContentBase64(body && body.contentBase64)
  let mimeType = body && body.mimeType
  let fileName = (body && body.fileName) || 'file'
  if (!buffer && body && body.sourceUrl) {
    const downloaded = await fetchSafeUrl(body.sourceUrl, { maxBytes: MAX_BYTES })
    buffer = downloaded.buffer
    mimeType = mimeType || downloaded.mimeType
    if (!body.fileName) {
      try {
        const pathName = new URL(downloaded.finalUrl).pathname
        fileName = decodeURIComponent(pathName.split('/').pop() || 'download')
      } catch (e) {
        fileName = 'download'
      }
    }
  }
  if (!buffer) {
    const err = new Error('请提供 contentBase64 或 sourceUrl')
    err.statusCode = 400
    err.code = 'MISSING_CONTENT'
    throw err
  }
  return createFromBuffer(db, {
    roomKey,
    buffer,
    fileName,
    mimeType,
    nodeUid: body && body.nodeUid,
    sourceKind: (body && body.sourceKind) || 'attachment',
    createdBy: actor.id || '',
    forceExtract: !!(body && body.forceExtract)
  })
}

async function ensureSources(db, roomKey, sources, actor = {}) {
  const results = []
  for (const source of sources || []) {
    if (!source) continue
    if (source.attachmentId) {
      const row = await getById(db, roomKey, source.attachmentId)
      if (!row) {
        results.push({
          type: source.type || 'attachment',
          name: source.name || source.attachmentId,
          status: 'failed',
          error: '附件不存在或无权限',
          attachmentId: source.attachmentId,
          extractedText: ''
        })
        continue
      }
      results.push({
        type: source.type || row.sourceKind || 'attachment',
        name: source.name || row.fileName,
        status: row.status,
        error: row.errorMessage,
        attachmentId: row.id,
        extractedText: row.extractedText
      })
      continue
    }
    if (source.contentBase64 || source.sourceUrl) {
      try {
        const saved = await ingestUpload(
          db,
          roomKey,
          {
            contentBase64: source.contentBase64,
            sourceUrl: source.sourceUrl,
            fileName: source.name || source.fileName || 'file',
            mimeType: source.mimeType,
            nodeUid: source.nodeUid,
            sourceKind: source.type || 'attachment',
            forceExtract: !!source.forceExtract
          },
          actor
        )
        results.push({
          type: source.type || saved.sourceKind || 'attachment',
          name: source.name || saved.fileName,
          status: saved.status,
          error: saved.errorMessage,
          attachmentId: saved.id,
          extractedText: saved.extractedText,
          imageUrl: source.imageUrl || ''
        })
      } catch (err) {
        results.push({
          type: source.type || 'attachment',
          name: source.name || source.fileName || 'file',
          status: 'failed',
          error: (err && err.message) || '解析失败',
          extractedText: '',
          imageUrl: source.imageUrl || ''
        })
      }
      continue
    }
    results.push({
      type: source.type || 'unknown',
      name: source.name || '',
      status: source.status || 'failed',
      error: source.error || '缺少可解析内容',
      extractedText: source.extractedText || '',
      attachmentId: source.attachmentId || '',
      imageUrl: source.imageUrl || ''
    })
  }
  return results
}

module.exports = {
  initSchema,
  rowToDto,
  getById,
  getByHash,
  listByIds,
  createFromBuffer,
  ingestUpload,
  ensureSources,
  hashBuffer,
  MAX_BYTES,
  storeEnabled
}
