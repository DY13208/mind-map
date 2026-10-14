const fs = require('fs')
const path = require('path')
const assert = require('assert').strict
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const script = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/attachment-preview/AttachmentPresentationPreview.vue'), 'utf8')).script.content
const code = babel.transformSync(script, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code
const ref = { exports: {} }
let finishOpen, started
const opened = new Promise(resolve => { started = resolve })
class Viewer {
  constructor() { this.slideCount = 3 }
  open(buffer, options) { this.signal = options.signal; started(this); return new Promise(resolve => { finishOpen = resolve }) }
  destroy() { this.destroyed = true }
}
new Function('require','module','exports',code)(name => {
  if(name === 'jszip') return { loadAsync: async () => ({ files: { 'ppt/slides/slide1.xml': {} } }) }
  if(name.endsWith('/nodeAttachmentApi')) return { fetchNodeAttachmentContent: async () => ({ buffer: new ArrayBuffer(8) }) }
  if(name.endsWith('/nodeAttachmentPreview')) return { OFFICE_PREVIEW_MAX_BYTES: 5242880, assertOfficeZipBudget() {} }
  return { loadPresentationPreviewRuntime: async () => ({ PptxViewer: Viewer }) }
},ref,ref.exports)
async function main() {
  const c = ref.exports.default
  const vm = { ...c.data(), source: { roomKey:'fixture',id:'pptx',byteSize:8 }, $refs: {slides:{},viewport:{}} }
  for(const [key,method] of Object.entries(c.methods)) vm[key] = method.bind(vm)
  const pending = vm.load()
  const viewer = await opened
  c.beforeDestroy.call(vm)
  assert.equal(viewer.signal.aborted,true,'close aborts in-progress parsing')
  assert.equal(viewer.destroyed,true,'close destroys renderer before open resolves')
  finishOpen()
  await pending
  assert.equal(vm.count,0,'late parsing result cannot update a destroyed preview')
  assert.equal(vm._viewer,null)
  console.log('PPTX close-during-load and stale completion checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
