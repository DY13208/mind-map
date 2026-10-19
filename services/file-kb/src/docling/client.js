'use strict'
// docling-serve client (async API, verified against pinned v1.37.0):
//   POST /v1/convert/file/async  (multipart: files + options)  -> { task_id, task_status }
//   GET  /v1/status/poll/{task_id}?wait=<s>                   -> { task_status: pending|started|success|failure }
//   GET  /v1/result/{task_id}                                  -> { document: { json_content }, status, errors }
const fs = require('fs')
const path = require('path')
const { createBreaker, BreakerOpenError } = require('./breaker')
const { OCR_EXTS, scanStats, scanKind } = require('./ocr')

class DoclingUnavailableError extends Error {
  constructor(message, cause) { super(message); this.code = 'DOCLING_UNAVAILABLE'; this.cause = cause }
}
class DoclingDocumentError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.code = 'DOCLING_DOCUMENT_ERROR'; this.retryable = retryable }
}

const FROM_FORMAT = {
  pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xls: 'xls', csv: 'csv', html: 'html', htm: 'html', md: 'md',
  png: 'image', jpg: 'image', jpeg: 'image', tif: 'image', tiff: 'image', bmp: 'image', webp: 'image'
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')) }, { once: true })
  })
}

function createDoclingClient({
  baseUrl, apiKey = '', fetchImpl = globalThis.fetch, breaker = createBreaker(),
  submitTimeoutMs = 60000, requestTimeoutMs = 30000, totalTimeoutMs = 30 * 60000, pollWaitS = 5,
  doOcr = false, documentTimeoutS = 600,
  // OCR: 'off' | 'always' | 'auto' (first pass without OCR; re-run with OCR only when the result looks scanned).
  // Unset keeps the legacy doOcr behaviour. ocrEngine is sent as docling-serve ocr_preset.
  ocrMode = null, ocrEngine = 'rapidocr', ocrLang = [], ocrForce = true,
  ocrDocumentTimeoutS = 1800, ocrTotalTimeoutMs = 60 * 60000,
  ocrMinCharsPerPage = 20, ocrTextlessPageRatio = 0.6, ocrMixedMinPages = 1, log = console.log
} = {}) {
  const mode = ocrMode || (doOcr ? 'always' : 'off')
  const PLAIN = { ocr: false, force: false, documentTimeoutS, totalTimeoutMs }
  const ALWAYS = { ocr: true, force: false, documentTimeoutS: ocrDocumentTimeoutS, totalTimeoutMs: ocrTotalTimeoutMs }
  // Fallback passes: 'full' (scan) may force OCR over every page; 'mixed' never forces, so docling keeps the
  // programmatic text of text pages and OCRs only bitmap regions (verified on docling-serve 1.37.0).
  const FALLBACK = {
    full: { ocr: true, force: ocrForce, documentTimeoutS: ocrDocumentTimeoutS, totalTimeoutMs: ocrTotalTimeoutMs },
    mixed: { ocr: true, force: false, documentTimeoutS: ocrDocumentTimeoutS, totalTimeoutMs: ocrTotalTimeoutMs }
  }
  async function call(url, init = {}, timeoutMs = requestTimeoutMs, outerSignal) {
    if (!baseUrl) throw new DoclingUnavailableError('DOCLING_URL not configured')
    breaker.before()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => ctrl.abort(outerSignal.reason)
    if (outerSignal) outerSignal.addEventListener('abort', onAbort, { once: true })
    let res
    try {
      res = await fetchImpl(baseUrl + url, { ...init, headers: { ...(init.headers || {}), ...(apiKey ? { 'X-Api-Key': apiKey } : {}) }, signal: ctrl.signal })
    } catch (err) {
      if (outerSignal && outerSignal.aborted) throw outerSignal.reason || err
      breaker.failure()
      throw new DoclingUnavailableError(`docling request failed: ${err.message}`, err)
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort)
    }
    if (res.status >= 500 || res.status === 429) {
      breaker.failure()
      throw new DoclingUnavailableError(`docling HTTP ${res.status}`)
    }
    breaker.success()
    return res
  }

  async function submit(filePath, fileName, ext, signal, pass = mode === 'always' ? ALWAYS : PLAIN) {
    const form = new FormData()
    const blob = await fs.openAsBlob(filePath)
    form.append('files', blob, path.basename(fileName))
    form.append('to_formats', 'json')
    if (FROM_FORMAT[ext]) form.append('from_formats', FROM_FORMAT[ext])
    form.append('do_ocr', pass.ocr ? 'true' : 'false')
    if (pass.ocr) {
      if (ocrEngine) form.append('ocr_preset', ocrEngine)
      for (const l of ocrLang || []) form.append('ocr_lang', l)
      if (pass.force) form.append('force_ocr', 'true')
    }
    form.append('image_export_mode', 'placeholder')
    form.append('include_images', 'false')
    form.append('abort_on_error', 'false')
    form.append('document_timeout', String(pass.documentTimeoutS))
    const res = await call('/v1/convert/file/async', { method: 'POST', body: form }, submitTimeoutMs, signal)
    if (!res.ok) throw new DoclingDocumentError(`docling submit HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.json()
    if (!body.task_id) throw new DoclingDocumentError('docling submit returned no task_id')
    return body.task_id
  }

  async function poll(taskId, signal) {
    const res = await call(`/v1/status/poll/${encodeURIComponent(taskId)}?wait=${pollWaitS}`, {}, (pollWaitS + 30) * 1000, signal)
    if (res.status === 404) return { task_status: 'lost' }
    if (!res.ok) throw new DoclingDocumentError(`docling poll HTTP ${res.status}`, { retryable: true })
    return res.json()
  }

  async function result(taskId, signal) {
    const res = await call(`/v1/result/${encodeURIComponent(taskId)}`, {}, 120000, signal)
    if (res.status === 404) return null
    if (!res.ok) throw new DoclingDocumentError(`docling result HTTP ${res.status}`, { retryable: true })
    return res.json()
  }

  // One async conversion pass. existingTaskId lets a retried job resume an in-flight task.
  async function runPass(pass, { filePath, fileName, ext, existingTaskId = null, onTaskId = async () => {}, signal }) {
    const deadline = Date.now() + pass.totalTimeoutMs
    let taskId = existingTaskId
    if (!taskId) { taskId = await submit(filePath, fileName, ext, signal, pass); await onTaskId(taskId) }
    for (;;) {
      if (Date.now() > deadline) throw new DoclingDocumentError(`docling task ${taskId} exceeded ${pass.totalTimeoutMs}ms`, { retryable: true })
      const st = await poll(taskId, signal)
      if (st.task_status === 'lost') { // docling restarted and forgot the task: resubmit once
        taskId = await submit(filePath, fileName, ext, signal, pass); await onTaskId(taskId); continue
      }
      if (st.task_status === 'success') break
      if (st.task_status === 'failure') {
        const r = await result(taskId, signal).catch(() => null)
        const errs = r && r.errors ? JSON.stringify(r.errors).slice(0, 500) : ''
        throw new DoclingDocumentError(`docling task failed ${errs}`, { retryable: false })
      }
      await sleep(500, signal)
    }
    const r = await result(taskId, signal)
    if (!r) throw new DoclingDocumentError('docling result missing', { retryable: true })
    const doc = r.document || {}
    if (!doc.json_content) throw new DoclingDocumentError(`docling returned no json_content (status ${r.status})`, { retryable: false })
    return { taskId, status: r.status, errors: r.errors || [], json: doc.json_content, processingTime: r.processing_time }
  }

  // Full conversion. In auto mode a PDF/image whose first pass looks scanned ('full') or has textless
  // pages among text pages ('mixed') is converted again with OCR. `ocr` carries counts and page numbers
  // only (never content) for parse_runs.stats; ocr.fallback is false | 'full' | 'mixed'.
  async function convertFile(args) {
    const first = await runPass(mode === 'always' ? ALWAYS : PLAIN, args)
    if (mode !== 'auto' || !OCR_EXTS.has(args.ext)) return { ...first, ocr: { mode, fallback: false } }
    const before = scanStats(first.json)
    const kind = scanKind(before, { minCharsPerPage: ocrMinCharsPerPage, textlessPageRatio: ocrTextlessPageRatio, mixedMinPages: ocrMixedMinPages })
    if (!kind) return { ...first, ocr: { mode, fallback: false } }
    const pass = FALLBACK[kind]
    const summary = { mode, fallback: kind, engine: ocrEngine || 'auto', force: pass.force, firstPass: before }
    log(`[file-kb-worker] docling OCR fallback=${kind} start ext=${args.ext} pages=${before.pages} chars=${before.chars} textless=${before.textlessPages}`)
    const t0 = Date.now()
    let second
    try {
      second = await runPass(pass, { ...args, existingTaskId: null })
    } catch (err) {
      if (!(err instanceof DoclingDocumentError)) throw err // unavailable / breaker / abort: let the job defer or retry
      log(`[file-kb-worker] docling OCR fallback failed after ${Date.now() - t0}ms; keeping first pass: ${err.message}`)
      return { ...first, ocr: { ...summary, ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 300) } }
    }
    const after = scanStats(second.json)
    log(`[file-kb-worker] docling OCR fallback=${kind} done ms=${Date.now() - t0} pages=${after.pages} chars=${after.chars} textless=${after.textlessPages}`)
    return { ...second, ocr: { ...summary, ok: true, ms: Date.now() - t0, ocrPass: after, firstPassProcessingTime: first.processingTime } }
  }

  async function health(timeoutMs = 2000) {
    if (!baseUrl) return { status: 'not_configured' }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(baseUrl + '/health', { signal: ctrl.signal })
      return { status: r.ok ? 'ok' : 'error', httpStatus: r.status, breaker: breaker.state() }
    } catch (_) {
      return { status: 'unreachable', breaker: breaker.state() }
    } finally { clearTimeout(t) }
  }

  return { convertFile, submit, poll, result, health, breaker }
}

module.exports = { createDoclingClient, DoclingUnavailableError, DoclingDocumentError, BreakerOpenError, FROM_FORMAT }
