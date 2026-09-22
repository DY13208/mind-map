const crypto = require('crypto')
const fs = require('fs')
const COS = require('cos-nodejs-sdk-v5')
const {
  MAX_BYTES,
  COS_SLICE_BYTES,
  EXTRACT_WAIT_MAX_BYTES,
  EXTRACT_CONCURRENCY,
  DEFAULT_TEXT_SLICE_CHARS,
  MAX_TEXT_SLICE_CHARS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isAllowedFile,
  normalizeMime,
  safeFileName,
  kindOf
} = require('./limits')
const pLimit = require('p-limit')
const { extractBuffer } = require('./extract')
const { fetchSafeUrl } = require('./ssrf')
const binary = require('./binary')

const extractLimit = pLimit(EXTRACT_CONCURRENCY)

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

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function statSize(filePath) {
  const stat = await fs.promises.stat(filePath)
  return Number(stat.size || 0)
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

// extracted_text can hold tens of thousands of characters per row, so metadata
// reads select its length instead of its value.
const META_COLUMNS = [
  'id',
  'room_key',
  'node_uid',
  'content_hash',
  'file_name',
  'mime_type',
  'byte_size',
  'status',
  'error_message',
  'source_kind',
  'created_by',
  'created_at',
  'updated_at'
]
  .map(column => `a.${column}`)
  .join(', ')

function rowToMetaDto(row) {
  const dto = rowToDto(row)
  if (!dto) return null
  delete dto.extractedText
  return dto
}

function clampInt(value, fallback, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

// A file uploaded twice inside one room is deduped onto a single row whose
// node_uid only records the first node, so the node's own attachmentId has to
// be consulted as well.
async function attachmentIdsOnNode(db, roomKey, nodeUid) {
  try {
    const res = await db.query(
      `select data->>'attachmentId' as id
       from room_nodes
       where room_key = $1 and uid = $2 and deleted_at is null`,
      [roomKey, nodeUid]
    )
    return res.rows.map(row => String(row.id || '')).filter(Boolean)
  } catch (err) {
    // Rooms predating the room_nodes migration only have the attachment side.
    if (err && (err.code === '42P01' || err.code === '42703')) return []
    throw err
  }
}

async function listMeta(db, roomKey, options = {}) {
  const nodeUid = String(options.nodeUid || '').trim()
  const ids = (options.ids || [])
    .map(id => String(id || '').trim())
    .filter(Boolean)
    .slice(0, MAX_LIST_LIMIT)
  const limit = clampInt(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
  const params = [roomKey]
  const where = ['a.room_key = $1']
  if (nodeUid) {
    params.push(nodeUid)
    const uidParam = `$${params.length}`
    params.push(await attachmentIdsOnNode(db, roomKey, nodeUid))
    where.push(`(a.node_uid = ${uidParam} or a.id = any($${params.length}::text[]))`)
  }
  if (ids.length) {
    params.push(ids)
    where.push(`a.id = any($${params.length}::text[])`)
  }
  params.push(limit)
  const res = await db.query(
    `select ${META_COLUMNS}, char_length(a.extracted_text) as extracted_chars
     from node_attachments a
     where ${where.join(' and ')}
     order by a.updated_at desc, a.id
     limit $${params.length}`,
    params
  )
  return res.rows.map(rowToMetaDto)
}

async function getTextSlice(db, roomKey, id, options = {}) {
  const rawOffset = Math.floor(Number(options.offset))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  const limit = clampInt(
    options.limit,
    DEFAULT_TEXT_SLICE_CHARS,
    MAX_TEXT_SLICE_CHARS
  )
  const res = await db.query(
    `select ${META_COLUMNS}, char_length(a.extracted_text) as extracted_chars,
            substr(a.extracted_text, $3 + 1, $4) as text_slice
     from node_attachments a
     where a.room_key = $1 and a.id = $2
     limit 1`,
    [roomKey, id, offset, limit]
  )
  const row = res.rows[0]
  if (!row) return null
  const attachment = rowToMetaDto(row)
  const totalChars = attachment.extractedChars
  const text = String(row.text_slice || '')
  const nextOffset = offset + text.length
  const hasMore = nextOffset < totalChars
  return {
    attachment,
    text,
    offset,
    length: text.length,
    total_chars: totalChars,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null
  }
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

async function putObjectFromFile(cosKey, filePath, mimeType) {
  if (!storeEnabled) return false
  await cosCall('uploadFile', {
    Bucket,
    Region,
    Key: cosKey,
    FilePath: filePath,
    SliceSize: COS_SLICE_BYTES,
    ContentType: mimeType || 'application/octet-stream',
    ACL: acl
  })
  return true
}

async function getObjectBuffer(cosKey) {
  if (!storeEnabled || !cosKey) {
    const err = new Error('附件原文件未存储，无法查看或重新解析')
    err.statusCode = 404
    err.code = 'ATTACHMENT_CONTENT_MISSING'
    throw err
  }
  const data = await cosCall('getObject', {
    Bucket,
    Region,
    Key: cosKey
  })
  const body = data && data.Body
  return Buffer.isBuffer(body) ? body : Buffer.from(body || '')
}

async function getContentById(db, roomKey, id) {
  const row = await db.query(
    `select * from node_attachments where room_key = $1 and id = $2 limit 1`,
    [roomKey, id]
  )
  if (!row.rows[0]) return null
  return {
    attachment: rowToDto(row.rows[0]),
    buffer: await getObjectBuffer(row.rows[0].cos_key)
  }
}

async function deleteObject(cosKey) {
  if (!storeEnabled || !cosKey) return false
  await cosCall('deleteObject', {
    Bucket,
    Region,
    Key: cosKey
  })
  return true
}

// Attachments are deduplicated per room. When a node replaces its attachment,
// only remove the shared record if no other live node references it. Deleting
// the row also makes a late async extractor's conditional update a no-op.
async function removeById(db, roomKey, id, options = {}) {
  const nodeUid = String(options.nodeUid || '').trim()
  const existing = await db.query(
    `select * from node_attachments where room_key = $1 and id = $2 limit 1`,
    [roomKey, id]
  )
  const row = existing.rows[0]
  if (!row) return null

  if (nodeUid) {
    try {
      const references = await db.query(
        `select count(*)::integer as count
         from room_nodes
         where room_key = $1
           and deleted_at is null
           and uid <> $2
           and data->>'attachmentId' = $3`,
        [roomKey, nodeUid, id]
      )
      if (Number(references.rows[0] && references.rows[0].count) > 0) {
        return { ...rowToDto(row), deleted: false, shared: true }
      }
    } catch (err) {
      // Legacy rooms without room_nodes still support replacement. Their
      // attachment linkage lives only in the room snapshot.
      if (!err || (err.code !== '42P01' && err.code !== '42703')) throw err
    }
  }

  const removed = await db.query(
    `delete from node_attachments where room_key = $1 and id = $2 returning *`,
    [roomKey, id]
  )
  const deleted = removed.rows[0]
  if (!deleted) return null
  try {
    await deleteObject(deleted.cos_key)
  } catch (err) {
    // The database record is authoritative. A failed object cleanup only
    // leaves an inaccessible orphan and must not resurrect a cancelled task.
    console.warn('[nodeKnowledge] cos delete failed', err && err.message)
  }
  return { ...rowToDto(deleted), deleted: true, shared: false }
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

async function loadBuffer(options = {}) {
  if (Buffer.isBuffer(options.buffer)) return options.buffer
  if (options.filePath) return fs.promises.readFile(options.filePath)
  const err = new Error('缺少 roomKey 或文件内容')
  err.statusCode = 400
  err.code = 'INVALID_UPLOAD'
  throw err
}

async function createFromBuffer(db, options = {}) {
  const roomKey = String(options.roomKey || '').trim()
  const filePath = options.filePath
  const hasBuffer = Buffer.isBuffer(options.buffer)
  if (!roomKey || (!hasBuffer && !filePath)) {
    const err = new Error('缺少 roomKey 或文件内容')
    err.statusCode = 400
    err.code = 'INVALID_UPLOAD'
    throw err
  }
  const byteSize = hasBuffer ? options.buffer.length : await statSize(filePath)
  if (byteSize > MAX_BYTES) {
    throw binary.fileTooLargeError(MAX_BYTES)
  }
  const fileName = safeFileName(options.fileName || 'file')
  const mimeType = normalizeMime(options.mimeType, fileName)
  if (!isAllowedFile(fileName, mimeType)) {
    const err = new Error(`不支持的文件类型：${fileName}`)
    err.statusCode = 415
    err.code = 'UNSUPPORTED_TYPE'
    throw err
  }

  const contentHash = hasBuffer
    ? hashBuffer(options.buffer)
    : await hashFile(filePath)
  const existing = await getByHash(db, roomKey, contentHash)
  if (existing) {
    if (options.cleanupFile) await binary.unlinkQuiet(filePath)
    if (options.forceExtract && existing.status === 'failed') {
      const buffer = await loadBuffer(options)
      return reextract(db, existing, buffer)
    }
    return { ...existing, deduped: true }
  }

  const id = newId()
  const cosKey = attachmentCosKey(roomKey, contentHash)
  let storedKey = null
  try {
    const uploaded = filePath
      ? await putObjectFromFile(cosKey, filePath, mimeType)
      : await putObject(cosKey, options.buffer, mimeType)
    if (uploaded) storedKey = cosKey
  } catch (err) {
    console.warn('[nodeKnowledge] cos put failed', err && err.message)
  }

  try {
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
        byteSize,
        storedKey,
        options.sourceKind || 'attachment',
        String(options.createdBy || '').slice(0, 160)
      ]
    )
  } catch (err) {
    if (String(err && err.code) === '23505') {
      if (options.cleanupFile) await binary.unlinkQuiet(filePath)
      const raced = await getByHash(db, roomKey, contentHash)
      if (raced) return { ...raced, deduped: true }
    }
    throw err
  }

  const waitExtract =
    options.waitExtract != null
      ? !!options.waitExtract
      : byteSize <= EXTRACT_WAIT_MAX_BYTES

  const runExtract = async () => {
    try {
      const buffer = await loadBuffer(options)
      let extracted
      try {
        extracted = await extractBuffer(buffer, { fileName, mimeType })
      } catch (err) {
        extracted = {
          status: 'failed',
          extractedText: '',
          errorMessage: (err && err.message) || '附件解析失败'
        }
      }
      return updateExtraction(db, id, {
        status: extracted.status,
        errorMessage: extracted.errorMessage,
        extractedText: extracted.extractedText
      })
    } finally {
      if (options.cleanupFile) await binary.unlinkQuiet(filePath)
    }
  }

  if (waitExtract) {
    const saved = await extractLimit(() => runExtract())
    return {
      ...saved,
      deduped: false,
      kind: kindOf(fileName, mimeType)
    }
  }

  extractLimit(() => runExtract()).catch(err => {
    console.warn('[nodeKnowledge] background extract failed', err && err.message)
  })
  return {
    id,
    roomKey,
    nodeUid: String(options.nodeUid || '').slice(0, 120),
    contentHash,
    fileName,
    mimeType,
    byteSize,
    status: 'processing',
    errorMessage: '',
    extractedText: '',
    extractedChars: 0,
    sourceKind: options.sourceKind || 'attachment',
    createdBy: String(options.createdBy || '').slice(0, 160),
    deduped: false,
    kind: kindOf(fileName, mimeType)
  }
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

async function reextractStored(db, roomKey, id) {
  const content = await getContentById(db, roomKey, id)
  if (!content) return null
  return reextract(db, content.attachment, content.buffer)
}

function decodeContentBase64(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  // FileReader emits a data URL. Text files may include a charset parameter
  // and empty files legitimately have no payload after the comma.
  const dataUrl = /^data:[^,]*;base64,/i.test(raw)
  const cleaned = dataUrl ? raw.replace(/^data:[^,]*;base64,/i, '') : raw
  if (
    cleaned &&
    !/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(
      cleaned
    )
  ) {
    const err = new Error('contentBase64 无效')
    err.statusCode = 400
    err.code = 'INVALID_BASE64'
    throw err
  }
  const buf = Buffer.from(cleaned, 'base64')
  // An empty data URL represents a valid zero-byte attachment. Do not confuse
  // it with an absent payload, which is handled by ingestUpload.
  if (!buf.length && !dataUrl) {
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

async function ingestBinaryRequest(db, roomKey, req, actor = {}) {
  const meta = binary.metaFromHeaders(req)
  const received = await binary.receiveBinaryToTempFile(req, MAX_BYTES)
  try {
    return await createFromBuffer(db, {
      roomKey,
      filePath: received.filePath,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      nodeUid: meta.nodeUid,
      sourceKind: meta.sourceKind,
      createdBy: actor.id || '',
      forceExtract: meta.forceExtract,
      cleanupFile: true,
      waitExtract: received.byteSize <= EXTRACT_WAIT_MAX_BYTES
    })
  } catch (err) {
    await binary.unlinkQuiet(received.filePath)
    throw err
  }
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
  listMeta,
  getTextSlice,
  getContentById,
  removeById,
  reextractStored,
  createFromBuffer,
  ingestUpload,
  ingestBinaryRequest,
  ensureSources,
  hashBuffer,
  MAX_BYTES,
  storeEnabled
}
