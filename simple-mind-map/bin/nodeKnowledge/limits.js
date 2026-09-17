function parseByteLimit(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
const MAX_BYTES = Math.max(
  64 * 1024,
  parseByteLimit(process.env.NODE_KNOWLEDGE_MAX_BYTES, DEFAULT_MAX_BYTES)
)
const MAX_EXTRACT_CHARS = Math.max(
  1000,
  Number(process.env.NODE_KNOWLEDGE_MAX_EXTRACT_CHARS || 20000)
)
const MAX_FILENAME = 180
// Attachment text is handed to MCP clients in slices so a single response
// cannot blow past their output budget.
const DEFAULT_TEXT_SLICE_CHARS = 4000
const MAX_TEXT_SLICE_CHARS = 20000
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const COS_SLICE_BYTES = 8 * 1024 * 1024
const EXTRACT_WAIT_MAX_BYTES = Math.max(
  64 * 1024,
  parseByteLimit(process.env.NODE_KNOWLEDGE_EXTRACT_WAIT_BYTES, 16 * 1024 * 1024)
)
const FILE_NAME_HEADER = 'x-mind-file-name'
const MIME_TYPE_HEADER = 'x-mind-mime-type'
const NODE_UID_HEADER = 'x-mind-node-uid'
const SOURCE_KIND_HEADER = 'x-mind-source-kind'
const FORCE_EXTRACT_HEADER = 'x-mind-force-extract'
const TUS_PATH = '/api/attachments/resumable'
const EXTRACT_CONCURRENCY = Math.max(
  1,
  Number(process.env.NODE_KNOWLEDGE_EXTRACT_CONCURRENCY || 2)
)

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json'])
const HTML_EXTS = new Set(['.html', '.htm'])
const DOC_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.ods', '.pptx'
])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const MIME_BY_EXT = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm':
    'application/vnd.ms-excel.sheet.macroenabled.12',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function extOf(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
  const idx = base.lastIndexOf('.')
  if (idx < 0) return ''
  return base.slice(idx)
}

function normalizeMime(mime, fileName) {
  const raw = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (raw && raw !== 'application/octet-stream') return raw
  return MIME_BY_EXT[extOf(fileName)] || raw || 'application/octet-stream'
}

function isHtmlMime(mimeType) {
  const mime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return mime === 'text/html' || mime === 'application/xhtml+xml'
}

function isAllowedFile(fileName, mimeType) {
  const ext = extOf(fileName)
  const mime = normalizeMime(mimeType, fileName)
  if (
    TEXT_EXTS.has(ext) ||
    HTML_EXTS.has(ext) ||
    DOC_EXTS.has(ext) ||
    IMAGE_EXTS.has(ext)
  ) {
    return true
  }
  if (isHtmlMime(mime)) return true
  if (/^text\//.test(mime)) return true
  if (mime === 'application/pdf') return true
  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel.sheet.macroenabled.12' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return true
  }
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return true
  return false
}

function kindOf(fileName, mimeType) {
  const ext = extOf(fileName)
  const mime = normalizeMime(mimeType, fileName)
  if (HTML_EXTS.has(ext) || isHtmlMime(mime)) return 'html'
  if (IMAGE_EXTS.has(ext) || /^image\//.test(mime)) return 'image'
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf'
  if (ext === '.doc' || mime === 'application/msword') return 'doc'
  if (ext === '.docx' || /wordprocessingml/.test(mime)) return 'docx'
  if (ext === '.pptx' || /presentationml/.test(mime)) return 'pptx'
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls' || ext === '.ods' || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'xlsx'
  if (TEXT_EXTS.has(ext) || /^text\//.test(mime) || mime === 'application/json') {
    return 'text'
  }
  return 'unsupported'
}

function safeFileName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, MAX_FILENAME) || 'file'
}

// The upload MIME is client supplied and must not control how stored bytes are
// served.  Use the allow-listed extension as the source of truth instead.
function trustedMimeType(fileName) {
  return MIME_BY_EXT[extOf(fileName)] || 'application/octet-stream'
}

function encodeContentDispositionFileName(fileName) {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase()
  )
}

function attachmentResponseHeaders(fileName) {
  const safeName = safeFileName(fileName || 'attachment')
  const mimeType = trustedMimeType(safeName)
  const isHtml = mimeType === 'text/html'
  const inline =
    isHtml ||
    mimeType === 'application/pdf' ||
    mimeType.startsWith('image/')
  const headers = {
    // Stored text can be GBK/UTF-16. Do not falsely label its raw bytes UTF-8;
    // the in-app preview decodes bytes explicitly and non-media files download.
    'Content-Type': isHtml ? 'text/html; charset=utf-8' : mimeType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFileName(safeName)}`,
    'X-Content-Type-Options': 'nosniff'
  }
  return headers
}

module.exports = {
  parseByteLimit,
  DEFAULT_MAX_BYTES,
  MAX_BYTES,
  MAX_EXTRACT_CHARS,
  MAX_FILENAME,
  DEFAULT_TEXT_SLICE_CHARS,
  MAX_TEXT_SLICE_CHARS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  COS_SLICE_BYTES,
  EXTRACT_WAIT_MAX_BYTES,
  FILE_NAME_HEADER,
  MIME_TYPE_HEADER,
  NODE_UID_HEADER,
  SOURCE_KIND_HEADER,
  FORCE_EXTRACT_HEADER,
  TUS_PATH,
  EXTRACT_CONCURRENCY,
  TEXT_EXTS,
  HTML_EXTS,
  DOC_EXTS,
  IMAGE_EXTS,
  isHtmlMime,
  MIME_BY_EXT,
  extOf,
  normalizeMime,
  isAllowedFile,
  kindOf,
  safeFileName,
  trustedMimeType,
  encodeContentDispositionFileName,
  attachmentResponseHeaders
}
