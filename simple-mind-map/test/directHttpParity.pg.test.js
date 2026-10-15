const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { randomUUID } = require('node:crypto')
const { createHarness, request, isolatedInstance, timeout } = require('./performanceBackendHarness')
let app
before(async () => { app = await createHarness() })
after(async () => { if (app) await app.close() })

function command(data = {}) {
  return { operation_id: randomUUID(), client_id: 'performance-client', ...data }
}

async function legacyRequest(...args) {
  const prior = process.env.COLLAB_HTTP_DIRECT
  process.env.COLLAB_HTTP_DIRECT = '0'
  try { return await request(...args) }
  finally { process.env.COLLAB_HTTP_DIRECT = prior }
}

for (const operation of ['insert', 'update', 'delete']) {
  test(`R19 approved ordinary HTTP ${operation} uses Direct without hidden full-tree work`, async t => {
    const { roomKey } = await app.seed()
    app.observer.reset()
    const path = `/api/files/${roomKey}/nodes` + (operation === 'insert' ? '' : '/grand-0-0')
    const method = { insert: 'POST', update: 'PATCH', delete: 'DELETE' }[operation]
    const body = command(operation === 'insert'
      ? { uid: 'custom-direct-' + operation, parent: 'target', text: 'inserted' }
      : operation === 'update' ? { text: 'changed', note: 'changed note' } : {})
    const result = await request(app.base, path, { method, body })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const trace = app.observer.trace()
    t.diagnostic(JSON.stringify({ case: 'R19-' + operation, submissionPath: result.body.submissionPath,
      N: 1000, trace }))
    assert.equal(result.body.submissionPath, 'direct', `R19 ordinary HTTP ${operation} used the legacy full-tree path`)
    assert.equal(trace.snapshotCalls, 0, 'R19 direct response loaded a whole snapshot')
    const fullRows = trace.sql.filter(row => /from room_nodes/i.test(row.sql) && /\bdata\b/i.test(row.sql) && row.rows > 20)
    assert.deepEqual(fullRows, [], 'R19 unrelated graph data was transferred during a local write')
  })
}

test('R19 ordinary Direct text update avoids redundant preflight and SOP reads within 18 SQL round trips', async t => {
  const { roomKey } = await app.seed()
  app.observer.reset()
  const written = await request(app.base, `/api/files/${roomKey}/nodes/grand-0-0`, {
    method: 'PATCH', body: command({ text: 'roundtrip-budget' })
  })
  assert.equal(written.status, 200)
  assert.equal(written.body.submissionPath, 'direct')
  const trace = app.observer.trace()
  t.diagnostic(JSON.stringify({ case: 'R19-roundtrips', sqlCount: trace.sql.length, sql: trace.sql }))
  assert.ok(trace.sql.length <= 18, 'ordinary UID text write has redundant full preflight round trips')
  assert.equal(trace.sql.filter(row => /^select uid, parent_uid, position, data, is_root, node_version, deleted_at from room_nodes/i.test(row.sql)).length, 1,
    'SOP guard should inspect the same transaction-local target row already read by applyUpdate')
  const room = await app.storage.getRoom(roomKey)
  assert.equal(written.body.title, room.title)
  assert.equal(new Date(written.body.updated_at).getTime(), new Date(room.updated_at).getTime())
})

test('R19 verified MCP custom-UID text update preserves the Direct and legacy normalized business state', async () => {
  const first = await app.seed(50)
  const second = await app.seed(50)
  const edit = { text: 'parity text', note: 'parity note' }
  const legacy = await legacyRequest(app.base, `/api/files/${first.roomKey}/nodes/child-1`, { method: 'PATCH', body: command(edit) })
  const direct = await request(app.base, `/api/files/${second.roomKey}/nodes/child-1`, {
    method: 'PATCH', body: command(edit), mcpPrincipal: 'performance-owner'
  })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.body.submissionPath, 'legacy')
  assert.equal(direct.status, 200)
  assert.equal(direct.body.submissionPath, 'direct')
  const a = await app.storage.readRoomNodes(first.roomKey)
  const b = await app.storage.readRoomNodes(second.roomKey)
  assert.deepEqual(a.nodes, b.nodes)
  const { applyCollabEvent } = require('../bin/collabRecovery')
  assert.deepEqual(applyCollabEvent(first.graph, legacy.body.event), applyCollabEvent(second.graph, direct.body.event))
  const one = await app.storage.getRoomOperation(first.roomKey, legacy.body.operationId)
  const two = await app.storage.getRoomOperation(second.roomKey, direct.body.operationId)
  const { createMemoryStore } = require('../bin/collabV2/directStore')
  const { applyDirect } = require('../bin/collabV2/directApplier')
  const restoreA = createMemoryStore(JSON.parse(JSON.stringify(a.nodes)))
  const restoreB = createMemoryStore(JSON.parse(JSON.stringify(b.nodes)))
  await applyDirect(restoreA, one.inverse_payload, { version: 9 })
  await applyDirect(restoreB, two.inverse_payload, { version: 9 })
  assert.deepEqual(restoreA.graph, restoreB.graph)
  assert.equal(restoreA.graph['child-1'].data.text, 'child-1')
  assert.deepEqual(restoreA.graph.target.children, first.graph.target.children)
})

test('R20 SQL failure rolls back real node, operation and outbox changes', async () => {
  const { roomKey } = await app.seed()
  const before = await app.counters(roomKey)
  process.env.COLLAB_FAULT_INJECT = 'before_commit_once'
  try {
    const result = await request(app.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', mcpPrincipal: 'performance-owner',
      body: command({ uid: 'rollback-child', parent: 'target', text: 'rollback' })
    })
    assert.equal(result.status, 500)
    assert.equal(result.body.code, 'FAULT_INJECTED')
    assert.deepEqual(await app.counters(roomKey), before)
    const rows = await app.pool.query('select uid from room_nodes where room_key=$1 and uid=$2', [roomKey, 'rollback-child'])
    assert.equal(rows.rows.length, 0)
  } finally { delete process.env.COLLAB_FAULT_INJECT }
})

test('R20 MCP same-ID replay after committed response loss creates only one version and outbox row', async () => {
  const { roomKey } = await app.seed()
  const body = command({ uid: 'lost-ack-child', parent: 'target', text: 'one durable insert' })
  await assert.rejects(request(app.base, `/api/files/${roomKey}/nodes`, {
    method: 'POST', body, mcpPrincipal: 'performance-owner', headers: { 'x-performance-drop-response': '1' }
  }))
  const retry = await request(app.base, `/api/files/${roomKey}/nodes`, { method: 'POST', body, mcpPrincipal: 'performance-owner' })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.duplicate, true)
  const state = await app.counters(roomKey)
  assert.equal(Number(state.version), 8)
  assert.equal(state.operations, 1)
  assert.equal(state.outbox, 1)
})

test('R20 ordinary HTTP repeated ID retains the existing old-result contract even with a different body', async () => {
  const { roomKey } = await app.seed()
  const id = randomUUID()
  const first = await request(app.base, `/api/files/${roomKey}/nodes/child-0`, {
    method: 'PATCH', body: command({ operation_id: id, text: 'first value' })
  })
  const second = await request(app.base, `/api/files/${roomKey}/nodes/child-0`, {
    method: 'PATCH', body: command({ operation_id: id, text: 'different value' })
  })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.duplicate, true)
  assert.equal(second.body.operationId, first.body.operationId)
  assert.equal(Number((await app.counters(roomKey)).version), 8)
  const tree = await app.storage.readRoomNodes(roomKey)
  assert.equal(tree.nodes['child-0'].data.text, 'first value')
})

test('R20 ordinary HTTP Direct rolls back a SQL fault and replays one commit after response loss', async () => {
  const { roomKey } = await app.seed()
  const before = await app.counters(roomKey)
  const path = `/api/files/${roomKey}/nodes`
  const body = command({ uid: 'http-recovery-child', parent: 'target', text: 'http recovery' })
  process.env.COLLAB_FAULT_INJECT = 'before_commit_once'
  try {
    const rejected = await request(app.base, path, { method: 'POST', body })
    assert.equal(rejected.status, 500)
    assert.equal(rejected.body.code, 'FAULT_INJECTED')
    assert.deepEqual(await app.counters(roomKey), before)
  } finally { delete process.env.COLLAB_FAULT_INJECT }
  await assert.rejects(request(app.base, path, {
    method: 'POST', body, headers: { 'x-performance-drop-response': '1' }
  }))
  const retry = await request(app.base, path, { method: 'POST', body })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.submissionPath, 'direct')
  assert.equal(retry.body.duplicate, true)
  const state = await app.counters(roomKey)
  assert.equal(Number(state.version), 8)
  assert.equal(state.operations, 1)
  assert.equal(state.outbox, 1)
})

test('R21 default HTTP flag absence keeps legacy and root deletion guards are equivalent', async () => {
  const { roomKey } = await app.seed()
  const prior = process.env.COLLAB_HTTP_DIRECT
  try {
    delete process.env.COLLAB_HTTP_DIRECT
    const written = await request(app.base, `/api/files/${roomKey}/nodes/child-1`, {
      method: 'PATCH', body: command({ text: 'legacy by default' })
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.submissionPath, 'legacy')
  } finally { process.env.COLLAB_HTTP_DIRECT = prior }
  const before = await app.counters(roomKey)
  const legacy = await legacyRequest(app.base, `/api/files/${roomKey}/nodes/root`, { method: 'DELETE', body: command() })
  const direct = await request(app.base, `/api/files/${roomKey}/nodes/root`, { method: 'DELETE', body: command() })
  assert.equal(direct.status, legacy.status)
  assert.equal(direct.body.code, legacy.body.code)
  assert.deepEqual(await app.counters(roomKey), before)
})

test('R21 unsupported structural shape chooses legacy before write; real ACL and conflicts never write', async () => {
  const { roomKey } = await app.seed()
  const moved = await request(app.base, `/api/files/${roomKey}/nodes/child-0`, {
    method: 'PATCH', mcpPrincipal: 'performance-owner', body: command({ parent: 'unrelated', index: 0 })
  })
  assert.equal(moved.status, 200)
  assert.equal(moved.body.submissionPath, 'legacy')
  const before = await app.counters(roomKey)
  const denied = await request(app.base, `/api/files/${roomKey}/nodes/child-1`, {
    method: 'PATCH', actor: 'performance-viewer', mcpPrincipal: 'performance-viewer', body: command({ text: 'denied' })
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'FORBIDDEN')
  const conflict = await request(app.base, `/api/files/${roomKey}/nodes/target`, {
    method: 'PATCH', mcpPrincipal: 'performance-owner', body: command({ text: 'bad', expected: { note: 'does-not-match' } })
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await app.counters(roomKey), before)
})

test('R21 MCP operation ID rejects another business request and another verified principal', async () => {
  const { roomKey } = await app.seed()
  const body = command({ text: 'first' })
  const path = `/api/files/${roomKey}/nodes/child-1`
  const first = await request(app.base, path, { method: 'PATCH', body, mcpPrincipal: 'performance-owner' })
  assert.equal(first.status, 200)
  const changed = await request(app.base, path, {
    method: 'PATCH', body: { ...body, text: 'different' }, mcpPrincipal: 'performance-owner'
  })
  assert.equal(changed.status, 409)
  assert.equal(changed.body.code, 'OPERATION_ID_CONFLICT')
  // Actor remains authorized owner; only the verified transport principal changes.
  const other = await request(app.base, path, { method: 'PATCH', body, mcpPrincipal: 'performance-viewer' })
  assert.equal(other.status, 409)
  assert.equal(other.body.code, 'OPERATION_ID_CONFLICT')
  assert.equal((await app.counters(roomKey)).operations, 1)
})

function ack(socket, event, body) {
  return timeout(new Promise(resolve => socket.emit(event, body, resolve)), 'socket acknowledgement timed out')
}
async function client(base, roomKey) {
  const { io } = require('socket.io-client')
  const clientId = 'performance-socket-' + randomUUID()
  const socket = io(base, { path: '/collab-v2', transports: ['websocket'], forceNew: true,
    reconnection: false, auth: { userId: 'performance-owner', clientId } })
  await timeout(new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  }), 'socket connection timed out')
  const joined = await ack(socket, 'join', { roomKey, clientId, lastServerRevision: 7 })
  assert.equal(joined.ok, true)
  return { socket, clientId }
}

test('R22 two actual application processes broadcast one canonical event each for a committed HTTP write', async () => {
  const { roomKey } = await app.seed()
  const a = await isolatedInstance({ sockets: true })
  const b = await isolatedInstance({ sockets: true })
  const sockets = []
  try {
    const ca = await client(a.base, roomKey)
    const cb = await client(b.base, roomKey)
    sockets.push(ca.socket, cb.socket)
    const receivedA = []
    const receivedB = []
    ca.socket.on('op:event', event => receivedA.push(event))
    cb.socket.on('op:event', event => receivedB.push(event))
    const inserted = await request(a.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', mcpPrincipal: 'performance-owner',
      body: command({ uid: 'two-instance-child', parent: 'target', text: 'broadcast once' })
    })
    assert.equal(inserted.status, 200)
    const started = Date.now()
    while ((!receivedA.length || !receivedB.length) && Date.now() - started < 10000) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    for (const events of [receivedA, receivedB]) {
      const matching = events.filter(event => event.opId === inserted.body.operationId)
      assert.equal(matching.length, 1)
      assert.equal(matching[0].payload.uid, 'two-instance-child')
      assert.equal(matching[0].payload.data.text, 'broadcast once')
      assert.equal(matching[0].serverRevision, 8)
    }
  } finally {
    sockets.forEach(socket => socket.close())
    await b.close()
    await a.close()
  }
})

test('R22 real mixed legacy deletion and Direct socket undo restore child order and tombstones', async () => {
  const { roomKey, graph } = await app.seed()
  const remote = await isolatedInstance({ sockets: true })
  let connection
  try {
    const deleted = await legacyRequest(app.base, `/api/files/${roomKey}/nodes/child-1`, {
      method: 'DELETE', body: command()
    })
    assert.equal(deleted.status, 200)
    const original = await app.storage.getRoomOperation(roomKey, deleted.body.operationId)
    assert.ok(original.inverse_payload.payload.nodes, 'legacy inverse fixture must use nodes')
    connection = await client(remote.base, roomKey)
    const undone = await ack(connection.socket, 'op', {
      opId: randomUUID(), roomKey, clientId: connection.clientId, baseRevision: 8,
      type: 'operation.undo', payload: { targetOperationId: deleted.body.operationId }
    })
    assert.equal(undone.ok, true, JSON.stringify(undone))
    const restored = await app.storage.readRoomNodes(roomKey)
    assert.deepEqual(restored.nodes.target.children, graph.target.children)
    assert.deepEqual(restored.nodes['child-1'].children, graph['child-1'].children)
    const tombstones = await app.pool.query(
      `select uid from room_nodes where room_key=$1 and uid=any($2::text[]) and deleted_at is not null`,
      [roomKey, ['child-1', 'grand-1-0', 'grand-1-1']]
    )
    assert.equal(tombstones.rows.length, 0)
  } finally {
    if (connection) connection.socket.close()
    await remote.close()
  }
})

test('R22 Direct rows deletion inverse restores through the real legacy HTTP undo endpoint', async () => {
  const { roomKey, graph } = await app.seed()
  const deleted = await request(app.base, `/api/files/${roomKey}/nodes/child-1`, {
    method: 'DELETE', body: command(), mcpPrincipal: 'performance-owner'
  })
  assert.equal(deleted.status, 200)
  const operation = await app.storage.getRoomOperation(roomKey, deleted.body.operationId)
  assert.ok(Array.isArray(operation.inverse_payload.payload.rows), 'Direct inverse fixture must use rows')
  const undo = await request(app.base, `/api/maps/${roomKey}/operations/${deleted.body.operationId}/undo`, {
    method: 'POST', body: command({ baseVersion: 8 })
  })
  assert.equal(undo.status, 201, JSON.stringify(undo.body))
  const restored = await app.storage.readRoomNodes(roomKey)
  assert.deepEqual(restored.nodes.target.children, graph.target.children)
  assert.deepEqual(restored.nodes['child-1'].children, graph['child-1'].children)
})

test('R22 Direct rows deletion inverse restores original sibling order through the real Direct socket undo', async () => {
  const { roomKey, graph } = await app.seed()
  const remote = await isolatedInstance({ sockets: true })
  let connection
  try {
    const deleted = await request(app.base, `/api/files/${roomKey}/nodes/child-1`, {
      method: 'DELETE', body: command(), mcpPrincipal: 'performance-owner'
    })
    assert.equal(deleted.status, 200)
    connection = await client(remote.base, roomKey)
    const undone = await ack(connection.socket, 'op', {
      opId: randomUUID(), roomKey, clientId: connection.clientId, baseRevision: 8,
      type: 'operation.undo', payload: { targetOperationId: deleted.body.operationId }
    })
    assert.equal(undone.ok, true, JSON.stringify(undone))
    const restored = await app.storage.readRoomNodes(roomKey)
    assert.deepEqual(restored.nodes.target.children, graph.target.children)
    assert.deepEqual(restored.nodes['child-1'].children, graph['child-1'].children)
  } finally {
    if (connection) connection.socket.close()
    await remote.close()
  }
})

test('R22 actual event bridge head reconciliation delivers an operation when notifications are dropped', async () => {
  const { roomKey } = await app.seed()
  const remote = await isolatedInstance({ sockets: true })
  let connection
  try {
    connection = await client(remote.base, roomKey)
    await remote.control('dropNotifications', { value: true })
    const received = []
    connection.socket.on('op:event', event => received.push(event))
    const result = await request(app.base, `/api/files/${roomKey}/nodes`, {
      method: 'POST', mcpPrincipal: 'performance-owner',
      body: command({ uid: 'missed-notification', parent: 'target', text: 'head reconciliation' })
    })
    assert.equal(result.status, 200)
    const started = Date.now()
    while (!received.length && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(received.filter(event => event.opId === result.body.operationId).length, 1)
    assert.equal(received[0].payload.uid, 'missed-notification')
    assert.equal(received[0].serverRevision, 8)
  } finally {
    if (connection) connection.socket.close()
    await remote.close()
  }
})

test('R22 HTTP and Socket recovery read a real archive page and reject a real log gap without partial data', async () => {
  const { roomKey } = await app.seed()
  const remote = await isolatedInstance({ sockets: true })
  let connection
  try {
    for (let i = 0; i < 3; i++) {
      const written = await request(app.base, `/api/files/${roomKey}/nodes/child-0`, {
        method: 'PATCH', body: command({ text: 'revision-' + i }), mcpPrincipal: 'performance-owner'
      })
      assert.equal(written.status, 200)
    }
    // Isolated retention/corruption fixture only; production recovery queries run unchanged.
    await app.pool.query(
      `insert into room_operations_archive(room_key,version,operation_id,actor_id,client_id,
         operation_type,payload,event,inverse_payload,created_at,archived_at)
       select room_key,version,operation_id,actor_id,client_id,operation_type,payload,event,inverse_payload,created_at,now()
       from room_operations where room_key=$1 and version=8`, [roomKey]
    )
    await app.pool.query('delete from room_operations where room_key=$1 and version=8', [roomKey])
    const page = await request(app.base, `/api/maps/${roomKey}/operations?after=7&limit=2&headVersion=10`)
    assert.equal(page.status, 200)
    assert.deepEqual(page.body.operations.map(op => op.version), [8, 9])
    assert.equal(page.body.hasMore, true)
    connection = await client(remote.base, roomKey)
    const synchronized = await ack(connection.socket, 'sync', { roomKey, afterRevision: 7, limit: 2, headVersion: 10 })
    assert.equal(synchronized.ok, true)
    assert.deepEqual(synchronized.operations.map(op => op.serverRevision), [8, 9])
    await app.pool.query('delete from room_operations where room_key=$1 and version=9', [roomKey])
    const gap = await request(app.base, `/api/maps/${roomKey}/operations?after=7&headVersion=10`)
    assert.equal(gap.status, 409)
    assert.equal(gap.body.code, 'RESNAPSHOT_REQUIRED')
    assert.deepEqual(gap.body.operations, [])
    assert.equal(gap.body.missingVersion, 9)
    const socketGap = await ack(connection.socket, 'sync', { roomKey, afterRevision: 7, headVersion: 10 })
    assert.equal(socketGap.ok, true)
    assert.equal(socketGap.reload, true)
    assert.equal(socketGap.completeFromRevision, 10)
    assert.deepEqual(socketGap.operations, [])
  } finally {
    if (connection) connection.socket.close()
    await remote.close()
  }
})
