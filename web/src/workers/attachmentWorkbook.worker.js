import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { slimSpreadsheetZip, readAttachmentWorkbook } from '../utils/nodeAttachmentPreview'

let book = null
const MAX_ROWS = 10000
const MAX_COLS = 40
self.onmessage = async event => {
  const { id, action, buffer, fileName, mimeType, sheet, offset = 0 } = event.data
  try {
    if (action === 'open') {
      book = null
      const slim = await slimSpreadsheetZip(buffer, JSZip)
      book = readAttachmentWorkbook(XLSX, slim, fileName, mimeType, MAX_ROWS)
      const sheets = book.SheetNames.slice(0, 10).map(name => {
        const item = book.Sheets[name]
        if (!item || !item['!ref']) return { name, rows: 0, columns: 0, truncated: false }
        const range = XLSX.utils.decode_range(item['!ref'])
        const full = XLSX.utils.decode_range(item['!fullref'] || item['!ref'] || 'A1')
        return { name, rows: Math.min(MAX_ROWS, range.e.r + 1), columns: Math.min(MAX_COLS, range.e.c + 1), truncated: full.e.r >= MAX_ROWS || full.e.c >= MAX_COLS || book.SheetNames.length > 10 }
      })
      self.postMessage({ id, sheets })
    } else if (action === 'rows' && book && book.Sheets[sheet]) {
      const ref = book.Sheets[sheet]['!ref']
      const range = ref && XLSX.utils.decode_range(ref)
      if (!range || offset > range.e.r || offset >= MAX_ROWS) {
        self.postMessage({ id, offset, rows: [] })
        return
      }
      const rows = XLSX.utils.sheet_to_json(book.Sheets[sheet], {
        header: 1, raw: false, defval: '', blankrows: true,
        range: { s: { r: offset, c: 0 }, e: { r: Math.min(MAX_ROWS - 1, offset + 99, range.e.r), c: Math.min(MAX_COLS - 1, range.e.c) } }
      }).map(row => row.map(value => String(value == null ? '' : value)))
      self.postMessage({ id, offset, rows })
    } else throw new Error('工作表不存在')
  } catch (error) { self.postMessage({ id, error: error.message || '表格解析失败' }) }
}
