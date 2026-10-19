// 批量上传：有界并发队列（纯逻辑，不依赖 Vue / axios，便于 node 测试）。
// 任何时刻进行中的任务数都不会超过 concurrency；排队项按加入顺序启动。
// 本地队列是临时的：刷新页面后不存在；后端任务（解析/结构化）不受影响，文件状态以后端为准。

export const DEFAULT_CONCURRENCY = 3
export const MAX_CONCURRENCY = 6
// 后端 services/file-kb/src/config.js：KB_MAX_FILE_BYTES 缺省 100 MiB。运行时值后端暂未暴露（见 CONTRACT.md 待后端支持）。
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
// 与后端 services/file-kb/src/limits.js#ALLOWED 的扩展名一致（后端还会校验文件头）
export const ALLOWED_EXTS = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'html', 'htm', 'md', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp']
export const PAGE_SIZE = 50

export function clampConcurrency(n) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 1) return 1
  return Math.min(MAX_CONCURRENCY, v)
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GB`
  if (v >= 1048576) return `${(v / 1048576).toFixed(v % 1048576 ? 1 : 0)} MB`
  if (v >= 1024) return `${Math.round(v / 1024)} KB`
  return `${v} B`
}

// 选择文件后在本地先做的检查；与后端规则一致，后端仍会再检查一次
export function precheckFile(file, { maxFileBytes = DEFAULT_MAX_FILE_BYTES, allowed = ALLOWED_EXTS } = {}) {
  const ext = extOf(file && file.name)
  if (!allowed.includes(ext)) return { code: 'unsupported_type', message: `不支持的文件类型${ext ? `（.${ext}）` : ''}` }
  if (!file.size) return { code: 'empty_file', message: '空文件，无法上传' }
  if (file.size > maxFileBytes) return { code: 'file_too_large', message: `超过单文件上限 ${formatBytes(maxFileBytes)}` }
  return null
}

export const UPLOAD_CODES = {
  unsupported_type: '不支持的文件类型',
  file_too_large: '超过后端单文件大小上限',
  empty_file: '空文件，无法上传',
  content_type_mismatch: '文件内容与扩展名不符，已被后端拒绝',
  too_many_files: '单次请求的文件数超过后端上限',
  batch_too_large: '请求总大小超过后端上限',
  write_failed: '后端写入失败',
  multipart_required: '上传请求格式错误',
  unsupported_media: '上传请求格式错误',
  bad_multipart: '上传请求格式错误',
  aborted: '上传中断',
  folder_required: '当前令牌只允许上传到指定文件夹，请先选择文件夹',
  batch_closed: '批次已封口或已取消，后端不再接收该批次的上传',
  batch_full: '批次已达到计划文件数',
  client_key_conflict: '该批次条目已对应另一个文件',
  batch_scope_unsupported: '限定文件夹的令牌不能使用批次上传',
  missing: '目标文件夹不存在或无权限',
  forbidden: '没有权限上传到该文件夹',
  origin_denied: '请求来源被拒绝',
  unauthorized: '登录已失效，请重新登录',
  kb_disabled: '文件知识库服务未启用'
}
// 自动重试策略（每个文件独立计算）：
// - throttle：后端 429 限流码，不计为失败；unavailable：502/503/504 等服务暂不可用；network：无响应 / 超时。
// - 指数退避 base×2^(n-1)，等量抖动（一半固定 + 一半随机），单次最长 maxDelayMs；
//   若后端给了 Retry-After（或正文 retryAfterMs），不早于它重试。
// - 每类有次数上限，另有每个文件累计等待预算 budgetMs；任一超限即停止自动重试，标为「失败·可重试」。
// 最坏情况：单个文件累计自动等待不超过 budgetMs（10 分钟）+ 最后一次请求本身耗时。
export const RETRY_POLICY = {
  budgetMs: 10 * 60 * 1000,
  maxDelayMs: 60 * 1000,
  classes: {
    throttle: { maxRetries: 20 },
    unavailable: { base: 5000, maxRetries: 5 },
    network: { base: 3000, maxRetries: 3 }
  }
}
const THROTTLE = {
  too_many_concurrent_uploads: { base: 3000, message: '同时上传数超过后端限制' },
  rate_limited: { base: 15000, message: '上传过于频繁（后端每分钟限额）' },
  queue_full: { base: 20000, message: '后端解析队列已满' }
}

export function retryDelay({ base, attempt, retryAfterMs = null, random = Math.random, maxDelayMs = RETRY_POLICY.maxDelayMs }) {
  const exp = Math.min(maxDelayMs, base * Math.pow(2, Math.max(0, attempt - 1)))
  const jittered = Math.round(exp / 2 + random() * (exp / 2))
  const floor = retryAfterMs != null && retryAfterMs > 0 ? Math.min(retryAfterMs, RETRY_POLICY.budgetMs) : 0
  return Math.max(jittered, floor)
}

// 把 kbApi 归一化后的错误（或任意错误）转成上传结果。
// ambiguous=true 表示请求可能已经被后端处理（响应丢失），重试依赖后端按内容 sha256 去重（见 CONTRACT.md）。
export function classifyUploadError(err) {
  const e = err || {}
  if (e.kind === 'canceled' || e.__CANCEL__ || e.name === 'CanceledError' || e.code === 'ERR_CANCELED') return { code: 'canceled', message: '已取消', canceled: true }
  const data = e.data || {}
  const rejected = Array.isArray(data.rejected) ? data.rejected : []
  const code = (rejected[0] && rejected[0].code) || data.code || e.code || e.kind || 'error'
  const retryAfterMs = e.retryAfterMs != null ? e.retryAfterMs : null
  if (THROTTLE[code]) return { code, message: THROTTLE[code].message, retry: { cls: 'throttle', base: THROTTLE[code].base }, retryAfterMs }
  if (e.status === 429) return { code, message: '后端限流', retry: { cls: 'throttle', base: 10000 }, retryAfterMs }
  if (e.kind === 'network') return { code: 'network', message: '网络中断或服务无响应', retry: { cls: 'network', base: RETRY_POLICY.classes.network.base }, ambiguous: true }
  if (e.kind === 'timeout') return { code: 'timeout', message: '请求超时', retry: { cls: 'network', base: RETRY_POLICY.classes.network.base }, ambiguous: true }
  if (e.kind === 'unavailable') {
    // 503：后端认证不可用或 nginx 无上游，请求未进入上传处理；502/504：网关断开，后端可能已提交
    const ambiguous = e.status === 502 || e.status === 504
    return { code: code || 'unavailable', message: e.status === 503 ? '文件知识库服务暂不可用（503）' : `网关错误（${e.status || '5xx'}），后端可能已收到文件`, retry: { cls: 'unavailable', base: RETRY_POLICY.classes.unavailable.base }, retryAfterMs, ambiguous }
  }
  if (e.kind === 'not_ready') return { code: 'not_ready', message: '上传接口暂不可用' }
  if (e.status >= 500 || e.kind === 'error') return { code, message: e.message || '服务端错误', ambiguous: true }
  return { code, message: UPLOAD_CODES[code] || e.message || '上传失败' }
}

// 解析 POST /files 的成功响应：单文件为文件对象本身（另带 files/rejected），多文件为 { files, rejected }
export function interpretUploadResponse(body) {
  const b = body || {}
  const files = Array.isArray(b.files) ? b.files : b.id ? [b] : []
  const rejected = Array.isArray(b.rejected) ? b.rejected : []
  const file = files[0] || null
  return {
    file,
    files,
    rejected,
    duplicate: !!(file && file.duplicate),
    partial: files.length > 0 && rejected.length > 0
  }
}

export const TERMINAL_PARSE = ['done', 'partial', 'failed']

// 单项展示状态。parse 状态只来自后端文件状态轮询（item.backend），不在本地伪造。
export function itemPhase(item) {
  if (item.state === 'queued') return item.retryAt ? 'retry_wait' : 'queued'
  if (item.state === 'uploading') return 'uploading'
  if (item.state === 'failed') return 'failed'
  if (item.state === 'cancelled') return 'cancelled'
  if (item.state === 'uploaded') {
    const s = item.backend && item.backend.status
    if (s === 'parsing') return 'parsing'
    if (s === 'structuring') return 'structuring'
    if (s === 'done') return 'done'
    if (s === 'partial') return 'partial'
    if (s === 'failed') return 'parse_failed'
    return 'awaiting_parse'
  }
  return item.state
}

// 「未提交」= 只在本页面的本地队列里，刷新即消失；「已上传」之后的状态都来自后端，刷新后在文件列表仍可见
export const PHASE_LABELS = {
  queued: '排队中·未提交',
  retry_wait: '等待重试·未提交',
  uploading: '上传中',
  awaiting_parse: '已上传·等待解析',
  parsing: '解析中',
  structuring: '结构化入库中',
  done: '完成',
  partial: '部分完成',
  parse_failed: '解析失败',
  failed: '失败·未提交',
  cancelled: '已取消'
}

export function fileIdentity(file, folderId = '', batchId = '') {
  const id = [file && file.name, Number(file && file.size) || 0, Number(file && file.lastModified) || 0, folderId || ''].join('|')
  return batchId ? `${id}|${batchId}` : id
}

let seq = 0

export function createUploadQueue(opts = {}) {
  const items = opts.items || []
  const run = opts.run // (item, { signal, onProgress(loaded,total) }) => Promise<result>
  const onChange = opts.onChange || (() => {})
  const onSettled = opts.onSettled || (() => {})
  const createAbort = opts.createAbort || (() => (typeof AbortController !== 'undefined' ? new AbortController() : null))
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer || (t => clearTimeout(t))
  const now = opts.now || (() => Date.now())
  const random = opts.random || Math.random
  const policy = opts.policy || RETRY_POLICY
  // 调用方可禁止某些失败项重新排队（例如所属批次已封口，后端会直接 409 batch_closed）
  const retryable = opts.retryable || (() => true)
  let concurrency = clampConcurrency(opts.concurrency == null ? DEFAULT_CONCURRENCY : opts.concurrency)
  let active = 0
  let peak = 0
  let timer = null
  let timerAt = 0
  let disposed = false
  const ctrls = new Map()

  const emit = () => { if (!disposed) onChange() }

  function resetRetry(item) {
    item.retryAt = 0
    item.retryCounts = {}
    item.waitedMs = 0
  }

  // 返回 { added, skipped, revived }：同一文件（名称+大小+修改时间+目标文件夹）在队列里只保留一项；
  // 已失败/已取消的同一文件再次选择时，直接重新排队原项。
  function add(files, extra = {}) {
    const added = []
    const skipped = []
    const revived = []
    if (disposed) return { added, skipped, revived }
    const index = new Map(items.map(i => [i.identity, i]))
    for (const file of files || []) {
      const identity = fileIdentity(file, extra.folderId, extra.batchId)
      const existing = index.get(identity)
      if (existing) {
        if ((existing.state === 'failed' || existing.state === 'cancelled') && !existing.local && retryable(existing)) {
          requeue(existing)
          revived.push(existing)
        } else skipped.push(existing)
        continue
      }
      const pre = extra.precheck ? extra.precheck(file) : null
      const item = {
        key: `u${++seq}`,
        identity,
        file,
        name: file.name,
        size: Number(file.size) || 0,
        folderId: extra.folderId || '',
        // 批次上传：同一批次内 clientKey 稳定，重试和补传都带同一个 key，后端据此幂等
        batchId: extra.batchId || '',
        clientKey: extra.batchId && extra.clientKey ? extra.clientKey(file) : '',
        state: pre ? 'failed' : 'queued',
        loaded: 0,
        code: pre ? pre.code : '',
        error: pre ? pre.message : '',
        local: !!pre, // 本地预检失败，未发送请求
        result: null,
        warning: '',
        duplicate: false,
        recovered: false,
        ambiguous: false, // 之前某次请求结果未知（可能已被后端接收）
        backend: null,
        attempts: 0,
        retryAt: 0,
        retryCounts: {},
        waitedMs: 0,
        cancelRequested: false
      }
      items.push(item)
      index.set(identity, item)
      added.push(item)
    }
    emit()
    pump()
    return { added, skipped, revived }
  }

  function reschedule() {
    if (timer) { clearTimer(timer); timer = null; timerAt = 0 }
    if (disposed) return
    const waits = items.filter(i => i.state === 'queued' && i.retryAt).map(i => i.retryAt)
    if (!waits.length) return
    timerAt = Math.min(...waits)
    timer = setTimer(() => { timer = null; timerAt = 0; pump() }, Math.max(0, timerAt - now()))
  }

  function pump() {
    if (disposed) return
    const t = now()
    for (const item of items) {
      if (active >= concurrency) break
      if (item.state !== 'queued') continue
      if (item.retryAt && item.retryAt > t) continue
      start(item)
    }
    const waits = items.filter(i => i.state === 'queued' && i.retryAt).map(i => i.retryAt)
    const next = waits.length ? Math.min(...waits) : 0
    if (next !== timerAt) reschedule()
  }

  function failed(item, c, extraNote) {
    item.state = 'failed'
    item.code = c.code
    item.retryAt = 0
    item.error = extraNote ? `${c.message}；${extraNote}` : c.message
  }

  function onError(item, err) {
    const c = classifyUploadError(err)
    if (item.cancelRequested || c.canceled) {
      item.state = 'cancelled'
      item.code = 'canceled'
      // 字节已全部发出后取消：后端可能已经保存，不能断言「未上传」
      item.error = item.loaded >= item.size && item.size > 0 ? '已取消；请求已发出，后端可能已接收，请以文件列表为准' : ''
      item.loaded = 0
      return
    }
    item.loaded = 0
    if (c.ambiguous) item.ambiguous = true
    if (!c.retry) { failed(item, c); return }
    const cls = policy.classes[c.retry.cls] || { maxRetries: 0 }
    const n = (item.retryCounts[c.retry.cls] || 0) + 1
    const delay = retryDelay({ base: c.retry.base, attempt: n, retryAfterMs: c.retryAfterMs, random, maxDelayMs: policy.maxDelayMs })
    if (n > cls.maxRetries || item.waitedMs + delay > policy.budgetMs) {
      const total = Object.values(item.retryCounts).reduce((a, b) => a + b, 0)
      failed(item, c, `自动重试已停止（已自动重试 ${total} 次，累计等待约 ${Math.max(1, Math.round(item.waitedMs / 60000))} 分钟），可手动重试`)
      return
    }
    item.retryCounts[c.retry.cls] = n
    item.waitedMs += delay
    item.state = 'queued'
    item.retryAt = now() + delay
    item.code = c.code
    item.error = `${c.message}，约 ${Math.ceil(delay / 1000)} 秒后自动重试（第 ${n}/${cls.maxRetries} 次）`
  }

  function start(item) {
    active++
    peak = Math.max(peak, active)
    item.state = 'uploading'
    item.retryAt = 0
    item.loaded = 0
    item.cancelRequested = false
    item.attempts++
    const ctrl = createAbort()
    if (ctrl) ctrls.set(item.key, ctrl)
    emit()
    let p
    try {
      p = Promise.resolve(run(item, {
        signal: ctrl ? ctrl.signal : undefined,
        onProgress(loaded, total) {
          if (item.state !== 'uploading' || disposed) return
          const cap = total || item.size
          item.loaded = Math.min(Math.max(0, Number(loaded) || 0), cap || 0)
          emit()
        }
      }))
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(res => {
      const r = interpretUploadResponse(res)
      item.result = r.file
      item.loaded = item.size
      if (!r.file) {
        failed(item, classifyUploadError({ data: res || {} }))
        return
      }
      item.state = 'uploaded'
      item.error = ''
      item.code = ''
      item.retryAt = 0
      // 之前请求结果未知、这次后端按 sha256 返回已有文件：多半就是上次已被接收的那次上传，没有重复创建
      item.recovered = r.duplicate && item.ambiguous
      item.duplicate = r.duplicate && !item.recovered
      item.backend = { status: r.file.status, statusDetail: r.file.statusDetail, error: r.file.error, parseVersion: r.file.parseVersion }
      if (r.partial) item.warning = `部分文件被拒绝：${r.rejected.map(x => `${x.name}（${UPLOAD_CODES[x.code] || x.code}）`).join('；')}`
    }, err => onError(item, err)).then(() => {
      active--
      ctrls.delete(item.key)
      item.cancelRequested = false
      if (disposed) return
      emit()
      onSettled(item)
      pump()
    })
  }

  function cancel(key) {
    const item = items.find(i => i.key === key)
    if (!item) return false
    if (item.state === 'queued') {
      item.state = 'cancelled'
      item.retryAt = 0
      item.error = ''
      reschedule()
      emit()
      return true
    }
    if (item.state === 'uploading') {
      item.cancelRequested = true
      const c = ctrls.get(key)
      if (c) c.abort()
      return true
    }
    return false
  }

  // filter 可只取消某个批次的条目（例如该批次已在后端取消）
  function cancelAll(filter) {
    items.forEach(i => {
      if (filter && !filter(i)) return
      if (i.state === 'queued') { i.state = 'cancelled'; i.retryAt = 0; i.error = '' }
      else if (i.state === 'uploading') cancel(i.key)
    })
    reschedule()
    emit()
  }

  function requeue(item) {
    item.state = 'queued'
    item.error = ''
    item.code = ''
    item.loaded = 0
    resetRetry(item)
  }

  function retry(key) {
    const item = items.find(i => i.key === key)
    if (!item || (item.state !== 'failed' && item.state !== 'cancelled')) return false
    if (item.local) return false // 本地预检不通过的文件重试也不会成功
    if (!retryable(item)) return false
    requeue(item)
    emit()
    pump()
    return true
  }

  function retryFailed() {
    let n = 0
    items.forEach(i => {
      if (i.state === 'failed' && !i.local && retryable(i)) { requeue(i); n++ }
    })
    emit()
    pump()
    return n
  }

  function clearFinished() {
    for (let i = items.length - 1; i >= 0; i--) {
      const s = items[i].state
      if (s === 'uploaded' || s === 'cancelled') items.splice(i, 1)
    }
    emit()
  }

  function setConcurrency(n) {
    concurrency = clampConcurrency(n)
    pump()
    return concurrency
  }

  // 组件销毁：停止计时器、取消排队项、中止进行中的请求；之后不再回调 onChange / onSettled
  function dispose() {
    if (disposed) return
    items.forEach(i => {
      if (i.state === 'queued') { i.state = 'cancelled'; i.retryAt = 0 }
      if (i.state === 'uploading') { i.cancelRequested = true; const c = ctrls.get(i.key); if (c) c.abort() }
    })
    disposed = true
    if (timer) clearTimer(timer)
    timer = null
    timerAt = 0
  }

  return {
    items,
    add,
    cancel,
    cancelAll,
    retry,
    retryFailed,
    clearFinished,
    setConcurrency,
    dispose,
    pump,
    get concurrency() { return concurrency },
    get active() { return active },
    get peak() { return peak },
    get hasTimer() { return !!timer },
    get disposed() { return disposed }
  }
}

// 汇总：总进度按字节加权；分母只算「仍要上传或已上传」的文件（排队/上传中/已上传），失败与取消单列。
export function summarize(items) {
  const s = { total: items.length, success: 0, failed: 0, uploading: 0, queued: 0, cancelled: 0, duplicate: 0, recovered: 0, parsed: 0, parsing: 0, parseFailed: 0, totalBytes: 0, loadedBytes: 0, percent: 0 }
  for (const i of items) {
    if (i.state === 'uploaded') {
      s.success++
      if (i.duplicate) s.duplicate++
      if (i.recovered) s.recovered++
      const st = i.backend && i.backend.status
      if (st === 'done' || st === 'partial') s.parsed++
      else if (st === 'failed') s.parseFailed++
      else s.parsing++
      s.totalBytes += i.size
      s.loadedBytes += i.size
    } else if (i.state === 'uploading') {
      s.uploading++
      s.totalBytes += i.size
      s.loadedBytes += Math.min(i.loaded, i.size)
    } else if (i.state === 'queued') {
      s.queued++
      s.totalBytes += i.size
    } else if (i.state === 'failed') s.failed++
    else if (i.state === 'cancelled') s.cancelled++
  }
  s.percent = s.totalBytes ? Math.floor((s.loadedBytes / s.totalBytes) * 1000) / 10 : (s.success ? 100 : 0)
  return s
}

export const FILTERS = {
  all: () => true,
  active: i => i.state === 'queued' || i.state === 'uploading',
  failed: i => i.state === 'failed',
  uploaded: i => i.state === 'uploaded'
}

export function pageOf(items, { page = 1, pageSize = PAGE_SIZE, filter = 'all' } = {}) {
  const list = items.filter(FILTERS[filter] || FILTERS.all)
  const pages = Math.max(1, Math.ceil(list.length / pageSize))
  const p = Math.min(Math.max(1, page), pages)
  return { rows: list.slice((p - 1) * pageSize, p * pageSize), total: list.length, page: p, pages }
}

// 轮询分片：后端 GET /files?ids= 一次最多 50 个；先查当前可见页，再轮转一片其余进行中的项
export function pollIds(items, visibleKeys, cursor = 0, chunk = 50) {
  const activeItem = i => i.state === 'uploaded' && i.result && i.result.id && !TERMINAL_PARSE.includes(i.backend && i.backend.status)
  const visible = new Set(visibleKeys || [])
  const first = items.filter(i => visible.has(i.key) && activeItem(i)).map(i => i.result.id)
  const rest = items.filter(i => !visible.has(i.key) && activeItem(i)).map(i => i.result.id)
  const unique = arr => [...new Set(arr)]
  const a = unique(first).slice(0, chunk)
  const r = unique(rest).filter(id => !a.includes(id))
  const start = r.length ? cursor % r.length : 0
  const b = r.slice(start, start + chunk)
  return { batches: [a, b].filter(x => x.length), nextCursor: r.length ? (start + chunk) % Math.max(r.length, 1) : 0 }
}
