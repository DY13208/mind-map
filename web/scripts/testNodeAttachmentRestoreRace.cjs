const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('../node_modules/@babel/core')
const compiler = require('../node_modules/vue-template-compiler')

const sourcePath = path.join(
  __dirname,
  '../src/pages/Edit/components/NodeAttachment.vue'
)
const api = {
  getNodeAttachment: async (_room, id) => ({
    attachment: {
      id,
      fileName: '历史附件.pdf',
      mimeType: 'application/pdf',
      status: 'ready',
      extractedText: '历史摘要'
    }
  }),
  getRoomRevision: async () => 1,
  deleteNodeAttachment: async () => ({}),
  uploadNodeAttachment: async () => ({}),
  waitForAttachmentReady: async () => ({}),
  maxAttachmentBytes: () => 1000000,
  formatAttachmentMaxMb: () => '1'
}

function loadNodeAttachment() {
  const parsed = compiler.parseComponent(fs.readFileSync(sourcePath, 'utf8'))
  assert.ok(parsed.script, 'NodeAttachment SFC must contain a script')
  const code = babel.transformSync(parsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('../node_modules/@babel/plugin-transform-modules-commonjs')]
  }).code
  const mocks = {
    '@/utils/roomLocation': { roomFromLocation: () => 'room-a' },
    '@/utils/attachmentProgressiveText': {
      attachmentUploadNotice: () => ({ type: 'info', message: '' })
    },
    './KnowledgeFilePicker.vue': {},
    'simple-mind-map/src/utils/attachmentFileName': {
      normalizeAttachmentFileName: value => value
    },
    '@/utils/knowledgeFiles': {
      MAX_KNOWLEDGE_FILES: 10,
      readKnowledgeFileReference: async file => file
    },
    '@/utils/nodeAttachmentApi': api
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (!Object.prototype.hasOwnProperty.call(mocks, name)) {
      throw new Error(`Unexpected NodeAttachment import: ${name}`)
    }
    return mocks[name]
  }, module, module.exports)
  return module.exports.default
}

function makeNode(data) {
  const children = (data.children || []).map(makeNode)
  const node = {
    uid: data.uid,
    nodeData: { data: { ...data }, children: [] },
    children,
    getData(key) {
      return key == null ? this.nodeData.data : this.nodeData.data[key]
    }
  }
  node.nodeData.children = children.map(child => child.nodeData)
  return node
}

function makeMindMap(node) {
  const listeners = new Map()
  const map = {
    opt: { readonly: false },
    renderer: {
      root: node,
      activeNodeList: [],
      findNodeByUid(uid) {
        let found = null
        const visit = current => {
          if (!current || found) return
          if (current.getData('uid') === uid) {
            found = current
            return
          }
          current.children.forEach(visit)
        }
        visit(map.renderer.root)
        return found
      },
      reRenderNodeCheckChange() {}
    },
    on(event, callback) {
      const callbacks = listeners.get(event) || new Set()
      callbacks.add(callback)
      listeners.set(event, callbacks)
    },
    off(event, callback) {
      const callbacks = listeners.get(event)
      if (callbacks) callbacks.delete(callback)
    },
    emit(event, ...args) {
      ;[...(listeners.get(event) || [])].forEach(callback => callback(...args))
    },
    listenerCount(event) {
      return (listeners.get(event) || new Set()).size
    },
    writes: [],
    execCommand(command, target, url, name, meta) {
      map.writes.push({ command, target })
      if (command === 'SET_NODE_ATTACHMENT') {
        Object.assign(target.nodeData.data, {
          attachmentUrl: url,
          attachmentName: name,
          ...(meta || {})
        })
      }
    }
  }
  return map
}

function makeContext(component, mindMap, mount = true) {
  const messages = []
  const context = {
    ...component.data(),
    ...component.methods,
    mindMap,
    $route: { params: { roomKey: 'room-a' } },
    $refs: {},
    $bus: { $on() {}, $off() {}, $emit() {} },
    $set(object, key, value) { object[key] = value },
    $delete(object, key) { delete object[key] },
    $confirm: async () => true,
    $message(message) {
      messages.push({ type: 'info', message })
      return { close() {} }
    }
  }
  ;['success', 'warning', 'error', 'info'].forEach(type => {
    context.$message[type] = message => messages.push({ type, message })
  })
  context.messages = messages
  component.created.call(context)
  if (mount) component.mounted.call(context)
  return context
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeFile() {
  return { name: '替换附件.pdf', size: 8, type: 'application/pdf' }
}

async function pickFile(context, target) {
  return context.onFilePicked(
    { target: { files: [fakeFile()], value: '' } },
    [target]
  )
}

const component = loadNodeAttachment()

async function testRestoreInvalidatesDelayedUpload() {
  const oldNode = makeNode({
    uid: 'same-uid', text: '节点', attachmentId: 'old-id',
    attachmentName: '旧附件.pdf', attachmentUrl: '/old',
    attachmentMimeType: 'application/pdf', attachmentStatus: 'ready'
  })
  const map = makeMindMap(oldNode)
  const context = makeContext(component, map)
  const target = context.captureTarget(oldNode, 'room-a')
  context.beginOperation(target)
  const upload = deferred()
  api.uploadNodeAttachment = () => upload.promise
  const pending = pickFile(context, target)

  map.emit('before_set_data')
  const restoredNode = makeNode({ ...oldNode.getData() })
  map.renderer.root = restoredNode
  assert.notEqual(restoredNode, oldNode)
  assert.equal(restoredNode.getData('uid'), target.uid)
  assert.equal(restoredNode.getData('attachmentId'), target.expectedAttachmentId)

  upload.resolve({ attachment: {
    id: 'late-upload', fileName: '替换附件.pdf',
    mimeType: 'application/pdf', status: 'ready', extractedText: '新摘要'
  } })
  await pending

  assert.equal(map.writes.length, 0, 'late upload must not write to the restored node')
  assert.equal(restoredNode.getData('attachmentId'), 'old-id')
  assert.equal(context.messages.some(item => item.type === 'success'), false)
  component.beforeDestroy.call(context)
}

async function testNewUploadAndOrdinaryRerenderRemainUsable() {
  const firstNode = makeNode({
    uid: 'same-uid', text: '节点', attachmentId: 'old-id',
    attachmentName: '旧附件.pdf', attachmentUrl: '/old',
    attachmentMimeType: 'application/pdf', attachmentStatus: 'ready'
  })
  const map = makeMindMap(firstNode)
  const context = makeContext(component, map)

  // A renderer-only node recreation is not a before_set_data boundary.
  const target = context.captureTarget(firstNode, 'room-a')
  context.beginOperation(target)
  const upload = deferred()
  api.uploadNodeAttachment = () => upload.promise
  const pending = pickFile(context, target)
  const rerenderedNode = makeNode({ ...firstNode.getData() })
  map.renderer.root = rerenderedNode
  assert.equal(context.operationIsCurrent(target, context.operationEpochs['same-uid']), true)
  upload.resolve({ attachment: {
    id: 'rerender-upload', fileName: '替换附件.pdf',
    mimeType: 'application/pdf', status: 'ready', extractedText: '新摘要'
  } })
  await pending
  assert.equal(map.writes.length, 1)
  assert.equal(map.writes[0].target, rerenderedNode)
  assert.equal(rerenderedNode.getData('attachmentId'), 'rerender-upload')

  // After a real restore, a newly captured target remains writable.
  map.emit('before_set_data')
  const restoredNode = makeNode({ ...rerenderedNode.getData(), attachmentId: 'old-id' })
  map.renderer.root = restoredNode
  const nextTarget = context.captureTarget(restoredNode, 'room-a')
  context.beginOperation(nextTarget)
  api.uploadNodeAttachment = async () => ({ attachment: {
    id: 'post-restore-upload', fileName: '替换附件.pdf',
    mimeType: 'application/pdf', status: 'ready', extractedText: '新摘要'
  } })
  await pickFile(context, nextTarget)
  assert.equal(map.writes.length, 2)
  assert.equal(restoredNode.getData('attachmentId'), 'post-restore-upload')
  component.beforeDestroy.call(context)
}

async function testMindMapSwitchAndDestroyUnbindListeners() {
  const componentFirstNode = makeNode({ uid: 'one', text: 'one' })
  const firstMap = makeMindMap(componentFirstNode)
  const context = makeContext(component, firstMap)
  assert.equal(firstMap.listenerCount('before_set_data'), 1)

  const secondMap = makeMindMap(makeNode({ uid: 'two', text: 'two' }))
  context.mindMap = secondMap
  component.watch.mindMap.call(context, secondMap, firstMap)
  assert.equal(firstMap.listenerCount('before_set_data'), 0)
  assert.equal(firstMap.listenerCount('attach_local_files'), 0)
  assert.equal(secondMap.listenerCount('before_set_data'), 1)

  component.beforeDestroy.call(context)
  assert.equal(secondMap.listenerCount('before_set_data'), 0)
  assert.equal(secondMap.listenerCount('attach_local_files'), 0)
}

async function testStaleHydrationLoopStopsAfterRestore() {
  const firstResponse = deferred()
  const requests = []
  const previousGetNodeAttachment = api.getNodeAttachment
  api.getNodeAttachment = async (_room, id) => {
    requests.push(id)
    if (id === 'first-id') return firstResponse.promise
    return { attachment: { id, status: 'ready', extractedText: '不应覆盖' } }
  }
  const initialRoot = makeNode({
    uid: 'root', attachmentId: 'first-id', attachmentStatus: 'processing',
    children: [{ uid: 'child', attachmentId: 'second-id', attachmentStatus: 'processing' }]
  })
  const map = makeMindMap(initialRoot)
  const context = makeContext(component, map, false)
  context.bindMindMapLocalFileEvents()

  const hydration = context.hydrateExistingAttachments()
  assert.deepEqual(requests, ['first-id'])
  map.emit('before_set_data')
  const restoredRoot = makeNode({
    uid: 'root', attachmentId: 'first-id', attachmentStatus: 'ready',
    attachmentExtractedText: '恢复版本摘要',
    children: [{
      uid: 'child', attachmentId: 'second-id', attachmentStatus: 'ready',
      attachmentExtractedText: '恢复子节点摘要'
    }]
  })
  map.renderer.root = restoredRoot
  firstResponse.resolve({ attachment: {
    id: 'first-id', status: 'ready', extractedText: '恢复前迟到摘要'
  } })
  await hydration

  assert.deepEqual(requests, ['first-id'], 'old snapshot hydration must stop before querying later nodes')
  assert.equal(restoredRoot.getData('attachmentExtractedText'), '恢复版本摘要')
  assert.equal(restoredRoot.children[0].getData('attachmentExtractedText'), '恢复子节点摘要')
  api.getNodeAttachment = previousGetNodeAttachment
  component.beforeDestroy.call(context)
}

async function testStaleDetachDoesNotAbortRestoredSameIdWatcher() {
  const deleteResponse = deferred()
  const readiness = deferred()
  const previousRevision = api.getRoomRevision
  const previousDelete = api.deleteNodeAttachment
  const previousWait = api.waitForAttachmentReady
  let deleteStarted = false
  api.getRoomRevision = async () => 7
  api.deleteNodeAttachment = () => {
    deleteStarted = true
    return deleteResponse.promise
  }
  api.waitForAttachmentReady = () => readiness.promise

  const originalNode = makeNode({
    uid: 'same-uid', attachmentId: 'same-id', attachmentName: '旧附件.pdf',
    attachmentUrl: '/old', attachmentStatus: 'ready'
  })
  const map = makeMindMap(originalNode)
  const context = makeContext(component, map, false)
  context.bindMindMapLocalFileEvents()
  const deleting = context.onManageAttachment({ action: 'delete', node: originalNode })
  for (let attempt = 0; attempt < 10 && !deleteStarted; attempt += 1) {
    await Promise.resolve()
  }
  assert.equal(deleteStarted, true, 'delete request should be pending before restore')

  map.emit('before_set_data')
  const restoredNode = makeNode({ ...originalNode.getData() })
  map.renderer.root = restoredNode
  context.watchAttachment(restoredNode, 'room-a', 'same-id')
  const restoredWatcher = context.inflight['same-uid']
  assert.ok(restoredWatcher, 'restored attachment watcher should be registered')

  deleteResponse.resolve({ already_detached: true })
  await deleting
  assert.equal(context.inflight['same-uid'], restoredWatcher, 'old detach response must not abort the restored same-ID watcher')
  assert.equal(context.messages.some(item => item.type === 'success'), false)

  component.beforeDestroy.call(context)
  api.getRoomRevision = previousRevision
  api.deleteNodeAttachment = previousDelete
  api.waitForAttachmentReady = previousWait
}

async function main() {
  await testRestoreInvalidatesDelayedUpload()
  await testNewUploadAndOrdinaryRerenderRemainUsable()
  await testMindMapSwitchAndDestroyUnbindListeners()
  await testStaleHydrationLoopStopsAfterRestore()
  await testStaleDetachDoesNotAbortRestoredSameIdWatcher()
  console.log('PASS NodeAttachment restore race: delayed upload invalidation, same-ID restore ABA, ordinary node recreation, post-restore upload, stale multi-node hydration, stale detach response, map switch and destroy cleanup')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
