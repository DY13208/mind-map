const fs = require('node:fs/promises')
const { createMineru } = require('./mineru')
const { formatFor } = require('./formats')
function createDocumentExtractor({ mineru } = {}) {
  return async function extractDocument(file, options = {}) {
    const format = formatFor(file)
    if (!format)
      throw Object.assign(new Error('官方在线 API 未支持该格式'), {
        code: 'unsupported'
      })
    if (format.provider === 'local') {
      const buffer = await fs.readFile(file)
      const text =
        buffer[0] === 0xff && buffer[1] === 0xfe
          ? buffer.subarray(2).toString('utf16le')
          : buffer.toString('utf8').replace(/^\ufeff/, '')
      return [{ page: null, pageMissing: true, text, method: 'text' }]
    }
    mineru ||= createMineru()
    return mineru.extract(file, options)
  }
}
const extractDocument = createDocumentExtractor()
async function checkTools() {
  return createMineru().status()
}
module.exports = { extractDocument, createDocumentExtractor, checkTools }
