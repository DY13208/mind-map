const { factKey } = require('./fillFacts')
function candidatesFor(rows, field = '') {
  const groups = new Map()
  for (const row of rows) {
    const key = factKey(row.text, field)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, { text: row.text, sources: [], row })
    groups.get(key).sources.push({ file: row.file || row.sourceTitle || 'Wiki', page: row.page ?? null, line: row.line ?? null, quote: row.quote || row.text, date: row.effectiveDate || row.date || '', related: row.related || [] })
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, value], i) => ({ ...value, id: String(i + 1) }))
}
function selectCandidates(candidates, ids, multiple = false) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || (!multiple && ids.length !== 1)) throw new Error('请选择有效候选；单值字段只能选择一项')
  const selected = ids.map(id => candidates.find(c => c.id === id))
  if (selected.some(c => !c)) throw new Error('候选资料已变化，请重新补齐')
  return selected
}
function multipleReports(candidates, field) {
  if (!['报告编号','检验受理编号'].includes(field)) return false
  const records = new Map()
  for (const candidate of candidates) for (const source of candidate.sources) {
    const ids = [...new Set(source.related.filter(r=>r.field==='报告编号').map(r=>r.text))]
    if (ids.length !== 1) return false
    if (!records.has(ids[0])) records.set(ids[0],new Set())
    records.get(ids[0]).add(candidate.text)
  }
  return records.size > 1 && [...records.values()].every(values=>values.size===1)
}
module.exports = { candidatesFor, selectCandidates, multipleReports }
