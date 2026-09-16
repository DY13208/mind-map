const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

function load(source, mocks = {}) {
  const { code } = babel.transformSync(source, {
    babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'FileReader', code)(
    name => mocks[name] || {}, module, module.exports,
    class { readAsDataURL() { this.result = 'data:text/plain;base64,dGVzdA=='; this.onload() } }
  )
  return module.exports
}

async function main() {
  let response = { attachment: { id: 'att-1', status: 'ready', extractedText: '验收条件：三项全部通过' } }
  let request
  const helpers = load(fs.readFileSync(path.join(__dirname, '../src/utils/sopRunAttachments.js'), 'utf8'), {
    './nodeAttachmentApi': { uploadNodeAttachment: async (...args) => { request = args; return response } }
  })
  const { validateSopAttachment, uploadSopAttachment, formatSopAttachmentNote } = helpers
  for (const name of ['spec.pdf', '文档.docx', '表格.xlsx', 'image.PNG', 'note.txt', '说明.html', 'page.htm']) {
    assert.equal(validateSopAttachment({ name, size: 100 }), '')
  }
  assert.ok(validateSopAttachment({ name: 'tool.exe', size: 100 }))
  assert.ok(validateSopAttachment({ name: 'empty.txt', size: 0 }))
  assert.ok(validateSopAttachment({ name: 'large.pdf', size: 5 * 1024 * 1024 + 1 }))
  assert.equal(validateSopAttachment({ name: 'limit.pdf', size: 5 * 1024 * 1024 }), '')
  await uploadSopAttachment('test-room', { name: 'spec.txt', type: 'text/plain' })
  assert.equal(request[0], 'test-room')
  assert.equal(request[1].fileName, 'spec.txt')
  assert.equal(request[1].file.name, 'spec.txt')
  assert.equal(request[1].contentBase64, undefined)
  response = { attachment: { id: 'att-2', status: 'failed', errorMessage: 'OCR failed' } }
  await assert.rejects(uploadSopAttachment('test-room', { name: 'image.png' }), /OCR failed/)
  response = { attachment: { id: 'att-3', status: 'ready', extractedText: '' } }
  await assert.rejects(uploadSopAttachment('test-room', { name: 'image.png' }), /未能解析/)
  const note = formatSopAttachmentNote('请核对', [
    { status: 'ready', name: 'spec.txt', attachmentId: 'att-1', extractedText: '验收条件：三项全部通过' },
    { status: 'failed', name: 'bad.txt', extractedText: '不可发送' }
  ])
  assert.match(note, /请核对/)
  assert.match(note, /att-1/)
  assert.match(note, /验收条件：三项全部通过/)
  assert.ok(!note.includes('不可发送'))
  assert.equal(formatSopAttachmentNote('原始说明', []), '原始说明')

  // Exercise the real dialog methods without triggering a real SOP or notifications.
  const source = fs.readFileSync(path.join(__dirname, '../src/pages/SopRegistry/Index.vue'), 'utf8')
  const script = compiler.parseComponent(source).script.content
  const calls = []
  const pending = []
  const noop = () => {}
  const chain = { usePlugin() { return this } }
  const mocks = new Proxy({}, { get: (_, name) => {
    if (name === '@/utils/sopRunAttachments') return { ...helpers, uploadSopAttachment: () => new Promise(resolve => pending.push(resolve)) }
    if (name === '@/utils/sopSubmitMaterial') return { formatSubmitMaterialNote: (_, value) => value }
    if (name === '@/utils/agentChat') return { AI_BACKEND_OPENCLAW: 'openclaw', AI_BACKEND_XIAOCE: 'xiaoce', saveOpenclawConfig: noop }
    if (name === 'simple-mind-map') return chain
    return new Proxy(noop, { get: (_, key) => key === '__esModule' ? false : noop })
  } })
  const methods = load(script, mocks).default.methods
  const vm = { ...methods, roomKey: 'test-room', runAttachments: [], $message: { warning: noop, error: noop } }
  let prevented = false
  let pasted
  methods.onRunPaste.call({ addRunAttachments: files => { pasted = files } }, {
    clipboardData: { files: [], items: [], getData: () => '文本' }, preventDefault: () => { prevented = true }
  })
  assert.equal(prevented, false)
  assert.equal(pasted, undefined)
  methods.onRunPaste.call({ addRunAttachments: files => { pasted = files } }, {
    clipboardData: { files: [{ name: 'image.png' }], getData: () => '' }, preventDefault: () => { prevented = true }
  })
  assert.equal(prevented, true)
  assert.equal(pasted[0].name, 'image.png')
  vm.addRunAttachments(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, size: 10 })))
  assert.equal(vm.runAttachments.length, 5)
  const removed = vm.runAttachments[0]
  vm.removeRunAttachment(removed)
  pending[0]({ id: 'late', extractedText: 'removed' })
  await Promise.resolve()
  assert.equal(vm.runAttachments.length, 4)
  assert.ok(!vm.runAttachments.includes(removed))
  vm.runAttachments = [] // Reopening while uploads are pending must not restore old tags.
  pending[1]({ id: 'old-dialog', extractedText: 'old' })
  await Promise.resolve()
  assert.equal(vm.runAttachments.length, 0)
  Object.assign(vm, {
    runTarget: { uid: 'sop-1' }, canEditSop: true, runSubmitLoading: false,
    runBackend: 'openclaw', runModel: 'openclaw/default', runSubmitFields: [],
    runExtraNote: '请核对', runOutputIds: ['html'], userInfo: { name: 'QA' },
    resolveSopUid: () => 'sop-1', setLocalConfig: noop,
    sopRunQueue: { enqueue: async payload => { calls.push(payload); return { ok: false } } },
    runAttachments: [{ status: 'ready', name: 'spec.txt', attachmentId: 'att-1', extractedText: '验收条件：三项全部通过' }]
  })
  await vm.confirmRunSop()
  assert.match(calls[0].extraNote, /验收条件：三项全部通过/)
  assert.deepEqual(calls[0].outputIds, ['html'])
  assert.equal(calls[0].backend, 'openclaw')
  vm.runAttachments[0].status = 'uploading'
  await vm.confirmRunSop()
  assert.equal(calls.length, 1, 'Pending attachments must block queue submission')
  console.log('PASS: validation, upload contract, parse failures, text/image paste, 5-file limit, removal/reopen races, queue payload and pending guard')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
