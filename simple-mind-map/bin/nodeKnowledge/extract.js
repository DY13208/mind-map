const JSZip = require('jszip')
const { kindOf, normalizeMime, MAX_EXTRACT_CHARS } = require('./limits')

function clip(text, max = MAX_EXTRACT_CHARS) {
  const value = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

function decodeTextBuffer(buffer) {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // Reject buffers that look mostly binary.
  const sample = text.slice(0, 4000)
  const bad = (sample.match(/[^\x09\x0a\x0d\x20-\x7e\u0080-\uFFFF]/g) || [])
    .length
  if (bad > sample.length * 0.3) {
    const err = new Error('文本文件包含过多二进制内容')
    err.code = 'BINARY_TEXT'
    throw err
  }
  return clip(text)
}

function stripXml(xml) {
  return String(xml || '')
    .replace(/<w:tab[^/]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const doc = zip.file('word/document.xml')
  if (!doc) {
    const err = new Error('DOCX 缺少 document.xml')
    err.code = 'DOCX_INVALID'
    throw err
  }
  const xml = await doc.async('string')
  return clip(stripXml(xml))
}

async function extractXlsx(buffer) {
  try {
    const XLSX = require('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer', raw: false })
    const parts = []
    workbook.SheetNames.slice(0, 10).forEach(name => {
      const sheet = workbook.Sheets[name]
      if (!sheet) return
      const csv = XLSX.utils.sheet_to_csv(sheet)
      if (csv && csv.trim()) parts.push(`# ${name}\n${csv.trim()}`)
    })
    if (!parts.length) {
      const err = new Error('XLSX 无可提取文本')
      err.code = 'XLSX_EMPTY'
      throw err
    }
    return clip(parts.join('\n\n'))
  } catch (err) {
    if (err && err.code) throw err
    // Fallback: sharedStrings only
    const zip = await JSZip.loadAsync(buffer)
    const shared = zip.file('xl/sharedStrings.xml')
    if (!shared) {
      const next = new Error(
        err && err.message
          ? `XLSX 解析失败：${err.message}`
          : 'XLSX 解析失败'
      )
      next.code = 'XLSX_PARSE_FAILED'
      throw next
    }
    const xml = await shared.async('string')
    return clip(stripXml(xml).replace(/\n{3,}/g, '\n\n'))
  }
}

function extractPdfText(buffer) {
  const raw = buffer.toString('latin1')
  const chunks = []
  const re = /BT([\s\S]*?)ET/g
  let match
  while ((match = re.exec(raw))) {
    const body = match[1]
    const parts = []
    const tj = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g
    let piece
    while ((piece = tj.exec(body))) {
      const token = piece[0]
      if (token.endsWith('Tj')) {
        const inner = token.replace(/\s*Tj$/, '').trim()
        if (inner.startsWith('(') && inner.endsWith(')')) {
          parts.push(unescapePdfString(inner.slice(1, -1)))
        }
      } else {
        const arr = token.replace(/\s*TJ$/, '').trim()
        const strRe = /\((?:\\.|[^\\)])*\)/g
        let s
        while ((s = strRe.exec(arr))) {
          parts.push(unescapePdfString(s[0].slice(1, -1)))
        }
      }
    }
    if (parts.length) chunks.push(parts.join(''))
  }
  const text = chunks.join('\n').replace(/[^\S\n]+/g, ' ').trim()
  if (!text) {
    const err = new Error('PDF 未提取到文字（可能是扫描件，需 OCR）')
    err.code = 'PDF_NO_TEXT'
    throw err
  }
  return clip(text)
}

function unescapePdfString(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

async function ocrViaHttp(buffer, mimeType, fileName) {
  const endpoint = String(process.env.NODE_KNOWLEDGE_OCR_URL || '').trim()
  if (!endpoint) {
    const err = new Error(
      '图片 OCR 未配置：请设置 NODE_KNOWLEDGE_OCR_URL，或改用已提取文字'
    )
    err.code = 'OCR_NOT_CONFIGURED'
    throw err
  }
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, Math.max(3000, Number(process.env.NODE_KNOWLEDGE_OCR_TIMEOUT_MS || 30000)))
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller ? controller.signal : undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: process.env.NODE_KNOWLEDGE_OCR_TOKEN
          ? `Bearer ${process.env.NODE_KNOWLEDGE_OCR_TOKEN}`
          : undefined
      },
      body: JSON.stringify({
        fileName,
        mimeType,
        contentBase64: buffer.toString('base64')
      })
    })
    if (!res.ok) {
      const err = new Error(`OCR 服务失败 HTTP ${res.status}`)
      err.code = 'OCR_FAILED'
      throw err
    }
    const data = await res.json().catch(() => ({}))
    const text = clip(data.text || data.extractedText || data.result || '')
    if (!text) {
      const err = new Error('OCR 服务未返回文本')
      err.code = 'OCR_EMPTY'
      throw err
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function ocrViaTesseract(buffer) {
  let Tesseract
  try {
    Tesseract = require('tesseract.js')
  } catch (e) {
    const err = new Error('本地 OCR 未安装（缺少 tesseract.js）')
    err.code = 'OCR_NOT_CONFIGURED'
    throw err
  }
  const langs = String(process.env.NODE_KNOWLEDGE_OCR_LANGS || 'eng+chi_sim')
  const result = await Tesseract.recognize(buffer, langs, {
    logger: () => {}
  })
  const text = clip(result && result.data && result.data.text)
  if (!text) {
    const err = new Error('本地 OCR 未识别到文字')
    err.code = 'OCR_EMPTY'
    throw err
  }
  return text
}

async function ocrImage(buffer, mimeType, fileName) {
  const endpoint = String(process.env.NODE_KNOWLEDGE_OCR_URL || '').trim()
  if (endpoint) {
    try {
      return await ocrViaHttp(buffer, mimeType, fileName)
    } catch (err) {
      // Fall through to local OCR when remote OCR is unavailable.
      try {
        return await ocrViaTesseract(buffer)
      } catch (localErr) {
        throw err
      }
    }
  }
  return ocrViaTesseract(buffer)
}

async function extractBuffer(buffer, options = {}) {
  const fileName = options.fileName || 'file'
  const mimeType = normalizeMime(options.mimeType, fileName)
  const kind = kindOf(fileName, mimeType)
  if (kind === 'text') {
    return {
      kind,
      status: 'ready',
      extractedText: decodeTextBuffer(buffer),
      errorMessage: ''
    }
  }
  if (kind === 'docx') {
    return {
      kind,
      status: 'ready',
      extractedText: await extractDocx(buffer),
      errorMessage: ''
    }
  }
  if (kind === 'xlsx') {
    return {
      kind,
      status: 'ready',
      extractedText: await extractXlsx(buffer),
      errorMessage: ''
    }
  }
  if (kind === 'pdf') {
    try {
      return {
        kind,
        status: 'ready',
        extractedText: extractPdfText(buffer),
        errorMessage: ''
      }
    } catch (err) {
      if (err && err.code === 'PDF_NO_TEXT') {
        // Fall through to OCR for scanned PDFs when configured.
        try {
          const text = await ocrImage(buffer, 'application/pdf', fileName)
          return {
            kind,
            status: 'ready',
            extractedText: text,
            errorMessage: ''
          }
        } catch (ocrErr) {
          return {
            kind,
            status: 'failed',
            extractedText: '',
            errorMessage: err.message
          }
        }
      }
      throw err
    }
  }
  if (kind === 'image') {
    try {
      const text = await ocrImage(buffer, mimeType, fileName)
      return {
        kind,
        status: 'ready',
        extractedText: text,
        errorMessage: ''
      }
    } catch (err) {
      return {
        kind,
        status: 'failed',
        extractedText: '',
        errorMessage: (err && err.message) || '图片 OCR 失败'
      }
    }
  }
  return {
    kind: 'unsupported',
    status: 'failed',
    extractedText: '',
    errorMessage: `不支持的文件类型：${mimeType || fileName}`
  }
}

module.exports = {
  clip,
  decodeTextBuffer,
  extractDocx,
  extractXlsx,
  extractPdfText,
  extractBuffer,
  ocrViaHttp,
  ocrViaTesseract,
  ocrImage
}
