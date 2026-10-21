// 纯函数：KB 接口错误归一化与状态映射（无依赖，便于 node 测试）
const CODE_MESSAGES = {
  kb_disabled: '文件知识库服务未就绪',
  auth_unavailable: '认证服务暂不可用，请稍后重试',
  origin_denied: '请求来源被拒绝',
  unauthorized: '请先登录',
  missing: '资源不存在或无权查看',
  not_implemented: '该能力尚未实现',
  FORBIDDEN: '没有权限执行该操作',
  forbidden: '没有权限执行该操作',
  OWNER_SINGLE: '不能通过授权把别人设为所有者，请使用所有权转移',
  OWNER_ANCHOR: '不能修改所有者本人的角色',
  INVALID_ROLE: '角色无效',
  INVALID_SUBJECT: '授权对象无效',
  UNKNOWN_TEAM: '团队不存在',
  FOLDER_NOT_EMPTY: '文件夹不为空',
  job_in_progress: '该文件已有进行中的解析任务',
  job_not_failed: '该任务已不是失败状态，请刷新',
  bad_job_id: '任务编号无效',
  INVALID_NAME: '名称无效',
  bad_ttl: '有效期需在 1 到 366 天之间',
  bad_scope: '令牌权限无效',
  bad_folder_id: '文件夹无效',
  bad_layout: '表头或数据起始行无效',
  not_excel: '只有 Excel 工作簿可以确认表头',
  empty_header: '所选表头行是空行，不能作为表头',
  bad_column_override: '改名的列超出了工作表的列数',
  batch_closed: '批次已封口或已取消，不再接收上传',
  batch_full: '批次已达到计划文件数',
  client_key_conflict: '该批次条目已对应另一个文件',
  batch_cancelled: '批次已取消，不能再暂停、继续或重试',
  run_superseded: '文件已有更新的解析版本，不能重试旧任务',
  bad_batch_size: '批次文件数需在 1 到 1000 之间',
  bad_batch_action: '不支持的批次操作',
  batch_scope_unsupported: '限定文件夹的令牌不能管理批次，请使用登录会话',
  geekcloud_forbidden: '当前账号不在吉客云授权名单中',
  query_required: '请输入查询内容',
  bad_mode: '查询模式无效'
}

// kind: ok | not_ready | not_implemented | disabled | unauthorized | forbidden | not_found | conflict | invalid | unavailable | network | timeout | error
export function classifyStatus(status, code) {
  const s = Number(status || 0)
  if (code === 'kb_disabled') return 'disabled'
  if (code === 'auth_unavailable') return 'unavailable'
  if (code === 'not_implemented') return 'not_implemented'
  if (s >= 200 && s < 300) return 'ok'
  if (s === 401) return 'unauthorized'
  if (s === 403) return 'forbidden'
  if (s === 404) return code === 'not_found' || !code ? 'not_ready' : 'not_found'
  if (s === 405 || s === 501) return 'not_ready'
  if (s === 409) return 'conflict'
  if (s === 400 || s === 413 || s === 415 || s === 422) return 'invalid'
  if (s === 502 || s === 503 || s === 504) return 'unavailable'
  return 'error'
}

const KIND_MESSAGES = {
  not_ready: '后端未就绪：该接口尚未实现',
  not_implemented: '该能力尚未实现',
  disabled: '文件知识库服务未就绪，页面可以查看，但不会加载真实数据。',
  unauthorized: '请先登录',
  forbidden: '没有权限执行该操作',
  not_found: '资源不存在或无权查看',
  conflict: '操作冲突，请刷新后重试',
  invalid: '请求参数无效',
  unavailable: '文件知识库服务暂不可用',
  network: '网络异常，无法连接文件知识库服务',
  timeout: '请求超时，请稍后重试',
  error: '请求失败，请重试'
}

export function normalizeKbError(error) {
  if (error && error.__kb) return error
  const response = error && error.response
  const status = response ? Number(response.status || 0) : 0
  const data = (response && response.data) || {}
  const code = String((data && typeof data === 'object' && (data.code || '')) || '')
  let kind
  if (error && error.__CANCEL__) kind = 'canceled'
  else if (!response) {
    kind = error && (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) ? 'timeout' : 'network'
  } else kind = classifyStatus(status, code)
  const message = kind === 'canceled' ? '已取消'
    : CODE_MESSAGES[code] && kind !== 'not_ready' ? CODE_MESSAGES[code]
    : KIND_MESSAGES[kind] || (data && data.error) || KIND_MESSAGES.error
  const err = new Error(message)
  err.__kb = true
  err.status = status
  err.code = code || kind
  err.kind = kind
  err.backendNotReady = kind === 'not_ready'
  err.detail = data && typeof data === 'object' ? data.error || data.message || '' : ''
  err.data = data && typeof data === 'object' ? data : null
  err.retryAfterMs = parseRetryAfter(response && response.headers, err.data)
  return err
}

// Retry-After：秒数或 HTTP 日期；后端 429 另在正文给 retryAfterMs。都没有时为 null。
export function parseRetryAfter(headers, data, now = Date.now()) {
  const h = headers && (typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'] || headers['Retry-After'])
  if (h != null && String(h).trim() !== '') {
    const v = String(h).trim()
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
    const t = Date.parse(v)
    if (!isNaN(t)) return Math.max(0, t - now)
  }
  const ms = data && Number(data.retryAfterMs)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

const PRESENTATION = {
  not_ready: { title: '后端未就绪', description: '该接口尚未实现。' },
  not_implemented: { title: '该能力尚未实现', description: '服务已连通，但这项能力没有启用。' },
  disabled: { title: '服务未就绪', description: '后端开关仍关闭。页面和空状态可以查看，这里没有真实文件。' },
  unauthorized: { title: '请先登录', description: '登录后才能使用文件知识库。' },
  forbidden: { title: '没有权限', description: '没有权限执行该操作。' },
  not_found: { title: '资源不存在', description: '没有找到该资源，或你没有查看权限。' },
  unavailable: { title: '服务暂不可用', description: '文件知识库服务暂不可用，请稍后重试。' },
  network: { title: '网络异常', description: '无法连接文件知识库服务。' },
  timeout: { title: '请求超时', description: '请求超时，请稍后重试。' }
}

export function errorPresentation(err) {
  const known = err && PRESENTATION[err.kind]
  if (known) return { title: known.title, description: (err && err.message) || known.description }
  return { title: '加载失败', description: (err && err.message) || '请求失败，请重试' }
}

// 后台任务 last_error（英文、偏技术）→ 给用户看的原因；原文另行展示
const JOB_ERROR_RULES = [
  [/exceeded \d+ms|timed? ?out|timeout/i, '解析超时，文件可能过大或页数过多'],
  [/docling task failed/i, '解析服务无法处理该文件，可能已损坏、加密或格式不受支持'],
  [/no json_content|result missing/i, '解析服务没有返回内容'],
  [/HTTP 5\d\d|ECONNREFUSED|ECONNRESET|connect|breaker/i, '解析服务暂时不可用'],
  [/lease expired/i, '处理中多次中断，可能是内存不足或服务重启'],
  [/object_missing|ENOENT/i, '原始文件已丢失，请重新上传'],
  [/cancel/i, '任务已被取消']
]
export function describeJobError(lastError) {
  const text = String(lastError || '')
  const hit = JOB_ERROR_RULES.find(([re]) => re.test(text))
  return hit ? hit[1] : '处理失败，原因见错误详情'
}

export function isNotReady(err) {
  return !!err && (err.kind === 'not_ready' || err.kind === 'disabled' || err.kind === 'unavailable' || err.kind === 'network')
}
