/* global module */

// Keep archive extensions and MIME aliases in this shared module so the web
// picker, preview, icons, and server upload checks use the same allowlist.
const ARCHIVE_EXTENSIONS = Object.freeze([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  '.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz2', '.txz'
])
const ARCHIVE_EXTENSION_PATTERN = new RegExp(
  `(?:${ARCHIVE_EXTENSIONS.map(extension =>
    extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})$`
)

const FILE_TYPE_RULES = [
  ['pdf', /\.pdf$/],
  ['word', /\.(doc|docx|odt|rtf)$/],
  ['presentation', /\.(ppt|pptx)$/],
  ['spreadsheet', /\.(xls|xlsx|xlsm|ods|csv)$/],
  ['image', /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/],
  ['html', /\.html?$/],
  ['text', /\.(txt|md|markdown|log|json|xml|ya?ml|js|ts|jsx|tsx|css|vue|py|java|go|sql|sh|bat)$/],
  ['archive', ARCHIVE_EXTENSION_PATTERN]
]

const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/vnd.rar',
  'application/rar',
  'application/x-rar',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/7z',
  'application/x-7z',
  'application/x-tar',
  'application/tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/bzip2',
  'application/x-bz2',
  'application/x-xz',
  'application/xz'
])
const ARCHIVE_MIME_BY_EXTENSION = Object.freeze({
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.tgz': 'application/gzip',
  '.tbz2': 'application/x-bzip2',
  '.txz': 'application/x-xz'
})

// Finer-grained types used only for choosing an icon. getAttachmentFileType()
// keeps its original return values for backwards compatibility.
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/
const CODE_EXT = /\.(json|jsonc|js|mjs|cjs|ts|jsx|tsx|vue|css|scss|less|py|java|go|rs|c|h|cpp|hpp|cs|rb|php|kt|swift|sql|sh|bat|ps1|xml|ya?ml|toml|ini)$/
const AUDIO_EXT = /\.(mp3|wav|m4a|flac|ogg|oga|aac|opus|wma)$/
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpeg|mpg)$/

function normalize(fileName, mimeType) {
  return {
    name: String(fileName || '').trim().toLowerCase(),
    mime: String(mimeType || '').toLowerCase().split(';')[0].trim()
  }
}

function isArchiveAttachment(fileName, mimeType = '') {
  const { name, mime } = normalize(fileName, mimeType)
  if (ARCHIVE_EXTENSIONS.some(extension => name.endsWith(extension))) return true

  // File extensions win over a misleading container MIME: DOCX/XLSX are ZIP
  // containers too, but remain Office attachments when the browser reports
  // application/zip for them.
  const recognizedExtension = FILE_TYPE_RULES.some(([, pattern]) => pattern.test(name))
  return !recognizedExtension && ARCHIVE_MIME_TYPES.has(mime)
}

function getAttachmentFileType(fileName, mimeType = '') {
  const { name, mime } = normalize(fileName, mimeType)
  if (ARCHIVE_EXTENSIONS.some(extension => name.endsWith(extension))) return 'archive'
  if (mime === 'application/pdf') return 'pdf'
  if (/presentationml|ms-powerpoint|powerpoint/.test(mime)) return 'presentation'
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(mime)) return 'word'
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(mime)) return 'spreadsheet'
  if (/^image\//.test(mime)) return 'image'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (/^text\//.test(mime) || /json|javascript|xml|yaml/.test(mime)) return 'text'
  if (isArchiveAttachment(name, mime)) return 'archive'
  const rule = FILE_TYPE_RULES.find(([, pattern]) => pattern.test(name))
  return rule ? rule[0] : 'attachment'
}

// Icon type: pdf | word | presentation | spreadsheet | image | html | text |
// archive | markdown | code | audio | video | attachment (unknown).
function getAttachmentFileIconType(fileName, mimeType = '') {
  const { name, mime } = normalize(fileName, mimeType)
  const base = getAttachmentFileType(fileName, mimeType)
  if (base === 'text' || base === 'attachment') {
    if (mime === 'text/markdown' || mime === 'text/x-markdown' || MARKDOWN_EXT.test(name)) return 'markdown'
    if (/json|javascript|typescript|x-python|x-sh|yaml|xml/.test(mime) || CODE_EXT.test(name)) return 'code'
  }
  if (base === 'attachment') {
    if (/^audio\//.test(mime) || AUDIO_EXT.test(name)) return 'audio'
    if (/^video\//.test(mime) || VIDEO_EXT.test(name)) return 'video'
  }
  return base
}

module.exports = {
  ARCHIVE_EXTENSIONS,
  ARCHIVE_MIME_TYPES,
  ARCHIVE_MIME_BY_EXTENSION,
  isArchiveAttachment,
  getAttachmentFileType,
  getAttachmentFileIconType
}
