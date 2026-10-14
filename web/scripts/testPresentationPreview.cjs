const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const compiler = require('vue-template-compiler')
const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const file = 'src/pages/Edit/components/attachment-preview/AttachmentPresentationPreview.vue'
const parsed = compiler.parseComponent(read(file))
assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
assert(!parsed.script.content.includes('extractedText'))
const calls = []
class Viewer {
  constructor(container, options) { calls.push(['create', container, options]) }
  async open(buffer, options) { calls.push(['open', buffer, options]); this.slideCount = 3 }
  async goToSlide(index) { calls.push(['go', index]) }
  async setZoom(percent) { calls.push(['zoom', percent]) }
  destroy() { calls.push(['destroy']) }
}
const binary = new Uint8Array([80, 75, 3, 4]).buffer
const ctx = {
  AbortController,
  JSZip: { loadAsync: async () => ({ files: { 'ppt/slides/slide1.xml': {} } }) },
  OFFICE_PREVIEW_MAX_BYTES: 5 * 1024 * 1024,
  assertOfficeZipBudget() {},
  fetchNodeAttachmentContent: async (room, id, options) => { calls.push(['fetch', room, id, options]); return { buffer: binary } },
  loadPresentationPreviewRuntime: async () => ({ PptxViewer: Viewer, RECOMMENDED_ZIP_LIMITS: {} })
}
vm.runInNewContext(parsed.script.content.replace(/^import .*$/gm, '').replace('export default', 'component ='), ctx)
const component = ctx.component
async function test() {
  const instance = { ...component.data(), ...component.methods, source: { id: 'pptx', roomKey: 'fixture', byteSize: 4 }, $refs: { slides: {}, viewport: {} }, $nextTick: async () => {} }
  await instance.load()
  assert.equal(instance.error, '')
  assert.equal(instance.count, 3)
  assert.equal(calls.find(call => call[0] === 'open')[1], binary)
  assert.equal(calls.find(call => call[0] === 'open')[2].renderMode, 'slide')
  await instance.goToPage(2)
  await instance.setZoom(125)
  assert.equal(instance.page, 2)
  assert.equal(instance.zoom, 125)
  component.beforeDestroy.call(instance)
  assert(instance._controller.signal.aborted)
  assert(calls.some(call => call[0] === 'destroy'))
  const big = { ...instance, _disposed: false, source: { byteSize: 40 * 1024 * 1024 }, error: '' }
  await big.load()
  assert(big.error.includes('较大'))
  const classifier = read('src/utils/nodeAttachmentPreview.js')
  const fn = classifier.slice(classifier.indexOf('export function attachmentPreviewKind'), classifier.indexOf('export function isHtmlAttachment')).replace('export ', '')
  const kindContext = { IMAGE_EXT: /\.(png|jpe?g|webp|gif)$/i, HTML_EXT: /\.html?$/i, TEXT_EXT: /\.(txt|js)$/i }
  vm.runInNewContext(fn, kindContext)
  for (const [name, expected] of [['deck.pptx', 'presentation'], ['deck.ppt', 'unsupported'], ['archive.zip', 'archive'], ['file.md', 'markdown'], ['file.pdf', 'pdf'], ['file.docx', 'office'], ['file.xlsx', 'office'], ['file.png', 'image'], ['file.txt', 'text']]) assert.equal(kindContext.attachmentPreviewKind(name, ''), expected)
  assert(read('src/pages/Edit/components/NodeAttachmentPreview.vue').includes("if (this.kind === 'presentation') return 'AttachmentPresentationPreview'"))
  console.log('PASS: binary PPTX routing/rendering, navigation, zoom preserves page, close cleanup, size budget, per-format routing and unsupported legacy files.')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
