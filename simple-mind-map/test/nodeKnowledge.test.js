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
  assert.equal(limits.isAllowedFile('a.png', 'image/png'), true)
  assert.equal(limits.isAllowedFile('a.exe', 'application/octet-stream'), false)
  assert.equal(limits.kindOf('x.md', ''), 'text')
  assert.equal(limits.kindOf('x.pdf', ''), 'pdf')

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

  const imageNoOcr = await extract.extractBuffer(
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    { fileName: 'a.png', mimeType: 'image/png' }
  )
  assert.equal(imageNoOcr.status, 'failed')
  assert.match(imageNoOcr.errorMessage, /OCR/)

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

  let denied = null
  try {
    await store.createFromBuffer(db, {
      roomKey: 'room-demo',
      buffer: Buffer.alloc(limits.MAX_BYTES + 10),
      fileName: 'big.txt',
      mimeType: 'text/plain'
    })
  } catch (err) {
    denied = err
  }
  assert.ok(denied)
  assert.equal(denied.code, 'FILE_TOO_LARGE')

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
