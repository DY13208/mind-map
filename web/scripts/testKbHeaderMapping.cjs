// File KB: Excel 表头/字段映射纯函数（无网络、无文件写入）
const test = require('node:test')
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const file = path.resolve(__dirname, '../src/features/knowledge-base/utils/headerMapping.js')
const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(require('module').createRequire(file), mod, mod.exports)
const H = mod.exports

test('auxiliary-sheet mode submits an explicit skip and still requires review', () => {
  const state = H.createSheetState({ name: 'Data', headerRows: [3], dataStartRow: 2 })
  H.setMappingMode(state, 'skip', () => null, [])
  assert.equal(H.validateSheet(state).length, 1)
  H.markReviewed(state)
  assert.deepEqual(H.validateSheet(state), [])
  assert.deepEqual(H.buildStructurePayload([state]), { sheets: [{ sheet: 'Data', mode: 'skip' }] })
  assert.equal(H.rowRole(state, 3), 'note')
})

test('vertical form preview, payload, review guard and saved renames agree with worker rules', () => {
  const form = { fieldColumn: 1, valueColumn: 3, groupColumn: 0, requiredColumn: 2, noteColumn: 4 }
  const source = H.rowsFromAoa([
    ['一级', '二级', '是否必填', '请供应商填写', '说明'],
    ['摘要', '供应商名称', '必填', 'Example'],
    ['联系人', '销售联系人', '必填', '甲'],
    [null, '电话', null, '0101234'],
    [null, '财务联系人', null, '乙'],
    [null, '电话', null, null, '待补充']
  ])
  const get = n => source[n - 1] || null
  const state = H.createSheetState({ name: '资料', mode: 'form', form, rowCount: 6, columnCount: 5,
    headerRows: [1], dataStartRow: 2, columns: [] })
  H.recomputeFields(state, n => n <= 3 ? get(n) : null, [])
  assert.equal(state.formComplete, false)
  assert.ok(H.validateSheet(state).some(s => s.includes('完整工作表')))
  H.recomputeFields(state, get, [])
  assert.deepEqual(H.effectiveFields(state).map(f => f.name), ['供应商名称', '销售联系人', '销售联系人 / 电话', '财务联系人', '财务联系人 / 电话'])
  assert.deepEqual(H.dataSample(state, get).rows[0].values, ['Example', '甲', '0101234', '乙', ''])
  H.setFieldName(state, 4, '财务电话')
  H.markReviewed(state)
  assert.deepEqual(H.validateSheet(state), [])
  const payload = H.buildStructurePayload([state]).sheets[0]
  assert.equal(payload.mode, 'form')
  assert.deepEqual(payload.form, form)
  assert.deepEqual(payload.columnOverrides, [{ index: 4, name: '财务电话' }])
  const saved = H.createSheetState({ name: '资料', mode: 'form', form, confirmed: true, rowCount: 6, columnCount: 5,
    headerRows: [1], dataStartRow: 2, columns: H.effectiveFields(state) })
  H.recomputeFields(saved, get, [])
  assert.equal(H.effectiveFields(saved)[4].name, '财务电话')
  assert.deepEqual(H.buildStructurePayload([saved]).sheets[0].columnOverrides, [{ index: 4, name: '财务电话' }])
  H.setDataStartRow(state, 3)
  H.recomputeFields(state, get, [])
  assert.deepEqual(H.buildStructurePayload([state]).sheets[0].columnOverrides, [], 'a changed record range cannot reuse names at shifted indexes')
  assert.equal(state.formEntries[0].row, 3)
  H.setFormColumn(state, 'valueColumn', 1, get, [])
  assert.equal(state.reviewed, false)
  assert.ok(H.validateSheet(state).some(s => s.includes('不同的有效列')))
})

