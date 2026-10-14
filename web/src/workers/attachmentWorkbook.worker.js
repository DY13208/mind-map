import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { slimSpreadsheetZip } from '../utils/nodeAttachmentPreview'

let book = null
const MAX_ROWS = 10000
const MAX_COLS = 40
self.onmessage = async event => {
  const { id, action, buffer, sheet, offset = 0 } = event.data
  try {
    if (action === 'open') {
      const slim = await slimSpreadsheetZip(buffer, JSZip)
      book = XLSX.read(slim, { type: 'array', cellStyles: false, cellHTML: false, sheetRows: MAX_ROWS + 1 })
      const sheets = book.SheetNames.slice(0, 10).map(name => {
        const item = book.Sheets[name]
        const range = XLSX.utils.decode_range(item['!ref'] || 'A1')
        const full = XLSX.utils.decode_range(item['!fullref'] || item['!ref'] || 'A1')
        return { name, rows: Math.min(MAX_ROWS, range.e.r + 1), columns: Math.min(MAX_COLS, range.e.c + 1), truncated: full.e.r >= MAX_ROWS || full.e.c >= MAX_COLS || book.SheetNames.length > 10 }
      })
      self.postMessage({ id, sheets })
    } else if (action === 'rows' && book && book.Sheets[sheet]) {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[sheet], {
        header: 1, raw: false, defval: '', blankrows: true,
        range: { s: { r: offset, c: 0 }, e: { r: Math.min(MAX_ROWS - 1, offset + 99), c: MAX_COLS - 1 } }
      }).map(row => row.map(value => String(value == null ? '' : value)))
      self.postMessage({ id, offset, rows })
    } else throw new Error('工作表不存在')
  } catch (error) { self.postMessage({ id, error: error.message || '表格解析失败' }) }
}
