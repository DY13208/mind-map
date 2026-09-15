const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const TEXT_EXT = /\.(txt|log|csv)$/i

export function attachmentPreviewKind(fileName, mimeType = '') {
  const name = String(fileName || '')
  const mime = String(mimeType || '').toLowerCase().split(';')[0]
  if (IMAGE_EXT.test(name) || /^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    return 'image'
  }
  if (/\.pdf$/i.test(name) || mime === 'application/pdf') return 'pdf'
  if (/\.(md|markdown)$/i.test(name) || mime === 'text/markdown') return 'markdown'
  if (/\.json$/i.test(name) || mime === 'application/json') return 'json'
  if (/\.(docx|xlsx)$/i.test(name) || /wordprocessingml|spreadsheetml/.test(mime)) {
    return 'office'
  }
  if (TEXT_EXT.test(name) || /^text\//.test(mime)) return 'text'
  return 'unsupported'
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
}

function isProbablyBinary(bytes) {
  if (!bytes.length) return false
  let controls = 0
  const sampleLength = Math.min(bytes.length, 4096)
  for (let index = 0; index < sampleLength; index += 1) {
    const value = bytes[index]
    if (value === 0) return true
    if (value < 0x09 || (value > 0x0d && value < 0x20)) controls += 1
  }
  return controls > sampleLength * 0.12
}

function utf16EncodingFromPattern(bytes) {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 512)
  if (sampleLength < 8) return ''
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenZeros += 1
    if (bytes[index + 1] === 0) oddZeros += 1
  }
  const pairs = sampleLength / 2
  if (oddZeros > pairs * 0.35) return 'utf-16le'
  if (evenZeros > pairs * 0.35) return 'utf-16be'
  return ''
}

function decode(bytes, encoding, fatal = true) {
  return new TextDecoder(encoding, { fatal }).decode(bytes)
}

export function decodeAttachmentText(value) {
  const bytes = asBytes(value)
  if (!bytes.length) return ''
  let encoding = ''
  let offset = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8'
    offset = 3
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    offset = 2
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    offset = 2
  } else {
    encoding = utf16EncodingFromPattern(bytes)
  }
  if (encoding) return decode(bytes.subarray(offset), encoding)
  if (isProbablyBinary(bytes)) {
    throw new Error('文件包含二进制内容，无法按文本预览')
  }
  try {
    return decode(bytes, 'utf-8')
  } catch (err) {
    try {
      return decode(bytes, 'gb18030')
    } catch (fallbackErr) {
      throw new Error('无法识别文本编码，请下载后使用本地程序打开')
    }
  }
}

export function formatAttachmentText(value, kind) {
  const text = decodeAttachmentText(value)
  if (kind !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch (err) {
    return text
  }
}

export function formatOfficePreviewText(value, fileName) {
  const text = String(value || '')
  if (!/\.xlsx$/i.test(String(fileName || ''))) return text
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/(?:,\s*)+$/, ''))
    .filter(line => line.replace(/[\s,]/g, '').length > 0)
    .join('\n')
}

export function safeMarkdownSource(value) {
  return String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
