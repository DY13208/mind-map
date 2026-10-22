const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const compiler = require('vue-template-compiler')
const load = require('./loadAttachmentUtils.cjs')
const { readBoundedAttachmentResponse } = load('boundedAttachmentRead')
const { attachmentPreviewKind } = load()
const calls = []
const scope = {
  URL, window: { location: { href: 'https://app.example.test/?room=one' } },
  readBoundedAttachmentResponse,
  fetchNodeAttachmentContent: async (...args) => { calls.push(args); return 'stored' },
  fetch: async (url, options) => { calls.push({ url, options }); return new Response('a,b\n') }
}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/attachmentPreviewSource.js'), 'utf8').replace(/^import .*$/gm, '').replace('export async function', 'async function'), scope)
const fetchContent = scope.fetchPreviewAttachmentContent

async function test() {
  const options = { maxBytes: 4, signal: new AbortController().signal }
  assert.equal(await fetchContent({ roomKey: 'one', id: 'stored' }, options), 'stored')
  assert.deepEqual(calls[0], ['one', 'stored', options], 'stored originals retain their authenticated API')
  const source = { external: true, url: 'https://files.example.test/data.csv' }
  assert.equal(new TextDecoder().decode((await fetchContent(source, options)).buffer), 'a,b\n')
  assert.equal(calls[1].options.credentials, 'same-origin', 'external hosts never receive application cookies')
  assert.equal(calls[1].options.signal, options.signal)
  assert.equal(calls[1].options.referrerPolicy, 'no-referrer')
  await assert.rejects(fetchContent(source, { maxBytes: 2 }), e => e.code === 'PREVIEW_TOO_LARGE')
  scope.fetch = async () => new Response('denied', { status: 403 })
  await assert.rejects(fetchContent(source, options), /HTTP 403/)
  scope.fetch = async () => { throw Object.assign(new Error('blocked'), { name: 'TypeError' }) }
  await assert.rejects(fetchContent(source, options), /跨域/)
  scope.fetch = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) }
  await assert.rejects(fetchContent(source, options), e => e.name === 'AbortError')
  await assert.rejects(fetchContent({ external: true, url: 'javascript:alert(1)' }, options), /不支持/)

  const parsed = compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/NodeAttachmentPreview.vue'), 'utf8'))
  const method = parsed.script.content.slice(parsed.script.content.indexOf('    openExternalAttachment(data)'), parsed.script.content.indexOf('    retry()'))
  const routing = { URL, window: scope.window, attachmentPreviewKind }
  vm.runInNewContext('methods = ({' + method + '})', routing)
  for (const [file, kind] of [['编号.csv', 'office'], ['报告.pptx', 'presentation'], ['报告.pdf', 'pdf']]) {
    const viewer = {
      requestId: 0,
      resetPreview() { this.source = null },
      loadPreviewComponent(componentKind, requestId) { this.loadedPreview = { componentKind, requestId } }
    }
    routing.methods.openExternalAttachment.call(viewer, { attachmentUrl: 'https://files.example.test/' + encodeURIComponent(file), attachmentMimeType: 'text/markdown' })
    assert.equal(viewer.kind, kind)
    assert.equal(viewer.title, file)
    assert.equal(viewer.source.external, true)
    assert.equal(viewer.visible, true)
    assert.deepEqual(viewer.loadedPreview, { componentKind: kind, requestId: 0 })
  }
  console.log('PASS external CSV/PPTX/PDF routing, URL names, bounded reads, HTTP/CORS failures, cancellation and stored API preservation')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
