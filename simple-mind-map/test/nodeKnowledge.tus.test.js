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
  const originalAcl = roomAcl.assertRoomAccess
  const ingested = []
  store.createFromBuffer = async (db, options) => {
    ingested.push({ db, options })
    const bytes = await fs.promises.readFile(options.filePath)
    return {
      id: 'att-resume-1',
      roomKey: options.roomKey,
      fileName: options.fileName,
      mimeType: options.mimeType,
      byteSize: bytes.length,
      status: 'ready',
      extractedText: bytes.toString('utf8'),
      deduped: false
    }
  }
  roomAcl.assertRoomAccess = async () => {}

  const server = http.createServer(async (req, res) => {
    req.authUser = { id: 'tester' }
    const handled = await tus.handleTus(req, res, { db: { kind: 'test-db' } })
    if (!handled && !res.headersSent) {
      res.writeHead(404)
      res.end('no')
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
    const created = await request(port, '/api/attachments/resumable', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(payload.length),
        'Upload-Metadata': encodeMetadata({
          filename: '说明.txt',
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
    assert.equal(ingested[0].options.fileName, '说明.txt')
    const stored = await fs.promises.readFile(ingested[0].options.filePath)
    assert.ok(stored.equals(payload))

    const result = await request(port, `/api/attachments/resumable/${uploadId}/result`)
    assert.equal(result.status, 200)
    assert.equal(result.json().attachment.id, 'att-resume-1')
    assert.equal(result.json().attachment.extractedText, 'hello-resume')

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
