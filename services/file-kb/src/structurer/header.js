'use strict'
// Decides which rows are notes, headers, or data. Row numbers stay 1-based
// spreadsheet coordinates. Nothing here is tied to a particular workbook.
const { normHeader } = require('./fields')

function colLetter(index) {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function cellText(v) {
  if (v == null) return ''
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  return String(v).replace(/\s+/g, ' ').trim()
}

function looksLikeValue(s) {
  if (/^[-+]?\d+(\.\d+)?%?$/.test(s)) return true
  if (/[¥￥$€£]/.test(s) && /\d/.test(s)) return true
  if (/^\d{4}[-/.年]\d{1,2}/.test(s)) return true
  return false
}

function analyze(row) {
  const values = (row && row.values) || []
  let filled = 0
  let maxLen = 0
  let numeric = 0
  let valued = 0
  let long = 0
  let width = 0
  for (let i = 0; i < values.length; i++) {
    const s = cellText(values[i])
    if (!s) continue
    filled++
    width = i + 1
    if (s.length > maxLen) maxLen = s.length
    if (s.length >= 24) long++
    if (/^[-+]?\d+(\.\d+)?%?$/.test(s)) numeric++
    if (looksLikeValue(s)) valued++
  }
  return { filled, maxLen, numeric, valued, long, width, mergeSpan: (row && row.mergeSpan) || 1 }
}

function emptyRow(row) {
  return analyze(row).filled === 0
}

function mergeSpan(merges, rowNumber) {
  let span = 1
  for (const m of merges || []) {
    if (rowNumber >= m.top && rowNumber <= m.bottom) span = Math.max(span, m.right - m.left + 1)
  }
  return span
}

function distinctTexts(row) {
  return new Set(((row && row.values) || []).map(cellText).filter(Boolean))
}

function isTitle(row, next) {
  const st = analyze(row)
  if (!st.filled) return false
  const distinct = distinctTexts(row).size
  if (distinct <= 2 && st.long > 0) return true
  if (distinct === 1 && (st.mergeSpan >= 3 || st.maxLen >= 18)) return true
  if (!next) return false
  const nx = analyze(next)
  if (distinct === 1 && nx.filled >= 4 && nx.width >= Math.max(2, st.width * 2)) return true
  if (distinct <= 2 && st.maxLen >= 12 && nx.filled >= Math.max(4, st.filled * 3)) return true
  return false
}

function isHeaderCandidate(row) {
  const st = analyze(row)
  if (!st.filled || st.long > 0 || st.maxLen > 24) return false
  if (st.filled === 1) return st.maxLen <= 16 && st.numeric === 0 && st.mergeSpan < 3
  return st.mergeSpan < Math.max(4, st.width)
}

function dataDiffers(header, data) {
  const h = analyze(header)
  const d = analyze(data)
  if (!d.filled) return false
  if (d.long > 0) return true
  if (d.maxLen >= h.maxLen + 4) return true
  const hr = h.valued / h.filled
  const dr = d.valued / d.filled
  if (d.valued > h.valued && dr >= hr + 0.2) return true
  return false
}

function nextFilled(rows, start) {
  for (let i = start; i < rows.length; i++) if (!emptyRow(rows[i])) return i
  return -1
}

function uniqueHeaders(values) {
  const seen = new Map()
  return values.map((v, i) => {
    let h = normHeader(v instanceof Date ? v.toISOString().slice(0, 10) : v)
    if (!h) h = `列${i + 1}`
    const n = seen.get(h) || 0
    seen.set(h, n + 1)
    return n ? `${h}_${n + 1}` : h
  })
}

function fillRowMerges(values, rowNumber, merges) {
  const out = values.slice()
  for (const m of merges || []) {
    if (rowNumber < m.top || rowNumber > m.bottom) continue
    const master = out[m.left - 1]
    if (master == null || master === '') continue
    if (out.length < m.right) {
      for (let i = out.length; i < m.right; i++) out.push(null)
    }
    for (let c = m.left - 1; c < m.right; c++) {
      if (out[c] == null || out[c] === '') out[c] = master
    }
  }
  return out
}

function combineHeaders(rows, merges) {
  const filled = rows.map(r => fillRowMerges(r.values || [], r.number, merges))
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

function score({ notes, headerCount, differs, synthetic }) {
  if (synthetic) return 0.34
  let c = 0.52
  if (notes) c += 0.08
  if (headerCount === 1 || headerCount === 2) c += 0.1
  if (headerCount > 2) c -= 0.08
  if (differs) c += 0.22
  else c -= 0.16
  return Math.max(0.05, Math.min(0.98, Math.round(c * 100) / 100))
}

function dataEnd(rows, start) {
  if (start < 0 || start >= rows.length) return start - 1
  let end = start - 1
  let blanks = 0
  for (let i = start; i < rows.length; i++) {
    if (emptyRow(rows[i])) {
      blanks++
      if (blanks >= 2) break
      continue
    }
    blanks = 0
    end = i
  }
  return end
}

function regionFrom({ notes, headerIndexes, rows, merges, synthetic, differs, dataStartIndex, dataEndIndex }) {
  const headerRows = synthetic ? [] : headerIndexes.map(i => rows[i].number)
  let headers
  if (synthetic) {
    const width = Math.max(1, ...rows.slice(dataStartIndex, dataEndIndex + 1).map(r => (r.values || []).length))
    headers = uniqueHeaders(Array.from({ length: width }, () => ''))
  } else {
    headers = combineHeaders(headerIndexes.map(i => rows[i]), merges)
  }
  const confidence = score({ notes: notes.length, headerCount: headerRows.length, differs, synthetic })
  const dataRow = rows[dataStartIndex]
  return {
    notes,
    headerRows,
    headers,
    dataStartRow: dataRow ? dataRow.number : null,
    dataEndRow: dataEndIndex >= 0 && rows[dataEndIndex] ? rows[dataEndIndex].number : null,
    confidence,
    needsConfirmation: !!(synthetic || !differs || confidence < 0.72),
    synthetic: !!synthetic,
    confirmed: false
  }
}

function detectLayout(input, merges = [], opts = {}) {
  const partial = !!opts.partial
  const rows = (input || []).map(r => ({ ...r, mergeSpan: r.mergeSpan || mergeSpan(merges, r.number) }))
  const regions = []
  let i = 0
  while (i < rows.length) {
    while (i < rows.length && emptyRow(rows[i])) i++
    if (i >= rows.length) break
    const notes = []
    while (i < rows.length && isTitle(rows[i], rows[nextFilled(rows, i + 1)] || null)) {
      const text = (rows[i].values || []).map(cellText).filter(Boolean).join(' ')
      if (text) notes.push({ number: rows[i].number, text })
      i++
      while (i < rows.length && emptyRow(rows[i])) {
        const n = nextFilled(rows, i + 1)
        if (n >= 0 && isTitle(rows[n], rows[nextFilled(rows, n + 1)] || null)) i++
        else break
      }
    }
    while (i < rows.length && emptyRow(rows[i])) i++
    if (i >= rows.length) {
      if (notes.length) {
        regions.push({
          notes, headerRows: [], headers: [], dataStartRow: null, dataEndRow: null,
          confidence: 0.2, needsConfirmation: true, synthetic: true, confirmed: false
        })
      }
      break
    }
    const pendingHeaders = partial && isHeaderCandidate(rows[i]) && nextFilled(rows, i + 1) < 0
    if (pendingHeaders) return { regions, pending: true, needsConfirmation: true }

    const headerIndexes = []
    let cursor = i
    let ambiguous = false
    while (headerIndexes.length < 3 && cursor < rows.length && isHeaderCandidate(rows[cursor])) {
      const nxt = nextFilled(rows, cursor + 1)
      if (nxt < 0) {
        headerIndexes.push(cursor)
        break
      }
      if (isHeaderCandidate(rows[nxt]) && !dataDiffers(rows[cursor], rows[nxt])) {
        const after = nextFilled(rows, nxt + 1)
        if (after >= 0 && (dataDiffers(rows[nxt], rows[after]) || dataDiffers(rows[cursor], rows[after])) && headerIndexes.length < 2) {
          headerIndexes.push(cursor)
          cursor = nxt
          continue
        }
        if (partial && after < 0) return { regions, pending: true, needsConfirmation: true }
        if (!headerIndexes.length && !dataDiffers(rows[cursor], rows[nxt])) ambiguous = true
        headerIndexes.push(cursor)
        break
      }
      headerIndexes.push(cursor)
      break
    }

    const lastH = headerIndexes.length ? headerIndexes[headerIndexes.length - 1] : -1
    const dataAt = lastH >= 0 ? nextFilled(rows, lastH + 1) : i
    const differs = lastH >= 0 && dataAt >= 0 && headerIndexes.some(idx => dataDiffers(rows[idx], rows[dataAt]))
    if ((!headerIndexes.length || (!differs && ambiguous))) {
      if (partial && rows.slice(i).every(r => emptyRow(r) || isHeaderCandidate(r))) {
        return { regions, pending: true, needsConfirmation: true }
      }
      const end = dataEnd(rows, i)
      regions.push(regionFrom({
        notes, headerIndexes: [], rows, merges, synthetic: true, differs: false,
        dataStartIndex: i, dataEndIndex: end
      }))
      i = end + 1
      continue
    }
    const start = dataAt >= 0 ? dataAt : lastH + 1
    const end = dataEnd(rows, start)
    regions.push(regionFrom({
      notes, headerIndexes, rows, merges, synthetic: false, differs,
      dataStartIndex: start < rows.length ? start : rows.length - 1,
      dataEndIndex: end
    }))
    i = end + 1
  }
  if (partial) {
    if (!regions.length) return { regions, pending: true, needsConfirmation: true }
    const last = regions[regions.length - 1]
    const hasData = rows.some(r => last.dataStartRow && r.number >= last.dataStartRow && !emptyRow(r) && !last.headerRows.includes(r.number))
    if (!hasData) return { regions, pending: true, needsConfirmation: true }
  }
  return {
    regions,
    pending: false,
    needsConfirmation: regions.length === 0 || regions.some(r => r.needsConfirmation)
  }
}

function shouldPublish({ needsConfirmation, confirmed } = {}) {
  return confirmed === true || needsConfirmation !== true
}

module.exports = {
  detectLayout, combineHeaders, uniqueHeaders, colLetter, cellText, mergeSpan,
  shouldPublish, analyze, fillRowMerges
}
