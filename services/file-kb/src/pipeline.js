'use strict'
// Job handlers: parse (docling) -> structure (blocks/fields/records). Idempotent per run_id.
const path = require('path')
const { EXCEL } = require('./limits')
const { docToBlocks } = require('./structurer/blocks')
const { structureExcel } = require('./structurer/excel')
const { DoclingUnavailableError, BreakerOpenError } = require('./docling/client')
const { LeaseLostError } = require('./queue')
const { instrumentPool, measured, scope } = require('./metrics')
const { parseTextFile } = require('./text')
const fs = require('fs')
const { withPreparedInput, IMAGE_EXTS } = require('./prepare')

const BATCH = 1000

async function loadContext(pool, job) {
  const r = await pool.query(
    `select f.*, r.id as run_id_, r.docling_task_id, r.raw_json_key, r.docling_status, r.status as run_status,
            r.options as run_options
     from kb.files f left join kb.parse_runs r on r.id = $2 where f.id = $1`, [job.file_id, job.run_id])
  return r.rows[0] || null
}

async function insertBatch(client, table, cols, rows) {
  if (!rows.length) return
  const params = []
  const tuples = rows.map(row => `(${cols.map(c => { params.push(row[c]); return `$${params.length}` }).join(',')})`)
  await client.query(`insert into kb.${table} (${cols.join(',')}) values ${tuples.join(',')}`, params)
}

function createPipeline({ pool, queue, storage, docling, nativeLightParse = false, nativeLightMaxBytes = 2*1024*1024, log = console.log }) {
  instrumentPool(pool)
  async function finalizeFailed(c, job, file, message) {
    await c.query(`update kb.parse_runs set status = 'failed', error = $2, finished_at = now() where id = $1`, [job.run_id, message.slice(0, 2000)])
    await c.query("update kb.batch_items set state='failed',error=$2,updated_at=now() where run_id=$1 and state<>'cancelled'",[job.run_id,message.slice(0,2000)])
    // Only the latest run may change the file's visible status.
    await c.query(
      `update kb.files set status = case when current_run_id is not null then 'partial' else 'failed' end,
         error = $2, status_detail = $3, updated_at = now()
       where id = $1 and (select id from kb.parse_runs where file_id = $1 order by created_at desc limit 1) = $4`,
      [file.id, message.slice(0, 2000), `${job.kind} failed`, job.run_id])
  }

  async function runParse(job, file, signal) {
    await queue.withFence(job, c => Promise.all([
      c.query(`update kb.files set status = 'parsing', status_detail = null, updated_at = now() where id = $1`, [file.id]),
      c.query(`update kb.parse_runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1`, [job.run_id])
    ]))
    const filePath = storage.resolveKey(file.storage_key)
    // TXT is always parsed locally: Docling has no plain-text input format and no OCR/layout work is needed.
    const native = file.ext === 'txt' || file.ext === 'xls' || (nativeLightParse && ['xlsx','md'].includes(file.ext) && Number(file.size)<=nativeLightMaxBytes)
    const out = native ? {
      json: { nativeBlocks: file.ext === 'txt' ? await parseTextFile(filePath) : file.ext === 'md' ? [{seq:0,type:'paragraph',text:await fs.promises.readFile(filePath,'utf8'),page:null,bbox:null,heading_path:[],table:null}] : [] },
      status:'native_success',errors:[],processingTime:0
    } : await withPreparedInput({
      filePath, fileName: file.name, ext: file.ext,
      existingTaskId: file.docling_task_id,
      onTaskId: id => queue.withFence(job, c => c.query(`update kb.parse_runs set docling_task_id = $2 where id = $1`, [job.run_id, id])),
      signal
    }, async prepared => ({ ...await docling.convertFile(prepared), preprocessing: prepared.preprocessing }))
    const rawKey = await storage.writeRaw(job.run_id, out.json)
    let cancelled=false
    await queue.withFence(job, async c => {
      await c.query(`update kb.parse_runs set raw_json_key = $2, docling_status = $3, stats = stats || $4 where id = $1`,
        [job.run_id, rawKey, out.status, { parser: native ? (EXCEL.has(file.ext) ? 'exceljs' : file.ext === 'txt' ? 'native-text' : 'native-markdown') : 'docling', doclingErrors: out.errors.length, processingTime: out.processingTime, ...(out.preprocessing ? { preprocessing: out.preprocessing } : {}), ...(out.ocr ? { ocr: out.ocr } : {}) }])
      await queue.complete(c, job)
      const batch=job.batch_id?(await c.query('select control from kb.batches where id=$1 for update',[job.batch_id])).rows[0]:null
      if(batch?.control==='cancelled'){
        cancelled=true
        await c.query("update kb.parse_runs set status='failed',error='cancelled_after_parse',finished_at=now() where id=$1",[job.run_id])
        await c.query("update kb.files set status=case when current_run_id is null then 'failed' else 'partial' end,error='cancelled_after_parse',status_detail='cancelled before structure',updated_at=now() where id=$1",[file.id])
        await c.query("update kb.batch_items set state='cancelled',error='cancelled_after_parse',updated_at=now() where run_id=$1 and state in('waiting','processing')",[job.run_id])
      }else await queue.enqueue(c, { fileId: file.id, runId: job.run_id, kind: 'structure' })
    })
    log(`[file-kb-worker] parse done file=${file.id} run=${job.run_id} docling=${out.status}`)
    return cancelled?'cancelled':'parsed'
  }

  async function runStructure(job, file, signal) {
    await queue.withFence(job, async c => {
      await c.query(`update kb.files set status = 'structuring', updated_at = now() where id = $1`, [file.id])
      // idempotent: wipe anything a previous (crashed) attempt wrote for this run
      await c.query('delete from kb.blocks where run_id = $1', [job.run_id])
      await c.query('delete from kb.records where run_id = $1', [job.run_id])
      await c.query('delete from kb.fields where run_id = $1', [job.run_id])
    })
    const stats = { blocks: 0, records: 0, fields: 0, sheets: 0 }
    let partialReasons = []
    if (file.raw_json_key) {
      const doc = await storage.readRaw(file.raw_json_key)
      const blocks = Array.isArray(doc.nativeBlocks) ? doc.nativeBlocks : docToBlocks(doc)
      for (let i = 0; i < blocks.length; i += BATCH) {
        const rows = blocks.slice(i, i + BATCH).map(b => ({
          run_id: job.run_id, file_id: file.id, seq: b.seq, type: b.type, text: b.text, page: b.page, sheet: null,
          bbox: b.bbox ? JSON.stringify(b.bbox) : null, heading_path: b.heading_path, data: b.table ? JSON.stringify(b.table) : null
        }))
        await queue.withFence(job, c => insertBatch(c, 'blocks', ['run_id', 'file_id', 'seq', 'type', 'text', 'page', 'sheet', 'bbox', 'heading_path', 'data'], rows))
      }
      stats.blocks = blocks.length
      if (file.docling_status && !['success','native_success'].includes(file.docling_status)) partialReasons.push(`docling ${file.docling_status}`)
    } else {
      partialReasons.push('no docling output')
    }
    if (EXCEL.has(file.ext)) {
      try {
        const userStructure = file.run_options && file.run_options.structure
        const res = await structureExcel(storage.resolveKey(file.storage_key), {
          signal,
          batchSize: BATCH,
          layout: userStructure || null,
          onBatch: batch => queue.withFence(job, c => insertBatch(c, 'records',
            ['run_id', 'file_id', 'sheet', 'table_index', 'cell_range', 'row_index', 'data', 'sku', 'price', 'stock', 'record_date'],
            batch.map(r => ({ ...r, run_id: job.run_id, file_id: file.id, data: JSON.stringify(r.data) }))))
        })
        if (res.preprocessing) stats.preprocessing = res.preprocessing
        const fields = res.sheets.flatMap(s => s.fields.map(f => ({
          header_row: null, confidence: null, confirmed: false, table_index: 0,
          ...f, run_id: job.run_id, file_id: file.id
        })))
        for (let i = 0; i < fields.length; i += BATCH) {
          await queue.withFence(job, c => insertBatch(c, 'fields',
            ['run_id', 'file_id', 'sheet', 'col_index', 'name', 'inferred_type', 'header_row', 'confidence', 'confirmed', 'table_index'],
            fields.slice(i, i + BATCH)))
        }
        if (res.notes && res.notes.length) {
          const noteRows = res.notes.map((n, i) => ({
            run_id: job.run_id, file_id: file.id, seq: stats.blocks + i + 1, type: 'paragraph', text: n.text,
            page: null, sheet: n.sheet, bbox: null, heading_path: null,
            data: JSON.stringify({ role: 'note', row: n.row })
          }))
          await queue.withFence(job, c => insertBatch(c, 'blocks',
            ['run_id', 'file_id', 'seq', 'type', 'text', 'page', 'sheet', 'bbox', 'heading_path', 'data'], noteRows))
          stats.blocks += res.notes.length
        }
        await queue.withFence(job, async c => {
          for (const [tmp, real] of Object.entries(res.nameMap)) {
            await c.query('update kb.records set sheet = $3 where run_id = $1 and sheet = $2', [job.run_id, tmp, real])
          }
          // docling maps worksheet N to page N: label xlsx blocks with the real sheet name
          const ordered = Object.entries(res.nameMap).sort((x, y) => Number(x[0].slice(1)) - Number(y[0].slice(1))).map(x => x[1])
          await c.query('update kb.blocks set sheet = ($2::text[])[page] where run_id = $1 and page is not null', [job.run_id, ordered])
        })
        stats.records = res.totalRows; stats.fields = fields.length; stats.sheets = res.sheets.length
        stats.needsConfirmation = res.needsConfirmation === true
        stats.layout = {
          needsConfirmation: stats.needsConfirmation,
          sheets: res.sheets.map(s => ({
            sheet: s.sheet,
            regions: s.regions.map(r => ({
              headerRows: r.headerRows, dataStartRow: r.dataStartRow, dataEndRow: r.dataEndRow,
              confidence: r.confidence, needsConfirmation: r.needsConfirmation, confirmed: r.confirmed === true,
              headers: r.headers
            }))
          }))
        }
        stats.special = Object.fromEntries(res.sheets.map(s => [s.sheet, Object.fromEntries(Object.entries(s.special || {}).map(([k, i]) => [k, (s.fields.find(f => f.table_index === 0 && f.col_index === i) || s.fields[i] || {}).name]))]))
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        throw err // Staged rows are retried idempotently; never publish an incomplete Excel run.
      }
    }
    const empty = !stats.blocks && !stats.records
    if (empty) partialReasons.push(IMAGE_EXTS.has(file.ext) ? '已执行 OCR，但未识别到文字' : EXCEL.has(file.ext) ? '表格未读取到可入库内容' : '未解析到可入库内容')
    const hold = stats.needsConfirmation === true && !empty
    const status = empty ? 'failed' : (partialReasons.length || hold) ? 'partial' : 'done'
    await queue.withFence(job, async c => {
      const latest = await c.query(`select id from kb.parse_runs where file_id = $1 order by created_at desc limit 1`, [file.id])
      const isLatest = latest.rows[0] && latest.rows[0].id === job.run_id
      await c.query(`update kb.parse_runs set status = $2, stats = stats || $3, finished_at = now(), error = $4 where id = $1`,
        [job.run_id, isLatest ? (status === 'failed' ? 'failed' : status) : 'superseded', stats, partialReasons.join('; ') || null])
      if (isLatest) {
        const detail = hold ? `待确认表头 blocks=${stats.blocks}` : `blocks=${stats.blocks} records=${stats.records}`
        await c.query(
          `update kb.files set status = $2, status_detail = $3, error = $4, updated_at = now(),
             current_run_id = case when $2 = 'failed' or $6 then current_run_id else $5::uuid end,
             parse_version = parse_version + case when $2 = 'failed' or $6 or current_run_id=$5 then 0 else 1 end
           where id = $1`, [file.id, status, detail, partialReasons.join('; ') || null, job.run_id, hold])
        if (!hold && status !== 'failed') {
          await c.query(`update kb.parse_runs set status = 'superseded' where file_id = $1 and id <> $2 and status in ('done','partial')`, [file.id, job.run_id])
        }
      }
      await c.query(`update kb.batch_items i set state=r.status,error=r.error,updated_at=now()
        from kb.parse_runs r where i.run_id=r.id and r.id=$1 and r.status in('done','partial','failed') and i.state<>'cancelled'`,[job.run_id])
      await queue.complete(c, job)
    })
    log(`[file-kb-worker] structure ${status} file=${file.id} run=${job.run_id} blocks=${stats.blocks} records=${stats.records}`)
    return status
  }

  // Executes one claimed job. Never throws for job-level errors.
  async function process(job, { signal } = {}) {
    let file
    try {
      file = await loadContext(pool, job)
      if (!file || file.deleted_at) { await queue.withFence(job, c => queue.complete(c, job)); return 'skipped' }
      if (job.attempts > job.max_attempts) {
        await queue.withFence(job, async c => {
          await c.query(`update kb.jobs set state = 'failed', last_error = 'lease expired too many times', lease_token = null, locked_until = null where id = $1`, [job.id])
          await finalizeFailed(c, job, file, 'lease expired too many times (worker crash loop?)')
        })
        return 'failed'
      }
      if (job.kind === 'parse') return await runParse(job, file, signal)
      if (job.kind === 'structure') return await runStructure(job, file, signal)
      throw Object.assign(new Error(`unknown job kind ${job.kind}`), { retryable: false })
    } catch (err) {
      if(scope.getStore())scope.getStore().failureReason=String(err.message).slice(0,2000)
      if (err instanceof LeaseLostError || (signal && signal.aborted)) { log(`[file-kb-worker] job ${job.id} lease lost; abandoning`); return 'lease_lost' }
      try {
        if(job.batch_id){
          let cancelled=false
          await queue.withFence(job,async c=>{
            const b=(await c.query('select control from kb.batches where id=$1 for update',[job.batch_id])).rows[0]
            if(b?.control!=='cancelled')return
            cancelled=true
            await c.query("update kb.jobs set state='cancelled',locked_by=null,locked_until=null,lease_token=null,last_error=$2,updated_at=now() where id=$1",[job.id,String(err.message).slice(0,2000)])
            await c.query("update kb.parse_runs set status='failed',error='cancelled_after_failure',finished_at=now() where id=$1",[job.run_id])
            await c.query("update kb.files set status=case when current_run_id is null then 'failed' else 'partial' end,error='cancelled_after_failure',updated_at=now() where id=$1",[job.file_id])
            await c.query("update kb.batch_items set state='cancelled',error='cancelled_after_failure',updated_at=now() where run_id=$1 and state in('waiting','processing')",[job.run_id])
          })
          if(cancelled)return 'cancelled'
        }
        if (err instanceof BreakerOpenError || err instanceof DoclingUnavailableError) {
          const delay = Math.max(err.retryInMs || 0, 15000)
          await queue.withFence(job, async c => {
            await queue.defer(c, job, delay, err.message)
            await c.query(`update kb.files set status_detail = $2, updated_at = now() where id = $1`, [job.file_id, 'waiting for docling'])
          })
          log(`[file-kb-worker] job ${job.id} deferred ${delay}ms: ${err.message}`)
          return 'deferred'
        }
        let final
        await queue.withFence(job, async c => {
          final = (await queue.retry(c, job, err)).final
          if (final && file) {
            if (job.kind === 'parse' && EXCEL.has(file.ext)) {
              // Excel can still be structured without docling output => partial
              await c.query(`update kb.parse_runs set error = $2 where id = $1`, [job.run_id, String(err.message).slice(0, 2000)])
              await queue.enqueue(c, { fileId: file.id, runId: job.run_id, kind: 'structure' })
            } else {
              await finalizeFailed(c, job, file, String(err.message))
            }
          }
        })
        log(`[file-kb-worker] job ${job.id} ${final ? 'failed permanently' : 'will retry'}: ${err.message}`)
        return final ? 'failed' : 'retry'
      } catch (inner) {
        if (inner instanceof LeaseLostError) return 'lease_lost'
        throw inner
      }
    }
  }

  async function trackedProcess(job,opts) {
    const {outcome,metrics,error}=await measured(job,()=>process(job,opts))
    await pool.query(`update kb.job_attempts set finished_at=now(),outcome=$2,metrics=$3,
      error=$4 where lease_token=$1`,[job.lease_token,outcome,metrics,metrics.failureReason||null])
    await pool.query(`update kb.jobs set metrics=$2 where id=$1 and (lease_token=$3 or
      (lease_token is null and not exists(select 1 from kb.job_attempts a where a.job_id=$1 and a.id>(select id from kb.job_attempts where lease_token=$3))))`,[job.id,metrics,job.lease_token])
    if(['done','partial','failed'].includes(outcome)) await pool.query(`update kb.batch_items i set state=r.status,error=r.error,updated_at=now()
      from kb.parse_runs r where i.run_id=r.id and r.id=$1 and r.status in('done','partial','failed') and i.state<>'cancelled'`,[job.run_id])
    if(error)throw error
    return outcome
  }
  return { process: trackedProcess }
}

module.exports = { createPipeline }
