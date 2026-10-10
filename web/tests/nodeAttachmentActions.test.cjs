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

  console.log('Node attachment delete/replace concurrency tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
