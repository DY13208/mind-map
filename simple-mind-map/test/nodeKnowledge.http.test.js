const assert = require('assert').strict
const httpApi = require('../bin/nodeKnowledge/http')
const limits = require('../bin/nodeKnowledge/limits')
const roomAcl = require('../bin/roomAcl')
const store = require('../bin/nodeKnowledge/store')

function createResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(body) {
      this.body = body
    }
  }
}

async function main() {
  const imageHeaders = limits.attachmentResponseHeaders('截图.png')
  assert.equal(imageHeaders['Content-Type'], 'image/png')
  assert.match(imageHeaders['Content-Disposition'], /^inline; filename\*=UTF-8''/)
  assert.match(imageHeaders['Content-Disposition'], /%E6%88%AA%E5%9B%BE\.png/)
  assert.equal(imageHeaders['X-Content-Type-Options'], 'nosniff')
  assert.equal(
    limits.encodeContentDispositionFileName("方案(最终)'*.txt"),
    '%E6%96%B9%E6%A1%88%28%E6%9C%80%E7%BB%88%29%27%2A.txt'
  )

  const pdfHeaders = limits.attachmentResponseHeaders('合同.pdf')
  assert.equal(pdfHeaders['Content-Type'], 'application/pdf')
  assert.match(pdfHeaders['Content-Disposition'], /^inline;/)

  const docxHeaders = limits.attachmentResponseHeaders('合同.docx')
  assert.equal(
    docxHeaders['Content-Type'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  assert.match(docxHeaders['Content-Disposition'], /^attachment;/)

  const xlsmHeaders = limits.attachmentResponseHeaders('财务模型.xlsm')
  assert.equal(
    xlsmHeaders['Content-Type'],
    'application/vnd.ms-excel.sheet.macroenabled.12'
  )
  assert.match(xlsmHeaders['Content-Disposition'], /^attachment;/)

  const textHeaders = limits.attachmentResponseHeaders('说明.txt')
  assert.equal(textHeaders['Content-Type'], 'text/plain')
  assert.match(textHeaders['Content-Disposition'], /^attachment;/)

  const htmlHeaders = limits.attachmentResponseHeaders('说明.html')
  assert.equal(htmlHeaders['Content-Type'], 'text/html; charset=utf-8')
  assert.match(htmlHeaders['Content-Disposition'], /^inline;/)
  assert.equal(htmlHeaders['X-Content-Type-Options'], 'nosniff')
  assert.equal(htmlHeaders['Content-Security-Policy'], undefined)

  // The MIME supplied at upload time is intentionally not an input to the
  // response helper. Unknown extensions are never served as an active type.
  assert.equal(limits.trustedMimeType('fake.png'), 'image/png')
  assert.equal(limits.trustedMimeType('fake.unknown'), 'application/octet-stream')
  const unknownHeaders = limits.attachmentResponseHeaders('数据.unknown')
  assert.equal(unknownHeaders['Content-Type'], 'application/octet-stream')
  assert.match(unknownHeaders['Content-Disposition'], /^attachment;/)

  const originalAssertRoomAccess = roomAcl.assertRoomAccess
  const originalGetContentById = store.getContentById
  const originalListMeta = store.listMeta
  const originalGetTextSlice = store.getTextSlice
  const accessCalls = []
  try {
    roomAcl.assertRoomAccess = async (db, req, roomKey, action) => {
      accessCalls.push({ roomKey, action })
    }
    const raw = Buffer.from('标题：合同金额 9000\n', 'utf8')
    store.getContentById = async () => ({
      attachment: {
        fileName: '合同.txt',
        // This deliberately conflicts with the extension. The response must
        // use the allow-listed extension MIME, not this stored client value.
        mimeType: 'image/png'
      },
      buffer: raw
    })
    const response = createResponse()
    const handled = await httpApi.handleApi(
      { method: 'GET', url: '/api/files/room-demo/attachments/att-1/content' },
      response,
      { pathname: '/api/files/room-demo/attachments/att-1/content', db: {} }
    )
    assert.equal(handled, true)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['Content-Type'], 'text/plain')
    assert.match(response.headers['Content-Disposition'], /^attachment;/)
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
    assert.equal(response.headers['Content-Length'], raw.length)
    assert.ok(Buffer.isBuffer(response.body))
    assert.ok(response.body.equals(raw), 'content response must preserve original bytes')
    assert.deepEqual(accessCalls, [{ roomKey: 'room-demo', action: 'view' }])

    roomAcl.assertRoomAccess = async () => {
      const error = new Error('无权访问附件')
      error.statusCode = 403
      error.code = 'FORBIDDEN'
      throw error
    }
    store.getContentById = async () => {
      throw new Error('ACL denial must happen before reading content')
    }
    const denied = createResponse()
    await httpApi.handleApi(
      { method: 'GET', url: '/api/files/room-demo/attachments/att-1/content' },
      denied,
      { pathname: '/api/files/room-demo/attachments/att-1/content', db: {} }
    )
    assert.equal(denied.statusCode, 403)
    assert.equal(JSON.parse(denied.body).code, 'FORBIDDEN')

    roomAcl.assertRoomAccess = async () => {}
    store.getContentById = async () => null
    const missing = createResponse()
    await httpApi.handleApi(
      { method: 'GET', url: '/api/files/room-demo/attachments/missing/content' },
      missing,
      { pathname: '/api/files/room-demo/attachments/missing/content', db: {} }
    )
    assert.equal(missing.statusCode, 404)
    assert.equal(JSON.parse(missing.body).code, 'NOT_FOUND')

    assert.equal(
      httpApi.isBinaryAttachmentUpload({
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      }),
      false
    )
    assert.equal(
      httpApi.isBinaryAttachmentUpload({
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-mind-file-name': encodeURIComponent('合同.pdf')
        }
      }),
      true
    )

    roomAcl.assertRoomAccess = async () => {}
    const tooBig = createResponse()
    const { Readable } = require('stream')
    const bigReq = Readable.from([Buffer.from('x')])
    bigReq.method = 'POST'
    bigReq.url = '/api/files/room-demo/attachments'
    bigReq.headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(limits.MAX_BYTES + 1),
      'x-mind-file-name': encodeURIComponent('big.bin')
    }
    bigReq.destroy = function destroy() {
      this.destroyed = true
    }
    await httpApi.handleApi(bigReq, tooBig, {
      pathname: '/api/files/room-demo/attachments',
      db: {}
    })
    assert.equal(tooBig.statusCode, 413)
    assert.equal(JSON.parse(tooBig.body).code, 'FILE_TOO_LARGE')

    // Attachment listing: metadata only, never the extracted text itself.
    accessCalls.length = 0
    roomAcl.assertRoomAccess = async (db, req, roomKey, action) => {
      accessCalls.push({ roomKey, action })
    }
    const listArgs = []
    store.listMeta = async (db, roomKey, options) => {
      listArgs.push({ roomKey, options })
      return [
        {
          id: 'att-1',
          fileName: '合同.pdf',
          mimeType: 'application/pdf',
          status: 'ready',
          extractedChars: 9000
        }
      ]
    }
    const listed = createResponse()
    await httpApi.handleApi(
      {
        method: 'GET',
        url: '/api/files/room-demo/attachments?node_uid=node-9&limit=5'
      },
      listed,
      { pathname: '/api/files/room-demo/attachments', db: {} }
    )
    assert.equal(listed.statusCode, 200)
    const listBody = JSON.parse(listed.body)
    assert.equal(listBody.ok, true)
    assert.equal(listBody.room_key, 'room-demo')
    assert.equal(listBody.total, 1)
    assert.equal(listBody.attachments[0].id, 'att-1')
    assert.equal(listBody.attachments[0].extractedText, undefined)
    assert.deepEqual(listArgs, [
      { roomKey: 'room-demo', options: { nodeUid: 'node-9', ids: [], limit: '5' } }
    ])
    assert.deepEqual(accessCalls, [{ roomKey: 'room-demo', action: 'view' }])

    // Text slices carry the paging cursor the MCP tool hands back as offset.
    const sliceArgs = []
    store.getTextSlice = async (db, roomKey, id, options) => {
      sliceArgs.push({ roomKey, id, options })
      return {
        attachment: { id, fileName: '合同.pdf', status: 'ready', extractedChars: 9000 },
        text: '第二段正文',
        offset: 4000,
        length: 5,
        total_chars: 9000,
        has_more: true,
        next_offset: 4005
      }
    }
    const sliced = createResponse()
    await httpApi.handleApi(
      {
        method: 'GET',
        url: '/api/files/room-demo/attachments/att-1/text?offset=4000&limit=4000'
      },
      sliced,
      { pathname: '/api/files/room-demo/attachments/att-1/text', db: {} }
    )
    assert.equal(sliced.statusCode, 200)
    const sliceBody = JSON.parse(sliced.body)
    assert.equal(sliceBody.text, '第二段正文')
    assert.equal(sliceBody.has_more, true)
    assert.equal(sliceBody.next_offset, 4005)
    assert.equal(sliceBody.total_chars, 9000)
    assert.deepEqual(sliceArgs, [
      {
        roomKey: 'room-demo',
        id: 'att-1',
        options: { offset: '4000', limit: '4000' }
      }
    ])

    // A failed extraction must surface its status instead of looking empty.
    store.getTextSlice = async () => ({
      attachment: {
        id: 'att-doc',
        fileName: '旧合同.doc',
        status: 'failed',
        errorMessage: '暂不支持解析 .doc，请下载后本地打开',
        extractedChars: 0
      },
      text: '',
      offset: 0,
      length: 0,
      total_chars: 0,
      has_more: false,
      next_offset: null
    })
    const failedSlice = createResponse()
    await httpApi.handleApi(
      { method: 'GET', url: '/api/files/room-demo/attachments/att-doc/text' },
      failedSlice,
      { pathname: '/api/files/room-demo/attachments/att-doc/text', db: {} }
    )
    const failedBody = JSON.parse(failedSlice.body)
    assert.equal(failedSlice.statusCode, 200)
    assert.equal(failedBody.attachment.status, 'failed')
    assert.match(failedBody.attachment.errorMessage, /不支持解析/)
    assert.equal(failedBody.has_more, false)

    store.getTextSlice = async () => null
    const missingSlice = createResponse()
    await httpApi.handleApi(
      { method: 'GET', url: '/api/files/room-demo/attachments/nope/text' },
      missingSlice,
      { pathname: '/api/files/room-demo/attachments/nope/text', db: {} }
    )
    assert.equal(missingSlice.statusCode, 404)
    assert.equal(JSON.parse(missingSlice.body).code, 'NOT_FOUND')

    // Both new reads are gated by the same room ACL as the binary content read.
    roomAcl.assertRoomAccess = async () => {
      const error = new Error('无权访问附件')
      error.statusCode = 403
      error.code = 'FORBIDDEN'
      throw error
    }
    store.listMeta = async () => {
      throw new Error('ACL denial must happen before listing attachments')
    }
    store.getTextSlice = async () => {
      throw new Error('ACL denial must happen before reading text')
    }
    for (const pathname of [
      '/api/files/room-demo/attachments',
      '/api/files/room-demo/attachments/att-1/text'
    ]) {
      const denied = createResponse()
      await httpApi.handleApi(
        { method: 'GET', url: pathname },
        denied,
        { pathname, db: {} }
      )
      assert.equal(denied.statusCode, 403, pathname)
      assert.equal(JSON.parse(denied.body).code, 'FORBIDDEN', pathname)
    }
  } finally {
    roomAcl.assertRoomAccess = originalAssertRoomAccess
    store.getContentById = originalGetContentById
    store.listMeta = originalListMeta
    store.getTextSlice = originalGetTextSlice
  }

  console.log('nodeKnowledge HTTP attachment tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
