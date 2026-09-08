import { plainText, noteOf, findSopNode } from './flowSearch'
import {
  readLedgerFromNodeLike,
  mergeLedgerSources,
  normalizeLedger,
  stripLedgerBlocksFromNote
} from './sopLedger'

const MAX_OUTLINE_NODES = 2000
const MAX_PROMPT_CHARS = 100000

/** 匹配「D：采购目标」——单独字母 D + 冒号；排除 D1/D2 等编号 */
export const D_REGISTRY_RE = /^(D)(?!\d)\s*[：:]\s*(.+)$/i

/** 从节点标题识别 SOP：去掉首尾空白与项目符号后再匹配 */
export function matchDRegistryTitle(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^[-*•●]\s*/, '')
    .replace(/^【\s*/, '')
    .replace(/\s*】$/, '')
  const m = trimmed.match(D_REGISTRY_RE)
  if (!m) return null
  const title = cleanTitle(m[2])
  if (!title) return null
  return { id: 'D', title, raw: trimmed }
}

export const SOP_REGISTRY_SYSTEM = `你是良策 SOP 台账助手。任务：从用户给出的思维导图/XMind 大纲或粘贴文本中，识别「D：标题」条目，整理成可管理的 SOP 清单，并补全台账字段与可选的 C/P 骨架。

【编号语义 — 必须遵守】
- 台账 SOP 标题格式为单独字母「D：业务标题」（如「D：采购目标」「D: 招聘」）。
- 「D1：…」「D2：…」是步骤/子项编号，不是台账 SOP，必须忽略。
- 与 CPDA 一致：D = Do；不要把 D1/D2 当成台账编号。

【抽取规则】
1. 匹配行或节点标题：/^D(?!\\d)\\s*[：:]/（全角/半角冒号均可；D 后不得紧跟数字）。
2. 编号固定为「D」；标题取冒号后全文并 trim；忽略尾部纯装饰符号。
3. 同一标题多次出现：合并为一条，保留最完整路径；冲突字段列入 conflicts。
4. 「D1：」「D2：」及普通节点只可作上下文，不得收入 sops。

【台账字段】
对每条 SOP 输出：
- source：来自哪张图/哪个大纲路径/粘贴片段；写得出路径就写 path。
- frequency：仅当原文出现周期用语（每天/每周/每月/每季度/按需/触发时）才填写；否则 frequency.label=「未知」。
- runs：仅当原文有时间、完成、结果、日志类信息才记一条；无则 []。
- deliverables：原文中的文件名、链接、导出物、附件、「交付/产出/结果文档」类节点；无则 []。
- cpda：为目标名生成简洁 C（2～5 条可验收叶子）与 P（3～8 条可执行步骤）。若原文已有「C/检查/目标」「P/计划」子树，优先照抄并整理，禁止与原文矛盾的臆造。

【禁止】
- 禁止把「D1/D2」当成台账 SOP。
- 禁止编造不存在的运行记录、文件路径、负责人、频率。
- 禁止输出名为「SOP」的索引空壳当业务目标；业务目标用冒号后的标题（如「采购目标」）。
- 禁止只做散文总结；必须给出可解析 JSON（可附简短说明，但 JSON 优先）。

【输出】
只输出一个 JSON 对象，字段：sops[]、conflicts[]、notes。不要 Markdown 围栏外的长文。
JSON 中每条 sop 形状：
{
  "id": "D",
  "title": "采购目标",
  "source": { "type": "xmind|room|paste", "ref": "...", "path": "..." },
  "frequency": { "label": "每周|按需|未知", "cron_hint": null },
  "runs": [{ "at": "...", "result": "...", "note": "..." }],
  "deliverables": [{ "name": "...", "uri_or_path": "...", "kind": "file|link|node" }],
  "cpda": { "goal": "采购目标", "C": ["验收项"], "P": ["步骤"] }
}`

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\[[0-9a-fA-F-]{8,}\]\s*$/g, '') // 去掉大纲行尾 [uid]
    .replace(/[\s]*[|｜].*$/, '')
    .replace(/[\s]+$/g, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim()
}

/**
 * 本地确定性抽取「D：标题」（不依赖 AI）
 * 同一标题多条全部保留，不按编号合并覆盖
 */
export function parseDRegistryEntries(rawText, meta = {}) {
  const text = String(rawText || '')
  const lines = text.split(/\r?\n/)
  const sops = []
  const seenKeys = new Set()

  lines.forEach((line, index) => {
    const matched = matchDRegistryTitle(line.trim().replace(/^[-*•]\s*/, ''))
    if (!matched) return
    const { id, title } = matched
    if (!title) return

    const pathHint = inferPathFromIndent(lines, index)
    const ctx = collectNearbyContext(lines, index)
    const frequency = detectFrequency(ctx) || detectFrequency(title)
    const deliverables = detectDeliverables(ctx)
    const runs = detectRuns(ctx)
    const key = `line:${index}:${id}:${title}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)

    sops.push({
      id,
      title,
      uid: '',
      rowKey: key,
      source: {
        type: meta.sourceType || 'paste',
        ref: meta.sourceRef || '粘贴',
        path: pathHint || ''
      },
      frequency: frequency || { label: '未知', cron_hint: null },
      runs,
      deliverables,
      cpda: {
        goal: title,
        C: [],
        P: []
      },
      _line: index + 1
    })
  })

  return {
    sops: sops.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    ),
    conflicts: [],
    notes: ''
  }
}

function inferPathFromIndent(lines, index) {
  const stack = []
  for (let i = 0; i <= index; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    const label = line
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(D_REGISTRY_RE, (_, id, title) => `${id}：${cleanTitle(title)}`)
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    stack.push({ indent, label })
  }
  return stack.map(s => s.label).join(' / ')
}

function collectNearbyContext(lines, index) {
  const start = Math.max(0, index)
  const baseIndent = (lines[index].match(/^(\s*)/) || ['', ''])[1].length
  const chunks = [lines[index]]
  for (let i = index + 1; i < lines.length && i < index + 40; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    if (indent <= baseIndent && matchDRegistryTitle(line.trim().replace(/^[-*•]\s*/, ''))) {
      break
    }
    if (indent <= baseIndent && i > index + 1) break
    chunks.push(line)
  }
  return chunks.join('\n')
}

function detectFrequency(text) {
  const t = String(text || '')
  const rules = [
    { re: /每天|每日|daily/i, label: '每天' },
    { re: /每周|weekly/i, label: '每周' },
    { re: /每月|monthly/i, label: '每月' },
    { re: /每季度|季度/i, label: '每季度' },
    { re: /按需|需要时/i, label: '按需' },
    { re: /触发时|事件触发/i, label: '触发时' }
  ]
  for (const rule of rules) {
    if (rule.re.test(t)) return { label: rule.label, cron_hint: null }
  }
  return null
}

function detectDeliverables(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach(line => {
    const t = line.trim()
    if (!t) return
    if (/SOP_LEDGER|【SOP台账】/.test(t)) return
    if (/交付|产出|结果文档|附件|导出|产物/.test(t)) {
      const name = t.replace(/^[-*•]\s*/, '').replace(/^[^：:]*[：:]/, '').trim() || t
      out.push({
        name: cleanTitle(name),
        uri_or_path: '',
        kind: 'node'
      })
    }
    const file = t.match(
      /([\w.\u4e00-\u9fff/\\:-]+\.(html?|xlsx?|docx?|pdf|md|json|csv|png|jpg))/i
    )
    if (file) {
      out.push({ name: file[1], uri_or_path: file[1], kind: 'file' })
    }
    const url = t.match(/https?:\/\/\S+/i)
    if (url) {
      out.push({ name: url[0], uri_or_path: url[0], kind: 'link' })
    }
  })
  return dedupeDeliverables(out)
}

function detectRuns(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach(line => {
    const t = line.trim().replace(/^[-*•]\s*/, '')
    if (!t) return
    // 避免把台账摘要 / 频率句误当成运行记录
    if (/SOP_LEDGER|【SOP台账】|^编号:|^标题:|^频率:|^最近运行:|^最新产物:|^历史运行:|^产物总数:/.test(t)) {
      return
    }
    if (/^(频率|每天|每日|每周|每月|每季度|按需)/.test(t)) return
    const hasTime = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(t)
    const hasRunWord = /(运行记录|执行记录|日志|已完成|完成于)/.test(t)
    if (!hasTime && !hasRunWord) return
    const time =
      (t.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/) ||
        t.match(/\d{1,2}[-/]\d{1,2}/) ||
        [])[0] || ''
    out.push({
      at: time,
      result: /完成|成功|通过/.test(t) ? '完成' : '',
      note: t.slice(0, 160)
    })
  })
  return out
}

function dedupeDeliverables(list) {
  const seen = new Set()
  return (list || []).filter(item => {
    const key = `${item.kind}|${item.name}|${item.uri_or_path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mergeRegistryEntry(a, b) {
  const ledger = mergeLedgerSources(
    a.sopLedger || a,
    b.sopLedger || b
  )
  return {
    ...a,
    uid: a.uid || b.uid || '',
    title: (b.title && b.title.length >= a.title.length ? b.title : a.title) || a.title,
    source: {
      type: a.source.type || b.source.type,
      ref: a.source.ref || b.source.ref,
      path: (a.source.path && a.source.path.length >= (b.source.path || '').length
        ? a.source.path
        : b.source.path) || a.source.path || ''
    },
    frequency: ledger.frequency,
    runs: ledger.runs,
    deliverables: ledger.deliverables,
    sopLedger: ledger,
    cpda: {
      goal: a.cpda.goal || b.cpda.goal,
      C: [...(a.cpda.C || []), ...(b.cpda.C || [])],
      P: [...(a.cpda.P || []), ...(b.cpda.P || [])]
    }
  }
}

export function buildSopRegistryUserPrompt({
  sourceType = 'paste',
  sourceRef = '粘贴',
  userNote = '无',
  rawText = ''
} = {}) {
  let body = String(rawText || '')
  if (body.length > MAX_PROMPT_CHARS) {
    body = body.slice(0, MAX_PROMPT_CHARS) + '\n…(内容过长已截断)'
  }
  return [
    '请从下列文本抽取全部「D：标题」SOP（排除 D1/D2），并补全台账 JSON。',
    '',
    '## 来源说明',
    `- type: ${sourceType}`,
    `- ref: ${sourceRef}`,
    `- 可选已知频率/交付补充（没有则写「无」）：${userNote || '无'}`,
    '',
    '## 原文',
    body
  ].join('\n')
}

function stripHtmlLocal(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** 从纯数据节点（含未展开子树）生成大纲行 */
export function outlineLinesFromNodeData(nodeData, depth, counter) {
  if (!nodeData || counter.count >= MAX_OUTLINE_NODES) return []
  counter.count++
  const title = stripHtmlLocal(nodeData.data && nodeData.data.text) || '(空)'
  const note = nodeData.data && nodeData.data.note
  const lines = [`${'  '.repeat(depth)}- ${title}`]
  if (note) {
    lines.push(
      `${'  '.repeat(depth + 1)}（备注: ${String(note).slice(0, 120)}）`
    )
  }
  ;(nodeData.children || []).forEach(child => {
    lines.push(...outlineLinesFromNodeData(child, depth + 1, counter))
  })
  return lines
}

export function buildOutlineFromTreeData(tree) {
  if (!tree) return ''
  const counter = { count: 0 }
  return outlineLinesFromNodeData(tree, 0, counter).join('\n')
}

/**
 * 从当前导图生成大纲文本，供台账抽取。
 * 必须走 nodeData 全树：折叠节点不会出现在 renderer 的 children 里。
 * 注意：协同懒加载下，未展开节点的 children 可能根本不在本地，需配合 loadRegistryOutline。
 */
export function buildOutlineFromMindMap(mindMap) {
  const root = mindMap && mindMap.renderer && mindMap.renderer.root
  if (!root) return ''
  const counter = { count: 0 }

  // 优先整棵数据树（含 expand=false 但仍在本地的子孙）
  if (root.nodeData) {
    return outlineLinesFromNodeData(root.nodeData, 0, counter).join('\n')
  }

  const lines = []
  const walk = (node, depth) => {
    if (!node || counter.count >= MAX_OUTLINE_NODES) return
    counter.count++
    const title = plainText(node) || '(空)'
    const note = noteOf(node)
    let line = `${'  '.repeat(depth)}- ${title}`
    if (note) line += ` （备注: ${String(note).slice(0, 120)}）`
    lines.push(line)
    const live = node.children || []
    if (live.length) {
      live.forEach(child => walk(child, depth + 1))
    } else if (node.nodeData && node.nodeData.children) {
      node.nodeData.children.forEach(child => {
        lines.push(...outlineLinesFromNodeData(child, depth + 1, counter))
      })
    }
  }
  walk(root, 0)
  return lines.join('\n')
}

/**
 * 拉取台账用大纲：有房间号时优先 HTTP 全量大纲（不依赖画布展开/懒加载）
 */
export async function loadRegistryOutline(mindMap, { roomKey } = {}) {
  const key = String(roomKey || '').trim()
  if (key) {
    try {
      const { getFileOutline, getFileExport } = await import('@/utils/fileApi')
      const outlineRes = await getFileOutline(key, 5000)
      if (outlineRes && typeof outlineRes.outline === 'string' && outlineRes.outline.trim()) {
        return {
          outline: outlineRes.outline,
          source: 'outline',
          roomKey: key
        }
      }
      const data = await getFileExport(key)
      const tree = data && data.tree
      if (tree && (tree.data || tree.children)) {
        const outline = buildOutlineFromTreeData(tree)
        if (outline) {
          return { outline, source: 'export', roomKey: key }
        }
      }
    } catch (err) {
      console.warn('[sopRegistry] remote outline failed, fallback local', err)
    }
  }
  const outline = buildOutlineFromMindMap(mindMap)
  return { outline, source: 'local', roomKey: key || '' }
}

function pathToString(path) {
  if (Array.isArray(path)) {
    return path
      .map(p => stripHtmlLocal(typeof p === 'string' ? p : (p && p.text) || ''))
      .filter(Boolean)
      .join(' / ')
  }
  return stripHtmlLocal(path || '')
}

function matchToRegistrySop(item, roomKey) {
  const raw = stripHtmlLocal((item && item.text) || '')
  const matched = matchDRegistryTitle(raw)
  if (!matched) return null
  const { id, title } = matched
  if (!title) return null
  const note = item.note ? String(item.note) : ''
  const noteClean = stripLedgerBlocksFromNote(note)
  const path = pathToString(item.path)
  const ctx = [raw, noteClean, path].join('\n')
  // 结构化台账优先；文本启发式只用清理后的备注，避免把 <!--SOP_LEDGER--> 再抽成运行记录
  const ledger = normalizeLedger(
    mergeLedgerSources(readLedgerFromNodeLike(item), {
      frequency: detectFrequency(ctx),
      runs: detectRuns(ctx),
      deliverables: detectDeliverables(ctx)
    })
  )

  return {
    id,
    title,
    uid: item.uid || '',
    rowKey: item.uid || `room:${id}:${title}:${path}`,
    source: {
      type: 'room',
      ref: roomKey || '当前房间',
      path
    },
    frequency: ledger.frequency || { label: '未知', cron_hint: null },
    runs: ledger.runs || [],
    deliverables: ledger.deliverables || [],
    sopLedger: ledger,
    cpda: {
      goal: title,
      C: [],
      P: []
    }
  }
}

/**
 * 从当前房间底层节点列出全部「D：标题」（不依赖画布展开）
 * 每个节点一条；排除 D1/D2 编号标题
 */
export async function listRoomDRegistrySops(roomKey) {
  const key = String(roomKey || '').trim()
  if (!key) {
    return { sops: [], source: 'none', totalScanned: 0 }
  }

  const { searchFileAll, getFileFlatNodes } = await import('@/utils/fileApi')
  const byUid = new Map()
  const list = []
  let totalScanned = 0
  let source = 'nodes'

  const ingest = nodes => {
    ;(nodes || []).forEach(item => {
      totalScanned += 1
      const sop = matchToRegistrySop(item, key)
      if (!sop) return
      // 仅按 uid 去重（同一底层节点）；编号相同的不同节点全部保留
      if (sop.uid) {
        if (byUid.has(sop.uid)) return
        byUid.set(sop.uid, true)
      }
      list.push(sop)
    })
  }

  // 主路径：底层扁平全量节点（不依赖画布展开）
  try {
    const flat = await getFileFlatNodes(key)
    ingest((flat && flat.nodes) || [])
    source = 'nodes'
  } catch (err) {
    console.warn('[sopRegistry] format=nodes failed, try search', err)
  }

  // 兜底：检索「D：/D:」候选，再用「单独 D：」严格过滤（禁止 D1/D2）
  if (!list.length) {
    try {
      const seenUid = new Set()
      const merged = []
      for (const q of ['D：', 'D:', 'D ：', 'D :']) {
        const res = await searchFileAll(key, q)
        ;((res && res.matches) || []).forEach(item => {
          const uid = item && item.uid
          if (uid && seenUid.has(uid)) return
          if (uid) seenUid.add(uid)
          merged.push(item)
        })
      }
      source = 'search'
      totalScanned = 0
      ingest(merged)
    } catch (err) {
      console.warn('[sopRegistry] search D-registry failed', err)
    }
  }

  const sops = list.sort((a, b) => {
    const idCmp = a.id.localeCompare(b.id, undefined, { numeric: true })
    if (idCmp !== 0) return idCmp
    return String(a.source.path || '').localeCompare(String(b.source.path || ''))
  })
  return {
    sops: fillDefaultCpda({ sops, conflicts: [], notes: '' }).sops,
    source,
    totalScanned,
    roomKey: key
  }
}

/**
 * 从 AI 回复中解析 JSON 对象
 */
export function parseSopRegistryJson(content) {
  const text = String(content || '').trim()
  if (!text) {
    return { sops: [], conflicts: [], notes: '空响应' }
  }

  const candidates = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1))
  }
  candidates.push(text)

  for (const raw of candidates) {
    try {
      const data = JSON.parse(raw)
      if (data && Array.isArray(data.sops)) {
        return normalizeRegistryPayload(data)
      }
      if (Array.isArray(data)) {
        return normalizeRegistryPayload({ sops: data, conflicts: [], notes: '' })
      }
    } catch (e) {
      /* try next */
    }
  }
  return { sops: [], conflicts: [], notes: '无法解析 AI JSON', raw: text.slice(0, 500) }
}

function normalizeRegistryPayload(data) {
  const sops = (data.sops || []).map(item => normalizeSopItem(item)).filter(Boolean)
  return {
    sops,
    conflicts: Array.isArray(data.conflicts) ? data.conflicts : [],
    notes: data.notes != null ? String(data.notes) : ''
  }
}

function normalizeSopItem(item) {
  if (!item) return null
  let id = String(item.id || '').trim().toUpperCase()
  let title = cleanTitle(item.title || '')
  if (!id && item.title) {
    const matched = matchDRegistryTitle(item.title)
    if (matched) {
      id = matched.id
      title = matched.title
    }
  }
  if (!id || id !== 'D') return null
  if (!title) title = id

  const freq = item.frequency || {}
  const cpda = item.cpda || {}
  const uid = item.uid || ''
  const path = (item.source && item.source.path) || ''
  return {
    id,
    title,
    uid,
    rowKey: item.rowKey || uid || `ai:${id}:${title}:${path}`,
    source: {
      type: (item.source && item.source.type) || 'paste',
      ref: (item.source && item.source.ref) || '',
      path
    },
    frequency: {
      label: freq.label || '未知',
      cron_hint: freq.cron_hint == null ? null : freq.cron_hint
    },
    runs: Array.isArray(item.runs) ? item.runs : [],
    deliverables: Array.isArray(item.deliverables) ? item.deliverables : [],
    cpda: {
      goal: cpda.goal || title,
      C: Array.isArray(cpda.C) ? cpda.C.map(String).filter(Boolean) : [],
      P: Array.isArray(cpda.P) ? cpda.P.map(String).filter(Boolean) : []
    }
  }
}

function sopRowKey(s) {
  return (s && (s.rowKey || s.uid || `${s.id}:${s.title}:${(s.source && s.source.path) || ''}`)) || ''
}

/**
 * 合并本地抽取与 AI 结果：按 uid/rowKey 对齐，不按编号覆盖
 */
export function mergeRegistryResults(localPayload, aiPayload) {
  const local = localPayload || { sops: [], conflicts: [], notes: '' }
  const ai = aiPayload || { sops: [], conflicts: [], notes: '' }
  const rows = local.sops.map(s => ({ ...s, rowKey: sopRowKey(s) }))

  const patchFields = (prev, s) => {
    const ledger = mergeLedgerSources(prev.sopLedger || prev, {
      frequency: s.frequency,
      runs: s.runs,
      deliverables: s.deliverables
    })
    return {
      ...prev,
      title: s.title || prev.title,
      source: {
        type: (s.source && s.source.type) || prev.source.type,
        ref: (s.source && s.source.ref) || prev.source.ref,
        path: (s.source && s.source.path) || prev.source.path
      },
      frequency: ledger.frequency,
      runs: ledger.runs,
      deliverables: ledger.deliverables,
      sopLedger: ledger,
      cpda: {
        goal: (s.cpda && s.cpda.goal) || prev.cpda.goal,
        C: s.cpda && s.cpda.C && s.cpda.C.length ? s.cpda.C : prev.cpda.C,
        P: s.cpda && s.cpda.P && s.cpda.P.length ? s.cpda.P : prev.cpda.P
      },
      aiEnriched: true
    }
  }

  ai.sops.forEach(s => {
    const key = sopRowKey(s)
    let idx = -1
    if (s.uid) idx = rows.findIndex(r => r.uid && r.uid === s.uid)
    if (idx < 0 && key) idx = rows.findIndex(r => sopRowKey(r) === key)
    if (idx < 0 && s.id && s.title) {
      const title = cleanTitle(s.title)
      idx = rows.findIndex(
        r => r.id === s.id && cleanTitle(r.title) === title
      )
    }
    // 仅当列表里该编号只有一条时，才允许按编号补全
    if (idx < 0 && s.id) {
      const sameId = rows
        .map((r, i) => (r.id === s.id ? i : -1))
        .filter(i => i >= 0)
      if (sameId.length === 1) idx = sameId[0]
    }
    if (idx >= 0) {
      rows[idx] = patchFields(rows[idx], s)
    } else {
      rows.push({ ...s, rowKey: key || sopRowKey(s), aiEnriched: true })
    }
  })

  return {
    sops: rows.sort((a, b) => {
      const idCmp = a.id.localeCompare(b.id, undefined, { numeric: true })
      if (idCmp !== 0) return idCmp
      return String((a.source && a.source.path) || '').localeCompare(
        String((b.source && b.source.path) || '')
      )
    }),
    conflicts: [...(local.conflicts || []), ...(ai.conflicts || [])],
    notes: [local.notes, ai.notes].filter(Boolean).join('；')
  }
}

function formatRegistryNote(sop) {
  const lines = [
    '【SOP台账】',
    `编号: ${sop.id}`,
    `标题: ${sop.title}`,
    `来源: ${(sop.source && sop.source.ref) || ''} ${(sop.source && sop.source.path) || ''}`.trim(),
    `频率: ${(sop.frequency && sop.frequency.label) || '未知'}`
  ]
  if (sop.deliverables && sop.deliverables.length) {
    lines.push(
      `交付: ${sop.deliverables.map(d => d.name || d.uri_or_path).join('、')}`
    )
  }
  if (sop.runs && sop.runs.length) {
    lines.push(
      `运行: ${sop.runs
        .map(r => [r.at, r.result, r.note].filter(Boolean).join(' '))
        .join(' | ')}`
    )
  }
  return lines.join('\n')
}

function findChildByTitle(parent, matcher) {
  const kids = (parent && parent.children) || []
  return kids.find(child => matcher(plainText(child) || '')) || null
}

function sopIdentityKey(sop) {
  const id = String((sop && sop.id) || '')
    .trim()
    .toUpperCase()
  const title = cleanTitle((sop && sop.title) || '')
  return `${id}|${title}`
}

/**
 * 台账展示用：按「编号+标题」合并为唯一 SOP，路径归到 sources
 */
export function dedupeSopsForRegistry(sops) {
  const map = new Map()
  ;(sops || []).forEach(s => {
    if (!s || !s.id) return
    const key = sopIdentityKey(s)
    if (!map.has(key)) {
      map.set(key, {
        ...s,
        rowKey: key,
        occurrenceCount: 1,
        sources: s.source ? [{ ...s.source, uid: s.uid || '' }] : [],
        uids: s.uid ? [s.uid] : []
      })
      return
    }
    const cur = map.get(key)
    cur.occurrenceCount += 1
    if (s.uid && !cur.uids.includes(s.uid)) cur.uids.push(s.uid)
    if (s.source) {
      cur.sources.push({ ...s.source, uid: s.uid || '' })
    }
    const merged = mergeLedgerSources(cur.sopLedger || cur, s.sopLedger || s)
    cur.sopLedger = merged
    cur.runs = merged.runs
    cur.deliverables = merged.deliverables
    cur.frequency = merged.frequency
    if (
      s.title &&
      (!cur.title || String(s.title).length > String(cur.title).length)
    ) {
      cur.title = s.title
    }
    if (s.uid && !cur.uid) cur.uid = s.uid
    if (s.cpda) {
      cur.cpda = {
        goal: cur.cpda.goal || s.cpda.goal,
        C:
          cur.cpda.C && cur.cpda.C.length
            ? cur.cpda.C
            : s.cpda.C || [],
        P:
          cur.cpda.P && cur.cpda.P.length
            ? cur.cpda.P
            : s.cpda.P || []
      }
    }
  })
  return Array.from(map.values()).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true })
  )
}

function findFlatByText(nodes, matcher) {
  return (nodes || []).find(n => matcher(stripHtmlLocal(n.text || '')))
}

/**
 * 经房间 API 写入 C/P；若 SOP 下已有相同「编号：标题」则跳过，不重复写入
 */
export async function ensureSopCpdaInRoom(roomKey, sop) {
  const key = String(roomKey || '').trim()
  if (!key || !sop) throw new Error('缺少房间或 SOP')

  const { getFileFlatNodes, addFileNode } = await import('@/utils/fileApi')
  const flat = await getFileFlatNodes(key)
  const nodes = (flat && flat.nodes) || []
  const goalLabel = `${sop.id}：${sop.title}`
  const note = formatRegistryNote(sop)
  const cList =
    sop.cpda && sop.cpda.C && sop.cpda.C.length
      ? sop.cpda.C
      : ['完成关键验收项', '产出物已归档']
  const pList =
    sop.cpda && sop.cpda.P && sop.cpda.P.length
      ? sop.cpda.P
      : ['确认目标与输入', '执行关键步骤', '验收并归档交付']

  const existingGoal = findFlatByText(nodes, t => {
    if (t === goalLabel || t === sop.title) return true
    const matched = matchDRegistryTitle(t)
    return !!(
      matched &&
      matched.id === sop.id &&
      matched.title === cleanTitle(sop.title)
    )
  })
  if (existingGoal) {
    return {
      skipped: true,
      reason: 'already_exists',
      goalUid: existingGoal.uid,
      goalLabel
    }
  }

  let sopNode = findFlatByText(nodes, t => /^sop$/i.test(t))
  if (!sopNode) {
    const root = nodes.find(n => n.isRoot) || nodes[0]
    if (!root) throw new Error('房间没有根节点')
    const created = await addFileNode(key, {
      parent: root.uid,
      text: 'SOP',
      confirm_sop_change: true
    })
    const uid =
      (created && created.uid) ||
      (created && created.node && created.node.uid) ||
      (created && created.result && created.result.uid)
    if (!uid) throw new Error('创建 SOP 节点失败')
    sopNode = { uid, text: 'SOP' }
  }

  const goalRes = await addFileNode(key, {
    parent: sopNode.uid,
    text: goalLabel,
    note,
    confirm_sop_change: true
  })
  const goalUid =
    (goalRes && goalRes.uid) ||
    (goalRes && goalRes.node && goalRes.node.uid) ||
    (goalRes && goalRes.result && goalRes.result.uid)
  if (!goalUid) throw new Error('创建业务目标失败')

  const cRes = await addFileNode(key, {
    parent: goalUid,
    text: 'C',
    confirm_sop_change: true
  })
  const cUid =
    (cRes && cRes.uid) ||
    (cRes && cRes.node && cRes.node.uid) ||
    (cRes && cRes.result && cRes.result.uid)
  const pRes = await addFileNode(key, {
    parent: goalUid,
    text: 'P',
    confirm_sop_change: true
  })
  const pUid =
    (pRes && pRes.uid) ||
    (pRes && pRes.node && pRes.node.uid) ||
    (pRes && pRes.result && pRes.result.uid)

  if (cUid) {
    for (const text of cList) {
      await addFileNode(key, {
        parent: cUid,
        text,
        confirm_sop_change: true
      })
    }
  }
  if (pUid) {
    for (const text of pList) {
      await addFileNode(key, {
        parent: pUid,
        text,
        confirm_sop_change: true
      })
    }
  }

  return { skipped: false, goalUid, goalLabel }
}

/**
 * 批量写入；相同「编号+标题」只写一次
 */
export async function ensureSopsCpdaInRoom(roomKey, sops) {
  const unique = dedupeSopsForRegistry(sops)
  const results = []
  for (const sop of unique) {
    try {
      const r = await ensureSopCpdaInRoom(roomKey, sop)
      results.push({ sop, ...r })
    } catch (err) {
      results.push({
        sop,
        skipped: false,
        error: (err && err.message) || String(err)
      })
    }
  }
  return results
}

/**
 * 画布侧写入；已存在相同「编号：标题」则跳过
 */
export function applySopCpdaToMindMap(mindMap, sop) {
  if (!mindMap || !sop) {
    throw new Error('缺少 mindMap 或 SOP')
  }
  const root = mindMap.renderer && mindMap.renderer.root
  if (!root) throw new Error('导图未就绪')

  let sopRoot = findSopNode(root)
  if (!sopRoot) {
    mindMap.execCommand('INSERT_CHILD_NODE', false, [root], { text: 'SOP' })
    sopRoot = findSopNode(root)
  }
  if (!sopRoot) throw new Error('无法创建 SOP 节点')

  const goalLabel = `${sop.id}：${sop.title}`
  const note = formatRegistryNote(sop)
  const cList =
    sop.cpda && sop.cpda.C && sop.cpda.C.length
      ? sop.cpda.C
      : ['完成关键验收项', '产出物已归档']
  const pList =
    sop.cpda && sop.cpda.P && sop.cpda.P.length
      ? sop.cpda.P
      : ['确认目标与输入', '执行关键步骤', '验收并归档交付']

  let goalNode =
    findChildByTitle(sopRoot, t => t === goalLabel) ||
    findChildByTitle(
      sopRoot,
      t => {
        const matched = matchDRegistryTitle(t)
        return !!(
          matched &&
          matched.id === sop.id &&
          matched.title === cleanTitle(sop.title)
        )
      }
    ) ||
    findChildByTitle(sopRoot, t => t === sop.title)

  if (goalNode) {
    return {
      sopRoot,
      goalNode,
      goalLabel,
      skipped: true,
      reason: 'already_exists'
    }
  }

  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [sopRoot], [
    {
      data: { text: goalLabel, note },
      children: [
        {
          data: { text: 'C' },
          children: cList.map(text => ({ data: { text } }))
        },
        {
          data: { text: 'P' },
          children: pList.map(text => ({ data: { text } }))
        }
      ]
    }
  ])
  goalNode =
    findChildByTitle(sopRoot, t => t === goalLabel) ||
    findChildByTitle(sopRoot, t => t === sop.title)
  return { sopRoot, goalNode, goalLabel, skipped: false }
}

export function defaultCpdaForTitle(title) {
  const t = cleanTitle(title) || '业务目标'
  return {
    goal: t,
    C: [`「${t}」相关检查项已通过`, '交付物齐全且可追溯'],
    P: [`明确「${t}」输入与范围`, `按步骤执行「${t}」`, '验收并更新运行记录']
  }
}

/** 给本地抽取结果补默认 C/P（未走 AI 时） */
export function fillDefaultCpda(payload) {
  const next = {
    sops: (payload.sops || []).map(s => {
      const hasCpda =
        (s.cpda && s.cpda.C && s.cpda.C.length) ||
        (s.cpda && s.cpda.P && s.cpda.P.length)
      if (hasCpda) return s
      return {
        ...s,
        cpda: defaultCpdaForTitle(s.title)
      }
    }),
    conflicts: payload.conflicts || [],
    notes: payload.notes || ''
  }
  return next
}
