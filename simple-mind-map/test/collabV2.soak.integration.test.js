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

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

async function main() {
  const api = await tryPg()
  if (api.error) {
    console.log('skip collabV2 soak: PostgreSQL unavailable', api.error.message)
    return
  }
  const rounds = Math.max(200, Number(process.env.COLLAB_SOAK_OPS || 1000))
  const roomKey = 'pg-soak-' + Date.now()
  await seedPgRoom(api, roomKey, 120)
  const { server, url, presence } = await startV2Server()
  const clients = []
  const live = new Set(Array.from({ length: 120 }, (_, i) => 'n' + i))
  const heap0 = process.memoryUsage().heapUsed
  const initial = (await api.readRoomNodes(roomKey)).nodes
  try {
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      clients.push(await joinClient(url, roomKey, name))
    }
    let created = 0
    for (let i = 0; i < rounds; i++) {
      const actor = pick(clients)
      const kind = i % 11
      try {
        if (kind === 0) {
          const uid = 's' + created++
          const parent = pick(['root', ...Array.from(live).slice(0, 20)])
          const res = await submitOp(actor, 'node.insert', { uid, parent, text: 's' + i })
          if (res.result.ok) live.add(uid)
        } else if (kind === 1 && live.size > 40) {
          const uid = pick(Array.from(live).filter(id => id.startsWith('s')))
          if (uid) {
            const res = await submitOp(actor, 'node.delete', { uid })
            if (res.result.ok) live.delete(uid)
          }
        } else if (kind === 2) {
          const uid = pick(Array.from(live))
          await submitOp(actor, 'node.move', {
            uid,
            parent: pick(['root', 'n0', 'n1']),
            index: 0
          })
        } else if (kind === 3 && i % 40 === 3) {
          actor.socket.disconnect()
          await wait(20)
          actor.socket.connect()
          await wait(40)
          await require('./collabV2.pgHarness').emitAck(actor.socket, 'join', {
            roomKey,
            clientId: actor.userId,
            userId: actor.userId,
            lastServerRevision: 0
          })
        } else {
          await submitOp(actor, 'node.update', {
            uid: pick(Array.from(live)),
            text: actor.userId + '-' + i
          })
        }
      } catch (err) {
        // random valid ops may still hit cycle/delete races
        if (!/CYCLE|TARGET_DELETED|NODE_DELETED|PARENT_DELETED|UID_/.test(err.code || err.message || '')) {
          throw err
        }
      }
    }
    await wait(300)
    const table = await api.readRoomNodes(roomKey)
    const pg = graphHash(table.nodes || table)
    const ops = await listAllOps(roomKey)
    const replayed = applyCollabEvents(initial, ops)
    assert.strictEqual(replayed.type, 'apply')
    assert.strictEqual(graphHash(replayed.nodes).hash, pg.hash, 'soak replay diverged from PostgreSQL')
    const tailAfter = Math.max(0, Number(ops.length && ops[ops.length - 1].version) - 200)
    for (const client of clients) {
      const sync = await emitAck(client.socket, 'sync', {
        roomKey,
        afterRevision: tailAfter,
        limit: 400
      })
      assert.strictEqual(sync.ok, true, JSON.stringify(sync))
      assert.strictEqual(sync.reload, false)
    }
    const heap1 = process.memoryUsage().heapUsed
    assert.ok(pg.count > 50)
    assert.strictEqual(clients[0].socket.listeners('op:event').length, 1)
    console.log('collabV2 soak ok', {
      roomKey,
      rounds,
      pgNodes: pg.count,
      pgHash: pg.hash,
      opCount: ops.length,
      heapDeltaMb: Number(((heap1 - heap0) / 1048576).toFixed(2)),
      listenersA: clients[0].socket.listeners('op:event').length,
      presenceBeforeClose: (presence.list(roomKey) || []).length
    })
    clients.forEach(item => item.socket.close())
    await wait(80)
    assert.strictEqual((presence.list(roomKey) || []).length, 0, 'presence leaked after close')
  } finally {
    clients.forEach(item => {
      try {
        item.socket.close()
      } catch (err) {}
    })
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
