/* global module */

const FILE_TYPE_RULES = [
  ['pdf', /\.pdf$/],
  ['word', /\.(doc|docx|odt|rtf)$/],
  ['presentation', /\.(ppt|pptx)$/],
  ['spreadsheet', /\.(xls|xlsx|xlsm|ods|csv)$/],
  ['image', /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/],
  ['html', /\.html?$/],
  ['text', /\.(txt|md|markdown|log|json|xml|ya?ml|js|ts|jsx|tsx|css|vue|py|java|go|sql|sh|bat)$/],
  ['archive', /\.(zip|rar|7z|tar|gz|bz2)$/]
]

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

function getAttachmentFileType(fileName, mimeType = '') {
  const { name, mime } = normalize(fileName, mimeType)
  if (mime === 'application/pdf') return 'pdf'
  if (/presentationml|ms-powerpoint|powerpoint/.test(mime)) return 'presentation'
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(mime)) return 'word'
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(mime)) return 'spreadsheet'
  if (/^image\//.test(mime)) return 'image'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (/^text\//.test(mime) || /json|javascript|xml|yaml/.test(mime)) return 'text'
  if (/zip|compressed|x-rar|x-7z|x-tar/.test(mime)) return 'archive'
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
  getAttachmentFileType,
  getAttachmentFileIconType
}
