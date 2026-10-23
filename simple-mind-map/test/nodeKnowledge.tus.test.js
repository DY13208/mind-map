const assert = require('assert').strict
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const tusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-map-tus-'))
process.env.NODE_KNOWLEDGE_TUS_DIR = tusDir

const tus = require('../bin/nodeKnowledge/tus')
const store = require('../bin/nodeKnowledge/store')
const roomAcl = require('../bin/roomAcl')

function encodeMetadata(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',')
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    server.on('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
  })
}

async function request(port, pathname, options = {}) {
  const headers = { ...(options.headers || {}) }
  const body = options.body
  if (Buffer.isBuffer(body) && headers['Content-Length'] == null) {
    headers['Content-Length'] = String(body.length)
  }
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: body && options.method !== 'GET' && options.method !== 'HEAD' ? body : undefined
  })
  const text = await res.text()
  const allHeaders = {}
  res.headers.forEach((value, key) => {
    allHeaders[key.toLowerCase()] = value
  })
  return {
    status: res.status,
    headers: allHeaders,
    text,
    json: () => {
      try {
        return JSON.parse(text)
      } catch (err) {
        return null
      }
    }
  }
}

async function main() {
  assert.deepEqual(tus.matchTus('/api/attachments/resumable'), {
    id: '',
    result: false
  })
  assert.deepEqual(tus.matchTus('/api/attachments/resumable/abc123'), {
    id: 'abc123',
    result: false
  })
  assert.deepEqual(tus.matchTus('/api/attachments/resumable/abc123/result'), {
    id: 'abc123',
    result: true
  })
  assert.equal(tus.matchTus('/api/files/room/attachments'), null)
  assert.equal(tus.isTusPath('/api/attachments/resumable/xyz'), true)
  assert.equal(tus.isTusPath('/api/files/room/attachments'), false)

  const originalCreate = store.createFromBuffer
  const originalGetById = store.getById
  const originalAcl = roomAcl.assertRoomAccess
  const ingested = []
  const accessEvents = []
  let liveAttachment = null
  let denyResultAccess = false
  store.createFromBuffer = async (db, options) => {
    ingested.push({ db, options })
    const bytes = await fs.promises.readFile(options.filePath)
    const saved = {
      id: 'att-resume-1',
      roomKey: options.roomKey,
      fileName: options.fileName,
      mimeType: options.mimeType,
      byteSize: bytes.length,
      status: 'ready',
      extractedText: bytes.toString('utf8'),
      deduped: false
    }
    liveAttachment = {
      ...saved,
      fileName: 'latest-name.txt',
      extractedText: 'latest database value'
    }
    return saved
  }
  store.getById = async (db, roomKey, attachmentId) => {
    accessEvents.push('getById')
    assert.equal(db.kind, 'test-db')
    assert.equal(roomKey, 'room-demo')
    assert.equal(attachmentId, 'att-resume-1')
    return liveAttachment
  }
  roomAcl.assertRoomAccess = async (db, req, roomKey, access) => {
    if (String(req.url || '').endsWith('/result')) {
      accessEvents.push('acl')
      assert.equal(roomKey, 'room-demo')
      assert.equal(access, 'view')
      if (denyResultAccess) {
        const err = new Error('denied')
        err.statusCode = 403
        err.code = 'FORBIDDEN'
        throw err
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    req.authUser = { id: 'tester' }
    try {
      const handled = await tus.handleTus(req, res, { db: { kind: 'test-db' } })
      if (!handled && !res.headersSent) {
        res.writeHead(404)
        res.end('no')
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message, code: err.code }))
      }
    }
  })

  try {
    const port = await listen(server)
    const options = await request(port, '/api/attachments/resumable', {
      method: 'OPTIONS'
    })
    assert.equal(options.status, 204)
    assert.equal(options.headers['tus-resumable'], '1.0.0')
    assert.match(String(options.headers['tus-extension'] || ''), /creation/)

    const missing = await request(port, '/api/attachments/resumable/missing/result')
    assert.equal(missing.status, 404)
    assert.equal(missing.json().code, 'NOT_FOUND')

    const payload = Buffer.from('hello-resume')
    const rawFileName = `${'说明'.repeat(100)}.txt`
    const created = await request(port, '/api/attachments/resumable', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(payload.length),
        'Upload-Metadata': encodeMetadata({
          filename: rawFileName,
          filetype: 'text/plain',
          roomKey: 'room-demo'
        })
      }
    })
    assert.equal(created.status, 201)
    const location = created.headers.location
    assert.match(location, /\/api\/attachments\/resumable\/[A-Za-z0-9-]+$/)
    const uploadId = location.split('/').pop()

    const first = payload.subarray(0, 5)
    const patched = await request(port, location, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream'
      },
      body: first
    })
    assert.equal(patched.status, 204)
    assert.equal(patched.headers['upload-offset'], '5')
    assert.equal(ingested.length, 0)

    const head = await request(port, location, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0' }
    })
    assert.equal(head.status, 200)
    assert.equal(head.headers['upload-offset'], '5')
    assert.equal(head.headers['upload-length'], String(payload.length))

    // A result sidecar cannot make an incomplete upload look successful.
    await fs.promises.writeFile(
      tus.resultPath(uploadId),
      JSON.stringify({ id: 'att-resume-1', roomKey: 'room-demo' }),
      'utf8'
    )
    accessEvents.length = 0
    const incompleteResult = await request(
      port,
      `/api/attachments/resumable/${uploadId}/result`
    )
    assert.equal(incompleteResult.status, 404)
    assert.equal(incompleteResult.json().code, 'NOT_FOUND')
    assert.deepEqual(accessEvents, [])
    assert.equal(fs.existsSync(tus.resultPath(uploadId)), false)

    const finished = await request(port, location, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '5',
        'Content-Type': 'application/offset+octet-stream'
      },
      body: payload.subarray(5)
    })
    assert.equal(finished.status, 204)
    assert.equal(finished.headers['upload-offset'], String(payload.length))
    assert.equal(finished.headers['x-mind-attachment-id'], 'att-resume-1')
    assert.equal(ingested.length, 1)
    assert.equal(ingested[0].db.kind, 'test-db')
    assert.equal(ingested[0].options.roomKey, 'room-demo')
    assert.equal(ingested[0].options.cleanupFile, false)
    assert.equal(ingested[0].options.fileName, rawFileName)
    const stored = await fs.promises.readFile(ingested[0].options.filePath)
    assert.ok(stored.equals(payload))

    accessEvents.length = 0
    const result = await request(port, `/api/attachments/resumable/${uploadId}/result`)
    assert.equal(result.status, 200)
    assert.equal(result.json().attachment.id, 'att-resume-1')
    assert.equal(result.json().attachment.fileName, 'latest-name.txt')
    assert.equal(result.json().attachment.extractedText, 'latest database value')
    assert.deepEqual(accessEvents, ['acl', 'getById'])

    // Preserve the old full-DTO sidecar format while resolving its ID live.
    const legacySidecar = JSON.parse(
      await fs.promises.readFile(tus.resultPath(uploadId), 'utf8')
    )
    assert.equal(legacySidecar.fileName, rawFileName)

    denyResultAccess = true
    accessEvents.length = 0
    const deniedResult = await request(
      port,
      `/api/attachments/resumable/${uploadId}/result`
    )
    assert.equal(deniedResult.status, 403)
    assert.deepEqual(accessEvents, ['acl'])
    denyResultAccess = false

    liveAttachment = null
    accessEvents.length = 0
    const deletedAttachmentResult = await request(
      port,
      `/api/attachments/resumable/${uploadId}/result`
    )
    assert.equal(deletedAttachmentResult.status, 404)
    assert.equal(deletedAttachmentResult.json().code, 'NOT_FOUND')
    assert.deepEqual(accessEvents, ['acl', 'getById'])
    assert.equal(fs.existsSync(tus.resultPath(uploadId)), false)

    // Expired TUS uploads also invalidate and remove any legacy sidecar.
    const expiredId = 'expired-upload'
    await fs.promises.writeFile(
      tus.resultPath(expiredId),
      JSON.stringify({ id: 'att-resume-1', roomKey: 'room-demo' }),
      'utf8'
    )
    const datastore = tus.getTusServer().datastore
    const originalDatastoreGetUpload = datastore.getUpload
    datastore.getUpload = async function (id) {
      if (id === expiredId) {
        return {
          id,
          size: 1,
          offset: 1,
          creation_date: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          metadata: { roomKey: 'room-demo' }
        }
      }
      return originalDatastoreGetUpload.call(this, id)
    }
    accessEvents.length = 0
    let expiredResult
    try {
      expiredResult = await request(
        port,
        `/api/attachments/resumable/${expiredId}/result`
      )
    } finally {
      datastore.getUpload = originalDatastoreGetUpload
    }
    assert.equal(expiredResult.status, 404)
    assert.equal(expiredResult.json().code, 'NOT_FOUND')
    assert.deepEqual(accessEvents, [])
    assert.equal(fs.existsSync(tus.resultPath(expiredId)), false)

    const resumedHead = await request(port, location, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0' }
    })
    assert.equal(resumedHead.status, 200)
    assert.equal(resumedHead.headers['upload-offset'], String(payload.length))

    const rejected = await request(port, '/api/attachments/resumable', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '4',
        'Upload-Metadata': encodeMetadata({
          filename: 'note.txt',
          filetype: 'text/plain'
        })
      }
    })
    assert.equal(rejected.status, 400)
  } finally {
    store.createFromBuffer = originalCreate
    store.getById = originalGetById
    roomAcl.assertRoomAccess = originalAcl
    await close(server)
    await fs.promises.rm(tusDir, { recursive: true, force: true })
  }

  console.log('nodeKnowledge tus resumable tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
