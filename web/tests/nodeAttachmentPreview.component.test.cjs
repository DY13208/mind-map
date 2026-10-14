const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const pending = []
const tabs = []
const filename = path.resolve(__dirname, '../src/pages/Edit/components/NodeAttachmentPreview.vue')
const script = compiler.parseComponent(fs.readFileSync(filename, 'utf8')).script.content
const { code } = babel.transformSync(script, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
const moduleRef = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === '@/utils/roomLocation') return { roomFromLocation: route => route.query.room }
  if (name === '@/utils/nodeAttachmentApi') return {
    getNodeAttachment: (room, id) => new Promise(resolve => pending.push({ room, id, resolve })),
    nodeAttachmentContentUrl: (room, id, options = {}) => 'http://fixture/' + room + '/' + id + (options.download ? '?download=1' : '')
  }
  if (name === '@/utils/nodeAttachmentPreview') return require('./loadAttachmentUtils.cjs')()
  if (name === '@/utils/attachmentProgressiveText') return require('./loadAttachmentUtils.cjs')('attachmentProgressiveText')
  return {}
}, moduleRef, moduleRef.exports)
const component = moduleRef.exports.default
function makeVm() {
  const value = { ...component.data(), $route: { query: { room: 'room-1' } }, $message: { info() {}, warning() {} } }
  for (const [key, method] of Object.entries(component.methods)) value[key] = method.bind(value)
  return value
}
async function main() {
  const vm = makeVm()
  const first = vm.openStoredAttachment({ attachmentId: 'first', attachmentName: '旧文件.md' })
  const second = vm.openStoredAttachment({ attachmentId: 'second', attachmentName: '图片.png' })
  pending[1].resolve({ attachment: { id: 'second', fileName: '图片.png', status: 'failed', mimeType: 'image/png', byteSize: 2048 } })
  await second
  pending[0].resolve({ attachment: { id: 'first', fileName: '旧文件.md', status: 'ready' } })
  await first
  assert.equal(vm.source.id, 'second', 'late responses cannot replace the selected attachment')
  assert.equal(vm.kind, 'image', 'OCR failure does not redirect to replacement')
  assert.equal(vm.loading, false)
  assert.equal(Object.isFrozen(vm.source), true)
  const third = vm.openStoredAttachment({ attachmentId: 'third', attachmentName: '日志.txt' })
  vm.visible = false
  vm.onClosed()
  pending[2].resolve({ attachment: { id: 'third', fileName: '日志.txt' } })
  await third
  assert.equal(vm.source, null, 'close invalidates pending metadata responses')
  assert.equal(vm.attachmentId, '')
  vm.toggleMaximize()
  assert.equal(vm.isMaximized, true)
  vm.toggleMaximize()
  assert.equal(vm.isMaximized, false)
  component.watch.$route.call(vm, { query: { room: 'room-2' } }, { query: { room: 'room-1' } })
  assert.equal(vm.visible, false)
  const previousWindow = global.window
  const previousDocument = global.document
  global.window = { open: (...args) => tabs.push(args) }
  let downloaded
  global.document = {
    body: { appendChild() {} },
    createElement: () => ({ click() { downloaded = this.href }, remove() {} })
  }
  try {
    vm.attachmentId = 'download'
    vm.source = { roomKey: 'room-1' }
    vm.download()
    assert.equal(downloaded, 'http://fixture/room-1/download?download=1')
    vm.onAttachmentClick({ getData: () => ({ attachmentId: 'html', attachmentName: '说明.html' }) })
    assert.equal(tabs[0][0], 'http://fixture/room-1/html')
    vm.openExternalAttachment({ attachmentName: '旧附件.pdf', attachmentUrl: 'https://example.test/a.pdf' })
    assert.equal(vm.externalUrl, 'https://example.test/a.pdf')
  } finally { global.window = previousWindow; global.document = previousDocument }
  // Two scroll requests may finish out of order; only the latest viewport wins.
  const officeScript = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/attachment-preview/AttachmentOfficePreview.vue'), 'utf8')).script.content
  const officeCode = babel.transformSync(officeScript, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code
  const officeModule = { exports: {} }
  new Function('require', 'module', 'exports', officeCode)(() => ({}), officeModule, officeModule.exports)
  const office = officeModule.exports.default
  const rowRequests = []
  const sheetVm = {
    ...office.data(), _cache: new Map(), _sheetEpoch: 0, _rowEpoch: 0, _worker: {},
    $refs: { sheetViewport: { clientHeight: 600 } }, currentSheet: { rows: 2501 }, activeSheet: 'Sheet1',
    workerCall: request => new Promise(resolve => rowRequests.push({ ...request, resolve }))
  }
  const firstRows = office.methods.loadRows.call(sheetVm, 0)
  const lastRows = office.methods.loadRows.call(sheetVm, 500)
  rowRequests[1].resolve({ rows: Array.from({ length: 100 }, (_, i) => ['row ' + (500 + i)]) })
  await lastRows
  rowRequests[0].resolve({ rows: Array.from({ length: 100 }, (_, i) => ['row ' + i]) })
  await firstRows
  assert.equal(sheetVm.rowStart, 500)
  assert.equal(sheetVm.rows[0][0], 'row 500', 'late scroll results cannot replace visible rows')
  assert.equal(sheetVm.rowsLoading, false)
  const switched = office.methods.loadRows.call(sheetVm, 1000)
  sheetVm._sheetEpoch++
  sheetVm.activeSheet = 'Sheet2'
  sheetVm.rows = []
  rowRequests[2].resolve({ rows: [['stale Sheet1']] })
  await switched
  assert.equal(sheetVm.rows.length, 0, 'switching sheets invalidates in-flight row requests')
  console.log('Attachment shell stale response, close, route, download and maximize checks passed')
  console.log('Spreadsheet rapid scrolling and sheet-switch race checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
