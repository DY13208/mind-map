/**
 * SOP 台账 → AI 后端直接运行（WorkBuddy / 小策 / 助理，由设置与运行弹窗选择）
 * 交互对齐：点运行 → 选产物 → 执行 SOP → 拿回报告/链接
 */
import {
  AI_BACKEND_OPENCLAW,
  AI_BACKEND_XIAOCE,
  aiBackendLabel,
  checkWorkbuddy,
  getAiBackend,
  normalizeAiBackend,
  streamChat
} from './agentChat'
import {
  addRunToLedger,
  addDeliverableToLedger,
  persistSopLedger,
  normalizeLedger,
  isJunkDeliverable
} from './sopLedger'
import {
  extractNotifyNodesFromOutline,
  extractWecomTodoNotifyNodesFromOutline,
  isManualGateTitle,
  isNotifyTitle,
  isWecomTodoOrientedSop,
  processNotifyNodes,
  summarizeNotifyResults
} from './sopNotify'
import { parseProvidedFieldLabels } from './sopSubmitMaterial'

/** 可选产物预设（运行前勾选） */
export const SOP_OUTPUT_PRESETS = [
  {
    id: 'html',
    label: 'HTML 执行单',
    hint: '单页简洁美观，含 KPI / 表格 / 本周动作',
    prompt:
      '生成一份简洁美观的单页 HTML 执行单，落到项目 output 目录，文件名必须含本 SOP 编号与标题（如 D2_采购目标_YYYY-MM-DD_HHmm.html），并给出可打开的绝对路径'
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

function normalizeStepTitle(text) {
  return String(text || '')
    .replace(/^AI\s*[:：]\s*/i, '')
    .replace(/\s+/g, '')
    .trim()
}

/** 节点标题匹配：要求足够重合，避免「需求方」「发offer」误伤后续步骤 */
function matchStepByTitle(steps, tip) {
  const list = Array.isArray(steps) ? steps : []
  const raw = String(tip || '').trim()
  if (!raw) return null
  const norm = normalizeStepTitle(raw)
  const exact = list.find(
    s => s.title === raw || normalizeStepTitle(s.title) === norm
  )
  if (exact) return exact
  // 短串完整包含于长串，且长度够接近，避免「发offer」「需求方」误中
  const strong = list.find(s => {
    const st = normalizeStepTitle(s.title)
    if (!st || st.length < 6 || norm.length < 6) return false
    const shorter = st.length <= norm.length ? st : norm
    const longer = st.length <= norm.length ? norm : st
    if (!longer.includes(shorter)) return false
    return shorter.length * 2 >= longer.length
  })
  return strong || null
}

/**
 * 纠正节点流错标：仅清理「等待人工」步骤之后的误标绿。
 * 不要用 active 当游标，否则根节点 active 会把后面已完成步骤洗成灰。
 */
export function sanitizeNodeProgress(steps) {
  const list = Array.isArray(steps) ? steps.map(s => ({ ...s })) : []
  if (!list.length) return list
  const cursor = list.findIndex(s => s && s.status === 'waiting')
  if (cursor < 0) return list
  return list.map((s, i) => {
    if (i <= cursor) return s
    if (
      s.status === 'done' ||
      s.status === 'skipped' ||
      s.status === 'waiting' ||
      s.status === 'active'
    ) {
      return {
        ...s,
        status: 'pending',
        detail: '',
        updatedAt: Date.now()
      }
    }
    return s
  })
}

/** 把历史节点状态合并到新拉的步骤表上，续跑时保持已走进度变绿 */
export function mergeNodeProgress(freshSteps, priorSteps) {
  const fresh = Array.isArray(freshSteps) ? freshSteps.map(s => ({ ...s })) : []
  const prior = Array.isArray(priorSteps) ? priorSteps : []
  if (!fresh.length) return prior.map(s => ({ ...s }))
  if (!prior.length) return fresh

  const byUid = new Map()
  const byTitle = new Map()
  prior.forEach(s => {
    if (!s) return
    if (s.uid) byUid.set(String(s.uid), s)
    const nt = normalizeStepTitle(s.title)
    if (nt) byTitle.set(nt, s)
  })

  let merged = fresh.map(s => {
    const old =
      (s.uid && byUid.get(String(s.uid))) ||
      byTitle.get(normalizeStepTitle(s.title))
    if (!old) return { ...s, status: s.status || 'pending' }
    return {
      ...s,
      status: old.status || s.status || 'pending',
      detail: old.detail || '',
      events: Array.isArray(old.events) ? old.events.slice(-20) : [],
      updatedAt: old.updatedAt || s.updatedAt || 0
    }
  })

  // 续跑：waiting → done，并点亮下一个 pending
  merged = merged.map(s =>
    s.status === 'waiting'
      ? {
          ...s,
          status: 'done',
          detail: s.detail || '企微待办已完成',
          updatedAt: Date.now()
        }
      : s
  )

  const hasActive = merged.some(s => s.status === 'active')
  if (!hasActive) {
    let lit = false
    merged = merged.map(s => {
      if (lit) return s
      if (s.status === 'pending') {
        lit = true
        return { ...s, status: 'active', updatedAt: Date.now() }
      }
      return s
    })
  }
  return merged
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

function inferStepKind(title) {
  const t = String(title || '')
  if (/提交资料|提供资料|填写|补数|提交招聘/.test(t)) return 'submit'
  if (isManualGateTitle(t)) return 'manual'
  if (isNotifyTitle(t) || /通知|待办|企微|派发|发给|发送/.test(t)) return 'notify'
  if (/^AI\s*[:：]|AI\s*(通知|发布|筛选|发起)/i.test(t)) return 'ai'
  return 'step'
}

/** 节点流只保留可执行步骤，排除资料模板里的枚举叶子（初级/深圳…） */
function isActionableSopStep(title, depth) {
  const t = String(title || '').trim()
  if (!t || t === '(空)') return false
  if (isNotifyTitle(t) || isManualGateTitle(t)) return true
  if (/^AI\s*[:：]|AI\s*(通知|发布|筛选|发起|初筛)/i.test(t)) return true
  if (/提交资料|提供资料|提交招聘|需求方/.test(t)) return true
  if (
    /^(初级|中级|高级|经理级|经理级以上|全职|实习|兼职|深圳|北京|上海|广州|杭州|离职补|新增|男|女|不限)$/.test(
      t
    )
  ) {
    return false
  }
  // 深层级短标签多半是表单选项
  if (depth >= 2 && t.length <= 10 && !/AI|通知|待办|发送|确认|审批/.test(t)) {
    return false
  }
  // 资料字段名：有「要求/主体/岗位」等但不像动作
  if (
    depth >= 1 &&
    /^(公司主体|招聘岗位|招聘部门|性别要求|职级|工作性质|招聘人数|招聘城市|招聘原因|试用期|硬性要求|成长计划)/.test(
      t
    )
  ) {
    return false
  }
  return depth <= 1
}

function treeToSteps(node, depth = 0, steps = [], limit = { n: 0, max: 400 }) {
  if (!node || limit.n >= limit.max) return steps
  limit.n += 1
  const data = node.data || node
  const title = stripText(data.text || node.text) || '(空)'
  const uid = String(data.uid || node.uid || data.id || '').trim()
  if (isActionableSopStep(title, depth)) {
    steps.push({
      uid: uid || `step-${steps.length}`,
      title,
      depth,
      kind: inferStepKind(title),
      status: 'pending',
      detail: '',
      events: [],
      updatedAt: 0
    })
  }
  ;(node.children || []).forEach(child =>
    treeToSteps(child, depth + 1, steps, limit)
  )
  return steps
}

export async function loadSopRunContext(roomKey, sop) {
  const key = String(roomKey || '').trim()
  const uid = (sop && (sop.uid || (sop.uids && sop.uids[0]))) || ''
  const { getFileSubtree, getFileOutline } = await import('./fileApi')

  let outline = ''
  let steps = []
  let source = 'none'

  if (uid) {
    try {
      const data = await getFileSubtree(key, uid, { deep: true, maxNodes: 800 })
      const tree = (data && data.tree) || data
      const lines = treeToOutline(tree)
      steps = treeToSteps(tree)
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
    steps,
    source
  }
}

function buildSystemPrompt() {
  return `你是良策 SOP 执行助手（${aiBackendLabel()}）。用户会指定一个 SOP 节点并勾选需要的产物。
这是真实执行任务，不是问答总结。

硬性规则：
1. 必须实际调用工具/MCP 去读数据、算数、写文件；禁止只根据大纲「口头完成」。
2. 没有工具调用、没有生成真实文件路径，就不能说「已完成」。
3. 只执行用户指定的那一个 SOP（编号+标题+uid），禁止顺带执行或改写其它 D 节点。
4. 若用户消息已标明「已处理的通知」，不要重复派发；阻塞类通知由台账队列等待人工完成。
5. 按该 SOP 的步骤与检查项执行；HTML 要真正落盘（简洁美观：KPI 卡 + 表格 + 本周动作）。
5. 文末必须有可解析的「产物清单」，且只列用户勾选的最终产物（绝对路径或可打开链接；文件名时间精确到分）。
6. 文件名必须包含本 SOP 编号（如 D2）与标题关键词，避免多任务并行时产物串台，例如：
   D2_采购目标_2026-09-08_1022.html
7. 产物清单格式：
## 产物清单
- name: D2_采购目标_2026-09-08_1022.html
  path: D:\\\\path\\\\to\\\\output\\\\D2_采购目标_2026-09-08_1022.html
8. 禁止把过程数据、中间 JSON、MCP/工具临时路径、stdout、schema 片段、COS 临时对象写入产物清单。
9. 最终文件请落到项目 output 目录；不要复用或改写其它 SOP 刚生成的文件。
10. 同时给出：是否完成、核心判断一句话、单页内容要点、数据来源。
11. 不要修改 SOP 本体结构；过程日志不必写入导图。
12. 缺关键数据时说明缺什么，仍尽量用已有数据给出可执行结论，但不要伪造文件。`
}

function buildUserPrompt({ ctx, outputs, extraNote }) {
  const selected = (outputs || [])
    .map(o => `- ${o.label}：${o.prompt}`)
    .join('\n')
  const goal = [ctx.sopId, ctx.sopTitle].filter(Boolean).join('：')
  const fileHint = suggestDeliverableFileStem(ctx.sopId, ctx.sopTitle)
  const needFiles = !!(outputs && outputs.length)
  if (!needFiles) {
    return [
      `请执行 SOP「${goal || ctx.sopTitle}」（流程型，不要求落盘产物文件）。`,
      ctx.sopUid ? `节点 uid：${ctx.sopUid}` : '',
      `房间：${ctx.roomKey}`,
      '',
      '【执行要求】',
      '- 按大纲中的 AI / 人 / HRBP / 需求方 等步骤推进可自动部分；',
      '- 遇到通知、知会、审批类步骤：说明对象与内容；若台账侧已派发待办则勿重复；',
      '- 不要强行生成 HTML/Excel 等文件；文末可不写「产物清单」，改为「## 执行结果」；',
      '- 说明：已完成哪些自动步骤、卡在哪个人工步骤、下一步建议。',
      '- 若下方已有「## 用户提交资料 / 用户补充数据」，视为需求方已提供；不得再要求用户重复填写这些字段；仅当大纲另有未覆盖的硬性必填时，才在「仍缺」里列出字段名。',
      extraNote ? `\n## 额外要求\n${extraNote}` : '',
      '',
      '## SOP 子树 / 大纲上下文',
      ctx.outline || '（未拉到大纲，请用房间 MCP/工具自行读取该 SOP）',
      '',
      '开始执行。完成后用中文结构化汇报（含 ## 执行结果）。'
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    `请执行 SOP「${goal || ctx.sopTitle}」。`,
    ctx.sopUid ? `节点 uid：${ctx.sopUid}` : '',
    `房间：${ctx.roomKey}`,
    '',
    '【归属约束】本次只服务上述 SOP；产物文件名必须以以下词干开头（后接 _YYYY-MM-DD_HHmm.扩展名）：',
    fileHint,
    '产物清单里禁止出现其它 D 编号（如别人的 D1/D3 执行单）。',
    '',
    '## 需要输出的产物（只生成并回报这些；文末「产物清单」也只能列这些最终文件）',
    selected,
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

/** 产物文件名词干：D2_采购目标 */
export function suggestDeliverableFileStem(sopId, sopTitle) {
  const id = String(sopId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const title = String(sopTitle || '')
    .replace(/[\\/:*?"<>|\s]+/g, '')
    .slice(0, 24)
  if (id && title) return `${id}_${title}`
  if (id) return id
  return title || 'SOP'
}

function sopIdFromText(text) {
  // 不用 \b：文件名常为 D2_采购目标.html，下划线会吃掉词界
  const m = String(text || '').match(/(?:^|[^A-Za-z0-9])(D\d+)(?=[^A-Za-z0-9]|$)/i)
  return m ? m[1].toUpperCase() : ''
}

/**
 * 多任务并行时按 SOP 编号/标题过滤产物，避免串台
 */
export function filterDeliverablesBySop(list, sopMeta = {}) {
  const items = Array.isArray(list) ? list.slice() : []
  if (!items.length) return items
  const wantId = String(sopMeta.id || sopMeta.sopId || '')
    .trim()
    .toUpperCase()
  const wantTitle = String(sopMeta.title || sopMeta.sopTitle || '')
    .trim()
  const titleKey = wantTitle.replace(/\s+/g, '').slice(0, 12)

  const scoreMatch = item => {
    const blob = `${(item && item.name) || ''}\n${(item && item.uri_or_path) || ''}`
    let s = 0
    const fileId = sopIdFromText(blob)
    if (wantId) {
      if (fileId === wantId) s += 100
      else if (fileId && fileId !== wantId) s -= 200
      if (new RegExp(wantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blob)) {
        s += 40
      }
    }
    if (titleKey && titleKey.length >= 2 && blob.includes(titleKey)) s += 60
    if (/[\\/]output[\\/]/i.test(blob)) s += 10
    return s
  }

  const ranked = items
    .map(item => ({ item, score: scoreMatch(item) }))
    .sort((a, b) => b.score - a.score)

  // 有明确本 SOP 命中时，丢掉明显属于其它 D 编号的文件
  const hasOwnHit = ranked.some(r => r.score >= 100)
  const filtered = ranked
    .filter(r => {
      if (r.score < 0) return false
      if (hasOwnHit && r.score < 40) return false
      return true
    })
    .map(r => r.item)

  return filtered.length ? filtered : items
}

/** 过程数据 / 工具噪声，不应进入用户可见产物 */
export { isJunkDeliverable }

function deliverableExt(item) {
  const blob = `${(item && item.name) || ''}\n${(item && item.uri_or_path) || ''}`
  const m = blob.match(/\.(html?|xlsx?|docx?|pdf|md|csv|json)(?=(\?|#|$|[\s"'<>]))/i)
  return m ? m[1].toLowerCase() : ''
}

/** 只保留用户勾选的产物类型；每种类型最多 1 个（优先本地 output 落盘 + 本 SOP 命中） */
export function filterDeliverablesByOutputs(list, outputs = [], sopMeta = {}) {
  const ids = (outputs || []).map(o => o.id || o).filter(Boolean)
  const idSet = new Set(ids)
  const allowAll = !idSet.size
  const scoped = filterDeliverablesBySop(list, sopMeta)

  const typed = (scoped || []).filter(item => {
    if (isJunkDeliverable(item)) return false
    if (allowAll) return true
    const type = guessOutputId(item)
    return type && idSet.has(type)
  })

  const wantId = String(sopMeta.id || sopMeta.sopId || '')
    .trim()
    .toUpperCase()
  const titleKey = String(sopMeta.title || sopMeta.sopTitle || '')
    .replace(/\s+/g, '')
    .slice(0, 12)

  const score = item => {
    const uri = String((item && item.uri_or_path) || '')
    const name = String((item && item.name) || '')
    const blob = `${name}\n${uri}`
    let s = 0
    if (/[\\/]output[\\/]/i.test(uri)) s += 100
    if (/^[A-Za-z]:[\\/]/.test(uri)) s += 50
    if (/^https?:\/\//i.test(uri)) s += 10
    if (/\.(html?|xlsx?|md|csv)$/i.test(uri)) s += 20
    const fileId = sopIdFromText(blob)
    if (wantId && fileId === wantId) s += 80
    if (wantId && fileId && fileId !== wantId) s -= 150
    if (titleKey && titleKey.length >= 2 && blob.includes(titleKey)) s += 50
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

export function extractDeliverablesFromReply(
  text,
  events = [],
  outputs = [],
  sopMeta = {}
) {
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
      kind: item.kind || guessKind(uri || name),
      sop_id: sopMeta.id || sopMeta.sopId || '',
      sop_uid: sopMeta.uid || sopMeta.sopUid || ''
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
  return filterDeliverablesByOutputs(out, outputs, sopMeta).slice(0, 8)
}

function guessKind(uri) {
  if (/^https?:\/\//i.test(uri)) return 'link'
  if (/\.html?/i.test(uri)) return 'file'
  return 'file'
}

function inferRunResult(reply) {
  const t = String(reply || '')
  if (/疑似空跑|未真正执行|没有工具|未调用工具/.test(t)) return '疑似空跑'
  // 缺数据 / 待人工补数：优先于「失败」（避免「读取失败」被误判成整单失败）
  if (isMissingDataReply(t)) return '待补数'
  if (/已完成|执行完成|全部完成|成功生成/.test(t) && !/未完成|失败无法|待补/.test(t)) {
    return '完成'
  }
  if (/部分完成|待人工|人工确认/.test(t)) return '部分完成'
  // 硬失败：明确无法继续，且不是「缺数据等你填」
  if (
    /(?:^|[^\u4e00-\u9fff])(?:任务失败|执行失败|无法继续|中断退出)(?:[^\u4e00-\u9fff]|$)/.test(
      t
    ) ||
    (/\berror\b/i.test(t) && !/缺|待补|人工|下一步|请提供/.test(t))
  ) {
    return '失败'
  }
  return t.trim() ? '完成' : '未知'
}

/** 回复是否在要人工补数（而非整单失败） */
export function isMissingDataReply(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  if (
    /待补数|缺数据|缺少数据|数据缺失|请补充|请提供|待填写|需人工|人工确认|下一步建议|卡在|等待需求方|对齐并补全/.test(
      t
    )
  ) {
    return true
  }
  // 「读取…失败」但同时在列缺失项 / 下一步 → 仍算待补数
  if (/读取.{0,20}失败|超时|无通路/.test(t) && /下一步|请|需|缺|人工/.test(t)) {
    return true
  }
  return false
}

/**
 * 从模型汇报里抽出待补字段（供台账表单预填）
 * 只认「字段名列表」，不把状态叙述拆成表单项。
 * @param {string} reply
 * @param {{ alreadyProvided?: string[] }} [opts]
 */
export function extractMissingDataNeeds(reply, opts = {}) {
  const text = String(reply || '')
  const provided = opts.alreadyProvided || []
  const fields = []
  const seen = new Set()

  const isJunkLabel = name => {
    const s0 = String(name || '').trim()
    if (!s0) return true
    if (s0.length > 24) return true
    if (/[。；;！!？?\n]/.test(s0)) return true
    if (/[“”"']/.test(s0)) return true
    // 状态叙述 / 能力说明，不是待填字段名
    if (
      /节点|uid|未完成|已完成|已消除|历史|运行|推进|阻塞|阻断|容器|待办|产物|大纲|台账|校验|房间|本次|本单|流程型|登记|拟稿|数据源|回复示例|示例|仍缺|缺少|字段|初稿|产出|发起|知会|账号|简历池|即时|并发|可即时|AI侧|Boss|直聘/.test(
        s0
      )
    ) {
      return true
    }
    if (/^(?:但|且|并|可|已|无|有|项)/.test(s0)) return true
    if (/^(?:请|把|将|对|向|用)/.test(s0)) return true
    // 像完整短句（含动词）而非字段名
    if (
      /(?:产出|发起|消除|生成|发布|登录|缺少|没有|无法)/.test(s0) &&
      s0.length > 8
    ) {
      return true
    }
    if (/^\d+$/.test(s0)) return true
    return false
  }

  /** 更像「字段名」：短名词，而非汇报句子 */
  const looksLikeFieldName = name => {
    const s0 = String(name || '').trim()
    if (!s0 || isJunkLabel(s0)) return false
    if (s0.length > 16) return false
    // 允许：公司主体、带教导师、硬性要求、Boss账号
    if (/^[A-Za-z0-9\u4e00-\u9fff/／_-]{2,16}$/.test(s0)) return true
    return false
  }

  const push = label => {
    let name = String(label || '')
      .replace(/^[-*•\d.、）)\s]+/, '')
      .replace(/[*`「」【】\[\]]/g, '')
      .replace(/[：:=]\s*$/, '')
      .replace(/（.*?）|\(.*?\)/g, '')
      .replace(/[（(][^）)]*$/, '')
      .replace(/^需求方[（(]?[^）)]*[）)]?[：:]?/, '')
      .replace(/^(?:补齐|补充|提供|填写|对齐)[^：:]*[：:]?/, '')
      .replace(/\s+/g, '')
      .trim()
    if (!name) return
    if (/[=＝]/.test(name)) name = name.split(/[=＝]/)[0].trim()
    if (!looksLikeFieldName(name)) return
    if (
      provided.length &&
      provided.some(p => {
        const a = name.toLowerCase()
        const b = String(p || '')
          .replace(/\s+/g, '')
          .toLowerCase()
        return a === b || a.includes(b) || b.includes(a)
      })
    ) {
      return
    }
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    fields.push({ key: `f_${fields.length + 1}`, label: name, value: '' })
  }

  const pushList = chunk => {
    if (!chunk) return
    // 只有短列表才按顿号拆；长叙述整段丢弃
    const parts = String(chunk).split(/[、,，;；|/／\n]/)
    if (parts.length >= 2 && parts.every(p => String(p).trim().length <= 16)) {
      parts.forEach(part => push(part))
      return
    }
    if (String(chunk).trim().length <= 16) push(chunk)
  }

  let fromExplicit = false
  const listPatterns = [
    /仍缺\s*\*?\*?(\d+)\s*个?\s*字段\*?\*?[（(：:\s]*([^）)\n]{2,200})/i,
    /缺(?:少|失)?\s*\*?\*?(\d+)\s*个?\s*(?:字段|项)\*?\*?[（(：:\s]*([^）)\n]{2,200})/i,
    /(?:补齐|补充|提供|填写)(?:以下)?\s*\d+\s*项[：:\s]+([^\n。]{2,200})/i,
    /关键(?:字段|信息)[：:\s]+([^\n。]{2,80})/i
  ]
  for (const re of listPatterns) {
    const m = text.match(re)
    if (!m) continue
    const listPart = m[2] || m[1]
    if (!listPart) continue
    if (/[=＝]/.test(listPart)) {
      listPart.split(/[;；、,，]/).forEach(seg =>
        push(String(seg).split(/[=＝]/)[0])
      )
    } else {
      pushList(listPart)
    }
    if (fields.length >= 1) {
      fromExplicit = true
      break
    }
  }

  if (fields.length < 2) {
    const section =
      text.match(
        /(?:#{1,4}\s*)?(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:下一步建议|待补数?|缺失字段|请补充|需提供|仍缺)[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|\n--|\n【|$)/i
      ) ||
      text.match(
        /(?:--\s*)?下一步建议[^\n]*\n([\s\S]*?)(?=\n--|\n#{1,4}|$)/i
      )
    const chunk = (section && section[1]) || ''
    chunk.split(/\r?\n/).forEach(line => {
      const t = line.trim()
      if (!t || t.length > 100) return
      const bullet =
        t.match(/^[-*•]\s*(.+)$/) || t.match(/^\d+[\.、．]\s*(.+)$/)
      if (!bullet) return
      const body = bullet[1].trim()
      const listed = body.match(/(?:补齐|补充|提供|填写)[^：:]*[：:]\s*(.+)$/)
      if (listed) {
        pushList(listed[1])
        fromExplicit = true
        return
      }
      const short = body
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[：:].*$/, '')
        .trim()
      // 下一步里只收短字段名；长句/状态说明直接丢弃
      if (
        short.length >= 2 &&
        short.length <= 16 &&
        !/[。；、]/.test(short) &&
        looksLikeFieldName(short)
      ) {
        push(short)
        fromExplicit = true
      }
    })
  }

  // 仅当模型明确在要用户补数时，才用关键词兜底；避免把「产出JD初稿」等叙述误当成字段
  const asksUserFill =
    /仍缺|待补|请补充|请提供|请填写|缺失字段|缺少以下|需提供|请先补/.test(text)
  if (!fromExplicit && fields.length === 0 && asksUserFill) {
    ;[
      ['公司主体', /公司主体|公司全称/],
      ['招聘部门', /招聘部门|用人部门/],
      ['性别要求', /性别要求/],
      ['人数', /(?:招聘)?人数|编制/],
      ['招聘原因', /招聘原因/],
      ['岗位/JD', /岗位\s*\/?\s*JD|岗位JD|JD\s*(?:全文|内容|信息)|缺少\s*JD/i],
      ['职级', /职级/],
      ['城市', /招聘城市|工作地|工作城市/]
    ].forEach(([label, re]) => {
      if (re.test(text)) push(label)
    })
  }

  if (
    !fields.length &&
    !provided.length &&
    /仍缺\s*\d+\s*个?\s*字段|请补充以下|缺失字段[：:]/.test(text)
  ) {
    push('关键信息')
  }

  const clean = fields.slice(0, 12)
  return {
    needsData: clean.length > 0,
    fields: clean,
    summary: clean.length
      ? `待补充 ${clean.length} 项：${clean.map(f => f.label).join('、')}`
      : ''
  }
}

/** 判定是否像真执行：要有工具事件或真实产物路径；过短秒回视为空跑 */
export function assessSopExecution({
  reply,
  events,
  elapsedSec,
  deliverables,
  requireFiles = true,
  alreadyProvided = [],
  notifyResults = []
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
  const dispatched = (notifyResults || []).filter(r => r && r.dispatchOk)
  const tooFast = Number(elapsedSec) > 0 && Number(elapsedSec) < 40
  const text = String(reply || '')
  const claimsDone = /已完成|执行完成|成功生成/.test(text)
  const missing = extractMissingDataNeeds(text, { alreadyProvided })

  // 缺数据：不算失败，进入待补数（已提供过的字段不会再进表单）
  if (missing.needsData && missing.fields.length) {
    return {
      ok: true,
      waitingData: true,
      runResult: '待补数',
      reason: missing.summary || '缺少关键数据，请补充后继续',
      missingFields: missing.fields,
      missingSummary: missing.summary || '',
      toolEvents: toolish.length,
      realFiles: realFiles.length
    }
  }

  // 企微待办已直派成功：即使模型只回了预览/确认文案，也算真执行
  if (dispatched.length && realFiles.length === 0) {
    const names = dispatched
      .map(r => String((r && r.assignee) || '').trim())
      .filter(Boolean)
      .join('、')
    return {
      ok: true,
      runResult: '完成',
      reason: names
        ? `企微待办已派发 → ${names}`
        : `企微待办已派发 ${dispatched.length} 条`,
      toolEvents: toolish.length,
      realFiles: 0,
      notifyDispatched: dispatched.length
    }
  }

  // 流程型：不要求产物文件，有正文或工具事件即可
  if (!requireFiles) {
    if (!text.trim() && toolish.length === 0 && !dispatched.length) {
      return {
        ok: false,
        runResult: '未执行',
        reason: '流程型任务无正文也无工具事件'
      }
    }
    const result = inferRunResult(reply) || '完成'
    return {
      ok: result !== '失败',
      runResult: result,
      reason: result === '失败' ? '模型汇报执行失败' : '',
      toolEvents: toolish.length,
      realFiles: realFiles.length
    }
  }

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
    // 小策常见：只给「确认创建企业微信待办」预览，未真正调用工具
    if (/确认创建企业微信待办|创建待办预览|尚未执行任何写入/.test(text)) {
      return {
        ok: false,
        runResult: '未真正派发',
        reason:
          '小策只返回了待办预览/确认文案，未实际写入企业微信。请改走台账直派，或在智能体侧关闭待办确认门禁'
      }
    }
    return {
      ok: false,
      runResult: '未拿到产物',
      reason: '没有工具事件也没有可打开的产物路径'
    }
  }
  const result = inferRunResult(reply)
  return {
    ok: result !== '失败',
    runResult: result,
    reason: result === '失败' ? '模型汇报执行失败' : '',
    toolEvents: toolish.length,
    realFiles: realFiles.length
  }
}

/**
 * 运行 SOP：当前 AI 后端 Chat（与客户端「执行这个节点的 SOP」同类）
 */
export async function runSopWithWorkbuddy({
  roomKey,
  sop,
  outputIds = ['html'],
  extraNote = '',
  actor = '台账',
  model,
  backend: backendInput,
  signal,
  conversationId: conversationIdInput,
  onStatus,
  onDelta,
  onEventDetail,
  onContext,
  onNotifyResults,
  onNodeProgress,
  skipNotify = false,
  completedNotifyKeys = [],
  priorNodeProgress = null
} = {}) {
  const key = String(roomKey || '').trim()
  if (!key) throw new Error('请先选择空间')
  if (!sop || !sop.title) throw new Error('缺少 SOP')

  const setStatus = msg => onStatus && onStatus(msg)
  const outputs = SOP_OUTPUT_PRESETS.filter(p =>
    (outputIds || []).includes(p.id)
  )
  // 允许不选产物：流程型 SOP（通知/招聘/审批）只执行步骤与派发

  const backend = normalizeAiBackend(backendInput || getAiBackend())
  const backendLabel = aiBackendLabel(backend)
  setStatus(`检查 ${backendLabel}…`)
  const wb = await checkWorkbuddy(backend)
  if (!wb.ok) {
    throw new Error(
      backend === AI_BACKEND_XIAOCE
        ? '小策未就绪，请确认已登录且企业/智能体配置可用'
        : backend === AI_BACKEND_OPENCLAW
          ? '助理（OpenClaw）未就绪，请先运行 Start-Docker 拉起 Gateway / Bridge'
          : 'WorkBuddy 未就绪，请确认本机已启动 WorkBuddy API 代理'
    )
  }

  setStatus('拉取 SOP 节点子树 / 大纲…')
  const ctx = await loadSopRunContext(key, sop)
  const freshSteps = Array.isArray(ctx.steps)
    ? ctx.steps.map(s => ({ ...s }))
    : []
  const hasPrior =
    Array.isArray(priorNodeProgress) && priorNodeProgress.length > 0
  let nodeProgress = hasPrior
    ? mergeNodeProgress(freshSteps, priorNodeProgress)
    : freshSteps
  const emitNodes = (patchUid, patch) => {
    if (!nodeProgress.length) return
    const now = Date.now()
    if (patchUid) {
      nodeProgress = nodeProgress.map(s => {
        if (s.uid !== patchUid && s.title !== patchUid) return s
        return {
          ...s,
          ...patch,
          updatedAt: now,
          events: patch.event
            ? [...(s.events || []), patch.event].slice(-20)
            : s.events || []
        }
      })
    }
    if (onNodeProgress) onNodeProgress(nodeProgress.slice())
  }
  if (nodeProgress.length) {
    const hasMaterial = /##\s*用户提交资料/.test(String(extraNote || ''))
    if (!hasPrior) {
      // 首次运行：根节点 active；已填资料则提交类直接 done
      nodeProgress = nodeProgress.map((s, idx) => {
        let status = s.status
        if (idx === 0) status = 'active'
        if (
          hasMaterial &&
          (s.kind === 'submit' ||
            /提交招聘需求|提交资料|提供资料|需求方\s*[:：]\s*提交/.test(s.title))
        ) {
          status = 'done'
        }
        return { ...s, status, updatedAt: Date.now() }
      })
    } else if (hasMaterial) {
      // 续跑：只补标提交类，不重置其它进度
      nodeProgress = nodeProgress.map(s => {
        if (
          s.kind === 'submit' ||
          /提交招聘需求|提交资料|提供资料|需求方\s*[:：]\s*提交/.test(s.title)
        ) {
          return { ...s, status: 'done', updatedAt: Date.now() }
        }
        return s
      })
    }
    if (onNodeProgress) onNodeProgress(nodeProgress.slice())
  }
  const wecomSop = isWecomTodoOrientedSop({
    ...sop,
    title: ctx.sopTitle || sop.title,
    id: ctx.sopId || sop.id
  })

  // 刷新续跑且此前已派发：企微代办 SOP 直接结束，避免再调模型重复发
  if (skipNotify && wecomSop) {
    const elapsedSec = 1
    setStatus('刷新续跑：企微待办此前已派发，已跳过重复执行')
    let ledger = normalizeLedger(
      sop.sopLedger || {
        frequency: sop.frequency,
        runs: sop.runs,
        deliverables: sop.deliverables
      }
    )
    ledger = addRunToLedger(ledger, {
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      result: '成功',
      note: '刷新续跑跳过重复派发',
      actor: actor || backendLabel
    })
    try {
      const uid = ctx.sopUid || sop.uid || (sop.uids && sop.uids[0]) || ''
      if (uid) {
        await persistSopLedger(
          key,
          uid,
          {
            id: ctx.sopId || sop.id,
            title: ctx.sopTitle || sop.title
          },
          ledger
        )
      }
    } catch (e) {
      /* ignore */
    }
    return {
      ok: true,
      reply: '刷新续跑：企微待办此前已派发，已跳过重复执行。',
      elapsedSec,
      outputs,
      deliverables: [],
      ledger,
      runResult: '成功',
      assessment: {
        ok: true,
        runResult: '成功',
        reason: '跳过重复派发',
        toolEvents: 0
      },
      events: [],
      context: ctx,
      notifyResults: [],
      conversationId: String(conversationIdInput || '').trim()
    }
  }

  // 企微代办 SOP：只用专用提取（含子节点），不要走通用「通知」扫描以免串台账噪声
  let notifyNodes = []
  const doneKeys = new Set((completedNotifyKeys || []).filter(Boolean))
  if (!skipNotify) {
    if (wecomSop) {
      notifyNodes = extractWecomTodoNotifyNodesFromOutline(
        ctx.outline,
        {
          ...sop,
          id: ctx.sopId || sop.id,
          title: ctx.sopTitle || sop.title,
          uid: ctx.sopUid || sop.uid
        },
        extraNote
      )
    } else {
      notifyNodes = extractNotifyNodesFromOutline(ctx.outline)
    }
  }
  // 已完成的通知键标绿（严格按标题匹配）
  if (doneKeys.size && nodeProgress.length) {
    notifyNodes.forEach(n => {
      if (n && n.notifyKey && doneKeys.has(n.notifyKey)) {
        const hit = matchStepByTitle(nodeProgress, n.text)
        if (hit) emitNodes(hit.uid, { status: 'done', detail: '此前已完成' })
      }
    })
  }
  let notifyResults = []
  let notifySummary = summarizeNotifyResults([])
  const notifyStartedAt = Date.now()
  if (notifyNodes.length) {
    setStatus(`发现 ${notifyNodes.length} 个通知/代办节点，按顺序派发…`)
    const earlyConversationId =
      String(conversationIdInput || '').trim() ||
      `sop-exec-${key}-${String(sop.id || sop.title)
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .slice(0, 40)}-${Date.now().toString(36)}`
    notifyResults = await processNotifyNodes({
      roomKey: key,
      nodes: notifyNodes,
      sop: { ...sop, uid: ctx.sopUid || sop.uid },
      conversationId: earlyConversationId,
      onStatus: setStatus,
      onDelta,
      onEvent: (label, raw) => {
        if (onEventDetail) onEventDetail({ label, raw, at: Date.now() })
      },
      signal,
      extraNote,
      skipKeys: Array.from(doneKeys),
      stopOnFirstBlock: true,
      backend
    })
    notifySummary = summarizeNotifyResults(notifyResults)
    if (onEventDetail) {
      notifyResults.forEach(r => {
        if (r && r.skipped) return
        onEventDetail({
          label: `${r.block ? '阻塞通知' : '知会通知'} → ${r.assignee}：${r.text}`,
          at: Date.now(),
          raw: r
        })
      })
    }
    // 立刻通知队列：刷新续跑时跳过重复派发
    if (typeof onNotifyResults === 'function') {
      try {
        onNotifyResults(notifyResults)
      } catch (e) {
        /* ignore */
      }
    }
    // 节点流：严格按标题匹配，禁止「随便找一个未完成通知」误标后续步骤
    notifyResults.forEach(r => {
      if (!r || r.skipped) return
      const tip = String((r && (r.text || r.title)) || '')
      const hit = matchStepByTitle(nodeProgress, tip)
      if (hit) {
        emitNodes(hit.uid, {
          status:
            r.block && (r.dispatchOk || r.cpdaOk)
              ? 'waiting'
              : r.dispatchOk || r.cpdaOk
                ? 'done'
                : 'failed',
          detail: tip.slice(0, 200),
          event: {
            at: Date.now(),
            label: r.dispatchOk || r.cpdaOk ? '已派发/已建待办' : '派发失败',
            raw: r
          }
        })
        // 当前命中步之前的进行中步骤一律收成绿，呈现「一路往下变绿」
        const idx = nodeProgress.findIndex(
          s => s.uid === hit.uid || s.title === hit.title
        )
        if (idx > 0) {
          nodeProgress = nodeProgress.map((s, i) => {
            if (i >= idx) return s
            if (s.status === 'active' || s.status === 'pending') {
              return {
                ...s,
                status: 'done',
                detail: s.detail || '已推进',
                updatedAt: Date.now()
              }
            }
            return s
          })
          if (onNodeProgress) onNodeProgress(nodeProgress.slice())
        }
      }
      if (r.notifyKey && (r.dispatchOk || r.cpdaOk || r.skipped)) {
        doneKeys.add(r.notifyKey)
      }
    })
    // 已跳过的历史通知也标绿
    notifyNodes.forEach(n => {
      if (!n || !n.notifyKey || !doneKeys.has(n.notifyKey)) return
      if (notifyResults.some(r => r && r.notifyKey === n.notifyKey && !r.skipped)) {
        return
      }
      const hit = matchStepByTitle(nodeProgress, n.text)
      if (hit && hit.status !== 'done' && hit.status !== 'waiting') {
        emitNodes(hit.uid, { status: 'done', detail: '此前已完成' })
      }
    })

    // 阻塞通知企微派发失败：不要假装「等待人工」，直接失败提示
    const failedBlocks = (notifySummary.dispatchFailed || []).filter(Boolean)
    if (failedBlocks.length && !notifySummary.hasBlocking) {
      const reason = failedBlocks
        .map(
          r =>
            `${r.text || '通知'} → ${r.assignee}：${
              r.dispatchError || r.dispatchReply || '企微派发失败'
            }`
        )
        .join('；')
        .replace(/<!DOCTYPE[\s\S]*$/i, 'WorkBuddy 502')
        .slice(0, 400)
      setStatus(`企微待办未发出：${reason}`)
      const failLedger = addRunToLedger(
        normalizeLedger(
          sop.sopLedger || {
            frequency: sop.frequency,
            runs: sop.runs,
            deliverables: sop.deliverables
          }
        ),
        {
          at: new Date().toISOString().slice(0, 16).replace('T', ' '),
          result: '失败',
          note: `企微派发失败：${reason}`,
          actor: actor || backendLabel
        }
      )
      const uidFail = ctx.sopUid || sop.uid || (sop.uids && sop.uids[0]) || ''
      if (uidFail) {
        try {
          await persistSopLedger(
            key,
            uidFail,
            {
              id: ctx.sopId || sop.id,
              title: ctx.sopTitle || sop.title
            },
            failLedger
          )
        } catch (e) {
          /* ignore */
        }
      }
      const hint =
        backend === AI_BACKEND_OPENCLAW
          ? '请确认助理 OpenClaw Gateway 已启动且企微工具可用后再重试'
          : backend === AI_BACKEND_XIAOCE
            ? '请确认小策企微链路可用后再重试'
            : '请确认 WorkBuddy API 已启动后再重试'
      const err = new Error(
        `企微待办未发出（${failedBlocks.length} 条）。${reason}。${hint}。`
      )
      err.ledger = failLedger
      err.notifyResults = notifyResults
      throw err
    }

    // 纯「发企微代办」SOP：直派成功后立刻结束，不再调模型（哪怕勾了产物）
    const dispatchedOk = notifyResults.filter(r => r && r.dispatchOk)
    if (dispatchedOk.length && wecomSop) {
      const elapsedSec = Math.max(
        1,
        Math.round((Date.now() - notifyStartedAt) / 1000)
      )
      const reply = notifyResults
        .map(r => {
          const mark = r.dispatchOk ? '已派发' : '失败'
          return `- ${mark} → ${r.assignee}：${r.wxTitle || r.text}${
            r.dispatchReply ? `\n  ${String(r.dispatchReply).slice(0, 200)}` : ''
          }${r.dispatchError ? `\n  错误：${r.dispatchError}` : ''}`
        })
        .join('\n')
      const assessment = assessSopExecution({
        reply: `## 执行结果\n企微待办直派完成。\n${reply}`,
        events: [{ type: 'tool_result', label: 'wecom_todo_dispatch' }],
        elapsedSec,
        deliverables: [],
        requireFiles: false,
        notifyResults
      })
      setStatus(
        assessment.ok
          ? `企微待办已派发（${elapsedSec}s）`
          : `${assessment.reason || '派发未确认'}，仍写入台账…`
      )
      let ledger = normalizeLedger(
        sop.sopLedger || {
          frequency: sop.frequency,
          runs: sop.runs,
          deliverables: sop.deliverables
        }
      )
      ledger = addRunToLedger(ledger, {
        at: new Date().toISOString().slice(0, 16).replace('T', ' '),
        result: assessment.runResult,
        note: `企微直派 ${dispatchedOk.length}/${notifyResults.length} 条`,
        actor: actor || backendLabel
      })
      try {
        const uid = ctx.sopUid || sop.uid || (sop.uids && sop.uids[0]) || ''
        if (uid) {
          await persistSopLedger(
            key,
            uid,
            {
              id: ctx.sopId || sop.id,
              title: ctx.sopTitle || sop.title
            },
            ledger
          )
        }
      } catch (e) {
        /* ignore */
      }
      return {
        ok: assessment.ok,
        reply: `## 执行结果\n企微待办直派完成。\n${reply}`,
        elapsedSec,
        outputs,
        deliverables: [],
        ledger,
        runResult: assessment.runResult,
        assessment,
        events: [{ type: 'tool_result', label: 'wecom_todo_dispatch' }],
        context: ctx,
        notifyResults,
        conversationId: earlyConversationId
      }
    }

    if (notifySummary.hasBlocking) {
      const waitStarted = Date.now()
      setStatus(
        `已派发阻塞通知 ${notifySummary.blocking.length} 条，等待企业微信待办完成后再继续`
      )
      const waitingLedger = normalizeLedger(
        sop.sopLedger || {
          frequency: sop.frequency,
          runs: sop.runs,
          deliverables: sop.deliverables
        }
      )
      const waitingRunLedger = addRunToLedger(waitingLedger, {
        at: new Date().toISOString().slice(0, 16).replace('T', ' '),
        result: '等待人工',
        note: `阻塞通知 ${notifySummary.blocking.length} 条：${notifySummary.blocking
          .map(b => b.text)
          .join('；')}`,
        actor: actor || backendLabel
      })
      return {
        ok: false,
        waiting: true,
        waitingHuman: true,
        reply: notifyResults
          .map(
            r =>
              `${r.block ? '[阻塞]' : '[知会]'} ${r.text} → ${r.assignee}${
                r.todoId ? `（企微 ${r.todoId}）` : ''
              }`
          )
          .join('\n'),
        elapsedSec: Math.max(1, Math.round((Date.now() - waitStarted) / 1000)),
        outputs,
        deliverables: [],
        ledger: waitingRunLedger,
        runResult: '等待人工',
        assessment: {
          ok: false,
          runResult: '等待人工',
          reason: '存在阻塞类通知，需在企业微信完成待办后再继续'
        },
        events: [],
        context: ctx,
        notifyResults,
        nodeProgress: sanitizeNodeProgress(nodeProgress),
        completedNotifyKeys: Array.from(doneKeys),
        waitingTaskUids: notifySummary.waitingTaskUids,
        waitingWecomTodos: notifySummary.waitingWecomTodos || [],
        conversationId: earlyConversationId
      }
    }
    setStatus(
      `知会通知 ${notifySummary.continued.length} 条已派发，继续执行 SOP…`
    )
  }

  const notifyOk = notifyResults.filter(r => r && r.dispatchOk)
  const notifyFail = notifyResults.filter(r => r && !r.dispatchOk)
  const notifyExtraParts = []
  if (notifyOk.length && !notifySummary.hasBlocking) {
    notifyExtraParts.push(
      `## 已成功派发企微待办（勿重复）\n${notifyOk
        .map(
          r =>
            `- ${r.text} → ${r.assignee}${
              r.todoId ? `（企微 ${r.todoId}）` : ''
            }`
        )
        .join('\n')}`
    )
  }
  if (notifyFail.length) {
    notifyExtraParts.push(
      `## 企微待办派发失败（导图节点可能已写，但企微未创建；不要声称已派发成功）\n${notifyFail
        .map(
          r =>
            `- ${r.text} → ${r.assignee}：${
              r.dispatchError || r.dispatchReply || '未知失败'
            }`
        )
        .join('\n')}`
    )
  }
  const notifyExtra = notifyExtraParts.length
    ? `\n\n${notifyExtraParts.join('\n\n')}`
    : ''

  const promptUser =
    buildUserPrompt({ ctx, outputs, extraNote }) + notifyExtra
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
      systemPromptChars: promptSystem.length,
      notifyCount: notifyResults.length,
      steps: nodeProgress.slice()
    })
  }
  if (!ctx.outline) {
    setStatus(`未拉到子树，仍把房间号/节点 uid 交给 ${backendLabel} 自行读取…`)
  } else {
    setStatus(
      `已打包上下文：节点 ${ctx.sopUid || '(无uid)'}，大纲 ${
        ctx.outline.length
      } 字，正在流式调用 ${backendLabel}…`
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
  // 模型阶段：把第一个 pending 标 active
  const nextPending = nodeProgress.find(s => s.status === 'pending')
  if (nextPending) emitNodes(nextPending.uid, { status: 'active' })

  const result = await streamChat({
    backend,
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
        setStatus(`${backendLabel}：${label}`)
      }
      if (onEventDetail) onEventDetail({ label, raw, at: Date.now() })
      // 工具事件：只推进当前 waiting/active 的通知步，不乱标后面的节点
      const name = String((raw && (raw.name || raw.toolName)) || label || '')
      if (/wecom|todo|待办/i.test(name)) {
        const hit =
          nodeProgress.find(s => s.status === 'waiting' || s.status === 'active') ||
          null
        if (hit && (hit.kind === 'notify' || hit.kind === 'manual')) {
          emitNodes(hit.uid, {
            status: /result|done|end/i.test(String(label)) ? 'done' : 'active',
            detail: String(label || '').slice(0, 120),
            event: { at: Date.now(), label, raw }
          })
        }
      }
    },
    onDelta: text => {
      if (onDelta) onDelta(text)
    }
  })

  const reply = String((result && result.content) || '').trim()
  const elapsedSec = Math.max(1, Math.round((Date.now() - started) / 1000))
  const events = (result && result.events) || []
  const sopMeta = {
    id: ctx.sopId || sop.id || '',
    title: ctx.sopTitle || sop.title || '',
    uid: ctx.sopUid || sop.uid || '',
    sopId: ctx.sopId || sop.id || '',
    sopTitle: ctx.sopTitle || sop.title || '',
    sopUid: ctx.sopUid || sop.uid || ''
  }
  let deliverables = extractDeliverablesFromReply(
    reply,
    events,
    outputs,
    sopMeta
  )

  // 通路通但正文为空：典型是 ACP 只吐 phase、模型没真正生成
  if (!reply) {
    const phaseOnly =
      events.length > 0 &&
      events.every(ev => String((ev && ev.type) || '').includes('phase'))
    const reason = phaseOnly
      ? backend === AI_BACKEND_XIAOCE
        ? `小策接口已通，但智能体未产出正文（仅 ${events.length} 个 phase 事件，耗时 ${elapsedSec}s）。请确认企业/智能体可用后重试。`
        : backend === AI_BACKEND_OPENCLAW
          ? `助理接口已通，但未产出正文（仅 ${events.length} 个事件，耗时 ${elapsedSec}s）。请确认 OpenClaw Gateway / Bridge 可用后重试。`
          : `WorkBuddy 接口已通，但模型未产出正文（仅 ${events.length} 个 phase 事件，耗时 ${elapsedSec}s）。请在 WorkBuddy 客户端确认已登录且本月额度可用，再重试。`
      : `${backendLabel} 返回空正文（耗时 ${elapsedSec}s，事件 ${events.length}）。接口连通但执行未成功。`
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
      actor: actor || backendLabel
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
    deliverables,
    requireFiles: outputs.length > 0,
    alreadyProvided: parseProvidedFieldLabels(extraNote),
    notifyResults
  })
  const runResult = assessment.runResult

  setStatus(
    assessment.ok
      ? outputs.length
        ? `回写运行记录与产物…（${elapsedSec}s）`
        : `回写运行记录…（${elapsedSec}s）`
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
        : outputs.length
          ? `期望产物: ${outputs.map(o => o.label).join('、')}`
          : '流程型（无产物要求）',
      assessment.reason || brief
    ]
      .filter(Boolean)
      .join(' · '),
    actor: actor || backendLabel
  })
  // 只有拿到真实路径才记产物；不要再用「待回填路径」冒充成功
  deliverables.forEach(d => {
    const uri = String((d && d.uri_or_path) || '')
    if (!uri || /待回填/.test(String((d && d.name) || ''))) return
    ledger = addDeliverableToLedger(ledger, {
      ...d,
      sop_id: sopMeta.id,
      sop_uid: sopMeta.uid,
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
    assessment.waitingData
      ? `待补数：${assessment.reason || '请补充缺失数据后继续'}`
      : assessment.ok
        ? `执行完成（${elapsedSec}s）`
        : `未确认真执行（${elapsedSec}s）：${assessment.reason || runResult}`
  )
  if (nodeProgress.length) {
    const finalStatus = assessment.waitingData
      ? 'waiting'
      : assessment.ok
        ? 'done'
        : 'failed'
    nodeProgress = nodeProgress.map(s => {
      if (s.status === 'done' || s.status === 'waiting') return s
      if (s.status === 'active' || s.status === 'pending') {
        return {
          ...s,
          status:
            s.status === 'active'
              ? finalStatus
              : assessment.ok
                ? 'skipped'
                : 'pending',
          updatedAt: Date.now()
        }
      }
      return s
    })
    if (onNodeProgress) onNodeProgress(nodeProgress.slice())
  }
  return {
    ok: assessment.ok && runResult !== '失败',
    waitingData: !!assessment.waitingData,
    missingFields: assessment.missingFields || [],
    missingSummary: assessment.waitingData
      ? assessment.reason || ''
      : '',
    reply,
    elapsedSec,
    outputs,
    deliverables,
    ledger,
    runResult: assessment.waitingData ? '待补数' : runResult,
    assessment,
    events,
    context: ctx,
    nodeProgress,
    // 无论是否待补数，都带回通知派发结果，便于界面展示「发给谁」
    notifyResults,
    waitingTaskUids: notifySummary.waitingTaskUids || [],
    waitingWecomTodos: notifySummary.waitingWecomTodos || []
  }
}
