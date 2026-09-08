/**
 * SOP 台账 → WorkBuddy 直接运行
 * 交互对齐 WorkBuddy 客户端：点运行 → 选产物 → 执行 SOP → 拿回报告/链接
 */
import { checkWorkbuddy, streamChat } from './workbuddyChat'
import {
  addRunToLedger,
  addDeliverableToLedger,
  persistSopLedger,
  normalizeLedger,
  isJunkDeliverable
} from './sopLedger'

/** 可选产物预设（运行前勾选） */
export const SOP_OUTPUT_PRESETS = [
  {
    id: 'html',
    label: 'HTML 执行单',
    hint: '单页简洁美观，含 KPI / 表格 / 本周动作',
    prompt:
      '生成一份简洁美观的单页 HTML 执行单，落到项目 output 目录，文件名带 YYYY-MM-DD_HHmm，并给出可打开的绝对路径'
  },
  {
    id: 'md',
    label: 'Markdown 摘要',
    hint: '核心判断 + 动作清单',
    prompt: '输出 Markdown 摘要：核心判断一句话、关键结论、本周动作'
  },
  {
    id: 'xlsx',
    label: 'Excel / 表格',
    hint: '排产、下单或核对表',
    prompt: '如需表格数据，产出 Excel/CSV 并给出路径或链接'
  },
  {
    id: 'json',
    label: '结构化 JSON',
    hint: '便于二次消费',
    prompt: '额外给出结构化 JSON（结论、KPI、动作、数据源）'
  }
]

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function treeToOutline(node, depth = 0, lines = [], limit = { n: 0, max: 400 }) {
  if (!node || limit.n >= limit.max) return lines
  limit.n += 1
  const data = node.data || node
  const title = stripText(data.text || node.text) || '(空)'
  lines.push(`${'  '.repeat(depth)}- ${title}`)
  const note = data.note || node.note
  if (note) {
    lines.push(`${'  '.repeat(depth + 1)}（备注: ${String(note).slice(0, 160)}）`)
  }
  ;(node.children || []).forEach(child =>
    treeToOutline(child, depth + 1, lines, limit)
  )
  return lines
}

export async function loadSopRunContext(roomKey, sop) {
  const key = String(roomKey || '').trim()
  const uid = (sop && (sop.uid || (sop.uids && sop.uids[0]))) || ''
  const { getFileSubtree, getFileOutline } = await import('./fileApi')

  let outline = ''
  let source = 'none'

  if (uid) {
    try {
      const data = await getFileSubtree(key, uid, { deep: true, maxNodes: 800 })
      const tree = (data && data.tree) || data
      const lines = treeToOutline(tree)
      if (lines.length) {
        outline = lines.join('\n')
        source = 'subtree'
      }
    } catch (err) {
      console.warn('[sopRun] subtree failed', err)
    }
  }

  if (!outline) {
    try {
      const res = await getFileOutline(key, 2000)
      outline = (res && res.outline) || ''
      source = 'outline'
    } catch (err) {
      console.warn('[sopRun] outline failed', err)
    }
  }

  return {
    roomKey: key,
    sopId: (sop && sop.id) || '',
    sopTitle: (sop && sop.title) || '',
    sopUid: uid,
    outline: outline.slice(0, 80000),
    source
  }
}

function buildSystemPrompt() {
  return `你是良策 SOP 执行助手（WorkBuddy）。用户会指定一个 SOP 节点并勾选需要的产物。
这是真实执行任务，不是问答总结。

硬性规则：
1. 必须实际调用工具/MCP 去读数据、算数、写文件；禁止只根据大纲「口头完成」。
2. 没有工具调用、没有生成真实文件路径，就不能说「已完成」。
3. 按该 SOP 的步骤与检查项执行；HTML 要真正落盘（简洁美观：KPI 卡 + 表格 + 本周动作）。
4. 文末必须有可解析的「产物清单」，且只列用户勾选的最终产物（绝对路径或可打开链接；文件名时间精确到分）：
## 产物清单
- name: UN排产下单执行单_2026-09-07_1730.html
  path: D:\\\\path\\\\to\\\\output\\\\UN排产下单执行单_2026-09-07_1730.html
5. 禁止把过程数据、中间 JSON、MCP/工具临时路径、stdout、schema 片段、COS 临时对象写入产物清单。
6. 最终文件请落到项目 output 目录；文件名带 YYYY-MM-DD_HHmm。
7. 同时给出：是否完成、核心判断一句话、单页内容要点、数据来源。
8. 不要修改 SOP 本体结构；过程日志不必写入导图。
9. 缺关键数据时说明缺什么，仍尽量用已有数据给出可执行结论，但不要伪造文件。`
}

function buildUserPrompt({ ctx, outputs, extraNote }) {
  const selected = (outputs || [])
    .map(o => `- ${o.label}：${o.prompt}`)
    .join('\n')
  const goal = [ctx.sopId, ctx.sopTitle].filter(Boolean).join('：')
  return [
    `请执行 SOP「${goal || ctx.sopTitle}」。`,
    ctx.sopUid ? `节点 uid：${ctx.sopUid}` : '',
    `房间：${ctx.roomKey}`,
    '',
    '## 需要输出的产物（只生成并回报这些；文末「产物清单」也只能列这些最终文件）',
    selected || '- HTML 执行单：简洁美观',
    '',
    '注意：中间快照、_map_full/_map_outline、MCP 日志不要出现在产物清单里。',
    extraNote ? `\n## 额外要求\n${extraNote}` : '',
    '',
    '## SOP 子树 / 大纲上下文',
    ctx.outline || '（未拉到大纲，请用房间 MCP/工具自行读取该 SOP）',
    '',
    '开始执行。完成后用中文结构化汇报，文末必须有「## 产物清单」。'
  ]
    .filter(Boolean)
    .join('\n')
}

/** 过程数据 / 工具噪声，不应进入用户可见产物 */
export { isJunkDeliverable }

function deliverableExt(item) {
  const blob = `${(item && item.name) || ''}\n${(item && item.uri_or_path) || ''}`
  const m = blob.match(/\.(html?|xlsx?|docx?|pdf|md|csv|json)(?=(\?|#|$|[\s"'<>]))/i)
  return m ? m[1].toLowerCase() : ''
}

/** 只保留用户勾选的产物类型；每种类型最多 1 个（优先本地 output 落盘） */
export function filterDeliverablesByOutputs(list, outputs = []) {
  const ids = (outputs || []).map(o => o.id || o).filter(Boolean)
  const idSet = new Set(ids)
  const allowAll = !idSet.size

  const typed = (list || []).filter(item => {
    if (isJunkDeliverable(item)) return false
    if (allowAll) return true
    const type = guessOutputId(item)
    return type && idSet.has(type)
  })

  const score = item => {
    const uri = String((item && item.uri_or_path) || '')
    let s = 0
    if (/[\\/]output[\\/]/i.test(uri)) s += 100
    if (/^[A-Za-z]:[\\/]/.test(uri)) s += 50
    if (/^https?:\/\//i.test(uri)) s += 10
    if (/\.(html?|xlsx?|md|csv)$/i.test(uri)) s += 20
    return s
  }

  const bestByType = new Map()
  typed.forEach(item => {
    const type = guessOutputId(item) || '_other'
    const prev = bestByType.get(type)
    if (!prev || score(item) > score(prev)) bestByType.set(type, item)
  })

  const order = ids.length ? ids : Array.from(bestByType.keys())
  const out = []
  const seen = new Set()
  order.forEach(id => {
    const item = bestByType.get(id)
    if (!item) return
    const key = `${item.name}|${item.uri_or_path}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  })
  // 未映射到预设类型的（allowAll）附在后面
  if (allowAll) {
    bestByType.forEach((item, key) => {
      if (ids.includes(key)) return
      const k = `${item.name}|${item.uri_or_path}`
      if (seen.has(k)) return
      seen.add(k)
      out.push(item)
    })
  }
  return out
}

function guessOutputId(item) {
  const ext = deliverableExt(item)
  const uri = String((item && item.uri_or_path) || '')
  const name = String((item && item.name) || '')
  if (/^html?$/i.test(ext)) return 'html'
  if (/^md$/i.test(ext)) return 'md'
  if (/^(xlsx?|csv)$/i.test(ext)) return 'xlsx'
  if (/^json$/i.test(ext)) return 'json'
  if (
    /^https?:\/\//i.test(uri) &&
    /(执行单|报告|\.html?)/i.test(`${name} ${uri}`)
  ) {
    return 'html'
  }
  return ''
}

function cleanDeliverableName(name, uri) {
  let n = String(name || '').trim()
  n = n.replace(/^name\s*[:：]\s*/i, '').trim()
  if (!n || isJunkDeliverable({ name: n, uri_or_path: '' })) {
    const base = String(uri || '')
      .split(/[\\/]/)
      .pop()
      .split(/[?#]/)[0]
    if (base && /\.(html?|xlsx?|docx?|pdf|md|csv|json)$/i.test(base)) return base
  }
  return n || uri
}

export function extractDeliverablesFromReply(text, events = [], outputs = []) {
  const out = []
  // 只用模型正文解析产物；工具事件里会有大量 MCP/过程路径噪声
  const reply = String(text || '')
  const seen = new Set()

  const push = item => {
    if (!item || isJunkDeliverable(item)) return
    const uri = String(item.uri_or_path || '').trim()
    const name = cleanDeliverableName(item.name, uri)
    if (!name && !uri) return
    if (isJunkDeliverable({ name, uri_or_path: uri })) return
    const key = `${name}|${uri}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      name: name || uri.split(/[\\/]/).pop() || uri,
      uri_or_path: uri || name,
      kind: item.kind || guessKind(uri || name)
    })
  }

  // 优先：结构化「产物清单」
  const block = reply.match(/##\s*产物清单([\s\S]*?)(?=\n##\s|\n---|\s*$)/i)
  if (block) {
    const chunk = block[1]
    const namePathPairs = chunk.matchAll(
      /(?:name|名称)\s*[:：]\s*(.+?)(?:\n|\r).*?(?:path|路径|uri|url|链接)\s*[:：]\s*(.+?)(?:\n|\r|$)/gi
    )
    for (const m of namePathPairs) {
      push({ name: m[1].trim(), uri_or_path: m[2].trim() })
    }
    const bullets = chunk.matchAll(/^[-*•]\s*(.+)$/gm)
    for (const m of bullets) {
      const line = m[1].trim()
      const file = line.match(
        /([A-Za-z]:\\[^\s"'<>]+|\/(?:[\w.\u4e00-\u9fff/-]+\/)+[^\s"'<>]+|https?:\/\/\S+|[\w.\u4e00-\u9fff/\\-]+\.(html?|xlsx?|docx?|pdf|md|csv))/i
      )
      if (file) {
        push({
          name:
            line.replace(file[1], '').replace(/^[\s\-–—:：]+/, '') || file[1],
          uri_or_path: file[1]
        })
      }
    }
  }

  // 清单为空时，才从正文（仍不含事件）兜底扫最终文件
  if (!out.length) {
    const winPathRe =
      /([A-Za-z]:\\[^\s"'<>|]+\.(html?|xlsx?|docx?|pdf|md|csv))/gi
    let m
    while ((m = winPathRe.exec(reply))) {
      push({ name: m[1].split(/[\\/]/).pop(), uri_or_path: m[1], kind: 'file' })
    }
    const urlRe =
      /https?:\/\/[^\s)\]>`"'，,]+\.(html?|xlsx?|docx?|pdf|md|csv)(?:\?[^\s)\]>`"'，,]*)?/gi
    while ((m = urlRe.exec(reply))) {
      push({
        name: m[0].split('/').pop().split('?')[0] || m[0],
        uri_or_path: m[0],
        kind: 'link'
      })
    }
  }

  void events // 保留签名兼容，刻意不扫事件正文
  return filterDeliverablesByOutputs(out, outputs).slice(0, 8)
}

function guessKind(uri) {
  if (/^https?:\/\//i.test(uri)) return 'link'
  if (/\.html?/i.test(uri)) return 'file'
  return 'file'
}

function inferRunResult(reply) {
  const t = String(reply || '')
  if (/疑似空跑|未真正执行|没有工具|未调用工具/.test(t)) return '疑似空跑'
  if (/已完成|执行完成|全部完成|成功生成/.test(t) && !/未完成|失败无法/.test(t)) {
    return '完成'
  }
  if (/失败|无法执行|中断|error/i.test(t)) return '失败'
  if (/部分完成|待人工|缺数据/.test(t)) return '部分完成'
  return t.trim() ? '完成' : '未知'
}

/** 判定是否像真执行：要有工具事件或真实产物路径；过短秒回视为空跑 */
export function assessSopExecution({
  reply,
  events,
  elapsedSec,
  deliverables
} = {}) {
  const evs = events || []
  const toolish = evs.filter(ev => {
    const type = String((ev && ev.type) || '')
    return /tool_call|tool_result|phase|plan/.test(type)
  })
  const realFiles = (deliverables || []).filter(d => {
    const uri = String((d && d.uri_or_path) || '')
    const name = String((d && d.name) || '')
    if (/待回填/.test(name)) return false
    return /^(https?:\/\/|[A-Za-z]:\\|\/)/.test(uri) || /\.(html?|xlsx?|pdf|md|csv)$/i.test(uri)
  })
  const tooFast = Number(elapsedSec) > 0 && Number(elapsedSec) < 40
  const text = String(reply || '')
  const claimsDone = /已完成|执行完成|成功生成/.test(text)

  if (toolish.length === 0 && tooFast) {
    return {
      ok: false,
      runResult: '疑似空跑',
      reason: `仅 ${elapsedSec}s 且无工具调用，多半只是口头回复，不是真执行`
    }
  }
  if (claimsDone && realFiles.length === 0 && tooFast) {
    return {
      ok: false,
      runResult: '疑似空跑',
      reason: '声称完成但没有真实产物路径，且耗时过短'
    }
  }
  if (realFiles.length === 0 && toolish.length === 0) {
    return {
      ok: false,
      runResult: '未拿到产物',
      reason: '没有工具事件也没有可打开的产物路径'
    }
  }
  return {
    ok: true,
    runResult: inferRunResult(reply),
    reason: '',
    toolEvents: toolish.length,
    realFiles: realFiles.length
  }
}

/**
 * 运行 SOP：WorkBuddy Chat（与客户端「执行这个节点的 SOP」同类）
 */
export async function runSopWithWorkbuddy({
  roomKey,
  sop,
  outputIds = ['html'],
  extraNote = '',
  actor = '台账',
  model,
  signal,
  conversationId: conversationIdInput,
  onStatus,
  onDelta,
  onEventDetail,
  onContext
} = {}) {
  const key = String(roomKey || '').trim()
  if (!key) throw new Error('请先选择空间')
  if (!sop || !sop.title) throw new Error('缺少 SOP')

  const setStatus = msg => onStatus && onStatus(msg)
  const outputs = SOP_OUTPUT_PRESETS.filter(p =>
    (outputIds || []).includes(p.id)
  )
  if (!outputs.length) {
    throw new Error('请至少选择一种产物')
  }

  setStatus('检查 WorkBuddy…')
  const wb = await checkWorkbuddy()
  if (!wb.ok) {
    throw new Error('WorkBuddy 未就绪，请确认本机已启动 WorkBuddy API 代理')
  }

  setStatus('拉取 SOP 节点子树 / 大纲…')
  const ctx = await loadSopRunContext(key, sop)
  const promptUser = buildUserPrompt({ ctx, outputs, extraNote })
  const promptSystem = buildSystemPrompt()
  if (onContext) {
    onContext({
      roomKey: key,
      sopId: ctx.sopId,
      sopTitle: ctx.sopTitle,
      sopUid: ctx.sopUid,
      outlineSource: ctx.source,
      outlineChars: (ctx.outline || '').length,
      outlinePreview: String(ctx.outline || '').slice(0, 1200),
      userPromptChars: promptUser.length,
      systemPromptChars: promptSystem.length
    })
  }
  if (!ctx.outline) {
    setStatus('未拉到子树，仍把房间号/节点 uid 交给 WorkBuddy 自行读取…')
  } else {
    setStatus(
      `已打包上下文：节点 ${ctx.sopUid || '(无uid)'}，大纲 ${
        ctx.outline.length
      } 字，正在流式调用 WorkBuddy…`
    )
  }

  const started = Date.now()
  const conversationId =
    String(conversationIdInput || '').trim() ||
    `sop-exec-${key}-${String(sop.id || sop.title)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .slice(0, 40)}-${Date.now().toString(36)}`

  let lastEvent = ''
  if (model) setStatus(`使用模型：${model}`)
  const result = await streamChat({
    messages: [
      { role: 'system', content: promptSystem },
      { role: 'user', content: promptUser }
    ],
    stream: true,
    conversationId,
    model,
    signal,
    onEvent: (label, raw) => {
      if (label) {
        lastEvent = label
        setStatus(`WorkBuddy：${label}`)
      }
      if (onEventDetail) onEventDetail({ label, raw, at: Date.now() })
    },
    onDelta: text => {
      if (onDelta) onDelta(text)
    }
  })

  const reply = String((result && result.content) || '').trim()
  const elapsedSec = Math.max(1, Math.round((Date.now() - started) / 1000))
  const events = (result && result.events) || []
  let deliverables = extractDeliverablesFromReply(reply, events, outputs)

  // 通路通但正文为空：典型是 ACP 只吐 phase、模型没真正生成
  if (!reply) {
    const phaseOnly =
      events.length > 0 &&
      events.every(ev => String((ev && ev.type) || '').includes('phase'))
    const reason = phaseOnly
      ? `WorkBuddy 接口已通，但模型未产出正文（仅 ${events.length} 个 phase 事件，耗时 ${elapsedSec}s）。请在 WorkBuddy 客户端确认已登录且本月额度可用，再重试。`
      : `WorkBuddy 返回空正文（耗时 ${elapsedSec}s，事件 ${events.length}）。接口连通但执行未成功。`
    setStatus(reason)
    const emptyLedger = normalizeLedger(
      sop.sopLedger || {
        frequency: sop.frequency,
        runs: sop.runs,
        deliverables: sop.deliverables
      }
    )
    const failedLedger = addRunToLedger(emptyLedger, {
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      result: '接口空跑',
      note: reason,
      actor: actor || 'WorkBuddy'
    })
    const uidEmpty = sop.uid || (sop.uids && sop.uids[0]) || ''
    if (uidEmpty) {
      try {
        await persistSopLedger(
          key,
          uidEmpty,
          { id: sop.id, title: sop.title },
          failedLedger
        )
      } catch (err) {
        console.warn('[sopRun] persist empty-run failed', err)
      }
    }
    const err = new Error(reason)
    err.code = 'WORKBUDDY_EMPTY_CONTENT'
    err.events = events
    err.elapsedSec = elapsedSec
    err.ledger = failedLedger
    throw err
  }

  const assessment = assessSopExecution({
    reply,
    events,
    elapsedSec,
    deliverables
  })
  const runResult = assessment.runResult

  setStatus(
    assessment.ok
      ? `回写运行记录与产物…（${elapsedSec}s）`
      : `${assessment.reason || '执行异常'}，仍写入台账…`
  )
  let ledger = normalizeLedger(
    sop.sopLedger || {
      frequency: sop.frequency,
      runs: sop.runs,
      deliverables: sop.deliverables
    }
  )
  const brief = reply
    .replace(/<!--SOP_LEDGER:[\s\S]*?:SOP_LEDGER-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  ledger = addRunToLedger(ledger, {
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    result: runResult,
    note: [
      `耗时约 ${elapsedSec}s`,
      assessment.toolEvents != null
        ? `工具事件 ${assessment.toolEvents || 0}`
        : '',
      lastEvent ? `末状态:${lastEvent}` : '',
      deliverables.length
        ? `产物 ${deliverables.length} 个`
        : `期望产物: ${outputs.map(o => o.label).join('、')}`,
      assessment.reason || brief
    ]
      .filter(Boolean)
      .join(' · '),
    actor: actor || 'WorkBuddy'
  })
  // 只有拿到真实路径才记产物；不要再用「待回填路径」冒充成功
  deliverables.forEach(d => {
    const uri = String((d && d.uri_or_path) || '')
    if (!uri || /待回填/.test(String((d && d.name) || ''))) return
    ledger = addDeliverableToLedger(ledger, {
      ...d,
      at: new Date().toISOString().slice(0, 16).replace('T', ' ')
    })
  })

  const uid = sop.uid || (sop.uids && sop.uids[0]) || ''
  if (uid) {
    try {
      await persistSopLedger(
        key,
        uid,
        { id: sop.id, title: sop.title },
        ledger
      )
    } catch (err) {
      console.warn('[sopRun] persist ledger failed', err)
    }
  }

  setStatus(
    assessment.ok
      ? `执行完成（${elapsedSec}s）`
      : `未确认真执行（${elapsedSec}s）：${assessment.reason || runResult}`
  )
  return {
    ok: assessment.ok && runResult !== '失败',
    reply,
    elapsedSec,
    outputs,
    deliverables,
    ledger,
    runResult,
    assessment,
    events,
    context: ctx
  }
}
