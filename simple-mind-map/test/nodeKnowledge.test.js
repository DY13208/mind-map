const assert = require('assert').strict
const JSZip = require('jszip')
const limits = require('../bin/nodeKnowledge/limits')
const ssrf = require('../bin/nodeKnowledge/ssrf')
const extract = require('../bin/nodeKnowledge/extract')
const store = require('../bin/nodeKnowledge/store')
const attachmentFileName = require('../src/utils/attachmentFileName')

function createMemoryDb() {
  const rows = new Map()
  let hashMisses = 0
  let uniqueInsertFailures = 0
  let nextFileNameUpdateBehavior = ''
  function removeRow(row) {
    rows.delete(row.id)
    rows.delete(`hash:${row.room_key}:${row.content_hash}`)
  }
  return {
    forceNextHashMiss() { hashMisses += 1 },
    failNextInsertAsUniqueConflict() { uniqueInsertFailures += 1 },
    setNextFileNameUpdateBehavior(behavior) { nextFileNameUpdateBehavior = behavior },
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (text.startsWith('create') || text.startsWith('alter')) {
        return { rows: [] }
      }
      if (text.includes('insert into node_attachments')) {
        if (uniqueInsertFailures > 0) {
          uniqueInsertFailures -= 1
          const error = new Error('simulated unique conflict')
          error.code = '23505'
          throw error
        }
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
      if (text.startsWith('delete from node_attachments')) {
        const row = rows.get(params[1])
        if (!row || row.room_key !== params[0]) return { rows: [] }
        rows.delete(row.id)
        rows.delete(`hash:${row.room_key}:${row.content_hash}`)
        return { rows: [row] }
      }
      if (text.startsWith('update node_attachments set file_name = $3')) {
        const row = rows.get(params[1])
        if (!row || row.room_key !== params[0] || row.file_name !== params[3]) {
          return { rows: [] }
        }
        const behavior = nextFileNameUpdateBehavior
        nextFileNameUpdateBehavior = ''
        if (behavior === 'error') throw new Error('simulated filename update error')
        if (behavior === 'lose-race') {
          row.file_name = 'concurrent-winner.html'
          row.updated_at = new Date()
          return { rows: [] }
        }
        if (behavior === 'deleted') {
          removeRow(row)
          return { rows: [] }
        }
        if (behavior === 'deleted-after-update') {
          row.file_name = params[2]
          removeRow(row)
          return { rows: [row] }
        }
        row.file_name = params[2]
        row.updated_at = new Date()
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
        if (hashMisses > 0) {
          hashMisses -= 1
          return { rows: [] }
        }
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
  const encodedLongName = '%E5%AE%B6%E6%9C%89%E8%89%AF%E7%89%A9-%E8%89%AF%E7%AD%96AI%E7%94%B5%E5%95%86%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%96%B9%E6%A1%88-%E5%90%AB%E5%AE%A2%E6%88%B7%E7%97%9B%E7%82%B9%E5%AE%8C%E6%95%B4%E7%89%88.html'
  const decodedLongName = '家有良物-良策AI电商工作流方案-含客户痛点完整版.html'
  assert.equal(encodedLongName.length, 198)
  assert.equal(attachmentFileName.normalizeAttachmentFileName(encodedLongName), decodedLongName)
  const sanitizedEncodedName = attachmentFileName.sanitizeAttachmentFileName(encodedLongName)
  assert.ok(sanitizedEncodedName.length <= 180)
  assert.ok(sanitizedEncodedName.endsWith('.html'))
  assert.match(sanitizedEncodedName, /%/)
  assert.equal(attachmentFileName.normalizeAttachmentFileName('预算100%.html'), '预算100%.html')
  assert.equal(attachmentFileName.normalizeAttachmentFileName('report%20name.pdf'), 'report%20name.pdf')
  assert.equal(attachmentFileName.normalizeAttachmentFileName('中文%20.html'), '中文%20.html')
  assert.equal(attachmentFileName.normalizeAttachmentFileName('%E5%AD%97%GG.html'), '%E5%AD%97%GG.html')
  assert.deepEqual(
    attachmentFileName.detectLegacyAttachmentFileName('%E5%AD%97.html', '字.html'),
    { reason: 'encoded', candidate: '字.html' }
  )
  assert.deepEqual(
    attachmentFileName.detectLegacyAttachmentFileName('%e5%ad%97.html', '字.html'),
    { reason: 'encoded', candidate: '字.html' }
  )
  const completeEncodedLongName = encodeURIComponent(decodedLongName)
  assert.equal(completeEncodedLongName.length, 198)
  assert.deepEqual(
    attachmentFileName.detectLegacyAttachmentFileName(completeEncodedLongName, decodedLongName),
    { reason: 'encoded', candidate: decodedLongName }
  )
  // The old stored value could be the entire 198-character percent-encoded
  // form even though the re-upload supplies the original 30-character name.
  const thirtyCharacterOriginal = decodedLongName
  const completeEncodedThirtyCharacterName = encodeURIComponent(thirtyCharacterOriginal)
  assert.equal(thirtyCharacterOriginal.length, 30)
  assert.equal(completeEncodedThirtyCharacterName.length, 198)
  assert.deepEqual(
    attachmentFileName.detectLegacyAttachmentFileName(
      completeEncodedThirtyCharacterName,
      thirtyCharacterOriginal
    ),
    { reason: 'encoded', candidate: thirtyCharacterOriginal }
  )
  assert.equal(
    attachmentFileName.detectLegacyAttachmentFileName('a%2520b.txt', 'a%20b.txt'),
    null
  )
  const mixedEncodingName = '%25E5%25AE%25B6%E5%AD%97.html'
  const onceDecodedMixedName = attachmentFileName.normalizeAttachmentFileName(mixedEncodingName)
  assert.equal(onceDecodedMixedName, '%E5%AE%B6字.html')
  assert.equal(attachmentFileName.sanitizeAttachmentFileName(onceDecodedMixedName), onceDecodedMixedName)
  assert.notEqual(attachmentFileName.normalizeAttachmentFileName(onceDecodedMixedName), onceDecodedMixedName)
  const mixedNameDisposition = limits.attachmentResponseHeaders(onceDecodedMixedName)['Content-Disposition']
  assert.equal(
    decodeURIComponent(mixedNameDisposition.split("filename*=UTF-8''")[1]),
    onceDecodedMixedName
  )
  assert.equal(limits.attachmentResponseHeaders(decodedLongName)['Content-Type'], 'text/html; charset=utf-8')

  const longEmojiName = `${'文'.repeat(177)}😀.html`
  const normalizedLongEmojiName = attachmentFileName.normalizeAttachmentFileName(longEmojiName)
  assert.ok(normalizedLongEmojiName.length <= 180)
  assert.ok(normalizedLongEmojiName.endsWith('.html'))
  assert.equal(/[\uD800-\uDBFF]$/.test(normalizedLongEmojiName), false)
  assert.doesNotThrow(() => limits.attachmentResponseHeaders('isolated-\ud800.html'))

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
  assert.equal(second.fileName, 'a.txt')

  // Simulate a legacy DB row that stored the first 180 characters of the
  // percent-encoded name. Re-uploading its original name repairs only the
  // shared display name and retains its ID/content/extraction state.
  const repairDb = createMemoryDb()
  await store.initSchema(repairDb)
  const repairBuffer = Buffer.from('same content for legacy filename repair', 'utf8')
  const initiallySaved = await store.createFromBuffer(repairDb, {
    roomKey: 'room-repair', buffer: repairBuffer,
    fileName: encodedLongName, mimeType: 'text/html', createdBy: 'tester'
  })
  const oldTruncatedName = encodedLongName.slice(0, 180)
  await repairDb.query(
    'update node_attachments set file_name = $3, updated_at = now() where room_key = $1 and id = $2 and file_name = $4 returning *',
    ['room-repair', initiallySaved.id, oldTruncatedName, decodedLongName]
  )
  const repaired = await store.createFromBuffer(repairDb, {
    roomKey: 'room-repair', buffer: repairBuffer,
    fileName: encodedLongName, mimeType: 'text/html', createdBy: 'tester'
  })
  assert.equal(repaired.id, initiallySaved.id)
  assert.equal(repaired.deduped, true)
  assert.equal(repaired.fileName, decodedLongName)
  assert.equal(repaired.contentHash, initiallySaved.contentHash)
  assert.equal(repaired.extractedText, initiallySaved.extractedText)

  // Repair the complete encoded form as well as historical truncated forms.
  // This specifically covers a value longer than MAX_FILENAME in the DB.
  const completeEncodedDb = createMemoryDb()
  await store.initSchema(completeEncodedDb)
  const completeEncodedBuffer = Buffer.from('complete encoded legacy filename')
  const completeEncodedSaved = await store.createFromBuffer(completeEncodedDb, {
    roomKey: 'room-complete-encoded',
    buffer: completeEncodedBuffer,
    fileName: thirtyCharacterOriginal,
    mimeType: 'text/html',
    createdBy: 'tester'
  })
  await completeEncodedDb.query(
    'update node_attachments set file_name = $3, updated_at = now() where room_key = $1 and id = $2 and file_name = $4 returning *',
    [
      'room-complete-encoded',
      completeEncodedSaved.id,
      completeEncodedThirtyCharacterName,
      thirtyCharacterOriginal
    ]
  )
  const repairedCompleteEncoded = await store.createFromBuffer(completeEncodedDb, {
    roomKey: 'room-complete-encoded',
    buffer: completeEncodedBuffer,
    fileName: thirtyCharacterOriginal,
    mimeType: 'text/html',
    createdBy: 'tester'
  })
  assert.equal(repairedCompleteEncoded.id, completeEncodedSaved.id)
  assert.equal(repairedCompleteEncoded.fileName, thirtyCharacterOriginal)
  assert.equal(repairedCompleteEncoded.contentHash, completeEncodedSaved.contentHash)

  async function createCorruptLongNameRecord(dbForRepair, roomKey) {
    await store.initSchema(dbForRepair)
    const buffer = Buffer.from(`repair-cas-${roomKey}`)
    const saved = await store.createFromBuffer(dbForRepair, {
      roomKey,
      buffer,
      fileName: encodedLongName,
      mimeType: 'text/html',
      createdBy: 'tester'
    })
    const oldName = encodedLongName.slice(0, 180)
    await dbForRepair.query(
      'update node_attachments set file_name = $3, updated_at = now() where room_key = $1 and id = $2 and file_name = $4 returning *',
      [roomKey, saved.id, oldName, decodedLongName]
    )
    return { saved, buffer, oldName }
  }

  // A lost CAS re-reads and returns the concurrently chosen current name.
  const lostRaceDb = createMemoryDb()
  const lostRaceRecord = await createCorruptLongNameRecord(lostRaceDb, 'room-lost-race')
  lostRaceDb.setNextFileNameUpdateBehavior('lose-race')
  const lostRaceResult = await store.createFromBuffer(lostRaceDb, {
    roomKey: 'room-lost-race',
    buffer: lostRaceRecord.buffer,
    fileName: encodedLongName,
    mimeType: 'text/html'
  })
  assert.equal(lostRaceResult.id, lostRaceRecord.saved.id)
  assert.equal(lostRaceResult.fileName, 'concurrent-winner.html')
  assert.equal((await store.getById(lostRaceDb, 'room-lost-race', lostRaceResult.id)).fileName, 'concurrent-winner.html')

  // If the row disappears during the conditional update, do not return a stale
  // DTO that points at a missing attachment.
  const deletedDuringRepairDb = createMemoryDb()
  const deletedDuringRepair = await createCorruptLongNameRecord(deletedDuringRepairDb, 'room-deleted-during-repair')
  deletedDuringRepairDb.setNextFileNameUpdateBehavior('deleted')
  await assert.rejects(
    () => store.createFromBuffer(deletedDuringRepairDb, {
      roomKey: 'room-deleted-during-repair',
      buffer: deletedDuringRepair.buffer,
      fileName: encodedLongName,
      mimeType: 'text/html'
    }),
    err => err && err.statusCode === 404 && err.code === 'ATTACHMENT_NOT_FOUND'
  )

  // Even a successful UPDATE result must be read back; the row may have been
  // removed between the write and that read.
  const deletedAfterUpdateDb = createMemoryDb()
  const deletedAfterUpdate = await createCorruptLongNameRecord(deletedAfterUpdateDb, 'room-deleted-after-update')
  deletedAfterUpdateDb.setNextFileNameUpdateBehavior('deleted-after-update')
  await assert.rejects(
    () => store.createFromBuffer(deletedAfterUpdateDb, {
      roomKey: 'room-deleted-after-update',
      buffer: deletedAfterUpdate.buffer,
      fileName: encodedLongName,
      mimeType: 'text/html'
    }),
    err => err && err.statusCode === 404 && err.code === 'ATTACHMENT_NOT_FOUND'
  )

  // A database error during the CAS propagates and leaves the old row intact.
  const failedUpdateDb = createMemoryDb()
  const failedUpdate = await createCorruptLongNameRecord(failedUpdateDb, 'room-failed-update')
  failedUpdateDb.setNextFileNameUpdateBehavior('error')
  await assert.rejects(
    () => store.createFromBuffer(failedUpdateDb, {
      roomKey: 'room-failed-update',
      buffer: failedUpdate.buffer,
      fileName: encodedLongName,
      mimeType: 'text/html'
    }),
    /simulated filename update error/
  )
  assert.equal(
    (await store.getById(failedUpdateDb, 'room-failed-update', failedUpdate.saved.id)).fileName,
    failedUpdate.oldName
  )

  // Exercise the INSERT unique-conflict branch: the first hash lookup misses,
  // another writer wins, and the fallback lookup repairs its legacy name.
  const uniqueRaceDb = createMemoryDb()
  const uniqueRace = await createCorruptLongNameRecord(uniqueRaceDb, 'room-unique-race')
  uniqueRaceDb.forceNextHashMiss()
  uniqueRaceDb.failNextInsertAsUniqueConflict()
  const uniqueRaceResult = await store.createFromBuffer(uniqueRaceDb, {
    roomKey: 'room-unique-race',
    buffer: uniqueRace.buffer,
    fileName: encodedLongName,
    mimeType: 'text/html'
  })
  assert.equal(uniqueRaceResult.id, uniqueRace.saved.id)
  assert.equal(uniqueRaceResult.deduped, true)
  assert.equal(uniqueRaceResult.fileName, decodedLongName)

  // Normal shared names are stable even when identical bytes arrive under a
  // different name; only a provable legacy encoding/truncation is repairable.
  const ordinaryDedup = await store.createFromBuffer(repairDb, {
    roomKey: 'room-repair', buffer: repairBuffer,
    fileName: 'renamed.html', mimeType: 'text/html', createdBy: 'tester'
  })
  assert.equal(ordinaryDedup.fileName, decodedLongName)

  const removed = await store.removeById(db, 'room-demo', first.id, {
    nodeUid: 'node-1'
  })
  assert.equal(removed.deleted, true)
  const replacement = await store.createFromBuffer(db, {
    roomKey: 'room-demo',
    buffer: Buffer.from('hello knowledge', 'utf8'),
    fileName: 'a.txt',
    mimeType: 'text/plain'
  })
  assert.notEqual(replacement.id, first.id)

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

  const entryName = '家有良物-良策AI电商工作流方案-含客户痛点完整版.html'
  const encodedEntryName = encodeURIComponent(entryName)
  const htmlPayload = Buffer.from('<html><body>encoded filename entry regression</body></html>')
  const binaryEntry = Readable.from([htmlPayload])
  binaryEntry.headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(htmlPayload.length),
    // Header encoding is transport encoding; the inner name remains the same
    // percent-encoded logical input used by TUS/JSON/MCP clients.
    'x-mind-file-name': encodeURIComponent(encodedEntryName),
    'x-mind-mime-type': 'text/html'
  }
  const binaryNamed = await store.ingestBinaryRequest(db, 'room-binary-name', binaryEntry)
  assert.equal(binaryNamed.fileName, entryName)
  const jsonNamed = await store.ingestUpload(db, 'room-json-name', {
    fileName: encodedEntryName, mimeType: 'text/html', contentBase64: htmlPayload.toString('base64')
  })
  assert.equal(jsonNamed.fileName, entryName)
  const { resolveAttachmentUploadInput, attachmentMetaForNode } = await import('../bin/mcpAttachmentUpload.mjs')
  const mcpInput = await resolveAttachmentUploadInput({
    file_name: encodedEntryName, mime_type: 'text/html', content_base64: htmlPayload.toString('base64')
  })
  const mcpNamed = await store.ingestUpload(db, 'room-mcp-name', mcpInput)
  assert.equal(mcpNamed.fileName, entryName)
  assert.equal(attachmentMetaForNode(mcpNamed).attachmentName, entryName)

  const ensured = await store.ensureSources(db, 'room-demo', [
    { attachmentId: replacement.id, name: 'a.txt' },
    {
      type: 'attachment',
      name: 'missing.pdf',
      attachmentId: 'no-such-id'
    }
  ])
  assert.equal(ensured[0].status, 'ready')
  assert.match(ensured[0].extractedText, /hello knowledge/)
  assert.equal(ensured[1].status, 'failed')

  await testListMetaAndTextSlice()

  console.log('nodeKnowledge extract/store tests passed')
}

// A room-scoped stand-in for PostgreSQL that implements just enough of
// char_length/substr to exercise the metadata and text-slice readers.
function createReadDb(options = {}) {
  const attachments = options.attachments || []
  const nodeAttachmentIds = options.nodeAttachmentIds || null
  const calls = []
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim()
      calls.push({ text, params })
      if (text.includes('from room_nodes')) {
        if (!nodeAttachmentIds) {
          const err = new Error('relation "room_nodes" does not exist')
          err.code = '42P01'
          throw err
        }
        if (text.startsWith('select 1')) {
          return {
            rows: options.roomHasNormalizedNodes === false ? [] : [{ present: 1 }]
          }
        }
        return { rows: (nodeAttachmentIds[params[1]] || []).map(id => ({ id })) }
      }
      const idParamIndexes = [...text.matchAll(/a\.id = any\(\$(\d+)/g)].map(
        match => Number(match[1]) - 1
      )
      const idFilters = idParamIndexes.map(index => params[index] || [])
      const nodeUidMatch = text.match(/a\.node_uid = \$(\d+)/)
      const currentPointer = text.includes("a.source_kind <> 'attachment'")
      const currentIds = currentPointer ? idFilters.shift() || [] : []
      const nodeUid = nodeUidMatch ? params[Number(nodeUidMatch[1]) - 1] : ''
      const rows = attachments
        .filter(row => row.room_key === params[0])
        .filter(row => {
          if (!nodeUidMatch) return true
          if (currentPointer) {
            return (
              currentIds.includes(row.id) ||
              (row.source_kind !== 'attachment' && row.node_uid === nodeUid)
            )
          }
          return row.node_uid === nodeUid
        })
        .filter(row => idFilters.every(allowed => allowed.includes(row.id)))
        .filter(row => !text.includes('a.id = $2') || row.id === params[1])
        .map(row => {
          const projected = { ...row }
          delete projected.extracted_text
          projected.extracted_chars = String(row.extracted_text || '').length
          if (text.includes('substr(a.extracted_text')) {
            projected.text_slice = String(row.extracted_text || '').substr(
              Number(params[2]),
              Number(params[3])
            )
          }
          return projected
        })
      return { rows }
    }
  }
}

async function testListMetaAndTextSlice() {
  const attachments = [
    {
      id: 'att-shared',
      room_key: 'room-demo',
      // Deduped upload: the row only remembers the first node that used it.
      node_uid: 'node-1',
      file_name: '合同.pdf',
      mime_type: 'application/pdf',
      status: 'ready',
      error_message: '',
      byte_size: 1024,
      source_kind: 'attachment',
      extracted_text: '甲乙丙丁戊己庚辛'
    },
    {
      id: 'att-other',
      room_key: 'room-demo',
      node_uid: 'node-9',
      file_name: '旧合同.doc',
      mime_type: 'application/msword',
      status: 'failed',
      error_message: '暂不支持文本解析',
      byte_size: 512,
      source_kind: 'attachment',
      extracted_text: ''
    },
    {
      id: 'att-elsewhere',
      room_key: 'room-other',
      node_uid: 'node-1',
      file_name: '别人的.pdf',
      mime_type: 'application/pdf',
      status: 'ready',
      error_message: '',
      byte_size: 32,
      source_kind: 'attachment',
      extracted_text: 'x'
    }
  ]

  const all = await store.listMeta(createReadDb({ attachments }), 'room-demo')
  assert.deepEqual(
    all.map(item => item.id),
    ['att-shared', 'att-other']
  )
  // Length is reported, the text itself never leaves the database.
  assert.equal(all[0].extractedChars, 8)
  assert.equal(all[0].extractedText, undefined)

  // Node 2 reuses the deduped row, so the node's own attachmentId has to be
  // what surfaces it.
  const reused = await store.listMeta(
    createReadDb({
      attachments,
      nodeAttachmentIds: { 'node-2': ['att-shared'] }
    }),
    'room-demo',
    { nodeUid: 'node-2' }
  )
  assert.deepEqual(
    reused.map(item => item.id),
    ['att-shared']
  )

  // On migrated rooms the normalized node pointer is authoritative: detach or
  // replacement must not keep the uploader's old row in the node's listing.
  const detached = await store.listMeta(
    createReadDb({
      attachments,
      nodeAttachmentIds: { 'node-1': [] }
    }),
    'room-demo',
    { nodeUid: 'node-1' }
  )
  assert.deepEqual(detached, [])

  const missingMigratedNode = await store.listMeta(
    createReadDb({
      attachments,
      nodeAttachmentIds: { 'some-other-node': [] }
    }),
    'room-demo',
    { nodeUid: 'node-9' }
  )
  assert.deepEqual(
    missingMigratedNode,
    [],
    'a normalized room must not fall back to origin node_uid for a missing node'
  )

  const replacementRows = [
    ...attachments,
    {
      ...attachments[0],
      id: 'att-replacement',
      node_uid: 'node-1',
      file_name: '新合同.pdf'
    }
  ]
  const replacement = await store.listMeta(
    createReadDb({
      attachments: replacementRows,
      nodeAttachmentIds: { 'node-1': ['att-replacement'] }
    }),
    'room-demo',
    { nodeUid: 'node-1' }
  )
  assert.deepEqual(replacement.map(item => item.id), ['att-replacement'])

  const nonAttachmentSource = await store.listMeta(
    createReadDb({
      attachments: [
        {
          ...attachments[0],
          id: 'knowledge-link',
          source_kind: 'link'
        }
      ],
      nodeAttachmentIds: { 'node-1': [] }
    }),
    'room-demo',
    { nodeUid: 'node-1' }
  )
  assert.deepEqual(nonAttachmentSource.map(item => item.id), ['knowledge-link'])

  // Rooms predating the room_nodes migration still match on the attachment side.
  const legacy = await store.listMeta(createReadDb({ attachments }), 'room-demo', {
    nodeUid: 'node-1'
  })
  assert.deepEqual(
    legacy.map(item => item.id),
    ['att-shared']
  )

  const byId = await store.listMeta(createReadDb({ attachments }), 'room-demo', {
    ids: ['att-other', 'att-elsewhere']
  })
  assert.deepEqual(
    byId.map(item => item.id),
    ['att-other']
  )

  const limited = createReadDb({ attachments })
  await store.listMeta(limited, 'room-demo', { limit: 9999 })
  assert.equal(limited.calls[0].params.at(-1), limits.MAX_LIST_LIMIT)
  const defaulted = createReadDb({ attachments })
  await store.listMeta(defaulted, 'room-demo', { limit: 0 })
  assert.equal(defaulted.calls[0].params.at(-1), limits.DEFAULT_LIST_LIMIT)

  const head = await store.getTextSlice(
    createReadDb({ attachments }),
    'room-demo',
    'att-shared',
    { limit: 3 }
  )
  assert.equal(head.text, '甲乙丙')
  assert.equal(head.offset, 0)
  assert.equal(head.total_chars, 8)
  assert.equal(head.has_more, true)
  assert.equal(head.next_offset, 3)

  const tail = await store.getTextSlice(
    createReadDb({ attachments }),
    'room-demo',
    'att-shared',
    { offset: head.next_offset, limit: 3000 }
  )
  assert.equal(tail.text, '丁戊己庚辛')
  assert.equal(tail.has_more, false)
  assert.equal(tail.next_offset, null)

  // A failed extraction reads as empty text plus its status and message.
  const failed = await store.getTextSlice(
    createReadDb({ attachments }),
    'room-demo',
    'att-other'
  )
  assert.equal(failed.text, '')
  assert.equal(failed.total_chars, 0)
  assert.equal(failed.has_more, false)
  assert.equal(failed.attachment.status, 'failed')
  assert.match(failed.attachment.errorMessage, /暂不支持/)

  // Cross-room reads and unknown ids resolve to nothing.
  assert.equal(
    await store.getTextSlice(
      createReadDb({ attachments }),
      'room-demo',
      'att-elsewhere'
    ),
    null
  )

  const clamped = createReadDb({ attachments })
  await store.getTextSlice(clamped, 'room-demo', 'att-shared', {
    offset: -5,
    limit: 999999
  })
  assert.equal(clamped.calls[0].params[2], 0)
  assert.equal(clamped.calls[0].params[3], limits.MAX_TEXT_SLICE_CHARS)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
