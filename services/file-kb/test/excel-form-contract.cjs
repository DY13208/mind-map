'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const { structureExcel, previewExcel } = require('../src/structurer/excel')
const { normalizeMappings, carryConfirmed } = require('../src/structurer/mapping')
const { buildForm, validForm } = require('../src/shared/excelForm')

async function fixture(t, reversed = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-form-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'supplier.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('供应商资料')
  ws.addRows([
    ['一级', '二级', '是否必填', '请供应商填写', '说明'],
    ['摘要信息', '供应商名称', '必填', 'Example Supplier', '与营业执照一致'],
    [null, '供应商类型', '必填', '分销商'],
    [null, '证件号码', '必填', '0012345'],
    ['联系人', '销售联系人', '必填', '张三'],
    [null, '电话', '必填', '01012345678'],
    [null, '财务联系人', null, '李四'],
    [null, '电话', null, null, '待补充'],
    [], [],
    ['财务信息', '户名', '必填', 'Example Supplier']
  ])
  ws.mergeCells('A2:A4'); ws.mergeCells('A5:A8')
  wb.addWorksheet('Data').addRows([['供应商分类'], ['个人'], ['厂商'], ['分销商']])
  await wb.xlsx.writeFile(file)
  if (reversed) {
    const zip = await JSZip.loadAsync(await fs.readFile(file))
    const out = new JSZip()
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    const sheets = ['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet1.xml']
    for (const name of names.filter(n => !sheets.includes(n)).concat(sheets)) {
      let bytes = await zip.files[name].async('nodebuffer')
      // Logical sheet ids also need not be ZIP part numbers.
      if (name === 'xl/workbook.xml') bytes = Buffer.from(bytes.toString().replace('sheetId="1"', 'sheetId="9"').replace('sheetId="2"', 'sheetId="4"'))
      out.file(name, bytes)
    }
    await fs.writeFile(file, await out.generateAsync({ type: 'nodebuffer' }))
  }
  return file
}

const form = { fieldColumn: 1, valueColumn: 3, groupColumn: 0, requiredColumn: 2, noteColumn: 4 }

test('worksheet relationship binding survives reversed ZIP parts and nonordinal sheet ids', async t => {
  const file = await fixture(t, true)
  const before = await fs.readFile(file)
  const preview = await previewExcel(file)
  assert.deepEqual(preview.sheets.map(s => s.name), ['供应商资料', 'Data'])
  assert.equal(preview.sheets[0].preview[1].values[3], 'Example Supplier')
  assert.equal(preview.sheets[1].preview[1].values[0], '个人')
  const page = await previewExcel(file, { sheet: '供应商资料', fromRow: 5, limit: 4 })
  assert.equal(page.sheets.find(s => s.name === '供应商资料').preview[0].values[1], '销售联系人')
  const records = []
  const res = await structureExcel(file, { onBatch: async rows => records.push(...rows) })
  assert.equal(res.nameMap['#1'], '供应商资料')
  assert.equal(records.find(r => r.sheet === '#1').data['供应商名称'], 'Example Supplier')
  assert.equal(records.filter(r => r.sheet === '#2').some(r => Object.values(r.data).includes('个人')), true)
  assert.deepEqual(await fs.readFile(file), before)
})

test('vertical form is held for review; confirmed mapping yields one record, nulls, sources and notes', async t => {
  const file = await fixture(t)
  const detected = await structureExcel(file)
  assert.equal(detected.sheets[0].regions[0].mode, 'form')
  assert.equal(detected.needsConfirmation, true)
  const preview = await previewExcel(file, { selectedBySheet: { '供应商资料': [1] } })
  assert.equal(preview.sheets[0].selectedRows[0].values[0], '一级', JSON.stringify(preview.sheets[0]))
  const mapping = normalizeMappings([{ sheet: '供应商资料', mode: 'form', form, headerRows: [1], dataStartRow: 2,
    columnOverrides: [{ index: 6, name: '财务电话' }] }], preview)
  const records = []
  const res = await structureExcel(file, { layout: { confirmed: true, sheets: mapping }, onBatch: async rows => records.push(...rows) })
  const supplier = records.filter(r => r.sheet === '#1')
  assert.equal(supplier.length, 1)
  assert.equal(supplier[0].data['供应商名称'], 'Example Supplier')
  assert.equal(supplier[0].data['证件号码'], '0012345')
  assert.equal(supplier[0].data['销售联系人 / 电话'], '01012345678')
  assert.equal(supplier[0].data['财务电话'], null)
  assert.equal(supplier[0].data['户名'], 'Example Supplier', 'blank rows do not split a form')
  assert.equal(supplier[0].cell_range, 'A2:E11')
  const region = res.sheets[0].regions[0]
  assert.equal(region.confirmed, true)
  assert.equal(region.confidence, 1)
  assert.equal(region.needsConfirmation, false)
  assert.equal(region.fieldSources[6].valueCell, 'D8')
  assert.equal(region.fieldSources[6].note, '待补充')
  assert.equal(region.fieldSources[1].group, '摘要信息')
  assert.ok(res.notes.some(n => n.row === 8 && n.text.includes('待补充')))
  assert.deepEqual(carryConfirmed([], { confirmed: true, sheets: mapping }), mapping)
})

test('form mappings reject missing, duplicate and out of range columns', async t => {
  const preview = await previewExcel(await fixture(t), { selectedBySheet: { '供应商资料': [1] } })
  for (const invalid of [null, { ...form, valueColumn: 1 }, { ...form, valueColumn: 9 }, { ...form, noteColumn: 3 }]) {
    assert.equal(validForm(invalid, 5), false)
    assert.throws(() => normalizeMappings([{ sheet: '供应商资料', mode: 'form', form: invalid, headerRows: [1], dataStartRow: 2 }], preview), e => e.code === 'bad_layout')
  }
})

test('duplicate form labels retain every value and never inherit missing values', () => {
  const rows = [
    { number: 2, values: ['甲', '名称', null, 'A'] },
    { number: 3, values: ['乙', '名称', null, 'B'] },
    { number: 4, values: [null, '名称', null, null] },
    { number: 5, values: [null, '__proto__', null, '原文'] }
  ]
  const entries = buildForm(rows, [], { form, dataStartRow: 2, headerRows: [1] })
  assert.deepEqual(entries.map(e => e.name), ['甲 / 名称', '乙 / 名称', '乙 / 名称_2', '__proto__'])
  assert.equal(entries[2].value, null)
})

test('confirmed auxiliary sheets retain text without blocking or creating records', async t => {
  const file = await fixture(t, true)
  const preview = await previewExcel(file, { selectedBySheet: { '供应商资料': [1] } })
  const sheets = normalizeMappings([
    { sheet: '供应商资料', mode: 'form', form, headerRows: [1], dataStartRow: 2, columnOverrides: [] },
    { sheet: 'Data', mode: 'skip' }
  ], preview)
  const records = []
  const result = await structureExcel(file, { layout: { confirmed: true, sheets }, onBatch: async rows => records.push(...rows) })
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.totalRows, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].sheet, '#1')
  assert.equal(result.sheets.find(s => s.sheet === 'Data').fields.length, 0)
  assert.ok(result.notes.some(n => n.sheet === 'Data' && n.text === '个人'))
})

test('missing streaming shared strings falls back before emitting worksheet rows', async t => {
  const file = await fixture(t)
  const Reader = ExcelJS.stream.xlsx.WorkbookReader
  ExcelJS.stream.xlsx.WorkbookReader = class extends Reader {
    async *[Symbol.asyncIterator]() {
      for await (const ws of super[Symbol.asyncIterator]()) {
        delete this.sharedStrings
        yield ws
      }
    }
  }
  try {
    const preview = await previewExcel(file)
    assert.equal(preview.sheets[0].preview[0].values[0], '一级')
    const records = []
    const result = await structureExcel(file, { onBatch: async rows => records.push(...rows) })
    assert.equal(result.sheets.find(s => s.sheet === '供应商资料').regions[0].mode, 'form')
    assert.equal(records.filter(r => r.sheet === '#1').length, 1)
    assert.equal(records.find(r => r.sheet === '#1').data['供应商名称'], 'Example Supplier')
  } finally {
    ExcelJS.stream.xlsx.WorkbookReader = Reader
  }
})
