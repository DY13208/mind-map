const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

function loadVue(file, mocks = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const parsed = compiler.parseComponent(source)
  assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
  const code = babel.transformSync(parsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (mocks[name]) return mocks[name]
    if (name === 'vuex') {
      return {
        mapState: () => ({}),
        mapMutations: () => ({ setLocalConfig() {} })
      }
    }
    if (name === '@/utils/roomLocation') {
      return {
        roomFromLocation: route => (route && route.query && route.query.room) || '',
        buildInviteUrl: room => room
      }
    }
    if (name === 'simple-mind-map/src/utils') {
      return { getTextFromHtml: text => String(text || '').replace(/<[^>]*>/g, '') }
    }
    if (name === 'simple-mind-map/src/parse/toMarkdown') return { transformToMarkdown() {} }
    if (name === 'simple-mind-map/src/parse/toTxt') return { transformToTxt() {} }
    if (name === '@/utils') {
      return { setDataToClipboard() {}, setImgToClipboard() {}, copy() {} }
    }
    if (name === '@/config') return { numberTypeList: {}, numberLevelList: {} }
    if (name === '@/utils/runtimeConfig') return { getRuntimeConfig: () => ({}) }
    return {}
  }, mod, mod.exports)
  return mod.exports.default
}

function loadAttachmentApi(apiRequest) {
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
    if (name === './roomLocation') return { roomFromLocation: () => 'room-A' }
    if (name === './runtimeConfig') return { getRuntimeConfig: () => ({}) }
    if (name === './nodeKnowledge') {
      return { collectNodeKnowledge() { return [] }, knowledgeNeedsRemoteExtract() { return false } }
    }
    if (name === 'tus-js-client') return { Upload: class Upload {} }
    if (name === './attachmentUploadQueue') {
      return { enqueueAttachmentUpload: task => task() }
    }
    return {}
  }, mod, mod.exports)
  return mod.exports
}

function node(uid, data) {
  const result = {
    uid,
    nodeData: { data: { uid, ...data } },
    children: [],
    getData(key) {
      return key ? this.nodeData.data[key] : this.nodeData.data
    },
    reRender() {}
  }
  return result
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function messageSink() {
  const entries = []
  const sink = message => {
    entries.push(['notice', message])
    return { close() { entries.push(['closed']) } }
  }
  ;['success', 'warning', 'error', 'info'].forEach(type => {
    sink[type] = message => entries.push([type, message])
  })
  return { sink, entries }
}

function makeAttachmentVm(component, api, nodeList) {
  const commands = []
  const renderer = {
    root: nodeList[0],
    findNodeByUid: uid => nodeList.find(item => item.uid === uid) || null,
    setNodeData(target, patch) {
      Object.assign(target.nodeData.data, patch)
    }
  }
  const mindMap = {
    renderer,
    execCommand(...args) {
      commands.push(args)
      const [, target, url, name, meta] = args
      if (args[0] === 'SET_NODE_DATA') { Object.assign(target.nodeData.data, url); return }
      Object.assign(target.nodeData.data, {
        attachmentUrl: url,
        attachmentName: name,
        ...(meta || {})
      })
    }
  }
  const messages = messageSink()
  const handlers = {}
  const vm = {
    mindMap,
    $route: { query: { room: 'room-A' } },
    $refs: { fileInput: { click() {} } },
    $bus: {
      $on(name, fn) { handlers[name] = fn },
      $off() {}
    },
    $set(object, key, value) { object[key] = value },
    $delete(object, key) { delete object[key] },
    $message: messages.sink,
    async $confirm(message, title, options) {
      vm.confirmation = { message, title, options }
    },
    handlers,
    commands,
    messages
  }
  Object.assign(vm, component.data.call(vm), component.methods)
  return vm
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

async function run() {
  const calls = { deletes: [], uploads: [], waits: [] }
  const api = {
    getNodeAttachment: async () => ({ attachment: null }),
    getRoomRevision: async () => 17,
    deleteNodeAttachment: (...args) => {
      calls.deletes.push(args)
      return api.deleteResult()
    },
    uploadNodeAttachment: (...args) => {
      calls.uploads.push(args)
      return api.uploadResult()
    },
    waitForAttachmentReady: (...args) => {
      calls.waits.push(args)
      return api.waitResult()
    },
    maxAttachmentBytes: () => 1000,
    formatAttachmentMaxMb: () => 1
  }
  const component = loadVue(
    path.join(__dirname, '../src/pages/Edit/components/NodeAttachment.vue'),
    { '@/utils/nodeAttachmentApi': api }
  )

  // Confirmed managed delete sends the captured ID and UID, then applies only
  // attachment fields from the server response (never a second SET command).
  const managed = node('n-managed', {
    text: 'current text',
    attachmentId: 'att-old',
    attachmentName: 'report.pdf',
    attachmentStatus: 'processing',
    attachmentUrl: ''
  })
  const vm = makeAttachmentVm(component, api, [managed])
  const deletion = deferred()
  api.deleteResult = () => deletion.promise
  const deleteRun = vm.onManageAttachment({
    action: 'delete',
    uid: 'n-managed',
    node: managed,
    expectedAttachmentId: 'att-old',
    expectedAttachmentUrl: '',
    expectedAttachmentName: 'report.pdf'
  })
  await flush()
  assert.equal(
    vm.confirmation.message,
    '确定从当前节点移除附件“report.pdf”吗？此操作只解绑当前节点；原文件保留供历史恢复和共享节点使用。'
  )
  assert.deepEqual(calls.deletes[0], [
    'room-A',
    'att-old',
    'n-managed',
    { confirmSopChange: true, baseVersion: 17 }
  ])
  managed.nodeData.data.text = 'concurrent newer text'
  deletion.resolve({
    ok: true,
    detached: true,
    retained: true,
    revision: 8,
    node: {
      uid: 'n-managed',
      data: {
        text: 'stale server text',
        attachmentUrl: '',
        attachmentName: '',
        attachmentId: '',
        attachmentMimeType: '',
        attachmentStatus: '',
        attachmentError: '',
        attachmentExtractedText: '',
        attachmentProgress: 0
      }
    }
  })
  await deleteRun
  assert.equal(vm.commands.length, 0)
  assert.equal(managed.getData('text'), 'concurrent newer text')
  assert.equal(managed.getData('attachmentId'), '')
  assert.equal(managed.getData('attachmentName'), '')
  assert.ok(vm.messages.entries.some(entry =>
    entry[0] === 'success' &&
    entry[1] === '已从当前节点移除附件，原文件保留供历史恢复和共享节点使用'
  ))

  // A newer attachment that arrives before a stale DELETE response is kept.
  const replacedDuringDelete = node('n-race-delete', {
    attachmentId: 'att-before',
    attachmentName: 'old.pdf'
  })
  const raceVm = makeAttachmentVm(component, api, [replacedDuringDelete])
  const delayedDelete = deferred()
  api.deleteResult = () => delayedDelete.promise
  const racingDelete = raceVm.onManageAttachment({
    action: 'delete', uid: 'n-race-delete', node: replacedDuringDelete,
    expectedAttachmentId: 'att-before', expectedAttachmentName: 'old.pdf'
  })
  await flush()
  replacedDuringDelete.nodeData.data.attachmentId = 'att-newer'
  replacedDuringDelete.nodeData.data.attachmentName = 'new.pdf'
  delayedDelete.resolve({ detached: true, node: { uid: 'n-race-delete', data: {} } })
  await racingDelete
  assert.equal(replacedDuringDelete.getData('attachmentId'), 'att-newer')

  const mismatched = node('n-mismatch', {
    attachmentId: 'att-current', attachmentName: 'current.pdf'
  })
  const mismatchVm = makeAttachmentVm(component, api, [mismatched])
  api.deleteResult = async () => {
    const error = new Error('attachment changed')
    error.code = 'ATTACHMENT_MISMATCH'
    error.statusCode = 409
    throw error
  }
  await mismatchVm.onManageAttachment({
    action: 'delete', uid: 'n-mismatch', node: mismatched,
    expectedAttachmentId: 'att-current', expectedAttachmentName: 'current.pdf'
  })
  assert.equal(mismatched.getData('attachmentId'), 'att-current')
  assert.equal(mismatchVm.commands.length, 0)
  assert.ok(mismatchVm.messages.entries.some(entry => entry[0] === 'warning'))

  // Idempotent DELETE explains that only the node reference is absent while
  // the stored object remains available for history and shared references.
  const alreadyDetached = node('n-already-detached', {
    attachmentId: 'att-already', attachmentName: 'already.pdf'
  })
  const alreadyDetachedVm = makeAttachmentVm(component, api, [alreadyDetached])
  api.deleteResult = async () => ({ already_detached: true, detached: false })
  await alreadyDetachedVm.onManageAttachment({
    action: 'delete', uid: 'n-already-detached', node: alreadyDetached,
    expectedAttachmentId: 'att-already', expectedAttachmentName: 'already.pdf'
  })
  assert.ok(alreadyDetachedVm.messages.entries.some(entry =>
    entry[0] === 'info' &&
    entry[1] === '当前节点已无该附件，原文件保留供历史恢复和共享节点使用'
  ))

  // Replace confirmation and failed upload do not clear or restore a stale
  // snapshot; the original pointer and metadata remain exactly as they were.
  const existing = node('n-replace', {
    attachmentId: 'att-existing',
    attachmentName: 'source.xlsx',
    attachmentMimeType: 'application/xlsx',
    attachmentStatus: 'failed',
    attachmentError: 'parse failed'
  })
  const replaceVm = makeAttachmentVm(component, api, [existing])
  let inputClicks = 0
  replaceVm.$refs.fileInput.click = () => { inputClicks += 1 }
  api.uploadResult = () => Promise.reject(new Error('network down'))
  await replaceVm.onManageAttachment({
    action: 'replace', uid: 'n-replace', node: existing,
    expectedAttachmentId: 'att-existing', expectedAttachmentName: 'source.xlsx'
  })
  assert.equal(inputClicks, 1)
  assert.equal(calls.deletes.length, 4)
  const oldData = { ...existing.getData() }
  const originalConsoleError = console.error
  console.error = () => {}
  await replaceVm.onFilePicked({ target: { files: [{ name: 'new.xlsx', size: 12, type: 'application/xlsx' }], value: 'selected' } })
  console.error = originalConsoleError
  assert.equal(existing.getData('attachmentId'), oldData.attachmentId)
  assert.equal(existing.getData('attachmentName'), oldData.attachmentName)
  assert.equal(existing.getData('attachmentStatus'), oldData.attachmentStatus)
  assert.equal(replaceVm.commands.length, 0)

  // Upload completion is ignored if another collaborator changed the target
  // while the upload was running.
  const changed = node('n-upload-race', {
    attachmentId: 'att-start', attachmentName: 'start.txt'
  })
  const uploadVm = makeAttachmentVm(component, api, [changed])
  const upload = deferred()
  api.uploadResult = () => upload.promise
  uploadVm.pendingNodes = [uploadVm.captureTarget(changed, 'room-A')]
  const uploadRun = uploadVm.onFilePicked({
    target: { files: [{ name: 'replacement.txt', size: 10, type: 'text/plain' }], value: 'x' }
  })
  changed.nodeData.data.attachmentId = 'att-from-other-user'
  changed.nodeData.data.attachmentName = 'other.txt'
  upload.resolve({ attachment: { id: 'att-uploaded', fileName: 'replacement.txt', status: 'ready' } })
  await uploadRun
  assert.equal(changed.getData('attachmentId'), 'att-from-other-user')
  assert.equal(uploadVm.commands.length, 0)

  const noId = node('n-no-id', {
    attachmentId: 'att-preserved', attachmentName: 'preserved.txt'
  })
  const noIdVm = makeAttachmentVm(component, api, [noId])
  api.uploadResult = async () => ({ attachment: { fileName: 'missing-id.txt', status: 'ready' } })
  noIdVm.pendingNodes = [noIdVm.captureTarget(noId, 'room-A')]
  await noIdVm.onFilePicked({
    target: { files: [{ name: 'missing-id.txt', size: 4, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(noId.getData('attachmentId'), 'att-preserved')
  assert.equal(noIdVm.commands.length, 0)

  // A silent SET_NODE_ATTACHMENT no-op must not be reported as success or
  // retried blindly; the uploaded storage object remains unattached and the
  // previous node reference stays intact.
  const noOpNode = node('n-command-noop', {
    attachmentId: 'att-noop-before',
    attachmentName: 'before-noop.txt',
    attachmentStatus: 'ready'
  })
  const noOpVm = makeAttachmentVm(component, api, [noOpNode])
  let noOpCalls = 0
  noOpVm.mindMap.execCommand = (...args) => {
    noOpCalls += 1
    noOpVm.commands.push(args)
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-noop-uploaded', fileName: 'after-noop.txt', status: 'ready' }
  })
  noOpVm.pendingNodes = [noOpVm.captureTarget(noOpNode, 'room-A')]
  await noOpVm.onFilePicked({
    target: { files: [{ name: 'after-noop.txt', size: 5, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(noOpCalls, 1)
  assert.equal(noOpNode.getData('attachmentId'), 'att-noop-before')
  assert.equal(noOpNode.getData('attachmentName'), 'before-noop.txt')
  assert.ok(noOpVm.messages.entries.some(entry =>
    entry[0] === 'error' &&
    entry[1].includes('附件已上传到服务器') &&
    entry[1].includes('原附件已保留')
  ))
  assert.ok(!noOpVm.messages.entries.some(entry => entry[0] === 'success'))

  // Older command versions may update only URL/name. Restore just those
  // fields through SET_NODE_DATA while the same live node still has its old ID.
  const legacyNode = node('n-legacy-attachment-command', {
    attachmentId: 'att-legacy-before',
    attachmentUrl: 'old-url',
    attachmentName: 'legacy-before.txt',
    attachmentMimeType: 'application/old',
    attachmentStatus: 'ready'
  })
  const legacyVm = makeAttachmentVm(component, api, [legacyNode])
  const legacyCommands = []
  legacyVm.mindMap.execCommand = (command, target, ...args) => {
    legacyCommands.push(command)
    if (command === 'SET_NODE_ATTACHMENT') {
      target.nodeData.data.attachmentUrl = args[0]
      target.nodeData.data.attachmentName = args[1]
    } else if (command === 'SET_NODE_DATA') {
      Object.assign(target.nodeData.data, args[0])
    }
  }
  api.uploadResult = async () => ({
    attachment: {
      id: 'att-legacy-uploaded',
      fileName: 'legacy-after.txt',
      mimeType: 'application/new',
      status: 'ready'
    }
  })
  legacyVm.pendingNodes = [legacyVm.captureTarget(legacyNode, 'room-A')]
  await legacyVm.onFilePicked({
    target: { files: [{ name: 'legacy-after.txt', size: 5, type: 'text/plain' }], value: 'x' }
  })
  assert.deepEqual(legacyCommands, ['SET_NODE_ATTACHMENT', 'SET_NODE_DATA'])
  assert.equal(legacyNode.getData('attachmentId'), 'att-legacy-before')
  assert.equal(legacyNode.getData('attachmentUrl'), 'old-url')
  assert.equal(legacyNode.getData('attachmentName'), 'legacy-before.txt')
  assert.equal(legacyNode.getData('attachmentMimeType'), 'application/old')
  assert.ok(legacyVm.messages.entries.some(entry =>
    entry[0] === 'error' && entry[1].includes('原附件已保留')
  ))

  // Never restore a snapshot over a different live attachment ID. If a
  // concurrent edit wins during the first command, report the state as unknown.
  const concurrentNode = node('n-concurrent-attachment-id', {
    attachmentId: 'att-concurrent-before',
    attachmentUrl: 'concurrent-old-url',
    attachmentName: 'concurrent-before.txt',
    attachmentMimeType: 'application/old'
  })
  const concurrentVm = makeAttachmentVm(component, api, [concurrentNode])
  let concurrentRollbackCalls = 0
  concurrentVm.mindMap.execCommand = (command, target, ...args) => {
    if (command === 'SET_NODE_ATTACHMENT') {
      Object.assign(target.nodeData.data, {
        attachmentUrl: args[0],
        attachmentName: args[1],
        attachmentId: 'att-from-concurrent-edit'
      })
    } else if (command === 'SET_NODE_DATA') {
      concurrentRollbackCalls += 1
      Object.assign(target.nodeData.data, args[0])
    }
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-concurrent-uploaded', fileName: 'concurrent-after.txt', status: 'ready' }
  })
  concurrentVm.pendingNodes = [concurrentVm.captureTarget(concurrentNode, 'room-A')]
  await concurrentVm.onFilePicked({
    target: { files: [{ name: 'concurrent-after.txt', size: 6, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(concurrentRollbackCalls, 0)
  assert.equal(concurrentNode.getData('attachmentId'), 'att-from-concurrent-edit')
  assert.ok(concurrentVm.messages.entries.some(entry =>
    entry[0] === 'error' && entry[1].includes('状态未能确认')
  ))

  const readonlyNode = node('n-readonly-attachment', {
    attachmentId: 'att-readonly-before', attachmentName: 'readonly-before.txt'
  })
  const readonlyVm = makeAttachmentVm(component, api, [readonlyNode])
  readonlyVm.mindMap.opt = { readonly: true }
  let readonlyCalls = 0
  readonlyVm.mindMap.execCommand = () => { readonlyCalls += 1 }
  const readonlyResult = readonlyVm.applyAttachment(
    { uid: readonlyNode.uid, node: readonlyNode },
    '',
    'readonly-after.txt',
    { attachmentId: 'att-readonly-after', attachmentMimeType: 'text/plain' }
  )
  assert.equal(readonlyCalls, 0)
  assert.equal(readonlyResult.applied, false)
  assert.equal(readonlyNode.getData('attachmentId'), 'att-readonly-before')

  // A non-transient command exception is surfaced and does not clear the old
  // reference or trigger repeated command dispatches.
  const throwingNode = node('n-command-throws', {
    attachmentId: 'att-throw-before',
    attachmentName: 'before-throw.txt',
    attachmentStatus: 'ready'
  })
  const throwingVm = makeAttachmentVm(component, api, [throwingNode])
  let throwCalls = 0
  throwingVm.mindMap.execCommand = () => {
    throwCalls += 1
    throw new Error('collaboration denied')
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-throw-uploaded', fileName: 'after-throw.txt', status: 'ready' }
  })
  throwingVm.pendingNodes = [throwingVm.captureTarget(throwingNode, 'room-A')]
  await throwingVm.onFilePicked({
    target: { files: [{ name: 'after-throw.txt', size: 6, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(throwCalls, 1)
  assert.equal(throwingNode.getData('attachmentId'), 'att-throw-before')
  assert.equal(throwingNode.getData('attachmentName'), 'before-throw.txt')
  assert.ok(throwingVm.messages.entries.some(entry =>
    entry[0] === 'error' && entry[1].includes('collaboration denied')
  ))

  // Re-resolving by UID rejects a command that wrote to a detached node
  // instance after the renderer replaced it during upload completion.
  const staleInstance = node('n-replaced-instance', {
    attachmentId: 'att-instance-old', attachmentName: 'instance-old.txt'
  })
  const currentInstance = node('n-replaced-instance', {
    attachmentId: 'att-instance-old', attachmentName: 'instance-old.txt'
  })
  const instanceVm = makeAttachmentVm(component, api, [staleInstance])
  const writeStaleInstance = instanceVm.mindMap.execCommand
  instanceVm.mindMap.execCommand = (...args) => {
    writeStaleInstance(...args)
    instanceVm.mindMap.renderer.findNodeByUid = uid =>
      uid === currentInstance.uid ? currentInstance : null
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-instance-new', fileName: 'instance-new.txt', status: 'ready' }
  })
  instanceVm.pendingNodes = [instanceVm.captureTarget(staleInstance, 'room-A')]
  await instanceVm.onFilePicked({
    target: { files: [{ name: 'instance-new.txt', size: 9, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(staleInstance.getData('attachmentId'), 'att-instance-new')
  assert.equal(currentInstance.getData('attachmentId'), 'att-instance-old')
  assert.ok(instanceVm.messages.entries.some(entry =>
    entry[0] === 'error' && entry[1].includes('节点挂载失败')
  ))
  assert.ok(!instanceVm.messages.entries.some(entry => entry[0] === 'success'))

  // A renderer may rebuild the same UID during a successful command. The
  // current instance's verified fields should still count as a successful attach.
  const rebuiltSource = node('n-rebuilt-instance-success', {
    attachmentId: 'att-rebuilt-old', attachmentName: 'rebuilt-old.txt'
  })
  const rebuiltLive = node('n-rebuilt-instance-success', {
    attachmentId: 'att-rebuilt-new',
    attachmentUrl: '',
    attachmentName: 'rebuilt-new.txt',
    attachmentMimeType: 'text/plain'
  })
  const rebuiltVm = makeAttachmentVm(component, api, [rebuiltSource])
  const writeBeforeRebuild = rebuiltVm.mindMap.execCommand
  rebuiltVm.mindMap.execCommand = (...args) => {
    writeBeforeRebuild(...args)
    Object.assign(rebuiltLive.nodeData.data, {
      attachmentUrl: args[2],
      attachmentName: args[3],
      ...(args[4] || {})
    })
    rebuiltVm.mindMap.renderer.findNodeByUid = uid =>
      uid === rebuiltLive.uid ? rebuiltLive : null
  }
  api.uploadResult = async () => ({
    attachment: {
      id: 'att-rebuilt-new',
      fileName: 'rebuilt-new.txt',
      mimeType: 'text/plain',
      status: 'ready'
    }
  })
  rebuiltVm.pendingNodes = [rebuiltVm.captureTarget(rebuiltSource, 'room-A')]
  await rebuiltVm.onFilePicked({
    target: { files: [{ name: 'rebuilt-new.txt', size: 9, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(rebuiltLive.getData('attachmentId'), 'att-rebuilt-new')
  assert.equal(rebuiltLive.getData('attachmentName'), 'rebuilt-new.txt')
  assert.ok(rebuiltVm.messages.entries.some(entry => entry[0] === 'success'))

  // Restoring a field absent on the original node uses null, which the normal
  // command path treats as deletion. An old command that writes only name must
  // not leave an orphaned name or report success.
  const initiallyEmpty = node('n-empty-legacy-attachment', {})
  const emptyVm = makeAttachmentVm(component, api, [initiallyEmpty])
  emptyVm.mindMap.execCommand = (command, target, ...args) => {
    if (command === 'SET_NODE_ATTACHMENT') {
      target.nodeData.data.attachmentName = args[1]
    } else if (command === 'SET_NODE_DATA') {
      Object.keys(args[0]).forEach(key => {
        if (args[0][key] == null) delete target.nodeData.data[key]
        else target.nodeData.data[key] = args[0][key]
      })
    }
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-empty-uploaded', fileName: 'empty-new.txt', status: 'ready' }
  })
  emptyVm.pendingNodes = [emptyVm.captureTarget(initiallyEmpty, 'room-A')]
  await emptyVm.onFilePicked({
    target: { files: [{ name: 'empty-new.txt', size: 4, type: 'text/plain' }], value: 'x' }
  })
  assert.ok(
    initiallyEmpty.getData('attachmentName') == null ||
    initiallyEmpty.getData('attachmentName') === ''
  )
  assert.ok(!emptyVm.messages.entries.some(entry => entry[0] === 'success'))

  // Only explicitly transient failures are retried, with a bounded attempt
  // count. A successful command is then verified against the live node.
  const retryNode = node('n-command-retry', {
    attachmentId: 'att-retry-before', attachmentName: 'before-retry.txt'
  })
  const retryVm = makeAttachmentVm(component, api, [retryNode])
  const runCommand = retryVm.mindMap.execCommand
  let retryCalls = 0
  retryVm.mindMap.execCommand = (...args) => {
    retryCalls += 1
    if (retryCalls === 1) {
      throw Object.assign(new Error('temporary connection reset'), {
        code: 'ETIMEDOUT'
      })
    }
    return runCommand(...args)
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-retry-uploaded', fileName: 'after-retry.txt', status: 'ready' }
  })
  retryVm.pendingNodes = [retryVm.captureTarget(retryNode, 'room-A')]
  await retryVm.onFilePicked({
    target: { files: [{ name: 'after-retry.txt', size: 7, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(retryCalls, 2)
  assert.equal(retryNode.getData('attachmentId'), 'att-retry-uploaded')
  assert.ok(retryVm.messages.entries.some(entry => entry[0] === 'success'))

  // One failed target does not hide another target's confirmed success, and
  // the failed node retains its original attachment fields.
  const multiSuccess = node('n-multi-success', {
    attachmentId: 'att-multi-old-a', attachmentName: 'old-a.txt'
  })
  const multiFailure = node('n-multi-failure', {
    attachmentId: 'att-multi-old-b', attachmentName: 'old-b.txt'
  })
  const multiVm = makeAttachmentVm(component, api, [multiSuccess, multiFailure])
  const multiCommand = multiVm.mindMap.execCommand
  multiVm.mindMap.execCommand = (...args) => {
    if (args[1].uid === 'n-multi-failure') {
      multiVm.commands.push(args)
      return
    }
    return multiCommand(...args)
  }
  api.uploadResult = async () => ({
    attachment: { id: 'att-multi-uploaded', fileName: 'shared.txt', status: 'ready' }
  })
  multiVm.pendingNodes = [
    multiVm.captureTarget(multiSuccess, 'room-A'),
    multiVm.captureTarget(multiFailure, 'room-A')
  ]
  await multiVm.onFilePicked({
    target: { files: [{ name: 'shared.txt', size: 8, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(multiSuccess.getData('attachmentId'), 'att-multi-uploaded')
  assert.equal(multiFailure.getData('attachmentId'), 'att-multi-old-b')
  assert.equal(multiFailure.getData('attachmentName'), 'old-b.txt')
  assert.ok(multiVm.messages.entries.some(entry =>
    entry[0] === 'warning' && entry[1].includes('1 个节点挂载失败')
  ))
  assert.ok(!multiVm.messages.entries.some(entry => entry[0] === 'success'))

  // A delayed poll callback after abort cannot write even if the old task
  // resolves despite AbortController cancellation.
  const polled = node('n-poll', { attachmentId: 'att-poll', attachmentName: 'poll.txt' })
  const pollVm = makeAttachmentVm(component, api, [polled])
  const wait = deferred()
  api.waitResult = () => wait.promise
  pollVm.watchAttachment(polled, 'room-A', 'att-poll')
  const pollOptions = calls.waits[calls.waits.length - 1][2]
  pollVm.abortInflight('n-poll')
  pollOptions.onUpdate({ id: 'att-poll', status: 'ready', extractedText: 'stale result' })
  wait.resolve({ id: 'att-poll', status: 'ready', extractedText: 'stale result' })
  await flush()
  assert.equal(polled.getData('attachmentExtractedText'), undefined)
  assert.equal(pollVm.commands.length, 0)

  // A successful replacement with an ID starts polling against the newly
  // attached ID; the old target ID is not used as the polling guard.
  const pending = node('n-pending-upload', {
    attachmentId: 'att-before-upload', attachmentName: 'before.txt'
  })
  const pendingVm = makeAttachmentVm(component, api, [pending])
  const pendingWait = deferred()
  api.uploadResult = async () => ({
    attachment: { id: 'att-new-upload', fileName: 'new.txt', status: 'processing' }
  })
  api.waitResult = () => pendingWait.promise
  pendingVm.pendingNodes = [pendingVm.captureTarget(pending, 'room-A')]
  await pendingVm.onFilePicked({
    target: { files: [{ name: 'new.txt', size: 10, type: 'text/plain' }], value: 'x' }
  })
  assert.equal(pending.getData('attachmentId'), 'att-new-upload')
  assert.equal(calls.waits[calls.waits.length - 1][1], 'att-new-upload')
  pendingVm.abortInflight('n-pending-upload')
  pendingWait.resolve({ id: 'att-new-upload', status: 'processing' })
  await flush()

  // Hydration GETs cannot write a result into a node after it is replaced or
  // navigation crossed a room boundary while the request was in flight.
  const hydrationNode = node('n-hydration', {
    attachmentId: 'att-hydrate', attachmentName: 'hydrate.txt',
    attachmentStatus: 'processing'
  })
  const hydrationRoot = node('root', {})
  hydrationRoot.children = [hydrationNode]
  const hydrationVm = makeAttachmentVm(component, api, [hydrationRoot, hydrationNode])
  hydrationVm.mindMap.renderer.root = hydrationRoot
  const hydration = deferred()
  api.getNodeAttachment = () => hydration.promise
  const hydrateRun = hydrationVm.hydrateExistingAttachments()
  await flush()
  hydrationVm.$route.query.room = 'room-B'
  hydrationVm.navigationEpoch += 1
  hydrationVm.$route.query.room = 'room-A'
  hydrationNode.nodeData.data.attachmentId = 'att-from-collaborator'
  hydration.resolve({ attachment: { id: 'att-hydrate', status: 'ready', extractedText: 'stale' } })
  await hydrateRun
  assert.equal(hydrationNode.getData('attachmentId'), 'att-from-collaborator')
  assert.equal(hydrationNode.getData('attachmentStatus'), 'processing')
  assert.equal(hydrationVm.commands.length, 0)

  // Context menu forwards only its explicit right-click target, not the rest
  // of the current multi-selection, and honors the existing command gate.
  const menu = loadVue(path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'))
  assert.ok(compiler.parseComponent(fs.readFileSync(
    path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8'
  )).template.content.includes('data-testid="delete-node-attachment"'))
  const selected = node('selected-first', { attachmentId: 'att-selected' })
  const rightClicked = node('right-clicked', { attachmentId: 'att-context', attachmentName: 'context.pdf' })
  const emitted = []
  const menuVm = {
    node: rightClicked,
    hasExplicitNodeContext: true,
    selectedNodes: [selected, rightClicked],
    $message: { warning() {}, success() {}, error() {} },
    $bus: { $emit: (...args) => emitted.push(args) },
    async canExecuteCommand(key) { assert.equal(key, 'SET_NODE_ATTACHMENT'); return true },
    hide() { this.hidden = true }
  }
  Object.assign(menuVm, menu.methods)
  menuVm.canExecuteCommand = async key => {
    assert.equal(key, 'SET_NODE_ATTACHMENT')
    return true
  }
  menuVm.hide = function hideMenu() { this.hidden = true }
  await menuVm.manageNodeAttachment('delete')
  assert.equal(emitted[0][1].uid, 'right-clicked')
  assert.equal(emitted[0][1].expectedAttachmentId, 'att-context')
  assert.equal(menuVm.hidden, true)
  menuVm.hasExplicitNodeContext = false
  await menuVm.manageNodeAttachment('replace')
  assert.equal(emitted.length, 1)
  menuVm.hasExplicitNodeContext = true
  menuVm.canExecuteCommand = async () => false
  await menuVm.manageNodeAttachment('delete')
  assert.equal(emitted.length, 1)

  // DELETE's URL contract carries the required expected node UID and explicit
  // SOP confirmation; polling checks AbortSignal again after a pending GET.
  const requests = []
  const getResponse = deferred()
  const attachmentApi = loadAttachmentApi((url, options) => {
    requests.push({ url, options })
    if (url.includes('format=meta')) {
      return Promise.resolve({ currentRevision: 44 })
    }
    if (options.method === 'GET') return getResponse.promise
    return Promise.resolve({ ok: true })
  })
  await attachmentApi.deleteNodeAttachment('room A', 'att/1', 'node 1', {
    confirmSopChange: true,
    baseVersion: 23
  })
  assert.match(requests[0].url, /node_uid=node%201&confirm_sop_change=true&base_version=23/)
  assert.equal(requests[0].options.method, 'DELETE')
  assert.equal(await attachmentApi.getRoomRevision('room/A'), 44)
  assert.match(requests[1].url, /room%2FA\?format=meta/)
  await assert.rejects(
    attachmentApi.deleteNodeAttachment('room-A', 'att-1'),
    /node_uid/
  )
  await assert.rejects(
    attachmentApi.deleteNodeAttachment('room-A', 'att-1', 'node-1'),
    /base_version/
  )
  const controller = new AbortController()
  let staleUpdateCalled = false
  const pollRun = attachmentApi.waitForAttachmentReady('room-A', 'att-1', {
    signal: controller.signal,
    intervalMs: 400,
    timeoutMs: 400,
    onUpdate() { staleUpdateCalled = true }
  })
  await flush()
  controller.abort()
  getResponse.resolve({ attachment: { id: 'att-1', status: 'ready' } })
  await assert.rejects(pollRun, error => error && error.name === 'AbortError')
  assert.equal(staleUpdateCalled, false)

  // 忽略错误 / 恢复错误提示 write attachmentErrorIgnored through SET_NODE_ATTACHMENT (undoable + synced).
  const failedNode = node('n-failed', {
    attachmentId: 'att-failed', attachmentName: 'bad.docx', attachmentStatus: 'failed', attachmentError: 'boom'
  })
  const ignoreVm = makeAttachmentVm(component, api, [failedNode])
  await ignoreVm.onManageAttachment({
    action: 'ignoreError', uid: 'n-failed', node: failedNode,
    expectedAttachmentId: 'att-failed', expectedAttachmentName: 'bad.docx'
  })
  assert.equal(ignoreVm.confirmation, undefined, 'ignoring needs no confirmation')
  assert.equal(ignoreVm.commands.length, 1)
  assert.equal(ignoreVm.commands[0][0], 'SET_NODE_ATTACHMENT')
  assert.deepEqual(ignoreVm.commands[0][4], { attachmentErrorIgnored: true })
  assert.equal(failedNode.getData('attachmentErrorIgnored'), true)
  assert.equal(failedNode.getData('attachmentId'), 'att-failed')
  assert.ok(ignoreVm.messages.entries.some(entry => entry[0] === 'success'))
  await ignoreVm.onManageAttachment({
    action: 'restoreError', uid: 'n-failed', node: failedNode,
    expectedAttachmentId: 'att-failed', expectedAttachmentName: 'bad.docx'
  })
  assert.equal(failedNode.getData('attachmentErrorIgnored'), false)
  // Read-only maps cannot change attachments from the error dialog.
  const ignoreReadonlyNode = node('n-ro', { attachmentId: 'att-ro', attachmentName: 'ro.docx', attachmentStatus: 'failed' })
  const ignoreReadonlyVm = makeAttachmentVm(component, api, [ignoreReadonlyNode])
  ignoreReadonlyVm.mindMap.opt = { readonly: true }
  await ignoreReadonlyVm.onManageAttachment({
    action: 'ignoreError', uid: 'n-ro', node: ignoreReadonlyNode,
    expectedAttachmentId: 'att-ro', expectedAttachmentName: 'ro.docx'
  })
  assert.equal(ignoreReadonlyVm.commands.length, 0)
  assert.equal(ignoreReadonlyNode.getData('attachmentErrorIgnored'), undefined)
  assert.ok(ignoreReadonlyVm.messages.entries.some(entry => entry[0] === 'warning'))

  // Multiple KB references preserve the existing attachment and parsed excerpts.
  let referenceReads = 0
  let referenceResult = async file => ({ ...file, extractedText: '已解析的知识库内容' })
  const knowledgeComponent = loadVue(
    path.join(__dirname, '../src/pages/Edit/components/NodeAttachment.vue'),
    { '@/utils/nodeAttachmentApi': api, '@/utils/knowledgeFiles': {
      MAX_KNOWLEDGE_FILES: 20,
      readKnowledgeFileReference: file => { referenceReads++; return referenceResult(file) }
    } }
  )
  const knowledgeNode = node('kb-node', { attachmentId: 'original', attachmentName: 'original.txt' })
  const knowledgeVm = makeAttachmentVm(knowledgeComponent, api, [knowledgeNode])
  knowledgeVm.onSelectKnowledgeFile([knowledgeNode])
  assert.equal(knowledgeVm.knowledgeVisible, true)
  await knowledgeVm.onKnowledgeFilePicked([{ id: 'kb-file', name: '原文.txt' }, { id: 'pdf', name: '说明.pdf' }])
  assert.equal(knowledgeNode.getData('knowledgeFiles').length, 2)
  assert.equal(knowledgeNode.getData('knowledgeFiles')[1].extractedText, '已解析的知识库内容')
  assert.equal(knowledgeNode.getData('attachmentId'), 'original')
  assert.equal(knowledgeVm.knowledgeVisible, false)
  assert.equal(knowledgeVm.knowledgeBusy, false)
  knowledgeVm.mindMap.opt = { readonly: true }
  knowledgeVm.onSelectKnowledgeFile([knowledgeNode])
  assert.equal(knowledgeVm.knowledgeVisible, false)
  knowledgeVm.mindMap.opt.readonly = false
  knowledgeVm.onSelectKnowledgeFile([knowledgeNode])
  const readsBeforeLimit = referenceReads
  await knowledgeVm.onKnowledgeFilePicked(Array.from({ length: 21 }, (_, id) => ({ id })))
  assert.equal(referenceReads, readsBeforeLimit, 'too many files rejected before fetching')
  const delayedRaw = deferred()
  referenceResult = () => delayedRaw.promise
  const previousRefs = knowledgeNode.getData('knowledgeFiles')
  const pendingKnowledge = knowledgeVm.onKnowledgeFilePicked([{ id: 'new-file', name: '原文.txt' }])
  knowledgeVm.$route.query.room = 'different-room'
  delayedRaw.resolve({ id: 'new-file', extractedText: 'stale' })
  await pendingKnowledge
  assert.equal(knowledgeNode.getData('knowledgeFiles'), previousRefs, 'room changes during reading must not mount knowledge files')
  assert.equal(knowledgeVm.knowledgeBusy, false)

  const picker = loadVue(path.join(__dirname, '../src/pages/Edit/components/KnowledgeFilePicker.vue'), {
    '@/utils/knowledgeFiles': { MAX_KNOWLEDGE_FILES: 20 },
    '@/features/knowledge-base/services/kbApi': {
      listFolders: async ({ parentId }) => ({ items: parentId ? [] : [{ id: 'folder-a', name: '制度' }] }),
      listFiles: async ({ folderId }) => ({ items: folderId ? [{ id: 'child', name: '制度.pdf', folderId }] : [{ id: 'root', name: '说明.txt' }, { id: 'child', folderId: 'folder-a' }] })
    }
  })
  const pickerVm = { ...picker.data(), ...picker.methods, busy: false, readonly: false,
    $set(obj, key, value) { obj[key] = value }, $delete(obj, key) { delete obj[key] } }
  Object.defineProperty(pickerVm, 'selectedFiles', { get() { return Object.values(this.selected) } })
  const roots = await pickerVm.fetchChildren('')
  assert.deepEqual(roots.map(item => item.kind), ['folder', 'file'])
  const children = await pickerVm.fetchChildren('folder-a')
  assert.equal(children[0].id, 'child')
  pickerVm.checkFile(roots[1], true); pickerVm.checkFile(children[0], true)
  assert.equal(pickerVm.selectedFiles.length, 2, 'selection persists across folders')
  assert.equal(pickerVm.selectedFiles[0].id, 'root')
  console.log('Node attachment delete/replace and knowledge file concurrency tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
