import attachmentState from 'simple-mind-map/src/utils/attachmentIconState'

export const canPreviewOriginalAttachment = attachmentState.canPreviewOriginalAttachment
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024
export const OFFICE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024
export const PDF_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
export const WORKBOOK_PAGE_ROWS = 100

export function attachmentPreviewByteLimit(kind) {
  if (kind === 'image') return IMAGE_PREVIEW_MAX_BYTES
  if (kind === 'pdf') return PDF_PREVIEW_MAX_BYTES
  if (kind === 'office') return OFFICE_PREVIEW_MAX_BYTES
  return TEXT_PREVIEW_MAX_BYTES
}

// A small compressed image can still allocate hundreds of MB when decoded.
// Inspect its header before creating an <img> and starting browser decoding.
export function assertImagePreviewBudget(buffer) {
  const bytes = asBytes(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') {
    const type = String.fromCharCode(...bytes.subarray(12, 16))
    if (type === 'VP8X') {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    } else if (type === 'VP8L') {
      const bits = view.getUint32(21, true)
      width = 1 + (bits & 0x3fff)
      height = 1 + ((bits >>> 14) & 0x3fff)
    } else if (type === 'VP8 ') {
      width = view.getUint16(26, true) & 0x3fff
      height = view.getUint16(28, true) & 0x3fff
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (offset + 2 > bytes.length) break
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
        break
      }
      offset += size
    }
  }
  if (!width || !height) throw new Error('无法读取图片尺寸，请下载原文件查看')
  if (width * height > 20 * 1000 * 1000) {
    throw Object.assign(new Error('图片分辨率过大，请下载原文件查看'), { code: 'PREVIEW_TOO_LARGE' })
  }
  return { width, height }
}

const TEXT_EXT = /\.(txt|log|csv|js|ts|jsx|tsx|css|scss|less|py|java|go|rs|c|cpp|h|sh|sql|xml|ya?ml|vue|toml|ini|conf)$/i

export function attachmentPreviewKind(fileName, mimeType = '') {
  const name = String(fileName || '').trim()
  const ext = name.match(/\.([a-z0-9]+)$/i)
  // Original file extensions take precedence over extraction/legacy MIME metadata.
  if (ext) {
    const suffix = ext[1].toLowerCase()
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(suffix)) return 'image'
    if (suffix === 'pdf') return 'pdf'
    if (['html', 'htm'].includes(suffix)) return 'html'
    if (['md', 'markdown'].includes(suffix)) return 'markdown'
    if (suffix === 'json') return 'json'
    if (['docx', 'xls', 'xlsx', 'xlsm', 'ods'].includes(suffix)) return 'office'
    if (suffix === 'pptx') return 'presentation'
    if (suffix === 'zip') return 'archive'
    if (TEXT_EXT.test(name)) return 'text'
    // An explicit unknown extension must not be mistaken for extracted Markdown.
    if (String(mimeType || '').toLowerCase().split(';')[0].trim() === 'text/markdown') return 'unsupported'
  }
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim()
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/json') return 'json'
  if (/wordprocessingml|spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'office'
  if (/presentationml/.test(mime)) return 'presentation'
  if (/application\/(zip|x-zip-compressed)/.test(mime)) return 'archive'
  return /^text\//.test(mime) ? 'text' : 'unsupported'
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
  if (canPreviewOriginalAttachment(data)) return true
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
  assertOfficeZipBudget(zip)
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

export function assertOfficeZipBudget(zip) {
  const files = Object.values(zip.files || {})
  const inflated = files.reduce((total, file) => total + Number((file._data && file._data.uncompressedSize) || 0), 0)
  if (files.length > 2000 || inflated > 16 * 1024 * 1024) {
    throw new Error('文档展开后内容过大，请下载后查看')
  }
}

export function workbookSheetsFromXlsx(XLSX, workbook) {
  const names = (workbook && workbook.SheetNames) || []
  return names
    .slice(0, WORKBOOK_PREVIEW_MAX_SHEETS)
    .map(name => {
      const sheet = workbook.Sheets[name]
      if (!sheet || !sheet['!ref']) return null
      const range = XLSX.utils.decode_range(sheet['!ref'])
      const truncated = range.e.r >= WORKBOOK_PREVIEW_MAX_ROWS || range.e.c >= WORKBOOK_PREVIEW_MAX_COLS
      range.e.r = Math.min(range.e.r, range.s.r + WORKBOOK_PREVIEW_MAX_ROWS - 1)
      range.e.c = Math.min(range.e.c, range.s.c + WORKBOOK_PREVIEW_MAX_COLS - 1)
      const values = XLSX.utils.sheet_to_json(sheet, {
        range,
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
        truncated: truncated || rows.length > WORKBOOK_PREVIEW_MAX_ROWS || names.length > WORKBOOK_PREVIEW_MAX_SHEETS
      }
    })
    .filter(sheet => sheet && sheet.rows.length)
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

function decode(bytes, encoding, partial = false) {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: partial })
}

export function decodeAttachmentText(value, partial = false) {
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
  if (encoding) return decode(bytes.subarray(offset), encoding, partial)
  if (isProbablyBinary(bytes)) {
    throw new Error('文件包含二进制内容，无法按文本预览')
  }
  try {
    return decode(bytes, 'utf-8', partial)
  } catch (err) {
    try {
      return decode(bytes, 'gb18030', partial)
    } catch (fallbackErr) {
      throw new Error('无法识别文本编码，请下载后使用本地程序打开')
    }
  }
}

export function formatAttachmentText(value, kind, partial = false) {
  const text = decodeAttachmentText(value, partial)
  if (kind !== 'json' || partial) return text
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
