// 本地盘符 / file:// 不能当超链接（浏览器无法跨端打开），应上传为附件。

function trimInput(value) {
  return String(value == null ? '' : value).trim()
}

export function isLocalFileReference(value) {
  const input = trimInput(value)
  if (!input) return false
  if (/^file:/i.test(input)) return true
  // Windows: D:\path or D:/path
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true
  // UNC: \\server\share
  if (/^\\\\[^\\/]+\\/.test(input)) return true
  // file:/C:/... (少见变体)
  if (/^file:\/*/i.test(input)) return true
  return false
}

export function localFileDisplayName(value) {
  const input = trimInput(value)
  if (!input) return ''
  let path = input
  try {
    if (/^file:/i.test(input)) {
      const parsed = new URL(input)
      path = decodeURIComponent(parsed.pathname || '')
      // URL pathname on Windows is like /D:/foo
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
