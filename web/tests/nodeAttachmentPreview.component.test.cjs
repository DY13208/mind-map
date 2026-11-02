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
    getNodeAttachment: (room, id) => new Promise((resolve, reject) => pending.push({ room, id, resolve, reject })),
    nodeAttachmentContentUrl: (room, id, options = {}) => 'http://fixture/' + room + '/' + id + (options.download ? '?download=1' : '')
  }
  if (name === '@/utils/nodeAttachmentPreview') return require('./loadAttachmentUtils.cjs')()
  if (name === '@/utils/attachmentProgressiveText') return require('./loadAttachmentUtils.cjs')('attachmentProgressiveText')
  if (name === 'simple-mind-map/src/utils/attachmentIconState') return require('../../simple-mind-map/src/utils/attachmentIconState')
  return {}
}, moduleRef, moduleRef.exports)
const component = moduleRef.exports.default
function makeVm() {
  const value = { ...component.data(), $route: { query: { room: 'room-1' } }, $message: { info() {}, warning() {} } }
  for (const [key, method] of Object.entries(component.methods)) value[key] = method.bind(value)
  return value
}
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
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
  let downloadedName
  global.document = {
    body: { appendChild() {} },
    createElement: () => ({ click() { downloaded = this.href; downloadedName = this.download }, remove() {} })
  }
  try {
    vm.attachmentId = 'download'
    vm.source = { roomKey: 'room-1' }
    vm.download()
    assert.equal(downloaded, 'http://fixture/room-1/download?download=1')
    const pendingBeforeArchiveClick = pending.length
    vm.onAttachmentClick({ getData: () => ({ attachmentId: 'archive', attachmentName: '资料.tar.gz' }) })
    assert.equal(downloaded, 'http://fixture/room-1/archive?download=1', 'archive click downloads original content directly')
    assert.equal(downloadedName, '资料.tar.gz', 'archive download keeps the original filename')
    assert.equal(pending.length, pendingBeforeArchiveClick, 'archive click skips metadata and preview loading')
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
  // Failed office attachments keep the explicit error actions because their
  // original file cannot be previewed here.
  const emitted = []
  const infos = []
  const errVm = makeVm()
  errVm.$bus = { $emit: (...args) => emitted.push(args) }
  errVm.$message = { info: m => infos.push(m), warning() {}, success() {} }
  const failedData = { uid: 'n-failed', attachmentId: 'att-f', attachmentName: '报告.docx', attachmentStatus: 'failed', attachmentError: 'Word 解析失败' }
  const failedNode = { getData: key => key ? failedData[key] : failedData, mindMap: { opt: {} } }
  const pendingBefore = pending.length
  errVm.onAttachmentClick(failedNode)
  assert.equal(errVm.errorDialog.visible, true, 'failed click opens the error actions')
  assert.equal(errVm.errorDialog.editable, true)
  assert.equal(errVm.errorDialog.data.attachmentError, 'Word 解析失败')
  assert.equal(pending.length, pendingBefore, 'failed click does not start a preview request')
  assert.equal(infos.length, 0)
  // PDF text extraction failure does not block opening the original PDF.
  errVm.errorDialog.visible = false
  errVm._previewModuleLoaders = {
    AttachmentPdfPreview: async () => ({ render() {} })
  }
  const pendingBeforePdf = pending.length
  const failedPdfData = {
    uid: 'n-pdf', attachmentId: 'att-pdf', attachmentName: '扫描件.pdf',
    attachmentMimeType: 'application/pdf', attachmentStatus: 'failed',
    attachmentError: 'PDF 未提取到文字（可能是扫描件，需 OCR）'
  }
  errVm.onAttachmentClick({ getData: key => key ? failedPdfData[key] : failedPdfData })
  assert.equal(errVm.errorDialog.visible, false, 'failed PDF extraction does not open the blocking error dialog')
  assert.equal(pending.length, pendingBeforePdf + 1, 'failed PDF click requests the original attachment')
  pending[pendingBeforePdf].resolve({ attachment: {
    id: 'att-pdf', fileName: '扫描件.pdf', mimeType: 'application/pdf',
    status: 'failed', errorMessage: 'PDF 未提取到文字（可能是扫描件，需 OCR）', byteSize: 1024
  } })
  await flush()
  assert.equal(errVm.source.id, 'att-pdf', 'original PDF is loaded despite extraction failure')
  assert.match(component.computed.extractionWarning.call(errVm), /原文件可以打开，但文字提取失败/)
  assert.match(component.computed.extractionWarning.call(errVm), /需 OCR/)
  assert.equal(errVm.previewComponent.render instanceof Function, true, 'PDF preview is mounted')
  // Failed image OCR follows the same non-blocking path.
  const failedImageData = {
    attachmentId: 'att-image', attachmentName: '图片.png', attachmentMimeType: 'image/png',
    attachmentStatus: 'failed', attachmentError: '图片 OCR 服务未配置'
  }
  const pendingBeforeImage = pending.length
  errVm.onAttachmentClick({ getData: key => key ? failedImageData[key] : failedImageData })
  assert.equal(errVm.errorDialog.visible, false)
  pending[pendingBeforeImage].resolve({ attachment: {
    id: 'att-image', fileName: '图片.png', mimeType: 'image/png', status: 'failed',
    errorMessage: '图片 OCR 服务未配置', byteSize: 2048
  } })
  await flush()
  assert.equal(errVm.source.id, 'att-image', 'original image opens despite OCR failure')
  assert.match(component.computed.extractionWarning.call(errVm), /图片 OCR 服务未配置/)
  // If the original content is actually unavailable or forbidden, show that
  // retrieval error instead of masking it as an extraction warning.
  for (const [id, message] of [['att-403', '403 Forbidden'], ['att-404', '404 Not Found']]) {
    const deniedData = {
      attachmentId: id, attachmentName: '原件.pdf', attachmentMimeType: 'application/pdf',
      attachmentStatus: 'failed', attachmentError: 'PDF 未提取到文字'
    }
    const pendingBeforeDenied = pending.length
    errVm.onAttachmentClick({ getData: key => key ? deniedData[key] : deniedData })
    pending[pendingBeforeDenied].reject(Object.assign(new Error(message), {
      statusCode: Number(id.slice(-3))
    }))
    await flush()
    assert.equal(errVm.error, message, `${message} from original retrieval remains visible`)
    assert.equal(component.computed.extractionWarning.call(errVm), '', 'an unavailable original does not get a success-style extraction notice')
  }
  for (const action of ['replace', 'delete', 'ignoreError']) {
    errVm.errorDialog.visible = true
    errVm.errorAction(action)
    assert.equal(errVm.errorDialog.visible, false)
    assert.deepEqual(emitted[emitted.length - 1], ['manageNodeAttachment', {
      action, uid: 'n-failed', node: failedNode,
      expectedAttachmentId: 'att-f', expectedAttachmentUrl: '', expectedAttachmentName: '报告.docx'
    }])
  }
  // Read-only users can see the error but not run mutating actions.
  const readonlyNode = { getData: key => key ? failedData[key] : failedData, mindMap: { opt: { readonly: true } } }
  const emittedBefore = emitted.length
  let prevented = 0
  let stopped = 0
  errVm.onAttachmentContextmenu(readonlyNode, { preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  assert.equal(errVm.errorDialog.visible, true, 'right-click on a failed icon opens the dialog')
  assert.equal(errVm.errorDialog.editable, false)
  assert.equal(prevented + stopped, 2)
  errVm.errorAction('delete')
  assert.equal(emitted.length, emittedBefore, 'read-only dialog cannot emit mutations')
  // Ignored errors behave like a normal attachment again.
  errVm.errorDialog.visible = false
  const ignoredData = { attachmentName: '旧.docx', attachmentStatus: 'failed', attachmentError: 'x', attachmentErrorIgnored: true }
  errVm.onAttachmentClick({ getData: () => ignoredData })
  assert.equal(errVm.errorDialog.visible, false)
  assert.equal(infos.length, 1)
  errVm.onAttachmentContextmenu({ getData: () => ignoredData }, { preventDefault() { throw new Error('should not prevent') } })
  assert.equal(errVm.errorDialog.visible, false)
  console.log('Failed attachment error dialog, read-only and ignore checks passed')
  console.log('Attachment shell stale response, close, route, download and maximize checks passed')
  console.log('Spreadsheet rapid scrolling and sheet-switch race checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
