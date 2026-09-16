const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const TEXT_EXT = /\.(txt|log|csv)$/i
const HTML_EXT = /\.html?$/i

export function attachmentPreviewKind(fileName, mimeType = '') {
  const name = String(fileName || '')
  const mime = String(mimeType || '').toLowerCase().split(';')[0]
  if (IMAGE_EXT.test(name) || /^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    return 'image'
  }
  if (/\.pdf$/i.test(name) || mime === 'application/pdf') return 'pdf'
  if (HTML_EXT.test(name) || mime === 'text/html' || mime === 'application/xhtml+xml') {
    return 'html'
  }
  if (/\.(md|markdown)$/i.test(name) || mime === 'text/markdown') return 'markdown'
  if (/\.json$/i.test(name) || mime === 'application/json') return 'json'
  if (/\.(docx|xls|xlsx|xlsm|ods)$/i.test(name) || /wordprocessingml|spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) {
    return 'office'
  }
  if (/\.pptx$/i.test(name) || /presentationml/.test(mime)) return 'presentation'
  if (TEXT_EXT.test(name) || /^text\//.test(mime)) return 'text'
  return 'unsupported'
}

export function isHtmlAttachment(fileName, mimeType, url) {
  if (attachmentPreviewKind(fileName, mimeType) === 'html') return true
  return /\.html?([?#]|$)/i.test(String(url || ''))
}

export const WORKBOOK_PREVIEW_MAX_ROWS = 500
export const WORKBOOK_PREVIEW_MAX_COLS = 40
export const WORKBOOK_PREVIEW_MAX_SHEETS = 10

const SPREADSHEET_EXT = /\.(xls|xlsx|xlsm|ods)$/i
const SPREADSHEET_MIME = /spreadsheetml|ms-excel|opendocument\.spreadsheet/
const SKIP_ZIP_ENTRY = /^(xl\/(media|drawings|charts|embeddings)\/)/i
const SKIP_ZIP_EXT = /\.(png|jpe?g|gif|emf|wmf|tif|tiff|bmp|wdp|svg)$/i

function attachmentStatusOf(data) {
  return String((data && (data.attachmentStatus || data.status)) || '')
    .trim()
    .toLowerCase()
}

export function isAttachmentBusy(data) {
  const status = attachmentStatusOf(data)
  return (
    status === 'uploading' || status === 'pending' || status === 'processing'
  )
}

export function isAttachmentPreviewReady(data) {
  if (!data || isAttachmentBusy(data)) return false
  if (attachmentStatusOf(data) === 'failed') return false
  return !!(data.attachmentId || data.id || data.attachmentUrl)
}

export function attachmentBusyMessage(data) {
  const status = attachmentStatusOf(data)
  if (status === 'uploading') return '正在上传，请稍候'
  if (status === 'pending' || status === 'processing') return '正在处理，请稍候'
  if (status === 'failed') {
    return (
      (data && (data.attachmentError || data.errorMessage)) ||
      '处理失败'
    )
  }
  return '还不能打开'
}

export function isSpreadsheetAttachment(fileName, mimeType = '') {
  const name = String(fileName || '')
  const mime = String(mimeType || '').toLowerCase()
  return SPREADSHEET_EXT.test(name) || SPREADSHEET_MIME.test(mime)
}

export function isZipBuffer(value) {
  const bytes = asBytes(value)
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

export async function slimSpreadsheetZip(buffer, JSZip) {
  const bytes = asBytes(buffer)
  if (!isZipBuffer(bytes) || !JSZip) return bytes
  const zip = await JSZip.loadAsync(bytes)
  let removed = 0
  Object.keys(zip.files).forEach(name => {
    if (SKIP_ZIP_ENTRY.test(name) || SKIP_ZIP_EXT.test(name)) {
      zip.remove(name)
      removed += 1
    }
  })
  if (!removed) return bytes
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function workbookSheetsFromXlsx(XLSX, workbook) {
  const names = (workbook && workbook.SheetNames) || []
  return names
    .slice(0, WORKBOOK_PREVIEW_MAX_SHEETS)
    .map(name => {
      const values = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false
      })
      const rows = values
        .map(row => {
          const cells = Array.isArray(row) ? row.map(value => String(value || '')) : []
          let last = cells.length - 1
          while (last >= 0 && !cells[last].trim()) last -= 1
          return cells.slice(0, last + 1)
        })
        .filter(row => row.some(cell => cell.trim()))
      const columnCount = Math.min(
        WORKBOOK_PREVIEW_MAX_COLS,
        rows.reduce((max, row) => Math.max(max, row.length), 0)
      )
      return {
        name,
        rows: rows
          .slice(0, WORKBOOK_PREVIEW_MAX_ROWS)
          .map(row => row.slice(0, columnCount)),
        columnCount,
        truncated: rows.length > WORKBOOK_PREVIEW_MAX_ROWS
      }
    })
    .filter(sheet => sheet.rows.length)
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
}

function isProbablyBinary(bytes) {
  if (!bytes.length) return false
  let controls = 0
  const sampleLength = Math.min(bytes.length, 4096)
  for (let index = 0; index < sampleLength; index += 1) {
    const value = bytes[index]
    if (value === 0) return true
    if (value < 0x09 || (value > 0x0d && value < 0x20)) controls += 1
  }
  return controls > sampleLength * 0.12
}

function utf16EncodingFromPattern(bytes) {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 512)
  if (sampleLength < 8) return ''
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenZeros += 1
    if (bytes[index + 1] === 0) oddZeros += 1
  }
  const pairs = sampleLength / 2
  if (oddZeros > pairs * 0.35) return 'utf-16le'
  if (evenZeros > pairs * 0.35) return 'utf-16be'
  return ''
}

function decode(bytes, encoding, fatal = true) {
  return new TextDecoder(encoding, { fatal }).decode(bytes)
}

export function decodeAttachmentText(value) {
  const bytes = asBytes(value)
  if (!bytes.length) return ''
  let encoding = ''
  let offset = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8'
    offset = 3
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    offset = 2
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    offset = 2
  } else {
    encoding = utf16EncodingFromPattern(bytes)
  }
  if (encoding) return decode(bytes.subarray(offset), encoding)
  if (isProbablyBinary(bytes)) {
    throw new Error('文件包含二进制内容，无法按文本预览')
  }
  try {
    return decode(bytes, 'utf-8')
  } catch (err) {
    try {
      return decode(bytes, 'gb18030')
    } catch (fallbackErr) {
      throw new Error('无法识别文本编码，请下载后使用本地程序打开')
    }
  }
}

export function formatAttachmentText(value, kind) {
  const text = decodeAttachmentText(value)
  if (kind !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch (err) {
    return text
  }
}

export function formatOfficePreviewText(value, fileName) {
  const text = String(value || '')
  if (!/\.(xls|xlsx|xlsm|ods)$/i.test(String(fileName || ''))) return text
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/(?:,\s*)+$/, ''))
    .filter(line => line.replace(/[\s,]/g, '').length > 0)
    .join('\n')
}

export function safeMarkdownSource(value) {
  return String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
