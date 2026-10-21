'use strict'
const ALLOWED = {
  pdf: { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xls: { mime: 'application/vnd.ms-excel', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  csv: { mime: 'text/csv', magic: null },
  html: { mime: 'text/html', magic: null },
  htm: { mime: 'text/html', magic: null },
  md: { mime: 'text/markdown', magic: null },
  txt: { mime: 'text/plain', magic: null },
  png: { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  tif: { mime: 'image/tiff', magic: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  tiff: { mime: 'image/tiff', magic: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  bmp: { mime: 'image/bmp', magic: [[0x42, 0x4d]] },
  webp: { mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] }
}
const EXCEL = new Set(['xlsx', 'xls'])

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop()
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean || 'unnamed'
}

function checkMagic(ext, head) {
  const spec = ALLOWED[ext]
  if (!spec) return false
  if (!spec.magic) {
    // text formats: reject NUL bytes in the first chunk
    if (ext === 'txt' && head.length >= 2 &&
        ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true
    return !head.subarray(0, 4096).includes(0)
  }
  return spec.magic.some(sig => sig.every((b, i) => head[i] === b))
}

module.exports = { ALLOWED, EXCEL, extOf, sanitizeName, checkMagic }
