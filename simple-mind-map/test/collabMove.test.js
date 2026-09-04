const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyCollabEvent } = require('../bin/collabRecovery')
const {
  planNativeMove,
  collectMovesAfterCommand,
  snapshotMoveOrigins,
  isCycleMove,
  remainingSiblings,
  connectorSlots
} = require('../src/utils/collabMove')

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

function kids(engine, roomKey, uid) {
  return (engine.getRoom(roomKey).nodes[uid] &&
    engine.getRoom(roomKey).nodes[uid].children) || []
}

function seedBush(count) {
  const nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    nodes[uid] = { data: { uid, text: 'N' + i }, children: [] }
    nodes[parent].children.push(uid)
  }
  return nodes
}

;(async () => {
  const parentKids = [
    { data: { uid: 'A' } },
    { data: { uid: 'B' } },
    { data: { uid: 'C' } },
    { data: { uid: 'D' } }
  ]
  const reorder = planNativeMove({
    uid: 'C',
    parentUid: 'P',
    oldParentUid: 'P',
    index: 1,
    parentKids
  })
  assert.strictEqual(reorder.kind, 'reorder')
  assert.strictEqual(reorder.command, 'INSERT_BEFORE')
  assert.strictEqual(reorder.anchorUid, 'B')

  const cross = planNativeMove({
    uid: 'B',
    parentUid: 'P2',
    oldParentUid: 'P1',
    index: 1,
    parentKids: [{ data: { uid: 'C' } }, { data: { uid: 'B' } }]
  })
  assert.strictEqual(cross.kind, 'move')
  assert.strictEqual(cross.command, 'INSERT_AFTER')
  assert.strictEqual(cross.anchorUid, 'C')

  const aNode = {
    isRoot: false,
    getData: key => (key === 'uid' ? 'B' : undefined),
    uid: 'B',
    parent: {
      getData: key => (key === 'uid' ? 'P2' : undefined),
      uid: 'P2',
      nodeData: {
        children: [{ data: { uid: 'C' } }, { data: { uid: 'B' } }]
      }
    }
  }
  const collected = collectMovesAfterCommand('MOVE_NODE_TO', [aNode, aNode.parent])
  assert.strictEqual(collected[0].parent, 'P2')
  assert.strictEqual(collected[0].index, 1)

  const origin = snapshotMoveOrigins([
    {
      isRoot: false,
      getData: key => (key === 'uid' ? 'B' : undefined),
      parent: {
        getData: key => (key === 'uid' ? 'P1' : undefined),
        nodeData: { children: [{ data: { uid: 'A' } }, { data: { uid: 'B' } }] }
      }
    }
  ])
  assert.strictEqual(origin[0].parent, 'P1')
  assert.strictEqual(origin[0].index, 1)

  const subtree = {
    uid: 'X',
    getData: key => (key === 'uid' ? 'X' : undefined),
    nodeData: {
      children: [
        { data: { uid: 'X1' }, children: [] },
        { data: { uid: 'X2' }, children: [] }
      ]
    }
  }
  assert.strictEqual(isCycleMove(subtree, 'X1'), true)
  assert.strictEqual(isCycleMove(subtree, 'P2'), false)
  assert.strictEqual(isCycleMove(subtree, 'X'), true)
  assert.strictEqual(remainingSiblings(parentKids, 'C').map(item => item.data.uid).join(','), 'A,B,D')
  assert.strictEqual(connectorSlots([], true, 3), 0, 'last-child move must not keep stale connectors')
  assert.strictEqual(connectorSlots([], false, 3), 3, 'collapsed lazy still uses childCount')
  assert.strictEqual(connectorSlots([{ uid: 'A' }], true, 3), 1)

  const { dataFields } = require('../bin/collabV2/directApplier')
  const stripped = dataFields({
    uid: 'C',
    parent: 'P',
    parentUid: 'P',
    index: 1,
    oldParentUid: 'P',
    newParentUid: 'P2',
    oldIndex: 2,
    kind: 'move',
    text: 'keep'
  })
  assert.strictEqual(stripped.parent, undefined)
  assert.strictEqual(stripped.oldParentUid, undefined)
  assert.strictEqual(stripped.kind, undefined)
  assert.strictEqual(stripped.text, 'keep')

  const coop = {
    _v2MoveActive: true,
    _v2MoveAllowReplace: false,
    _moveFullTreeHits: 0,
    markMoveFullTreeForbidden(reason) {
      this._moveFullTreeHits += 1
      this.reason = reason
    }
  }
  function setDataDuringMove(cooperate) {
    if (cooperate && cooperate._v2MoveActive && !cooperate._v2MoveAllowReplace) {
      cooperate.markMoveFullTreeForbidden('Render.setData')
      return 'blocked'
    }
    return 'replaced'
  }
  assert.strictEqual(setDataDuringMove(coop), 'blocked')
  assert.strictEqual(coop._moveFullTreeHits, 1)
  assert.strictEqual(coop.reason, 'Render.setData')

  const dragState = {
    clone: { remove() { this.gone = true } },
    placeholder: { remove() { this.gone = true } },
    placeHolderLine: { remove() { this.gone = true } },
    placeHolderExtraLines: [
      { remove() { this.gone = true } },
      { remove() { this.gone = true } }
    ]
  }
  function cleanupDragArtifacts(state) {
    ;['clone', 'placeholder', 'placeHolderLine'].forEach(key => {
      if (state[key] && typeof state[key].remove === 'function') state[key].remove()
      state[key] = null
    })
    ;(state.placeHolderExtraLines || []).forEach(item => {
      if (item && typeof item.remove === 'function') item.remove()
    })
    state.placeHolderExtraLines = []
  }
  const extra = dragState.placeHolderExtraLines.slice()
  cleanupDragArtifacts(dragState)
  assert.ok(extra.every(item => item.gone))
  assert.strictEqual(dragState.placeHolderExtraLines.length, 0)
  assert.strictEqual(dragState.clone, null)

  const engine = createEngine()
  const roomKey = 'move-lifecycle'
  engine.getRoom(roomKey)
  const access = { userId: 'A', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'P', parent: 'root', text: 'P' }
    },
    access
  )
  for (const uid of ['A', 'B', 'C', 'D']) {
    await engine.submit(
      {
        roomKey,
        opId: randomUUID(),
        clientId: 'c1',
        type: 'node.insert',
        payload: { uid, parent: 'P', text: uid }
      },
      access
    )
  }

  const reorderOp = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.move',
      payload: { uid: 'C', parent: 'P', index: 1 }
    },
    access
  )
  assert.notStrictEqual(reorderOp.operation.event.type, 'map.replaced')
  assert.ok(
    reorderOp.operation.event.type === 'node.moved' ||
      reorderOp.operation.event.type === 'node.reordered'
  )
  assert.deepStrictEqual(kids(engine, roomKey, 'P'), ['A', 'C', 'B', 'D'])
  const storeRow = await engine.getRoom(roomKey).store.getLive('C')
  assert.strictEqual(storeRow.parent_uid, 'P')
  assert.ok(!storeRow.deleted)

  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'P2', parent: 'root', text: 'P2' }
    },
    access
  )
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'E', parent: 'P2', text: 'E' }
    },
    access
  )
  const crossOp = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.move',
      payload: { uid: 'B', parent: 'P2', index: 1 }
    },
    access
  )
  assert.notStrictEqual(crossOp.operation.event.type, 'map.replaced')
  assert.ok(!kids(engine, roomKey, 'P').includes('B'))
  assert.ok(kids(engine, roomKey, 'P2').includes('B'))
  const bLive = await engine.getRoom(roomKey).store.getLive('B')
  assert.strictEqual(bLive.parent_uid, 'P2')

  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'X', parent: 'root', text: 'X' }
    },
    access
  )
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'X1', parent: 'X', text: 'X1' }
    },
    access
  )
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'X2', parent: 'X', text: 'X2' }
    },
    access
  )
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.move',
      payload: { uid: 'X', parent: 'P2', index: 2 }
    },
    access
  )
  const x1 = await engine.getRoom(roomKey).store.getLive('X1')
  const x2 = await engine.getRoom(roomKey).store.getLive('X2')
  assert.strictEqual(x1.parent_uid, 'X')
  assert.strictEqual(x2.parent_uid, 'X')
  const xLive = await engine.getRoom(roomKey).store.getLive('X')
  assert.strictEqual(xLive.parent_uid, 'P2')

  let cycle = null
  try {
    await engine.submit(
      {
        roomKey,
        opId: randomUUID(),
        clientId: 'c1',
        type: 'node.move',
        payload: { uid: 'P2', parent: 'X', index: 0 }
      },
      access
    )
  } catch (err) {
    cycle = err
  }
  assert.ok(cycle)
  assert.strictEqual(cycle.code, 'CYCLE_REJECTED')

  const moveRoom = 'move-conflict'
  engine.getRoom(moveRoom)
  await engine.submit(
    {
      roomKey: moveRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'n1', parent: 'root', text: 'n1' }
    },
    access
  )
  await engine.submit(
    {
      roomKey: moveRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'p1', parent: 'root', text: 'p1' }
    },
    access
  )
  await engine.submit(
    {
      roomKey: moveRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'p2', parent: 'root', text: 'p2' }
    },
    access
  )
  await Promise.all([
    engine.submit(
      {
        roomKey: moveRoom,
        opId: randomUUID(),
        clientId: 'ca',
        type: 'node.move',
        payload: { uid: 'n1', parent: 'p1', index: 0 }
      },
      { userId: 'A', role: 'editor', canEdit: true }
    ),
    engine.submit(
      {
        roomKey: moveRoom,
        opId: randomUUID(),
        clientId: 'cb',
        type: 'node.move',
        payload: { uid: 'n1', parent: 'p2', index: 0 }
      },
      { userId: 'B', role: 'editor', canEdit: true }
    )
  ])
  const n1 = await engine.getRoom(moveRoom).store.getLive('n1')
  assert.ok(n1.parent_uid === 'p1' || n1.parent_uid === 'p2')
  assert.ok(!engine.getRoom(moveRoom).nodes.n1.data.deleted)

  await engine.submit(
    {
      roomKey: moveRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'gone', parent: 'root', text: 'gone' }
    },
    access
  )
  await engine.submit(
    {
      roomKey: moveRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.delete',
      payload: { uid: 'gone' }
    },
    access
  )
  let deletedMove = null
  try {
    await engine.submit(
      {
        roomKey: moveRoom,
        opId: randomUUID(),
        clientId: 'c1',
        type: 'node.move',
        payload: { uid: 'gone', parent: 'p1', index: 0 }
      },
      access
    )
  } catch (err) {
    deletedMove = err
  }
  assert.ok(deletedMove)
  assert.ok(
    deletedMove.code === 'TARGET_DELETED' || deletedMove.code === 'NODE_DELETED'
  )
  assert.ok(!(await engine.getRoom(moveRoom).store.getLive('gone')))

  const echoRoom = 'move-echo'
  engine.getRoom(echoRoom)
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey: echoRoom, userId: 'EA' })
  const b = await makeClient(hub, { roomKey: echoRoom, userId: 'EB' })
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'm1', parent: 'root', text: 'm1' }
  })
  await wait()
  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'm2', parent: 'root', text: 'm2' }
  })
  await wait()
  const before = b.applied.length
  await a.adapter.submitOperation({
    type: 'node.move',
    payload: { uid: 'm2', parent: 'm1', index: 0 }
  })
  await wait()
  const remoteMoves = b.applied.filter(
    op =>
      op.event &&
      (op.event.type === 'node.moved' || op.event.type === 'node.reordered')
  )
  assert.ok(remoteMoves.length >= 1, 'B received remote move')
  assert.ok(
    !remoteMoves.some(op => op.event && op.event.type === 'map.replaced'),
    'remote move is not full-tree replace'
  )
  assert.ok(b.applied.length >= before)
  const m2 = await engine.getRoom(echoRoom).store.getLive('m2')
  assert.strictEqual(m2.parent_uid, 'm1')
  assert.strictEqual(
    a.applied.filter(
      op =>
        op.event &&
        (op.event.type === 'node.moved' || op.event.type === 'node.reordered')
    ).length,
    0,
    'origin client does not receive echo of own move'
  )
  assert.ok(
    !b.applied.some(op => op.event && op.event.type === 'map.replaced'),
    'B remote apply is not full-tree replace'
  )

  const undoRoom = 'move-undo'
  engine.getRoom(undoRoom)
  const undoAccess = { userId: 'U', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.insert',
      payload: { uid: 'uP', parent: 'root', text: 'uP' }
    },
    undoAccess
  )
  await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.insert',
      payload: { uid: 'u1n', parent: 'root', text: 'u1n' }
    },
    undoAccess
  )
  const moved = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'node.move',
      payload: { uid: 'u1n', parent: 'uP', index: 0 }
    },
    undoAccess
  )
  assert.strictEqual(moved.operation.inversePayload.type, 'node.move')
  const undone = await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.undo',
      payload: { targetOperationId: moved.operation.opId }
    },
    undoAccess
  )
  assert.notStrictEqual(undone.operation.event.type, 'map.replaced')
  const afterUndo = await engine.getRoom(undoRoom).store.getLive('u1n')
  assert.strictEqual(afterUndo.parent_uid, 'root')
  await engine.submit(
    {
      roomKey: undoRoom,
      opId: randomUUID(),
      clientId: 'u1',
      type: 'operation.redo',
      payload: { targetOperationId: moved.operation.opId }
    },
    undoAccess
  )
  const afterRedo = await engine.getRoom(undoRoom).store.getLive('u1n')
  assert.strictEqual(afterRedo.parent_uid, 'uP')

  const burstRoom = 'move-burst'
  engine.getRoom(burstRoom)
  await engine.submit(
    {
      roomKey: burstRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'burstP', parent: 'root', text: 'burstP' }
    },
    access
  )
  await engine.submit(
    {
      roomKey: burstRoom,
      opId: randomUUID(),
      clientId: 'c1',
      type: 'node.insert',
      payload: { uid: 'leaf', parent: 'root', text: 'leaf' }
    },
    access
  )
  for (let i = 0; i < 20; i++) {
    await engine.submit(
      {
        roomKey: burstRoom,
        opId: randomUUID(),
        clientId: 'c1',
        type: 'node.move',
        payload: {
          uid: 'leaf',
          parent: i % 2 === 0 ? 'burstP' : 'root',
          index: 0
        }
      },
      access
    )
  }
  const leaf = await engine.getRoom(burstRoom).store.getLive('leaf')
  assert.ok(leaf.parent_uid === 'burstP' || leaf.parent_uid === 'root')
  assert.ok(!engine.getRoom(burstRoom).ops.some(op => op.type === 'map.replaced'))

  let nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: ['P'] },
    P: {
      isRoot: false,
      data: { uid: 'P', text: 'P', expand: false },
      children: ['keep']
    },
    keep: { isRoot: false, data: { uid: 'keep', text: 'keep' }, children: [] },
    leaf2: { isRoot: false, data: { uid: 'leaf2', text: 'leaf2' }, children: [] }
  }
  nodes.root.children.push('leaf2')
  nodes = applyCollabEvent(nodes, {
    type: 'node.moved',
    payload: { uid: 'leaf2', parentUid: 'P', index: 1 }
  })
  assert.ok(nodes.P.children.includes('leaf2'))
  assert.ok(!nodes.root.children.includes('leaf2'))
  assert.strictEqual(nodes.P.data.expand, false)

  const timings = {}
  for (const size of [10000, 20000]) {
    const store = createMemoryStore(seedBush(size))
    store.resetStats()
    const t0 = process.hrtime.bigint()
    await applyDirect(
      store,
      {
        type: 'node.move',
        payload: { uid: 'n' + (size - 1), parent: 'n0', index: 0 }
      },
      { version: 2 }
    )
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const live = await store.getLive('n' + (size - 1))
    assert.strictEqual(live.parent_uid, 'n0')
    assert.ok(store.stats.reads < 80, size + ' move reads ' + store.stats.reads)
    timings[size] = {
      ms: Number(ms.toFixed(2)),
      reads: store.stats.reads,
      writes: store.stats.writes
    }
  }

  console.log('collabMove.test.js ok', timings)
})().catch(err => {
  console.error(err)
  process.exit(1)
})
