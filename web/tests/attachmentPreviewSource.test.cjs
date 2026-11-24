const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
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

  const editSource = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/Edit.vue'), 'utf8')
  const openMethodStart = editSource.indexOf('    openHyperlink(')
  const openMethodEnd = editSource.indexOf('  /**', openMethodStart)
  const openMethodScope = {
    URL,
    window: {
      location: { href: 'https://mind.example.test/?room=one' },
      open: (...args) => opened.push(args)
    }
  }
  vm.runInNewContext('methods = ({' + editSource.slice(openMethodStart, openMethodEnd) + '})', openMethodScope)
  const opened = []
  const emitted = []
  const warnings = []
  const editor = {
    $bus: { $emit: (...args) => emitted.push(args) },
    $message: { warning: message => warnings.push(message) }
  }
  const node = { getData: key => key === 'hyperlinkTitle' ? '百度搜索' : '' }
  openMethodScope.methods.openHyperlink.call(editor, 'https://www.baidu.com/search?q=mind-map', node)
  assert.deepEqual(opened, [], 'normal hyperlink opening must stay inside the mind-map page')
  assert.equal(emitted[0][0], 'node_hyperlinkPreview')
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0][1])), {
    url: 'https://www.baidu.com/search?q=mind-map',
    title: '百度搜索'
  })
  openMethodScope.methods.openHyperlink.call(editor, 'javascript:alert(1)', node)
  openMethodScope.methods.openHyperlink.call(editor, 'not a url', node)
  assert.equal(emitted.length, 1, 'unsafe or malformed URLs must not reach the preview frame')
  assert.equal(warnings.length, 2)

  const previewScope = { setTimeout, clearTimeout, URL, window: scope.window }
  vm.runInNewContext(parsed.script.content.replace(/^import .*$/gm, '').replace('export default', 'component ='), previewScope)
  const previewComponent = previewScope.component
  const bus = new EventEmitter()
  bus.$on = bus.on.bind(bus)
  bus.$off = bus.off.bind(bus)
  bus.$emit = bus.emit.bind(bus)
  const hyperlinkViewer = {
    ...previewComponent.data(), ...previewComponent.methods,
    $bus: bus, $route: {}, $message: { warning: message => warnings.push(message) }
  }
  for (const name of Object.keys(previewComponent.methods)) {
    hyperlinkViewer[name] = hyperlinkViewer[name].bind(hyperlinkViewer)
  }
  previewComponent.created.call(hyperlinkViewer)
  bus.$emit('node_hyperlinkPreview', { url: 'https://www.baidu.com/', title: '百度搜索' })
  assert.equal(hyperlinkViewer.visible, true)
  assert.equal(hyperlinkViewer.externalUrl, 'https://www.baidu.com/')
  assert.equal(hyperlinkViewer.title, '百度搜索')
  assert.equal(hyperlinkViewer.previewMode, 'hyperlink')
  assert.equal(previewComponent.computed.typeLabel.call(hyperlinkViewer), '网页')
  assert.equal(previewComponent.computed.fileSize.call(hyperlinkViewer), '')
  assert.match(parsed.template.content, /allow-scripts/, 'embedded web pages need script support')
  assert.match(parsed.template.content, /openExternal/, 'the shared viewer must retain an external-open fallback')
  assert.match(parsed.template.content, /newWindowIcon/, 'the fallback uses the standard external-link icon')
  assert.match(parsed.template.content, /新窗口打开/, 'the fallback clearly describes opening a new window')
  previewComponent.beforeDestroy.call(hyperlinkViewer)
  hyperlinkViewer.visible = false
  bus.$emit('node_hyperlinkPreview', { url: 'https://example.test/' })
  assert.equal(hyperlinkViewer.visible, false, 'destroyed viewers must release the hyperlink event listener')

  console.log('PASS external attachment sources and hyperlinks use bounded, validated shared preview flows with external fallbacks')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
