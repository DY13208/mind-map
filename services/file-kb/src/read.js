'use strict'
const { httpError } = require('./errors')
const { visibleSql, requireRole } = require('./access')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TOOLS = [
  { name: 'list_knowledge_files', description: 'List files the caller can view.', inputSchema: { type: 'object', properties: { folderId: { type: 'string' }, q: { type: 'string' }, page: { type: 'integer' }, pageSize: { type: 'integer' } } } },
  { name: 'search_knowledge', description: 'Keyword and full-text search over files the caller can view.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, mode: { type: 'string', enum: ['keyword', 'hybrid'] }, limit: { type: 'integer' } }, required: ['q'] } },
  { name: 'query_knowledge_records', description: 'Filter structured rows by SKU, price, stock, date, or an original column.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, filters: { type: 'array' }, cursor:{type:'string'}, sheet:{type:'string'}, tableIndex:{type:'integer'}, page: { type: 'integer' }, pageSize: { type: 'integer' } } } },
  { name: 'get_knowledge_document', description: 'Read one file the caller can view.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } },
  { name: 'get_knowledge_block', description: 'Read one current block the caller can view.', inputSchema: { type: 'object', properties: { blockId: { type: 'string' } }, required: ['blockId'] } },
  { name: 'get_knowledge_source', description: 'Return file/version and source coordinates. row is the original spreadsheet row (1-based); rowIndex is an explicit legacy 0-based alternative. field selects an exact Excel cell.', inputSchema: { type: 'object', properties: { blockId: { type: 'string' }, fileId: { type: 'string' }, sheet: { type: 'string' }, row: { type: 'integer' }, rowIndex: {type:'integer'}, field:{type:'string'} } } },
  { name: 'get_knowledge_import_status', description: 'Return parse status for one file.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } }
]

function plain(value, max = 240) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function rawHeaders(file) {
  const name = String(file.name || 'file')
  const dangerous = /html|svg|xml|javascript|xhtml/i.test(String(file.mime || '')) || /\.(html?|svg|xml|js)$/i.test(name)
  const type = dangerous ? 'application/octet-stream' : (file.mime || 'application/octet-stream')
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\<>]/g, '_')
  return {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  }
}

const { bboxOf, sourceOf } = require('./source')

function fileItem(f) {
  return {
    id: f.id, folderId: f.folder_id, name: f.name, ext: f.ext, mime: f.mime, size: Number(f.size),
    sha256: f.sha256, status: f.status, statusDetail: f.status_detail, error: f.error,
    parseVersion: f.parse_version, currentRunId: f.current_run_id, createdAt: f.created_at, updatedAt: f.updated_at
  }
}

async function listFiles(db, user, { folderId, q, status, page = 1, pageSize = 50 } = {}) {
  const params = []
  const where = ['f.deleted_at is null', visibleSql(user, 'file', 'f', params)]
  if (folderId) {
    if (!UUID.test(folderId)) throw httpError(400, 'bad_folder_id')
    params.push(folderId)
    where.push(`f.folder_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    where.push(`f.status = $${params.length}`)
  }
  if (q) {
    params.push(`%${String(q).replace(/[%_\\]/g, m => '\\' + m).slice(0, 200)}%`)
    where.push(`f.name ilike $${params.length}`)
  }
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 100)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit
  const count = await db.query(`select count(*)::int n from kb.files f where ${where.join(' and ')}`, params)
  params.push(limit, offset)
  const rows = await db.query(
    `select * from kb.files f where ${where.join(' and ')}
      order by f.updated_at desc, f.id desc limit $${params.length - 1} offset $${params.length}`, params)
  const items = rows.rows.map(fileItem)
  return { items, total: count.rows[0].n, files: items }
}

async function search(db, user, { q, mode = 'hybrid', limit = 20, folderId, cursor } = {}) {
  const query = String(q || '').trim()
  if (!query) throw httpError(400, 'q_required')
  if (mode === 'semantic') throw httpError(501, 'not_implemented', 'semantic search is not enabled')
  if (mode !== 'keyword' && mode !== 'hybrid') throw httpError(400, 'bad_mode')
  if (folderId && !UUID.test(folderId)) throw httpError(400, 'bad_folder_id')
  let offset = 0
  if (cursor) {
    let n
    try { n = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()) } catch (_) { throw httpError(400, 'bad_cursor') }
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw httpError(400, 'bad_cursor')
    offset = n
  }
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50)
  const params = []
  const visible = visibleSql(user, 'file', 'f', params)
  let folderSql = ''
  if (folderId) {
    params.push(folderId)
    folderSql = ` and f.folder_id = $${params.length}::uuid`
  }
  params.push(query)
  const qParam = params.length
  params.push(`%${query.replace(/[%_\\]/g, m => '\\' + m).slice(0, 200)}%`)
  const likeParam = params.length
  const textMatch = mode === 'keyword'
    ? `b.text ilike $${likeParam}`
    : `(b.tsv @@ plainto_tsquery('simple', $${qParam}) or b.text ilike $${likeParam})`
  const rank = mode === 'keyword'
    ? '0.5::float8'
    : `ts_rank(b.tsv, plainto_tsquery('simple', $${qParam}))`
  const inner = `
      select f.id as file_id, f.name as file_name, f.parse_version, f.current_run_id as run_id,
             b.id::text as block_id, b.page, b.sheet, b.bbox, null::int as row_index,
             left(b.text, 400) as snippet, ${rank} as score
        from kb.blocks b
        join kb.files f on f.id = b.file_id and b.run_id = f.current_run_id
       where f.deleted_at is null and ${visible} and ${textMatch}${folderSql}
      union all
      select f.id, f.name, f.parse_version, f.current_run_id, null::text, null::int, r.sheet, null::jsonb, r.row_index,
             left(coalesce(r.sku, '') || ' ' || r.data::text, 400),
             case when r.sku = $${qParam} then 1 else 0.4 end
        from kb.records r
        join kb.files f on f.id = r.file_id and r.run_id = f.current_run_id
       where f.deleted_at is null and ${visible}
         and (r.sku = $${qParam} or r.data::text ilike $${likeParam} or f.name ilike $${likeParam})${folderSql}`
  const count = await db.query(`select count(*)::int n from (${inner}) hits`, params)
  params.push(cap + 1, offset)
  const rows = await db.query(`select * from (${inner}) hits order by score desc, file_id limit $${params.length - 1} offset $${params.length}`, params)
  const results = rows.rows.slice(0, cap).map(row => {
    const shownRow = row.row_index == null ? null : row.row_index + 1
    return {
      fileId: row.file_id,
      fileName: row.file_name,
      parseVersion: row.parse_version,
      blockId: row.block_id,
      page: row.page,
      sheet: row.sheet,
      row: shownRow,
      bbox: bboxOf(row.bbox),
      snippet: plain(row.snippet),
      score: Number(row.score) || 0,
      source: sourceOf(row)
    }
  })
  const next = rows.rows.length > cap ? Buffer.from(JSON.stringify(offset + cap)).toString('base64url') : null
  return { results, items: results, total: count.rows[0].n, nextCursor: next, next_cursor: next }
}

const { queryRecords } = require('./records')

function fieldType(name, inferred) {
  if (/货号|商品编码|商品编号|产品编码|sku/i.test(name)) return 'sku'
  if (/价格|单价|售价|price/i.test(name)) return 'price'
  if (/库存|数量|stock|qty/i.test(name)) return 'stock'
  if (inferred === 'date' || /日期|date/i.test(name)) return 'date'
  if (/编码|编号|\bcode\b|\bid\b/i.test(name)) return 'code'
  if (inferred === 'int' || inferred === 'numeric') return 'number'
  return 'string'
}

async function listFields(db, user, fileId) {
  if (!UUID.test(String(fileId || ''))) throw httpError(400, 'bad_file_id')
  await requireRole(db, user, 'file', fileId, 'viewer')
  const rows = await db.query(
    `select fd.name, fd.inferred_type
       from kb.fields fd
       join kb.files f on f.id = fd.file_id and fd.run_id = f.current_run_id
      where fd.file_id = $1
      order by fd.sheet, fd.col_index`, [fileId])
  const fields = rows.rows.map(row => ({ key: row.name, label: row.name, type: fieldType(row.name, row.inferred_type) }))
  return { fields }
}

async function listBlocks(db, user, fileId) {
  await requireRole(db, user, 'file', fileId, 'viewer')
  const rows = await db.query(
    `select b.id, b.type, b.text, b.page, b.bbox, b.sheet, b.cell_range, b.data, f.parse_version, f.current_run_id as run_id, b.file_id
       from kb.blocks b
       join kb.files f on f.id = b.file_id and b.run_id = f.current_run_id
      where b.file_id = $1 and f.deleted_at is null
      order by b.seq
      limit 2000`, [fileId])
  const blocks = rows.rows.map(row => {
    const grid = row.data && Array.isArray(row.data.grid) ? row.data.grid : null
    return {
      id: Number(row.id), type: row.type, text: row.text, page: row.page,
      bbox: bboxOf(row.bbox), sheet: row.sheet, row: null, cell: row.cell_range,
      parseVersion: row.parse_version,
      source: { ...sourceOf({ ...row, row:row.data?.role==='note'?row.data.row:null, block_id: String(row.id) }), rows: grid ? grid.length : null, cols: grid && grid[0] ? grid[0].length : null }
    }
  })
  return { blocks }
}

async function getDocument(db, user, fileId) {
  await requireRole(db, user, 'file', fileId, 'viewer')
  const r = await db.query('select * from kb.files where id = $1 and deleted_at is null', [fileId])
  if (!r.rows[0]) throw httpError(404, 'missing', 'not found')
  return fileItem(r.rows[0])
}

async function getBlock(db, user, blockId) {
  if (!/^\d+$/.test(String(blockId || ''))) throw httpError(404, 'missing', 'not found')
  const r = await db.query(
    `select b.id, b.type, b.text, b.page, b.bbox, b.sheet, b.cell_range, b.data, b.file_id, f.parse_version, f.current_run_id as run_id, f.name
       from kb.blocks b
       join kb.files f on f.id = b.file_id and b.run_id = f.current_run_id
      where b.id = $1 and f.deleted_at is null`, [blockId])
  if (!r.rows[0]) throw httpError(404, 'missing', 'not found')
  await requireRole(db, user, 'file', r.rows[0].file_id, 'viewer')
  const row = r.rows[0]
  return {
    id: Number(row.id), fileId: row.file_id, fileName: row.name, type: row.type, text: row.text,
    page: row.page, bbox: bboxOf(row.bbox), sheet: row.sheet, cell: row.cell_range,
    parseVersion: row.parse_version, source: sourceOf({ ...row, row:row.data?.role==='note'?row.data.row:null, block_id: String(row.id) })
  }
}

async function getSource(db, user, args) {
  if (args.blockId) {
    const block = await getBlock(db, user, args.blockId)
    return { source: block.source, text: plain(block.text, 500), fileName: block.fileName }
  }
  if (!args.fileId) throw httpError(400, 'source_required')
  const doc = await getDocument(db, user, args.fileId)
  if (args.sheet != null && (args.row != null || args.rowIndex != null)) {
    const index = args.rowIndex != null ? Number(args.rowIndex) : Number(args.row) - 1
    if (!Number.isInteger(index) || index < 0) throw httpError(400, 'bad_row')
    const params = [args.fileId, String(args.sheet), index]
    const row = await db.query(
      `select r.*, f.parse_version, f.name, (select max(col_index)+1 from kb.fields fd where fd.run_id=r.run_id and fd.sheet=r.sheet and fd.table_index=r.table_index) column_count
         from kb.records r join kb.files f on f.id = r.file_id and r.run_id = f.current_run_id
        where r.file_id = $1 and r.sheet = $2 and r.row_index = $3`, params)
    if (!row.rows[0]) throw httpError(404, 'missing', 'not found')
    const record=row.rows[0],source=sourceOf(record)
    if(args.field!=null){
      const fd=(await db.query('select col_index from kb.fields where run_id=$1 and sheet=$2 and table_index=$3 and name=$4',[record.run_id,record.sheet,record.table_index,String(args.field)])).rows[0]
      if(!fd)throw httpError(404,'missing')
      source.cell=require('./structurer/header').colLetter(fd.col_index)+source.row
      return {source,fileName:doc.name,field:String(args.field),value:record.data[args.field]??null}
    }
    return { source, fileName: doc.name, data: record.data }
  }
  return { source: { fileId: doc.id, parseVersion: doc.parseVersion, runId: doc.currentRunId, coordinateVersion: 2, rowBase: 1, blockId: null, page: null, sheet: null, row: null }, fileName: doc.name }
}

async function importStatus(db, user, fileId) {
  const doc = await getDocument(db, user, fileId)
  return { id: doc.id, status: doc.status, error: doc.error, parseVersion: doc.parseVersion }
}

async function callTool(db, user, name, args = {}) {
  const input = { ...args }
  delete input.userId
  delete input.ownerId
  delete input.actorId
  delete input.subjectId
  if (name === 'list_knowledge_files') return listFiles(db, user, input)
  if (name === 'search_knowledge') return search(db, user, input)
  if (name === 'query_knowledge_records') return queryRecords(db, user, input)
  if (name === 'get_knowledge_document') return getDocument(db, user, input.fileId)
  if (name === 'get_knowledge_block') return getBlock(db, user, input.blockId)
  if (name === 'get_knowledge_source') return getSource(db, user, input)
  if (name === 'get_knowledge_import_status') return importStatus(db, user, input.fileId)
  throw httpError(400, 'unknown_tool')
}

module.exports = {
  TOOLS, plain, rawHeaders, bboxOf, fileItem, listFiles, search, queryRecords,
  sourceOf, listFields, listBlocks, getDocument, getBlock, getSource, importStatus, callTool
}
