const assert = require('assert')
const {
  tryPg,
  seedPgRoom,
  startV2Server,
  joinClient,
  submitOp,
  wait,
  graphHash,
  emitAck,
  listAllOps
} = require('./collabV2.pgHarness')
const { applyCollabEvents } = require('../bin/collabRecovery')

async function main() {
  const api = await tryPg()
  if (api.error) {
    console.log('skip collabV2 5-client: PostgreSQL unavailable', api.error.message)
    return
  }
  const roomKey = 'pg-five-' + Date.now()
  await seedPgRoom(api, roomKey, 80)
  const { server, url, presence } = await startV2Server()
  const names = ['A', 'B', 'C', 'D', 'E']
  const clients = []
  const initial = (await api.readRoomNodes(roomKey)).nodes
  try {
    for (const name of names) {
      clients.push(await joinClient(url, roomKey, name))
    }
    for (let i = 0; i < 100; i++) {
      const actor = clients[i % clients.length]
      const result = await submitOp(actor, 'node.update', {
        uid: 'n' + (i % 70),
        text: actor.userId + '-' + i
      })
      assert.strictEqual(result.result.ok, true, JSON.stringify(result.result))
    }
    await submitOp(clients[0], 'node.update', { uid: 'n10', text: 'A-conflict' })
    await submitOp(clients[1], 'node.update', { uid: 'n10', text: 'B-conflict' })
    await submitOp(clients[0], 'node.insert', { uid: 'mv', parent: 'n0', text: 'move-me' })
    await submitOp(clients[2], 'node.move', { uid: 'mv', parent: 'n1', index: 0 })
    await submitOp(clients[3], 'node.delete', { uid: 'mv' })
    await submitOp(clients[4], 'node.batch', {
      ops: Array.from({ length: 8 }, (_, i) => ({
        type: 'node.insert',
        payload: { uid: 'five-' + i, parent: 'n2', text: 'p' + i }
      }))
    })
    const ins = await submitOp(clients[0], 'node.insert', {
      uid: 'undo-five',
      parent: 'root',
      text: 'U1'
    })
    assert.strictEqual(ins.result.ok, true)
    const undone = await submitOp(clients[0], 'operation.undo', {
      targetOperationId: ins.result.opId
    })
    assert.strictEqual(undone.result.ok, true, JSON.stringify(undone.result))
    const redone = await submitOp(clients[0], 'operation.redo', {
      targetOperationId: ins.result.opId
    })
    if (!redone.result.ok && redone.result.code === 'UID_REUSED') {
      // insert undo tombstones; redo must restore, not insert
      console.warn('redo insert used restore fallback', redone.result.code)
    }
    assert.strictEqual(redone.result.ok, true, JSON.stringify(redone.result))

    clients[4].socket.disconnect()
    await wait(40)
    assert.strictEqual((presence.list(roomKey) || []).length, 4, 'E disconnect should drop presence')
    await submitOp(clients[1], 'node.update', { uid: 'n11', note: 'after-e-left' })
    clients[4].socket.connect()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('E reconnect timeout')), 8000)
      clients[4].socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const rejoin = await emitAck(clients[4].socket, 'join', {
      roomKey,
      clientId: 'E',
      userId: 'E',
      lastServerRevision: 0
    })
    assert.strictEqual(rejoin.ok, true)
    assert.ok((presence.list(roomKey) || []).length >= 5)

    await wait(200)
    const table = await api.readRoomNodes(roomKey)
    const pgHash = graphHash(table.nodes || table)
    const ops = await listAllOps(roomKey)
    const replayed = applyCollabEvents(initial, ops)
    assert.strictEqual(replayed.type, 'apply')
    const replayHash = graphHash(replayed.nodes)
    assert.strictEqual(replayHash.hash, pgHash.hash, 'replayed ops must match PostgreSQL')
    assert.ok(pgHash.count > 80)

    const clientHashes = []
    for (const client of clients) {
      const sync = await emitAck(client.socket, 'sync', {
        roomKey,
        afterRevision: 0,
        limit: 1000
      })
      assert.strictEqual(sync.ok, true, JSON.stringify(sync))
      const applied = applyCollabEvents(initial, sync.operations || [])
      assert.strictEqual(applied.type, 'apply')
      const hash = graphHash(applied.nodes)
      clientHashes.push({ userId: client.userId, ...hash })
      assert.strictEqual(hash.hash, pgHash.hash, client.userId + ' diverged from PostgreSQL')
    }
    assert.ok(clients.every(item => item.joined.ok))
    console.log('collabV2 5-client integration ok', {
      roomKey,
      pgNodes: pgHash.count,
      pgHash: pgHash.hash,
      clientHashes,
      eEvents: clients[4].events.length,
      opCount: ops.length
    })
  } finally {
    clients.forEach(item => item.socket.close())
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
