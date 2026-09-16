const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const {
  MAX_BYTES,
  FILE_NAME_HEADER,
  MIME_TYPE_HEADER,
  NODE_UID_HEADER,
  SOURCE_KIND_HEADER,
  FORCE_EXTRACT_HEADER
} = require('./limits')

function headerValue(req, name) {
  const headers = (req && req.headers) || {}
  return String(headers[name] || headers[String(name).toLowerCase()] || '')
}

function decodeHeaderFileName(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (err) {
    return value
  }
}

function isJsonContentType(req) {
  const type = String((req && req.headers && req.headers['content-type']) || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return type === 'application/json'
}

function isBinaryAttachmentUpload(req) {
  if (!req || req.method !== 'POST') return false
  if (isJsonContentType(req)) return false
  if (headerValue(req, FILE_NAME_HEADER)) return true
  const type = String((req.headers && req.headers['content-type']) || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return type === 'application/octet-stream'
}

function fileTooLargeError(maxBytes = MAX_BYTES) {
  const err = new Error(`文件过大（最多 ${maxBytes} 字节）`)
  err.statusCode = 413
  err.code = 'FILE_TOO_LARGE'
  return err
}

function metaFromHeaders(req) {
  return {
    fileName: decodeHeaderFileName(headerValue(req, FILE_NAME_HEADER)) || 'file',
    mimeType: headerValue(req, MIME_TYPE_HEADER) || 'application/octet-stream',
    nodeUid: headerValue(req, NODE_UID_HEADER),
    sourceKind: headerValue(req, SOURCE_KIND_HEADER) || 'attachment',
    forceExtract: /^(1|true|yes)$/i.test(headerValue(req, FORCE_EXTRACT_HEADER))
  }
}

function declaredContentLength(req) {
  const raw = Number((req && req.headers && req.headers['content-length']) || 0)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

async function receiveBinaryToTempFile(req, maxBytes = MAX_BYTES) {
  const declared = declaredContentLength(req)
  if (declared > maxBytes) {
    try {
      req.destroy()
    } catch (err) {
      // ignore
    }
    throw fileTooLargeError(maxBytes)
  }
  const filePath = path.join(
    os.tmpdir(),
    `mm-att-${crypto.randomBytes(16).toString('hex')}`
  )
  let size = 0
  const limiter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length
      if (size > maxBytes) {
        return cb(fileTooLargeError(maxBytes))
      }
      cb(null, chunk)
    }
  })
  try {
    await pipeline(req, limiter, fs.createWriteStream(filePath))
  } catch (err) {
    await fs.promises.unlink(filePath).catch(() => {})
    throw err
  }
  return { filePath, byteSize: size }
}

function unlinkQuiet(filePath) {
  if (!filePath) return Promise.resolve()
  return fs.promises.unlink(filePath).catch(() => {})
}

module.exports = {
  isJsonContentType,
  isBinaryAttachmentUpload,
  decodeHeaderFileName,
  metaFromHeaders,
  declaredContentLength,
  receiveBinaryToTempFile,
  unlinkQuiet,
  fileTooLargeError
}
