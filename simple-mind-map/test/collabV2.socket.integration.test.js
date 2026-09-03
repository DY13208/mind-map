const assert = require('assert')
const http = require('http')
const { randomUUID } = require('crypto')

process.env.COLLAB_V2 = process.env.COLLAB_V2 || '1'
process.env.WECOM_AUTH_ENABLED = process.env.WECOM_AUTH_ENABLED || '0'

require('../bin/loadEnv')

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(event + ' timeout'))
    }, timeoutMs)
    socket.emit(event, payload, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

function connectClient(url, clientId) {
  const { io } = require('socket.io-client')
  return io(url, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
}

async function join(socket, roomKey, clientId, lastServerRevision = 0) {
  return emitAck(socket, 'join', {
    roomKey,
    clientId,
    userId: clientId,
    name: clientId,
    lastServerRevision
  })
}

async function main() {
  let ioClient
  try {
    ioClient = require('socket.io-client')
  } catch (err) {
    console.log('skip collabV2 socket integration: socket.io-client not installed')
    return
  }
  const { initSchema, upsertRoom, getPool } = require('../bin/storage')
  const { attachCollabV2 } = require('../bin/collabV2/socketServer')
  try {
    await initSchema()
    await getPool().query('select 1')
  } catch (err) {
    console.log(
      'skip collabV2 socket integration: PostgreSQL unavailable',
      err && err.message
    )
    return
  }

  const roomKey = 'v2-socket-' + Date.now()
  await upsertRoom(roomKey, 'socket-v2', {
    nodes: {
      root: {
        isRoot: true,
        data: { uid: 'root', text: 'Root' },
        children: ['n1', 'n2']
      },
      n1: { data: { uid: 'n1', text: 'N1' }, children: [] },
      n2: { data: { uid: 'n2', text: 'N2' }, children: [] }
    }
  })

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('collab-v2 test')
  })
  attachCollabV2(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + port

  const aId = randomUUID()
  const bId = randomUUID()
  const a = connectClient(url, aId)
  const b = connectClient(url, bId)
  const bEvents = []
  b.on('op:event', op => bEvents.push(op))

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000)
      let left = 2
      const done = () => {
        left -= 1
        if (left === 0) {
          clearTimeout(timer)
          resolve()
        }
      }
      a.on('connect', done)
      b.on('connect', done)
      a.on('connect_error', reject)
      b.on('connect_error', reject)
    })

    const joinA = await join(a, roomKey, aId)
    const joinB = await join(b, roomKey, bId)
    assert.strictEqual(joinA.ok, true, JSON.stringify(joinA))
    assert.strictEqual(joinB.ok, true, JSON.stringify(joinB))
    assert.ok(joinA.canEdit)

    const update = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.update',
      roomKey,
      userId: aId,
      clientId: aId,
      payload: { uid: 'n1', text: 'from-A' }
    })
    assert.strictEqual(update.ok, true, JSON.stringify(update))
    assert.ok(update.serverRevision >= 1)
    assert.ok(update.queryStats, 'queryStats missing on ACK')
    assert.ok(update.queryStats.queries <= 8, 'too many apply queries ' + JSON.stringify(update.queryStats))
    ;(update.queryStats.sql || []).forEach(sql => {
      const s = String(sql).toLowerCase()
      if (!s.includes('room_nodes')) return
      assert.ok(
        s.includes('uid') || s.includes('parent_uid') || s.includes('is_root'),
        'unbounded room_nodes SQL ' + sql
      )
    })
    await wait(80)
    assert.ok(
      bEvents.some(op => op.type === 'node.updated' || (op.event && op.event.type === 'node.updated')),
      'B missed update event'
    )

    const insert = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.insert',
      roomKey,
      clientId: aId,
      payload: { uid: 'n3', parent: 'n1', text: 'child' }
    })
    assert.strictEqual(insert.ok, true, JSON.stringify(insert))

    const moved = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.move',
      roomKey,
      clientId: aId,
      payload: { uid: 'n3', parent: 'n2', index: 0 }
    })
    assert.strictEqual(moved.ok, true, JSON.stringify(moved))

    const deleted = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.delete',
      roomKey,
      clientId: aId,
      payload: { uid: 'n3' }
    })
    assert.strictEqual(deleted.ok, true, JSON.stringify(deleted))
    await wait(80)
    assert.ok(bEvents.length >= 3)

    const beforeGap = update.serverRevision
    b.disconnect()
    await wait(50)
    const extra = []
    for (let i = 0; i < 3; i++) {
      extra.push(
        await emitAck(a, 'op', {
          opId: randomUUID(),
          type: 'node.insert',
          roomKey,
          clientId: aId,
          payload: { uid: 'gap' + i, parent: 'root', text: 'g' + i }
        })
      )
    }
    assert.ok(extra[2].ok)
    b.connect()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('B reconnect timeout')), 8000)
      b.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const rejoin = await join(b, roomKey, bId, beforeGap)
    assert.strictEqual(rejoin.ok, true, JSON.stringify(rejoin))
    const synced = (rejoin.sync && rejoin.sync.operations) || []
    assert.ok(
      rejoin.sync && (rejoin.sync.reload || synced.length >= 3),
      'gap recovery missing ops ' + JSON.stringify(rejoin.sync)
    )

    const afterReconnect = await emitAck(a, 'op', {
      opId: randomUUID(),
      type: 'node.update',
      roomKey,
      clientId: aId,
      payload: { uid: 'n2', note: 'after-reconnect' }
    })
    assert.strictEqual(afterReconnect.ok, true, JSON.stringify(afterReconnect))

    const emptyJoin = await emitAck(a, 'join', {
      roomKey,
      clientId: '',
      userId: 'dev-local',
      lastServerRevision: 0
    })
    assert.strictEqual(emptyJoin.ok, false)
    assert.strictEqual(emptyJoin.code, 'INVALID_CLIENT_ID')

    const stray = connectClient(url, '')
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stray connect timeout')), 8000)
        stray.on('connect', () => {
          clearTimeout(timer)
          resolve()
        })
        stray.on('connect_error', reject)
      })
      const emptyOp = await emitAck(stray, 'op', {
        opId: randomUUID(),
        type: 'node.update',
        roomKey,
        clientId: '',
        payload: { uid: 'n1', text: 'empty-client' }
      })
      assert.strictEqual(emptyOp.ok, false, JSON.stringify(emptyOp))
      assert.strictEqual(emptyOp.code, 'INVALID_CLIENT_ID')
    } finally {
      stray.close()
    }

    const sameRoom = 'v2-same-user-' + Date.now()
    await upsertRoom(sameRoom, 'same-user', {
      nodes: {
        root: {
          isRoot: true,
          data: { uid: 'root', text: 'Root' },
          children: ['n1']
        },
        n1: { data: { uid: 'n1', text: 'N1' }, children: [] }
      }
    })
    const clientA = 'client-A-' + randomUUID()
    const clientB = 'client-B-' + randomUUID()
    const sameA = connectClient(url, clientA)
    const sameB = connectClient(url, clientB)
    const sameBEvents = []
    const sameAEvents = []
    sameB.on('op:event', op => sameBEvents.push(op))
    sameA.on('op:event', op => sameAEvents.push(op))
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('same-user connect timeout')), 8000)
        let left = 2
        const done = () => {
          left -= 1
          if (left === 0) {
            clearTimeout(timer)
            resolve()
          }
        }
        sameA.on('connect', done)
        sameB.on('connect', done)
        sameA.on('connect_error', reject)
        sameB.on('connect_error', reject)
      })
      const joinSameA = await join(sameA, sameRoom, clientA)
      const joinSameB = await join(sameB, sameRoom, clientB)
      assert.strictEqual(joinSameA.ok, true, JSON.stringify(joinSameA))
      assert.strictEqual(joinSameB.ok, true, JSON.stringify(joinSameB))
      const peers = (joinSameB.peers || []).concat(joinSameA.peers || [])
      assert.ok(peers.some(peer => peer.clientId === clientA))
      assert.ok(peers.some(peer => peer.clientId === clientB))
      const updateSame = await emitAck(sameA, 'op', {
        opId: randomUUID(),
        type: 'node.update',
        roomKey: sameRoom,
        userId: 'dev-local',
        clientId: clientA,
        payload: { uid: 'n1', text: 'same-user-from-A' }
      })
      assert.strictEqual(updateSame.ok, true, JSON.stringify(updateSame))
      assert.ok(updateSame.operation && updateSame.operation.clientId === clientA)
      await wait(80)
      assert.ok(
        sameBEvents.some(op => op.clientId === clientA),
        'same-user B missed A op'
      )
      const insertSame = await emitAck(sameB, 'op', {
        opId: randomUUID(),
        type: 'node.insert',
        roomKey: sameRoom,
        userId: 'dev-local',
        clientId: clientB,
        payload: { uid: 'n-same-b', parent: 'root', text: 'from-B' }
      })
      assert.strictEqual(insertSame.ok, true, JSON.stringify(insertSame))
      assert.ok(insertSame.operation && insertSame.operation.clientId === clientB)
      await wait(80)
      assert.ok(
        sameAEvents.some(op => op.clientId === clientB),
        'same-user A missed B op'
      )
    } finally {
      sameA.close()
      sameB.close()
    }

    console.log('collabV2 socket integration ok', {
      roomKey,
      updateQueries: update.queryStats.queries,
      ackRevision: afterReconnect.serverRevision,
      gapOps: synced.length
    })
  } finally {
    a.close()
    b.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
