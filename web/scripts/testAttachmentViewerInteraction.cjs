const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')
const compiler = require('vue-template-compiler')
const dir = path.resolve(__dirname, '../src/pages/Edit/components/attachment-preview')
function load(name, context = {}) {
  const parsed = compiler.parseComponent(fs.readFileSync(path.join(dir, name), 'utf8'))
  assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
  vm.runInNewContext(parsed.script.content.replace(/^import .*$/gm, '').replace('export default', 'component ='), context)
  return context.component
}
const image = load('AttachmentImagePreview.vue')
const instance = { ...image.data(), ...image.methods, loading: false }
instance.onWheel({ deltaY: -100 })
assert.equal(instance.zoom, 125)
instance.onWheel({ deltaY: 100 })
assert.equal(instance.zoom, 100)
for (let n = 0; n < 30; n++) instance.onWheel({ deltaY: -1 })
assert.equal(instance.zoom, 400)
for (let n = 0; n < 30; n++) instance.onWheel({ deltaY: 1 })
assert.equal(instance.zoom, 25)
instance.loading = true
instance.onWheel({ deltaY: -1 })
assert.equal(instance.zoom, 25)
const rail = load('AttachmentThumbnailRail.vue')
const attachmentViewer = load('../NodeAttachmentPreview.vue', { setTimeout, clearTimeout })
async function test() {
  let disposed = 0
  let cleared = 0
  const target = { replaceChildren: () => cleared++ }
  const pane = {
    ...rail.methods,
    _handles: new Map(), _visible: new Set([1, 2]),
    $refs: { rail: { querySelector: () => target } },
    renderThumbnail: async () => ({ dispose: () => disposed++ })
  }
  await pane.renderVisible()
  assert.equal(pane._handles.size, 2)
  pane.release(1)
  assert.equal(disposed, 1)
  rail.beforeDestroy.call(pane)
  assert.equal(disposed, 2)
  assert.equal(pane._handles.size, 0)
  assert.equal(cleared, 2)
  const late = { ...pane, _disposed: false, _handles: new Map(), _visible: new Set([3]), renderThumbnail: async () => { late._disposed = true; return { dispose: () => disposed++ } } }
  await late.renderVisible()
  assert.equal(late._handles.size, 0)
  assert.equal(disposed, 3)
  load('AttachmentPdfPreview.vue', { AttachmentThumbnailRail: {} })
  const office = { name: 'office-preview', render() {} }
  let loadAttempts = 0
  const viewer = {
    ...attachmentViewer.data(), ...attachmentViewer.methods,
    visible: true, kind: 'office', source: { fileName: '预算.xlsx' },
    _previewModuleLoadTimeoutMs: 20,
    _previewModuleLoaders: { AttachmentOfficePreview: () => {
      loadAttempts += 1
      return loadAttempts === 1 ? Promise.reject(new Error('chunk failed')) : Promise.resolve(office)
    } }
  }
  await viewer.loadPreviewComponent('office', viewer.requestId)
  assert.equal(viewer.loading, false)
  assert.equal(viewer.previewComponent, null)
  assert.match(viewer.error, /预览组件加载失败/)
  assert.equal(viewer.previewLoadFailed, true)
  await viewer.retry()
  assert.equal(loadAttempts, 2)
  assert.equal(viewer.previewComponent, office)
  assert.equal(viewer.error, '')

  viewer._previewModuleLoaders.AttachmentOfficePreview = () => new Promise(() => {})
  await viewer.loadPreviewComponent('office', viewer.requestId)
  assert.equal(viewer.previewLoadFailed, true)
  assert.match(viewer.error, /加载超时/)

  viewer._previewModuleLoaders.AttachmentOfficePreview = () => Promise.resolve({ default: undefined })
  await viewer.loadPreviewComponent('office', viewer.requestId)
  assert.equal(viewer.previewComponent, null)
  assert.equal(viewer.previewLoadFailed, true, 'an invalid/empty component module must show the error state')

  const templateOnlyOffice = { name: 'template-only-office-preview', template: '<div>可预览</div>' }
  viewer._previewModuleLoaders.AttachmentOfficePreview = () => Promise.resolve({ default: templateOnlyOffice })
  await viewer.loadPreviewComponent('office', viewer.requestId)
  assert.equal(viewer.previewComponent, templateOnlyOffice, 'a valid Vue component with a non-empty template is accepted')

  let resolveOldModule
  viewer._previewModuleLoaders.AttachmentOfficePreview = () => new Promise(resolve => { resolveOldModule = resolve })
  viewer.visible = true
  viewer.source = { id: 'old-attachment' }
  const oldRequestId = viewer.requestId
  const oldLoad = viewer.loadPreviewComponent('office', oldRequestId)
  viewer.visible = false
  viewer.resetPreview()
  viewer.visible = true
  viewer.source = { id: 'new-attachment' }
  viewer.onClosed()
  const requestId = viewer.requestId
  assert.equal(viewer.source.id, 'new-attachment', 'a late close event must not clear a reopened preview')
  assert.equal(viewer.requestId, requestId)
  const otherOffice = { name: 'other-office-preview', render() {} }
  viewer._previewModuleLoaders.AttachmentOfficePreview = () => Promise.resolve(otherOffice)
  await viewer.loadPreviewComponent('office', requestId)
  resolveOldModule({ default: office })
  await oldLoad
  assert.equal(viewer.previewComponent, otherOffice, 'a late import from the prior attachment must not replace the newer preview')
  viewer.visible = false
  viewer.onClosed()
  assert.equal(viewer.source, null, 'a closed dialog still releases its preview state')
  console.log('PASS: image wheel direction/limits/loading guard; thumbnail render/disposal; async preview module error, timeout, retry and close-race handling; preview templates compile.')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
