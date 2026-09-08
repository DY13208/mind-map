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
import {
  extractNotifyNodesFromOutline,
  processNotifyNodes,
  summarizeNotifyResults
} from './sopNotify'

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
 * 只认「字段名列表」，不把状态叙述/事件流拆成表单项。
 */
export function extractMissingDataNeeds(reply) {
  const text = String(reply || '')
  const fields = []
  const seen = new Set()

  const isJunkLabel = name => {
    const s = String(name || '').trim()
    if (!s) return true
    if (s.length > 16) return true
    if (/[。；;！!？?\n]/.test(s)) return true
    if (
      /节点|uid|未完成|已完成|历史|运行|推进|阻塞|阻断|容器|待办|产物|大纲|台账|校验|房间|本次|本单|流程型|登记|拟稿|数据源|回复示例|示例|仍缺|缺少|字段/.test(
        s
      )
    ) {
      return true
    }
    if (/^\d+$/.test(s)) return true
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
    // 「公司主体=XX」只取左边
    if (/[=＝]/.test(name)) {
      name = name.split(/[=＝]/)[0].trim()
    }
    if (isJunkLabel(name)) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    fields.push({ key: `f_${fields.length + 1}`, label: name, value: '' })
  }

  const pushList = chunk => {
    if (!chunk) return
    String(chunk)
      .split(/[、,，;；|/／\n]/)
      .forEach(part => push(part))
  }

  // 1) 优先：显式「仍缺 N 个字段（A、B、C）」/「缺：A、B、C」/「补齐以下 N 项：…」
  const listPatterns = [
    /仍缺\s*\*?\*?(\d+)\s*个?\s*字段\*?\*?[（(：:\s]*([^）)\n]{2,200})/i,
    /缺(?:少|失)?\s*\*?\*?(\d+)\s*个?\s*(?:字段|项)\*?\*?[（(：:\s]*([^）)\n]{2,200})/i,
    /(?:补齐|补充|提供|填写)(?:以下)?\s*\d*\s*项?[：:\s]+([^\n。]{2,200})/i,
    /关键(?:字段|信息)[：:\s]+([^\n。]{2,120})/i,
    /回复示例[：:\s`]*([^`\n]{4,200})/i
  ]
  for (const re of listPatterns) {
    const m = text.match(re)
    if (!m) continue
    const listPart = m[2] || m[1]
    if (!listPart) continue
    // 示例句「公司主体=XX；部门=XX」→ 只取键名
    if (/[=＝]/.test(listPart)) {
      listPart.split(/[;；、,，]/).forEach(seg => {
        const left = String(seg).split(/[=＝]/)[0]
        push(left)
      })
    } else {
      pushList(listPart)
    }
    if (fields.length >= 3) break
  }

  // 2) 仅在「下一步建议 / 待补」小节里扫短字段名（不扫全文）
  if (fields.length < 3) {
    const section =
      text.match(
        /(?:#{1,4}\s*)?(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:下一步建议|待补数?|缺失字段|请补充|需提供)[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|\n--|\n【|$)/i
      ) ||
      text.match(
        /(?:--\s*)?下一步建议[^\n]*\n([\s\S]*?)(?=\n--|\n#{1,4}|$)/i
      )
    const chunk = (section && section[1]) || ''
    chunk.split(/\r?\n/).forEach(line => {
      const t = line.trim()
      if (!t || t.length > 80) return
      const bullet = t.match(/^[-*•]\s*(.+)$/) || t.match(/^\d+[\.、．]\s*(.+)$/)
      if (!bullet) return
      const body = bullet[1].trim()
      const listed = body.match(/(?:补齐|补充|提供|填写)[^：:]*[：:]\s*(.+)$/)
      if (listed) {
        pushList(listed[1])
        return
      }
      // 小节里的短名才收；长叙述丢弃
      if (body.length <= 16 && !/[。；]/.test(body)) push(body)
    })
  }

  // 3) 已知招聘字段：文中点名才收（保底）
  const common = [
    ['公司主体', /公司主体/],
    ['招聘部门', /招聘部门|用人部门/],
    ['性别要求', /性别要求|性别/],
    ['人数', /人数|编制|HC\b/i],
    ['招聘原因', /招聘原因|增补原因/],
    ['岗位/JD', /\bJD\b|岗位JD|职位描述/],
    ['职级', /职级/],
    ['城市', /城市|工作地/],
    ['到岗时间', /到岗时间|入职时间/],
    ['汇报对象', /汇报对象/],
    ['薪资范围', /薪资范围|薪酬范围/]
  ]
  if (fields.length < 3) {
    common.forEach(([label, re]) => {
      if (re.test(text)) push(label)
    })
  }

  // 仍抽不出干净字段时：给空表单用的标准 8 项（不拿叙述当 label）
  const fallbackRecruit = [
    '公司主体',
    '招聘部门',
    '性别要求',
    '人数',
    '招聘原因',
    '岗位/JD',
    '职级',
    '城市'
  ]
  if (!fields.length && isMissingDataReply(text)) {
    // 文中写了「仍缺 N 个字段」就用招聘保底；否则给一项「关键信息」
    if (/仍缺|缺\s*\d+|字段|招聘|JD|部门/.test(text)) {
      fallbackRecruit.forEach(push)
    } else {
      push('关键信息')
    }
  }

  const clean = fields.slice(0, 12)
  return {
    needsData: isMissingDataReply(text) || clean.length > 0,
    fields: clean,
    summary: clean.length
      ? `待补充 ${clean.length} 项：${clean.map(f => f.label).join('、')}`
      : isMissingDataReply(text)
        ? '模型反馈缺少关键数据，请补充后继续'
        : ''
  }
}

/** 判定是否像真执行：要有工具事件或真实产物路径；过短秒回视为空跑 */
export function assessSopExecution({
  reply,
  events,
  elapsedSec,
  deliverables,
  requireFiles = true
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
  const missing = extractMissingDataNeeds(text)

  // 缺数据：不算失败，进入待补数
  if (missing.needsData) {
    return {
      ok: true,
      waitingData: true,
      runResult: '待补数',
      reason: missing.summary || '缺少关键数据，请补充后继续',
      missingFields: missing.fields,
      toolEvents: toolish.length,
      realFiles: realFiles.length
    }
  }

  // 流程型：不要求产物文件，有正文或工具事件即可
  if (!requireFiles) {
    if (!text.trim() && toolish.length === 0) {
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
  onContext,
  skipNotify = false
} = {}) {
  const key = String(roomKey || '').trim()
  if (!key) throw new Error('请先选择空间')
  if (!sop || !sop.title) throw new Error('缺少 SOP')

  const setStatus = msg => onStatus && onStatus(msg)
  const outputs = SOP_OUTPUT_PRESETS.filter(p =>
    (outputIds || []).includes(p.id)
  )
  // 允许不选产物：流程型 SOP（通知/招聘/审批）只执行步骤与派发

  setStatus('检查 WorkBuddy…')
  const wb = await checkWorkbuddy()
  if (!wb.ok) {
    throw new Error('WorkBuddy 未就绪，请确认本机已启动 WorkBuddy API 代理')
  }

  setStatus('拉取 SOP 节点子树 / 大纲…')
  const ctx = await loadSopRunContext(key, sop)

  // 先处理「AI发起通知」类节点：写入 CPDA 待办 + WorkBuddy 派发；阻塞则暂停主执行
  const notifyNodes = skipNotify
    ? []
    : extractNotifyNodesFromOutline(ctx.outline)
  let notifyResults = []
  let notifySummary = summarizeNotifyResults([])
  if (notifyNodes.length) {
    setStatus(`发现 ${notifyNodes.length} 个通知节点，正在派发…`)
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
      signal
    })
    notifySummary = summarizeNotifyResults(notifyResults)
    if (onEventDetail) {
      notifyResults.forEach(r => {
        onEventDetail({
          label: `${r.block ? '阻塞通知' : '知会通知'} → ${r.assignee}：${r.text}`,
          at: Date.now(),
          raw: r
        })
      })
    }
  if (notifySummary.hasBlocking) {
      const waitStarted = Date.now()
      setStatus(
        `已派发阻塞通知 ${notifySummary.blocking.length} 条，等待导图待办完成后再继续`
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
        actor: actor || 'WorkBuddy'
      })
      return {
        ok: false,
        waiting: true,
        waitingHuman: true,
        reply: notifyResults
          .map(
            r =>
              `${r.block ? '[阻塞]' : '[知会]'} ${r.text} → ${r.assignee}${
                r.taskUid ? `（待办 ${r.taskUid}）` : ''
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
          reason: '存在阻塞类通知，需完成导图待办后再继续'
        },
        events: [],
        context: ctx,
        notifyResults,
        waitingTaskUids: notifySummary.waitingTaskUids,
        conversationId: earlyConversationId
      }
    }
    setStatus(
      `知会通知 ${notifySummary.continued.length} 条已派发，继续执行 SOP…`
    )
  }

  const notifyExtra =
    notifyResults.length && !notifySummary.hasBlocking
      ? `\n\n## 已处理的通知（勿重复派发）\n${notifyResults
          .map(
            r =>
              `- ${r.text} → ${r.assignee}${
                r.taskUid ? `（导图待办 ${r.taskUid}）` : ''
              }`
          )
          .join('\n')}`
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
      notifyCount: notifyResults.length
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
    deliverables,
    requireFiles: outputs.length > 0
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
    actor: actor || 'WorkBuddy'
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
    context: ctx
  }
}
