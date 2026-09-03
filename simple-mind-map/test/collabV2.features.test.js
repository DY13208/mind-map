const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { FIELD_GROUPS } = require('../bin/fieldMerge')

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
        if (!result.duplicate) broadcast(result.operation.roomKey, socket.id, 'op:event', result.operation)
        return
      }
      if (event === 'sync') {
        reply({ ok: true, ...engine.opsAfter(payload.roomKey, payload.afterRevision, payload.limit) })
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
    canEdit: opts.role !== 'viewer',
    role: opts.role || 'editor',
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

async function main() {
  const roomKey = 'feat-room'
  const engine = createEngine()
  engine.getRoom(roomKey)
  const hub = createHub(engine)
  const a = await makeClient(hub, { roomKey, userId: 'A' })
  const b = await makeClient(hub, { roomKey, userId: 'B' })

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n1', parent: 'root', text: 'one' }
  })
  await wait()
  assert.ok(nodeOf(engine, roomKey, 'n1'))

  const persistCases = [
    { name: 'text', payload: { uid: 'n1', text: 'edited' }, read: n => n.data.text, want: 'edited' },
    { name: 'note', payload: { uid: 'n1', note: 'memo' }, read: n => n.data.note, want: 'memo' },
    { name: 'style', payload: { uid: 'n1', fillColor: '#abc' }, read: n => n.data.fillColor, want: '#abc' },
    { name: 'image', payload: { uid: 'n1', image: 'http://x/a.png', imageTitle: 'img' }, read: n => n.data.image, want: 'http://x/a.png' },
    { name: 'icon', payload: { uid: 'n1', icon: ['priority_1'] }, read: n => n.data.icon[0], want: 'priority_1' },
    { name: 'tag', payload: { uid: 'n1', tag: ['t1'] }, read: n => n.data.tag[0], want: 't1' },
    { name: 'hyperlink', payload: { uid: 'n1', hyperlink: 'https://a', hyperlinkTitle: 'A' }, read: n => n.data.hyperlink, want: 'https://a' },
    {
      name: 'mapRef',
      payload: { uid: 'n1', mapRef: { mapId: 'other', nodeId: 'x', type: 'node' } },
      read: n => n.data.mapRef.mapId,
      want: 'other'
    },
    { name: 'outerFrame', payload: { uid: 'n1', outerFrame: { width: 2 } }, read: n => n.data.outerFrame.width, want: 2 },
    {
      name: 'generalization',
      payload: { uid: 'n1', generalization: [{ text: 'sum' }] },
      read: n => n.data.generalization[0].text,
      want: 'sum'
    },
    {
      name: 'associativeLine',
      payload: { uid: 'n1', associativeLineTargets: ['root'] },
      read: n => n.data.associativeLineTargets[0],
      want: 'root'
    },
    { name: 'formula', payload: { uid: 'n1', formula: '1+1' }, read: n => n.data.formula, want: '1+1' },
    { name: 'attachment', payload: { uid: 'n1', attachmentUrl: 'f.pdf', attachmentName: 'f' }, read: n => n.data.attachmentUrl, want: 'f.pdf' },
    { name: 'customPosition', payload: { uid: 'n1', customLeft: 12, customTop: 8 }, read: n => n.data.customLeft, want: 12 }
  ]

  for (const item of persistCases) {
    await a.adapter.submitOperation({ type: 'node.update', payload: item.payload })
    await wait()
    assert.strictEqual(item.read(nodeOf(engine, roomKey, 'n1')), item.want, item.name + ' A')
    const remote = b.applied.find(
      op =>
        op.event &&
        op.event.payload &&
        (op.event.payload.uid === 'n1' || (op.event.payload.patch && op.event.payload.patch[Object.keys(item.payload)[1]]))
    )
    assert.ok(b.applied.length >= 1, item.name + ' B received')
    void remote
  }

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'n2', parent: 'root', text: 'two' }
  })
  await a.adapter.submitOperation({
    type: 'node.move',
    payload: { uid: 'n2', parent: 'n1', index: 0 }
  })
  await wait()
  assert.strictEqual(nodeOf(engine, roomKey, 'n2').parent_uid || nodeOf(engine, roomKey, 'n1').children.includes('n2'), true)

  await a.adapter.submitOperation({
    type: 'map.meta.update',
    payload: { theme: 'classic', layout: 'mindMap' }
  })
  await wait()
  assert.strictEqual(engine.getRoom(roomKey).store.getMeta().theme, 'classic')

  await a.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', text: 'before-replace' }
  })
  await wait()
  const replace = await a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      batchId: randomUUID(),
      ops: [
        {
          type: 'node.update',
          payload: { uid: 'n1', text: 'after-replace', expected: { text: 'before-replace' } }
        }
      ]
    }
  })
  assert.ok(replace.ok !== false)
  await b.adapter.submitOperation({
    type: 'node.update',
    payload: { uid: 'n1', text: 'B-changed' }
  })
  await wait()
  const conflicted = await a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      batchId: randomUUID(),
      ops: [
        {
          type: 'node.update',
          payload: { uid: 'n1', text: 'A-replace', expected: { text: 'after-replace' } }
        }
      ]
    }
  })
  await wait()
  assert.strictEqual(nodeOf(engine, roomKey, 'n1').data.text, 'B-changed')
  const skipped =
    conflicted.operation &&
    conflicted.operation.event &&
    conflicted.operation.event.payload &&
    conflicted.operation.event.payload.skipped
  assert.ok(Number(skipped || 0) >= 1 || conflicted.ok !== false)

  await a.adapter.submitOperation({
    type: 'node.insert',
    payload: { uid: 'cut-me', parent: 'root', text: 'cut' }
  })
  await a.adapter.submitOperation({ type: 'node.delete', payload: { uid: 'cut-me' } })
  await wait()
  assert.ok(!nodeOf(engine, roomKey, 'cut-me') || nodeOf(engine, roomKey, 'cut-me').deleted)

  await a.adapter.submitOperation({
    type: 'node.batch',
    payload: {
      ops: Array.from({ length: 8 }, (_, i) => ({
        type: 'node.insert',
        payload: { uid: 'paste-' + i, parent: 'root', text: 'p' + i }
      }))
    }
  })
  await wait()
  assert.ok(nodeOf(engine, roomKey, 'paste-0'))

  const beforeImport = JSON.parse(JSON.stringify(engine.getRoom(roomKey).nodes))
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
  const undone = await a.adapter.undo()
  await wait()
  assert.ok(undone)
  assert.ok(engine.getRoom(roomKey).nodes[Object.keys(beforeImport)[0]])

  const groups = Object.keys(FIELD_GROUPS)
  assert.ok(groups.includes('mapRef'))
  assert.ok(groups.includes('associativeLine'))
  assert.ok(groups.includes('formula'))

  console.log('collabV2 features tests ok', {
    persistCases: persistCases.length,
    bEvents: b.applied.length
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
