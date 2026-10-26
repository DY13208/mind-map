const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

function loadApi({ Upload, fetch, apiRequest }) {
  if (fetch) global.fetch = fetch
  const file = path.join(__dirname, '../src/utils/nodeAttachmentApi.js')
  const source = fs.readFileSync(file, 'utf8')
  const code = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === './fileApi') return { apiRequest }
    if (name === './roomLocation') return { roomFromLocation: () => 'room-a' }
    if (name === './runtimeConfig') return { getRuntimeConfig: () => ({ collabApi: '/collab' }) }
    if (name === './nodeKnowledge') {
      return { collectNodeKnowledge() { return [] }, knowledgeNeedsRemoteExtract() { return false } }
    }
    if (name === 'tus-js-client') return { Upload }
    if (name === './attachmentUploadQueue') return { enqueueAttachmentUpload: task => task() }
    if (name === './boundedAttachmentRead') return { readBoundedAttachmentResponse() {} }
    return {}
  }, mod, mod.exports)
  return mod.exports
}

function response(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'Server Error',
    async json() { return data }
  }
}

function createUploadHarness(previousUploads = []) {
  const instances = []
  class Upload {
    constructor(file, options) {
      this.file = file
      this.options = options
      this.url = `https://example.test/tus/${instances.length + 1}`
      this.started = 0
      this.resumeCalls = []
      this.previousLookupCalls = 0
      instances.push(this)
    }
    findPreviousUploads() {
      this.previousLookupCalls += 1
      return Promise.resolve(previousUploads)
    }
    resumeFromPreviousUpload(upload) {
      this.resumeCalls.push(upload)
    }
    start() {
      this.started += 1
    }
  }
  return { Upload, instances }
}

async function waitFor(predicate) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('timed out waiting for upload callback')
}

async function main() {
  const originalFetch = global.fetch
  const file = { name: '说明.html', size: 4, lastModified: 123, type: 'text/html' }
  const previous = [{ uploadUrl: 'https://example.test/tus/old' }]

  // Successful completion removes its stored fingerprint, while an incomplete
  // matching upload remains eligible for the usual TUS resume path.
  {
    const harness = createUploadHarness(previous)
    const api = loadApi({
      ...harness,
      fetch: async () => response(200, { ok: true, attachment: { id: 'result-id' } }),
      apiRequest: async url => ({ attachment: { id: 'header-id', url } })
    })
    const result = api.uploadNodeAttachment('room-a', { file })
    await waitFor(() => harness.instances.length === 1 && harness.instances[0].started === 1)
    const upload = harness.instances[0]
    assert.match(await upload.options.fingerprint(), /^mind-att-v2-room-a-/)
    assert.equal(upload.options.removeFingerprintOnSuccess, true)
    assert.deepEqual(upload.resumeCalls, [previous[0]])
    upload.options.onAfterResponse(null, { getHeader: () => 'header-id' })
    await upload.options.onSuccess()
    assert.equal((await result).attachment.id, 'header-id')
  }

  // A stale completed result is retried once with a brand-new TUS session;
  // the second attempt never asks local storage for the same completed URL.
  {
    const harness = createUploadHarness(previous)
    let resultReads = 0
    const api = loadApi({
      ...harness,
      fetch: async () => {
        resultReads += 1
        return response(404, { code: 'NOT_FOUND', error: 'expired result' })
      },
      apiRequest: async () => ({ attachment: { id: 'fresh-id' } })
    })
    const result = api.uploadNodeAttachment('room-a', { file })
    await waitFor(() => harness.instances.length === 1 && harness.instances[0].started === 1)
    await harness.instances[0].options.onSuccess()
    await waitFor(() => harness.instances.length === 2 && harness.instances[1].started === 1)
    assert.deepEqual(harness.instances[0].resumeCalls, [previous[0]])
    assert.equal(harness.instances[1].previousLookupCalls, 0)
    assert.equal(harness.instances[1].resumeCalls.length, 0)
    harness.instances[1].options.onAfterResponse(null, { getHeader: () => 'fresh-id' })
    await harness.instances[1].options.onSuccess()
    assert.equal((await result).attachment.id, 'fresh-id')
    assert.equal(resultReads, 1)
  }

  // A second 404 is returned to the caller rather than causing an upload loop.
  {
    const harness = createUploadHarness(previous)
    const api = loadApi({
      ...harness,
      fetch: async () => response(404, { code: 'NOT_FOUND', error: 'still missing' }),
      apiRequest: async () => ({})
    })
    const result = api.uploadNodeAttachment('room-a', { file })
    await waitFor(() => harness.instances.length === 1 && harness.instances[0].started === 1)
    await harness.instances[0].options.onSuccess()
    await waitFor(() => harness.instances.length === 2 && harness.instances[1].started === 1)
    await harness.instances[1].options.onSuccess()
    await assert.rejects(result, /still missing/)
    assert.equal(harness.instances.length, 2)
  }

  // Other result errors are not retried and the existing upload is not replaced.
  {
    const harness = createUploadHarness(previous)
    const api = loadApi({
      ...harness,
      fetch: async () => response(503, { error: 'temporarily unavailable' }),
      apiRequest: async () => ({})
    })
    const result = api.uploadNodeAttachment('room-a', { file })
    await waitFor(() => harness.instances.length === 1 && harness.instances[0].started === 1)
    await harness.instances[0].options.onSuccess()
    await assert.rejects(result, /temporarily unavailable/)
    assert.equal(harness.instances.length, 1)
  }

  global.fetch = originalFetch
  console.log('Attachment upload checks passed: v2 fingerprint, completed fingerprint cleanup, resume, stale-result fresh retry once, bounded 404 retry, and non-404 failure preservation')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
