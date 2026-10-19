'use strict'
// Header heuristics (EN + 中文) and value normalisation / type inference for tabular data.
const HEADER_RULES = {
  sku: [/^sku$/i, /\bsku\b/i, /货号|商品编码|商品编号|产品编码|产品编号|物料编码|物料号|料号|款号|条码|item\s*(no|code|#)|product\s*(code|id|no)|part\s*(no|number)/i],
  price: [/^(unit\s*)?price$/i, /价格|单价|售价|零售价|含税价|销售价|price/i],
  stock: [/^(stock|qty|quantity|inventory)$/i, /库存|在库|可用量|现存量|数量|stock|qty|quantity|inventory/i],
  record_date: [/^date$/i, /日期|时间|入库日|出库日|生产日期|更新日期|date/i]
}

function normHeader(h) {
  return String(h == null ? '' : h).replace(/\s+/g, ' ').trim()
}

// Map special columns: first header matching the strictest rule wins.
function detectSpecialColumns(headers) {
  const out = {}
  for (const [key, rules] of Object.entries(HEADER_RULES)) {
    for (const rule of rules) {
      const idx = headers.findIndex((h, i) => h && rule.test(h) && !Object.values(out).includes(i))
      if (idx >= 0) { out[key] = idx; break }
    }
  }
  return out
}

function cellValue(v) {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('')
    if ('result' in v) return cellValue(v.result)
    if ('text' in v) return cellValue(v.text)
    if ('error' in v) return null
    return null
  }
  if (typeof v === 'string') { const s = v.trim(); return s === '' ? null : s }
  return v
}

function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[,，\s]/g, '').replace(/^[¥￥$€£]|元$/g, '')
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

function parseIntStrict(v) {
  const n = parseNumber(v)
  return n != null && Number.isInteger(n) && Math.abs(n) < 2147483647 ? n : null
}

function excelSerialToDate(n) {
  if (typeof n !== 'number' || n < 20000 || n > 80000) return null
  return new Date(Math.round((n - 25569) * 86400000))
}

function parseDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v
  if (typeof v === 'number') return excelSerialToDate(v)
  if (typeof v !== 'string') return null
  const m = v.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T].*)?$/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return isNaN(d) || d.getUTCMonth() !== +m[2] - 1 ? null : d
}

const isoDate = d => d.toISOString().slice(0, 10)

// Incremental type inference: tracks which types every non-null value satisfies.
function createTypeTracker() {
  const c = { n: 0, int: 0, numeric: 0, date: 0, bool: 0 }
  return {
    add(v) {
      if (v == null) return
      c.n++
      if (typeof v === 'boolean' || (typeof v === 'string' && /^(true|false|是|否)$/i.test(v))) c.bool++
      if (v instanceof Date || (typeof v === 'string' && parseDate(v)) || excelSerialToDate(v)) c.date++
      const num = typeof v === 'boolean' || v instanceof Date ? null : parseNumber(v)
      if (num != null) { c.numeric++; if (Number.isInteger(num)) c.int++ }
    },
    type() {
      if (!c.n) return 'text'
      if (c.bool === c.n) return 'bool'
      if (c.date === c.n) return 'date'
      if (c.int === c.n) return 'int'
      if (c.numeric === c.n) return 'numeric'
      return 'text'
    }
  }
}

function jsonValue(v) {
  if (v instanceof Date) return isoDate(v)
  return v
}

// Build one record from normalised row values given headers + special column map.
function buildRecord(headers, values, special) {
  const data = Object.create(null) // Column names such as __proto__ are data, not setters.
  headers.forEach((h, i) => { if (h) { const v = values[i]; if (v != null) data[h] = jsonValue(v) } })
  const pick = k => (special[k] == null ? null : values[special[k]])
  const skuRaw = pick('sku')
  const d = parseDate(pick('record_date'))
  return {
    data,
    sku: skuRaw == null ? null : String(skuRaw instanceof Date ? isoDate(skuRaw) : skuRaw).trim().slice(0, 200) || null,
    price: parseNumber(pick('price')),
    stock: parseIntStrict(pick('stock')),
    record_date: d ? isoDate(d) : null
  }
}

module.exports = { detectSpecialColumns, normHeader, cellValue, parseNumber, parseIntStrict, parseDate, createTypeTracker, buildRecord, HEADER_RULES }
