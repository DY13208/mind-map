const assert = require('assert')
const { fromCommitted } = require('../bin/collabV2/protocol')
const { createOperationEventBridge } = require('../bin/collabV2/operationEventBridge')
const {
  createCollaborationAdapter,
  ackRevisionDisposition
} = require('../bin/collabV2/adapter')

const PRIVATE_REQUEST_SUMMARY = 'private-mcp-request-summary-test-sentinel'

function createRootSnapshot() {
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Root' },
      children: []
    }
  }
}

function createGeneratedInsertFixture() {
  const requestPayload = {
    parent: 'root',
    index: 0,
    text: 'requested node text',
    position: 'client-position-is-not-authoritative'
  }
  const uid = 'server-generated-node-23'
  const canonicalPayload = {
    ...requestPayload,
    uid,
    parentUid: 'root',
    data: { uid, text: 'requested node text', expand: true, __fv: { text: 23 } },
    text: 'requested node text',
    position: 'a1',
    index: 0
  }
  const committed = {
    operationId: 'committed-op-23',
    roomKey: 'mcp-event-bridge-test',
    actorId: 'mcp-agent',
    clientId: 'mcp-test-client',
    client_seq: 9,
    version: 23,
    operationType: 'node.insert',
    payload: {
      ...requestPayload,
      requestDigest: PRIVATE_REQUEST_SUMMARY,
      __mcpRequest: { v: 1, principalId: 'private-principal', digest: PRIVATE_REQUEST_SUMMARY }
    },
    event: {
      type: 'node.inserted',
      payload: canonicalPayload,
      affectedUids: ['root', uid]
    }
  }
  return { committed, canonicalPayload }
}

function makeCommitted(version, eventType = 'map.updated', payload = {}, roomKey = 'bridge-room') {
  return {
    operationId: `op-${version}`,
    roomKey,
    actorId: 'test-agent',
    clientId: 'browser-client',
    client_seq: version,
    version,
    operationType: eventType,
    payload,
    event: { type: eventType, payload }
  }
}

function createFakeBus() {
  const listeners = new Set()
  return {
    name: 'fake',
    async start() {},
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async publish(event) {
      await Promise.all(Array.from(listeners, listener => listener(event)))
    },
    status() {
      return { name: 'fake', ok: true }
    },
    async close() {
      listeners.clear()
    }
  }
}

function createBridgeFixture(options = {}) {
  const bus = createFakeBus()
  const rows = []
  const emissions = []
  const invalidations = []
  const activeRooms = new Set()
  let headVersion = Number(options.headVersion || 0)
  let activeQueries = 0
  let maxActiveQueries = 0
  let headQueryCount = 0
  let operationQueryCount = 0
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          emissions.push({ room, event, payload })
        }
      }
    }
  }
  const bridge = createOperationEventBridge({
    bus,
    io,
    intervalMs: options.intervalMs || 10000,
    pageSize: options.pageSize || 2,
    getActiveRoomKeys: () => Array.from(activeRooms),
    listActiveRoomHeads: async roomKeys => {
      headQueryCount += 1
      if (typeof options.beforeReadHeads === 'function') await options.beforeReadHeads(roomKeys)
      return roomKeys.map(roomKey => ({ roomKey, headVersion }))
    },
    listRoomOperationsContiguous: async (roomKey, afterVersion, query = {}) => {
      operationQueryCount += 1
      activeQueries += 1
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      try {
        if (typeof options.beforeReadOperations === 'function') {
          await options.beforeReadOperations({ roomKey, afterVersion, query, operationQueryCount })
        }
        if (options.readDelayMs) {
          await new Promise(resolve => setTimeout(resolve, options.readDelayMs))
        }
      } finally {
        activeQueries -= 1
      }
      const head = Number(query.headVersion == null ? headVersion : query.headVersion)
      const available = rows
        .filter(row => row.roomKey === roomKey && row.version > afterVersion && row.version <= head)
        .sort((a, b) => a.version - b.version)
      let expected = afterVersion + 1
      for (const row of available) {
        if (row.version !== expected) {
          return {
            ok: false,
            reload: true,
            code: 'RESNAPSHOT_REQUIRED',
            currentRevision: head,
            completeFromRevision: head,
            missingVersion: expected,
            reason: 'VERSION_GAP',
            operations: []
          }
        }
        expected += 1
      }
      if (expected <= head) {
        return {
          ok: false,
          reload: true,
          code: 'RESNAPSHOT_REQUIRED',
          currentRevision: head,
          completeFromRevision: head,
          missingVersion: expected,
          reason: 'VERSION_GAP',
          operations: []
        }
      }
      const page = available.slice(0, Number(query.limit || options.pageSize || 2))
      const last = page.length ? page[page.length - 1].version : afterVersion
      return {
        ok: true,
        reload: false,
        roomKey,
        afterVersion,
        fromVersion: afterVersion,
        toVersion: last,
        currentRevision: head,
        completeFromRevision: afterVersion,
        operations: page,
        hasMore: last < head
      }
    },
    invalidateRoomState: async (roomKey, version) => {
      invalidations.push({ roomKey, version })
    }
  })
  return {
    bus,
    bridge,
    rows,
    emissions,
    invalidations,
    activeRooms,
    setHead: value => { headVersion = Number(value) },
    getMaxActiveQueries: () => maxActiveQueries,
    getHeadQueryCount: () => headQueryCount,
    getOperationQueryCount: () => operationQueryCount
  }
}

async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'timed out waiting for asynchronous bridge state')
}

async function testFromCommittedUsesCanonicalEventPayload() {
  const { committed, canonicalPayload } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)

  assert.strictEqual(operation.type, 'node.inserted')
  assert.strictEqual(operation.payload.uid, canonicalPayload.uid)
  assert.strictEqual(operation.payload.parentUid, 'root')
  assert.strictEqual(operation.payload.position, canonicalPayload.position)
  assert.deepStrictEqual(operation.payload.data, canonicalPayload.data)
  assert.strictEqual(operation.clientSeq, 9)
}

async function testPrivateRequestSummaryDoesNotReachClientPatch() {
  const { committed } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)
  assert.ok(
    !JSON.stringify(operation).includes(PRIVATE_REQUEST_SUMMARY),
    'private request summary must not enter the client operation/patch'
  )
  assert.ok(!operation.payload.__mcpRequest)
  assert.ok(!operation.event.payload.__mcpRequest)
  assert.ok(!operation.payload.requestDigest)
}

async function testGeneratedInsertAppliesThroughClientPureReducer() {
  const { committed, canonicalPayload } = createGeneratedInsertFixture()
  const operation = fromCommitted(committed)
  const { applyCollabEvent } = await import('../src/plugins/cooperateRecovery.js')
  const clientSnapshot = createRootSnapshot()

  const next = applyCollabEvent(clientSnapshot, operation)
  assert.deepStrictEqual(next.root.children, [canonicalPayload.uid])
  assert.strictEqual(next[canonicalPayload.uid].data.uid, canonicalPayload.uid)
  assert.deepStrictEqual(next[canonicalPayload.uid].data, canonicalPayload.data)
  assert.strictEqual(next[canonicalPayload.uid].position, canonicalPayload.position)
}

async function testBridgeDrainsVersionsInOrderAndDeduplicatesWakeups() {
  const fixture = createBridgeFixture({ pageSize: 2, readDelayMs: 20 })
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  fixture.activeRooms.add('bridge-room')
  fixture.rows.push(makeCommitted(1), makeCommitted(2), makeCommitted(3))
  fixture.setHead(3)

  await Promise.all([
    fixture.bus.publish({ mapId: 'bridge-room', version: 3, operationId: 'wake-3' }),
    fixture.bus.publish({ mapId: 'bridge-room', version: 2, operationId: 'wake-2' }),
    fixture.bus.publish({ mapId: 'bridge-room', version: 2, operationId: 'wake-2' })
  ])
  await waitFor(() => fixture.emissions.filter(row => row.event === 'op:event').length === 3)

  const sent = fixture.emissions
    .filter(row => row.event === 'op:event')
    .map(row => row.payload.serverRevision)
  assert.deepStrictEqual(sent, [1, 2, 3])
  assert.strictEqual(fixture.getMaxActiveQueries(), 1)
  assert.strictEqual(fixture.invalidations.length, 3)
  const status = fixture.bridge.status()
  assert.strictEqual(status.duplicateNotifications, 1)
  assert.strictEqual(status.skippedDuplicateWakeups, 1)
  assert.strictEqual(status.notifications, 2)
  assert.strictEqual(status.duplicateRatio, 1 / 3)
  assert.ok(!JSON.stringify(status).includes('bridge-room'))
  await fixture.bridge.stop()
}

async function testConcurrentDuplicateWakeupDoesNotStartAnotherDrain() {
  let releaseRead
  let markReadStarted
  const readGate = new Promise(resolve => { releaseRead = resolve })
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  const fixture = createBridgeFixture({
    beforeReadOperations: async () => {
      markReadStarted()
      await readGate
    }
  })
  fixture.activeRooms.add('bridge-room')
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  const emptyDrainsBeforeWakeup = fixture.bridge.status().emptyDrains
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)

  const wakeup = { mapId: 'bridge-room', version: 1, operationId: 'same-op' }
  await fixture.bus.publish(wakeup)
  await readStarted
  const queriesAtFirstRead = fixture.getHeadQueryCount() + fixture.getOperationQueryCount()
  await fixture.bus.publish(wakeup)
  assert.strictEqual(
    fixture.getHeadQueryCount() + fixture.getOperationQueryCount(),
    queriesAtFirstRead,
    'a concurrent duplicate should not add a head or operation query'
  )

  releaseRead()
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  assert.strictEqual(fixture.getOperationQueryCount(), 1)
  assert.strictEqual(fixture.bridge.status().emptyDrains, emptyDrainsBeforeWakeup)
  await fixture.bridge.stop()
}

async function testPendingWakeupLimitBypassesCacheWithoutDroppingNotifications() {
  let releaseRead
  let markReadStarted
  const readGate = new Promise(resolve => { releaseRead = resolve })
  const readStarted = new Promise(resolve => { markReadStarted = resolve })
  const fixture = createBridgeFixture({
    beforeReadOperations: async ({ operationQueryCount }) => {
      if (operationQueryCount !== 1) return
      markReadStarted()
      await readGate
    }
  })
  fixture.activeRooms.add('bridge-room')
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  const emptyDrainsBefore = fixture.bridge.status().emptyDrains
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)

  await fixture.bus.publish({ mapId: 'bridge-room', version: 1, operationId: 'overflow-0' })
  await readStarted
  for (let index = 1; index < 2048; index += 1) {
    await fixture.bus.publish({
      mapId: 'bridge-room',
      version: index + 1,
      operationId: `overflow-${index}`
    })
  }

  const overflow = { mapId: 'bridge-room', version: 2049, operationId: 'overflow-last' }
  await fixture.bus.publish(overflow)
  await fixture.bus.publish(overflow)
  const saturatedStatus = fixture.bridge.status()
  assert.strictEqual(saturatedStatus.notifications, 2050)
  assert.strictEqual(saturatedStatus.duplicateNotifications, 0)
  assert.strictEqual(saturatedStatus.skippedDuplicateWakeups, 0)
  assert.strictEqual(saturatedStatus.queueLength, 1)

  releaseRead()
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  assert.strictEqual(fixture.getOperationQueryCount(), 1)
  assert.strictEqual(fixture.bridge.status().emptyDrains, emptyDrainsBefore + 1)
  await fixture.bridge.stop()
}

async function testFailedDrainAllowsSameWakeupToRetry() {
  let attempts = 0
  const fixture = createBridgeFixture({
    beforeReadOperations: async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('temporary operation read failure'), { code: 'TEMP_READ' })
      }
    }
  })
  fixture.activeRooms.add('bridge-room')
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)

  const wakeup = { mapId: 'bridge-room', version: 1, operationId: 'retry-op' }
  await fixture.bus.publish(wakeup)
  await waitFor(() => fixture.bridge.status().failedDrains === 1)
  assert.strictEqual(fixture.bridge.status().pendingDrains, 0)

  await fixture.bus.publish(wakeup)
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  const status = fixture.bridge.status()
  assert.strictEqual(attempts, 2)
  assert.strictEqual(status.failedDrains, 1)
  assert.strictEqual(status.notifications, 2)
  assert.strictEqual(status.duplicateNotifications, 0)
  assert.strictEqual(status.duplicateRatio, 0)
  await fixture.bridge.stop()
}

async function testDifferentVersionAndUnsignedWakeupsAreNotDropped() {
  const fixture = createBridgeFixture({ readDelayMs: 20 })
  fixture.activeRooms.add('bridge-room')
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  const emptyDrainsBeforeWakeups = fixture.bridge.status().emptyDrains
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)

  await Promise.all([
    fixture.bus.publish({ mapId: 'bridge-room', version: 1, operationId: 'same-op' }),
    fixture.bus.publish({ mapId: 'bridge-room', version: 2, operationId: 'same-op' }),
    fixture.bus.publish({ mapId: 'bridge-room' })
  ])
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)

  const status = fixture.bridge.status()
  assert.strictEqual(status.notifications, 3)
  assert.strictEqual(status.duplicateNotifications, 0)
  assert.strictEqual(status.skippedDuplicateWakeups, 0)
  assert.strictEqual(
    status.emptyDrains,
    emptyDrainsBeforeWakeups + 1,
    'different and unsigned notifications must schedule a follow-up check'
  )
  assert.strictEqual(status.duplicateRatio, 0)
  await fixture.bridge.stop()
}

async function testConcurrentDrainsKeepEmptyCountsRoomLocal() {
  let releaseBridgeRoomHead
  let markBridgeRoomHeadRead
  let markOtherRoomOperationRead
  const bridgeRoomHeadGate = new Promise(resolve => { releaseBridgeRoomHead = resolve })
  const bridgeRoomHeadRead = new Promise(resolve => { markBridgeRoomHeadRead = resolve })
  const otherRoomOperationRead = new Promise(resolve => { markOtherRoomOperationRead = resolve })
  const fixture = createBridgeFixture({
    beforeReadHeads: async roomKeys => {
      if (roomKeys.length === 1 && roomKeys[0] === 'bridge-room') {
        markBridgeRoomHeadRead()
        await bridgeRoomHeadGate
      }
    },
    beforeReadOperations: async ({ roomKey }) => {
      if (roomKey === 'other-room') markOtherRoomOperationRead()
    }
  })
  fixture.activeRooms.add('bridge-room')
  fixture.activeRooms.add('other-room')
  fixture.rows.push(makeCommitted(1, 'map.updated', {}, 'other-room'))
  fixture.setHead(1)
  await fixture.bridge.start()

  const emptyDrainsBefore = fixture.bridge.status().emptyDrains
  fixture.bridge.activateRoom('bridge-room', 1)
  await bridgeRoomHeadRead
  fixture.bridge.activateRoom('other-room', 0)
  await otherRoomOperationRead
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  releaseBridgeRoomHead()
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)

  assert.strictEqual(fixture.bridge.status().operationsSent, 1)
  assert.strictEqual(fixture.bridge.status().emptyDrains, emptyDrainsBefore + 1)
  await fixture.bridge.stop()
}

async function testRoomExitClearsWakeupDeduplicationState() {
  const fixture = createBridgeFixture({ intervalMs: 250 })
  fixture.activeRooms.add('bridge-room')
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)
  const wakeup = { mapId: 'bridge-room', version: 1, operationId: 'reentered-op' }

  await fixture.bus.publish(wakeup)
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  const operationQueriesBeforeExit = fixture.getOperationQueryCount()

  fixture.activeRooms.delete('bridge-room')
  await waitFor(() => fixture.bridge.status().activeRooms === 0)
  fixture.activeRooms.add('bridge-room')
  fixture.bridge.activateRoom('bridge-room', 1)
  await waitFor(() => fixture.bridge.status().pendingDrains === 0)
  const operationQueriesAfterReactivation = fixture.getOperationQueryCount()
  const headQueriesBeforeReenteredWakeup = fixture.getHeadQueryCount()
  await fixture.bus.publish(wakeup)
  await waitFor(() => fixture.bridge.status().notifications === 2)
  await waitFor(() => fixture.getHeadQueryCount() > headQueriesBeforeReenteredWakeup)

  const status = fixture.bridge.status()
  assert.strictEqual(status.duplicateNotifications, 0)
  assert.strictEqual(fixture.getOperationQueryCount(), operationQueriesAfterReactivation)
  assert.ok(operationQueriesAfterReactivation >= operationQueriesBeforeExit)
  assert.strictEqual(status.notifications, 2)
  await fixture.bridge.stop()
}

async function testBridgeIdleHeadCheckFindsMissedNotification() {
  const fixture = createBridgeFixture({ intervalMs: 250 })
  await fixture.bridge.start()
  fixture.activeRooms.add('bridge-room')
  fixture.bridge.activateRoom('bridge-room', 0)
  fixture.rows.push(makeCommitted(1))
  fixture.setHead(1)

  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'), 1000)
  assert.strictEqual(fixture.emissions.find(row => row.event === 'op:event').payload.serverRevision, 1)
  assert.ok(fixture.bridge.status().headChecks >= 2)
  await fixture.bridge.stop()
}

async function testUnsupportedBridgeEventRequiresSnapshot() {
  const fixture = createBridgeFixture({ pageSize: 5 })
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 0)
  fixture.rows.push(makeCommitted(1), makeCommitted(2, 'map.replaced', { tree: { root: {} } }))
  fixture.setHead(2)
  fixture.activeRooms.add('bridge-room')
  await fixture.bus.publish({ mapId: 'bridge-room', version: 2, operationId: 'wake-2' })

  await waitFor(() => fixture.emissions.some(row => row.event === 'sync:resnapshot-required'))
  const sent = fixture.emissions.filter(row => row.event === 'op:event')
  const reload = fixture.emissions.find(row => row.event === 'sync:resnapshot-required')
  assert.deepStrictEqual(sent.map(row => row.payload.serverRevision), [1])
  assert.strictEqual(reload.payload.code, 'RESNAPSHOT_REQUIRED')
  assert.strictEqual(reload.payload.currentRevision, 2)
  assert.strictEqual(fixture.bridge.status().unsupportedEvents, 1)
  await fixture.bridge.stop()
}

async function testExistingBridgeCursorCannotBeAdvancedByNewJoin() {
  const fixture = createBridgeFixture()
  fixture.setHead(1)
  await fixture.bridge.start()
  fixture.bridge.activateRoom('bridge-room', 1)
  fixture.bridge.activateRoom('bridge-room', 99)
  assert.strictEqual(fixture.bridge.status().activeRooms, 1)
  fixture.rows.push(makeCommitted(2))
  fixture.setHead(2)
  await fixture.bus.publish({ mapId: 'bridge-room', version: 2, operationId: 'wake-2' })
  await waitFor(() => fixture.emissions.some(row => row.event === 'op:event'))
  assert.strictEqual(fixture.emissions.find(row => row.event === 'op:event').payload.serverRevision, 2)
  await fixture.bridge.stop()
}

class FakeSocket {
  constructor(server) {
    this.server = server
    this.connected = true
    this.handlers = new Map()
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  emit(event, payload, callback) {
    Promise.resolve(this.server(event, payload)).then(result => {
      if (typeof callback === 'function') callback(result)
    })
  }

  fire(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload)
  }

  disconnect() {
    this.connected = false
  }
}

function makeClientOp(version, clientId, type = 'map.updated') {
  return {
    opId: `client-op-${version}`,
    roomKey: 'adapter-room',
    type,
    clientId,
    serverRevision: version,
    event: { type, payload: {} },
    payload: {}
  }
}

function makeSync(afterRevision, headVersion, clientId) {
  const operations = []
  for (let version = afterRevision + 1; version <= headVersion; version += 1) {
    operations.push(makeClientOp(version, version === headVersion ? clientId : 'remote-client'))
  }
  return {
    ok: true,
    reload: false,
    fromRevision: afterRevision,
    toRevision: headVersion,
    currentRevision: headVersion,
    serverRevision: headVersion,
    hasMore: false,
    operations
  }
}

function makeSyncPage(afterRevision, headVersion, clientId, pageSize) {
  const end = Math.min(headVersion, afterRevision + pageSize)
  const operations = []
  for (let version = afterRevision + 1; version <= end; version += 1) {
    operations.push(makeClientOp(version, version === headVersion ? clientId : 'remote-client'))
  }
  return {
    ok: true,
    reload: false,
    fromRevision: afterRevision,
    toRevision: end,
    currentRevision: headVersion,
    serverRevision: headVersion,
    hasMore: end < headVersion,
    operations
  }
}

async function createConnectedAdapter(options = {}) {
  // Node 26 exposes process-local sessionStorage. Independent adapter fixtures
  // share this synthetic room name, so isolate their persisted watermark too.
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('mind-map-collab-v2-rev:adapter-room')
  }
  let clientId = 'adapter-client-1234'
  let serverHead = Number(options.initialHead || 1)
  let reloadCount = 0
  let onRemote = []
  const syncRequests = []
  const socket = new FakeSocket(async (event, payload) => {
    if (event === 'join') {
      return {
        ok: true,
        roomKey: 'adapter-room',
        role: 'editor',
        canEdit: true,
        serverRevision: serverHead,
        sync: makeSyncPage(
          Number(payload.lastServerRevision || 0),
          serverHead,
          clientId,
          Number(options.pageSize) || 500
        )
      }
    }
    if (event === 'sync') {
      syncRequests.push({ ...payload })
      const head = Number(payload.headVersion == null ? serverHead : payload.headVersion)
      return makeSyncPage(
        Number(payload.afterRevision || 0),
        head,
        clientId,
        Number(options.pageSize) || 500
      )
    }
    if (event === 'op') {
      serverHead = Math.max(serverHead, Number(options.ackRevision) || 4)
      return { ok: true, opId: payload.opId, serverRevision: serverHead }
    }
    return { ok: true }
  })
  const adapter = createCollaborationAdapter({
    socket,
    clientId,
    memory: true,
    timeoutMs: 300,
    onRemoteOperation: op => { onRemote.push(op.serverRevision) },
    onReloadRequired: async sync => {
      reloadCount += 1
      return options.onReloadRequired
        ? options.onReloadRequired(sync, reloadCount)
        : { applied: true, version: Number(sync.currentRevision || 0) }
    }
  })
  await adapter.connect({ roomKey: 'adapter-room', clientId })
  return {
    adapter,
    socket,
    setHead: value => { serverHead = value },
    getRemoteRevisions: () => onRemote.slice(),
    getReloadCount: () => reloadCount,
    getSyncRequests: () => syncRequests.slice()
  }
}

async function testAckGapIsFilledBeforeWatermarkAdvances() {
  const state = await createConnectedAdapter({ ackRevision: 4 })
  assert.strictEqual(state.adapter.getStatus().lastServerRevision, 1)
  const result = await state.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', patch: { text: 'Updated' } }
  })
  assert.strictEqual(result.serverRevision, 4)
  assert.deepStrictEqual(state.getRemoteRevisions(), [2, 3])
  assert.strictEqual(state.adapter.getStatus().lastServerRevision, 4)
  await state.adapter.disconnect()
}

async function testSnapshotFailureDoesNotAdvanceAdapterWatermark() {
  let applied = false
  const state = await createConnectedAdapter({
    onReloadRequired: async sync =>
      applied
        ? { applied: true, version: sync.currentRevision }
        : { applied: false, version: sync.currentRevision }
  })
  await assert.rejects(
    state.adapter.resync({
      forceSnapshot: true,
      payload: { roomKey: 'adapter-room', currentRevision: 2 }
    }),
    error => error.code === 'SNAPSHOT_NOT_APPLIED'
  )
  assert.strictEqual(state.adapter.getStatus().lastServerRevision, 1)
  applied = true
  await state.adapter.resync({
    forceSnapshot: true,
    payload: { roomKey: 'adapter-room', currentRevision: 2 }
  })
  assert.strictEqual(state.adapter.getStatus().lastServerRevision, 2)
  await state.adapter.disconnect()
}

async function testJoinPagesThroughOneFixedHead() {
  const state = await createConnectedAdapter({ initialHead: 3, pageSize: 1 })
  assert.strictEqual(state.adapter.getStatus().lastServerRevision, 3)
  assert.deepStrictEqual(state.getRemoteRevisions(), [1, 2])
  assert.deepStrictEqual(
    state.getSyncRequests().map(request => [request.afterRevision, request.headVersion]),
    [[1, 3], [2, 3]]
  )
  await state.adapter.disconnect()
}

async function testAckDispositionNeverSkipsARevisionGap() {
  assert.deepStrictEqual(ackRevisionDisposition(1, 4), { advance: false, resync: true })
  assert.deepStrictEqual(ackRevisionDisposition(3, 4), { advance: true, resync: false })
  assert.deepStrictEqual(ackRevisionDisposition(4, 4), { advance: false, resync: false })
}

async function run() {
  const tests = [
    ['fromCommitted selects canonical event payload', testFromCommittedUsesCanonicalEventPayload],
    ['private request summary stays out of client patch', testPrivateRequestSummaryDoesNotReachClientPatch],
    ['generated insert applies through client pure reducer', testGeneratedInsertAppliesThroughClientPureReducer],
    ['bridge drains committed versions in order and deduplicates wakeups', testBridgeDrainsVersionsInOrderAndDeduplicatesWakeups],
    ['a concurrent duplicate wakeup does not start another drain', testConcurrentDuplicateWakeupDoesNotStartAnotherDrain],
    ['a full pending wakeup cache bypasses dedupe without dropping notifications', testPendingWakeupLimitBypassesCacheWithoutDroppingNotifications],
    ['a failed drain allows the same wakeup to retry', testFailedDrainAllowsSameWakeupToRetry],
    ['different versions and unsigned wakeups are not dropped', testDifferentVersionAndUnsignedWakeupsAreNotDropped],
    ['concurrent room drains keep empty counts room-local', testConcurrentDrainsKeepEmptyCountsRoomLocal],
    ['a room exit clears wakeup deduplication state', testRoomExitClearsWakeupDeduplicationState],
    ['active-room head check repairs a missed notification', testBridgeIdleHeadCheckFindsMissedNotification],
    ['unsupported bridge event requests a snapshot', testUnsupportedBridgeEventRequiresSnapshot],
    ['a later join cannot advance an existing room cursor', testExistingBridgeCursorCannotBeAdvancedByNewJoin],
    ['ACK gap is filled before the adapter watermark advances', testAckGapIsFilledBeforeWatermarkAdvances],
    ['failed snapshot recovery does not advance the adapter watermark', testSnapshotFailureDoesNotAdvanceAdapterWatermark],
    ['join pages through its fixed room head', testJoinPagesThroughOneFixedHead],
    ['ACK disposition never skips a revision gap', testAckDispositionNeverSkipsARevisionGap]
  ]
  let failures = 0
  for (const [name, test] of tests) {
    try {
      await test()
      console.log('ok - ' + name)
    } catch (err) {
      failures += 1
      console.error('not ok - ' + name)
      console.error(err && err.stack ? err.stack : err)
    }
  }
  if (failures) {
    console.error(`${failures} MCP event bridge test(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('MCP event bridge focused tests ok')
}

if (require.main === module) {
  run().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
}

module.exports = { run }
