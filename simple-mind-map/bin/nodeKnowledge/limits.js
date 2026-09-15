const MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.NODE_KNOWLEDGE_MAX_BYTES || 5 * 1024 * 1024)
)
const MAX_EXTRACT_CHARS = Math.max(
  1000,
  Number(process.env.NODE_KNOWLEDGE_MAX_EXTRACT_CHARS || 20000)
)
const MAX_FILENAME = 180

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json'])
const DOC_EXTS = new Set(['.pdf', '.docx', '.xlsx'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const MIME_BY_EXT = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

function isAllowedFile(fileName, mimeType) {
  const ext = extOf(fileName)
  const mime = normalizeMime(mimeType, fileName)
  if (TEXT_EXTS.has(ext) || DOC_EXTS.has(ext) || IMAGE_EXTS.has(ext)) {
    return true
  }
  if (/^text\//.test(mime)) return true
  if (mime === 'application/pdf') return true
  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return true
  }
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return true
  return false
}

function kindOf(fileName, mimeType) {
  const ext = extOf(fileName)
  const mime = normalizeMime(mimeType, fileName)
  if (IMAGE_EXTS.has(ext) || /^image\//.test(mime)) return 'image'
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf'
  if (ext === '.docx' || /wordprocessingml/.test(mime)) return 'docx'
  if (ext === '.xlsx' || /spreadsheetml/.test(mime)) return 'xlsx'
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
  const inline = mimeType === 'application/pdf' || mimeType.startsWith('image/')
  return {
    // Stored text can be GBK/UTF-16. Do not falsely label its raw bytes UTF-8;
    // the in-app preview decodes bytes explicitly and non-media files download.
    'Content-Type': mimeType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFileName(safeName)}`,
    'X-Content-Type-Options': 'nosniff'
  }
}

module.exports = {
  MAX_BYTES,
  MAX_EXTRACT_CHARS,
  MAX_FILENAME,
  TEXT_EXTS,
  DOC_EXTS,
  IMAGE_EXTS,
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
