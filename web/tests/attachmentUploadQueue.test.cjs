const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

function load(sourcePath, mocks = {}) {
  const { code } = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    name => {
      if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name]
      if (name === 'p-queue') return require('p-queue')
      return {}
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const queuePath = path.join(__dirname, '../src/utils/attachmentUploadQueue.js')
  const apiPath = path.join(__dirname, '../src/utils/nodeAttachmentApi.js')
  const queue = load(queuePath)
  assert.equal(queue.attachmentUploadQueue.concurrency, 2)

  let running = 0
  let maxRunning = 0
  const order = []
  await Promise.all(
    ['a', 'b', 'c', 'd'].map(name =>
      queue.enqueueAttachmentUpload(async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        order.push(`start:${name}`)
        await delay(40)
        running -= 1
        order.push(`end:${name}`)
        return name
      })
    )
  )
  assert.equal(maxRunning, 2)
  assert.equal(order.filter(item => item.startsWith('start:')).length, 4)
  assert.ok(queue.attachmentQueuePending() === 0)
  assert.ok(queue.attachmentQueueSize() === 0)

  const uploads = []
  const apiRequests = []
  let statuses = []
  const api = load(apiPath, {
    './fileApi': {
      apiRequest: async (...args) => {
        apiRequests.push(args)
        const url = String(args[0] || '')
        if (/att-wait/.test(url)) {
          return { ok: true, attachment: statuses.shift() }
        }
        return { ok: true, attachment: { id: 'att-9', fileName: '说明.txt', status: 'ready' } }
      }
    },
    './roomLocation': { roomFromLocation: () => 'room-demo' },
    './runtimeConfig': { getRuntimeConfig: () => ({ collabApi: 'http://example.test' }) },
    './nodeKnowledge': {
      collectNodeKnowledge: () => ({}),
      knowledgeNeedsRemoteExtract: () => false
    },
    './attachmentUploadQueue': queue,
    'tus-js-client': {
      Upload: class FakeUpload {
        constructor(file, options) {
          this.file = file
          this.options = options
          this.url = 'http://example.test/api/attachments/resumable/u1'
          uploads.push(this)
        }
        findPreviousUploads() {
          return Promise.resolve(this.options._previous || [])
        }
        resumeFromPreviousUpload(prev) {
          this.resumed = prev
        }
        start() {
          const header = name =>
            /x-mind-attachment-id/i.test(String(name || '')) ? 'att-9' : ''
          Promise.resolve()
            .then(() => this.options.onProgress(this.file.size, this.file.size))
            .then(() =>
              this.options.onAfterResponse(null, { getHeader: header })
            )
            .then(() => this.options.onSuccess())
            .catch(err => this.options.onError(err))
        }
      }
    }
  })

  assert.equal(api.TUS_CHUNK_BYTES, 8 * 1024 * 1024)
  assert.equal(
    api.attachmentFingerprint('room-a', {
      name: 'a.txt',
      size: 12,
      lastModified: 99
    }),
    'mind-att-room-a-a.txt-12-99'
  )

  const progress = []
  const result = await api.uploadNodeAttachment('room-demo', {
    file: { name: '说明.txt', size: 12, type: 'text/plain', lastModified: 1 },
    fileName: '说明.txt',
    mimeType: 'text/plain',
    nodeUid: 'n1',
    onUploadProgress: evt => progress.push(evt.percent)
  })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].options.endpoint, 'http://example.test/api/attachments/resumable')
  assert.equal(uploads[0].options.chunkSize, 8 * 1024 * 1024)
  assert.equal(uploads[0].options.metadata.roomKey, 'room-demo')
  assert.equal(uploads[0].options.metadata.filename, '说明.txt')
  assert.equal(await uploads[0].options.fingerprint(), 'mind-att-room-demo-说明.txt-12-1')
  assert.equal(result.attachment.id, 'att-9')
  assert.match(apiRequests[0][0], /\/attachments\/att-9$/)
  assert.ok(progress.includes(100))

  const jsonBody = await api.uploadNodeAttachment('room-demo', {
    fileName: 'remote.txt',
    sourceUrl: 'https://cdn.example.test/a.txt'
  })
  assert.equal(jsonBody.attachment.id, 'att-9')
  assert.equal(apiRequests[1][1].method, 'POST')

  statuses = [
    { id: 'att-wait', status: 'processing' },
    { id: 'att-wait', status: 'processing' },
    { id: 'att-wait', status: 'ready', fileName: '表.xlsx', extractedText: 'ok' }
  ]
  const seen = []
  const settled = await api.waitForAttachmentReady('room-demo', 'att-wait', {
    intervalMs: 400,
    onUpdate: item => seen.push(item.status)
  })
  assert.equal(settled.status, 'ready')
  assert.deepEqual(seen, ['processing', 'processing', 'ready'])
  assert.match(apiRequests[2][0], /\/attachments\/att-wait$/)

  console.log('PASS: attachment upload queue concurrency and tus client wiring')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
