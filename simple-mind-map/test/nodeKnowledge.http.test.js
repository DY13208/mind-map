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
  } finally {
    roomAcl.assertRoomAccess = originalAssertRoomAccess
    store.getContentById = originalGetContentById
  }

  console.log('nodeKnowledge HTTP attachment tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
