/**
 * 协同 V2 断线恢复单测（2026-10-10 用户反馈「一直报同步失败」：
 * ACK_TIMEOUT / stage=ack_wait / socketId 为空 / status=disconnected / phase=ERROR）。
 *
 * 根因：socket 没连上时加入房间，join 被缓冲发不出去，12 秒后超时，适配器停在 ERROR 不再重试；
 * socket.io 用完 8 次重连后也永久放弃。修复后应自动重连、重新 join，并把积压的修改发出去。
 */
const assert = require('assert')
const { randomUUID } = require('crypto')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')

function wait(ms = 25) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await wait(20)
  }
  return false
}

/** 模拟 socket.io：未连接时 emit 进缓冲区，connect() 后发出；server.joinMode 控制 join 的回应 */
function createFakeSocket({ connected = true, reconnection = true } = {}) {
  const handlers = {}
  const managerHandlers = {}
  const buffer = []
  const server = { joinMode: 'ok', joins: [], connectCalls: 0 }
  const socket = {
    id: connected ? randomUUID() : undefined,
    connected,
    server,
    io: {
      on(ev, fn) {
        managerHandlers[ev] = managerHandlers[ev] || []
        managerHandlers[ev].push(fn)
      },
      reconnection: () => reconnection,
      _emit(ev) {
        ;(managerHandlers[ev] || []).forEach(fn => fn())
      }
    },
    on(ev, fn) {
      handlers[ev] = handlers[ev] || []
      handlers[ev].push(fn)
    },
    emit(ev, payload, cb) {
      if (!socket.connected) {
        buffer.push([ev, payload, cb])
        return
      }
      Promise.resolve().then(() => handle(ev, payload, cb))
    },
    connect() {
      server.connectCalls += 1
      if (server.refuseConnect) return socket
      if (socket.connected) return socket
      socket.connected = true
      socket.id = randomUUID()
      buffer.splice(0).forEach(([ev, payload, cb]) => Promise.resolve().then(() => handle(ev, payload, cb)))
      ;(handlers.connect || []).forEach(fn => fn())
      return socket
    },
    disconnect() {
      socket.connected = false
      socket.id = undefined
    },
    drop() {
      socket.connected = false
      socket.id = undefined
      ;(handlers.disconnect || []).forEach(fn => fn('transport close'))
    }
  }
  function handle(ev, payload, cb) {
    const reply = typeof cb === 'function' ? cb : () => {}
    if (ev === 'join') {
      server.joins.push(payload.roomKey)
      if (server.joinMode === 'silent') return
      if (server.joinMode === 'forbidden') {
        reply({ ok: false, code: 'FORBIDDEN', error: 'forbidden', statusCode: 403 })
        return
      }
      reply({ ok: true, role: 'editor', canEdit: true, canView: true, serverRevision: 0, peers: [] })
    }
  }
  return socket
}

function makeAdapter(socket) {
  return createCollaborationAdapter({
    clientId: randomUUID(),
    name: 'tester',
    memory: true,
    socket,
    timeoutMs: 150,
    rejoinBaseDelayMs: 50
  })
}

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

test('join 超时（服务端没回）：转入重连而不是停在 ERROR，服务端恢复后自动回到 LIVE', async () => {
  const socket = createFakeSocket()
  socket.server.joinMode = 'silent'
  const adapter = makeAdapter(socket)
  await assert.rejects(adapter.connect({ roomKey: 'room-a', userId: 'u1' }), err => err.code === 'ACK_TIMEOUT')
  const failed = adapter.getStatus()
  assert.strictEqual(failed.status, 'reconnecting')
  assert.strictEqual(failed.phase, 'OFFLINE')
  assert.notStrictEqual(failed.saveState, 'error')
  socket.server.joinMode = 'ok'
  assert.ok(await waitFor(() => adapter.getStatus().phase === 'LIVE'), '应自动重新 join 成功')
  const live = adapter.getStatus()
  assert.strictEqual(live.saveState, 'saved')
  assert.ok(!live.currentError, '恢复后清掉 ACK_TIMEOUT')
  await adapter.disconnect()
})

test('socket 已断开且重连次数用完时打开脑图：主动 connect，连上后 join 成功', async () => {
  const socket = createFakeSocket({ connected: false })
  const adapter = makeAdapter(socket)
  const joined = await adapter.connect({ roomKey: 'room-a', userId: 'u1' })
  assert.ok(joined && joined.ok)
  assert.ok(socket.server.connectCalls >= 1)
  assert.strictEqual(adapter.getStatus().phase, 'LIVE')
  assert.deepStrictEqual(socket.server.joins, ['room-a'], 'connect 事件与缓冲的 join 不会重复加入')
  await adapter.disconnect()
})

test('socket.io 放弃重连（reconnect_failed）后按退避继续 connect，连上即恢复', async () => {
  const socket = createFakeSocket()
  const adapter = makeAdapter(socket)
  await adapter.connect({ roomKey: 'room-a', userId: 'u1' })
  socket.server.refuseConnect = true
  socket.drop()
  assert.strictEqual(adapter.getStatus().phase, 'OFFLINE')
  socket.io._emit('reconnect_failed')
  assert.ok(await waitFor(() => socket.server.connectCalls >= 2), '放弃后仍会继续尝试')
  socket.server.refuseConnect = false
  assert.ok(await waitFor(() => adapter.getStatus().phase === 'LIVE'), '网络恢复后回到 LIVE')
  await adapter.disconnect()
})

test('无权限（FORBIDDEN）：停在 ERROR，不自动重试', async () => {
  const socket = createFakeSocket()
  socket.server.joinMode = 'forbidden'
  const adapter = makeAdapter(socket)
  await assert.rejects(adapter.connect({ roomKey: 'room-a', userId: 'u1' }), err => err.code === 'FORBIDDEN')
  assert.strictEqual(adapter.getStatus().phase, 'ERROR')
  const joins = socket.server.joins.length
  await wait(400)
  assert.strictEqual(socket.server.joins.length, joins)
  await adapter.disconnect()
})

test('reconnection 被关闭（房间加载失败）时不自动重连', async () => {
  const socket = createFakeSocket({ reconnection: false })
  socket.server.joinMode = 'silent'
  const adapter = makeAdapter(socket)
  await assert.rejects(adapter.connect({ roomKey: 'room-a', userId: 'u1' }))
  const joins = socket.server.joins.length
  await wait(400)
  assert.strictEqual(socket.server.joins.length, joins)
  await adapter.disconnect()
})

test('后台重连期间切换脑图：最终加入的是新脑图', async () => {
  const socket = createFakeSocket()
  socket.server.joinMode = 'silent'
  const adapter = makeAdapter(socket)
  await assert.rejects(adapter.connect({ roomKey: 'room-a', userId: 'u1' }))
  socket.server.joinMode = 'ok'
  const joined = await adapter.connect({ roomKey: 'room-b', userId: 'u1' })
  assert.ok(joined && joined.ok)
  assert.strictEqual(adapter.getStatus().phase, 'LIVE')
  assert.strictEqual(socket.server.joins[socket.server.joins.length - 1], 'room-b')
  await wait(300)
  assert.strictEqual(socket.server.joins[socket.server.joins.length - 1], 'room-b', '不会再回头加入旧脑图')
  await adapter.disconnect()
})

test('disconnect 后不再自动重连', async () => {
  const socket = createFakeSocket()
  socket.server.joinMode = 'silent'
  const adapter = makeAdapter(socket)
  await assert.rejects(adapter.connect({ roomKey: 'room-a', userId: 'u1' }))
  await adapter.disconnect()
  const joins = socket.server.joins.length
  const connects = socket.server.connectCalls
  await wait(400)
  assert.strictEqual(socket.server.joins.length, joins)
  assert.strictEqual(socket.server.connectCalls, connects)
})

;(async () => {
  let failed = 0
  for (const item of cases) {
    try {
      await item.fn()
      console.log('PASS ', item.name)
    } catch (err) {
      failed += 1
      console.log('FAIL ', item.name, '\n      ', err && err.message)
    }
  }
  console.log(`\n共 ${cases.length} 项，失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
})()
