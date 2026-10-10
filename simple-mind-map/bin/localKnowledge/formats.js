const path = require('node:path')
const LOCAL = new Set(['.txt', '.md', '.csv', '.tsv', '.json'])
const ONLINE = new Map(
  [
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.jp2',
    '.webp',
    '.gif',
    '.bmp',
    '.doc',
    '.docx',
    '.ppt',
    '.pptx',
    '.xls',
    '.xlsx'
  ].map(ext => [ext, 'vlm'])
)
ONLINE.set('.html', 'MinerU-HTML')
function formatFor(file) {
  const ext = path.extname(file).toLowerCase()
  return LOCAL.has(ext)
    ? { ext, provider: 'local' }
    : ONLINE.has(ext)
    ? { ext, provider: 'mineru', model: ONLINE.get(ext) }
    : null
}
function extractionKey(file) {
  const format = formatFor(file)
  return format?.provider === 'mineru'
    ? 'mineru-v4-' + format.model + '-1'
    : format
    ? 'local-1'
    : 'unsupported-1'
}
module.exports = { formatFor, extractionKey }
