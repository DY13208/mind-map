'use strict'
// Streaming XLSX reader (exceljs WorkbookReader). Header rows are detected from
// the sheet itself; records keep the spreadsheet's original row numbers.
const fs = require('fs')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const { detectSpecialColumns, cellValue, createTypeTracker, buildRecord } = require('./fields')
const { detectLayout, combineHeaders, uniqueHeaders, cellText, mergeSpan, colLetter } = require('./header')
const { detectForm, buildForm, validForm } = require('../shared/excelForm')

function rowValues(row) {
  const raw = Array.isArray(row.values) ? row.values.slice(1) : [] // exceljs is 1-based
  return raw.map(cellValue)
}

function decodeXml(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

function colNum(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function parseA1Range(ref) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
  if (!m) return null
  return { top: Number(m[2]), left: colNum(m[1]), bottom: Number(m[4]), right: colNum(m[3]) }
}

function zipPath(target) {
  const t = String(target || '').replace(/^\/+/, '')
  return t.startsWith('xl/') ? t : `xl/${t}`
}

// workbook.xml sheet order is the authority. Stream worksheet ids are not.
async function workbookParts(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const wbEntry = zip.file('xl/workbook.xml')
  if (!wbEntry) return []
  const wb = await wbEntry.async('string')
  const relEntry = zip.file('xl/_rels/workbook.xml.rels')
  const rels = relEntry ? await relEntry.async('string') : ''
  const relMap = new Map()
  const relRe = /<Relationship\b[^>]*>/g
  let match
  while ((match = relRe.exec(rels))) {
    const id = /Id="([^"]+)"/.exec(match[0])
    const target = /Target="([^"]+)"/.exec(match[0])
    if (id && target) relMap.set(id[1], decodeXml(target[1]))
  }
  const sheets = []
  sheets.hasSharedStrings = !!zip.file('xl/sharedStrings.xml')
  const sheetRe = /<sheet\b[^>]*>/g
  while ((match = sheetRe.exec(wb))) {
    const tag = match[0]
    const name = /name="([^"]+)"/.exec(tag)
    const rid = /r:id="([^"]+)"/.exec(tag)
    const merges = []
    let rowCount = null, columnCount = null
    const target = rid ? relMap.get(rid[1]) : ''
    const entry = target ? zip.file(zipPath(target)) : null
    if (entry) {
      const xml = await entry.async('string')
      const dim = /<dimension\b[^>]*\bref="([^"]+)"/.exec(xml)
      const size = dim && /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(dim[1])
      if (size) { rowCount = Number(size[4] || size[2]); columnCount = colNum(size[3] || size[1]) }
      const mergeRe = /<mergeCell\b[^>]*\bref="([^"]+)"/g
      let cell
      while ((cell = mergeRe.exec(xml))) {
        const parsed = parseA1Range(cell[1])
        if (parsed) merges.push(parsed)
      }
    }
    sheets.push({ name: name ? decodeXml(name[1]) : `Sheet${sheets.length + 1}`, target: zipPath(target).replace(/\/\.\//g, '/'), merges, rowCount, columnCount })
  }
  return sheets
}

function resolveNames(reader) {
  const out = new Map()
  const rels = new Map((reader.workbookRels || []).map(x => [x.Id, x.Target]))
  for (const sh of (reader.model && reader.model.sheets) || []) {
    const m = /sheet(\d+)\.xml$/.exec(rels.get(sh.rId) || '')
    if (m) out.set(`#${m[1]}`, sh.name)
  }
  return out
}

async function sheetNames(filePath) {
  const parts = await workbookParts(filePath)
  if (parts.length) return new Map(parts.map((s, i) => [i + 1, s.name]))
  const r = new ExcelJS.stream.xlsx.WorkbookReader(filePath, { worksheets: 'emit', sharedStrings: 'ignore', styles: 'ignore', hyperlinks: 'ignore', entries: 'ignore' })
  for await (const ws of r) { for await (const _ of ws) { /* drain */ } }
  const names = resolveNames(r)
  return new Map([...names].map(([k, v]) => [Number(k.slice(1)), v]))
}

function applyNames(headers, columns) {
  if (!columns || !columns.length) return headers
  const next = headers.slice()
  for (const col of columns) {
    if (!Number.isInteger(col.index) || col.index < 0 || col.index >= 500 || !col.name) continue
    while (next.length <= col.index) next.push('')
    next[col.index] = col.name
  }
  return uniqueHeaders(next)
}

function layoutFor(layout, sheetName) {
  const sheets = layout && layout.sheets
  if (!Array.isArray(sheets)) return null
  return sheets.find(s => s && s.sheet === sheetName) || null
}

function excelReader(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', worksheets: 'emit'
  })
  // Some producers put workbook.xml after sharedStrings and worksheets. ExcelJS
  // dereferences model.sheets before reading that entry; our own relations are
  // already available, so a placeholder is sufficient until it reads the model.
  reader.model = { sheets: [] }
  // ZIP entry order is independent of workbook tab order. The entry event keeps
  // the physical sheet number even when ExcelJS replaces WorksheetReader.id.
  reader.on('entry', e => { if (e.type === 'worksheet') reader.sheetTarget = `xl/worksheets/sheet${e.id}.xml` })
  return reader
}

function streamPart(reader, parts) {
  const index = parts.findIndex(p => p.target === reader.sheetTarget)
  if (index < 0) throw new Error('Cannot resolve worksheet relationship: ' + reader.sheetTarget)
  return { part: parts[index], key: `#${index + 1}` }
}

async function* readWorksheets(filePath, parts) {
  const reader = excelReader(filePath)
  const seen = new Set()
  for await (const ws of reader) {
    // ExcelJS can yield a deferred worksheet without having cached shared
    // strings (ZIP/chunk order dependent). Never convert unresolved objects
    // into nulls: fall back before emitting any rows from this worksheet.
    if (parts.hasSharedStrings && !reader.sharedStrings) {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filePath)
      for (let i = 0; i < parts.length; i++) {
        const key = `#${i + 1}`
        if (seen.has(key)) continue
        const sheet = wb.getWorksheet(parts[i].name)
        if (!sheet) throw new Error('Missing worksheet: ' + parts[i].name)
        yield { part: parts[i], key, rows: (async function* () {
          for (let n = 1; n <= sheet.rowCount; n++) yield sheet.getRow(n)
        })() }
      }
      return
    }
    const bound = streamPart(reader, parts)
    seen.add(bound.key)
    yield { ...bound, rows: ws }
  }
}

async function consumeForm(sheetKey, rows, merges, config, { onBatch, total, maxRows }) {
  const width = Math.max(...rows.map(r => r.values.length), 0)
  if (!validForm(config.form, width)) throw new Error('纵向表单列映射无效')
  const entries = buildForm(rows, merges, config)
  if (config.confirmed && !entries.length) throw new Error('纵向表单没有可入库的字段')
  if (entries.length > 500) throw new Error('纵向表单超过 500 个字段，请拆分工作表后重试')
  if ((config.columns || []).some(c => c.index >= entries.length)) throw new Error('纵向表单字段改名超出实际字段范围')
  const headers = applyNames(entries.map(e => e.name), config.columns)
  const trackers = entries.map(e => { const t = createTypeTracker(); t.add(e.value); return t })
  const end = rows.length ? rows[rows.length - 1].number : config.dataStartRow
  const region = { ...config, headers, trackers, special: {}, dataEndRow: end, confirmed: config.confirmed === true,
    fieldSources: entries.map(({ value, ...source }, i) => ({ ...source, name: headers[i], originalName: source.name })) }
  const notes = rows.filter(r => !(config.headerRows || []).includes(r.number)).map(r => ({
    sheet: sheetKey, row: r.number, text: (r.values || []).map(cellText).filter(Boolean).join(' | ')
  })).filter(r => r.text)
  if (entries.length && total.n < maxRows) {
    const record = buildRecord(headers, entries.map(e => e.value), {})
    headers.forEach((h, i) => { if (entries[i].value == null) record.data[h] = null })
    if (onBatch) await onBatch([{ sheet: sheetKey, table_index: 0, row_index: entries[0].row - 1,
      cell_range: `A${config.dataStartRow}:${colLetter(Math.max(...rows.map(r => r.values.length), 1) - 1)}${end}`, ...record }])
    total.n++
  }
  return { regions: [region], notes, rows: entries.length ? 1 : 0 }
}

async function consumeSheet(sheetKey, rows, options) {
  if (options.userRegion && options.userRegion.mode === 'skip') {
    const notes = []
    for await (const row of rows) {
      const text = (row.values || []).map(cellText).filter(Boolean).join(' | ')
      if (text) notes.push({ sheet: sheetKey, row: row.number, text })
      if (notes.length > 20000) throw new Error('辅助表超过 20000 个非空行，请拆分工作表后重试')
    }
    return { rows: 0, notes, regions: [{ mode: 'skip', headerRows: [], headers: [], trackers: [], special: {},
      dataStartRow: null, confidence: 1, confirmed: true, needsConfirmation: false }] }
  }
  const iterator = rows[Symbol.asyncIterator]()
  const probe = []
  for (let i = 0; i < 40; i++) {
    const step = await iterator.next()
    if (step.done) break
    probe.push(step.value)
  }
  const detected = options.userRegion ? null : detectForm(probe)
  const config = options.userRegion || detected
  if (config && config.mode === 'form') {
    const all = probe.slice()
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
      if (all.length >= 20000) throw new Error('纵向表单超过 20000 行，请拆分工作表后重试')
      all.push(step.value)
    }
    return consumeForm(sheetKey, all, options.merges, { ...config, confirmed: !!options.userRegion,
      confidence: options.userRegion ? 1 : config.confidence, needsConfirmation: !options.userRegion }, options)
  }
  return consume(sheetKey, (async function* () {
    yield* probe
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) yield step.value
  })(), options)
}

async function* withRowGaps(input) {
  let previous=0
  for await(const row of input){
    // WorkbookReader can omit physically empty <row> elements. Two real empty
    // spreadsheet rows still delimit a table, regardless of ZIP chunk boundaries.
    if(previous)for(let n=previous+1;n<row.number && n<=previous+2;n++)yield {number:n,values:[],mergeSpan:1}
    yield row;previous=row.number
  }
}

async function consume(sheetKey, rows, { merges, userRegion, onBatch, batchSize, maxRows, total }) {
  rows=withRowGaps(rows)
  const regions = []
  const notes = []
  let batch = []
  let sheetRows = 0
  async function flush() {
    if (batch.length && onBatch) await onBatch(batch)
    batch = []
  }
  function begin(layoutRegion) {
    const region = {
      ...layoutRegion,
      special: detectSpecialColumns(layoutRegion.headers || []),
      trackers: (layoutRegion.headers || []).map(() => createTypeTracker())
    }
    regions.push(region)
    for (const n of region.notes || []) notes.push({ sheet: sheetKey, row: n.number, text: n.text })
    return region
  }
  async function emit(region, row) {
    if (!region || total.n >= maxRows) return
    const values = row.values || []
    if (!values.some(v => v != null && v !== '')) return
    values.forEach((v, i) => { if (region.trackers[i]) region.trackers[i].add(v) })
    region.dataEndRow = row.number
    batch.push({ sheet: sheetKey, table_index: regions.indexOf(region), cell_range: `A${row.number}:${colLetter(Math.max(0, region.headers.length-1))}${row.number}`, row_index: row.number - 1, ...buildRecord(region.headers, values, region.special) })
    sheetRows++
    total.n++
    if (batch.length >= batchSize) await flush()
  }
  function emitWindow(region, window) {
    const jobs = []
    for (const r of window) {
      if (!region.dataStartRow || r.number < region.dataStartRow) continue
      if ((region.headerRows || []).includes(r.number)) continue
      jobs.push(r)
    }
    return jobs
  }

  // A confirmed region ends at the same boundary automatic detection uses (two blank rows);
  // later tables on the sheet fall through to automatic detection with their own table_index.
  if (userRegion) {
    const it = rows[Symbol.asyncIterator]()
    const buffered = []
    let region = null
    let gap = 0
    let ended = false
    for (let step = await it.next(); !step.done; step = await it.next()) {
      const row = step.value
      if (row.number < userRegion.dataStartRow) { buffered.push(row); continue }
      if (region && region.dataEndRow) {
        if (!(row.values || []).some(v => v != null && v !== '')) {
          if (++gap >= 2) { ended = true; break }
          continue
        }
        gap = 0
      }
      if (!region) {
        const headerRows = userRegion.headerRows.map(n => buffered.find(r => r.number === n)).filter(Boolean)
        const headers = applyNames(headerRows.length ? combineHeaders(headerRows, merges) : [], userRegion.columns)
        const noteRows = []
        for (const r of buffered) {
          if (userRegion.headerRows.includes(r.number)) continue
          const text = (r.values || []).map(cellText).filter(Boolean).join(' ')
          if (text) noteRows.push({ number: r.number, text })
        }
        region = begin({
          notes: noteRows, headerRows: userRegion.headerRows.slice(), headers,
          dataStartRow: userRegion.dataStartRow, dataEndRow: null,
          confidence: 1, needsConfirmation: false, synthetic: false, confirmed: true
        })
      }
      await emit(region, row)
    }
    if (!region && buffered.length) {
      const headerRows = userRegion.headerRows.map(n => buffered.find(r => r.number === n)).filter(Boolean)
      const headers = applyNames(headerRows.length ? combineHeaders(headerRows, merges) : [], userRegion.columns)
      begin({
        notes: [], headerRows: userRegion.headerRows.slice(), headers,
        dataStartRow: userRegion.dataStartRow, dataEndRow: null,
        confidence: 1, needsConfirmation: false, synthetic: false, confirmed: true
      })
    }
    if (!ended) {
      await flush()
      return { regions, notes, rows: sheetRows }
    }
    rows = { [Symbol.asyncIterator]: () => it }
  }

  const window = []
  let mode = 'seek'
  let region = null
  let emptyRun = 0
  async function open(layoutRegion, buffered) {
    region = begin(layoutRegion)
    for (const r of emitWindow(region, buffered)) await emit(region, r)
  }
  for await (const row of rows) {
    const blank = !(row.values || []).some(v => v != null && v !== '')
    if (mode === 'seek') {
      window.push(row)
      const layout = detectLayout(window, merges, { partial: true })
      if (!layout.pending && layout.regions[0]) {
        await open(layout.regions[0], window)
        window.length = 0
        mode = 'data'
        emptyRun = 0
      } else if (window.length >= 40) {
        const forced = detectLayout(window, merges)
        const fallback = forced.regions[0] || {
          notes: [], headerRows: [], headers: ['列1'], dataStartRow: window.find(r => !((r.values || []).every(v => v == null || v === '')))?.number || window[0].number,
          confidence: 0.3, needsConfirmation: true, synthetic: true, confirmed: false
        }
        await open(fallback, window)
        window.length = 0
        mode = 'data'
        emptyRun = 0
      }
      continue
    }
    if (blank) {
      emptyRun++
      if (emptyRun >= 2) { mode = 'seek'; region = null; emptyRun = 0 }
      continue
    }
    emptyRun = 0
    await emit(region, row)
  }
  if (mode === 'seek' && window.length) {
    const forced = detectLayout(window, merges)
    if (forced.regions[0]) await open(forced.regions[0], window)
  }
  await flush()
  return { regions, notes, rows: sheetRows }
}

function annotate(row, merges, maxCols) {
  const source = typeof row.eachCell === 'function' ? rowValues(row) : (row.values || [])
  return { number: row.number, values: source.slice(0, maxCols), mergeSpan: mergeSpan(merges, row.number) }
}

async function structureExcel(filePath, { onBatch, batchSize = 1000, maxRows = 1000000, maxCols = 500, layout = null } = {}) {
  const parts = await workbookParts(filePath)
  const sheets = []
  const notes = []
  const total = { n: 0 }
  try {
  for await (const { rows: sourceRows, part, key: sheetKey } of readWorksheets(filePath, parts)) {
    const taken = await consumeSheet(sheetKey, (async function* () {
      for await (const row of sourceRows) yield annotate(row, part.merges, maxCols)
    })(), {
      merges: part.merges,
      userRegion: layoutFor(layout, part.name),
      onBatch, batchSize, maxRows, total
    })
    notes.push(...taken.notes)
    if (taken.regions.length) {
      sheets.push({
        sheet: sheetKey, name: part.name, rows: taken.rows, regions: taken.regions,
        special: (taken.regions[0] && taken.regions[0].special) || {},
        fields: taken.regions.flatMap((region, tableIndex) => (region.headers || []).map((name, i) => ({
          sheet: sheetKey,
          col_index: i,
          name,
          inferred_type: region.trackers[i] ? region.trackers[i].type() : 'text',
          header_row: region.headerRows.length ? region.headerRows[region.headerRows.length - 1] : null,
          confidence: region.confidence,
          confirmed: region.confirmed === true || region.needsConfirmation !== true,
          table_index: tableIndex
        })))
      })
    }
    if (total.n >= maxRows) break
  }
  } catch (err) {
    if (sheets.length) throw err
  }
  if (parts.length > sheets.length) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(filePath)
    const seen = new Set(sheets.map(s => s.sheet))
    for (let i = 0; i < wb.worksheets.length; i++) {
      const key = `#${i + 1}`
      if (seen.has(key)) continue
      const ws = wb.worksheets[i]
      const part = parts[i] || { name: ws.name, merges: [] }
      const list = []
      ws.eachRow({ includeEmpty: true }, row => { list.push(annotate(row, part.merges, maxCols)) })
      const taken = await consumeSheet(key, (async function* () { yield* list })(), {
        merges: part.merges, userRegion: layoutFor(layout, part.name), onBatch, batchSize, maxRows, total
      })
      notes.push(...taken.notes)
      if (taken.regions.length) {
        sheets.push({
          sheet: key, name: part.name, rows: taken.rows, regions: taken.regions,
          special: (taken.regions[0] && taken.regions[0].special) || {},
          fields: taken.regions.flatMap((region, tableIndex) => (region.headers || []).map((name, col) => ({
            sheet: key, col_index: col, name,
            inferred_type: region.trackers[col] ? region.trackers[col].type() : 'text',
            header_row: region.headerRows.length ? region.headerRows[region.headerRows.length - 1] : null,
            confidence: region.confidence,
            confirmed: region.confirmed === true || region.needsConfirmation !== true,
            table_index: tableIndex
          })))
        })
      }
    }
  }
  const nameMap = {}
  for (const s of sheets) {
    const index = Number(s.sheet.slice(1)) - 1
    const real = (parts[index] && parts[index].name) || s.name || `Sheet${s.sheet.slice(1)}`
    nameMap[s.sheet] = real
    s.sheet = real
    for (const f of s.fields) f.sheet = real
    for (const region of s.regions) delete region.trackers
  }
  for (const n of notes) {
    if (nameMap[n.sheet]) n.sheet = nameMap[n.sheet]
  }
  const needsConfirmation = sheets.some(s => s.regions.some(r => r.needsConfirmation))
  return { sheets, totalRows: total.n, nameMap, notes, needsConfirmation }
}

function mergesFromWorksheet(ws) {
  const refs = (ws.model && ws.model.merges) || Object.keys(ws._merges || {})
  return refs.map(parseA1Range).filter(Boolean)
}

function previewValues(values, maxCols) {
  return (values || []).slice(0, maxCols).map(v => (v == null ? null : cellText(v).slice(0, 80)))
}

// Streams one window of rows. The caller does not need the whole workbook in the browser.
async function previewExcel(filePath, { maxRows = 12, maxCols = 80, fromRow = 1, limit, sheet = null, selectedBySheet = {} } = {}) {
  const parts = await workbookParts(filePath)
  const start = Math.max(1, Number(fromRow) || 1)
  const count = Math.max(1, Math.min(200, Number(limit || maxRows) || maxRows))
  const end = start + count - 1
  const sheets = []
  for await (const { rows: sourceRows, part } of readWorksheets(filePath, parts)) {
    const wanted = !sheet || part.name === sheet
    const selected = selectedBySheet[part.name] || []
    const stopAt = Math.max(end, 40, ...(selected.length ? selected : [0]))
    const headerProbe = []
    const window = []
    const selectedValues = new Map()
    let seen = 0
    for await (const row of sourceRows) {
      seen = Math.max(seen, row.number || 0)
      if (!wanted && !selected.length) continue
      const annotated = annotate(row, part.merges, maxCols)
      if (annotated.number <= 40) headerProbe.push(annotated)
      if (annotated.number >= start && annotated.number <= end) window.push(annotated)
      if (selected.includes(annotated.number)) selectedValues.set(annotated.number, annotated.values)
      if (annotated.number >= stopAt) break
    }
    const form = detectForm(headerProbe)
    const layout = form ? { regions: [{ ...form, headers: buildForm(headerProbe, part.merges, form).map(e => e.name), notes: [] }] } : detectLayout(headerProbe, part.merges || [])
    const rowCount = part.rowCount || seen || 0
    const columnCount = part.columnCount || Math.max(0, ...headerProbe.map(r => (r.values || []).length), ...window.map(r => (r.values || []).length))
    const cap = rowCount ? Math.min(end, Math.max(rowCount, start - 1)) : (window.length ? window[window.length - 1].number : start - 1)
    const byNumber = new Map(window.map(r => [r.number, r]))
    const preview = []
    if (wanted) for (let n = start; n <= cap; n++) preview.push({ row: n, values: previewValues(byNumber.get(n) && byNumber.get(n).values, maxCols) })
    sheets.push({
      name: part.name, merges: part.merges,
      rowCount, columnCount,
      rowCountExact: part.rowCount != null,
      selectedRows: selected.map(n => ({ row: n, values: selectedValues.get(n) || [] })),
      regions: layout.regions.map(r => ({
        mode: r.mode || 'table', form: r.form, reason: r.reason,
        headerRows: r.headerRows, dataStartRow: r.dataStartRow, dataEndRow: r.dataEndRow,
        confidence: r.confidence, needsConfirmation: r.needsConfirmation, headers: r.headers, notes: r.notes
      })),
      preview, previewFromRow: start, previewLimit: count, previewSkipped: !wanted
    })
    if (sheet && part.name === sheet) break
  }
  for (let i = 0; i < parts.length; i++) {
    if (sheets.some(s => s.name === parts[i].name)) continue
    sheets.push({
      name: parts[i].name, rowCount: parts[i].rowCount || 0, columnCount: parts[i].columnCount || 0, rowCountExact: parts[i].rowCount != null,
      selectedRows: [], regions: [], preview: [], previewFromRow: start, previewLimit: count, previewSkipped: true
    })
  }
  if (sheet && !sheets.some(s => s.name === sheet && !s.previewSkipped)) {
    const err = new Error('missing'); err.status = 404; err.code = 'missing'; throw err
  }
  sheets.sort((a, b) => parts.findIndex(p => p.name === a.name) - parts.findIndex(p => p.name === b.name))
  return { sheets }
}

const { withPreparedExcel } = require('../prepare')
module.exports = {
  structureExcel: (filePath, options) => withPreparedExcel(filePath, prepared => structureExcel(prepared, options), options),
  sheetNames: filePath => withPreparedExcel(filePath, sheetNames),
  previewExcel: (filePath, options) => withPreparedExcel(filePath, prepared => previewExcel(prepared, options), options)
}
