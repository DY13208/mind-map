// 本地盘符 / file:// 不能当超链接（浏览器无法跨端打开），应上传为附件。

function trimInput(value) {
  return String(value == null ? '' : value).trim()
}

function isLocalFileReference(value) {
  const input = trimInput(value)
  if (!input) return false
  if (/^file:/i.test(input)) return true
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true
  if (/^\\\\[^\\/]+\\/.test(input)) return true
  return false
}

function localFileDisplayName(value) {
  const input = trimInput(value)
  if (!input) return ''
  let path = input
  try {
    if (/^file:/i.test(input)) {
      const parsed = new URL(input)
      path = decodeURIComponent(parsed.pathname || '')
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    }
  } catch (e) {
    path = input.replace(/^file:\/*/i, '')
    try {
      path = decodeURIComponent(path)
    } catch (err) {
      // keep raw
    }
  }
  path = path.replace(/\\/g, '/')
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

function assertHttpHyperlink(value, field = 'hyperlink') {
  const text = trimInput(value)
  if (!text) return ''
  if (!isLocalFileReference(text)) return text
  const name = localFileDisplayName(text) || text
  const err = new Error(
    `本地文件「${name}」不能写入超链接，请使用 upload_attachment 上传附件（等同工具栏「附件」）`
  )
  err.code = 'LOCAL_FILE_HYPERLINK'
  err.statusCode = 400
  err.field = field
  err.fileName = name
  throw err
}

// 节点 patch / data 写入前统一校验（MCP、HTTP Direct、legacy 共用）
function sanitizeHyperlinkFields(input = {}) {
  if (!input || typeof input !== 'object') return input
  if (Object.prototype.hasOwnProperty.call(input, 'hyperlink')) {
    const next = assertHttpHyperlink(input.hyperlink, 'hyperlink')
    input.hyperlink = next === '' ? '' : next
  }
  return input
}

module.exports = {
  isLocalFileReference,
  localFileDisplayName,
  assertHttpHyperlink,
  sanitizeHyperlinkFields
}
