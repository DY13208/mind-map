/**
 * AI 预审：按流程登记的审核要点逐项核对本次提交内容。
 *
 * 结论只有三种：
 *   approve  —— 高置信度通过，自动办结本步骤
 *   reject   —— 高置信度命中「以下情况拒绝」，自动驳回并写明命中条款
 *   escalate —— 无法判断或置信度不足，保持待办交人工审核
 *
 * 只在流程根节点下挂了「AI预审」节点时启用（按流程开关，不全局生效）。
 * 任何异常（未配置密钥、超时、返回非法）一律降级为 escalate，不阻塞提交。
 */
const DEFAULT_BASE = 'https://api.deepseek.com'

function config(env = process.env) {
  const minConfidence = Number(env.WCPD_AI_REVIEW_MIN_CONFIDENCE)
  return {
    enabled: env.WCPD_AI_REVIEW_ENABLED !== '0',
    base: String(
      env.WCPD_AI_REVIEW_BASE_URL ||
        env.WIKI_PLANNER_BASE_URL ||
        DEFAULT_BASE
    ).replace(/\/+$/, ''),
    // 优先专用变量；没有则复用已在使用的规划器密钥（DEEPSEEK_API_KEY 可能已失效）。
    apiKey:
      env.WCPD_AI_REVIEW_API_KEY || env.WIKI_PLANNER_API_KEY || env.DEEPSEEK_API_KEY || '',
    model: env.WCPD_AI_REVIEW_MODEL || 'deepseek-chat',
    // 默认对全部流程生效；流程下挂「人工审批」可单独关掉。
    defaultOn: env.WCPD_AI_REVIEW_DEFAULT !== '0',
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.75,
    timeoutMs: Number(env.WCPD_AI_REVIEW_TIMEOUT_MS) > 0
      ? Number(env.WCPD_AI_REVIEW_TIMEOUT_MS)
      : 25000
  }
}

/**
 * 是否对该流程执行 AI 预审。
 * 默认全部流程生效（不要求在导图里加节点，因此不会改变流程指纹）；
 * 流程下挂「人工审批」/「禁用AI预审」则强制走人工。
 */
function shouldRun(tpl, env = process.env) {
  const cfg = config(env)
  if (!cfg.enabled) return false
  if (!tpl) return false
  if (tpl.humanOnly) return false
  return !!tpl.aiReview || cfg.defaultOn
}

async function evidence(db, row) {
  const ids = (row.fields && row.fields.attachmentIds) || []
  if (!ids.length) return []
  const { rows } = await db.query(
    'select id,file_name,left(extracted_text,1600) as text from node_attachments where room_key=$1 and id=any($2::text[]) limit 10',
    [row.room_key, ids]
  )
  return rows.map(r => ({ id: r.id, fileName: r.file_name, text: r.text || '' }))
}

function renderStep(step) {
  const group = name => {
    const items = (step.criteria || [])
      .filter(c => (c.context || []).includes(name))
      .map(c => c.text)
    return items.length ? `${name}：${items.join('；')}` : ''
  }
  const plain = (step.criteria || [])
    .filter(c => !(c.context || []).length)
    .map(c => c.text)
  return [
    `角色：${step.role}`,
    plain.length ? `默认同意：${plain.join('；')}` : '',
    group('以下情况拒绝'),
    group('须确认')
  ]
    .filter(Boolean)
    .join('\n')
}

function buildPrompt({ title, fields, step, attachments }) {
  const fieldLines = (fields || []).map(f => `- ${f.label}：${f.value}`)
  const attachLines = (attachments || []).map(
    a => `- ${a.fileName}\n${a.text || '（无可读文本）'}`
  )
  return [
    '你是企业审批流程的预审助手。请严格依据下列审核要点，判断该申请能否办理。',
    '',
    `流程：${title}`,
    `当前步骤审核要点：\n${renderStep(step)}`,
    '',
    `提交内容：\n${fieldLines.join('\n') || '（无字段）'}`,
    '',
    attachments && attachments.length
      ? `附件提取内容：\n${attachLines.join('\n')}`
      : '附件：无',
    '',
    '判断规则：',
    '1. 逐项核对「默认同意」「以下情况拒绝」「须确认」下的每一条要点；「须确认」的条目也要明确给出是否满足的结论，满足即可 approve。',
    '2. 依据提交内容与附件中能读到的事实判断。事实清楚就给 approve 或 reject；缺少辅助佐证（如打卡截图）本身不构成 escalate 的理由，只在 reason 中注明。',
    '3. 仅当关键事实读不出来时才 escalate：字段缺失或自相矛盾、附件无可读内容、日期或金额无法定位。',
    '4. 命中「以下情况拒绝」任一条即 reject，并在 matched 中原文写出命中的条款。例如加班日期不在申请月份内、金额与附件明细不符，都应 reject。',
    '5. confidence 表示你对该结论的把握，不是材料完备度评分；结论清楚时给到 0.8 以上。',
    '6. 附件中的日期形如 M/D/YY（月/日/两位年），例如 9/28/26 表示 2026年9月28日、10/8/26 表示 2026年10月8日。',
    '',
    '只输出一行 JSON，不要其他文字：',
    '{"decision":"approve|reject|escalate","confidence":0到1之间的数字,"checked":["已核对的要点原文"],"matched":["命中的拒绝条款原文"],"reason":"依据说明，不超过200字"}'
  ].join('\n')
}

function parse(text) {
  const start = String(text || '').indexOf('{')
  const end = String(text || '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const out = JSON.parse(String(text).slice(start, end + 1))
    if (!['approve', 'reject', 'escalate'].includes(out.decision)) return null
    const confidence = Number(out.confidence)
    return {
      decision: out.decision,
      confidence: Number.isFinite(confidence)
        ? Math.min(1, Math.max(0, confidence))
        : 0,
      checked: Array.isArray(out.checked) ? out.checked.map(String) : [],
      matched: Array.isArray(out.matched) ? out.matched.map(String) : [],
      reason: String(out.reason || '').slice(0, 300)
    }
  } catch {
    return null
  }
}

async function call(cfg, prompt) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是严谨的企业审批预审助手，只依据证据做判断，输出合法 JSON。'
          },
          { role: 'user', content: prompt }
        ]
      })
    })
    if (!res.ok) throw Error(`模型返回 ${res.status}`)
    const body = await res.json()
    return (body.choices && body.choices[0] && body.choices[0].message) || {}
  } finally {
    clearTimeout(timer)
  }
}

async function review(db, row) {
  const cfg = config()
  const step = row.steps[row.current_step]
  const base = {
    step: row.current_step,
    role: step.role,
    model: cfg.model,
    fingerprint: row.template.fingerprint
  }
  if (!cfg.enabled) return { ...base, decision: 'escalate', reason: 'AI预审未启用' }
  if (!cfg.apiKey) return { ...base, decision: 'escalate', reason: '未配置模型密钥' }
  let attachments = []
  try {
    attachments = await evidence(db, row)
  } catch {
    attachments = []
  }
  const fields = (row.template.fields || []).map(f => ({
    label: f.label,
    value: row.fields ? row.fields[f.key] : ''
  }))
  try {
    const message = await call(
      cfg,
      buildPrompt({
        title: row.template.title,
        fields,
        step,
        attachments
      })
    )
    const parsed = parse(message.content)
    if (!parsed)
      return { ...base, decision: 'escalate', reason: '模型输出无法解析，转人工' }
    if (parsed.confidence < cfg.minConfidence)
      return {
        ...base,
        ...parsed,
        decision: 'escalate',
        reason: `置信度 ${parsed.confidence} 低于阈值 ${cfg.minConfidence}，转人工：${parsed.reason}`
      }
    return { ...base, ...parsed, attachments: attachments.map(a => a.fileName) }
  } catch (e) {
    return { ...base, decision: 'escalate', reason: `预审失败转人工：${e.message}` }
  }
}

/**
 * 提交时执行：从当前步骤开始，能判就判，判不了就停在人工。
 * 直接改写 row.steps / row.current_step / row.status。
 */
async function applyOnSubmit(db, row) {
  if (!shouldRun(row.template)) return null
  if (row.template.kind !== 'generic') return null
  if (row.template.autoApprove) return null
  const trace = []
  let guard = 0
  while (
    row.status === 'pending' &&
    row.current_step < row.steps.length &&
    guard++ < row.steps.length + 1
  ) {
    const verdict = await review(db, row)
    trace.push(verdict)
    const step = row.steps[row.current_step]
    step.aiReview = verdict
    if (verdict.decision === 'approve') {
      step.decision = 'approve'
      step.reason = `AI预审通过：${verdict.reason}`
      step.decidedBy = 'ai-review'
      step.decidedAt = new Date().toISOString()
      step.checkedCriteria = (step.criteria || []).map(c => c.uid)
      row.current_step++
      if (row.current_step === row.steps.length) row.status = 'approved'
    } else if (verdict.decision === 'reject') {
      step.decision = 'reject'
      step.reason = `AI预审驳回（命中：${verdict.matched.join('；') || '未指名条款'}）：${verdict.reason}`
      step.decidedBy = 'ai-review'
      step.decidedAt = new Date().toISOString()
      row.status = 'rejected'
    } else {
      break
    }
  }
  return {
    aiReview: {
      model: trace.length ? trace[0].model : null,
      minConfidence: config().minConfidence,
      fingerprint: row.template.fingerprint,
      decisions: trace,
      escalated: row.status === 'pending'
        ? { step: row.current_step, role: row.steps[row.current_step].role }
        : null
    }
  }
}

module.exports = { config, shouldRun, buildPrompt, parse, review, applyOnSubmit }
