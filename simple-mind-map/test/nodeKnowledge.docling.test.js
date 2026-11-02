const assert = require('assert').strict
const fs = require('fs')
const os = require('os')
const path = require('path')

function docWithText(text) {
  return {
    body: { children: [{ $ref: '#/texts/0' }] },
    texts: [{ label: 'text', text, prov: [{ page_no: 1 }] }],
    pages: { 1: { size: { width: 800, height: 1000 } } }
  }
}

async function main() {
  assert.ok(globalThis.FormData && globalThis.Blob && globalThis.Response,
    'Node 20 web APIs are required for the Docling multipart client')

  const originalFetch = globalThis.fetch
  const originalEnv = {
    DOCLING_URL: process.env.DOCLING_URL,
    DOCLING_API_KEY: process.env.DOCLING_API_KEY,
    KB_DOCLING_OCR_MODE: process.env.KB_DOCLING_OCR_MODE,
    KB_DOCLING_OCR_ENGINE: process.env.KB_DOCLING_OCR_ENGINE,
    KB_DOCLING_OCR_TOTAL_TIMEOUT_MS: process.env.KB_DOCLING_OCR_TOTAL_TIMEOUT_MS,
    KB_DOCLING_TOTAL_TIMEOUT_MS: process.env.KB_DOCLING_TOTAL_TIMEOUT_MS,
    NODE_KNOWLEDGE_OCR_URL: process.env.NODE_KNOWLEDGE_OCR_URL
  }
  const requests = []
  const tasks = new Map()
  let nextTaskId = 1

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/v1/convert/file/async') {
      const form = init.body
      const file = form.get('files')
      const taskId = `mock-task-${nextTaskId++}`
      const task = {
        taskId,
        fileName: file.name,
        mimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
        doOcr: form.get('do_ocr'),
        forceOcr: form.get('force_ocr'),
        engine: form.get('ocr_preset'),
        ext: form.get('from_formats')
      }
      requests.push(task)
      tasks.set(taskId, task)
      return new Response(JSON.stringify({ task_id: taskId, task_status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const statusMatch = parsed.pathname.match(/^\/v1\/status\/poll\/(.+)$/)
    if (statusMatch) {
      const task = tasks.get(decodeURIComponent(statusMatch[1]))
      const taskStatus = /识别失败\.png$/i.test(task.fileName) && task.doOcr === 'true'
        ? 'failure'
        : 'success'
      return new Response(JSON.stringify({ task_status: taskStatus }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const resultMatch = parsed.pathname.match(/^\/v1\/result\/(.+)$/)
    if (resultMatch) {
      const task = tasks.get(decodeURIComponent(resultMatch[1]))
      const isImage = /\.png$/i.test(task.fileName)
      if (/识别失败\.png$/i.test(task.fileName) && task.doOcr === 'true') {
        return new Response(JSON.stringify({
          status: 'failure', errors: [{ message: 'mock OCR engine crashed' }],
          document: { json_content: { body: { children: [] }, texts: [], pages: { 1: {} } } }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      const text = isImage && task.forceOcr !== 'true'
        ? ''
        : isImage
          ? 'LOCAL OCR ACCEPTANCE 20261102 Invoice total 12345.67 USD'
          : 'LOCAL PDF ACCEPTANCE 20261102 9876.54'
      const json = text ? docWithText(text) : { body: { children: [] }, texts: [], pages: { 1: {} } }
      return new Response(JSON.stringify({ status: 'success', document: { json_content: json }, errors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    throw new Error(`unexpected Docling request: ${url}`)
  }

  process.env.DOCLING_URL = 'http://docling.mock'
  process.env.DOCLING_API_KEY = 'mock-key'
  process.env.KB_DOCLING_OCR_MODE = 'auto'
  process.env.KB_DOCLING_OCR_ENGINE = 'rapidocr'
  process.env.KB_DOCLING_OCR_TOTAL_TIMEOUT_MS = '10000'
  process.env.KB_DOCLING_TOTAL_TIMEOUT_MS = '10000'
  delete process.env.NODE_KNOWLEDGE_OCR_URL

  try {
    const extract = require('../bin/nodeKnowledge/extract')
    const store = require('../bin/nodeKnowledge/store')
    assert.equal(extract.shouldUseDocling('中文图像.PNG', 'image/png'), true)
    assert.equal(extract.shouldUseDocling('扫描件.PDF', 'application/pdf'), true)

    const imageBytes = Buffer.from('mock png bytes')
    const image = await extract.extractBuffer(imageBytes, {
      fileName: '中文验收.PNG', mimeType: 'image/png'
    })
    assert.equal(image.status, 'ready')
    assert.match(image.extractedText, /LOCAL OCR ACCEPTANCE 20261102/)
    assert.equal(requests.length, 2, 'auto OCR should perform a plain pass then an OCR pass for a scan')
    assert.equal(requests[0].doOcr, 'false')
    assert.equal(requests[1].doOcr, 'true')
    assert.equal(requests[1].forceOcr, 'true')
    assert.equal(requests[1].engine, 'rapidocr')
    assert.equal(requests[0].fileName, '中文验收.PNG')
    assert.equal(requests[0].mimeType, 'image/png')
    assert.deepEqual(requests[0].bytes, imageBytes)
    assert.deepEqual(requests[1].bytes, imageBytes)

    const failedImage = await extract.extractBuffer(Buffer.from('mock png bytes'), {
      fileName: '识别失败.png', mimeType: 'image/png'
    })
    assert.equal(failedImage.status, 'failed')
    assert.match(failedImage.errorMessage, /OCR fallback 失败/)
    assert.match(failedImage.errorMessage, /mock OCR engine crashed/,
      'OCR二阶段失败时应保留Docling返回的具体错误')

    const requestCountBeforeTextPdf = requests.length
    const pdf = await extract.extractBuffer(Buffer.from('%PDF test'), {
      fileName: '正文.pdf', mimeType: 'application/pdf'
    })
    assert.equal(pdf.status, 'ready')
    assert.match(pdf.extractedText, /LOCAL PDF ACCEPTANCE 20261102/)
    assert.equal(requests.length, requestCountBeforeTextPdf + 1,
      'text PDF should finish from the first pass without OCR')

    const archive = await extract.extractBuffer(Buffer.from('opaque'), {
      fileName: '加密备份.zip', mimeType: 'application/zip'
    })
    assert.equal(archive.status, 'ready')
    assert.equal(archive.extractedText, '')
    assert.equal(requests.length, requestCountBeforeTextPdf + 1,
      'archives must bypass Docling')

    process.env.NODE_KNOWLEDGE_OCR_URL = 'http://legacy-ocr.mock'
    assert.equal(extract.shouldUseDocling('中文验收.png', 'image/png'), false,
      'explicit legacy OCR URL must retain precedence')
    delete process.env.NODE_KNOWLEDGE_OCR_URL

    const rows = new Map()
    const db = {
      async query(sql, params = []) {
        const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (text.startsWith('insert into node_attachments')) {
          const row = {
            id: params[0], room_key: params[1], node_uid: params[2],
            content_hash: params[3], file_name: params[4], mime_type: params[5],
            byte_size: params[6], cos_key: params[7], status: params[8],
            error_message: '', extracted_text: '', extracted_chars: 0,
            source_kind: params[9], created_by: params[10],
            created_at: new Date(), updated_at: new Date()
          }
          rows.set(row.id, row)
          return { rows: [row] }
        }
        if (text.startsWith('select * from node_attachments where room_key = $1 and content_hash = $2')) {
          return { rows: [] }
        }
        if (text.startsWith('update node_attachments set updated_at = now()')) {
          const row = rows.get(params[0])
          if (row && row.status === 'processing') row.updated_at = new Date()
          return { rows: row ? [{ id: row.id }] : [] }
        }
        if (text.startsWith('update node_attachments set status = $2')) {
          const row = rows.get(params[0])
          if (!row) return { rows: [] }
          row.status = params[1]
          row.error_message = params[2]
          row.extracted_text = params[3]
          row.extracted_chars = params[4]
          row.updated_at = new Date()
          return { rows: [row] }
        }
        return { rows: [] }
      }
    }
    const beforeUpload = requests.length
    const uploaded = await store.createFromBuffer(db, {
      roomKey: 'room-docling-test',
      buffer: Buffer.from('async upload png'),
      fileName: '异步上传.png',
      mimeType: 'image/png'
    })
    assert.equal(uploaded.status, 'processing', 'Docling OCR must not block the upload response')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && rows.get(uploaded.id).status === 'processing') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(rows.get(uploaded.id).status, 'ready')
    assert.match(rows.get(uploaded.id).extracted_text, /LOCAL OCR ACCEPTANCE 20261102/)
    assert.equal(requests.length, beforeUpload + 2)

    // Keep the pre-existing public submit(filePath, fileName, ext, signal, pass)
    // signature working for other File KB callers.
    const tempPath = path.join(os.tmpdir(), `docling-submit-${process.pid}.pdf`)
    const legacyBytes = Buffer.from('%PDF legacy submit contract')
    fs.writeFileSync(tempPath, legacyBytes)
    try {
      const { createDoclingClient } = require('../../services/file-kb/src/docling/client')
      const client = createDoclingClient({
        baseUrl: 'http://docling.mock', fetchImpl: globalThis.fetch, ocrMode: 'off'
      })
      await client.submit(tempPath, '旧签名.pdf', 'pdf', undefined, {
        ocr: false, force: false, documentTimeoutS: 60, totalTimeoutMs: 10000
      })
      const legacyRequest = requests[requests.length - 1]
      assert.equal(legacyRequest.fileName, '旧签名.pdf')
      assert.deepEqual(legacyRequest.bytes, legacyBytes)
    } finally {
      fs.rmSync(tempPath, { force: true })
    }

    console.log('nodeKnowledge Docling mock contract passed')
  } finally {
    globalThis.fetch = originalFetch
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
