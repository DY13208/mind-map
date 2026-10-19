const crypto = require('crypto')
const path = require('path')
const { httpError, sha256 } = require('./auth')
const { objectKey } = require('./storage/local')
const { assertAccess, scopeOf } = require('./acl')

const ALLOWED_EXT = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv',
  '.png', '.jpg', '.jpeg', '.webp', '.gif'
])

const FILE_COLUMNS = `id, owner_user_id, org_id, file_name, mime_type, byte_size,
  content_hash, status, latest_version, folder_id, inherit_acl, created_at, updated_at`

function extensionOf(fileName) {
  return path.extname(String(fileName || '')).toLowerCase()
}

function assertAllowedFile(fileName, bytes, config) {
  const ext = extensionOf(fileName)
  if (!ALLOWED_EXT.has(ext)) {
    throw httpError(400, 'UNSUPPORTED_TYPE', `不支持的文件类型：${ext || fileName}`)
  }
  if (!bytes || !bytes.length) throw httpError(400, 'EMPTY_FILE', '文件是空的')
  if (bytes.length > config.maxBytes) {
    throw httpError(413, 'FILE_TOO_LARGE', `文件超过 ${config.maxBytes} 字节`)
  }
}

function publicFile(row) {
  if (!row) return null
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    contentHash: row.content_hash,
    status: row.status,
    version: Number(row.latest_version),
    ownerUserId: row.owner_user_id,
    orgId: row.org_id || '',
    folderId: row.folder_id || null,
    inherit: row.inherit_acl !== false,
    effectiveRole: row.effective_role || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function clipText(value, max) {
  const text = String(value || '')
  if (Buffer.byteLength(text, 'utf8') <= max) return { text, truncated: false }
  let size = 0
  let end = 0
  for (const char of text) {
    const next = size + Buffer.byteLength(char, 'utf8')
    if (next > max - 1) break
    size = next
    end += char.length
  }
  return { text: text.slice(0, end) + '…', truncated: true }
}

async function audit(db, userId, action, fileId, detail) {
  await db.query(
    `insert into knowledge.audit (user_id, action, file_id, detail)
     values ($1, $2, $3, $4::jsonb)`,
    [userId || '', action, fileId || null, JSON.stringify(detail || {})]
  )
}

async function requireFile(db, user, fileId, action = 'view') {
  await assertAccess(db, user, action, 'file', fileId)
  const found = await db.query(`select ${FILE_COLUMNS} from knowledge.files where id = $1`, [fileId])
  if (!found.rows[0]) throw httpError(404, 'NOT_FOUND', '文件不存在或没有权限')
  found.rows[0].effective_role = await db.query(
    `select knowledge.effective_role($1, 'file', $2::uuid) as role`,
    [user.id, fileId]
  ).then(result => result.rows[0].role)
  return found.rows[0]
}

async function uploadFile(pool, storage, config, user, input) {
  assertAllowedFile(input.fileName, input.bytes, config)
  const hash = sha256(input.bytes)
  const existing = await pool.query(
    `select f.${FILE_COLUMNS.split(',').map(column => column.trim()).join(', f.')}
     from knowledge.file_versions v
     join knowledge.files f on f.id = v.file_id
     where v.owner_user_id = $1 and v.content_hash = $2
     limit 1`,
    [user.id, hash]
  )
  if (existing.rows[0] && !input.fileId) {
    await audit(pool, user.id, 'duplicate_upload', existing.rows[0].id, { contentHash: hash })
    return { duplicate: true, file: publicFile(existing.rows[0]) }
  }

  const client = await pool.connect()
  try {
    if (input.folderId) await assertAccess(pool, user, 'create', 'folder', input.folderId)
    if (input.fileId) await assertAccess(pool, user, 'upload', 'file', input.fileId)
    await client.query('begin')
    let fileId = input.fileId || crypto.randomUUID()
    let version = 1
    if (input.fileId) {
      const owned = await client.query(
        `select id, latest_version from knowledge.files
         where id = $1 for update`,
        [input.fileId]
      )
      if (!owned.rows[0]) throw httpError(404, 'NOT_FOUND', '文件不存在或没有权限')
      version = Number(owned.rows[0].latest_version) + 1
      fileId = owned.rows[0].id
    }
    const key = objectKey(config, user.id, fileId, version, input.fileName)
    const versionId = crypto.randomUUID()
    if (!input.fileId) {
      await client.query(
        `insert into knowledge.files
           (id, owner_user_id, org_id, file_name, mime_type, byte_size, content_hash, storage_key, status, latest_version, folder_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',1,$9)`,
        [fileId, user.id, user.orgId || '', input.fileName, input.mimeType || '', input.bytes.length, hash, key, input.folderId || null]
      )
      await client.query(
        `insert into knowledge.acl
           (id, resource_type, resource_id, subject_type, subject_id, role, granted_by)
         values ($1,'file',$2,'user',$3,'owner',$3)`,
        [crypto.randomUUID(), fileId, user.id]
      )
    } else {
      await client.query(
        `update knowledge.files
         set file_name = $2, mime_type = $3, byte_size = $4, content_hash = $5,
             storage_key = $6, status = 'queued', latest_version = $7, updated_at = now()
         where id = $1`,
        [fileId, input.fileName, input.mimeType || '', input.bytes.length, hash, key, version]
      )
    }
    await client.query(
      `insert into knowledge.file_versions
         (id, file_id, owner_user_id, version, content_hash, storage_key, byte_size, status)
       values ($1,$2,$3,$4,$5,$6,$7,'queued')`,
      [versionId, fileId, user.id, version, hash, key, input.bytes.length]
    )
    await client.query(
      `insert into knowledge.jobs (id, file_version_id, status)
       values ($1,$2,'pending')`,
      [crypto.randomUUID(), versionId]
    )
    await audit(client, user.id, input.fileId ? 'version_upload' : 'upload', fileId, {
      version,
      contentHash: hash,
      fileName: input.fileName
    })
    await client.query('commit')
    await storage.put(key, input.bytes)
    const saved = await pool.query(`select ${FILE_COLUMNS} from knowledge.files where id = $1`, [fileId])
    return { duplicate: false, file: publicFile(saved.rows[0]), versionId }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    if (err.code === '23505') {
      const again = await pool.query(
        `select ${FILE_COLUMNS} from knowledge.files f
         join knowledge.file_versions v on v.file_id = f.id
         where v.owner_user_id = $1 and v.content_hash = $2 limit 1`,
        [user.id, hash]
      )
      if (again.rows[0]) return { duplicate: true, file: publicFile(again.rows[0]) }
    }
    throw err
  } finally {
    client.release()
  }
}

async function listFiles(pool, user, options) {
  const limit = Math.min(options.limit || 20, options.maxPageSize || 100)
  const offset = Math.max(0, options.offset || 0)
  if (offset > 10000) throw httpError(400, 'OFFSET_TOO_LARGE', '请缩小分页偏移')
  const rows = await pool.query(
    `select ${FILE_COLUMNS}, knowledge.effective_role($1, 'file', f.id) as effective_role
     from knowledge.files f
     where knowledge.role_rank(knowledge.effective_role($1, 'file', f.id)) >= 1
       and knowledge.resource_in_scope('file', f.id, $2::uuid[])
     order by f.updated_at desc, f.id desc
     offset $3 limit $4`,
    [user.id, scopeOf(user), offset, limit + 1]
  )
  const hasMore = rows.rows.length > limit
  return {
    files: rows.rows.slice(0, limit).map(publicFile),
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  }
}

async function fileStatus(pool, user, fileId) {
  const file = await requireFile(pool, user, fileId)
  const versions = await pool.query(
    `select id, version, status, error_message, attempts, report, parser, parser_version, content_hash, created_at, updated_at
     from knowledge.file_versions
     where file_id = $1
     order by version desc
     limit 20`,
    [fileId]
  )
  const job = await pool.query(
    `select j.status, j.attempts, j.max_attempts, j.last_error, j.run_after, j.updated_at
     from knowledge.jobs j
     join knowledge.file_versions v on v.id = j.file_version_id
     where v.file_id = $1 and v.version = $2`,
    [fileId, file.latest_version]
  )
  return {
    file: publicFile(file),
    job: job.rows[0]
      ? {
          status: job.rows[0].status,
          attempts: job.rows[0].attempts,
          maxAttempts: job.rows[0].max_attempts,
          lastError: job.rows[0].last_error || '',
          runAfter: job.rows[0].run_after,
          updatedAt: job.rows[0].updated_at
        }
      : null,
    versions: versions.rows.map(row => ({
      version: row.version,
      status: row.status,
      errorMessage: row.error_message || '',
      attempts: row.attempts,
      report: row.report || {},
      parser: row.parser || '',
      parserVersion: row.parser_version || '',
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }
}

async function latestDocument(pool, fileId) {
  const found = await pool.query(
    `select d.id, d.file_id, d.parser, d.parser_version, d.plain_text, d.block_count, d.raw_document, d.created_at,
            v.version, v.status, v.report
     from knowledge.documents d
     join knowledge.file_versions v on v.id = d.file_version_id
     join knowledge.files f on f.id = d.file_id
     where d.file_id = $1 and v.version = f.latest_version`,
    [fileId]
  )
  return found.rows[0] || null
}

async function getDocument(pool, user, fileId, options = {}) {
  const file = await requireFile(pool, user, fileId)
  const document = await latestDocument(pool, fileId)
  if (!document) throw httpError(409, 'NOT_READY', '文档还没有解析完成')
  const max = options.maxResponseBytes || 20 * 1024
  const clipped = clipText(document.plain_text, Math.min(max, 8000))
  const blocks = await pool.query(
    `select id, block_key, parent_block_key, ordinal, kind, left(text, 500) as text
     from knowledge.blocks
     where document_id = $1
     order by ordinal
     offset $2 limit $3`,
    [document.id, Math.max(0, options.offset || 0), Math.min(options.limit || 50, 100)]
  )
  return {
    file: publicFile(file),
    document: {
      id: document.id,
      version: document.version,
      status: document.status,
      parser: document.parser,
      parserVersion: document.parser_version,
      blockCount: document.block_count,
      report: document.report || {},
      text: clipped.text,
      textTruncated: clipped.truncated,
      createdAt: document.created_at
    },
    blocks: blocks.rows.map(row => ({
      id: row.id,
      blockKey: row.block_key,
      parentBlockKey: row.parent_block_key,
      ordinal: row.ordinal,
      kind: row.kind,
      text: row.text
    }))
  }
}

async function getBlock(pool, user, blockId, options = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(blockId || ''))) {
    throw httpError(400, 'INVALID_ID', '块 ID 无效')
  }
  const found = await pool.query(
    `select b.*, f.owner_user_id
     from knowledge.blocks b
     join knowledge.files f on f.id = b.file_id
     where b.id = $1
       and knowledge.role_rank(knowledge.effective_role($2, 'file', f.id)) >= 1
       and knowledge.resource_in_scope('file', f.id, $3::uuid[])`,
    [blockId, user.id, scopeOf(user)]
  )
  const row = found.rows[0]
  if (!row) {
    await audit(pool, user.id, 'access_denied', null, { resource: 'block', blockId })
    throw httpError(404, 'NOT_FOUND', '内容块不存在或没有权限')
  }
  const rawBytes = Buffer.byteLength(JSON.stringify(row.raw || {}), 'utf8')
  const includeRaw = options.includeRaw !== false && rawBytes <= (options.maxResponseBytes || 20 * 1024)
  return {
    id: row.id,
    fileId: row.file_id,
    documentId: row.document_id,
    blockKey: row.block_key,
    parentBlockKey: row.parent_block_key,
    ordinal: row.ordinal,
    kind: row.kind,
    text: row.text,
    source: row.source || {},
    raw: includeRaw ? row.raw : undefined,
    rawOmitted: !includeRaw
  }
}

async function getSource(pool, user, blockId) {
  const block = await getBlock(pool, user, blockId, { includeRaw: false })
  return {
    fileId: block.fileId,
    blockId: block.id,
    blockKey: block.blockKey,
    kind: block.kind,
    source: block.source,
    excerpt: block.text,
    note: 'excerpt 是解析时保存的块文本，不是重新生成的内容'
  }
}

function likeQuery(query) {
  const text = String(query || '').trim()
  if (!text || text.length > 200) throw httpError(400, 'INVALID_QUERY', '查询词需要 1 到 200 个字符')
  return `%${text.replace(/[\\%_]/g, char => `\\${char}`)}%`
}

const ACCESS_SQL = `
  knowledge.role_rank(knowledge.effective_role($1, 'file', f.id)) >= 1
  and knowledge.resource_in_scope('file', f.id, $2::uuid[])
  and v.version = f.latest_version
  and v.status in ('ready', 'partial')
  and d.file_version_id = v.id
`

async function searchKnowledge(pool, user, options) {
  const limit = Math.min(options.limit || 20, options.maxPageSize || 100)
  const offset = Math.max(0, options.offset || 0)
  const rows = await pool.query(
    `select b.id, b.file_id, b.kind, b.block_key, left(b.text, 400) as text, b.source,
            f.file_name, v.version
     from knowledge.blocks b
     join knowledge.documents d on d.id = b.document_id
     join knowledge.files f on f.id = b.file_id
     join knowledge.file_versions v on v.file_id = f.id
     where ${ACCESS_SQL}
       and b.kind <> 'table_cell'
       and (
         b.text ilike $3 escape '\\'
         or f.file_name ilike $3 escape '\\'
       )
     order by f.updated_at desc, b.ordinal
     offset $4 limit $5`,
    [user.id, scopeOf(user), likeQuery(options.query), offset, limit + 1]
  )
  const hasMore = rows.rows.length > limit
  return {
    matches: rows.rows.slice(0, limit).map(row => ({
      blockId: row.id,
      fileId: row.file_id,
      fileName: row.file_name,
      version: row.version,
      kind: row.kind,
      blockKey: row.block_key,
      text: row.text,
      source: row.source || {}
    })),
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  }
}

async function queryRecords(pool, user, options) {
  const filters = options.filters || {}
  const allowed = new Set(['kind', 'text', 'page', 'label'])
  const unknown = Object.keys(filters).filter(key => !allowed.has(key) && filters[key] != null && filters[key] !== '')
  if (unknown.length) {
    throw httpError(400, 'UNKNOWN_FILTER', `不能查询未定义字段：${unknown.join(', ')}`)
  }
  const params = [user.id, scopeOf(user)]
  const where = [ACCESS_SQL]
  if (filters.kind) {
    params.push(String(filters.kind))
    where.push(`b.kind = $${params.length}`)
  }
  if (filters.text) {
    params.push(likeQuery(filters.text))
    where.push(`b.text ilike $${params.length} escape '\\'`)
  }
  if (filters.page != null && filters.page !== '') {
    const page = Number(filters.page)
    if (!Number.isInteger(page) || page < 0) throw httpError(400, 'INVALID_FILTER', 'page 必须是非负整数')
    params.push(page)
    where.push(`(b.source->>'page_no')::int = $${params.length}`)
  }
  if (filters.label) {
    params.push(String(filters.label))
    where.push(`b.raw->>'label' = $${params.length}`)
  }
  const limit = Math.min(options.limit || 20, options.maxPageSize || 100)
  const offset = Math.max(0, options.offset || 0)
  params.push(offset, limit + 1)
  const rows = await pool.query(
    `select b.id, b.file_id, b.kind, b.block_key, b.parent_block_key, b.ordinal,
            left(b.text, 400) as text, b.source, f.file_name, v.version
     from knowledge.blocks b
     join knowledge.documents d on d.id = b.document_id
     join knowledge.files f on f.id = b.file_id
     join knowledge.file_versions v on v.file_id = f.id
     where ${where.join(' and ')}
     order by f.updated_at desc, b.ordinal
     offset $${params.length - 1} limit $${params.length}`,
    params
  )
  const hasMore = rows.rows.length > limit
  return {
    records: rows.rows.slice(0, limit).map(row => ({
      blockId: row.id,
      fileId: row.file_id,
      fileName: row.file_name,
      version: row.version,
      kind: row.kind,
      blockKey: row.block_key,
      parentBlockKey: row.parent_block_key,
      ordinal: row.ordinal,
      text: row.text,
      source: row.source || {}
    })),
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  }
}

async function grantReader(pool, user, fileId, readerId) {
  const { setGrant } = require('./acl')
  return setGrant(pool, user, 'file', fileId, {
    subjectType: 'user',
    subjectId: readerId,
    role: 'viewer'
  })
}

async function deleteFile(pool, storage, user, fileId) {
  await requireFile(pool, user, fileId, 'remove')
  const keys = await pool.query(
    'select storage_key from knowledge.file_versions where file_id = $1',
    [fileId]
  )
  await audit(pool, user.id, 'file_delete', fileId, {})
  await pool.query('delete from knowledge.files where id = $1', [fileId])
  for (const row of keys.rows) {
    await storage.remove(row.storage_key).catch(() => {})
  }
  return { id: fileId, deleted: true }
}

async function readContent(pool, storage, user, fileId) {
  const file = await requireFile(pool, user, fileId, 'download')
  const version = await pool.query(
    `select storage_key from knowledge.file_versions
     where file_id = $1 and version = $2`,
    [fileId, file.latest_version]
  )
  if (!version.rows[0]) throw httpError(404, 'NOT_FOUND', '文件不存在或没有权限')
  const bytes = await storage.read(version.rows[0].storage_key)
  return {
    fileName: file.file_name,
    mimeType: file.mime_type || 'application/octet-stream',
    bytes
  }
}

async function reparseFile(pool, user, fileId) {
  const file = await requireFile(pool, user, fileId, 'reparse')
  const version = await pool.query(
    `select id from knowledge.file_versions where file_id = $1 and version = $2`,
    [fileId, file.latest_version]
  )
  const versionId = version.rows[0] && version.rows[0].id
  if (!versionId) throw httpError(404, 'NOT_FOUND', '文件不存在或没有权限')
  const job = await pool.query('select status from knowledge.jobs where file_version_id = $1', [versionId])
  if (job.rows[0] && job.rows[0].status === 'running') {
    throw httpError(409, 'JOB_RUNNING', '解析仍在进行')
  }
  await pool.query(
    `update knowledge.jobs
     set status = 'pending', attempts = 0, last_error = '', locked_at = null, locked_by = '',
         run_after = now(), updated_at = now()
     where file_version_id = $1`,
    [versionId]
  )
  await pool.query(
    `update knowledge.file_versions set status = 'queued', error_message = '', updated_at = now() where id = $1`,
    [versionId]
  )
  await pool.query(`update knowledge.files set status = 'queued', updated_at = now() where id = $1`, [fileId])
  await audit(pool, user.id, 'reparse', fileId, {})
  return fileStatus(pool, user, fileId)
}

async function issueToken(pool, user, label, scopeFolderIds) {
  let scope = null
  if (Array.isArray(scopeFolderIds)) {
    scope = scopeFolderIds.map(id => String(id))
    for (const id of scope) await assertAccess(pool, user, 'view', 'folder', id)
  }
  const token = `klib_${crypto.randomBytes(32).toString('base64url')}`
  const tokenId = crypto.randomUUID()
  await pool.query(
    `insert into knowledge.api_tokens
       (token_hash, token_id, user_id, org_id, label, scope_folder_ids)
     values ($1,$2,$3,$4,$5,$6::uuid[])`,
    [sha256(token), tokenId, user.id, user.orgId || '', String(label || '').slice(0, 80), scope]
  )
  await audit(pool, user.id, 'issue_token', null, { label: label || '', scopeFolderIds: scope })
  return { token, tokenId, userId: user.id, scopeFolderIds: scope }
}

async function revokeToken(pool, user, tokenId) {
  const result = await pool.query(
    `update knowledge.api_tokens
     set revoked_at = now()
     where token_id = $1::uuid and user_id = $2 and revoked_at is null
     returning token_id`,
    [tokenId, user.id]
  )
  if (!result.rows[0]) throw httpError(404, 'NOT_FOUND', '令牌不存在')
  await audit(pool, user.id, 'revoke_token', null, { tokenId })
  return { tokenId, revoked: true }
}

async function saveParsed(pool, versionRow, parsed) {
  const mapped = parsed.mapped
  const status = mapped.report.unrecognized.length || mapped.report.empty.length ? 'partial' : 'ready'
  const client = await pool.connect()
  try {
    await client.query('begin')
    const documentId = crypto.randomUUID()
    await client.query('delete from knowledge.documents where file_version_id = $1', [versionRow.id])
    await client.query(
      `insert into knowledge.documents
         (id, file_version_id, file_id, parser, parser_version, raw_document, plain_text, block_count)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [
        documentId,
        versionRow.id,
        versionRow.file_id,
        parsed.parser,
        parsed.parserVersion || '',
        JSON.stringify(parsed.raw || {}),
        mapped.plainText,
        mapped.blocks.length
      ]
    )
    for (const block of mapped.blocks) {
      await client.query(
        `insert into knowledge.blocks
           (id, document_id, file_id, block_key, parent_block_key, ordinal, kind, text, raw, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
        [
          crypto.randomUUID(),
          documentId,
          versionRow.file_id,
          block.blockKey,
          block.parentBlockKey,
          block.ordinal,
          block.kind,
          block.text,
          JSON.stringify(block.raw || {}),
          JSON.stringify(block.source || {})
        ]
      )
    }
    await client.query(
      `update knowledge.file_versions
       set status = $2, report = $3::jsonb, parser = $4, parser_version = $5,
           error_message = '', updated_at = now()
       where id = $1`,
      [versionRow.id, status, JSON.stringify(mapped.report), parsed.parser, parsed.parserVersion || '']
    )
    await client.query(
      `update knowledge.files f
       set status = $2, updated_at = now()
       from knowledge.file_versions v
       where v.id = $1 and f.id = v.file_id and f.latest_version = v.version`,
      [versionRow.id, status]
    )
    await client.query(
      `update knowledge.jobs
       set status = 'succeeded', last_error = '', locked_at = null, updated_at = now()
       where file_version_id = $1`,
      [versionRow.id]
    )
    await audit(client, versionRow.owner_user_id, 'parse_succeeded', versionRow.file_id, {
      status,
      blocks: mapped.blocks.length,
      unrecognized: mapped.report.unrecognized.length
    })
    await client.query('commit')
    return status
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function markJobFailure(pool, job, err) {
  const message = String((err && err.message) || err || '解析失败').slice(0, 500)
  const giveUp = Number(job.attempts) >= Number(job.max_attempts)
  const delaySeconds = giveUp ? 0 : [5, 20, 60][Math.min(Number(job.attempts) - 1, 2)] || 60
  await pool.query(
    `update knowledge.jobs
     set status = $2,
         last_error = $3,
         locked_at = null,
         locked_by = '',
         run_after = now() + ($4::double precision * interval '1 second'),
         updated_at = now()
     where id = $1`,
    [job.id, giveUp ? 'failed' : 'pending', message, delaySeconds]
  )
  await pool.query(
    `update knowledge.file_versions
     set status = $2, error_message = $3, updated_at = now()
     where id = $1`,
    [job.file_version_id, giveUp ? 'failed' : 'queued', message]
  )
  await pool.query(
    `update knowledge.files f
     set status = $2, updated_at = now()
     from knowledge.file_versions v
     where v.id = $1 and f.id = v.file_id and f.latest_version = v.version`,
    [job.file_version_id, giveUp ? 'failed' : 'queued']
  )
  return { retry: !giveUp, message }
}

async function recoverStaleJobs(pool, config) {
  const seconds = Math.ceil((config.parseTimeoutMs + 30000) / 1000)
  await pool.query(
    `update knowledge.jobs
     set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
         last_error = case when last_error = '' then '解析超时后已释放' else last_error end,
         locked_at = null,
         locked_by = '',
         run_after = now(),
         updated_at = now()
     where status = 'running'
       and locked_at < now() - ($1::double precision * interval '1 second')`,
    [seconds]
  )
}

async function processNextJob(pool, storage, parser, config, options = {}) {
  if (!options.onlyVersionId) await recoverStaleJobs(pool, config)
  const client = await pool.connect()
  let job
  try {
    await client.query('begin')
    const claimed = await client.query(
      `update knowledge.jobs j
       set status = 'running', locked_at = now(), locked_by = $1,
           attempts = j.attempts + 1, updated_at = now()
       where j.id = (
         select id from knowledge.jobs
         where status = 'pending' and run_after <= now()
           and ($2::uuid is null or file_version_id = $2::uuid)
         order by created_at
         for update skip locked
         limit 1
       )
       returning *`,
      [config.workerId, options.onlyVersionId || null]
    )
    job = claimed.rows[0]
    if (!job) {
      await client.query('commit')
      return null
    }
    await client.query(
      `update knowledge.file_versions set status = 'processing', attempts = $2, updated_at = now() where id = $1`,
      [job.file_version_id, job.attempts]
    )
    await client.query(
      `update knowledge.files f
       set status = 'processing', updated_at = now()
       from knowledge.file_versions v
       where v.id = $1 and f.id = v.file_id and f.latest_version = v.version`,
      [job.file_version_id]
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  const version = await pool.query(
    `select v.*, f.file_name, f.mime_type
     from knowledge.file_versions v
     join knowledge.files f on f.id = v.file_id
     where v.id = $1`,
    [job.file_version_id]
  )
  const row = version.rows[0]
  try {
    const bytes = await storage.read(row.storage_key)
    const parsed = await parser(bytes, {
      fileName: row.file_name,
      mimeType: row.mime_type,
      url: config.doclingUrl,
      ocr: config.doclingOcr,
      timeoutMs: config.parseTimeoutMs
    })
    const status = await saveParsed(pool, row, parsed)
    return { id: job.id, status }
  } catch (err) {
    const outcome = await markJobFailure(pool, job, err)
    await audit(pool, row.owner_user_id, 'parse_failed', row.file_id, {
      retry: outcome.retry,
      message: outcome.message
    })
    return { id: job.id, status: outcome.retry ? 'retry' : 'failed', error: outcome.message }
  }
}

module.exports = {
  ALLOWED_EXT,
  uploadFile,
  listFiles,
  fileStatus,
  getDocument,
  getBlock,
  getSource,
  searchKnowledge,
  queryRecords,
  grantReader,
  issueToken,
  revokeToken,
  deleteFile,
  readContent,
  reparseFile,
  processNextJob,
  publicFile
}
