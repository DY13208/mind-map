'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { scanStats, looksScanned, scanKind, OCR_EXTS } = require('../src/docling/ocr')
const { createDoclingClient } = require('../src/docling/client')
const { loadConfig } = require('../src/config')

const pdf = path.join(__dirname, 'fixtures/sample.pdf')
const prov = page => [{ page_no: page, bbox: { l: 0, t: 0, r: 1, b: 1 } }]
const pagesOf = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { page_no: i + 1, size: { width: 600, height: 800 } }]))

// 13 scanned pages: one picture per page, no text (what docling returns with do_ocr=false)
const scannedDoc = { pages: pagesOf(13), texts: [], tables: [], pictures: Array.from({ length: 13 }, (_, i) => ({ label: 'picture', prov: prov(i + 1) })) }
const textDoc = {
  pages: pagesOf(3), pictures: [{ prov: prov(2) }], tables: [],
  texts: [1, 2, 3].map(p => ({ label: 'text', text: 'This is a normal text page with plenty of extractable characters. '.repeat(3), prov: prov(p) }))
}

test('scanStats counts pages, non-whitespace chars, textless picture pages', () => {
  assert.deepEqual(scanStats(scannedDoc), { pages: 13, chars: 0, textPages: 0, picturePages: 13, textlessPicturePages: 13, textlessPages: 13, textlessPageNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] })
  const s = scanStats(textDoc)
  assert.equal(s.pages, 3); assert.equal(s.textPages, 3); assert.equal(s.textlessPicturePages, 0); assert.ok(s.chars > 100)
  assert.equal(s.textlessPages, 0); assert.deepEqual(s.textlessPageNos, [])
  const withTable = scanStats({ pages: pagesOf(1), texts: [], pictures: [], tables: [{ prov: prov(1), data: { table_cells: [{ text: ' ab c ' }, { text: 'd' }] } }] })
  assert.equal(withTable.chars, 4); assert.equal(withTable.textPages, 1)
  assert.deepEqual(scanStats(null), { pages: 0, chars: 0, textPages: 0, picturePages: 0, textlessPicturePages: 0, textlessPages: 0, textlessPageNos: [] })
  assert.equal(scanStats({ pages: pagesOf(80), texts: [] }).textlessPageNos.length, 50) // page list is capped
})

test('looksScanned: image-only and near-empty docs yes, text docs no', () => {
  assert.equal(looksScanned(scanStats(scannedDoc)), true)
  assert.equal(looksScanned(scanStats({ pages: pagesOf(2), texts: [], pictures: [], tables: [] })), true) // no pictures either
  assert.equal(looksScanned(scanStats(textDoc)), false)
  // a stamp/page number per page is still a scan
  const stamped = { ...scannedDoc, texts: Array.from({ length: 13 }, (_, i) => ({ text: `- ${i + 1} -`, prov: prov(i + 1) })) }
  assert.equal(looksScanned(scanStats(stamped)), true)
  // enough text overall but most pages are textless pictures => scan with an OCRed cover page
  const mixed = { ...scannedDoc, texts: [{ text: 'x'.repeat(2000), prov: prov(1) }] }
  assert.equal(looksScanned(scanStats(mixed)), true)
  assert.equal(looksScanned(scanStats(mixed), { textlessPageRatio: 1 }), false)
  assert.equal(looksScanned({ pages: 10, chars: 150, textlessPicturePages: 0 }, { minCharsPerPage: 20 }), true)
  assert.equal(looksScanned({ pages: 10, chars: 150, textlessPicturePages: 0 }, { minCharsPerPage: 10 }), false)
  assert.equal(looksScanned({ pages: 0, chars: 0, textlessPicturePages: 0 }), true)
  assert.equal(looksScanned({ pages: 0, chars: 5, textlessPicturePages: 0 }), false)
  assert.equal(looksScanned(null), false)
  assert.ok(OCR_EXTS.has('pdf') && OCR_EXTS.has('png') && !OCR_EXTS.has('docx'))
})

// Fake docling-serve: records submitted form fields per task, serves `docs[n]` for the n-th submit.
function fakeDocling(docs) {
  const submits = []
  const fetchImpl = async (url, init) => {
    const json = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
    if (url.endsWith('/v1/convert/file/async')) {
      const fields = {}
      for (const [k, v] of init.body.entries()) if (k !== 'files') (fields[k] = fields[k] || []).push(v)
      submits.push(fields)
      return json({ task_id: `t${submits.length}`, task_status: 'pending' })
    }
    const m = /\/(t\d+)/.exec(url)
    if (url.includes('/v1/status/poll/')) return json({ task_id: m[1], task_status: 'success' })
    if (url.includes('/v1/result/')) return json({ status: 'success', errors: [], processing_time: 1, document: { json_content: docs[Number(m[1].slice(1)) - 1] } })
    throw new Error('unexpected ' + url)
  }
  return { submits, fetchImpl }
}
const one = (f, k) => (f[k] || [])[0]
const quiet = () => {}

test('auto: text PDF is a single pass without OCR', async () => {
  const d = fakeDocling([textDoc])
  const ids = []
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, ocrMode: 'auto', log: quiet })
  const r = await c.convertFile({ filePath: pdf, fileName: 'a.pdf', ext: 'pdf', onTaskId: async id => ids.push(id) })
  assert.equal(d.submits.length, 1)
  assert.equal(one(d.submits[0], 'do_ocr'), 'false')
  assert.equal(d.submits[0].ocr_preset, undefined); assert.equal(d.submits[0].force_ocr, undefined)
  assert.equal(one(d.submits[0], 'document_timeout'), '600')
  assert.deepEqual(ids, ['t1'])
  assert.equal(r.json, textDoc)
  assert.deepEqual(r.ocr, { mode: 'auto', fallback: false })
})

test('auto: scanned PDF is re-run with OCR (rapidocr preset, force_ocr, longer timeout) and the OCR result is used', async () => {
  const ocrDoc = { pages: pagesOf(13), pictures: [], tables: [], texts: [{ text: '商業登記證 BUSINESS REGISTRATION', prov: prov(1) }] }
  const d = fakeDocling([scannedDoc, ocrDoc])
  const ids = []
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, ocrMode: 'auto', ocrLang: ['zh-Hant', 'en'], ocrDocumentTimeoutS: 2400, log: quiet })
  const r = await c.convertFile({ filePath: pdf, fileName: 'scan.pdf', ext: 'pdf', onTaskId: async id => ids.push(id) })
  assert.equal(d.submits.length, 2)
  assert.equal(one(d.submits[0], 'do_ocr'), 'false')
  const o = d.submits[1]
  assert.equal(one(o, 'do_ocr'), 'true'); assert.equal(one(o, 'force_ocr'), 'true'); assert.equal(one(o, 'ocr_preset'), 'rapidocr')
  assert.deepEqual(o.ocr_lang, ['zh-Hant', 'en'])
  assert.equal(one(o, 'document_timeout'), '2400')
  assert.deepEqual(ids, ['t1', 't2'])
  assert.equal(r.json, ocrDoc); assert.equal(r.taskId, 't2')
  assert.equal(r.ocr.fallback, 'full'); assert.equal(r.ocr.ok, true); assert.equal(r.ocr.force, true)
  assert.equal(r.ocr.firstPass.pages, 13); assert.equal(r.ocr.firstPass.chars, 0); assert.ok(r.ocr.ocrPass.chars > 0)
  assert.ok(!JSON.stringify(r.ocr).includes('BUSINESS'), 'metadata carries counts only')
})

test('auto: images use the fallback too; non-rasterized formats never do', async () => {
  const img = fakeDocling([{ pages: pagesOf(1), texts: [], pictures: [{ prov: prov(1) }], tables: [] }, textDoc])
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: img.fetchImpl, ocrMode: 'auto', log: quiet })
  await c.convertFile({ filePath: pdf, fileName: 'a.png', ext: 'png' })
  assert.equal(img.submits.length, 2); assert.equal(one(img.submits[1], 'do_ocr'), 'true')
  const docx = fakeDocling([{ pages: {}, texts: [], pictures: [], tables: [] }])
  const c2 = createDoclingClient({ baseUrl: 'http://d', fetchImpl: docx.fetchImpl, ocrMode: 'auto', log: quiet })
  await c2.convertFile({ filePath: pdf, fileName: 'a.docx', ext: 'docx' })
  assert.equal(docx.submits.length, 1)
})

test('auto: OCR pass document failure keeps the first pass instead of failing the file', async () => {
  let n = 0
  const fetchImpl = async url => {
    const json = o => ({ ok: true, status: 200, json: async () => o, text: async () => '' })
    if (url.endsWith('/v1/convert/file/async')) { n++; return json({ task_id: `t${n}` }) }
    if (url.includes('/poll/t2')) return json({ task_status: 'failure' })
    if (url.includes('/poll/')) return json({ task_status: 'success' })
    if (url.includes('/result/t2')) return json({ errors: ['boom'] })
    return json({ status: 'success', errors: [], document: { json_content: scannedDoc } })
  }
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl, ocrMode: 'auto', log: quiet })
  const r = await c.convertFile({ filePath: pdf, fileName: 'a.pdf', ext: 'pdf' })
  assert.equal(n, 2); assert.equal(r.json, scannedDoc); assert.equal(r.ocr.fallback, 'full'); assert.equal(r.ocr.ok, false)
})

test('off: scanned PDF stays a single pass without OCR (legacy default of the bare client)', async () => {
  for (const opts of [{ ocrMode: 'off' }, {}]) {
    const d = fakeDocling([scannedDoc])
    const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, log: quiet, ...opts })
    const r = await c.convertFile({ filePath: pdf, fileName: 'a.pdf', ext: 'pdf' })
    assert.equal(d.submits.length, 1); assert.equal(one(d.submits[0], 'do_ocr'), 'false'); assert.equal(r.ocr.fallback, false)
  }
})

test('always (and legacy doOcr:true): one OCR pass, no force_ocr', async () => {
  for (const opts of [{ ocrMode: 'always' }, { doOcr: true }]) {
    const d = fakeDocling([textDoc])
    const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, log: quiet, ...opts })
    await c.convertFile({ filePath: pdf, fileName: 'a.pdf', ext: 'pdf' })
    assert.equal(d.submits.length, 1)
    assert.equal(one(d.submits[0], 'do_ocr'), 'true'); assert.equal(one(d.submits[0], 'ocr_preset'), 'rapidocr')
    assert.equal(d.submits[0].force_ocr, undefined); assert.equal(one(d.submits[0], 'document_timeout'), '1800')
  }
})

test('config: OCR mode defaults to auto; legacy KB_DOCLING_OCR maps to always/off; MODE wins', () => {
  const c = loadConfig({})
  assert.equal(c.doclingOcrMode, 'auto'); assert.equal(c.doclingOcr, false)
  assert.equal(c.doclingOcrEngine, 'rapidocr'); assert.deepEqual(c.doclingOcrLang, []); assert.equal(c.doclingOcrForce, true)
  assert.equal(c.doclingOcrMinCharsPerPage, 20); assert.equal(c.doclingOcrTextlessPagePct, 60); assert.equal(c.doclingOcrMixedMinPages, 1)
  assert.equal(loadConfig({ KB_DOCLING_OCR_MIXED_MIN_PAGES: '0' }).doclingOcrMixedMinPages, 0)
  assert.throws(() => loadConfig({ KB_DOCLING_OCR_MIXED_MIN_PAGES: '-1' }))
  assert.equal(c.doclingOcrDocumentTimeoutS, 1800); assert.equal(c.doclingOcrTotalTimeoutMs, 3600000)
  assert.equal(loadConfig({ KB_DOCLING_OCR: 'true' }).doclingOcrMode, 'always')
  assert.equal(loadConfig({ KB_DOCLING_OCR: 'true' }).doclingOcr, true)
  assert.equal(loadConfig({ KB_DOCLING_OCR: 'false' }).doclingOcrMode, 'off')
  assert.equal(loadConfig({ KB_DOCLING_OCR: 'true', KB_DOCLING_OCR_MODE: 'auto' }).doclingOcrMode, 'auto')
  assert.equal(loadConfig({ KB_DOCLING_OCR_MODE: 'OFF' }).doclingOcrMode, 'off')
  assert.throws(() => loadConfig({ KB_DOCLING_OCR_MODE: 'sometimes' }))
  assert.deepEqual(loadConfig({ KB_DOCLING_OCR_LANG: 'zh-Hant, en' }).doclingOcrLang, ['zh-Hant', 'en'])
  assert.throws(() => loadConfig({ KB_DOCLING_OCR_LANG: 'zh;rm -rf' }))
  assert.throws(() => loadConfig({ KB_DOCLING_OCR_ENGINE: 'rapid ocr' }))
  assert.equal(loadConfig({ KB_DOCLING_OCR_ENGINE: 'easyocr' }).doclingOcrEngine, 'easyocr')
  assert.equal(loadConfig({ KB_DOCLING_OCR_FORCE: 'false' }).doclingOcrForce, false)
  assert.throws(() => loadConfig({ KB_DOCLING_OCR_TEXTLESS_PAGE_PCT: '0' }))
})

// 10 pages: 8 text pages + pages 3 and 5 scanned (docling emits neither text nor picture for them)
const mixedDoc = {
  pages: pagesOf(10), pictures: [], tables: [],
  texts: [1, 2, 4, 6, 7, 8, 9, 10].map(p => ({ label: 'text', text: 'Quarterly report text page with real programmatic text. '.repeat(8), prov: prov(p) }))
}

test('scanKind: full scan vs mixed (textless pages among text pages) vs plain text', () => {
  const m = scanStats(mixedDoc)
  assert.equal(m.textlessPages, 2); assert.deepEqual(m.textlessPageNos, [3, 5])
  assert.equal(looksScanned(m), false, 'document-level heuristic alone misses the scanned pages')
  assert.equal(scanKind(m), 'mixed')
  assert.equal(scanKind(m, { mixedMinPages: 3 }), null)
  assert.equal(scanKind(m, { mixedMinPages: 0 }), null, '0 disables mixed')
  assert.equal(scanKind(scanStats(scannedDoc)), 'full')
  assert.equal(scanKind(scanStats(scannedDoc), { mixedMinPages: 0 }), 'full')
  assert.equal(scanKind(scanStats(textDoc)), null)
  // picture-only page among text pages is mixed too
  const withPicPage = { ...textDoc, pages: pagesOf(4), pictures: [{ prov: prov(4) }] }
  assert.equal(scanKind(scanStats(withPicPage)), 'mixed')
  assert.equal(scanKind(null), null)
})

test('auto: mixed PDF re-runs with do_ocr=true and force_ocr NOT sent; stats say fallback=mixed', async () => {
  const filled = { ...mixedDoc, texts: [...mixedDoc.texts, { text: '营业执照', prov: prov(3) }, { text: '商業登記證', prov: prov(5) }] }
  const d = fakeDocling([mixedDoc, filled])
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, ocrMode: 'auto', ocrForce: true, log: quiet })
  const r = await c.convertFile({ filePath: pdf, fileName: 'mixed.pdf', ext: 'pdf' })
  assert.equal(d.submits.length, 2)
  assert.equal(one(d.submits[0], 'do_ocr'), 'false')
  const o = d.submits[1]
  assert.equal(one(o, 'do_ocr'), 'true'); assert.equal(o.force_ocr, undefined); assert.equal(one(o, 'ocr_preset'), 'rapidocr')
  assert.equal(one(o, 'document_timeout'), '1800')
  assert.equal(r.json, filled)
  assert.equal(r.ocr.fallback, 'mixed'); assert.equal(r.ocr.force, false); assert.equal(r.ocr.ok, true)
  assert.deepEqual(r.ocr.firstPass.textlessPageNos, [3, 5]); assert.equal(r.ocr.ocrPass.textlessPages, 0)
  assert.ok(!JSON.stringify(r.ocr).includes('营业执照'), 'metadata carries counts only')
})

test('auto: mixed detection can be disabled (mixedMinPages=0) -> single pass', async () => {
  const d = fakeDocling([mixedDoc])
  const c = createDoclingClient({ baseUrl: 'http://d', fetchImpl: d.fetchImpl, ocrMode: 'auto', ocrMixedMinPages: 0, log: quiet })
  const r = await c.convertFile({ filePath: pdf, fileName: 'mixed.pdf', ext: 'pdf' })
  assert.equal(d.submits.length, 1); assert.equal(r.ocr.fallback, false)
})
