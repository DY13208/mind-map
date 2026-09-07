/**
 * SOP 运行历史 / 产物台账
 * 主存：节点 data.sopLedger
 * 摘要：节点 note 中的【SOP台账】可读块（方便导图内直接看）
 */

const LEDGER_MARK = '【SOP台账】'
const LEDGER_JSON_START = '<!--SOP_LEDGER:'
const LEDGER_JSON_END = ':SOP_LEDGER-->'

export function emptyLedger() {
  return {
    frequency: { label: '未知', cron_hint: null },
    runs: [],
    deliverables: []
  }
}

export function normalizeRun(run) {
  if (!run || typeof run !== 'object') return null
  const at = String(run.at || '').trim()
  const result = String(run.result || '').trim()
  const note = String(run.note || '').trim()
  const actor = String(run.actor || '').trim()
  if (!at && !result && !note) return null
  return {
    id: run.id || `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    result: result || '完成',
    note,
    actor,
    createdAt: run.createdAt || new Date().toISOString()
  }
}

export function normalizeDeliverable(item) {
  if (!item || typeof item !== 'object') return null
  const name = String(item.name || '').trim()
  const uri = String(item.uri_or_path || item.uri || item.url || '').trim()
  if (!name && !uri) return null
  const kind = ['file', 'link', 'node', 'cos'].includes(item.kind)
    ? item.kind
    : uri
      ? /^https?:\/\//i.test(uri)
        ? 'link'
        : 'file'
      : 'file'
  return {
    id:
      item.id ||
      `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || uri,
    uri_or_path: uri,
    kind,
    at: String(item.at || '').trim(),
    createdAt: item.createdAt || new Date().toISOString()
  }
}

export function normalizeLedger(raw) {
  const base = emptyLedger()
  if (!raw || typeof raw !== 'object') return base
  const freq = raw.frequency || {}
  base.frequency = {
    label: freq.label || '未知',
    cron_hint: freq.cron_hint == null ? null : freq.cron_hint
  }
  base.runs = (Array.isArray(raw.runs) ? raw.runs : [])
    .map(normalizeRun)
    .filter(Boolean)
    .sort((a, b) => String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt)))
  base.deliverables = (Array.isArray(raw.deliverables) ? raw.deliverables : [])
    .map(normalizeDeliverable)
    .filter(Boolean)
    .sort((a, b) =>
      String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt))
    )
  return base
}

export function parseLedgerFromNote(note) {
  const text = String(note || '')
  const i = text.indexOf(LEDGER_JSON_START)
  const j = text.indexOf(LEDGER_JSON_END)
  if (i >= 0 && j > i) {
    const raw = text.slice(i + LEDGER_JSON_START.length, j).trim()
    try {
      return normalizeLedger(JSON.parse(raw))
    } catch (e) {
      /* fall through */
    }
  }
  return null
}

export function readLedgerFromNodeLike(item) {
  if (!item) return emptyLedger()
  if (item.sopLedger) return normalizeLedger(item.sopLedger)
  if (item.data && item.data.sopLedger) {
    return normalizeLedger(item.data.sopLedger)
  }
  const fromNote = parseLedgerFromNote(item.note || (item.data && item.data.note))
  if (fromNote) return fromNote
  return emptyLedger()
}

export function mergeLedgerSources(primary, fallback) {
  const a = normalizeLedger(primary)
  const b = normalizeLedger(fallback)
  const runKey = r => `${r.at}|${r.result}|${r.note}`
  const delKey = d => `${d.name}|${d.uri_or_path}`
  const runsMap = new Map()
  ;[...b.runs, ...a.runs].forEach(r => runsMap.set(runKey(r), r))
  const delsMap = new Map()
  ;[...b.deliverables, ...a.deliverables].forEach(d =>
    delsMap.set(delKey(d), d)
  )
  const frequency =
    a.frequency && a.frequency.label !== '未知'
      ? a.frequency
      : b.frequency || a.frequency
  return normalizeLedger({
    frequency,
    runs: Array.from(runsMap.values()),
    deliverables: Array.from(delsMap.values())
  })
}

export function stripLedgerBlocksFromNote(note) {
  let text = String(note || '')
  const i = text.indexOf(LEDGER_JSON_START)
  const j = text.indexOf(LEDGER_JSON_END)
  if (i >= 0 && j > i) {
    text = (text.slice(0, i) + text.slice(j + LEDGER_JSON_END.length)).trim()
  }
  // 去掉旧摘要块（从【SOP台账】到空行或文末）
  text = text.replace(
    /【SOP台账】[\s\S]*?(?=\n\n|$)/g,
    ''
  )
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

export function buildLedgerNoteSummary(sopMeta, ledger) {
  const L = normalizeLedger(ledger)
  const latestRun = L.runs[0]
  const latestDel = L.deliverables[0]
  const lines = [
    LEDGER_MARK,
    `编号: ${(sopMeta && sopMeta.id) || ''}`,
    `标题: ${(sopMeta && sopMeta.title) || ''}`,
    `频率: ${(L.frequency && L.frequency.label) || '未知'}`
  ]
  if (latestRun) {
    lines.push(
      `最近运行: ${[latestRun.at, latestRun.result, latestRun.note]
        .filter(Boolean)
        .join(' ')}`
    )
  } else {
    lines.push('最近运行: 暂无')
  }
  if (latestDel) {
    lines.push(
      `最新产物: ${latestDel.name}${
        latestDel.uri_or_path ? ` → ${latestDel.uri_or_path}` : ''
      }`
    )
  } else {
    lines.push('最新产物: 暂无')
  }
  if (L.runs.length > 1) lines.push(`历史运行: ${L.runs.length} 条`)
  if (L.deliverables.length > 1) {
    lines.push(`产物总数: ${L.deliverables.length}`)
  }
  const json = JSON.stringify({
    frequency: L.frequency,
    runs: L.runs.slice(0, 50),
    deliverables: L.deliverables.slice(0, 50)
  })
  lines.push(`${LEDGER_JSON_START}${json}${LEDGER_JSON_END}`)
  return lines.join('\n')
}

export function composeNodeNote(existingNote, sopMeta, ledger) {
  const kept = stripLedgerBlocksFromNote(existingNote)
  const summary = buildLedgerNoteSummary(sopMeta, ledger)
  return kept ? `${kept}\n\n${summary}` : summary
}

export function latestRunText(runs) {
  const list = Array.isArray(runs) ? runs : []
  if (!list.length) return '暂无'
  const r = list[0]
  return [r.at, r.result, r.note].filter(Boolean).join(' ') || '暂无'
}

export function latestDeliverableText(deliverables) {
  const list = Array.isArray(deliverables) ? deliverables : []
  if (!list.length) return '暂无'
  const d = list[0]
  const extra = list.length > 1 ? ` +${list.length - 1}` : ''
  return `${d.name || d.uri_or_path || '产物'}${extra}`
}

/** 建议的 COS/对象路径（仅作填写提示，不自动上传） */
export function suggestCosPath(roomKey, sopId, fileName) {
  const day = new Date().toISOString().slice(0, 10)
  const safeName = String(fileName || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80)
  return `mind-map/sop-runs/${roomKey || 'room'}/${sopId || 'SOP'}/${day}/${safeName}`
}

/**
 * 持久化台账到节点：data.sopLedger + note 摘要
 */
export async function persistSopLedger(roomKey, uid, sopMeta, ledger, options = {}) {
  const key = String(roomKey || '').trim()
  const nodeUid = String(uid || '').trim()
  if (!key || !nodeUid) throw new Error('缺少房间或节点')

  const { getFileNodes, patchFileNode } = await import('@/utils/fileApi')
  const normalized = normalizeLedger(ledger)

  let prevNote = options.prevNote || ''
  if (!prevNote) {
    try {
      const res = await getFileNodes(key, [nodeUid])
      const node = (res && res.nodes && res.nodes[0]) || null
      prevNote =
        (node && node.data && node.data.note) ||
        (node && node.note) ||
        ''
      if (node && node.data && node.data.sopLedger && !options.replace) {
        // 已在外部合并好则跳过
      }
    } catch (e) {
      /* keep empty */
    }
  }

  const note = composeNodeNote(prevNote, sopMeta, normalized)
  return patchFileNode(key, nodeUid, {
    sopLedger: normalized,
    note,
    confirm_sop_change: true
  })
}

export function addRunToLedger(ledger, runInput) {
  const L = normalizeLedger(ledger)
  const run = normalizeRun({
    ...runInput,
    at: runInput.at || new Date().toISOString().slice(0, 16).replace('T', ' ')
  })
  if (!run) return L
  return normalizeLedger({
    ...L,
    runs: [run, ...L.runs]
  })
}

export function addDeliverableToLedger(ledger, itemInput) {
  const L = normalizeLedger(ledger)
  const item = normalizeDeliverable({
    ...itemInput,
    at: itemInput.at || new Date().toISOString().slice(0, 10)
  })
  if (!item) return L
  return normalizeLedger({
    ...L,
    deliverables: [item, ...L.deliverables]
  })
}
