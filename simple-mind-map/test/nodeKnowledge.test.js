const assert = require('assert').strict
const JSZip = require('jszip')
const limits = require('../bin/nodeKnowledge/limits')
const ssrf = require('../bin/nodeKnowledge/ssrf')
const extract = require('../bin/nodeKnowledge/extract')
const store = require('../bin/nodeKnowledge/store')

function createMemoryDb() {
  const rows = new Map()
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (text.startsWith('create') || text.startsWith('alter')) {
        return { rows: [] }
      }
      if (text.includes('insert into node_attachments')) {
        const row = {
          id: params[0],
          room_key: params[1],
          node_uid: params[2],
          content_hash: params[3],
          file_name: params[4],
          mime_type: params[5],
          byte_size: params[6],
          cos_key: params[7],
          status: 'processing',
          error_message: '',
          extracted_text: '',
          extracted_chars: 0,
          source_kind: params[8],
          created_by: params[9],
          created_at: new Date(),
          updated_at: new Date()
        }
        rows.set(row.id, row)
        rows.set(`hash:${row.room_key}:${row.content_hash}`, row)
        return { rows: [row] }
      }
      if (text.includes('update node_attachments set')) {
        const row = rows.get(params[0])
        if (!row) return { rows: [] }
        row.status = params[1]
        row.error_message = params[2]
        row.extracted_text = params[3]
        row.extracted_chars = params[4]
        row.updated_at = new Date()
        return { rows: [row] }
      }
      if (text.includes('where room_key = $1 and content_hash = $2')) {
        const row = rows.get(`hash:${params[0]}:${params[1]}`)
        return { rows: row ? [row] : [] }
      }
      if (text.includes('where room_key = $1 and id = $2')) {
        const row = rows.get(params[1])
        if (!row || row.room_key !== params[0]) return { rows: [] }
        return { rows: [row] }
      }
      if (text.includes('id = any($2::text[])')) {
        const list = (params[1] || [])
          .map(id => rows.get(id))
          .filter(row => row && row.room_key === params[0])
        return { rows: list }
      }
      return { rows: [] }
    }
  }
}

async function main() {
  assert.equal(limits.isAllowedFile('a.txt', 'text/plain'), true)
  assert.equal(limits.isAllowedFile('a.pdf', 'application/pdf'), true)
  assert.equal(limits.isAllowedFile('a.docx', ''), true)
  assert.equal(limits.isAllowedFile('a.xlsx', ''), true)
  assert.equal(limits.isAllowedFile('a.xlsm', ''), true)
  assert.equal(limits.isAllowedFile('a.ods', ''), true)
  assert.equal(limits.isAllowedFile('a.pptx', ''), true)
  assert.equal(limits.isAllowedFile('a.doc', ''), true)
  assert.equal(limits.isAllowedFile('a.png', 'image/png'), true)
  assert.equal(limits.isAllowedFile('a.html', ''), true)
  assert.equal(limits.isAllowedFile('a.htm', 'text/html'), true)
  assert.equal(limits.isAllowedFile('a.exe', 'application/octet-stream'), false)
  assert.equal(limits.kindOf('x.md', ''), 'text')
  assert.equal(limits.kindOf('x.html', ''), 'html')
  assert.equal(limits.kindOf('page.htm', 'text/html'), 'html')
  assert.equal(limits.kindOf('x.pdf', ''), 'pdf')
  assert.equal(limits.kindOf('x.xlsm', ''), 'xlsx')
  assert.equal(limits.kindOf('x.ods', ''), 'xlsx')
  assert.equal(limits.kindOf('x.pptx', ''), 'pptx')
  assert.equal(limits.kindOf('x.doc', ''), 'doc')

  assert.throws(() => ssrf.assertSafeHttpUrl('file:///etc/passwd'), /http/)
  assert.throws(() => ssrf.assertSafeHttpUrl('http://127.0.0.1/a'), /本地|私网/)
  assert.throws(() => ssrf.assertSafeHttpUrl('http://192.168.0.1/a'), /私网|本地/)
  assert.throws(() => ssrf.assertSafeHttpUrl('http://10.1.2.3/a'), /私网|本地/)
  assert.doesNotThrow(() => ssrf.assertSafeHttpUrl('https://example.com/a.pdf'))
  assert.equal(ssrf.isPrivateIp('172.16.0.1'), true)
  assert.equal(ssrf.isPrivateIp('8.8.8.8'), false)

  const textResult = await extract.extractBuffer(
    Buffer.from('标题\n付款条件：30 天', 'utf8'),
    { fileName: 'note.txt', mimeType: 'text/plain' }
  )
  assert.equal(textResult.status, 'ready')
  assert.match(textResult.extractedText, /付款条件/)

  const html = await extract.extractBuffer(
    Buffer.from(
      '<html><head><style>p{color:red}</style></head><body><h1>采购说明</h1><script>alert(1)</script><p>验收后 30 天付款</p></body></html>',
      'utf8'
    ),
    { fileName: '说明.html', mimeType: 'text/html' }
  )
  assert.equal(html.status, 'ready')
  assert.equal(html.kind, 'html')
  assert.match(html.extractedText, /采购说明/)
  assert.match(html.extractedText, /验收后 30 天付款/)
  assert.ok(!html.extractedText.includes('alert'))
  assert.ok(!html.extractedText.includes('color:red'))

  assert.equal(
    extract.compactXlsxCsv('标题,,,\n甲,乙,,\n,,,\n,,,'),
    '标题\n甲,乙'
  )

  const pptxZip = new JSZip()
  pptxZip.file('ppt/slides/slide1.xml', '<a:p><a:r><a:t>项目进展</a:t></a:r></a:p>')
  const pptx = await extract.extractBuffer(
    await pptxZip.generateAsync({ type: 'nodebuffer' }),
    { fileName: '汇报.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
  )
  assert.equal(pptx.status, 'ready')
  assert.match(pptx.extractedText, /项目进展/)
  const doc = await extract.extractBuffer(Buffer.from('legacy'), { fileName: '旧文档.doc', mimeType: 'application/msword' })
  assert.equal(doc.status, 'failed')
  assert.match(doc.errorMessage, /暂不支持文本解析/)

  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>合同金额 9000</w:t></w:r></w:p></w:body></w:document>'
  )
  const docxBuf = await zip.generateAsync({ type: 'nodebuffer' })
  const docx = await extract.extractBuffer(docxBuf, {
    fileName: '合同.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })
  assert.equal(docx.status, 'ready')
  assert.match(docx.extractedText, /合同金额/)

  const pdf = await extract.extractBuffer(
    Buffer.from('%PDF-1.4\nBT\n(Hello PDF Text) Tj\nET\n%%EOF', 'latin1'),
    { fileName: 'a.pdf', mimeType: 'application/pdf' }
  )
  assert.equal(pdf.status, 'ready')
  assert.match(pdf.extractedText, /Hello PDF Text/)

  const unsupported = await extract.extractBuffer(Buffer.from('MZ'), {
    fileName: 'a.bin',
    mimeType: 'application/octet-stream'
  })
  assert.equal(unsupported.status, 'failed')

  const db = createMemoryDb()
  await store.initSchema(db)
  const first = await store.createFromBuffer(db, {
    roomKey: 'room-demo',
    buffer: Buffer.from('hello knowledge', 'utf8'),
    fileName: 'a.txt',
    mimeType: 'text/plain',
    createdBy: 'tester'
  })
  assert.equal(first.status, 'ready')
  assert.match(first.extractedText, /hello knowledge/)
  assert.equal(first.deduped, false)

  const second = await store.createFromBuffer(db, {
    roomKey: 'room-demo',
    buffer: Buffer.from('hello knowledge', 'utf8'),
    fileName: 'a-copy.txt',
    mimeType: 'text/plain'
  })
  assert.equal(second.id, first.id)
  assert.equal(second.deduped, true)

  const empty = await store.ingestUpload(db, 'room-demo', {
    contentBase64: 'data:text/plain;charset=utf-8;base64,',
    fileName: 'empty.txt',
    mimeType: 'text/plain'
  })
  assert.equal(empty.byteSize, 0)
  assert.equal(empty.fileName, 'empty.txt')

  await assert.rejects(
    () =>
      store.ingestUpload(db, 'room-demo', {
        contentBase64: 'data:text/plain;base64,not base64!',
        fileName: 'invalid.txt',
        mimeType: 'text/plain'
      }),
    /contentBase64 无效/
  )

  let denied = null
  try {
    const { Readable } = require('stream')
    const bigReq = Readable.from([])
    bigReq.headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(limits.MAX_BYTES + 1),
      'x-mind-file-name': 'big.txt'
    }
    bigReq.destroy = function destroy() {}
    await store.ingestBinaryRequest(db, 'room-demo', bigReq, {})
  } catch (err) {
    denied = err
  }
  assert.ok(denied)
  assert.equal(denied.code, 'FILE_TOO_LARGE')
  assert.equal(limits.DEFAULT_MAX_BYTES, 200 * 1024 * 1024)
  assert.equal(limits.parseByteLimit('', 12), 12)
  assert.equal(limits.parseByteLimit('4096', 12), 4096)

  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const tmp = path.join(os.tmpdir(), `mm-att-test-${Date.now()}.txt`)
  fs.writeFileSync(tmp, 'from disk file', 'utf8')
  const fromFile = await store.createFromBuffer(db, {
    roomKey: 'room-demo',
    filePath: tmp,
    fileName: 'from-file.txt',
    mimeType: 'text/plain',
    cleanupFile: true
  })
  assert.equal(fromFile.status, 'ready')
  assert.match(fromFile.extractedText, /from disk file/)
  assert.equal(fs.existsSync(tmp), false)

  const { Readable } = require('stream')
  const payload = Buffer.from('streamed attachment text', 'utf8')
  const req = Readable.from([payload])
  req.headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(payload.length),
    'x-mind-file-name': encodeURIComponent('stream.txt'),
    'x-mind-mime-type': 'text/plain',
    'x-mind-node-uid': 'node-1'
  }
  const streamed = await store.ingestBinaryRequest(db, 'room-stream', req, {
    id: 'tester'
  })
  assert.equal(streamed.status, 'ready')
  assert.equal(streamed.deduped, false)
  assert.equal(streamed.fileName, 'stream.txt')
  assert.match(streamed.extractedText, /streamed attachment/)

  const ensured = await store.ensureSources(db, 'room-demo', [
    { attachmentId: first.id, name: 'a.txt' },
    {
      type: 'attachment',
      name: 'missing.pdf',
      attachmentId: 'no-such-id'
    }
  ])
  assert.equal(ensured[0].status, 'ready')
  assert.match(ensured[0].extractedText, /hello knowledge/)
  assert.equal(ensured[1].status, 'failed')

  console.log('nodeKnowledge extract/store tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
