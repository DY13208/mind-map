const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { applyCollabEvent } = require('../bin/collabRecovery')
const { patchDelta } = require('../bin/fieldMerge')
const {
  snapshotValue,
  generalizationSignature,
  ownerGeneralizationPayload,
  mergeVirtualEditIntoOwner
} = require('../src/utils/collabGeneralization')

function wait(ms = 20) {
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
        const sync = engine.opsAfter(payload.roomKey, payload.lastServerRevision)
        reply({
          ok: true,
          role: socket.access.role,
          canEdit: !!socket.access.canEdit,
          serverRevision: engine.getRoom(payload.roomKey).revision,
          sync
        })
        return
      }
      if (event === 'op') {
        const result = await engine.submit(
          { ...payload, userId: socket.access.userId },
          socket.access
        )
        reply({
          ok: true,
          opId: result.operation.opId,
          serverRevision: result.operation.serverRevision,
          duplicate: result.duplicate,
          operation: result.operation
        })
        if (!result.duplicate) {
          broadcast(
            result.operation.roomKey,
            socket.id,
            'op:event',
            result.operation
          )
        }
      }
    } catch (err) {
      reply({ ok: false, code: err.code, error: err.message })
    }
  }
  function createSocket(access) {
    const handlers = {}
    const socket = {
      id: randomUUID(),
      connected: true,
      access,
      roomKey: '',
      on(ev, fn) {
        handlers[ev] = handlers[ev] || []
        handlers[ev].push(fn)
      },
      emit(ev, payload, cb) {
        Promise.resolve().then(() => handle(socket, ev, payload, cb))
      },
      disconnect() {
        socket.connected = false
      },
      _emit(ev, data) {
        ;(handlers[ev] || []).forEach(fn => fn(data))
      }
    }
    sockets.set(socket.id, socket)
    return socket
  }
  return { createSocket }
}

async function makeClient(hub, opts) {
  const applied = []
  const socket = hub.createSocket({
    canEdit: true,
    role: 'editor',
    userId: opts.userId
  })
  const adapter = createCollaborationAdapter({
    clientId: opts.clientId || randomUUID(),
    memory: true,
    socket,
    onRemoteOperation: op => applied.push(op)
  })
  await adapter.connect({
    url: 'mem',
    roomKey: opts.roomKey,
    userId: opts.userId
  })
  return { adapter, applied, socket }
}

function nodeOf(engine, roomKey, uid) {
  return engine.getRoom(roomKey).nodes[uid]
}

function genOf(engine, roomKey, uid) {
  const node = nodeOf(engine, roomKey, uid)
  return node && node.data && node.data.generalization
}

;(async () => {
  const live = [{ uid: 'g1', text: '概要A', color: '#111' }]
  const pushed = { generalization: snapshotValue(live) }
  live[0].text = '概要B'
  const delta = patchDelta(pushed, { generalization: live })
  assert.ok(delta.generalization, 'cloned snapshot still detects in-place gen text edit')
  assert.strictEqual(delta.generalization[0].text, '概要B')
  live[0].color = '#f00'
  assert.notStrictEqual(
    generalizationSignature(pushed.generalization),
    generalizationSignature(live),
    'style change is part of generalization signature'
  )

  const roomKey = 'gen-lifecycle'
  const engine = createEngine()
  engine.getRoom(roomKey)
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })
  const access = { userId: 'A', role: 'editor', canEdit: true }

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: 'Owner' }
  })
  await wait()

  const created = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'client-a',
      type: 'node.update',
      payload: {
        uid: 'n1',
        generalization: [{ uid: 'g1', text: '概要A', range: [0, 0] }]
      }
    },
    access
  )
  assert.strictEqual(created.operation.event.type, 'node.updated')
  assert.strictEqual(created.operation.event.payload.uid, 'n1')
  assert.strictEqual(genOf(engine, roomKey, 'n1')[0].text, '概要A')
  assert.ok(!nodeOf(engine, roomKey, 'g1'), 'virtual gen uid is not a room_nodes row')

  const edited = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'client-a',
      type: 'node.update',
      payload: {
        uid: 'n1',
        generalization: [{ uid: 'g1', text: '概要B', range: [0, 0] }]
      }
    },
    access
  )
  assert.strictEqual(edited.operation.event.type, 'node.updated')
  assert.strictEqual(edited.operation.inversePayload.type, 'node.update')
  assert.notStrictEqual(edited.operation.event.type, 'map.replaced')
  assert.strictEqual(genOf(engine, roomKey, 'n1')[0].text, '概要B')

  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'client-a',
      type: 'node.update',
      payload: {
        uid: 'n1',
        generalization: [
          {
            uid: 'g1',
            text: '概要B',
            range: [0, 0],
            color: '#ff0000',
            fillColor: '#ffffff'
          }
        ]
      }
    },
    access
  )
  assert.strictEqual(genOf(engine, roomKey, 'n1')[0].color, '#ff0000')
  assert.ok(!nodeOf(engine, roomKey, 'g1'))

  const deleted = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'client-a',
      type: 'node.update',
      payload: { uid: 'n1', generalization: null }
    },
    access
  )
  assert.strictEqual(deleted.operation.event.type, 'node.updated')
  assert.strictEqual(deleted.operation.inversePayload.type, 'node.update')
  assert.notStrictEqual(deleted.operation.inversePayload.type, 'node.delete')
  assert.notStrictEqual(deleted.operation.inversePayload.type, 'node.insert')
  const inverse = deleted.operation.inversePayload.payload || {}
  const patch = inverse.patch || inverse
  assert.ok(Array.isArray(patch.generalization), 'delete inverse restores generalization')
  assert.ok(!genOf(engine, roomKey, 'n1') || !genOf(engine, roomKey, 'n1').length)

  const undoRoom = 'gen-undo'
  engine.getRoom(undoRoom)
  const undoAccess = { userId: 'U', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.insert',
      payload: { uid: 'n1', parent: 'root', text: 'Owner' }
    },
    undoAccess
  )
  const genA = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.update',
      payload: { uid: 'n1', generalization: [{ uid: 'g1', text: 'A' }] }
    },
    undoAccess
  )
  const genB = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.update',
      payload: { uid: 'n1', generalization: [{ uid: 'g1', text: 'B' }] }
    },
    undoAccess
  )
  const undoEdit = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.undo',
      payload: { targetOperationId: genB.operation.opId }
    },
    undoAccess
  )
  assert.notStrictEqual(undoEdit.operation.event.type, 'map.replaced')
  assert.strictEqual(genOf(engine, undoRoom, 'n1')[0].text, 'A')
  const redoEdit = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.redo',
      payload: { targetOperationId: genB.operation.opId }
    },
    undoAccess
  )
  assert.strictEqual(genOf(engine, undoRoom, 'n1')[0].text, 'B')
  const genDel = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.update',
      payload: { uid: 'n1', generalization: null }
    },
    undoAccess
  )
  const undoDel = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.undo',
      payload: { targetOperationId: genDel.operation.opId }
    },
    undoAccess
  )
  assert.notStrictEqual(undoDel.operation.event.type, 'map.replaced')
  assert.strictEqual(genOf(engine, undoRoom, 'n1')[0].uid, 'g1')
  await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.redo',
      payload: { targetOperationId: genDel.operation.opId }
    },
    undoAccess
  )
  assert.ok(!genOf(engine, undoRoom, 'n1') || !genOf(engine, undoRoom, 'n1').length)
  void genA
  void redoEdit
  void a
  void b
  void access

  const remoteRoom = 'gen-remote'
  engine.getRoom(remoteRoom)
  const hubRemote = createHub(engine)
  const remoteA = await makeClient(hubRemote, { roomKey: remoteRoom, userId: 'A2' })
  const remoteB = await makeClient(hubRemote, { roomKey: remoteRoom, userId: 'B2' })
  await remoteA.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: 'Owner' }
  })
  await wait()
  await remoteA.adapter.submitOperation({
    type: 'node.update',
    payload: {
      uid: 'n1',
      generalization: [{ uid: 'g1', text: 'remote-A', color: '#123' }]
    }
  })
  await wait()
  assert.ok(
    remoteB.applied.some(op => {
      const event = (op && op.event) || op || {}
      const payload = event.payload || (op && op.payload) || {}
      return (
        (event.type === 'node.updated' || op.type === 'node.updated') &&
        payload.uid === 'n1'
      )
    }),
    'B received remote gen update'
  )
  assert.strictEqual(genOf(engine, remoteRoom, 'n1')[0].text, 'remote-A')
  assert.strictEqual(genOf(engine, remoteRoom, 'n1')[0].color, '#123')
  assert.ok(!nodeOf(engine, remoteRoom, 'g1'))
  assert.ok(
    !remoteB.applied.some(
      op => op.event && op.event.type === 'map.replaced'
    ),
    'remote gen edit is not full-tree replace'
  )
  void remoteA

  const room2 = 'gen-concurrent'
  engine.getRoom(room2)
  const hub2 = createHub(engine)
  const c = await makeClient(hub2, { roomKey: room2, userId: 'C' })
  const d = await makeClient(hub2, { roomKey: room2, userId: 'D' })
  await c.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: 'Owner2' }
  })
  await wait()
  await engine.submit(
    {
      roomKey: room2,
      opId: randomUUID(),
      clientId: 'client-c',
      type: 'node.update',
      payload: { uid: 'n2', generalization: [{ uid: 'g2', text: 'base' }] }
    },
    { userId: 'C', role: 'editor', canEdit: true }
  )
  await Promise.all([
    engine.submit(
      {
        roomKey: room2,
        opId: randomUUID(),
        clientId: 'client-c',
        type: 'node.update',
        payload: { uid: 'n2', generalization: [{ uid: 'g2', text: 'from-C' }] }
      },
      { userId: 'C', role: 'editor', canEdit: true }
    ),
    engine.submit(
      {
        roomKey: room2,
        opId: randomUUID(),
        clientId: 'client-d',
        type: 'node.update',
        payload: { uid: 'n2', generalization: [{ uid: 'g2', text: 'from-D' }] }
      },
      { userId: 'D', role: 'editor', canEdit: true }
    )
  ])
  const concurrent = genOf(engine, room2, 'n2')[0].text
  assert.ok(concurrent === 'from-C' || concurrent === 'from-D')
  assert.ok(!nodeOf(engine, room2, 'g2'))
  void c
  void d

  let nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: ['n1'] },
    n1: {
      isRoot: false,
      data: {
        uid: 'n1',
        text: 'Owner',
        generalization: [{ uid: 'g1', text: '概要' }]
      },
      children: []
    }
  }
  nodes = applyCollabEvent(nodes, {
    type: 'node.inserted',
    payload: {
      uid: 'p1',
      parentUid: 'root',
      text: 'Pasted',
      data: {
        uid: 'p1',
        text: 'Pasted',
        generalization: [{ uid: 'g-copy', text: '粘贴概要', color: '#00f' }]
      }
    }
  })
  assert.ok(nodes.p1)
  assert.strictEqual(nodes.p1.data.generalization[0].text, '粘贴概要')
  assert.ok(!nodes['g-copy'], 'pasted generalization is not a tree child')

  const payload = ownerGeneralizationPayload([
    { uid: 'g1', text: 'x', inserting: true }
  ])
  assert.strictEqual(payload[0].text, 'x')
  assert.strictEqual(payload[0].inserting, undefined)
  payload[0].text = 'mutated'
  assert.strictEqual(payload[0].text, 'mutated')

  const remapped = mergeVirtualEditIntoOwner(
    [{ uid: 'g1', text: '概要A', color: '#111' }],
    'g1',
    { text: '概要B', color: '#f00', richText: true }
  )
  assert.strictEqual(remapped[0].uid, 'g1')
  assert.strictEqual(remapped[0].text, '概要B')
  assert.strictEqual(remapped[0].color, '#f00')
  assert.strictEqual(remapped[0].richText, true)
  assert.ok(!nodeOf(engine, roomKey, 'g1'))
  assert.ok(!nodeOf(engine, undoRoom, 'g1'))
  assert.ok(!nodeOf(engine, room2, 'g2'))

  console.log('collabGeneralization.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
