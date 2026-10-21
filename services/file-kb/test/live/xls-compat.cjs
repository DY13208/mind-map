'use strict'
// Run after generating a BIFF fixture with preprocess/make_fixture.py.
const assert = require('node:assert/strict')
const { previewExcel, sheetNames, structureExcel } = require('../../src/structurer/excel')
async function main() {
  const file = process.argv[2]
  assert.ok(file, 'pass the generated XLS fixture path')
  assert.deepEqual(Array.from((await sheetNames(file)).values()), ['明细表', '附表'])
  const preview = await previewExcel(file, { fromRow: 1, limit: 8 })
  assert.equal(preview.sheets[0].name, '明细表')
  assert.equal(preview.sheets[0].preview.find(r => r.row === 5).values[0], 'SKU-4')
  const rows = []
  const result = await structureExcel(file, {
    layout: { sheets: [{ sheet: '明细表', headerRows: [1], dataStartRow: 2 }] },
    onBatch: async batch => rows.push(...batch)
  })
  assert.equal(result.totalRows, 3)
  assert.equal(result.preprocessing.method, 'xls-to-xlsx')
  assert.deepEqual(rows.map(r => r.row_index), [1, 2, 4])
  assert.equal(rows[0].record_date, '2024-05-06')
  assert.equal(rows[0].stock, 10)
  assert.equal(result.sheets[0].regions[0].confirmed, true)
  console.log('XLS preview, sheet names, confirmed headers, sparse row indices and dates passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
