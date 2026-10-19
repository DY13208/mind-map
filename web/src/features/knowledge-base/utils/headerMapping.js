// Excel 表头与字段映射的纯函数（无 Vue / 网络依赖，便于 node 测试）。
// 行号一律是 Excel 中用户看到的 1 基行号；列用 0 基 index（与后端 col_index / columnOverrides.index 一致）。
// 自动列名的推导与后端 services/file-kb/src/structurer/header.js#combineHeaders 保持同一规则：
// 合并单元格向右/向下填充 → 多行表头按列用「 / 」拼接（相邻重复去掉）→ 去掉尾部空列 → 空名补「列N」→ 重名加 _2、_3。
// 最终字段名以后端按原表计算为准；前端只把「用户明确改过的名字」作为 columnOverrides 发送。

export const MAX_COLUMNS = 500 // 与后端 columnOverrides.index < 500 一致
export const MAX_NAME_LENGTH = 200 // 与后端 name.length <= 200 一致

export function colLetter(index) {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export function cellText(v) {
  if (v == null) return ''
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('').replace(/\s+/g, ' ').trim()
    if (v.text != null) return String(v.text).replace(/\s+/g, ' ').trim()
    if (v.result != null) return cellText(v.result)
  }
  return String(v).replace(/\s+/g, ' ').trim()
}

function normHeader(h) {
  return String(h == null ? '' : h).replace(/\s+/g, ' ').trim()
}

export function uniqueHeaders(values) {
  const seen = new Map()
  return values.map((v, i) => {
    let h = normHeader(v instanceof Date ? v.toISOString().slice(0, 10) : v)
    if (!h) h = `列${i + 1}`
    const n = seen.get(h) || 0
    seen.set(h, n + 1)
    return n ? `${h}_${n + 1}` : h
  })
}

// merges: [{ top, left, bottom, right }]，均为 1 基（与后端 parseA1Range 一致）
export function fillRowMerges(values, rowNumber, merges) {
  const out = (values || []).slice()
  for (const m of merges || []) {
    if (rowNumber < m.top || rowNumber > m.bottom) continue
    const master = out[m.left - 1]
    if (master == null || master === '') continue
    for (let i = out.length; i < m.right; i++) out.push(null)
    for (let c = m.left - 1; c < m.right; c++) {
      if (out[c] == null || out[c] === '') out[c] = master
    }
  }
  return out
}

// rows: [{ number, values }]
export function combineHeaders(rows, merges) {
  const filled = rows.map(r => fillRowMerges(r.values || [], r.number, merges).slice(0, MAX_COLUMNS))
  const width = filled.reduce((m, r) => Math.max(m, r.length), 0)
  const names = []
  for (let c = 0; c < width; c++) {
    const parts = []
    for (const row of filled) {
      const s = cellText(row[c])
      if (!s) continue
      if (parts[parts.length - 1] !== s) parts.push(s)
    }
    names.push(parts.join(' / '))
  }
  while (names.length && !cellText(names[names.length - 1])) names.pop()
  return uniqueHeaders(names)
}

// SheetJS 的 !merges（0 基 {s:{r,c},e:{r,c}}）转换成 1 基
export function mergesFromSheetJs(list) {
  return (list || []).map(m => ({ top: m.s.r + 1, left: m.s.c + 1, bottom: m.e.r + 1, right: m.e.c + 1 }))
}

// aoa[i] 对应 Excel 第 originRow + i 行（读取时强制从 A1 开始，所以 originRow = 1）
export function rowsFromAoa(aoa, originRow = 1) {
  return (aoa || []).map((values, i) => ({ number: originRow + i, values: (values || []).slice(0, MAX_COLUMNS) }))
}

// "2" / "2,3" / "2-3" / "2，3" → [2,3]；非法片段返回 null
export function parseRowList(text) {
  const parts = String(text == null ? '' : text).split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
  const out = []
  for (const p of parts) {
    const m = /^(\d+)(?:\s*[-~～]\s*(\d+))?$/.exec(p)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b - a > 20) return null
    for (let n = a; n <= b; n++) out.push(n)
  }
  return normalizeRows(out)
}

export function normalizeRows(list) {
  return [...new Set((list || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
}

export function formatRowList(rows) {
  return (rows || []).join(', ')
}

function rowIsBlank(values) {
  return !(values || []).some(v => cellText(v) !== '')
}

// 后端 layout 的一张 sheet → 前端可编辑状态。每张 sheet 一份，互不共享对象。
export function createSheetState(layoutSheet) {
  const s = layoutSheet || {}
  const regions = Array.isArray(s.regions) ? s.regions : []
  const first = regions[0] || {}
  const columns = Array.isArray(s.columns) ? s.columns : []
  const headerRows = normalizeRows(s.headerRows)
  const dataStartRow = Number.isInteger(Number(s.dataStartRow)) && Number(s.dataStartRow) > 0 ? Number(s.dataStartRow) : null
  const confirmed = s.confirmed === true
  return {
    name: String(s.name || ''),
    detection: {
      // 只展示后端给的值；后端未给时为 null，界面不编造
      confidence: s.confidence == null || confirmed ? null : Number(s.confidence),
      needsConfirmation: s.needsConfirmation === true,
      confirmed,
      reason: s.reason || first.reason || null,
      regionCount: regions.length,
      detectedNotes: Array.isArray(first.notes) ? first.notes.slice() : []
    },
    // 后端 layout 的 rowCount / columnCount（ExcelJS 口径）；旧版本后端没有时为 null
    rowCount: Number.isInteger(s.rowCount) ? s.rowCount : null,
    columnCount: Number.isInteger(s.columnCount) ? s.columnCount : null,
    emptyHeaderRows: [],
    baseline: { headerRows: headerRows.slice(), dataStartRow },
    headerRows,
    dataStartRow,
    // autoSource：backend = 后端给的名字；recomputed = 前端按当前表头行重新推导
    autoSource: 'backend',
    fields: columns.map(c => ({ index: Number(c.index), letter: c.letter || colLetter(Number(c.index)), auto: String(c.name == null ? '' : c.name), user: null, saved: false })),
    pendingRows: [],
    include: true,
    reviewed: false,
    dirty: false,
    savedInferred: false
  }
}

function fieldAt(state, index) {
  return state.fields.find(f => f.index === index) || null
}

// 已确认版本的列名里包含上次的人工改名。若手里有表头原始值，把与原始推导不同的列标为「已保存的人工名称」，
// 这样重新提交时仍会作为 columnOverrides 发送，不会丢；与原始推导相同的列仍视为自动。
export function inferSavedOverrides(state, getRow, merges) {
  if (state.savedInferred || !state.detection.confirmed) return false
  const rows = state.headerRows.map(n => getRow(n))
  if (!rows.length || rows.some(r => !r)) return false
  const raw = combineHeaders(rows, merges)
  state.fields.forEach(f => {
    const auto = raw[f.index] != null ? raw[f.index] : `列${f.index + 1}`
    if (f.user == null && f.auto !== auto) {
      f.user = f.auto
      f.saved = true
    }
    f.auto = auto
  })
  state.savedInferred = true
  return true
}

// 按当前表头行重新推导自动列名。用户改过（user != null）的列按列号保留，不会被覆盖。
// getRow(n) 返回 { number, values } 或 null（该行尚未读取）。
export function recomputeFields(state, getRow, merges) {
  const missing = state.headerRows.filter(n => !getRow(n))
  state.pendingRows = missing
  if (missing.length) return false
  const rows = state.headerRows.map(n => getRow(n))
  state.emptyHeaderRows = rows.filter(r => rowIsBlank(r.values)).map(r => r.number)
  const auto = rows.length ? combineHeaders(rows, merges) : []
  const keep = new Map(state.fields.filter(f => f.user != null).map(f => [f.index, f]))
  const width = Math.max(auto.length, ...[...keep.keys()].map(i => i + 1), 0)
  const next = []
  for (let i = 0; i < width; i++) {
    const prev = keep.get(i)
    next.push({ index: i, letter: colLetter(i), auto: auto[i] != null ? auto[i] : `列${i + 1}`, user: prev ? prev.user : null, saved: prev ? prev.saved : false })
  }
  state.fields = next
  state.autoSource = 'recomputed'
  return true
}

function touch(state) {
  state.dirty = true
  state.reviewed = false
}

export function setHeaderRows(state, rows, getRow, merges) {
  state.headerRows = normalizeRows(rows)
  touch(state)
  return recomputeFields(state, getRow, merges)
}

export function toggleHeaderRow(state, n, getRow, merges) {
  const has = state.headerRows.includes(n)
  const rows = has ? state.headerRows.filter(x => x !== n) : state.headerRows.concat(n)
  const ok = setHeaderRows(state, rows, getRow, merges)
  const last = state.headerRows[state.headerRows.length - 1]
  // 只在数据起始行为空时给一个默认值；已经设置的起始行不自动改，由校验提示冲突
  if (!has && last && !state.dataStartRow) state.dataStartRow = last + 1
  return ok
}

export function setDataStartRow(state, n) {
  const v = Number(n)
  state.dataStartRow = Number.isInteger(v) && v > 0 ? v : null
  touch(state)
}

export function setFieldName(state, index, name) {
  const f = fieldAt(state, index)
  if (!f) return
  const v = String(name == null ? '' : name)
  if (v.trim() === f.auto && !f.saved) f.user = null
  else f.user = v
  touch(state)
}

export function resetFieldName(state, index) {
  const f = fieldAt(state, index)
  if (!f) return
  f.user = null
  f.saved = false
  touch(state)
}

export function fieldSource(f) {
  if (f.user == null) return 'auto'
  return f.saved ? 'saved' : 'user'
}

export function effectiveFields(state) {
  return state.fields.map(f => ({ index: f.index, letter: f.letter, name: f.user != null ? f.user.trim() : f.auto, source: fieldSource(f), auto: f.auto }))
}

export function markReviewed(state, value = true) {
  state.reviewed = !!value
}

// 一张 sheet 的问题列表（中文）。空数组表示可以提交。
export function validateSheet(state, { maxKnownRow = null } = {}) {
  const errors = []
  const label = n => `第 ${n} 行`
  if (!state.headerRows.length) errors.push('未选择表头行')
  if (!state.dataStartRow) errors.push('未设置数据起始行')
  const lastHeader = state.headerRows[state.headerRows.length - 1]
  if (state.dataStartRow && lastHeader && state.dataStartRow <= lastHeader) {
    errors.push(`数据起始行（${label(state.dataStartRow)}）必须在最后一个表头行（${label(lastHeader)}）之后`)
  }
  const rowCount = state.rowCount
  if (rowCount != null) {
    const out = state.headerRows.filter(n => n > rowCount)
    if (out.length) errors.push(`表头行 ${out.join('、')} 超出工作表范围（共 ${rowCount} 行）`)
    if (state.dataStartRow && state.dataStartRow > rowCount) errors.push(`数据起始行（${label(state.dataStartRow)}）之后没有数据（工作表共 ${rowCount} 行）`)
  } else if (maxKnownRow != null) {
    const out = state.headerRows.filter(n => n > maxKnownRow)
    if (out.length) errors.push(`表头行 ${out.join('、')} 超出已读取范围（${maxKnownRow} 行），请先读取原文件确认`)
  }
  if (state.emptyHeaderRows && state.emptyHeaderRows.length) errors.push(`表头行 ${state.emptyHeaderRows.join('、')} 是空行，不能作为表头`)
  if (state.pendingRows.length) errors.push(`表头行 ${state.pendingRows.join('、')} 尚未读取，无法计算字段名，请读取原文件`)
  const fields = effectiveFields(state)
  if (state.headerRows.length && !state.pendingRows.length && !fields.length) errors.push('所选表头行没有任何字段名')
  fields.forEach(f => {
    if (f.source !== 'auto' && state.columnCount != null && f.index >= state.columnCount) errors.push(`列 ${f.letter} 超出工作表列数（共 ${state.columnCount} 列），请恢复自动或删除该改名`)
    if (f.source !== 'auto' && !f.name) errors.push(`列 ${f.letter} 的字段名不能为空（可点「恢复自动」）`)
    if (f.name.length > MAX_NAME_LENGTH) errors.push(`列 ${f.letter} 的字段名超过 ${MAX_NAME_LENGTH} 个字符`)
  })
  const byName = new Map()
  fields.forEach(f => {
    if (!f.name) return
    const list = byName.get(f.name) || []
    list.push(f.letter)
    byName.set(f.name, list)
  })
  byName.forEach((letters, name) => {
    if (letters.length > 1) errors.push(`字段名重复：「${name}」（列 ${letters.join('、')}）`)
  })
  const confirmedUnchanged = state.detection.confirmed && !state.dirty
  if (!state.reviewed && !confirmedUnchanged) errors.push('尚未勾选「已核对此工作表」')
  return errors
}

export function validateAll(states, opts = {}) {
  const sheets = (states || []).map(s => ({ name: s.name, include: s.include, errors: s.include ? validateSheet(s, (opts.maxKnownRow && opts.maxKnownRow(s)) != null ? { maxKnownRow: opts.maxKnownRow(s) } : {}) : [] }))
  const included = sheets.filter(s => s.include)
  const global = []
  if (!included.length) global.push('至少要选择一个工作表参与本次结构化')
  return { ok: !global.length && included.every(s => !s.errors.length), global, sheets }
}

// 只发送用户明确改过的列名（columnOverrides）；未改的列由后端按原表表头计算。
// 不发送旧的 columns 快照，避免换表头后把旧猜测名写回（审计 P1-05）。
export function buildStructurePayload(states) {
  return {
    sheets: (states || []).filter(s => s.include).map(s => ({
      sheet: s.name,
      headerRows: s.headerRows.slice(),
      dataStartRow: s.dataStartRow,
      columnOverrides: s.fields.filter(f => f.user != null).map(f => ({ index: f.index, name: f.user.trim() }))
    }))
  }
}

// 数据样例：从数据起始行开始，跳过表头行与空行；row 为 Excel 行号（1 基）。
export function dataSample(state, getRow, { limit = 5, scan = 200, maxRow = null } = {}) {
  const out = []
  if (!state.dataStartRow) return { rows: out, incomplete: false }
  let incomplete = false
  const end = state.dataStartRow + scan
  for (let n = state.dataStartRow; n < end && out.length < limit; n++) {
    if (maxRow != null && n > maxRow) break
    if (state.headerRows.includes(n)) continue
    const r = getRow(n)
    if (!r) { incomplete = true; break }
    if (rowIsBlank(r.values)) continue
    out.push({ row: n, values: state.fields.map(f => cellText(r.values[f.index])) })
  }
  return { rows: out, incomplete }
}

// 数据起始行之前、非表头的非空行：保留为说明原文，不作为字段
export function noteRows(state, getRow, { maxScan = 200 } = {}) {
  const out = []
  const stop = Math.min((state.dataStartRow || 1) - 1, maxScan)
  for (let n = 1; n <= stop; n++) {
    if (state.headerRows.includes(n)) continue
    const r = getRow(n)
    if (!r) continue
    const text = (r.values || []).map(cellText).filter(Boolean).join(' ')
    if (text) out.push({ row: n, text })
  }
  return out
}

export function rowRole(state, n) {
  if (state.headerRows.includes(n)) return 'header'
  if (state.dataStartRow && n >= state.dataStartRow) return 'data'
  return 'note'
}
