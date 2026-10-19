import { UPLOAD_CODES } from './uploadQueue'

// 批次任务（后端 services/file-kb/src/batches.js、docs/file-kb/BATCH_API_V2.md）的纯逻辑：
// 状态文案、可用操作、条目归一化、上传计划与封口判断。不依赖 Vue / axios，便于 node 测试。
// 状态与计数一律来自后端；这里只做展示与判断，不推导或伪造进度。

export const MAX_BATCH_SIZE = 1000 // kb.batches.expected_count 1..1000
export const BATCH_TERMINAL = ['done', 'partial', 'failed', 'cancelled']
export const ITEM_TERMINAL = ['done', 'partial', 'failed', 'cancelled']

// 后端 deriveBatchState：未封口 accepting；封口后 running；control=paused 为 paused；control=cancelled 未收尾为 cancelling
export const BATCH_STATE = {
  accepting: { label: '接收中·未封口', tone: 'active' },
  running: { label: '后台处理中', tone: 'active' },
  paused: { label: '已暂停', tone: 'warn' },
  cancelling: { label: '取消中', tone: 'warn' },
  done: { label: '全部完成', tone: 'ok' },
  partial: { label: '部分完成', tone: 'warn' },
  failed: { label: '全部失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'muted' }
}

// kb.batch_items.state
export const ITEM_STATE = {
  waiting: { label: '等待处理', tone: 'muted' },
  processing: { label: '解析中', tone: 'active' },
  done: { label: '完成', tone: 'ok' },
  partial: { label: '部分完成', tone: 'warn' },
  failed: { label: '解析失败', tone: 'bad' },
  upload_failed: { label: '上传失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'muted' }
}

// 后端写入 batch_items.error 的固定原因码（batches.js / pipeline.js），其余为解析错误原文
export const ITEM_ERRORS = {
  cancelled_before_start: '批次取消时尚未开始处理',
  cancelled_after_parse: '批次已取消：原始解析已完成，不再结构化入库',
  cancelled_after_failure: '批次已取消：失败后不再重试'
}

export function isBatchTerminal(status) {
  return !!status && BATCH_TERMINAL.includes(status.state)
}

export function batchStateLabel(state) {
  return (BATCH_STATE[state] && BATCH_STATE[state].label) || state || '未知'
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

// 两条进度分开：接收（上传阶段，received/total）与后台处理（completed/total，completed 含失败与取消）
export function batchProgress(s) {
  const total = num(s && s.total)
  const pct = n => (total ? Math.floor((n / total) * 1000) / 10 : 0)
  const received = num(s && s.received)
  const completed = num(s && s.completed)
  return {
    total,
    received,
    notUploaded: num(s && s.notUploaded),
    completed,
    receivedPct: pct(received),
    completedPct: pct(completed),
    donePct: pct(num(s && s.done)),
    inFlight: num(s && s.waiting) + num(s && s.processing)
  }
}

// 可用操作只按后端返回的 state / control / sealed / 计数判断，与 batches.js#control 的拒绝条件一致
export function batchActions(s) {
  if (!s) return { seal: false, pause: false, resume: false, cancel: false, retry: false, supplement: false }
  const cancelled = s.control === 'cancelled'
  const terminal = isBatchTerminal(s)
  return {
    seal: !s.sealed && !cancelled,
    pause: !cancelled && s.control === 'running' && !terminal,
    resume: !cancelled && s.control === 'paused',
    cancel: !cancelled && !terminal,
    // 后端 retry 只处理有解析任务的失败项；上传失败的条目会被跳过
    retry: !cancelled && num(s.failed) > 0,
    // 后端 upload：批次已封口或已取消时直接 409 batch_closed，所以只能在封口前补传
    supplement: !s.sealed && !cancelled && num(s.received) < num(s.total)
  }
}

// GET /batches/:id/items 返回 kb.batch_items 原始行（snake_case）
export function itemView(row) {
  const r = row || {}
  const fileId = r.file_id || r.fileId || null
  const uploadFailed = r.state === 'failed' && !fileId
  const kind = uploadFailed ? 'upload_failed' : r.state
  const meta = ITEM_STATE[kind] || { label: r.state || '未知', tone: 'muted' }
  const err = r.error == null ? '' : String(r.error)
  return {
    id: r.id,
    clientKey: r.client_key || r.clientKey || '',
    fileId,
    runId: r.run_id || r.runId || null,
    name: r.name || '',
    duplicate: !!r.duplicate,
    state: r.state,
    kind,
    label: meta.label,
    tone: meta.tone,
    // 上传被拒的条目 error 是上传错误码（如 content_type_mismatch），解析失败是原文
    error: ITEM_ERRORS[err] || (uploadFailed && UPLOAD_CODES[err]) || err,
    uploadFailed,
    // 能被 POST /batches/:id/retry 重新排队：解析失败、有文件、不是引用其他批次 run 的重复项
    retryable: r.state === 'failed' && !!fileId && !r.duplicate,
    terminal: ITEM_TERMINAL.includes(r.state),
    updatedAt: r.updated_at || r.updatedAt || null
  }
}

export function sortBatches(list) {
  return [...(list || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)))
}

// 按 id 合并，保留其他已加载项（列表分页与单个批次刷新共用）
export function mergeBatches(list, updates) {
  const map = new Map((list || []).map(b => [b.id, b]))
  for (const u of updates || []) if (u && u.id) map.set(u.id, { ...(map.get(u.id) || {}), ...u })
  return sortBatches([...map.values()])
}

// 状态签名：计数或状态变化时才需要刷新条目页
export function statusSignature(s) {
  if (!s) return ''
  return [s.state, s.control, s.sealed ? 1 : 0, s.received, s.waiting, s.processing, s.done, s.partial, s.failed, s.cancelled].join('|')
}

// 一次选择超过 1000 个文件时拆成多个批次
export function planBatches(count, max = MAX_BATCH_SIZE) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const out = []
  for (let left = n; left > 0; left -= max) out.push(Math.min(max, left))
  return out
}

// client_key 在同一批次内必须稳定：同一个文件重传、补传时得到同一个 key，后端据此幂等
export function clientKeyFor(file, folderId = '') {
  const name = String((file && file.name) || '').slice(0, 200)
  return ['f', Number(file && file.size) || 0, Number(file && file.lastModified) || 0, folderId || '', name].join(':').slice(0, 300)
}

// 本地队列中属于某批次的条目决定是否封口：
// wait   还有排队/上传中/等待自动重试的文件
// ask    有可手动重试的上传失败项；封口后后端不再接收该批次上传，需用户决定
// seal   全部已提交、已取消或本地预检失败，可以封口
export function sealDecision(items) {
  const list = items || []
  if (list.some(i => i.state === 'queued' || i.state === 'uploading')) return 'wait'
  if (list.some(i => i.state === 'failed' && !i.local)) return 'ask'
  return 'seal'
}

// 批次的本地上传概况（只在当前页面内存；刷新后以 GET /batches/:id 为准）
export function localBatchSummary(items) {
  const s = { total: 0, uploaded: 0, failed: 0, local: 0, cancelled: 0, pending: 0 }
  for (const i of items || []) {
    s.total++
    if (i.state === 'uploaded') s.uploaded++
    else if (i.state === 'failed') { if (i.local) s.local++; else s.failed++ }
    else if (i.state === 'cancelled') s.cancelled++
    else s.pending++
  }
  return s
}

export function defaultBatchName(count, now = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `上传 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} · ${count} 个文件`
}

// 失败项需要扫描全部条目（后端 items 无状态过滤），每页最多 200 条，1000 个文件最多 5 次请求
export async function collectItems(fetchPage, { pageSize = 200, maxPages = 10 } = {}) {
  const rows = []
  let cursor = null
  let pages = 0
  do {
    const res = await fetchPage({ cursor, limit: pageSize })
    rows.push(...(res.items || []))
    cursor = res.nextCursor || null
    pages++
  } while (cursor && pages < maxPages)
  return { rows, complete: !cursor }
}
