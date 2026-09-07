/**
 * sopLedger 纯逻辑冒烟（CJS 内联复刻关键行为）
 */
function emptyLedger() {
  return { frequency: { label: '未知', cron_hint: null }, runs: [], deliverables: [] }
}

function normalizeRun(run) {
  if (!run || typeof run !== 'object') return null
  const at = String(run.at || '').trim()
  const result = String(run.result || '').trim()
  const note = String(run.note || '').trim()
  if (!at && !result && !note) return null
  return {
    id: run.id || 'r1',
    at,
    result: result || '完成',
    note,
    actor: String(run.actor || '').trim(),
    createdAt: run.createdAt || 't'
  }
}

function normalizeDeliverable(item) {
  if (!item || typeof item !== 'object') return null
  const name = String(item.name || '').trim()
  const uri = String(item.uri_or_path || '').trim()
  if (!name && !uri) return null
  return {
    id: item.id || 'd1',
    name: name || uri,
    uri_or_path: uri,
    kind: item.kind || 'file',
    at: String(item.at || '').trim(),
    createdAt: item.createdAt || 't'
  }
}

function normalizeLedger(raw) {
  const base = emptyLedger()
  if (!raw || typeof raw !== 'object') return base
  const freq = raw.frequency || {}
  base.frequency = {
    label: freq.label || '未知',
    cron_hint: freq.cron_hint == null ? null : freq.cron_hint
  }
  base.runs = (Array.isArray(raw.runs) ? raw.runs : []).map(normalizeRun).filter(Boolean)
  base.deliverables = (Array.isArray(raw.deliverables) ? raw.deliverables : [])
    .map(normalizeDeliverable)
    .filter(Boolean)
  return base
}

function mergeLedgerSources(primary, fallback) {
  const a = normalizeLedger(primary)
  const b = normalizeLedger(fallback)
  const runKey = r => `${r.at}|${r.result}|${r.note}`
  const delKey = d => `${d.name}|${d.uri_or_path}`
  const runsMap = new Map()
  ;[...b.runs, ...a.runs].forEach(r => runsMap.set(runKey(r), r))
  const delsMap = new Map()
  ;[...b.deliverables, ...a.deliverables].forEach(d => delsMap.set(delKey(d), d))
  const frequency =
    a.frequency && a.frequency.label !== '未知' ? a.frequency : b.frequency || a.frequency
  return normalizeLedger({
    frequency,
    runs: Array.from(runsMap.values()),
    deliverables: Array.from(delsMap.values())
  })
}

const LEDGER_JSON_START = '<!--SOP_LEDGER:'
const LEDGER_JSON_END = ':SOP_LEDGER-->'

function composeNodeNote(existingNote, sopMeta, ledger) {
  const L = normalizeLedger(ledger)
  const lines = [
    '【SOP台账】',
    `编号: ${(sopMeta && sopMeta.id) || ''}`,
    `标题: ${(sopMeta && sopMeta.title) || ''}`,
    `频率: ${(L.frequency && L.frequency.label) || '未知'}`,
    `${LEDGER_JSON_START}${JSON.stringify({
      frequency: L.frequency,
      runs: L.runs,
      deliverables: L.deliverables
    })}${LEDGER_JSON_END}`
  ]
  const kept = String(existingNote || '').trim()
  return kept ? `${kept}\n\n${lines.join('\n')}` : lines.join('\n')
}

const merged = mergeLedgerSources(
  { runs: [{ at: '2026-09-01', result: '完成', note: 'a' }], frequency: { label: '每天' } },
  {
    runs: [{ at: '2026-09-01', result: '完成', note: 'a' }, { at: '2026-09-02', result: '完成', note: 'b' }],
    deliverables: [{ name: '报表.xlsx', uri_or_path: 'cos://x' }]
  }
)
if (merged.runs.length !== 2) throw new Error('runs merge failed')
if (merged.deliverables.length !== 1) throw new Error('dels merge failed')
if (merged.frequency.label !== '每天') throw new Error('freq merge failed')

const note = composeNodeNote('原备注', { id: 'D2', title: '采购目标' }, merged)
if (!note.includes('【SOP台账】') || !note.includes(LEDGER_JSON_START)) {
  throw new Error('note compose failed')
}
if (!note.includes('原备注')) throw new Error('kept note lost')

console.log('smoke-sop-ledger: ok')
