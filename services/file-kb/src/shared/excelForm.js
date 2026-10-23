'use strict'
// Shared, dependency-free rules used by the worker and the mapping preview.
function text(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).replace(/\s+/g, ' ').trim()
}
function detectForm(rows) {
  for (const row of rows.slice(0, 40)) {
    const cells = (row.values || []).map(text)
    const fieldColumn = cells.findIndex(v => /^(二级|字段(?:名|名称)?|项目(?:名|名称)?|填写项目)$/.test(v))
    const valueColumn = cells.findIndex(v => /^(请供应商填写|填写内容|填写值|字段值|项目值|内容|值)$/.test(v))
    if (fieldColumn < 0 || valueColumn < 0 || fieldColumn === valueColumn) continue
    if (rows.filter(r => r.number > row.number && text((r.values || [])[fieldColumn])).length < 2) continue
    const find = re => cells.findIndex(v => re.test(v))
    return {
      mode: 'form', headerRows: [row.number], dataStartRow: row.number + 1,
      form: { fieldColumn, valueColumn, groupColumn: find(/^(一级|分类|分组)$/), requiredColumn: find(/^(是否必填|必填)$/), noteColumn: find(/^(说明|备注)$/) },
      confidence: 0.85, needsConfirmation: true,
      reason: '检测到字段名列和填写值列，疑似纵向表单；请核对列映射后确认，一张工作表生成一条记录。'
    }
  }
  return null
}
function validForm(form, width) {
  if (!form || !Number.isInteger(form.fieldColumn) || !Number.isInteger(form.valueColumn)) return false
  const keys = ['fieldColumn', 'valueColumn', 'groupColumn', 'requiredColumn', 'noteColumn']
  const used = []
  for (const key of keys) {
    const value = form[key]
    if (value == null || value === -1) {
      if (key === 'fieldColumn' || key === 'valueColumn') return false
      continue
    }
    if (!Number.isInteger(value) || value < 0 || value >= width || used.includes(value)) return false
    used.push(value)
  }
  return true
}
function buildForm(rows, merges, config) {
  const form = config.form
  const byRow = new Map(rows.map(r => [r.number, r]))
  let group = '', context = ''
  const entries = []
  for (const row of rows) {
    if (row.number < config.dataStartRow || (config.headerRows || []).includes(row.number)) continue
    const cells = row.values || []
    // Only category cells inherit. Values and notes are never filled down.
    const merge = (merges || []).find(m => m.left === form.groupColumn + 1 && m.right === m.left && m.top <= row.number && m.bottom >= row.number)
    const groupValue = text(merge && byRow.get(merge.top) ? byRow.get(merge.top).values[form.groupColumn] : cells[form.groupColumn])
    if (groupValue && groupValue !== group) { group = groupValue; context = '' }
    const label = text(cells[form.fieldColumn])
    if (!label) continue
    let name = label
    if (/^(电话|手机|邮箱|联系电话|电子邮箱)$/.test(label) && context) name = context + ' / ' + label
    if (/联系人$/.test(label)) context = label
    entries.push({ name, label, group, row: row.number, value: cells[form.valueColumn] == null ? null : cells[form.valueColumn],
      fieldCell: column(form.fieldColumn) + row.number, valueCell: column(form.valueColumn) + row.number,
      required: text(cells[form.requiredColumn]), note: text(cells[form.noteColumn]) })
  }
  const counts = new Map()
  entries.forEach(e => counts.set(e.name, (counts.get(e.name) || 0) + 1))
  const used = new Set()
  entries.forEach(e => {
    let base = counts.get(e.name) > 1 && e.group ? e.group + ' / ' + e.name : e.name
    base = base.slice(0, 190)
    let name = base, n = 2
    while (used.has(name)) name = base + '_' + n++
    used.add(name); e.name = name
  })
  return entries
}
function column(index) {
  let n = index + 1, out = ''
  while (n > 0) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26) }
  return out
}
module.exports = { detectForm, validForm, buildForm }
