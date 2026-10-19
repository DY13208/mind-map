const { mapDocument } = require('./mapDocument')

function failure(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

async function parseWithDocling(buffer, options = {}) {
  const base = String(options.url || '').replace(/\/$/, '')
  if (!base) throw failure('DOCLING_NOT_CONFIGURED', 'DOCLING_SERVE_URL 未配置，解析任务不会启动脑图服务')
  const form = new FormData()
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  form.append('files', new Blob([bytes]), options.fileName || 'upload.bin')
  form.append('to_formats', 'json')
  form.append('to_formats', 'md')
  form.append('do_ocr', options.ocr ? 'true' : 'false')
  let response
  try {
    response = await fetch(`${base}/v1/convert/file`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs || 120000)
    })
  } catch (err) {
    throw failure('DOCLING_UNAVAILABLE', `Docling 不可用：${err.message}`)
  }
  const bodyText = await response.text()
  let body
  try {
    body = bodyText ? JSON.parse(bodyText) : {}
  } catch (err) {
    throw failure('DOCLING_BAD_RESPONSE', 'Docling 返回的不是 JSON')
  }
  if (!response.ok) {
    throw failure('DOCLING_HTTP', `Docling HTTP ${response.status} ${bodyText.slice(0, 300)}`)
  }
  const document = body.document || body
  const json = document.json_content || document.jsonContent || null
  const markdown = document.md_content || document.mdContent || ''
  if (!json && !markdown) throw failure('DOCLING_EMPTY', 'Docling 未返回可识别内容')
  const mapped = json
    ? mapDocument(json)
    : mapDocument({
        version: '',
        texts: [{ self_ref: '#/texts/0', label: 'paragraph', text: markdown }],
        body: { children: [{ $ref: '#/texts/0' }] }
      })
  if (!json) mapped.report.unrecognized.push('json_content_missing')
  if (!mapped.blocks.length && !mapped.plainText) {
    throw failure('DOCLING_EMPTY', 'Docling 结果没有任何可保存的块')
  }
  return {
    parser: 'docling',
    parserVersion: mapped.parserVersion,
    mapped,
    raw: json || { markdown }
  }
}

module.exports = { parseWithDocling }
