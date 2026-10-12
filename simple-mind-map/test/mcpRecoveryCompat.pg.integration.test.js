const assert = require('assert')
const http = require('http')
const { randomUUID } = require('crypto')

function assertIsolatedDatabaseEnvironment() {
  const errors = []
  if (process.env.MIND_MAP_SKIP_ROOT_ENV !== '1') {
    errors.push('MIND_MAP_SKIP_ROOT_ENV must be exactly 1')
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(process.env.PGHOST || ''))) {
    errors.push('PGHOST must point to loopback')
  }
  if (String(process.env.PGPORT || '') !== '25492') {
    errors.push('PGPORT must be the isolated Compose port 25492')
  }
  if (String(process.env.PGDATABASE || '') !== 'mcp_incremental_test') {
    errors.push('PGDATABASE must be mcp_incremental_test')
  }
  if (process.env.COLLAB_V2 !== '1') {
    errors.push('COLLAB_V2 must be exactly 1')
  }
  if (errors.length) {
    throw new Error(
      'Refusing recovery integration test outside the isolated MCP test database: ' +
        errors.join('; ')
    )
  }
}

// Check the test-only connection before loading storage.js (which loads env files).
assertIsolatedDatabaseEnvironment()
require('../bin/loadEnv')

const storage = require('../bin/storage')
const history = require('../bin/collabHistory')
const { attachCollabV2 } = require('../bin/collabV2/socketServer')

const TEST_ACTOR = 'anonymous'
const CLIENT_TIMEOUT_MS = 8000

function node(uid, text, children = [], position = '') {
  return {
    isRoot: uid === 'root',
    data: { uid, text },
    children,
    position
  }
}

function initialTree() {
  return {
    root: node('root', 'Root', ['sibling', 'parent']),
    sibling: node('sibling', 'Sibling', [], 'a0'),
    parent: node('parent', 'Parent', ['child-a', 'child-b'], 'a1'),
    'child-a': node('child-a', 'Child A', [], 'a0'),
    'child-b': node('child-b', 'Child B', [], 'a1')
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendJson(res, statusCode, body) {
  if (res.writableEnded) return
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function createHttpServer() {
  return http.createServer((req, res) => {
    req.authUser = { id: TEST_ACTOR, name: 'MCP recovery integration test' }
    Promise.resolve(storage.handleApi(req, res))
      .then(handled => {
        if (!handled) sendJson(res, 404, { ok: false, code: 'TEST_ROUTE_NOT_FOUND' })
      })
      .catch(error => {
        sendJson(res, error.statusCode || 500, {
          ok: false,
          code: error.code || 'TEST_HTTP_ERROR',
          error: error.message || String(error)
        })
      })
  })
}

async function requestJson(baseUrl, method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (_) {
    throw new Error(`${method} ${path} returned non-JSON (${response.status})`)
  }
  return { status: response.status, body: data }
}

function emitAck(socket, event, payload, timeoutMs = CLIENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), timeoutMs)
    socket.emit(event, payload, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

async function connectSocket(baseUrl, clientId) {
  const { io } = require('socket.io-client')
  const socket = io(baseUrl, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: CLIENT_TIMEOUT_MS
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('collab-v2 socket connect timed out')), CLIENT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  socket.data = { recoveryTestClientId: clientId }
  return socket
}

async function joinSocket(socket, roomKey, clientId, lastServerRevision = 0) {
  return emitAck(socket, 'join', {
    roomKey,
    clientId,
    name: 'MCP recovery integration test',
    lastServerRevision
  })
}

async function submitSocket(socket, roomKey, clientId, type, payload, clientSeq = 1) {
  const baseRevision = await storage.getRoomVersion(roomKey)
  const result = await emitAck(socket, 'op', {
    opId: randomUUID(),
    roomKey,
    clientId,
    clientSeq,
    baseRevision,
    type,
    payload
  })
  assert.strictEqual(result && result.ok, true, JSON.stringify(result))
  return result
}

async function seedRoom(roomKey, nodes = initialTree()) {
  await storage.upsertRoom(roomKey, 'MCP recovery isolated test', { nodes })
}

async function rowsFor(roomKey, uids) {
  const result = await storage.getPool().query(
    `select uid, parent_uid, position, data, is_root, deleted_at
       from room_nodes
      where room_key = $1 and uid = any($2::text[])
      order by uid`,
    [roomKey, uids]
  )
  return result.rows
}

function structuralRows(rows) {
  return rows.map(row => ({
    uid: row.uid,
    parent_uid: row.parent_uid,
    position: row.position,
    data: row.data,
    is_root: row.is_root
  }))
}

function assertTombstoneState(rows, expectedDeleted) {
  assert.strictEqual(new Set(rows.map(row => row.uid)).size, rows.length, 'duplicate subtree rows')
  const deleted = new Set(expectedDeleted)
  for (const row of rows) {
    assert.strictEqual(
      row.deleted_at != null,
      deleted.has(row.uid),
      `unexpected tombstone state for ${row.uid}`
    )
  }
}

function makeLegacyNodesSnapshot(rows) {
  const nodes = {}
  const byParent = new Map()
  for (const row of rows) {
    nodes[row.uid] = {
      isRoot: !!row.is_root,
      data: { ...(row.data || {}), uid: row.uid },
      children: [],
      position: row.position || ''
    }
    if (row.parent_uid) {
      if (!byParent.has(row.parent_uid)) byParent.set(row.parent_uid, [])
      byParent.get(row.parent_uid).push(row)
    }
  }
  for (const [parentUid, children] of byParent) {
    if (!nodes[parentUid]) continue
    children.sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')))
    nodes[parentUid].children = children.map(row => row.uid)
  }
  return nodes
}

async function replaceInverseSnapshot(roomKey, operationId, rows, format) {
  const operation = await storage.getRoomOperation(roomKey, operationId)
  assert.strictEqual(operation && operation.inverse_payload?.type, 'node.restore')
  const inverse = { ...operation.inverse_payload }
  delete inverse.nodes
  delete inverse.rows
  if (format === 'nodes') {
    inverse.nodes = makeLegacyNodesSnapshot(rows)
  } else {
    inverse.rows = rows.map(row => ({
      uid: row.uid,
      parent_uid: row.parent_uid,
      position: row.position,
      data: row.data,
      is_root: row.is_root
    }))
  }
  const result = await storage.getPool().query(
    `update room_operations
        set inverse_payload = $3::jsonb
      where room_key = $1 and operation_id = $2`,
    [roomKey, operationId, JSON.stringify(inverse)]
  )
  assert.strictEqual(result.rowCount, 1, `failed to seed ${format} inverse fixture`)
  return storage.getRoomOperation(roomKey, operationId)
}

async function postOperation(baseUrl, roomKey, body) {
  return requestJson(baseUrl, 'POST', `/api/maps/${encodeURIComponent(roomKey)}/operations`, body)
}

async function assertNoPartialRecovery(result, headVersion, missingVersion) {
  assert.strictEqual(result.status, 409)
  assert.strictEqual(result.body.code, 'RESNAPSHOT_REQUIRED')
  assert.strictEqual(Number(result.body.currentRevision), headVersion)
  assert.strictEqual(Number(result.body.completeFromRevision), headVersion)
  if (Array.isArray(result.body.operations)) {
    assert.deepStrictEqual(result.body.operations, [], 'HTTP recovery must not return partial operations')
  }
  if (Array.isArray(result.body.events)) {
    assert.deepStrictEqual(result.body.events, [], 'HTTP recovery must not return partial events')
  }
  assert.strictEqual(Number(result.body.missingVersion), missingVersion)
}

async function testLegacyNodesSnapshotIsUndoableThroughSocket(baseUrl) {
  const roomKey = `mcp-recovery-legacy-${randomUUID()}`
  const uids = ['parent', 'child-a', 'child-b']
  await seedRoom(roomKey)
  const initialRows = await rowsFor(roomKey, uids)
  assertTombstoneState(initialRows, [])

  const deletion = await postOperation(baseUrl, roomKey, {
    operationId: randomUUID(),
    clientId: randomUUID(),
    baseVersion: 0,
    type: 'node.delete',
    payload: { uid: 'parent' }
  })
  assert.strictEqual(deletion.status, 201, JSON.stringify(deletion.body))
  const targetOperationId = deletion.body.operationId
  const stored = await replaceInverseSnapshot(roomKey, targetOperationId, initialRows, 'nodes')
  assert.strictEqual(stored.inverse_payload.type, 'node.restore')
  assert.ok(stored.inverse_payload.nodes, 'legacy HTTP inverse must contain nodes snapshot')
  const afterDelete = await rowsFor(roomKey, uids)
  assertTombstoneState(afterDelete, uids)

  const clientId = randomUUID()
  const socket = await connectSocket(baseUrl, clientId)
  try {
    const joined = await joinSocket(socket, roomKey, clientId)
    assert.strictEqual(joined.ok, true, JSON.stringify(joined))
    const undo = await emitAck(socket, 'op', {
      opId: randomUUID(),
      roomKey,
      clientId,
      clientSeq: 1,
      baseRevision: await storage.getRoomVersion(roomKey),
      type: 'operation.undo',
      payload: { targetOperationId }
    })
    assert.strictEqual(undo.ok, true, JSON.stringify(undo))

    const restoredRows = await rowsFor(roomKey, uids)
    assert.deepStrictEqual(structuralRows(restoredRows), structuralRows(initialRows))
    assertTombstoneState(restoredRows, [])
  } finally {
    socket.disconnect()
  }
}

async function testDirectRowsSnapshotSupportsHttpUndoRedo(baseUrl) {
  const roomKey = `mcp-recovery-direct-${randomUUID()}`
  const uids = ['parent', 'child-a', 'child-b']
  await seedRoom(roomKey)
  const initialRows = await rowsFor(roomKey, uids)
  const clientId = randomUUID()
  const socket = await connectSocket(baseUrl, clientId)
  try {
    const joined = await joinSocket(socket, roomKey, clientId)
    assert.strictEqual(joined.ok, true, JSON.stringify(joined))
    const deletion = await submitSocket(socket, roomKey, clientId, 'node.delete', { uid: 'parent' })
    const targetOperationId = deletion.operation.opId
    const stored = await replaceInverseSnapshot(roomKey, targetOperationId, initialRows, 'rows')
    assert.strictEqual(stored.inverse_payload.type, 'node.restore')
    assert.ok(Array.isArray(stored.inverse_payload.rows), 'Direct inverse must contain rows snapshot')
    assertTombstoneState(await rowsFor(roomKey, uids), uids)

    const undo = await requestJson(
      baseUrl,
      'POST',
      `/api/maps/${encodeURIComponent(roomKey)}/operations/${encodeURIComponent(targetOperationId)}/undo`,
      { operationId: randomUUID(), clientId: randomUUID() }
    )
    assert.strictEqual(undo.status, 201, JSON.stringify(undo.body))
    const restoredRows = await rowsFor(roomKey, uids)
    assert.deepStrictEqual(structuralRows(restoredRows), structuralRows(initialRows))
    assertTombstoneState(restoredRows, [])

    const redo = await requestJson(
      baseUrl,
      'POST',
      `/api/maps/${encodeURIComponent(roomKey)}/operations/${encodeURIComponent(targetOperationId)}/redo`,
      { operationId: randomUUID(), clientId: randomUUID() }
    )
    assert.strictEqual(redo.status, 201, JSON.stringify(redo.body))
    assertTombstoneState(await rowsFor(roomKey, uids), uids)
  } finally {
    socket.disconnect()
  }
}

async function seedThreeOperations(socket, roomKey, clientId) {
  const acks = []
  for (let index = 1; index <= 3; index++) {
    acks.push(
      await submitSocket(socket, roomKey, clientId, 'node.insert', {
        uid: `page-${index}`,
        parent: 'root',
        text: `Page ${index}`
      }, index)
    )
  }
  return acks
}

async function archiveVersion(roomKey, version) {
  const pool = storage.getPool()
  await pool.query(
    `insert into room_operations_archive
       (room_key, version, operation_id, actor_id, client_id,
        operation_type, payload, event, inverse_payload, created_at, archived_at)
     select room_key, version, operation_id, actor_id, client_id,
            operation_type, payload, event, inverse_payload, created_at, now()
       from room_operations
      where room_key = $1 and version = $2
     on conflict (room_key, version) do nothing`,
    [roomKey, version]
  )
  await pool.query(
    'delete from room_operations where room_key = $1 and version = $2',
    [roomKey, version]
  )
}

async function testHttpAndSocketReadArchivedOperationsContiguously(baseUrl) {
  const roomKey = `mcp-recovery-archive-${randomUUID()}`
  await seedRoom(roomKey, { root: node('root', 'Root') })
  const clientId = randomUUID()
  const socket = await connectSocket(baseUrl, clientId)
  try {
    const joined = await joinSocket(socket, roomKey, clientId)
    assert.strictEqual(joined.ok, true, JSON.stringify(joined))
    const acks = await seedThreeOperations(socket, roomKey, clientId)
    const revisions = acks.map(ack => ack.serverRevision)
    assert.deepStrictEqual(revisions, [1, 2, 3])
    await archiveVersion(roomKey, 1)

    const httpFirst = await requestJson(
      baseUrl,
      'GET',
      `/api/maps/${encodeURIComponent(roomKey)}/operations?after=0&limit=2`
    )
    assert.strictEqual(httpFirst.status, 200, JSON.stringify(httpFirst.body))
    assert.deepStrictEqual(httpFirst.body.operations.map(op => Number(op.version)), [1, 2])
    assert.strictEqual(Number(httpFirst.body.currentRevision), 3)
    assert.strictEqual(Number(httpFirst.body.completeFromRevision), 0)
    assert.strictEqual(httpFirst.body.hasMore, true)

    const httpSecond = await requestJson(
      baseUrl,
      'GET',
      `/api/maps/${encodeURIComponent(roomKey)}/operations?after=2&limit=2`
    )
    assert.strictEqual(httpSecond.status, 200, JSON.stringify(httpSecond.body))
    assert.deepStrictEqual(httpSecond.body.operations.map(op => Number(op.version)), [3])
    assert.strictEqual(Number(httpSecond.body.currentRevision), 3)
    assert.strictEqual(Number(httpSecond.body.completeFromRevision), 2)
    assert.strictEqual(httpSecond.body.hasMore, false)

    const socketFirst = await emitAck(socket, 'sync', {
      roomKey,
      afterRevision: 0,
      limit: 2
    })
    assert.strictEqual(socketFirst.ok, true, JSON.stringify(socketFirst))
    assert.strictEqual(socketFirst.reload, false)
    assert.deepStrictEqual(socketFirst.operations.map(op => Number(op.serverRevision)), [1, 2])
    assert.strictEqual(Number(socketFirst.currentRevision), 3)
    assert.strictEqual(Number(socketFirst.completeFromRevision), 0)
    assert.strictEqual(Number(socketFirst.serverRevision), 3)
    assert.strictEqual(Number(socketFirst.toRevision), 2)

    const socketSecond = await emitAck(socket, 'sync', {
      roomKey,
      afterRevision: 2,
      limit: 2
    })
    assert.strictEqual(socketSecond.ok, true, JSON.stringify(socketSecond))
    assert.strictEqual(socketSecond.reload, false)
    assert.deepStrictEqual(socketSecond.operations.map(op => Number(op.serverRevision)), [3])
    assert.strictEqual(Number(socketSecond.completeFromRevision), 2)
  } finally {
    socket.disconnect()
  }
}

async function testHttpAndSocketRequireSnapshotOnRealVersionGap(baseUrl) {
  const roomKey = `mcp-recovery-gap-${randomUUID()}`
  await seedRoom(roomKey, { root: node('root', 'Root') })
  const clientId = randomUUID()
  const socket = await connectSocket(baseUrl, clientId)
  try {
    const joined = await joinSocket(socket, roomKey, clientId)
    assert.strictEqual(joined.ok, true, JSON.stringify(joined))
    await seedThreeOperations(socket, roomKey, clientId)
    await archiveVersion(roomKey, 1)
    await storage.getPool().query(
      'delete from room_operations where room_key = $1 and version = 2',
      [roomKey]
    )
    await storage.getPool().query(
      'delete from room_operations_archive where room_key = $1 and version = 2',
      [roomKey]
    )

    const httpResult = await requestJson(
      baseUrl,
      'GET',
      `/api/maps/${encodeURIComponent(roomKey)}/operations?after=0&limit=10`
    )
    await assertNoPartialRecovery(httpResult, 3, 2)

    const socketResult = await emitAck(socket, 'sync', {
      roomKey,
      afterRevision: 0,
      limit: 10
    })
    assert.strictEqual(socketResult.ok, true, JSON.stringify(socketResult))
    assert.strictEqual(socketResult.reload, true)
    assert.strictEqual(socketResult.code, 'RESNAPSHOT_REQUIRED')
    assert.deepStrictEqual(socketResult.operations, [], 'Socket recovery must not return partial operations')
    assert.strictEqual(Number(socketResult.currentRevision), 3)
    assert.strictEqual(Number(socketResult.completeFromRevision), 3)
    assert.strictEqual(Number(socketResult.serverRevision), 3)
    assert.strictEqual(Number(socketResult.missingVersion), 2)
  } finally {
    socket.disconnect()
  }
}

async function testOldSocketRequestIsRejectedAfterVersionRestore(baseUrl) {
  const roomKey = `mcp-recovery-epoch-${randomUUID()}`
  await seedRoom(roomKey)
  const created = await requestJson(
    baseUrl,
    'POST',
    `/api/maps/${encodeURIComponent(roomKey)}/versions`,
    { name: 'MCP recovery epoch baseline' }
  )
  assert.strictEqual(created.status, 201, JSON.stringify(created.body))
  const versionId = created.body.version && created.body.version.versionId
  assert.ok(versionId, 'manual version endpoint did not return a version id')

  const clientId = randomUUID()
  const socket = await connectSocket(baseUrl, clientId)
  try {
    const joined = await joinSocket(socket, roomKey, clientId)
    assert.strictEqual(joined.ok, true, JSON.stringify(joined))
    const update = await submitSocket(
      socket,
      roomKey,
      clientId,
      'node.update',
      { uid: 'child-a', text: 'Edited after checkpoint' },
      1
    )
    assert.strictEqual(update.serverRevision, 1)

    const restored = await requestJson(
      baseUrl,
      'POST',
      `/api/maps/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(versionId)}/restore`,
      {
        expectedCurrentRevision: 1,
        clientId: randomUUID(),
        idempotencyKey: randomUUID()
      }
    )
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.body))
    assert.strictEqual(restored.body.fullTreeReason, 'VERSION_RESTORE')
    assert.strictEqual(Number(restored.body.newRevision), 2)

    const rejected = await emitAck(socket, 'op', {
      opId: randomUUID(),
      roomKey,
      clientId,
      clientSeq: 2,
      baseRevision: 1,
      type: 'node.update',
      payload: { uid: 'child-a', text: 'Stale edit must not apply' }
    })
    assert.strictEqual(rejected.ok, false, JSON.stringify(rejected))
    assert.strictEqual(rejected.code, 'STALE_AFTER_VERSION_RESTORE')
    assert.strictEqual(Number(rejected.currentVersion || rejected.details?.roomCurrentRevision), 2)
    const current = await rowsFor(roomKey, ['child-a'])
    assert.strictEqual(current[0].data.text, 'Child A')
  } finally {
    socket.disconnect()
  }
}

async function main() {
  let server
  let io
  const rooms = []
  const originalUpsertRoom = storage.upsertRoom
  storage.upsertRoom = async (...args) => {
    rooms.push(args[0])
    return originalUpsertRoom(...args)
  }
  try {
    const pool = storage.getPool()
    assert.strictEqual(Number(pool.options.port), 25492, 'storage pool is not configured for PG25492')
    await storage.initSchema()
    const identity = await pool.query('select current_database() as database')
    assert.strictEqual(identity.rows[0].database, 'mcp_incremental_test')
    await history.initHistorySchema(pool)
    history.createServerHistoryEngine(pool)

    server = createHttpServer()
    const collab = attachCollabV2(server)
    assert.strictEqual(collab.enabled, true, 'collabV2 must be enabled for this integration test')
    io = collab.io
    const port = await listen(server)
    const baseUrl = `http://127.0.0.1:${port}`

    const cases = [
      ['legacy nodes inverse restores through DirectApplier', () => testLegacyNodesSnapshotIsUndoableThroughSocket(baseUrl)],
      ['Direct rows inverse supports HTTP undo and redo', () => testDirectRowsSnapshotSupportsHttpUndoRedo(baseUrl)],
      ['HTTP and Socket page archived operations contiguously', () => testHttpAndSocketReadArchivedOperationsContiguously(baseUrl)],
      ['HTTP and Socket require a snapshot across a real gap', () => testHttpAndSocketRequireSnapshotOnRealVersionGap(baseUrl)],
      ['old Socket request is rejected after VERSION_RESTORE', () => testOldSocketRequestIsRejectedAfterVersionRestore(baseUrl)]
    ]
    const failures = []
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push({ name, error })
        console.error(`FAIL ${name}: ${error.stack || error.message}`)
      }
    }
    if (failures.length) {
      throw new Error(`${failures.length} MCP recovery integration case(s) failed`)
    }
    console.log('mcpRecoveryCompat.pg.integration.test.js ok')
  } finally {
    for (const roomKey of rooms.reverse()) {
      await storage.removeRoom(roomKey).catch(() => {})
      await storage.reviveRoom(roomKey).catch(() => {})
    }
    storage.upsertRoom = originalUpsertRoom
    if (io) {
      await new Promise(resolve => io.close(resolve))
    } else if (server && server.listening) {
      await new Promise(resolve => server.close(resolve))
    }
    await storage.getPool().end().catch(() => {})
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
