'use strict'
const { withTx } = require('./tx')
const { receiveFiles, cleanup } = require('./upload')
const { sanitizeName, EXCEL } = require('./limits')
const access = require('./access')
const readApi = require('./read')
const { previewExcel } = require('./structurer/excel')
const { colLetter } = require('./structurer/header')
const { createBatches } = require('./batches')
const { normalizeMappings, carryConfirmed } = require('./structurer/mapping')
const { instrumentPool, measureUpload, scope } = require('./metrics')
const { retryAfterMsFor } = require('./errors')
const { smartQuery } = require('./geekcloud/smart')
const { FORBIDDEN_REASONS } = require('./geekcloud/policy')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES = new Set(['pending', 'parsing', 'structuring', 'done', 'partial', 'failed'])

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(payload)
}
class HttpError extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code } }

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'body_too_large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (_) { reject(new HttpError(400, 'bad_json')) } })
    req.on('error', reject)
  })
}

// Visibility is the four-level check. A configured super-admin flag does not bypass it.
function ownerClause(user, alias, params, kind = 'file') {
  return access.visibleSql(user, kind, alias, params)
}

function fileView(f) {
  return {
    id: f.id, folderId: f.folder_id, name: f.name, ext: f.ext, mime: f.mime, size: Number(f.size), sha256: f.sha256,
    status: f.status, statusDetail: f.status_detail, error: f.error, parseVersion: f.parse_version,
    currentRunId: f.current_run_id, createdAt: f.created_at, updatedAt: f.updated_at
  }
}

function createApi({ pool, storage, queue, config, limiter, geekcloud = null }) {
  instrumentPool(pool)
  const batches = createBatches(pool, queue)
  async function getFolder(db, user, id, minRole) {
    await access.requireRole(db, user, 'folder', id, minRole)
    const r = await db.query('select * from kb.folders where id = $1 and deleted_at is null', [id])
    if (!r.rows[0]) throw new HttpError(404, 'missing')
    return r.rows[0]
  }
  async function getFile(db, user, id, minRole) {
    await access.requireRole(db, user, 'file', id, minRole)
    const r = await db.query('select * from kb.files where id = $1 and deleted_at is null', [id])
    if (!r.rows[0]) throw new HttpError(404, 'missing')
    return r.rows[0]
  }

  async function activeJobsFor(userId) {
    const r = await pool.query(
      `select count(*)::int n from kb.jobs j join kb.files f on f.id = j.file_id
       where f.owner_id = $1 and j.state in ('queued','running')`, [userId])
    return r.rows[0].n
  }

  async function upload(req, res, user, url) {
    const uploadStarted=performance.now(), uploadRss=process.memoryUsage().rss
    const batchId=url.searchParams.get('batch_id') || url.searchParams.get('batchId') || null
    if(batchId) { const b=await batches.load(pool,user,batchId); if(b.sealed_at||b.control==='cancelled')throw new HttpError(409,'batch_closed') }
    if(Array.isArray(user.scopeFolderIds) && !url.searchParams.get('folder_id') && !url.searchParams.get('folderId'))throw new HttpError(403,'folder_required')
    if((await activeJobsFor(user.id))>=config.maxQueuedPerUser)throw new HttpError(429,'queue_full')
    const len = Number(req.headers['content-length'] || 0)
    if (len && len > config.maxBatchBytes) throw new HttpError(413, 'batch_too_large')
    if (!/^multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'multipart_required')
    const lease = limiter.acquire(user.id)
    if (!lease.ok) throw new HttpError(429, lease.code)
    let received
    try {
      received = await receiveFiles(req, { storage, maxFileBytes: config.maxFileBytes, maxFiles: config.maxFilesPerBatch, maxBatchBytes: config.maxBatchBytes })
    } finally { lease.release() }
    const { accepted, rejected, fields } = received
    if (received.filesLimit) rejected.push({ name: '*', code: 'too_many_files' })
    try {
      const folderId = url.searchParams.get('folderId') || url.searchParams.get('folder_id') || fields.folderId || fields.folder_id || null
      if (folderId) await getFolder(pool, user, folderId, 'editor')
      if (accepted.length && !limiter.take(user.id, accepted.length)) {
        const err = new HttpError(429, 'rate_limited')
        err.retryAfterMs = limiter.retryAfterMs(user.id)
        throw err
      }
      if (accepted.length && (await activeJobsFor(user.id)) + accepted.length > config.maxQueuedPerUser) throw new HttpError(429, 'queue_full')
      if(batchId) for(const r of rejected) await batches.reject(user,batchId,{key:String(url.searchParams.get('client_key')||'rejected:'+r.name).slice(0,300),name:r.name,error:r.code,uploadMetrics:{uploadMs:performance.now()-uploadStarted,rssBytes:process.memoryUsage().rss}})
      const results = []
      for (const f of accepted) {
        const key = await storage.commitTemp(f.tmp, f.sha256)
        const out = await withTx(pool, async c => {
          await c.query("select pg_advisory_xact_lock(hashtext('kb.upload.admission'))")
          async function recorded(result,runId) {
            if(batchId) await batches.attach(c,user,batchId,{file:result,runId,duplicate:!!result.duplicate,name:f.name,
              clientKey: String(url.searchParams.get('client_key') || f.sha256+':'+f.name).slice(0,300),
              metrics:{uploadMs:performance.now()-uploadStarted,rssPeakBytes:Math.max(uploadRss,process.memoryUsage().rss,scope.getStore()?.rssPeakBytes||0),bytes:f.size,dbMs:scope.getStore()?.dbMs||0,dbWriteMs:scope.getStore()?.dbWriteMs||0}})
            return {...result,batchId}
          }
          const dup = await c.query(
            `select * from kb.files where owner_id = $1 and team_id is null and sha256 = $2 and deleted_at is null`, [user.id, f.sha256])
          if (dup.rows[0]) {
            if (dup.rows[0].owner_id !== user.id) throw new HttpError(404, 'missing')
            await getFile(c,user,dup.rows[0].id,'viewer')
            const rid=(await c.query('select id from kb.parse_runs where file_id=$1 order by created_at desc limit 1',[dup.rows[0].id])).rows[0]?.id
            return recorded({ ...fileView(dup.rows[0]), duplicate: true },rid)
          }
          const active=(await c.query("select count(*)::int total,count(*) filter(where f.owner_id=$1)::int own from kb.jobs j join kb.files f on f.id=j.file_id where j.state in('queued','running')",[user.id])).rows[0]
          if(active.own>=config.maxQueuedPerUser || active.total>=(config.maxActiveJobs||500))throw new HttpError(429,'queue_full')
          const ins = await c.query(
            `insert into kb.files (folder_id, owner_id, name, ext, mime, size, sha256, storage_key, status, created_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$2)
             on conflict (coalesce(team_id, ''), owner_id, sha256) where deleted_at is null do nothing
             returning *`, [folderId, user.id, f.name, f.ext, f.mime, f.size, f.sha256, key])
          if (!ins.rows[0]) { // concurrent upload of the same content won the race
            const again = await c.query(`select * from kb.files where owner_id = $1 and team_id is null and sha256 = $2 and deleted_at is null`, [user.id, f.sha256])
            if (!again.rows[0] || again.rows[0].owner_id !== user.id) throw new HttpError(404, 'missing')
            await getFile(c,user,again.rows[0].id,'viewer')
            return recorded({ ...fileView(again.rows[0]), duplicate: true },again.rows[0].current_run_id)
          }
          const file = ins.rows[0]
          const run = await c.query(`insert into kb.parse_runs (file_id, options) values ($1, $2) returning id`, [file.id, { source: 'upload' }])
          await queue.enqueue(c, { fileId: file.id, runId: run.rows[0].id, kind: 'parse', batchId })
          await c.query(`insert into kb.audit (actor, action, target, meta) values ($1,'file.upload',$2,$3)`, [user.id, file.id, { name: f.name, size: f.size, sha256: f.sha256 }])
          return recorded({ ...fileView(file), duplicate: false },run.rows[0].id)
        })
        results.push(out)
      }
      const created = results.filter(r => !r.duplicate).length
      const status = created ? 201 : results.length ? 200 : (rejected.some(r => r.code === 'file_too_large') ? 413 : 400)
      // Single-file upload (frontend contract: field `file`) returns the file object itself;
      // batch keeps { files, rejected }. Both carry files/rejected.
      const body = results.length === 1 && accepted.length === 1 ? { ...results[0], files: results, rejected } : { files: results, rejected }
      if (!results.length && rejected.length) { body.code = rejected[0].code; body.error = rejected[0].code }
      send(res, status, body)
    } catch (err) {
      await cleanup(accepted)
      throw err
    }
  }

  function pageParams(url, def = 50, max = 200) {
    const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') || url.searchParams.get('limit')) || def, 1), max)
    const page = Math.max(Number(url.searchParams.get('page')) || 1, 1)
    return { page, pageSize, offset: (page - 1) * pageSize }
  }
  const qp = (url, ...names) => { for (const n of names) { const v = url.searchParams.get(n); if (v != null && v !== '') return v } return null }

  async function listFiles(res, user, url) {
    const params = []
    const where = ['f.deleted_at is null', ownerClause(user, 'f', params)]
    const folderId = qp(url, 'folderId', 'folder_id')
    if (folderId) { if (!UUID.test(folderId)) throw new HttpError(400, 'bad_folder_id'); params.push(folderId); where.push(`f.folder_id = $${params.length}`) }
    const status = url.searchParams.get('status')
    if (status) { if (!STATUSES.has(status)) throw new HttpError(400, 'bad_status'); params.push(status); where.push(`f.status = $${params.length}`) }
    const q = url.searchParams.get('q')
    if (q) { params.push(`%${q.replace(/[%_\\]/g, m => '\\' + m).slice(0, 200)}%`); where.push(`f.name ilike $${params.length}`) }
    const idsRaw = url.searchParams.get('ids')
    if (idsRaw) {
      const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
      if (!ids.length || ids.length > 50 || ids.some(id => !UUID.test(id))) throw new HttpError(400, 'bad_ids')
      params.push(ids)
      where.push(`f.id = any($${params.length}::uuid[])`)
    }
    const cursor = url.searchParams.get('cursor')
    const { page, pageSize, offset } = pageParams(url)
    const total = cursor ? null : (await pool.query(`select count(*)::int n from kb.files f where ${where.join(' and ')}`, params)).rows[0].n
    if (cursor) {
      const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|')
      if (!UUID.test(id || '') || isNaN(Date.parse(ts))) throw new HttpError(400, 'bad_cursor')
      params.push(ts, id); where.push(`(f.updated_at, f.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
    }
    params.push(pageSize + 1)
    const lim = `$${params.length}`
    let off = ''
    if (!cursor && offset) { params.push(offset); off = ` offset $${params.length}` }
    const r = await pool.query(`select * from kb.files f where ${where.join(' and ')} order by f.updated_at desc, f.id desc limit ${lim}${off}`, params)
    const rows = r.rows.slice(0, pageSize)
    const next = r.rows.length > pageSize ? Buffer.from(`${rows[rows.length - 1].updated_at.toISOString()}|${rows[rows.length - 1].id}`).toString('base64url') : null
    const items = rows.map(fileView)
    send(res, 200, { items, files: items, total, page, pageSize, nextCursor: next, next_cursor: next })
  }

  async function fileDetail(res, user, id) {
    const f = await getFile(pool, user, id, 'viewer')
    const runs = await pool.query(`select id, status, docling_status, error, raw_json_key is not null as has_raw, stats, created_at, started_at, finished_at from kb.parse_runs where file_id = $1 order by created_at desc limit 10`, [id])
    const jobs = await pool.query(`select id, kind, resource_class, batch_id, state, attempts, max_attempts, run_after, last_error, deferred_count, first_started_at, metrics, updated_at from kb.jobs where file_id = $1 order by id desc limit 20`, [id])
    const counts = f.current_run_id ? (await pool.query(
      `select (select count(*)::int from kb.blocks where run_id = $1) blocks, (select count(*)::int from kb.records where run_id = $1) records, (select count(*)::int from kb.fields where run_id = $1) fields`, [f.current_run_id])).rows[0] : null
    send(res, 200, { ...fileView(f), runs: runs.rows, jobs: jobs.rows, counts })
  }

  async function updateFile(req, res, user, id) {
    const body = await readJson(req)
    const out = await withTx(pool, async c => {
      const f = await getFile(c, user, id, 'editor')
      const sets = []
      const params = [f.id]
      if (body.name != null) {
        if (!String(body.name).trim()) throw new HttpError(400, 'name_required')
        params.push(sanitizeName(body.name)); sets.push(`name = $${params.length}`)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'folderId')) {
        if (body.folderId) await getFolder(c, user, body.folderId, 'editor')
        params.push(body.folderId || null); sets.push(`folder_id = $${params.length}`)
      }
      if (!sets.length) return f
      const r = await c.query(`update kb.files set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, params)
      await c.query(`insert into kb.audit (actor, action, target, meta) values ($1,'file.update',$2,$3)`, [user.id, f.id, body])
      return r.rows[0]
    })
    send(res, 200, fileView(out))
  }

  function blockView(b) {
    return {
      id: String(b.id), seq: b.seq, type: b.type, text: b.text, page: b.page,
      bbox: b.bbox && Array.isArray(b.bbox.norm) ? b.bbox.norm : readApi.bboxOf(b.bbox), rawBbox: b.bbox,
      sheet: b.sheet, row: b.data && b.data.row != null ? b.data.row : null, cell: b.cell_range,
      headingPath: b.heading_path || [], table: b.data || null
    }
  }

  async function fileBlocks(res, user, id, url) {
    const f = await getFile(pool, user, id, 'viewer')
    const { page, pageSize, offset } = pageParams(url, 200, 500)
    if (!f.current_run_id) return send(res, 200, { items: [], blocks: [], total: 0, page, pageSize, nextCursor: null, next_cursor: null, status: f.status })
    const params = [f.current_run_id]
    const where = ['run_id = $1']
    const cursor = url.searchParams.get('cursor')
    if (cursor) {
      let seq
      try { seq = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch (_) { throw new HttpError(400, 'bad_cursor') }
      if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'bad_cursor')
      params.push(seq)
      where.push(`seq > $${params.length}`)
    }
    const total = (await pool.query('select count(*)::int n from kb.blocks where run_id = $1', [f.current_run_id])).rows[0].n
    params.push(pageSize + 1)
    const lim = params.length
    let offSql = ''
    if (!cursor && offset) { params.push(offset); offSql = ` offset $${params.length}` }
    const r = await pool.query(
      `select id, seq, type, text, page, bbox, sheet, cell_range, heading_path, data from kb.blocks where ${where.join(' and ')} order by seq limit $${lim}${offSql}`,
      params)
    const rows = r.rows.slice(0, pageSize)
    const items = rows.map(blockView)
    const next = r.rows.length > pageSize ? Buffer.from(JSON.stringify(rows[rows.length - 1].seq)).toString('base64url') : null
    send(res, 200, { items, blocks: items, total, page, pageSize, runId: f.current_run_id, nextCursor: next, next_cursor: next })
  }

  const INLINE_SAFE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'])
  async function fileRaw(req, res, user, id) {
    const f = await getFile(pool, user, id, 'viewer')
    const filePath = storage.resolveKey(f.storage_key)
    const st = await require('fs').promises.stat(filePath).catch(() => null)
    if (!st) throw new HttpError(410, 'object_missing')
    const inline = INLINE_SAFE.has(f.ext)
    const enc = encodeURIComponent(f.name)
    const headers = {
      'Content-Type': inline ? f.mime : (f.ext === 'xlsx' || f.ext === 'xls' || f.ext === 'docx' || f.ext === 'pptx' ? f.mime : 'application/octet-stream'),
      'Content-Length': st.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${enc}"; filename*=UTF-8''${enc}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${f.sha256}"`
    }
    // html/md/csv etc. are never rendered same-origin; non-inline types get a sandbox CSP as well.
    if (!inline) headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
    if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, { ETag: headers.ETag }); return res.end() }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    await new Promise((resolve, reject) => {
      const s = require('fs').createReadStream(filePath)
      s.on('error', reject); res.on('close', resolve); s.pipe(res)
    })
  }

  const FIELD_TYPE = { int: 'number', numeric: 'number', date: 'date', bool: 'string', text: 'string' }
  const SPECIAL_COL = { sku: 'sku', price: 'price', stock: 'stock', record_date: 'record_date', date: 'record_date' }

  async function listFields(res, user, url) {
    const fileId = qp(url, 'fileId', 'file_id')
    if (!fileId) throw new HttpError(400, 'fileId_required')
    const f = await getFile(pool, user, fileId, 'viewer')
    if (!f.current_run_id) return send(res, 200, { fields: [] })
    const run = (await pool.query('select stats from kb.parse_runs where id = $1', [f.current_run_id])).rows[0]
    const special = (run && run.stats && run.stats.special) || {}
    const r = await pool.query('select sheet, col_index, name, inferred_type, header_row, confidence, confirmed, table_index from kb.fields where run_id = $1 order by sheet, table_index, col_index', [f.current_run_id])
    const fields = r.rows.map(x => {
      const sp = Object.entries(special[x.sheet] || {}).find(([, name]) => name === x.name)
      return {
        key: x.name, label: x.name, type: sp ? (sp[0] === 'record_date' ? 'date' : sp[0]) : FIELD_TYPE[x.inferred_type] || 'string',
        sheet: x.sheet, colIndex: x.col_index, inferredType: x.inferred_type, column: sp ? sp[0] : null,
        headerRow: x.header_row, confidence: x.confidence == null ? null : Number(x.confidence), confirmed: x.confirmed !== false, tableIndex: x.table_index
      }
    })
    send(res, 200, { fields })
  }

  async function listRecords(res, user, url) {
    const body = await readApi.queryRecords(pool, user, {
      fileId: qp(url, 'fileId', 'file_id'), filters: url.searchParams.get('filters') || [],
      limit: qp(url, 'limit', 'pageSize'), page: url.searchParams.get('page'),
      cursor: url.searchParams.get('cursor'), sheet: url.searchParams.get('sheet'), tableIndex: url.searchParams.get('table_index')
    })
    send(res, 200, body)
  }

  async function reparse(res, user, id) {
    const out = await withTx(pool, async c => {
      const f = await getFile(c, user, id, 'editor')
      await c.query('select id from kb.files where id = $1 for update', [f.id])
      const active = await c.query(`select id, kind from kb.jobs where file_id = $1 and state in ('queued','running')`, [f.id])
      if (active.rows.length) throw new HttpError(409, 'job_in_progress')
      const run = await c.query(`insert into kb.parse_runs (file_id, options) values ($1, $2) returning id`, [f.id, { source: 'reparse', by: user.id }])
      const jobId = await queue.enqueue(c, { fileId: f.id, runId: run.rows[0].id, kind: 'parse' })
      await c.query(`update kb.files set status = 'pending', status_detail = 'reparse queued', updated_at = now() where id = $1`, [f.id])
      await c.query(`insert into kb.audit (actor, action, target) values ($1,'file.reparse',$2)`, [user.id, f.id])
      return { id: f.id, status: 'pending', runId: run.rows[0].id, jobId: jobId == null ? null : String(jobId) }
    })
    send(res, 202, out)
  }

  function parseStructureBody(body) {
    const list = Array.isArray(body && body.sheets) ? body.sheets : []
    if (!list.length || list.length>100) throw new HttpError(400, 'bad_layout')
    return list.map(s => {
      if (!s || typeof s.sheet !== 'string' || !s.sheet.trim()) throw new HttpError(400, 'bad_layout')
      const headerRows = [...new Set((Array.isArray(s.headerRows) ? s.headerRows : []).map(Number))]
        .filter(n => Number.isInteger(n) && n > 0 && n < 1000000)
        .sort((a, b) => a - b)
      const dataStartRow = Number(s.dataStartRow)
      if (!headerRows.length || headerRows.length>10 || !Number.isInteger(dataStartRow) || dataStartRow <= headerRows[headerRows.length - 1]) {
        throw new HttpError(400, 'bad_layout')
      }
      const columns = (Array.isArray(s.columns) ? s.columns : []).filter(c => c && Number.isInteger(Number(c.index)) && Number(c.index) >= 0 && Number(c.index) < 500 && String(c.name || '').trim())
        .map(c => ({ index: Number(c.index), name: String(c.name).trim().slice(0, 200) }))
      const columnOverrides=s.columnOverrides == null ? null : s.columnOverrides
      if(columnOverrides != null && (!Array.isArray(columnOverrides)||columnOverrides.some(c=>!Number.isInteger(c.index)||c.index<0||c.index>=500||typeof c.name!=='string'||!c.name.trim()||c.name.length>200)))throw new HttpError(400,'bad_layout')
      return { sheet: s.sheet.trim().slice(0, 200), headerRows, dataStartRow, columns, columnOverrides }
    })
  }

  function previewQuery(url) {
    const sheet = url && (url.searchParams.get('sheet') || null)
    const fromRaw = url && (url.searchParams.get('from_row') || url.searchParams.get('fromRow'))
    const limitRaw = url && url.searchParams.get('limit')
    const fromRow = fromRaw == null || fromRaw === '' ? 1 : Number(fromRaw)
    const limit = limitRaw == null || limitRaw === '' ? 12 : Number(limitRaw)
    if (!Number.isInteger(fromRow) || fromRow < 1 || fromRow > 1000000) throw new HttpError(400, 'bad_layout')
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'bad_layout')
    return { sheet, fromRow, limit }
  }

  async function fileLayout(res, user, id, url) {
    const page = previewQuery(url)
    const f = await getFile(pool, user, id, 'viewer')
    if (!EXCEL.has(f.ext)) throw new HttpError(415, 'not_excel')
    const preview = await previewExcel(storage.resolveKey(f.storage_key), { fromRow: page.fromRow, limit: page.limit, sheet: page.sheet, maxRows: page.limit, maxCols: 80 })
    const run = f.current_run_id
      ? (await pool.query('select stats from kb.parse_runs where id = $1', [f.current_run_id])).rows[0]
      : null
    const sheets = preview.sheets.map(sheet => {
      const region = (sheet.regions && sheet.regions[0]) || { headerRows: [], dataStartRow: null, confidence: 0, needsConfirmation: true, headers: [] }
      const appliedSheet = run && run.stats && run.stats.layout && Array.isArray(run.stats.layout.sheets)
        ? run.stats.layout.sheets.find(s => s.sheet === sheet.name)
        : null
      const applied = appliedSheet && appliedSheet.regions && appliedSheet.regions[0]
      const headers = applied && applied.confirmed && Array.isArray(applied.headers) && applied.headers.length ? applied.headers : (region.headers || [])
      const headerRows = applied && applied.confirmed && applied.headerRows && applied.headerRows.length ? applied.headerRows : (region.headerRows || [])
      const dataStartRow = applied && applied.confirmed && applied.dataStartRow ? applied.dataStartRow : region.dataStartRow
      const width = Math.max(headers.length, ...sheet.preview.map(r => (r.values || []).length), 0)
      return {
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        mappingVersion: 2,
        columnsAreSnapshot: true,
        confidence: applied && applied.confirmed ? 1 : region.confidence,
        needsConfirmation: applied && applied.confirmed ? false : region.needsConfirmation === true,
        confirmed: !!(applied && applied.confirmed),
        headerRows,
        dataStartRow,
        regions: sheet.regions,
        columns: headers.map((name, index) => ({
          index,
          letter: colLetter(index),
          name,
          samples: sheet.preview.filter(r => dataStartRow && r.row >= dataStartRow && !headerRows.includes(r.row)).slice(0, 3).map(r => (r.values && r.values[index] != null ? r.values[index] : ''))
        })),
        previewFromRow: sheet.previewFromRow || page.fromRow,
        previewLimit: sheet.previewLimit || page.limit,
        rowCountExact: sheet.rowCountExact === true,
        preview: sheet.preview.map(r => ({ row: r.row, values: Array.from({ length: width }, (_, i) => (r.values && r.values[i] != null ? r.values[i] : null)) }))
      }
    })
    send(res, 200, { fileId: f.id, sheet: page.sheet, fromRow: page.fromRow, limit: page.limit, sheets })
  }

  async function restructure(req, res, user, id) {
    const body = await readJson(req, 262144)
    let sheets = parseStructureBody(body)
    const out = await withTx(pool, async c => {
      const f = await getFile(c, user, id, 'editor')
      if (!EXCEL.has(f.ext)) throw new HttpError(415, 'not_excel')
      await c.query('select id from kb.files where id = $1 for update', [f.id])
      const active = await c.query(`select id from kb.jobs where file_id = $1 and state in ('queued','running')`, [f.id])
      if (active.rows.length) throw new HttpError(409, 'job_in_progress')
      const preview=await previewExcel(storage.resolveKey(f.storage_key),{maxCols:500,selectedBySheet:Object.fromEntries(sheets.map(s=>[s.sheet,s.headerRows]))})
      const current=f.current_run_id?(await c.query('select stats, options from kb.parse_runs where id=$1',[f.current_run_id])).rows[0]:null
      sheets=carryConfirmed(normalizeMappings(sheets,preview,current?.stats?.layout),current?.options?.structure)
      const options = { source: 'structure', by: user.id, structure: { confirmed: true, sheets } }
      const run = await c.query(
        `insert into kb.parse_runs (file_id, options, raw_json_key, docling_status)
         select f.id, $2::jsonb, p.raw_json_key, p.docling_status
         from kb.files f left join kb.parse_runs p on p.id = f.current_run_id
         where f.id = $1
         returning id`,
        [f.id, JSON.stringify(options)])
      const jobId = await queue.enqueue(c, { fileId: f.id, runId: run.rows[0].id, kind: 'structure' })
      await c.query(`update kb.files set status = 'structuring', status_detail = 'structure queued', updated_at = now() where id = $1`, [f.id])
      await c.query(`insert into kb.audit (actor, action, target) values ($1,'file.structure',$2)`, [user.id, f.id])
      return { id: f.id, status: 'structuring', runId: run.rows[0].id, jobId: jobId == null ? null : String(jobId) }
    })
    send(res, 202, out)
  }

  async function deleteFile(res, user, id) {
    await withTx(pool, async c => {
      const f = await getFile(c, user, id, 'manager')
      await c.query(`update kb.files set deleted_at = now(), updated_at = now() where id = $1`, [f.id])
      await c.query(`update kb.jobs set state = 'cancelled', lease_token = null, locked_until = null, updated_at = now() where file_id = $1 and state in ('queued','running')`, [f.id])
      await c.query(`insert into kb.audit (actor, action, target) values ($1,'file.delete',$2)`, [user.id, f.id])
    })
    send(res, 200, { id, deleted: true })
  }

  const folderView = f => ({ id: f.id, parentId: f.parent_id, name: f.name, path: f.path, createdAt: f.created_at, updatedAt: f.updated_at, effectiveRole: f.role || 'owner', inherit: f.inherit_acl !== false })

  async function createFolder(req, res, user) {
    const body = await readJson(req)
    if (!body.name || !String(body.name).trim()) throw new HttpError(400, 'name_required')
    const name = sanitizeName(body.name)
    const parentId = body.parentId || body.parent_id || null
    let parentPath = '/'
    if (parentId) {
      const parent = await getFolder(pool, user, parentId, 'editor')
      await access.assertNoCycle(pool, null, parent.id)
      parentPath = parent.path
    }
    const r = await pool.query(
      `insert into kb.folders (owner_id, parent_id, name, path) values ($1,$2,$3,$4) returning *`,
      [user.id, parentId, name, `${parentPath.replace(/\/$/, '')}/${name}`])
    send(res, 201, folderView(r.rows[0]))
  }

  async function listFolders(res, user, url) {
    const params = []
    const where = ['f.deleted_at is null', ownerClause(user, 'f', params, 'folder')]
    const parent = qp(url, 'parentId', 'parent_id')
    if (!parent || parent === 'root') where.push('f.parent_id is null')
    else { if (!UUID.test(parent)) throw new HttpError(400, 'bad_parent_id'); params.push(parent); where.push(`f.parent_id = $${params.length}`) }
    const cursor = url.searchParams.get('cursor')
    if (cursor) {
      let decoded
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch (_) { throw new HttpError(400, 'bad_cursor') }
      if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string' || !UUID.test(String(decoded[1]))) throw new HttpError(400, 'bad_cursor')
      params.push(decoded[0], decoded[1])
      where.push(`(f.name, f.id) > ($${params.length - 1}, $${params.length}::uuid)`)
    }
    const { pageSize } = pageParams(url, 100, 200)
    params.push(user.id)
    const roleParam = params.length
    params.push(pageSize + 1)
    const r = await pool.query(
      `select f.*, kb.effective_role('folder', f.id, $${roleParam}) as role,
              exists(select 1 from kb.folders c where c.parent_id = f.id and c.deleted_at is null and kb.effective_role('folder', c.id, $${roleParam}) is not null) as has_children
         from kb.folders f where ${where.join(' and ')} order by f.name, f.id limit $${params.length}`, params)
    const rows = r.rows.slice(0, pageSize)
    const items = rows.map(row => ({ ...folderView(row), hasChildren: row.has_children === true }))
    const next = r.rows.length > pageSize ? Buffer.from(JSON.stringify([rows[rows.length - 1].name, rows[rows.length - 1].id])).toString('base64url') : null
    send(res, 200, { items, folders: items, nextCursor: next, next_cursor: next })
  }

  async function renameFolder(req, res, user, id) {
    const body = await readJson(req)
    if (!body.name || !String(body.name).trim()) throw new HttpError(400, 'name_required')
    const f = await getFolder(pool, user, id, 'editor')
    const stamp = body.updatedAt || body.updated_at
    if (stamp && new Date(stamp).getTime() !== new Date(f.updated_at).getTime()) throw new HttpError(409, 'stale_update')
    const parentId = Object.prototype.hasOwnProperty.call(body, 'parentId') ? (body.parentId || null) : undefined
    if (parentId !== undefined) {
      await getFolder(pool, user, id, 'manager')
      if (parentId) await getFolder(pool, user, parentId, 'editor')
      await access.assertNoCycle(pool, id, parentId)
    }
    const r = await pool.query(
      `update kb.folders set name = $2,
         parent_id = case when $3::boolean then $4::uuid else parent_id end,
         updated_at = now() where id = $1 returning *`,
      [id, sanitizeName(body.name), parentId !== undefined, parentId || null])
    r.rows[0].role = await access.effectiveRole(pool, 'folder', id, user)
    send(res, 200, folderView(r.rows[0]))
  }

  async function deleteFolder(res, user, id) {
    await withTx(pool, async c => {
      await getFolder(c, user, id, 'manager')
      const busy = await c.query(
        `select (select count(*) from kb.folders where parent_id = $1 and deleted_at is null) + (select count(*) from kb.files where folder_id = $1 and deleted_at is null) n`, [id])
      if (Number(busy.rows[0].n) > 0) throw new HttpError(409, 'FOLDER_NOT_EMPTY', 'folder not empty')
      await c.query(`update kb.folders set deleted_at = now(), updated_at = now() where id = $1`, [id])
    })
    send(res, 200, { id, deleted: true })
  }

  function route(req, res, user, pathname, method, url) {
    let m
    if(pathname==='/api/kb/batches' && method==='POST') return readJson(req).then(b=>batches.create(user,b)).then(b=>send(res,201,b))
    if(pathname==='/api/kb/batches' && method==='GET') return batches.list(user,{cursor:url.searchParams.get('cursor'),limit:url.searchParams.get('limit')}).then(b=>send(res,200,b))
    if((m=/^\/api\/kb\/batches\/([^/]+)(?:\/(items|metrics|seal|pause|resume|cancel|retry))?$/.exec(pathname))){
      const id=m[1],action=m[2]
      if(method==='GET' && !action)return batches.status(user,id).then(b=>send(res,200,b))
      if(method==='GET' && action==='items')return batches.items(user,id,{after:url.searchParams.get('cursor'),limit:url.searchParams.get('limit')}).then(b=>send(res,200,b))
      if(method==='GET' && action==='metrics')return batches.metrics(user,id).then(b=>send(res,200,b))
      if(method==='POST' && ['seal','pause','resume','cancel','retry'].includes(action))return batches.control(user,id,action).then(b=>send(res,200,b))
    }
    if (pathname === '/api/kb/files' && method === 'POST') return measureUpload(()=>upload(req, res, user, url))
    if (pathname === '/api/kb/files' && method === 'GET') return listFiles(res, user, url)
    if ((m = /^\/api\/kb\/files\/([^/]+)$/.exec(pathname))) {
      if (method === 'GET') return fileDetail(res, user, m[1])
      if (method === 'PATCH') return updateFile(req, res, user, m[1])
      if (method === 'DELETE') return deleteFile(res, user, m[1])
    }
    if ((m = /^\/api\/kb\/files\/([^/]+)\/blocks$/.exec(pathname)) && method === 'GET') return fileBlocks(res, user, m[1], url)
    if ((m = /^\/api\/kb\/files\/([^/]+)\/raw$/.exec(pathname)) && (method === 'GET' || method === 'HEAD')) return fileRaw(req, res, user, m[1])
    if (pathname === '/api/kb/fields' && method === 'GET') return listFields(res, user, url)
    if (pathname === '/api/kb/records' && method === 'GET') return listRecords(res, user, url)
    if ((m = /^\/api\/kb\/files\/([^/]+)\/reparse$/.exec(pathname)) && method === 'POST') return reparse(res, user, m[1])
    if ((m = /^\/api\/kb\/files\/([^/]+)\/layout$/.exec(pathname)) && method === 'GET') return fileLayout(res, user, m[1], url)
    if ((m = /^\/api\/kb\/files\/([^/]+)\/structure$/.exec(pathname)) && method === 'POST') return restructure(req, res, user, m[1])
    if (pathname === '/api/kb/folders' && method === 'POST') return createFolder(req, res, user)
    if (pathname === '/api/kb/folders' && method === 'GET') return listFolders(res, user, url)
    if ((m = /^\/api\/kb\/folders\/([^/]+)$/.exec(pathname))) {
      if (method === 'PATCH') return renameFolder(req, res, user, m[1])
      if (method === 'DELETE') return deleteFolder(res, user, m[1])
    }
    if (pathname === '/api/kb/search' && method === 'GET') {
      return readApi.search(pool, user, {
        q: url.searchParams.get('q') || '',
        mode: url.searchParams.get('mode') || 'hybrid',
        limit: url.searchParams.get('limit') || 20,
        folderId: url.searchParams.get('folder_id') || url.searchParams.get('folderId') || undefined,
        cursor: url.searchParams.get('cursor') || undefined
      }).then(body => send(res, 200, body))
    }
    if ((m = /^\/api\/kb\/acl\/(file|folder)\/([^/]+)\/transfer$/.exec(pathname)) && method === 'POST') {
      const type = m[1]
      const id = decodeURIComponent(m[2])
      return readJson(req).then(body => access.transferOwner(pool, user, type, id, body)).then(body => send(res, 200, body))
    }
    if ((m = /^\/api\/kb\/acl\/(file|folder)\/([^/]+)$/.exec(pathname)) && ['GET', 'PUT', 'DELETE'].includes(method)) {
      const type = m[1]
      const id = decodeURIComponent(m[2])
      if (method === 'GET') return access.describeAcl(pool, user, type, id).then(body => send(res, 200, body))
      return readJson(req).then(body => (method === 'PUT' ? access.putGrant(pool, user, type, id, body) : access.deleteGrant(pool, user, type, id, body))).then(body => send(res, 200, body))
    }
    if (pathname === '/api/kb/mcp/status' && method === 'GET') {
      return pool.query(`select token_prefix from kb.mcp_tokens where user_id = $1 and revoked_at is null order by created_at desc limit 1`, [user.id]).then(row => send(res, 200, {
        ok: true, url: '/file-kb-mcp/mcp', transport: 'streamable-http', version: '2025-06-18', tokenPrefix: row.rows[0] ? row.rows[0].token_prefix : null
      }))
    }
    if (pathname === '/api/kb/mcp/tools' && method === 'GET') return send(res, 200, { tools: readApi.TOOLS })
    if (pathname === '/api/kb/mcp/call' && method === 'POST') {
      return readJson(req).then(body => {
        if (body.userId && body.userId !== user.id) throw new HttpError(403, 'forbidden')
        return readApi.callTool(pool, user, body.tool, body.arguments || {})
      }).then(body => send(res, 200, body))
    }
    if (pathname === '/api/kb/smart-query' && method === 'POST') {
      return readJson(req).then(body => smartQuery({ db: pool, geekcloud, via: 'api' }, user, body || {})).then(body => send(res, 200, body))
    }
    if (pathname === '/api/kb/geekcloud/status' && method === 'GET') {
      return Promise.resolve(send(res, 200, geekcloud ? geekcloud.status(user) : { enabled: false, configured: false, connection: { state: 'disabled' } }))
    }
    if (pathname === '/api/kb/geekcloud/check' && method === 'POST') {
      if (!geekcloud) return Promise.resolve(send(res, 200, { ok: false, state: 'disabled', reason: 'geekcloud_disabled' }))
      return geekcloud.check(user).then(body => {
        if (FORBIDDEN_REASONS.includes(body.reason)) throw new HttpError(403, body.reason)
        send(res, 200, body)
      })
    }
    if (pathname === '/api/kb/geekcloud/calls' && method === 'GET') return geekcloudCalls(res, user)
    if (pathname === '/api/kb/mcp/tokens' && method === 'GET') return listTokens(res, user)
    if (pathname === '/api/kb/mcp/tokens' && method === 'POST') return createToken(req, res, user)
    if ((m = /^\/api\/kb\/mcp\/tokens\/([^/]+)$/.exec(pathname)) && method === 'DELETE') return revokeToken(res, user, decodeURIComponent(m[1]))
    return null
  }

  function tokenView(row) {
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      scopes: row.scopes || [],
      scopeFolderIds: row.scope_folder_ids || [],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at
    }
  }

  // Own calls only: other users' SKUs and errors are not visible here.
  async function geekcloudCalls(res, user) {
    const rows = await pool.query(
      `select at, action, target, meta from kb.audit
        where actor = $1 and action in ('geekcloud.call', 'geekcloud.check')
        order by at desc limit 20`, [user.id])
    const items = rows.rows.map(r => ({
      at: r.at, action: r.action, tool: r.target, status: r.meta && r.meta.status, code: (r.meta && r.meta.code) || null,
      durationMs: r.meta && r.meta.durationMs, via: (r.meta && r.meta.via) || null, sku: (r.meta && r.meta.sku) || null
    }))
    send(res, 200, { items })
  }

  async function listTokens(res, user) {
    const rows = await pool.query(
      `select id, name, token_prefix, scopes, scope_folder_ids, created_at, expires_at, revoked_at, last_used_at
         from kb.mcp_tokens where user_id = $1 order by created_at desc limit 50`, [user.id])
    const items = rows.rows.map(tokenView)
    send(res, 200, { items, tokens: items })
  }

  async function createToken(req, res, user) {
    const crypto = require('crypto')
    const body = await readJson(req)
    if (body.userId && body.userId !== user.id) throw new HttpError(403, 'forbidden')
    const allowed = ['kb:read', 'kb:write', 'kb:admin', 'geekcloud:read']
    const asked = Array.isArray(body.scopes) && body.scopes.length ? [...new Set(body.scopes.map(String))] : ['kb:read']
    if (asked.some(s => !allowed.includes(s))) throw new HttpError(400, 'bad_scope')
    const callerScopes = user.via === 'token' ? (user.scopes || []) : allowed
    if (asked.some(s => !callerScopes.includes(s))) throw new HttpError(403, 'forbidden')
    // New tokens are read-only: kb:read is required, geekcloud:read is the only optional extra.
    if (!asked.includes('kb:read') || asked.some(s => s !== 'kb:read' && s !== 'geekcloud:read')) throw new HttpError(400, 'bad_scope')
    const scope = Array.isArray(body.scopeFolderIds) && body.scopeFolderIds.length ? body.scopeFolderIds : null
    if (scope && scope.some(id => !UUID.test(id))) throw new HttpError(400, 'bad_folder_id')
    if (scope && asked.includes('geekcloud:read')) throw new HttpError(400, 'geekcloud_scope_folder_conflict')
    if (user.via === 'token' && Array.isArray(user.scopeFolderIds)) {
      if (!scope || !scope.length) throw new HttpError(403, 'forbidden')
      for (const folderId of scope) {
        const ok = await pool.query('select kb.folder_in_scope($1, $2::uuid[]) as ok', [folderId, user.scopeFolderIds])
        if (!ok.rows[0] || ok.rows[0].ok !== true) throw new HttpError(403, 'forbidden')
      }
    } else if (scope) {
      for (const folderId of scope) await getFolder(pool, user, folderId, 'viewer')
    }
    // No ttl -> server default; default unset -> permanent (null), revocable any time.
    // An optional max (FILE_KB_MCP_TOKEN_MAX_TTL_DAYS) forbids permanent tokens and longer ttls.
    const maxDays = (config && config.mcpTokenMaxTtlDays) || null
    let defaultDays = (config && config.mcpTokenDefaultTtlDays) || null
    if (maxDays) defaultDays = Math.min(defaultDays || maxDays, maxDays)
    const limitDays = maxDays || 36500
    let expiresAt = null
    if (body.permanent === true && maxDays) throw new HttpError(400, 'bad_ttl')
    if (body.ttlDays != null && body.ttlDays !== '') {
      const days = Number(body.ttlDays)
      if (!Number.isInteger(days) || days < 1 || days > limitDays) throw new HttpError(400, 'bad_ttl')
      expiresAt = new Date(Date.now() + days * 86400000)
    } else if (body.expiresAt) {
      const when = new Date(body.expiresAt)
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() || when.getTime() > Date.now() + limitDays * 86400000) {
        throw new HttpError(400, 'bad_ttl')
      }
      expiresAt = when
    } else if (body.permanent !== true && defaultDays) {
      expiresAt = new Date(Date.now() + defaultDays * 86400000)
    }
    const raw = crypto.randomBytes(32).toString('hex')
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const prefix = raw.slice(0, 8)
    const name = String(body.name || '外部客户端').trim().slice(0, 80) || '外部客户端'
    const inserted = await withTx(pool, async c => {
      const row = await c.query(
        `insert into kb.mcp_tokens (user_id, name, token_prefix, token_hash, scopes, scope_folder_ids, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7) returning id, expires_at`,
        [user.id, name, prefix, hash, asked, scope, expiresAt])
      await c.query(`insert into kb.audit (actor, action, target, meta) values ($1,'mcp.token',$2,$3)`, [user.id, prefix, { folders: scope, scopes: asked }])
      return row.rows[0]
    })
    send(res, 201, {
      id: inserted.id, name, tokenPrefix: prefix, token: raw, scopes: asked,
      scopeFolderIds: scope || [], expiresAt: inserted.expires_at
    })
  }

  async function revokeToken(res, user, id) {
    if (!UUID.test(id)) throw new HttpError(400, 'bad_token_id')
    const out = await withTx(pool, async c => {
      const row = await c.query(
        `update kb.mcp_tokens set revoked_at = now()
          where id = $1 and user_id = $2 and revoked_at is null
          returning id, token_prefix`, [id, user.id])
      if (row.rows[0]) {
        await c.query(`insert into kb.audit (actor, action, target, meta) values ($1,'mcp.token.revoke',$2,$3)`, [user.id, row.rows[0].token_prefix, { id }])
        return { id, revoked: true }
      }
      const existing = await c.query('select id from kb.mcp_tokens where id = $1 and user_id = $2', [id, user.id])
      if (!existing.rows[0]) throw new HttpError(404, 'missing')
      return { id, revoked: true }
    })
    send(res, 200, out)
  }

  // Returns true when the request was handled (response sent), false when no route matched.
  return async function handle(req, res, user, pathname, method, url) {
    const p = route(req, res, user, pathname, method, url)
    if (!p) return false
    try {
      await p
    } catch (err) {
      if (err instanceof HttpError || err.status) {
        if (err.status===429 && res.setHeader) {
          const retryAfterMs = retryAfterMsFor(err.code, err.retryAfterMs)
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
          if (!res.headersSent) send(res, err.status, { error: err.message, code: err.code, retryAfterMs })
        } else if (!res.headersSent) send(res, err.status, { error: err.message, code: err.code })
      } else throw err
    }
    return true
  }
}

module.exports = { createApi, HttpError }
