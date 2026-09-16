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

function getAttachmentFileType(fileName, mimeType = '') {
  const name = String(fileName || '').trim().toLowerCase()
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim()
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

module.exports = {
  getAttachmentFileType
}
