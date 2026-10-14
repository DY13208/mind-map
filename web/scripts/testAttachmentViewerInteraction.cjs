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
  console.log('PASS: image wheel direction/limits/loading guard; thumbnail rendering, off-screen/disposal cleanup and late result cleanup; PPT/PDF templates compile.')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
