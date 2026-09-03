const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createOpId, normalizeOperation, isOpId } = require('../bin/collabV2/protocol')
const { createPresenceHub } = require('../bin/collabV2/presenceHub')

function wait(ms = 25) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createHub(engine) {
  const sockets = new Map()

  function broadcast(roomKey, exceptId, event, data) {
    sockets.forEach(socket => {
      if (!socket.connected || socket.roomKey !== roomKey) return
      if (exceptId && socket.id === exceptId) return
      socket._emit(event, data)
    })
  }

  async function handle(socket, event, payload, cb) {
    const reply = typeof cb === 'function' ? cb : () => {}
    try {
      if (event === 'join') {
        socket.roomKey = payload.roomKey
        socket.clientId = payload.clientId
        engine.setPresence(payload.roomKey, payload.clientId, {
          userId: payload.userId,
          name: payload.name,
          color: payload.color,
          role: socket.access.role
        })
        const sync = engine.opsAfter(payload.roomKey, payload.lastServerRevision)
        const room = engine.getRoom(payload.roomKey)
        reply({
          ok: true,
          role: socket.access.role,
          canEdit: !!socket.access.canEdit,
          canView: true,
          serverRevision: room.revision,
          sync,
          peers: engine.listPresence(payload.roomKey)
        })
        broadcast(payload.roomKey, socket.id, 'presence:state', {
          roomKey: payload.roomKey,
          peers: engine.listPresence(payload.roomKey)
        })
        return
      }
      if (event === 'op') {
        if (socket.dropAckOnce) {
          socket.dropAckOnce = false
          await engine.submit(
            { ...payload, userId: socket.access.userId },
            socket.access
          )
          return
        }
        const result = await engine.submit(
          { ...payload, userId: socket.access.userId },
          socket.access
        )
        const op = result.operation
        reply({
          ok: true,
          opId: op.opId,
          serverRevision: op.serverRevision,
          duplicate: result.duplicate,
          operation: op
        })
        if (!result.duplicate) {
          broadcast(op.roomKey, socket.id, 'op:event', op)
        }
        return
      }
      if (event === 'sync') {
        reply({
          ok: true,
          ...engine.opsAfter(payload.roomKey, payload.afterRevision, payload.limit)
        })
        return
      }
      if (event === 'presence') {
        const owner = payload.editingUid
          ? engine.lockOwner(payload.roomKey, payload.editingUid)
          : null
        if (owner && owner.clientId !== socket.clientId) {
          socket._emit('lock:denied', {
            roomKey: payload.roomKey,
            nodeId: payload.editingUid,
            owner
          })
          return
        }
        engine.setPresence(payload.roomKey, socket.clientId, payload)
        broadcast(payload.roomKey, null, 'presence:state', {
          roomKey: payload.roomKey,
          peers: engine.listPresence(payload.roomKey)
        })
      }
    } catch (err) {
      reply({
        ok: false,
        opId: payload && payload.opId,
        code: err.code,
        error: err.message,
        statusCode: err.statusCode || 400,
        currentVersion: err.currentVersion,
        details: err.details || {
          baseRevision: payload && payload.baseRevision,
          roomCurrentRevision: err.currentVersion,
          clientSeq: payload && payload.clientSeq,
          opId: payload && payload.opId
        }
      })
    }
  }

  function createSocket(access) {
    const handlers = {}
    const socket = {
      id: randomUUID(),
      connected: true,
      access,
      roomKey: '',
      clientId: '',
      dropAckOnce: false,
      on(ev, fn) {
        handlers[ev] = handlers[ev] || []
        handlers[ev].push(fn)
      },
      emit(ev, payload, cb) {
        Promise.resolve().then(() => handle(socket, ev, payload, cb))
      },
      disconnect() {
        socket.connected = false
        if (socket.roomKey) {
          engine.removeConnection(socket.clientId, socket.roomKey)
        }
      },
      _emit(ev, data) {
        ;(handlers[ev] || []).forEach(fn => fn(data))
      }
    }
    sockets.set(socket.id, socket)
    return socket
  }

  return { createSocket, sockets }
}

async function makeClient(hub, opts) {
  const applied = []
  const rejected = []
  const socket = hub.createSocket({
    canEdit: opts.role !== 'viewer',
    role: opts.role || 'editor',
    userId: opts.userId
  })
  const adapter = createCollaborationAdapter({
    clientId: opts.clientId || randomUUID(),
    name: opts.userId,
    color: opts.color || '#409EFF',
    memory: true,
    outbox: opts.outbox,
    socket,
    timeoutMs: opts.timeoutMs || 800,
    onRemoteOperation: op => {
      applied.push(op)
    },
    onRejected: (op, err) => rejected.push({ op, err })
  })
  await adapter.connect({
    roomKey: opts.roomKey,
    userId: opts.userId,
    lastServerRevision: opts.lastServerRevision || 0
  })
  return { adapter, applied, rejected, socket }
}

function nodeText(engine, roomKey, uid) {
  const node = engine.getRoom(roomKey).nodes[uid]
  return node && node.data && node.data.text
}

function treeHash(engine, roomKey) {
  const nodes = engine.getRoom(roomKey).nodes || {}
  return JSON.stringify(
    Object.keys(nodes)
      .sort()
      .map(uid => {
        const n = nodes[uid]
        return [uid, n && n.data && n.data.text, ((n && n.children) || []).slice()]
      })
  )
}

function nodeCount(engine, roomKey) {
  return Object.keys((engine.getRoom(roomKey).nodes || {})).length
}

async function testProtocolAndOutbox() {
  const op = normalizeOperation({
    type: 'node.create',
    payload: { uid: 'n1', parent: 'root', text: 'Hi' },
    roomKey: 'r1',
    userId: 'u1',
    clientId: 'c1'
  })
  assert.strictEqual(op.type, 'node.insert')
  assert.ok(isOpId(createOpId()))
  const box = createOutbox({ memory: true })
  const id = createOpId()
  await box.put({
    opId: id,
    clientId: 'tab-a',
    roomKey: 'r1',
    clientSeq: 1,
    status: 'pending'
  })
  await box.put({
    opId: createOpId(),
    clientId: 'tab-b',
    roomKey: 'r1',
    clientSeq: 1,
    status: 'pending'
  })
  const mine = await box.list('tab-a', 'r1')
  assert.strictEqual(mine.length, 1)
  assert.strictEqual(mine[0].opId, id)
}

async function testPresenceSoftLock() {
  const hub = createPresenceHub()
  hub.setPeer('r', 'a', { userId: 'A', name: 'A', editingUid: 'n1' })
  assert.strictEqual(hub.lockOwner('r', 'n1').clientId, 'a')
  hub.setPeer('r', 'b', { userId: 'B', name: 'B', editingUid: 'n1' })
  assert.strictEqual(hub.lockOwner('r', 'n1').clientId, 'a')
  hub.removePeer('r', 'a')
  assert.strictEqual(hub.lockOwner('r', 'n1'), null)
}

async function testThreeClientsAndConflicts() {
  const roomKey = 'room-v2'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A', role: 'owner' })
  const b = await makeClient(hub, { roomKey, userId: 'B', role: 'editor' })
  const c = await makeClient(hub, { roomKey, userId: 'C', role: 'editor' })

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: 'N1' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: 'N2' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n3', parent: 'root', text: 'N3' }
  })
  await wait(80)
  assert.strictEqual(nodeText(engine, roomKey, 'n1'), 'N1')
  assert.ok(b.applied.some(op => op.event && op.event.payload && op.event.payload.uid === 'n1'))
  assert.ok(c.applied.length >= 1)

  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', text: 'A-text' }
  })
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n2', text: 'B-text' }
  })
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'n1'), 'A-text')
  assert.strictEqual(nodeText(engine, roomKey, 'n2'), 'B-text')

  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n3', text: 'same-field-a' }
  })
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n3', text: 'same-field-b' }
  })
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'n3'), 'same-field-b')

  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', note: 'note-a' }
  })
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', icon: ['style'] }
  })
  await wait()
  const n1 = engine.getRoom(roomKey).nodes.n1.data
  assert.strictEqual(n1.note, 'note-a')
  assert.deepStrictEqual(n1.icon, ['style'])

  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n2', mapRef: { mapId: 'other', nodeId: 'x', type: 'node' } }
  })
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: {
      uid: 'n2',
      generalization: [{ uid: 'g1', text: 'summary' }]
    }
  })
  await c.adapter.submitOperation({
    type: 'node.update',
    payload: {
      uid: 'n2',
      outerFrame: { stroke: '#333' },
      associativeLine: [{ to: 'n1', text: 'rel' }]
    }
  })
  await wait()
  const n2 = engine.getRoom(roomKey).nodes.n2.data
  assert.strictEqual(n2.mapRef.mapId, 'other')
  assert.ok(Array.isArray(n2.generalization))
  assert.ok(n2.outerFrame)
  assert.ok(Array.isArray(n2.associativeLine))

  await a.adapter.submitOperation({
    type: 'node.move',
    payload: { uid: 'n3', parent: 'n1', index: 0 }
  })
  await wait()
  assert.ok(engine.getRoom(roomKey).nodes.n1.children.includes('n3'))

  let cycleCode = ''
  try {
    await a.adapter.submitOperation({
      type: 'node.move',
      payload: { uid: 'n1', parent: 'n3' }
    })
  } catch (err) {
    cycleCode = err.code
  }
  assert.strictEqual(cycleCode, 'CYCLE_REJECTED')

  await b.adapter.submitOperation({
    type: 'node.move',
    payload: { uid: 'n3', parent: 'n2', index: 0 }
  })
  await wait()
  const afterMove = engine.getRoom(roomKey).nodes
  assert.ok(afterMove.n2.children.includes('n3'))
  assert.ok(!afterMove.n1.children.includes('n3'))

  await a.adapter.submitOperation({
    type: 'node.delete',
    payload: { uid: 'n3' }
  })
  await wait()
  let deletedCode = ''
  try {
    await b.adapter.submitOperation({
      type: 'node.update',
      payload: { uid: 'n3', text: 'resurrect' }
    })
  } catch (err) {
    deletedCode = err.code
  }
  assert.ok(deletedCode === 'TARGET_DELETED' || deletedCode === 'NODE_DELETED')
  assert.ok(!engine.getRoom(roomKey).nodes.n3)

  await a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      ops: [
        { type: 'node.insert', payload: { uid: 'p1', parent: 'root', text: 'P1' } },
        { type: 'node.insert', payload: { uid: 'p2', parent: 'root', text: 'P2' } }
      ]
    }
  })
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'p1'), 'P1')
  assert.strictEqual(nodeText(engine, roomKey, 'p2'), 'P2')

  const first = await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', text: 'dup' }
  })
  a.socket.dropAckOnce = false
  const again = await engine.submit(
    {
      opId: first.opId,
      type: 'node.update',
      roomKey,
      userId: 'A',
      clientId: a.adapter.getClientId(),
      payload: { uid: 'n1', text: 'dup-again' }
    },
    { canEdit: true, userId: 'A' }
  )
  assert.strictEqual(again.duplicate, true)
  assert.strictEqual(again.operation.serverRevision, first.serverRevision)
  assert.strictEqual(nodeText(engine, roomKey, 'n1'), 'dup')

  return { engine, roomKey, a, b, c }
}

async function testAckLossReconnectGapUndoTabs() {
  const roomKey = 'room-gap'
  const engine = createEngine()
  const hub = createHub(engine)
  const sharedBox = createOutbox({ memory: true })
  const clientId = randomUUID()
  const a = await makeClient(hub, {
    roomKey,
    userId: 'A',
    clientId,
    outbox: sharedBox
  })
  const b = await makeClient(hub, { roomKey, userId: 'B' })

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'keep', parent: 'root', text: 'keep' }
  })
  await wait()

  a.socket.dropAckOnce = true
  const pending = a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'keep', text: 'offline-edit' }
  })
  await wait(40)
  const listed = await sharedBox.list(clientId, roomKey)
  assert.ok(listed.length >= 1)
  await a.adapter.retryPending()
  const acked = await pending
  assert.ok(acked.serverRevision)
  assert.strictEqual(nodeText(engine, roomKey, 'keep'), 'offline-edit')

  for (let i = 0; i < 6; i++) {
    await engine.submit(
      {
        opId: randomUUID(),
        type: 'node.insert',
        roomKey,
        userId: 'B',
        clientId: 'gap-seed-b',
        payload: { uid: 'gap' + i, parent: 'root', text: 'g' + i }
      },
      { canEdit: true, userId: 'B' }
    )
  }
  const latest = engine.getRoom(roomKey).ops[engine.getRoom(roomKey).ops.length - 1]
  const before = b.adapter.getStatus().lastServerRevision
  assert.ok(latest.serverRevision > before + 1)
  await b.adapter.applyRemoteOperation(latest)
  await wait()
  assert.ok(b.adapter.getStatus().lastServerRevision >= latest.serverRevision)
  assert.ok(engine.getRoom(roomKey).nodes.gap0)

  const localUndo = []
  const ackA = await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'undo-a', parent: 'root', text: 'A1' }
  })
  localUndo.push(ackA.opId)
  await b.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'undo-b', parent: 'root', text: 'B1' }
  })
  await wait()
  assert.ok(engine.getRoom(roomKey).nodes['undo-b'])
  assert.ok(engine.getRoom(roomKey).nodes['undo-a'])
  assert.strictEqual(localUndo.length, 1)
  assert.strictEqual(localUndo[0], ackA.opId)

  const tabB = await makeClient(hub, {
    roomKey,
    userId: 'A',
    clientId: randomUUID()
  })
  assert.notStrictEqual(a.adapter.getClientId(), tabB.adapter.getClientId())
  await tabB.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'tab-b', parent: 'root', text: 'tab' }
  })
  await wait()
  assert.ok(engine.getRoom(roomKey).nodes['tab-b'])
  assert.ok(a.applied.some(op => (op.event && op.event.payload && op.event.payload.uid) === 'tab-b'))
}

async function testViewerAndDemote() {
  const roomKey = 'room-acl'
  const engine = createEngine()
  const hub = createHub(engine)
  const owner = await makeClient(hub, { roomKey, userId: 'Owner', role: 'owner' })
  const viewer = await makeClient(hub, { roomKey, userId: 'View', role: 'viewer' })
  await owner.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'seen', parent: 'root', text: 'visible' }
  })
  await wait()
  assert.ok(viewer.applied.length >= 1)
  let forbidden = ''
  try {
    await viewer.adapter.submitOperation({
      type: 'node.update',
      payload: { uid: 'seen', text: 'hack' }
    })
  } catch (err) {
    forbidden = err.code
  }
  assert.strictEqual(forbidden, 'FORBIDDEN')
  assert.strictEqual(nodeText(engine, roomKey, 'seen'), 'visible')

  const editor = await makeClient(hub, { roomKey, userId: 'Ed', role: 'editor' })
  editor.socket.access = { canEdit: false, role: 'viewer', userId: 'Ed' }
  let demoted = ''
  try {
    await editor.adapter.submitOperation({
      type: 'node.update',
      payload: { uid: 'seen', text: 'nope' }
    })
  } catch (err) {
    demoted = err.code
  }
  assert.strictEqual(demoted, 'FORBIDDEN')
  assert.strictEqual(nodeText(engine, roomKey, 'seen'), 'visible')
}

async function testOfflineOutboxRefresh() {
  const roomKey = 'room-offline'
  const engine = createEngine()
  const hub = createHub(engine)
  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  const live = await makeClient(hub, { roomKey, userId: 'A', clientId, outbox: box })
  live.socket.connected = false
  live.adapter.getStatus()
  const opId = createOpId()
  await box.put({
    opId,
    type: 'node.insert',
    roomKey,
    userId: 'A',
    clientId,
    clientSeq: 1,
    payload: { uid: 'offline-n', parent: 'root', text: 'from-refresh' },
    status: 'pending'
  })
  live.socket.connected = true
  await live.adapter.retryPending()
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'offline-n'), 'from-refresh')
}

async function testUndoRedoConflictAndRestore() {
  const roomKey = 'room-undo'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A', role: 'owner' })
  const b = await makeClient(hub, { roomKey, userId: 'B', role: 'editor' })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'u1', parent: 'root', text: 'A1' }
  })
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'u1', text: 'A2' }
  })
  await wait()
  const undoA2 = await a.adapter.undo()
  assert.ok(undoA2.ok !== false)
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'u1'), 'A1')
  const redoA2 = await a.adapter.redo()
  assert.ok(redoA2.serverRevision)
  await wait()
  assert.strictEqual(nodeText(engine, roomKey, 'u1'), 'A2')
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'u1', text: 'B2' }
  })
  await wait()
  let conflict = ''
  try {
    await a.adapter.undo()
  } catch (err) {
    conflict = err.code
  }
  assert.strictEqual(conflict, 'UNDO_CONFLICT')
  assert.strictEqual(nodeText(engine, roomKey, 'u1'), 'B2')

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'gone', parent: 'root', text: 'temp' }
  })
  await a.adapter.submitOperation({
    type: 'node.delete',
    payload: { uid: 'gone' }
  })
  await wait()
  assert.ok(!engine.getRoom(roomKey).nodes.gone)
  await a.adapter.undo()
  await wait()
  assert.ok(engine.getRoom(roomKey).nodes.gone)
  assert.strictEqual(nodeText(engine, roomKey, 'gone'), 'temp')

  await a.adapter.submitOperation({
    type: 'map.meta.update',
    payload: { title: '主题图', theme: 'classic' }
  })
  await wait()
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().theme, 'classic')

  let unsupported = ''
  try {
    await engine.submit(
      {
        opId: randomUUID(),
        type: 'legacy.whatever',
        roomKey,
        userId: 'A',
        payload: {}
      },
      { canEdit: true, userId: 'A' }
    )
  } catch (err) {
    unsupported = err.code
  }
  assert.ok(unsupported === 'UNSUPPORTED_OPERATION' || unsupported === 'BAD_TYPE')

  await a.adapter.submitOperation({
    type: 'map.replace',
    payload: {
      nodes: {
        root: { isRoot: true, data: { uid: 'root', text: 'Imported' }, children: [] }
      }
    }
  })
  await wait()
  assert.strictEqual(engine.getRoom(roomKey).nodes.root.data.text, 'Imported')
  await a.adapter.undo()
  await wait()
  assert.notStrictEqual(engine.getRoom(roomKey).nodes.root.data.text, 'Imported')
}

async function testSaveStateFromSocketOutboxAck() {
  const roomKey = 'room-save-state'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const idle = a.adapter.getStatus()
  assert.strictEqual(idle.status, 'live')
  assert.strictEqual(idle.saveState, 'saved')
  assert.strictEqual(idle.outboxPending, 0)
  assert.strictEqual(idle.pendingCount, 0)
  const result = await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'saved-via-ack' }
  })
  const done = a.adapter.getStatus()
  assert.strictEqual(done.saveState, 'saved')
  assert.strictEqual(done.outboxPending, 0)
  assert.strictEqual(done.pendingCount, 0)
  assert.ok(done.lastServerRevision >= Number(result.serverRevision || 0))
}

async function testStructuredLastError() {
  const roomKey = 'room-diag-error'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  let caught = null
  try {
    await a.adapter.submitOperation({
      type: 'legacy.whatever',
      payload: { uid: 'root', text: 'nope' }
    })
  } catch (err) {
    caught = err
  }
  assert.ok(caught)
  assert.strictEqual(caught.code, 'UNSUPPORTED_OPERATION')
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.saveState, 'error')
  assert.ok(snap.lastError)
  assert.strictEqual(snap.lastError.code, 'UNSUPPORTED_OPERATION')
  assert.strictEqual(snap.lastError.stage, 'server_apply')
  assert.ok(snap.lastError.timestamp > 0)
  const debug = a.adapter.getDebugState()
  assert.strictEqual(debug.errorCode, 'UNSUPPORTED_OPERATION')
  assert.strictEqual(debug.stage, 'server_apply')
  assert.ok(debug.clientId)
  assert.ok(debug.roomKey)
  assert.strictEqual(debug.lastError.code, 'UNSUPPORTED_OPERATION')
  assert.notStrictEqual(debug.lastError, '同步失败')
  assert.ok(typeof debug.lastError === 'object')
  ;[
    'errorCode',
    'errorMessage',
    'stage',
    'roomKey',
    'userId',
    'clientId',
    'socketId',
    'lastServerRevision',
    'serverRevision',
    'outboxPending',
    'outboxSending',
    'baseRevision',
    'roomCurrentRevision',
    'clientSeq',
    'outboxIndex',
    'lastOpId',
    'timestamp',
    'currentError',
    'lastErrorRecovered'
  ].forEach(key => {
    assert.ok(Object.prototype.hasOwnProperty.call(debug, key), 'missing ' + key)
  })
  assert.ok(!Object.prototype.hasOwnProperty.call(debug, 'authorization'))
  assert.ok(!Object.prototype.hasOwnProperty.call(debug, 'cookie'))
  const recovered = await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'recovered' }
  })
  assert.ok(recovered.serverRevision)
  const afterOk = a.adapter.getStatus()
  assert.strictEqual(afterOk.saveState, 'saved')
  assert.strictEqual(afterOk.currentError, null)
  assert.ok(afterOk.lastError)
  assert.strictEqual(afterOk.lastError.code, 'UNSUPPORTED_OPERATION')
  assert.strictEqual(afterOk.lastErrorRecovered, true)
  const viewer = await makeClient(hub, { roomKey, userId: 'V', role: 'viewer' })
  let forbidden = null
  try {
    await viewer.adapter.submitOperation({
      type: 'node.update',
      payload: { uid: 'root', text: 'nope' }
    })
  } catch (err) {
    forbidden = err
  }
  assert.ok(forbidden)
  assert.strictEqual(forbidden.code, 'FORBIDDEN')
  const vSnap = viewer.adapter.getStatus()
  assert.strictEqual(vSnap.lastError.code, 'FORBIDDEN')
  assert.strictEqual(vSnap.lastError.stage, 'server_acl')
}

async function testEmptyClientIdRejected() {
  const engine = createEngine()
  const roomKey = 'room-empty-client'
  engine.getRoom(roomKey)
  let code = ''
  try {
    await engine.submit(
      {
        opId: randomUUID(),
        type: 'node.update',
        roomKey,
        userId: 'dev-local',
        clientId: '',
        payload: { uid: 'root', text: 'nope' }
      },
      { canEdit: true, userId: 'dev-local' }
    )
  } catch (err) {
    code = err.code
  }
  assert.strictEqual(code, 'INVALID_CLIENT_ID')
}

async function testSameUserTwoClients() {
  const roomKey = 'room-same-user'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, {
    roomKey,
    userId: 'dev-local',
    clientId: 'client-A',
    role: 'owner'
  })
  const b = await makeClient(hub, {
    roomKey,
    userId: 'dev-local',
    clientId: 'client-B',
    role: 'owner'
  })
  assert.notStrictEqual(a.adapter.getClientId(), b.adapter.getClientId())
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'from-A' }
  })
  await wait(80)
  assert.ok(
    b.applied.some(op => {
      const text =
        (op.event && op.event.payload && op.event.payload.text) ||
        (op.payload && op.payload.text)
      return text === 'from-A'
    }),
    'B must receive A update despite same userId'
  )
  await b.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'from-b', parent: 'root', text: 'from-B' }
  })
  await wait(80)
  assert.ok(
    a.applied.some(op => {
      const uid =
        (op.event && op.event.payload && op.event.payload.uid) ||
        (op.payload && op.payload.uid)
      return uid === 'from-b'
    }),
    'A must receive B insert despite same userId'
  )
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'from-A')
  assert.strictEqual(nodeText(engine, roomKey, 'from-b'), 'from-B')
  const peers = engine.listPresence(roomKey)
  assert.strictEqual(peers.length, 2)
  assert.ok(peers.some(peer => peer.clientId === 'client-A'))
  assert.ok(peers.some(peer => peer.clientId === 'client-B'))
}

async function testDifferentUserTwoClients() {
  const roomKey = 'room-diff-user'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, {
    roomKey,
    userId: 'user-A',
    clientId: 'client-A',
    role: 'owner'
  })
  const b = await makeClient(hub, {
    roomKey,
    userId: 'user-B',
    clientId: 'client-B',
    role: 'editor'
  })
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'user-A-text' }
  })
  await wait(80)
  assert.ok(
    b.applied.some(op => {
      const text =
        (op.event && op.event.payload && op.event.payload.text) ||
        (op.payload && op.payload.text)
      return text === 'user-A-text'
    })
  )
  await b.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'user-b-node', parent: 'root', text: 'user-B-node' }
  })
  await wait(80)
  assert.ok(
    a.applied.some(op => {
      const uid =
        (op.event && op.event.payload && op.event.payload.uid) ||
        (op.payload && op.payload.uid)
      return uid === 'user-b-node'
    })
  )
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'user-A-text')
  assert.strictEqual(nodeText(engine, roomKey, 'user-b-node'), 'user-B-node')
}

async function testSequentialOutboxDrainBurst() {
  const roomKey = 'room-seq-drain'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A', role: 'owner' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  let maxSending = 0
  const unsub = a.adapter.subscribe(snap => {
    maxSending = Math.max(maxSending, Number(snap.outboxSending || 0))
  })
  const started = Date.now()
  const waits = []
  for (let i = 0; i < 5; i++) {
    waits.push(
      a.adapter.submitOperation({
        type: 'node.insert',
        payload: { uid: 'burst-i' + i, parent: 'root', text: 'I' + i }
      })
    )
  }
  for (let i = 0; i < 10; i++) {
    waits.push(
      a.adapter.submitOperation({
        type: 'node.update',
        payload: { uid: 'burst-i0', text: 'U' + i }
      })
    )
  }
  for (let i = 0; i < 5; i++) {
    waits.push(
      a.adapter.submitOperation({
        type: 'node.move',
        payload: { uid: 'burst-i' + i, parent: 'root', index: i }
      })
    )
  }
  assert.ok(Date.now() - started < 500, 'submit enqueue should not wait for ACK')
  await Promise.all(waits)
  unsub()
  maxSending = Math.max(maxSending, Number(a.adapter.getStatus().maxSendingObserved || 0))
  assert.ok(maxSending <= 1, 'sending=' + maxSending)
  const status = a.adapter.getStatus()
  assert.strictEqual(status.outboxPending, 0)
  assert.ok(status.outboxSending <= 1)
  assert.strictEqual(status.versionAheadCount, 0)
  assert.strictEqual(status.lastError, null)
  await wait(80)
  assert.strictEqual(nodeText(engine, roomKey, 'burst-i0'), 'U9')
  assert.ok(engine.getRoom(roomKey).nodes['burst-i4'])
  assert.ok(
    b.applied.some(op => {
      const text =
        (op.event && op.event.payload && op.event.payload.text) ||
        (op.payload && op.payload.text)
      return text === 'U9'
    })
  )
}

async function testRapidTextThirty() {
  const roomKey = 'room-rapid-text'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  const waits = []
  for (let i = 1; i <= 30; i++) {
    waits.push(
      a.adapter.submitOperation({
        type: 'node.update',
        payload: { uid: 'root', text: 'x'.repeat(i) }
      })
    )
  }
  await Promise.all(waits)
  const status = a.adapter.getStatus()
  assert.strictEqual(status.versionAheadCount, 0)
  assert.strictEqual(status.outboxPending, 0)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'x'.repeat(30))
  await wait(80)
  assert.ok(
    b.applied.some(op => {
      const text =
        (op.event && op.event.payload && op.event.payload.text) ||
        (op.payload && op.payload.text)
      return text === 'x'.repeat(30)
    })
  )
}

async function testPasteThenImmediateUpdate() {
  const roomKey = 'room-paste-then-update'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  const paste = a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      ops: Array.from({ length: 8 }, (_, i) => ({
        type: 'node.insert',
        payload: { uid: 'paste-' + i, parent: 'root', text: 'P' + i }
      }))
    }
  })
  const upd = a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'paste-3', text: 'after-paste' }
  })
  await Promise.all([paste, upd])
  assert.ok(!a.rejected.some(item => item.err && item.err.code === 'TARGET_NOT_FOUND'))
  assert.strictEqual(a.adapter.getStatus().versionAheadCount, 0)
  assert.strictEqual(a.adapter.getStatus().outboxPending, 0)
  assert.strictEqual(nodeText(engine, roomKey, 'paste-3'), 'after-paste')
  await wait(80)
  assert.ok(
    b.applied.some(op => {
      const text =
        (op.event && op.event.payload && op.event.payload.text) ||
        (op.payload && op.payload.text)
      return text === 'after-paste'
    })
  )
}

async function testVersionAheadRecoveryAndStaleOutbox() {
  const roomKey = 'room-ahead-recover'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  a.adapter.setLastServerRevision(999)
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'rebased-ok' }
  })
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'rebased-ok')
  assert.ok(a.adapter.getStatus().versionAheadCount >= 1)
  assert.strictEqual(a.adapter.getStatus().outboxPending, 0)
  assert.strictEqual(a.adapter.getStatus().saveState, 'saved')
  assert.strictEqual(a.adapter.getStatus().currentError, null)
  assert.ok(a.adapter.getStatus().lastError)
  assert.strictEqual(a.adapter.getStatus().lastError.code, 'VERSION_AHEAD')
  assert.strictEqual(a.adapter.getStatus().lastErrorRecovered, true)
  assert.ok(a.adapter.getStatus().lastServerRevision < 999)

  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  await box.put({
    opId: createOpId(),
    type: 'node.update',
    roomKey,
    userId: 'A',
    clientId,
    clientSeq: 1,
    payload: { uid: 'root', text: 'idb-rebase' },
    baseRevision: 999,
    status: 'pending'
  })
  const resumed = await makeClient(hub, {
    roomKey,
    userId: 'A',
    clientId,
    outbox: box
  })
  await wait(80)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'idb-rebase')
  assert.strictEqual(resumed.adapter.getStatus().outboxPending, 0)
  const listed = await box.list(clientId, roomKey)
  assert.strictEqual(listed.length, 0)
}

async function testTwoClientsInterleaveWithoutAhead() {
  const roomKey = 'room-interleave'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'dev-local' })
  const b = await makeClient(hub, { roomKey, userId: 'dev-local' })
  const waits = []
  for (let i = 0; i < 4; i++) {
    waits.push(
      a.adapter.submitOperation({
        type: 'node.insert',
        payload: { uid: 'ia' + i, parent: 'root', text: 'A' + i }
      })
    )
    waits.push(
      b.adapter.submitOperation({
        type: 'node.insert',
        payload: { uid: 'ib' + i, parent: 'root', text: 'B' + i }
      })
    )
  }
  await Promise.all(waits)
  assert.strictEqual(a.adapter.getStatus().versionAheadCount, 0)
  assert.strictEqual(b.adapter.getStatus().versionAheadCount, 0)
  assert.strictEqual(a.adapter.getStatus().outboxPending, 0)
  assert.strictEqual(b.adapter.getStatus().outboxPending, 0)
  assert.ok(engine.getRoom(roomKey).nodes.ia3)
  assert.ok(engine.getRoom(roomKey).nodes.ib3)
}

async function testErrorClearsAfterRecovery() {
  const roomKey = 'room-error-lifecycle'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  a.adapter.setLastServerRevision(999)
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'ok-after-ahead' }
  })
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.status, 'live')
  assert.strictEqual(snap.saveState, 'saved')
  assert.strictEqual(snap.outboxPending, 0)
  assert.strictEqual(snap.outboxSending, 0)
  assert.strictEqual(snap.currentError, null)
  assert.notStrictEqual(snap.saveState, 'error')
  assert.ok(snap.lastError && snap.lastError.code === 'VERSION_AHEAD')
  assert.strictEqual(snap.lastErrorRecovered, true)
}

async function testTextInsertDeleteUndoRedo() {
  const roomKey = 'room-undo-text'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  const h0 = treeHash(engine, roomKey)
  const n0 = nodeCount(engine, roomKey)
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'BBBB' }
  })
  const h1 = treeHash(engine, roomKey)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'BBBB')
  assert.notStrictEqual(h1, h0)
  assert.strictEqual(a.adapter.getStatus().undoDepth, 1)
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), '未命名')
  assert.strictEqual(treeHash(engine, roomKey), h0)
  assert.strictEqual(nodeCount(engine, roomKey), n0)
  const lastOp = engine.getRoom(roomKey).ops[engine.getRoom(roomKey).ops.length - 1]
  assert.notStrictEqual(lastOp.type, 'map.replace')
  assert.notStrictEqual(lastOp.type, 'map.replaced')
  await a.adapter.redoLastLocalOperation()
  await wait(40)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'BBBB')
  assert.strictEqual(treeHash(engine, roomKey), h1)

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'nx', parent: 'root', text: 'NodeX' }
  })
  const afterInsert = treeHash(engine, roomKey)
  const nInsert = nodeCount(engine, roomKey)
  assert.ok(engine.getRoom(roomKey).nodes.nx)
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.ok(!engine.getRoom(roomKey).nodes.nx)
  assert.strictEqual(nodeCount(engine, roomKey), nInsert - 1)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'BBBB')
  await a.adapter.redoLastLocalOperation()
  await wait(40)
  assert.ok(engine.getRoom(roomKey).nodes.nx)
  assert.strictEqual(treeHash(engine, roomKey), afterInsert)

  await a.adapter.submitOperation({
    type: 'node.delete',
    payload: { uid: 'nx' }
  })
  assert.ok(!engine.getRoom(roomKey).nodes.nx)
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.ok(engine.getRoom(roomKey).nodes.nx)
  assert.strictEqual(nodeText(engine, roomKey, 'nx'), 'NodeX')
}

async function testSequentialAndMultiUserUndo() {
  const roomKey = 'room-undo-seq'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'A1' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: 'A2' }
  })
  await a.adapter.submitOperation({
    type: 'node.move',
    payload: { uid: 'n2', parent: 'root', index: 0 }
  })
  const afterA3 = treeHash(engine, roomKey)
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.ok(engine.getRoom(roomKey).nodes.n2)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'A1')
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.ok(!engine.getRoom(roomKey).nodes.n2)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), 'A1')
  await a.adapter.undoLastLocalOperation()
  await wait(40)
  assert.strictEqual(nodeText(engine, roomKey, 'root'), '未命名')
  assert.notStrictEqual(treeHash(engine, roomKey), afterA3)

  const room2 = 'room-undo-multi'
  const engine2 = createEngine()
  const hub2 = createHub(engine2)
  const a2 = await makeClient(hub2, { roomKey: room2, userId: 'A' })
  const b2 = await makeClient(hub2, { roomKey: room2, userId: 'B' })
  await a2.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'A1' }
  })
  await b2.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'b1', parent: 'root', text: 'B1' }
  })
  await a2.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'root', text: 'A2' }
  })
  await a2.adapter.undoLastLocalOperation()
  await wait(40)
  assert.strictEqual(nodeText(engine2, room2, 'root'), 'A1')
  assert.ok(engine2.getRoom(room2).nodes.b1)
  await a2.adapter.undoLastLocalOperation()
  await wait(40)
  assert.strictEqual(nodeText(engine2, room2, 'root'), '未命名')
  assert.ok(engine2.getRoom(room2).nodes.b1)
}

async function testUidReusedSkipDoesNotSticky() {
  const roomKey = 'room-uid-reused'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const uid = 'ca2a87d5-4ac0-4d08-bab8-008d0f6e6b06'
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid, parent: 'root', text: 'x' }
  })
  await a.adapter.submitOperation({
    type: 'node.delete',
    payload: { uid }
  })
  await wait(40)
  await assert.rejects(
    () =>
      a.adapter.submitOperation({
        type: 'node.insert',
        payload: { uid, parent: 'root', text: 'y' }
      }),
    err => err && err.code === 'UID_REUSED'
  )
  await wait(40)
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.status, 'live')
  assert.strictEqual(snap.currentError, null)
  assert.notStrictEqual(snap.saveState, 'error')
  assert.strictEqual(snap.outboxPending, 0)
  assert.strictEqual(a.rejected.length, 0)
  assert.ok(snap.lastError && snap.lastError.code === 'UID_REUSED')
  assert.strictEqual(snap.lastErrorRecovered, true)
  const node = engine.getRoom(roomKey).nodes[uid]
  assert.ok(!node || node.deleted)
}

async function testDropPendingInsertThenDelete() {
  const roomKey = 'room-drop-insert'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const uid = 'drop-me-uid'
  a.socket.connected = false
  const insertP = a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid, parent: 'root', text: 'soon gone' }
  })
  await wait(80)
  assert.ok(a.adapter.getStatus().outboxPending >= 1)
  const dropped = await a.adapter.dropPendingInsertsForUid(uid)
  assert.ok(dropped >= 1)
  await assert.rejects(() => insertP, err => err && err.code === 'DROPPED_DELETED')
  a.socket.connected = true
  await assert.rejects(
    () =>
      a.adapter.submitOperation({
        type: 'node.delete',
        payload: { uid }
      }),
    err =>
      err && (err.code === 'TARGET_DELETED' || err.code === 'NODE_DELETED')
  )
  await wait(40)
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.currentError, null)
  assert.notStrictEqual(snap.saveState, 'error')
  const listed = await a.adapter.outbox.list(a.adapter.getClientId(), roomKey)
  assert.strictEqual(
    listed.filter(item => item && item.status !== 'acked').length,
    0
  )
}

async function testDeleteAfterAckedInsert() {
  const roomKey = 'room-del-acked'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'keep-tree', parent: 'root', text: 'keep' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'gone-node', parent: 'root', text: 'gone' }
  })
  await a.adapter.submitOperation({
    type: 'node.delete',
    payload: { uid: 'gone-node' }
  })
  await wait(40)
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.currentError, null)
  assert.notStrictEqual(snap.saveState, 'error')
  assert.ok(engine.getRoom(roomKey).nodes['keep-tree'])
  const gone = engine.getRoom(roomKey).nodes['gone-node']
  assert.ok(!gone || gone.deleted)
  await wait(80)
  const ops = engine.opsAfter(roomKey, 0, 50).operations || []
  const reinsert = ops.filter(
    item =>
      (item.type === 'node.insert' || item.type === 'node.inserted') &&
      item.payload &&
      item.payload.uid === 'gone-node'
  )
  assert.strictEqual(reinsert.length, 1)
}

async function testUpdateDoesNotReorderRemoteSiblings() {
  const roomKey = 'room-update-order'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  for (const [uid, text] of [
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
    ['d', 'D'],
    ['e', 'E']
  ]) {
    await a.adapter.submitOperation({
      type: 'node.insert',
      payload: { uid, parent: 'root', text }
    })
  }
  const before = (engine.getRoom(roomKey).nodes.root.children || []).slice()
  assert.deepStrictEqual(before, ['a', 'b', 'c', 'd', 'e'])
  const up = await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'c', text: 'C2' }
  })
  const ev = up.operation && up.operation.event
  assert.ok(ev)
  assert.strictEqual(ev.payload.index, undefined)
  assert.strictEqual(ev.payload.parentUid, undefined)
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'd', text: 'D2', index: -1 }
  })
  await wait(40)
  const after = (engine.getRoom(roomKey).nodes.root.children || []).slice()
  assert.deepStrictEqual(after, before)
  assert.strictEqual(nodeText(engine, roomKey, 'c'), 'C2')
  assert.strictEqual(nodeText(engine, roomKey, 'd'), 'D2')
  const remoteUpdate = b.applied.filter(
    op => op.event && op.event.type === 'node.updated' && op.event.payload && op.event.payload.uid === 'c'
  )
  assert.ok(remoteUpdate.length >= 1)
  assert.strictEqual(remoteUpdate[0].event.payload.index, undefined)
}

async function testPresenceDoesNotChangeSaveState() {
  const roomKey = 'room-presence-save'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  assert.strictEqual(a.adapter.getStatus().saveState, 'saved')
  const pendingBefore = a.adapter.getStatus().pendingCount
  for (let i = 0; i < 100; i++) {
    a.socket._emit('presence:state', {
      roomKey,
      peers: [
        { clientId: 'peer-' + i, userId: 'B', selectedUids: ['root'], editingUid: null }
      ]
    })
  }
  const snap = a.adapter.getStatus()
  assert.strictEqual(snap.saveState, 'saved')
  assert.strictEqual(snap.outboxPending, 0)
  assert.strictEqual(snap.pendingCount, pendingBefore)
  await wait(40)
  assert.strictEqual(a.adapter.getStatus().saveState, 'saved')
}

async function testReplaceAllConflictViaAdapter() {
  const roomKey = 'room-replace-adapter'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: 'Beta' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: 'Beta' }
  })
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', text: 'Changed' }
  })
  const result = await a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      batchId: randomUUID(),
      ops: [
        {
          type: 'node.update',
          payload: { uid: 'n1', text: 'Beta-X', expected: { text: 'Beta' } }
        },
        {
          type: 'node.update',
          payload: { uid: 'n2', text: 'Beta-X', expected: { text: 'Beta' } }
        }
      ]
    }
  })
  assert.strictEqual(nodeText(engine, roomKey, 'n1'), 'Changed')
  assert.strictEqual(nodeText(engine, roomKey, 'n2'), 'Beta-X')
  const skipped =
    result.operation &&
    result.operation.event &&
    result.operation.event.payload &&
    result.operation.event.payload.skipped
  assert.strictEqual(Number(skipped || 0), 1)
}

async function testThreeDuplicateBetaReplaceOneAndAll() {
  const roomKey = 'room-three-beta-one'
  const engine = createEngine()
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid1', parent: 'root', text: 'Beta' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid2', parent: 'root', text: 'Beta' }
  })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid3', parent: 'root', text: 'Beta' }
  })
  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'uid2', text: 'Beta-X', expected: { text: 'Beta' } }
  })
  await wait(30)
  assert.strictEqual(nodeText(engine, roomKey, 'uid1'), 'Beta')
  assert.strictEqual(nodeText(engine, roomKey, 'uid2'), 'Beta-X')
  assert.strictEqual(nodeText(engine, roomKey, 'uid3'), 'Beta')

  const roomAll = 'room-three-beta-all'
  const engine2 = createEngine()
  const hub2 = createHub(engine2)
  const c = await makeClient(hub2, { roomKey: roomAll, userId: 'A' })
  const d = await makeClient(hub2, { roomKey: roomAll, userId: 'B' })
  await c.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid1', parent: 'root', text: 'Beta' }
  })
  await c.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid2', parent: 'root', text: 'Beta' }
  })
  await c.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'uid3', parent: 'root', text: 'Beta' }
  })
  const result = await c.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      batchId: randomUUID(),
      ops: ['uid1', 'uid2', 'uid3'].map(uid => ({
        type: 'node.update',
        payload: { uid, text: 'Beta-X', expected: { text: 'Beta' } }
      }))
    }
  })
  await wait(30)
  assert.strictEqual(nodeText(engine2, roomAll, 'uid1'), 'Beta-X')
  assert.strictEqual(nodeText(engine2, roomAll, 'uid2'), 'Beta-X')
  assert.strictEqual(nodeText(engine2, roomAll, 'uid3'), 'Beta-X')
  const skipped =
    result.operation &&
    result.operation.event &&
    result.operation.event.payload &&
    result.operation.event.payload.skipped
  assert.strictEqual(Number(skipped || 0), 0)
  assert.strictEqual(nodeText(engine2, roomAll, 'uid1'), nodeText(engine2, roomAll, 'uid2'))
  void b
  void d
}

async function testQueryNeedsSearchWithoutEnter() {
  const {
    queryNeedsSearch,
    dedupeMatchesByUid
  } = require('../bin/roomNodes')
  assert.strictEqual(queryNeedsSearch('Beta', ''), true)
  assert.strictEqual(queryNeedsSearch('Beta', 'Alpha'), true)
  assert.strictEqual(queryNeedsSearch('Beta', 'Beta'), false)
  const hits = dedupeMatchesByUid([
    { uid: 'uid1', text: 'Beta' },
    { uid: 'uid2', text: 'Beta' },
    { uid: 'uid3', text: 'Beta' }
  ])
  assert.strictEqual(hits.length, 3)
}

async function testGapPagination() {
  const roomKey = 'room-gap'
  const engine = createEngine()
  engine.getRoom(roomKey)
  for (let i = 0; i < 12; i++) {
    await engine.submit(
      {
        opId: randomUUID(),
        type: 'node.update',
        roomKey,
        userId: 'A',
        clientId: 'gap-page-a',
        payload: { uid: 'root', text: 'v' + i }
      },
      { canEdit: true, userId: 'A' }
    )
  }
  const page = engine.opsAfter(roomKey, 0, 5)
  assert.strictEqual(page.reload, false)
  assert.strictEqual(page.hasMore, true)
  assert.strictEqual(page.operations.length, 5)
  const rest = engine.opsAfter(roomKey, page.operations[4].serverRevision, 20)
  assert.strictEqual(rest.hasMore, false)
  assert.ok(rest.operations.length >= 7)
}

async function main() {
  await testProtocolAndOutbox()
  await testPresenceSoftLock()
  await testThreeClientsAndConflicts()
  await testAckLossReconnectGapUndoTabs()
  await testViewerAndDemote()
  await testOfflineOutboxRefresh()
  await testUndoRedoConflictAndRestore()
  await testGapPagination()
  await testSaveStateFromSocketOutboxAck()
  await testStructuredLastError()
  await testEmptyClientIdRejected()
  await testSameUserTwoClients()
  await testDifferentUserTwoClients()
  await testSequentialOutboxDrainBurst()
  await testRapidTextThirty()
  await testPasteThenImmediateUpdate()
  await testVersionAheadRecoveryAndStaleOutbox()
  await testTwoClientsInterleaveWithoutAhead()
  await testErrorClearsAfterRecovery()
  await testTextInsertDeleteUndoRedo()
  await testSequentialAndMultiUserUndo()
  await testUidReusedSkipDoesNotSticky()
  await testDropPendingInsertThenDelete()
  await testDeleteAfterAckedInsert()
  await testUpdateDoesNotReorderRemoteSiblings()
  await testPresenceDoesNotChangeSaveState()
  await testReplaceAllConflictViaAdapter()
  await testThreeDuplicateBetaReplaceOneAndAll()
  await testQueryNeedsSearchWithoutEnter()
  console.log('collabV2 tests ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
