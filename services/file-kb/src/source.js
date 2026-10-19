'use strict'
const { colLetter } = require('./structurer/header')
function bboxOf(value) {
  const b = Array.isArray(value) ? value : value && Array.isArray(value.norm) ? value.norm : value && [value.l,value.t,value.r,value.b]
  if (!b || b.length !== 4 || b.some(v=>v == null || !Number.isFinite(Number(v)) || Number(v)<0 || Number(v)>1)) return null
  const [l,t,r,bt] = b.map(Number)
  return [Math.min(l,r),Math.min(t,bt),Math.max(l,r),Math.max(t,bt)]
}
function sourceOf(r) {
  const row = r.row_index == null ? r.row == null ? null : Number(r.row) : Number(r.row_index)+1
  return { coordinateVersion:2, rowBase:1, fileId:r.file_id||r.fileId,
    parseVersion:r.parse_version, runId:r.run_id||r.current_run_id||null,
    blockId:r.block_id == null ? null : String(r.block_id), page:r.page??null,
    sheet:r.sheet||null, row, rowIndex:r.row_index == null ? null : Number(r.row_index),
    tableIndex:r.table_index??null,
    cell:r.cell_range || (row && r.column_count ? `A${row}:${colLetter(Number(r.column_count)-1)}${row}` : null),
    bbox:bboxOf(r.bbox) }
}
module.exports={bboxOf,sourceOf}
