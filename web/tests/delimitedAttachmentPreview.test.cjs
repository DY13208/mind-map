const assert = require('node:assert/strict')
const path = require('node:path')
const XLSX = require('xlsx')
const iconv = require('iconv-lite')
const esbuild = require('esbuild')
const utils = require('./loadAttachmentUtils.cjs')()
const { attachmentPreviewKind, isSpreadsheetAttachment, readAttachmentWorkbook } = utils

for (const ext of ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'ods']) {
  assert.equal(attachmentPreviewKind('财务.' + ext.toUpperCase(), 'text/markdown'), 'office')
  assert.equal(isSpreadsheetAttachment('财务.' + ext), true)
}
assert.equal(attachmentPreviewKind('数据', 'text/csv; charset=utf-8'), 'office')
assert.equal(attachmentPreviewKind('数据', 'text/tab-separated-values'), 'office')
assert.equal(attachmentPreviewKind('数据', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'), 'office')
assert.equal(isSpreadsheetAttachment('说明.docx', 'application/vnd.ms-excel'), false)
assert.equal(attachmentPreviewKind('说明.txt', 'text/csv'), 'text')
for (const [name, mime, kind] of [['录音.mp3', '', 'audio'], ['录音.wav', '', 'audio'], ['视频.mp4', '', 'video'], ['视频.webm', '', 'video'], ['录音', 'audio/mp4', 'audio']]) assert.equal(attachmentPreviewKind(name, mime), kind)

const csv = '编号,说明,值\r\n00123,"中文,逗号",0\r\n"多行\n文本","双""引号",12345678901234567890\r\n=1+1,<script>alert(1)</script>,2026-01-01'
function rows(buffer, name = '数据.csv', mime = '') {
  const book = readAttachmentWorkbook(XLSX, buffer, name, mime)
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: false, defval: '' })
}
const expected = [['编号', '说明', '值'], ['00123', '中文,逗号', '0'], ['多行\n文本', '双"引号', '12345678901234567890'], ['=1+1', '<script>alert(1)</script>', '2026-01-01']]
for (const buffer of [Buffer.from(csv), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(csv)]), iconv.encode(csv, 'gb18030'), Buffer.concat([Buffer.from([255, 254]), Buffer.from(csv, 'utf16le')]), Buffer.concat([Buffer.from([254, 255]), Buffer.from(csv, 'utf16le').swap16()])]) assert.deepEqual(rows(buffer), expected)
assert.deepEqual(rows(Buffer.from('编号\t描述\n00123\t"中文\t制表符"'), '数据.tsv'), [['编号', '描述'], ['00123', '中文\t制表符']])
assert.deepEqual(rows(Buffer.from('sep=;\n编号;金额\n00123;20')), [['编号', '金额'], ['00123', '20']])
const formulaBook = readAttachmentWorkbook(XLSX, Buffer.from('=1+1,00123'), 'safe.csv')
assert.equal(formulaBook.Sheets.Sheet1.A1.f, undefined, 'CSV formulas remain text')
const large = readAttachmentWorkbook(XLSX, Buffer.from(Array.from({ length: 12000 }, (_, n) => n + ',data').join('\n')), 'large.csv')
assert.equal(XLSX.utils.decode_range(large.Sheets.Sheet1['!ref']).e.r, 10000)

async function workerChecks() {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/workers/attachmentWorkbook.worker.js')], bundle: true, platform: 'browser', format: 'iife', write: false, alias: { 'simple-mind-map': path.resolve(__dirname, '../../simple-mind-map') } })
  const responses = [], self = Object.assign(Object.create(global), { postMessage: response => responses.push(response) })
  new Function('self', built.outputFiles[0].text)(self)
  async function call(message) { responses.length = 0; await self.onmessage({ data: { id: 1, ...message } }); assert.equal(responses.length, 1); return responses[0] }
  const opened = await call({ action: 'open', buffer: Buffer.from(csv), fileName: '中文.csv', mimeType: 'text/markdown' })
  assert.equal(opened.sheets[0].columns, 3); assert.equal(opened.sheets[0].rows, 4)
  assert.deepEqual((await call({ action: 'rows', sheet: opened.sheets[0].name })).rows.slice(0, 4), expected)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['编号', '金额'], ['0001', 0]]), '预算')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['第二页']]), '详情')
  for (const type of ['xlsx', 'xls', 'xlsb', 'ods']) {
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: type })
    const result = await call({ action: 'open', buffer, fileName: '预算.' + type })
    assert.deepEqual(result.sheets.map(s => s.name), ['预算', '详情'])
    assert.deepEqual((await call({ action: 'rows', sheet: '预算' })).rows[1].slice(0, 2), ['0001', '0'])
    assert.equal((await call({ action: 'rows', sheet: '详情' })).rows[0][0], '第二页')
  }
  const empty = await call({ action: 'open', buffer: Buffer.alloc(0), fileName: 'empty.csv' })
  assert.equal(empty.sheets[0].rows, 0)
  assert.ok((await call({ action: 'open', buffer: Uint8Array.from([0, 1, 2]), fileName: 'bad.csv' })).error)
  console.log('PASS CSV/TSV encoding, quoted delimiters/newlines, exact identifiers, bounds, workbook worker and XLSX/XLS/XLSB/ODS sheets')
}
workerChecks().catch(error => { console.error(error); process.exitCode = 1 })
