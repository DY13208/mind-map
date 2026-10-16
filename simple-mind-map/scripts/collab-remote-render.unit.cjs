const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRemoteRenderScheduler } = require('../src/utils/remoteRenderScheduler')

function fakeClock() {
  let nextId = 1
  let now = 100
  const frames = new Map()
  const timers = new Map()
  return {
    frames,
    timers,
    now: () => now,
    requestFrame(callback) {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelFrame(id) { frames.delete(id) },
    setTimeout(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    fireFrame() {
      const [id, callback] = frames.entries().next().value || []
      if (id == null) return false
      frames.delete(id)
      now += 16
      callback()
      return true
    },
    fireTimer(id) {
      const timer = timers.get(id)
      if (!timer) return false
      timers.delete(id)
      now += timer.delay
      timer.callback()
      return true
    }
  }
}

function method(source, start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing source method: ${start}`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `missing source boundary: ${end}`)
  return source.slice(from, to).trim()
}

function sourceMethods(clock = null) {
  const renderSource = fs.readFileSync(
    path.join(__dirname, '../src/core/render/Render.js'), 'utf8'
  )
  const cooperateSource = fs.readFileSync(
    path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8'
  )
  const renderMethods = vm.runInNewContext(`({${[
    method(renderSource, '  render(callback, source) {', '\n  beginRemoteRenderBatch()'),
    method(renderSource, '  beginRemoteRenderBatch() {', '\n  endRemoteRenderBatch()'),
    method(renderSource, '  endRemoteRenderBatch() {', '\n  requestRemoteRender('),
    method(renderSource, '  requestRemoteRender(', '\n  // 更新的渲染')
  ].join(',')}})`, {
    setTimeout: clock ? clock.setTimeout : setTimeout,
    clearTimeout: clock ? clock.clearTimeout : clearTimeout
  })
  const cooperateMethods = vm.runInNewContext(`({${method(
    cooperateSource,
    '  getV2RevisionScope() {',
    '\n  isV2RevisionScopeCurrent('
  )}, ${method(
    cooperateSource,
    '  isV2RevisionScopeCurrent(scope) {',
    '\n  clearV2RevisionCompletions('
  )}, ${method(
    cooperateSource,
    '  clearV2RevisionCompletions() {',
    '\n  async replayV2AckCompletion('
  )}, ${method(
    cooperateSource,
    '  async replayV2AckCompletion(completion, scope, context) {',
    '\n  // Must be called from the serialized V2 apply/reconcile task'
  )}, ${method(
    cooperateSource,
    '  async markV2RevisionComplete(version, scope = this.getV2RevisionScope(), completion = null, context = null) {',
    '\n  // On a successful local ACK'
  )}, ${method(
    cooperateSource,
    '  cancelV2RemoteApply() {',
    '\n  isV2RemoteApplyScopeCurrent('
  )}, ${method(
    cooperateSource,
    '  isV2RemoteApplyScopeCurrent(context) {',
    '\n  isV2RemoteApplyCurrent('
  )}, ${method(
    cooperateSource,
    '  isV2RemoteApplyCurrent(context) {',
    '\n  rebaseV2RemoteApplyContext('
  )}, ${method(
    cooperateSource,
    '  rebaseV2RemoteApplyContext(context) {',
    '\n  waitV2RendererReady('
  )}, ${method(
    cooperateSource,
    '  waitV2RendererReady(context) {',
    '\n  async applyV2RemoteOperation('
  )}, ${method(
    cooperateSource,
    '  async applyV2RemoteOperation(op, meta = {}) {',
    '\n  async applyV2RemoteOperationNow('
  )}, ${method(
    cooperateSource,
    '  async applyV2RemoteOperationNow(op, meta = {}, context) {',
    '\n  async applyV2RemoteBatchEvents('
  )}, ${method(
    cooperateSource,
    '  async applyV2RemoteBatchEvents(op, meta = {}, events = [], context) {',
    '\n  remoteTargetRendered('
  )}, ${method(
    cooperateSource,
    '  requestRemoteApplyRender(uids, callback, source = \'remote apply\') {',
    '\n  applyV2PayloadInsert('
  )}})`, {
    v2Trace() {},
    collabTrace() {},
    payloadParentUid(payload = {}) {
      return payload.parentUid || payload.parent_uid || payload.parent || ''
    },
    applyCollabEvent(data) { return data }
  })
  return { renderMethods, cooperateMethods }
}

function loadSourceStore() {
  let source = fs.readFileSync(
    path.join(__dirname, '../src/utils/collaborationStore.js'), 'utf8'
  )
  source = source
    .replace(/^import \{ createOperationId \} from '.\/operationId'\s*/m, '')
    .replace('export function createCollaborationStore', 'function createCollaborationStore')
    .replace('export default createCollaborationStore', 'module.exports = { createCollaborationStore }')
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    createOperationId: () => 'generated-operation',
    setTimeout,
    clearTimeout,
    Date,
    Math
  }, { filename: 'src/utils/collaborationStore.js' })
  return module.exports.createCollaborationStore
}

async function testRenderScheduler() {
  const clock = fakeClock()
  const flushes = []
  const scheduler = createRemoteRenderScheduler({
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    maxWaitMs: 50,
    onFlush: payload => flushes.push(payload)
  })
  scheduler.schedule('a')
  scheduler.schedule(['a', 'b'])
  assert.equal(clock.frames.size, 1)
  assert.equal(clock.timers.size, 1)
  assert.equal(clock.timers.values().next().value.delay, 50)
  assert.equal(clock.fireFrame(), true)
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0].dirtyUids, ['a', 'b'])
  assert.equal(flushes[0].reason, 'frame')
  assert.equal(scheduler.isPending(), false)

  const backgroundClock = fakeClock()
  const backgroundFlushes = []
  const background = createRemoteRenderScheduler({
    requestFrame: backgroundClock.requestFrame,
    cancelFrame: backgroundClock.cancelFrame,
    setTimeout: backgroundClock.setTimeout,
    clearTimeout: backgroundClock.clearTimeout,
    now: backgroundClock.now,
    isBackground: () => true,
    maxWaitMs: 50,
    onFlush: payload => backgroundFlushes.push(payload)
  })
  background.schedule('hidden')
  assert.equal(backgroundClock.frames.size, 0)
  assert.equal(backgroundClock.timers.values().next().value.delay, 50)
  const backgroundTimer = backgroundClock.timers.keys().next().value
  backgroundClock.fireTimer(backgroundTimer)
  assert.equal(backgroundFlushes[0].reason, 'background-timeout')
  assert.deepEqual(backgroundFlushes[0].dirtyUids, ['hidden'])

  const maxWaitClock = fakeClock()
  const maxWaitFlushes = []
  const maxWait = createRemoteRenderScheduler({
    requestFrame: maxWaitClock.requestFrame,
    cancelFrame: maxWaitClock.cancelFrame,
    setTimeout: maxWaitClock.setTimeout,
    clearTimeout: maxWaitClock.clearTimeout,
    now: maxWaitClock.now,
    maxWaitMs: 50,
    onFlush: payload => maxWaitFlushes.push(payload)
  })
  maxWait.schedule('slow-frame')
  const maxWaitTimer = maxWaitClock.timers.keys().next().value
  maxWaitClock.fireTimer(maxWaitTimer)
  assert.equal(maxWaitFlushes[0].reason, 'max-wait')

  const renderClock = fakeClock()
  const { renderMethods } = sourceMethods(renderClock)
  let renderCount = 0
  let flushed
  const context = {
    ...renderMethods,
    _remoteRenderBatchDepth: 0,
    _remoteRenderPending: false,
    _remoteRenderDirtyUids: new Set(),
    renderCallbackList: [],
    renderSourceList: [],
    _render() { renderCount += 1 },
    addRenderParams(callback, source) {
      if (callback && !this.renderCallbackList.includes(callback)) this.renderCallbackList.push(callback)
      if (source && !this.renderSourceList.includes(source)) this.renderSourceList.push(source)
    }
  }
  context._remoteRenderScheduler = createRemoteRenderScheduler({
    requestFrame: renderClock.requestFrame,
    cancelFrame: renderClock.cancelFrame,
    setTimeout: renderClock.setTimeout,
    clearTimeout: renderClock.clearTimeout,
    now: renderClock.now,
    maxWaitMs: 50,
    onFlush: payload => {
      flushed = payload
      context._remoteRenderPending = false
      context._remoteRenderDirtyUids.clear()
      context._render()
    }
  })
  const callbackA = () => {}
  const callbackB = () => {}
  context.beginRemoteRenderBatch()
  context.requestRemoteRender('a', callbackA, 'remote')
  context.requestRemoteRender(Array.from(new Set(['a', 'b'])), callbackB)
  assert.equal(renderClock.frames.size, 0)
  context.endRemoteRenderBatch()
  assert.equal(renderClock.frames.size, 1)
  renderClock.fireFrame()
  assert.equal(renderCount, 1)
  assert.deepEqual(flushed.dirtyUids, ['a', 'b'])
  assert.equal(context.renderCallbackList.length, 2)
}

async function testCollaborationStoreCommit() {
  const createCollaborationStore = loadSourceStore()
  const store = createCollaborationStore({ maxBuffer: 50 })
  store.reset('room', 20)
  const first = { version: 21, type: 'first' }
  const second = { version: 22, type: 'second' }
  store.enqueueRemoteEvent(second)
  store.enqueueRemoteEvent(first)
  const ready = store.peekReadyEvents()
  assert.deepEqual(Array.from(ready, item => item.version), [21, 22])
  assert.equal(store.getSnapshot().lastAppliedVersion, 20)
  assert.equal(store.commitReadyEvents([second]).committed, false)
  assert.equal(store.getSnapshot().lastAppliedVersion, 20)
  const committed = store.commitReadyEvents(ready)
  assert.equal(committed.committed, true)
  assert.equal(committed.version, 22)

  store.reset('overflow', 0)
  for (let version = 1; version <= 51; version += 1) {
    store.enqueueRemoteEvent({ version, type: 'event' })
  }
  const replayed = store.enqueueRemoteEvent({ version: 1, type: 'replayed' })
  assert.equal(replayed.accepted, true)
  assert.equal(replayed.version, 1)

  store.reset('ack-gap', 20)
  store.trackPending({ operationId: 'local-op-22', type: 'node.updated' })
  const futureAck = store.confirmPending('local-op-22', 22)
  assert.equal(futureAck.confirmed, true)
  assert.equal(futureAck.version, 20)
  assert.equal(futureAck.recoveryVersion, 22)
  assert.deepEqual(
    Array.from(
      store.getSnapshot().pendingConfirmations,
      item => `${item.version}:${item.operationId}`
    ),
    ['22:local-op-22']
  )
  const event22 = { version: 22, type: 'local-op-22' }
  const event21 = { version: 21, type: 'remote-op-21' }
  assert.equal(store.enqueueRemoteEvent(event22).accepted, true)
  assert.equal(store.enqueueRemoteEvent(event21).accepted, true)
  assert.deepEqual(
    Array.from(store.peekReadyEvents(), event => event.version),
    [21, 22]
  )
  const recoveredPrefix = store.commitReadyEvents([event21])
  assert.equal(recoveredPrefix.committed, true)
  assert.equal(recoveredPrefix.version, 21)
  assert.equal(store.getSnapshot().pendingConfirmations.length, 1)
  store.setLastAppliedVersion(22)
  assert.equal(store.getSnapshot().lastAppliedVersion, 22)
  assert.equal(store.getSnapshot().pendingConfirmations.length, 0)
  assert.equal(store.getSnapshot().bufferedVersions.length, 0)
  assert.equal(
    store.enqueueRemoteEvent({ version: 22, type: 'duplicate-local-op' }).accepted,
    false
  )
}

async function testLocalRenderDuringRemoteApply() {
  const clock = fakeClock()
  const { renderMethods, cooperateMethods } = sourceMethods(clock)
  const flushes = []
  let renderCount = 0
  let releaseRemote
  const remoteCallback = () => {}
  const context = {
    ...renderMethods,
    ...cooperateMethods,
    _remoteRenderBatchDepth: 0,
    _remoteRenderPending: false,
    _remoteRenderDirtyUids: new Set(),
    renderCallbackList: [],
    renderSourceList: [],
    lastAppliedVersion: 20,
    mindMap: { renderer: null },
    collabStore: { setLastAppliedVersion(version) { this.version = version } },
    _render() { renderCount += 1 },
    addRenderParams(callback, source) {
      if (callback && !this.renderCallbackList.includes(callback)) this.renderCallbackList.push(callback)
      if (source && !this.renderSourceList.includes(source)) this.renderSourceList.push(source)
    },
    scheduleRemoteRecover() {},
    applyV2RemoteOperationNow() {
      return new Promise(resolve => {
        releaseRemote = () => {
          context.requestRemoteRender('remote-uid', remoteCallback, 'remote apply')
          resolve(true)
        }
      })
    }
  }
  context.mindMap.renderer = context
  context._remoteRenderScheduler = createRemoteRenderScheduler({
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    maxWaitMs: 50,
    onFlush: payload => {
      flushes.push(payload)
      context._remoteRenderPending = false
      context._remoteRenderDirtyUids.clear()
      context._render()
    }
  })

  const pendingRemote = cooperateMethods.applyV2RemoteOperation.call(context, {
    serverRevision: 21
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context._remoteRenderBatchDepth, 1)
  assert.equal(typeof releaseRemote, 'function')

  const localCallback = () => {}
  context.render(localCallback)
  const localRenderTimer = context.renderTimer
  assert.ok(clock.timers.has(localRenderTimer))
  assert.equal(clock.frames.size, 0)
  assert.equal(clock.fireTimer(localRenderTimer), true)
  assert.equal(renderCount, 1, '本地渲染必须在远端 await 未完成时执行')
  assert.equal(context._remoteRenderBatchDepth, 1)

  releaseRemote()
  assert.equal(await pendingRemote, true)
  assert.equal(context._remoteRenderBatchDepth, 0)
  assert.equal(context.lastAppliedVersion, 21)
  assert.equal(clock.frames.size, 1, '远端渲染仍应在批次结束后合并调度')
  assert.equal(clock.fireFrame(), true)
  assert.equal(renderCount, 2)
  assert.deepEqual(flushes[0].dirtyUids, ['remote-uid'])
  assert.ok(context.renderCallbackList.includes(localCallback))
  assert.ok(context.renderCallbackList.includes(remoteCallback))

  const routedCalls = []
  const routeCallback = () => {}
  cooperateMethods.requestRemoteApplyRender.call({
    mindMap: { renderer: {
      requestRemoteRender(...args) { routedCalls.push(args) }
    } }
  }, ['theme'], routeCallback, 'changeLayout')
  assert.equal(routedCalls.length, 1)
  assert.deepEqual(routedCalls[0], [['theme'], routeCallback, 'changeLayout'])
}

async function testBatchDispatchAndWatermark() {
  const { cooperateMethods } = sourceMethods()
  const originalDispatch = cooperateMethods.applyV2RemoteOperationNow
  const calls = []
  const context = {
    ...cooperateMethods,
    httpRoomKey: '',
    collabV2Adapter: null,
    currentData: null,
    applyV2RemoteOperationNow: async (op, meta) => {
      calls.push({ uid: op.event.payload.uid, meta })
      await Promise.resolve()
      return true
    }
  }
  const envelope = {
    serverRevision: 8,
    payload: {
      ops: [{ type: 'node.deleted', payload: { uid: 'failed-original-op' } }],
      events: [
        { type: 'node.updated', payload: { uid: 'same', patch: { text: 'one' } } },
        { type: 'node.moved', payload: { uid: 'same', parentUid: 'root', index: 0 } },
        { type: 'node.deleted', payload: { uid: 'other' } }
      ]
    },
    type: 'batch.applied'
  }
  const tree = {}
  context.mindMap = {
    _destroyed: false,
    renderer: {
      renderTree: tree,
      root: { nodeData: tree },
      isRendering: false,
      renderTimer: null,
      hasWaitRendering: false
    }
  }
  const dispatchContext = {
    epoch: 0,
    tree,
    room: context.httpRoomKey,
    adapter: context.collabV2Adapter
  }
  const dispatched = await originalDispatch.call(context, envelope, {}, dispatchContext)
  assert.equal(dispatched, true)
  assert.deepEqual(calls.map(item => item.uid), ['same', 'same', 'other'])
  assert.ok(calls.every(item => item.meta.deferFallback === true))

  const wrapper = cooperateMethods.applyV2RemoteOperation
  const batchCalls = { begin: 0, end: 0, recover: [] }
  const watermarkContext = {
    ...cooperateMethods,
    mindMap: { renderer: {
      beginRemoteRenderBatch() { batchCalls.begin += 1 },
      endRemoteRenderBatch() { batchCalls.end += 1 }
    } },
    lastAppliedVersion: 10,
    collabStore: { versions: [], setLastAppliedVersion(version) { this.versions.push(version) } },
    scheduleRemoteRecover(version) { batchCalls.recover.push(version) },
    applyV2RemoteOperationNow: async () => false
  }
  assert.equal(await wrapper.call(watermarkContext, { serverRevision: 11 }), false)
  assert.equal(watermarkContext.lastAppliedVersion, 10)
  assert.deepEqual(watermarkContext.collabStore.versions, [])
  watermarkContext.applyV2RemoteOperationNow = async () => true
  assert.equal(await wrapper.call(watermarkContext, { serverRevision: 11 }), true)
  assert.equal(watermarkContext.lastAppliedVersion, 11)
  assert.deepEqual(watermarkContext.collabStore.versions, [11])
  assert.equal(await wrapper.call(watermarkContext, { serverRevision: 13 }), true)
  assert.equal(watermarkContext.lastAppliedVersion, 11)
  assert.equal(watermarkContext._v2RevisionCompletions.has(13), true)
  assert.deepEqual(batchCalls.recover, [])
  assert.equal(await wrapper.call(watermarkContext, { serverRevision: 12 }), true)
  assert.equal(watermarkContext.lastAppliedVersion, 13)
  assert.deepEqual(watermarkContext.collabStore.versions, [11, 12, 13], 'each contiguous completion publishes its applied prefix')
  assert.deepEqual(batchCalls.recover, [])
  assert.equal(batchCalls.begin, 4)
  assert.equal(batchCalls.end, 4)

  let reconcileCalls = 0
  let appliedBeforeFailure = false
  const failureContext = {
    ...context,
    applyV2RemoteOperationNow: async () => {
      if (!appliedBeforeFailure) {
        appliedBeforeFailure = true
        return true
      }
      return false
    },
    deferUnloadedRemoteEvents: () => false,
    markRemoteDirty() {},
    syncHttpRemoteOperations(events) {
      reconcileCalls += 1
      assert.deepEqual(Array.from(events, item => item.event.payload.uid), ['same', 'other'])
      return true
    }
  }
  assert.equal(await cooperateMethods.applyV2RemoteBatchEvents.call(failureContext, envelope, {}, envelope.payload.events), true)
  assert.equal(reconcileCalls, 1)
}

async function main() {
  await testRenderScheduler()
  await testCollaborationStoreCommit()
  await testLocalRenderDuringRemoteApply()
  await testBatchDispatchAndWatermark()
  console.log('collaboration render, batch ordering, and applied-watermark checks passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
