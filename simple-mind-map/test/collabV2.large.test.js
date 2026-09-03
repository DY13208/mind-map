const assert = require('assert')
const { randomUUID } = require('crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')

function wait(ms = 20) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function seedBush(count) {
  const nodes = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Root' },
      children: []
    }
  }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    nodes[uid] = {
      data: { uid, text: 'N' + i, note: '', mapRef: null },
      children: []
    }
    nodes[parent].children.push(uid)
  }
  return nodes
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
        const sync = engine.opsAfter(payload.roomKey, payload.lastServerRevision)
        reply({
          ok: true,
          role: socket.access.role,
          canEdit: !!socket.access.canEdit,
          canView: true,
          serverRevision: engine.getRoom(payload.roomKey).revision,
          sync,
          peers: []
        })
        return
      }
      if (event === 'op') {
        const room = engine.getRoom(payload.roomKey)
        if (room.store && room.store.resetStats) room.store.resetStats()
        const started = process.hrtime.bigint()
        const result = await engine.submit(
          { ...payload, userId: socket.access.userId },
          socket.access
        )
        socket.lastDbMs = Number(process.hrtime.bigint() - started) / 1e6
        socket.lastQueries = room.store ? room.store.stats.queries : 0
        socket.lastReads = room.store ? room.store.stats.reads : 0
        const op = result.operation
        reply({
          ok: true,
          opId: op.opId,
          serverRevision: op.serverRevision,
          duplicate: result.duplicate,
          operation: op,
          queryStats: room.store ? { ...room.store.stats } : null
        })
        if (!result.duplicate) broadcast(op.roomKey, socket.id, 'op:event', op)
        return
      }
      if (event === 'sync') {
        reply({
          ok: true,
          ...engine.opsAfter(payload.roomKey, payload.afterRevision)
        })
      }
    } catch (err) {
      reply({
        ok: false,
        code: err.code,
        error: err.message,
        statusCode: err.statusCode || 400
      })
    }
  }
  return {
    createSocket(access) {
      const handlers = {}
      const socket = {
        id: randomUUID(),
        connected: true,
        access,
        roomKey: '',
        lastDbMs: 0,
        lastQueries: 0,
        lastReads: 0,
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
  }
}

async function makeClients(engine, hub, roomKey, count) {
  const clients = []
  for (let i = 0; i < count; i++) {
    const applied = []
    const socket = hub.createSocket({
      canEdit: true,
      role: 'editor',
      userId: 'U' + i
    })
    const adapter = createCollaborationAdapter({
      clientId: randomUUID(),
      memory: true,
      socket,
      timeoutMs: 8000,
      onRemoteOperation: op => applied.push(op)
    })
    const t0 = process.hrtime.bigint()
    await adapter.connect({ roomKey, userId: 'U' + i, lastServerRevision: 0 })
    const joinMs = Number(process.hrtime.bigint() - t0) / 1e6
    clients.push({ adapter, applied, socket, joinMs })
  }
  return clients
}

async function timed(adapter, socket, op) {
  const started = process.hrtime.bigint()
  const ack = await adapter.submitOperation(op)
  return {
    ack,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    dbMs: socket.lastDbMs,
    queries: socket.lastQueries,
    reads: socket.lastReads
  }
}

async function runSize(nodeCount, clientCount) {
  const roomKey = 'large-' + nodeCount + '-' + clientCount
  const engine = createEngine()
  engine.replaceNodes(roomKey, seedBush(nodeCount))
  const hub = createHub(engine)
  const heapBefore = process.memoryUsage().heapUsed
  const clients = await makeClients(engine, hub, roomKey, clientCount)
  const actor = clients[0]
  await timed(actor.adapter, actor.socket, {
    type: 'node.update',
    payload: { uid: 'n8', text: 'warmup' }
  })
  const text = await timed(actor.adapter, actor.socket, {
    type: 'node.update',
    payload: { uid: 'n0', text: 'edited-' + nodeCount }
  })
  const style = await timed(actor.adapter, actor.socket, {
    type: 'node.update',
    payload: { uid: 'n0', fillColor: '#112233' }
  })
  const note = await timed(actor.adapter, actor.socket, {
    type: 'node.update',
    payload: { uid: 'n1', note: 'note-' + nodeCount }
  })
  const mapRef = await timed(actor.adapter, actor.socket, {
    type: 'node.update',
    payload: {
      uid: 'n2',
      mapRef: { mapId: 'other', nodeId: 'x', type: 'node' }
    }
  })
  const insert = await timed(actor.adapter, actor.socket, {
    type: 'node.insert',
    payload: { uid: 'leaf-' + nodeCount, parent: 'n0', text: 'leaf' }
  })
  const move = await timed(actor.adapter, actor.socket, {
    type: 'node.move',
    payload: { uid: 'leaf-' + nodeCount, parent: 'n1', index: 0 }
  })
  const del = await timed(actor.adapter, actor.socket, {
    type: 'node.delete',
    payload: { uid: 'leaf-' + nodeCount }
  })
  const batches = {}
  for (const size of [20, 100, 1000]) {
    const batch = await timed(actor.adapter, actor.socket, {
      type: 'node.batch',
      payload: {
        ops: Array.from({ length: size }, (_, i) => ({
          type: 'node.insert',
          payload: {
            uid: 'paste-' + nodeCount + '-' + clientCount + '-' + size + '-' + i,
            parent: 'n3',
            text: 'paste ' + i
          }
        }))
      }
    })
    batches[size] = batch
  }
  await wait(40)
  const latest = engine.getRoom(roomKey).ops.slice(-1)[0]
  const follower = clients[Math.min(1, clients.length - 1)]
  follower.adapter.setLastServerRevision(Math.max(0, text.ack.serverRevision - 3))
  const tGap = process.hrtime.bigint()
  await follower.adapter.resync()
  const gapMs = Number(process.hrtime.bigint() - tGap) / 1e6
  const heapAfter = process.memoryUsage().heapUsed
  assert.strictEqual(engine.getRoom(roomKey).nodes.n0.data.text, 'edited-' + nodeCount)
  assert.ok(engine.getRoom(roomKey).nodes['paste-' + nodeCount + '-' + clientCount + '-20-0'])
  assert.strictEqual(engine.rooms.size, 1)
  assert.ok(text.queries <= 6, 'text queries ' + text.queries)
  return {
    nodes: nodeCount,
    clients: clientCount,
    joinMs: Number(
      (clients.reduce((sum, item) => sum + item.joinMs, 0) / clients.length).toFixed(2)
    ),
    textMs: Number(text.ms.toFixed(2)),
    styleMs: Number(style.ms.toFixed(2)),
    noteMs: Number(note.ms.toFixed(2)),
    mapRefMs: Number(mapRef.ms.toFixed(2)),
    insertMs: Number(insert.ms.toFixed(2)),
    moveMs: Number(move.ms.toFixed(2)),
    deleteMs: Number(del.ms.toFixed(2)),
    batch20Ms: Number(batches[20].ms.toFixed(2)),
    batch100Ms: Number(batches[100].ms.toFixed(2)),
    batch1000Ms: Number(batches[1000].ms.toFixed(2)),
    textQueries: text.queries,
    insertQueries: insert.queries,
    batch20Queries: batches[20].queries,
    batch1000Queries: batches[1000].queries,
    dbMs: Number(text.dbMs.toFixed(2)),
    gapMs: Number(gapMs.toFixed(2)),
    heapDeltaMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    serverRevision: latest.serverRevision
  }
}

async function main() {
  const report = []
  const sizes = [1000, 5000, 10000, 20000]
  for (const size of sizes) {
    report.push(await runSize(size, 2))
    report.push(await runSize(size, 5))
  }
  console.log('collabV2 large report', JSON.stringify(report, null, 2))
  const twoClients = report.filter(row => row.clients === 2)
  const at1k = twoClients.find(row => row.nodes === 1000)
  const at20k = twoClients.find(row => row.nodes === 20000)
  report.forEach(row => {
    assert.ok(row.joinMs < 5000, 'join too slow ' + JSON.stringify(row))
    assert.ok(row.textMs < 200, 'text update too slow ' + JSON.stringify(row))
    assert.ok(row.textQueries <= 6, 'text queries grew ' + JSON.stringify(row))
  })
  assert.ok(
    at20k.textMs < Math.max(40, at1k.textMs * 8),
    'text update scaled with room size ' + JSON.stringify({ at1k, at20k })
  )
  console.log('collabV2 large tests ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
