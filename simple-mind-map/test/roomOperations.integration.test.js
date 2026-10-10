const assert = require('assert')
const crypto = require('crypto')
require('../bin/loadEnv')
const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')
assertHistoryPgTestEnvironment()
const mindDoc = require('../bin/mindDoc')
const { applyCollabEvent, applyCollabEvents } = require('../bin/collabRecovery')
const { readRoomNodes, getPool } = require('../bin/storage')
const attachmentStore = require('../bin/nodeKnowledge/store')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:1234'
const wsUrl = (
  process.env.COLLAB_DIRECT_WS_URL || baseUrl.replace(/^http/, 'ws')
).replace(/\/$/, '')

class AuthedWebSocket extends WebSocket {
  constructor(url, protocols) {
    const token = process.env.MCP_TOKEN
    const headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(process.env.COLLAB_TEST_COOKIE
        ? { Cookie: process.env.COLLAB_TEST_COOKIE }
        : {}),
      ...(process.env.COLLAB_TEST_ORIGIN
        ? { Origin: process.env.COLLAB_TEST_ORIGIN }
        : {})
    }
    super(url, protocols, {
      headers
    })
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function connectRoom(roomKey, doc) {
  const provider = new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: AuthedWebSocket,
    disableBc: true,
    connect: false,
    maxBackoffTime: 1000
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      reject(new Error('websocket sync timeout'))
    }, 15000)
    provider.on('sync', synced => {
      if (!synced) return
      clearTimeout(timer)
      resolve(provider)
    })
    provider.on('connection-error', err => {
      clearTimeout(timer)
      provider.destroy()
      reject(err)
    })
    provider.connect()
  })
}

function authHeaders(extra = {}) {
  const token = process.env.MCP_TOKEN
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(process.env.COLLAB_TEST_COOKIE
      ? { Cookie: process.env.COLLAB_TEST_COOKIE }
      : {}),
    ...(process.env.COLLAB_TEST_ORIGIN
      ? { Origin: process.env.COLLAB_TEST_ORIGIN }
      : {}),
    'x-client-id': process.env.COLLAB_TEST_CLIENT_ID || 'attachment-test-client',
    ...extra
  }
}

async function request(path, options = {}) {
  const { headers, ...rest } = options
  const response = await fetch(baseUrl + path, {
    ...rest,
    headers: authHeaders(headers)
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

function structureOf(obj) {
  return Object.keys(obj || {})
    .sort()
    .map(uid => ({
      uid,
      children: [...((obj[uid] && obj[uid].children) || [])],
      text: obj[uid] && obj[uid].data && obj[uid].data.text,
      note: (obj[uid] && obj[uid].data && obj[uid].data.note) || ''
    }))
}

async function createRoom(title) {
  const roomKey = `ops-${crypto.randomUUID()}`
  const created = await request('/api/files', {
    method: 'POST',
    body: JSON.stringify({
      room_key: roomKey,
      title,
      tree: { data: { uid: 'root', text: 'Root' }, children: [] }
    })
  })
  assert.strictEqual(created.response.status, 201, created.data.error)
  assert.strictEqual(Number(created.data.version || 0), 0)
  return roomKey
}

async function deleteRoom(roomKey) {
  await request(`/api/files/${encodeURIComponent(roomKey)}`, { method: 'DELETE' })
}

async function withRoom(title, fn) {
  const roomKey = await createRoom(title)
  try {
    return await fn(roomKey)
  } finally {
    await deleteRoom(roomKey)
  }
}

async function insertChild(roomKey, uid, text, extra = {}) {
  return request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
    method: 'POST',
    headers: extra.headers,
    body: JSON.stringify({
      parent: extra.parent || 'root',
      uid,
      text,
      index: extra.index,
      confirm_sop_change: true
    })
  })
}

async function fetchAllOperations(roomKey, after = 0, limit = 200) {
  const operations = []
  let cursor = after
  let currentVersion = after
  let pages = 0
  while (true) {
    const { response, data } = await request(
      `/api/maps/${encodeURIComponent(roomKey)}/operations?after=${cursor}&limit=${limit}`
    )
    assert.strictEqual(response.status, 200, data.error)
    currentVersion = data.currentVersion
    operations.push(...data.operations)
    pages += 1
    if (!data.hasMore) {
      return { operations, currentVersion, pages, hasMore: false }
    }
    assert.ok(data.operations.length, 'hasMore without operations')
    cursor = data.operations[data.operations.length - 1].version
  }
}

async function serverNodes(roomKey) {
  const loaded = await request(
    `/api/files/${encodeURIComponent(roomKey)}?format=full`
  )
  assert.strictEqual(loaded.response.status, 200, loaded.data.error)
  assert.ok(loaded.data.tree, 'expected full tree')
  return {
    version: Number(loaded.data.version || 0),
    nodes: mindDoc.treeToObject(loaded.data.tree),
    title: loaded.data.title
  }
}

async function testSmokeAndRename(roomKey) {
  const firstId = crypto.randomUUID()
  const added = await insertChild(roomKey, 'child-1', 'Child 1', {
    headers: { 'X-Operation-Id': firstId }
  })
  assert.strictEqual(added.response.status, 200, added.data.error)
  assert.strictEqual(added.data.version, 1)
  assert.strictEqual(added.data.duplicate, false)

  const replay = await insertChild(roomKey, 'child-1', 'Child 1 duplicate', {
    headers: { 'X-Operation-Id': firstId }
  })
  assert.strictEqual(replay.data.duplicate, true)
  assert.strictEqual(replay.data.version, 1)

  const patched = await request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/child-1`,
    {
      method: 'PATCH',
      body: JSON.stringify({ note: 'after-insert', confirm_sop_change: true })
    }
  )
  assert.strictEqual(patched.response.status, 200, patched.data.error)
  assert.strictEqual(patched.data.version, 2)

  const renamed = await request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '操作日志房间-已改名' })
  })
  assert.strictEqual(renamed.response.status, 200, renamed.data.error)
  assert.strictEqual(renamed.data.version, 3)
  assert.strictEqual(renamed.data.title, '操作日志房间-已改名')
  assert.strictEqual(renamed.data.duplicate, false)

  const renamedAgain = await request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'PATCH',
    headers: { 'X-Operation-Id': renamed.data.operationId },
    body: JSON.stringify({ title: '不应生效' })
  })
  assert.strictEqual(renamedAgain.data.duplicate, true)
  assert.strictEqual(renamedAgain.data.version, 3)
  assert.strictEqual(renamedAgain.data.title, '操作日志房间-已改名')

  const replaced = await request(
    `/api/files/${encodeURIComponent(roomKey)}/replace`,
    {
      method: 'POST',
      body: JSON.stringify({
        confirm_sop_change: true,
        tree: {
          data: { uid: 'root', text: 'Root' },
          children: [{ data: { uid: 'kept', text: 'Kept' }, children: [] }]
        }
      })
    }
  )
  assert.strictEqual(replaced.response.status, 200, replaced.data.error)
  assert.strictEqual(Number(replaced.data.version), 4)

  const current = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
  assert.strictEqual(current.data.version, 4)

  const operations = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations?after=0`
  )
  assert.strictEqual(operations.data.operations.length, 4)
  assert.strictEqual(operations.data.operations[2].event.type, 'map.updated')
  assert.strictEqual(
    operations.data.operations[2].event.payload.resnapshot,
    false
  )
  assert.strictEqual(operations.data.operations[3].event.type, 'map.replaced')
  assert.strictEqual(operations.data.operations[3].event.payload.resnapshot, true)

  const snapshot = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/snapshot?depth=2`
  )
  assert.strictEqual(snapshot.data.version, 4)
  assert.ok(snapshot.data.tree)
}

async function testIdempotentTenTimes(roomKey) {
  const operationId = crypto.randomUUID()
  let last = null
  for (let i = 0; i < 10; i++) {
    last = await insertChild(roomKey, 'once', 'Once', {
      headers: { 'X-Operation-Id': operationId }
    })
    assert.strictEqual(last.response.status, 200, last.data.error)
    assert.strictEqual(last.data.version, 1)
    assert.strictEqual(last.data.uid, 'once')
    assert.strictEqual(last.data.duplicate, i > 0)
  }
  const truth = await serverNodes(roomKey)
  assert.strictEqual(truth.version, 1)
  assert.deepStrictEqual(truth.nodes.root.children, ['once'])
  assert.ok(truth.nodes.once)
}

async function testThousandVersions(roomKey) {
  for (let i = 1; i <= 1000; i++) {
    const step = await insertChild(roomKey, `child-${i}`, `Child ${i}`)
    assert.strictEqual(step.response.status, 200, step.data.error)
    assert.strictEqual(step.data.version, i)
    if (i === 198 || i === 200) {
      const snap = await request(
        `/api/maps/${encodeURIComponent(roomKey)}/snapshot?depth=2`
      )
      assert.strictEqual(snap.response.status, 200, snap.data.error)
      assert.strictEqual(snap.data.http_collab, true)
      assert.strictEqual(snap.data.version, i)
      assert.strictEqual(snap.data.lazy_load, snap.data.collapsed)
      if (i === 198) {
        assert.strictEqual(snap.data.node_count, 199)
        assert.strictEqual(snap.data.collapsed, false)
      }
      if (i === 200) {
        assert.strictEqual(snap.data.node_count, 201)
        assert.strictEqual(snap.data.collapsed, true)
      }
    }
  }
  const current = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
  assert.strictEqual(current.data.version, 1000)
  const paged = await fetchAllOperations(roomKey, 0, 200)
  assert.ok(paged.pages >= 5, `expected pagination, got ${paged.pages} pages`)
  assert.strictEqual(paged.currentVersion, 1000)
  assert.strictEqual(paged.operations.length, 1000)
  assert.deepStrictEqual(
    paged.operations.map(item => item.version),
    Array.from({ length: 1000 }, (_, i) => i + 1)
  )
}

async function testDroppedEventsConverge(roomKey) {
  const initial = await serverNodes(roomKey)
  const replicaA = {
    nodes: JSON.parse(JSON.stringify(initial.nodes)),
    last: 0
  }
  const replicaB = {
    nodes: JSON.parse(JSON.stringify(initial.nodes)),
    last: 0
  }
  const droppedA = []
  const droppedB = []
  const count = 40

  function onNotify(replica, event, version, drop) {
    if (drop) return
    if (version <= replica.last) return
    if (version !== replica.last + 1) return
    replica.nodes = applyCollabEvent(replica.nodes, event)
    replica.last = version
  }

  for (let i = 1; i <= count; i++) {
    const step = await insertChild(roomKey, `drop-${i}`, `Drop ${i}`)
    assert.strictEqual(step.response.status, 200, step.data.error)
    assert.strictEqual(step.data.version, i)
    const event = step.data.event
    const dropA = i % 10 === 0
    const dropB = i % 10 === 1
    if (dropA) droppedA.push(i)
    if (dropB) droppedB.push(i)
    onNotify(replicaA, event, i, dropA)
    onNotify(replicaB, event, i, dropB)
  }

  assert.ok(droppedA.length >= 4)
  assert.ok(droppedB.length >= 4)
  assert.ok(replicaA.last < count)
  assert.ok(replicaB.last < count)
  assert.notDeepStrictEqual(
    structureOf(replicaA.nodes),
    structureOf(replicaB.nodes),
    'replicas should diverge before catch-up'
  )

  async function catchUp(replica) {
    const { operations, currentVersion } = await fetchAllOperations(
      roomKey,
      replica.last,
      20
    )
    const applied = applyCollabEvents(replica.nodes, operations)
    assert.strictEqual(applied.type, 'apply')
    return { nodes: applied.nodes, version: currentVersion }
  }

  const caughtA = await catchUp(replicaA)
  const caughtB = await catchUp(replicaB)
  const truth = await serverNodes(roomKey)
  assert.strictEqual(caughtA.version, count)
  assert.strictEqual(caughtB.version, count)
  assert.strictEqual(truth.version, count)
  assert.deepStrictEqual(structureOf(caughtA.nodes), structureOf(truth.nodes))
  assert.deepStrictEqual(structureOf(caughtB.nodes), structureOf(truth.nodes))
}

async function testNormalizedTableRoundtrip(roomKey) {
  const added = await insertChild(roomKey, 'table-1', 'Table 1')
  assert.strictEqual(added.response.status, 200, added.data.error)
  const moved = await request(
    `/api/files/${encodeURIComponent(roomKey)}/nodes/table-1`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        note: 'from-table',
        confirm_sop_change: true
      })
    }
  )
  assert.strictEqual(moved.response.status, 200, moved.data.error)
  const truth = await serverNodes(roomKey)
  const table = await readRoomNodes(roomKey)
  assert.ok(table.nodes, 'room_nodes should be dual-written')
  assert.strictEqual(table.version, truth.version)
  assert.deepStrictEqual(structureOf(table.nodes), structureOf(truth.nodes))
  const consistency = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/consistency`
  )
  assert.strictEqual(consistency.response.status, 200, consistency.data.error)
  assert.strictEqual(consistency.data.ok, true)
  assert.strictEqual(consistency.data.source, 'table')
  assert.strictEqual(consistency.data.equal, true)
}

async function testDualClientReconnect(roomKey) {
  const initial = await serverNodes(roomKey)
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = await connectRoom(roomKey, docA)
  const providerB = await connectRoom(roomKey, docB)
  let replica = {
    nodes: JSON.parse(JSON.stringify(initial.nodes)),
    last: 0
  }

  const noticed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('documentChange not received')),
      10000
    )
    providerB.awareness.on('change', () => {
      const change = Array.from(providerB.awareness.getStates().values())
        .map(state => state.documentChange)
        .find(
          item =>
            item &&
            item.roomKey === roomKey &&
            Number(item.version) === 1 &&
            Number(item.clientId) !== providerB.awareness.clientID
        )
      if (!change) return
      clearTimeout(timer)
      resolve(change)
    })
  })

  const added = await insertChild(roomKey, 'live-1', 'Live 1')
  assert.strictEqual(added.data.version, 1)
  providerA.awareness.setLocalStateField('documentChange', {
    roomKey,
    userId: 'user-a',
    clientId: providerA.awareness.clientID,
    version: added.data.version,
    nonce: crypto.randomUUID()
  })
  const change = await noticed
  assert.strictEqual(Number(change.version), 1)

  const firstOps = await fetchAllOperations(roomKey, replica.last, 50)
  const firstApply = applyCollabEvents(replica.nodes, firstOps.operations)
  assert.strictEqual(firstApply.type, 'apply')
  replica = { nodes: firstApply.nodes, last: firstOps.currentVersion }
  assert.ok(replica.nodes['live-1'])

  providerB.destroy()
  docB.destroy()
  await delay(200)

  const second = await insertChild(roomKey, 'live-2', 'Live 2')
  const third = await insertChild(roomKey, 'live-3', 'Live 3')
  assert.strictEqual(second.data.version, 2)
  assert.strictEqual(third.data.version, 3)

  const docB2 = new Y.Doc()
  const providerB2 = await connectRoom(roomKey, docB2)
  const current = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
  assert.strictEqual(current.data.version, 3)
  const caught = await fetchAllOperations(roomKey, replica.last, 50)
  const applied = applyCollabEvents(replica.nodes, caught.operations)
  assert.strictEqual(applied.type, 'apply')
  const truth = await serverNodes(roomKey)
  assert.deepStrictEqual(structureOf(applied.nodes), structureOf(truth.nodes))
  assert.strictEqual(caught.currentVersion, 3)

  providerA.destroy()
  providerB2.destroy()
  docA.destroy()
  docB2.destroy()
}

async function testSubtreeKnownVersion(roomKey) {
  const added = await insertChild(roomKey, 'branch', 'Branch')
  assert.strictEqual(added.data.version, 1)

  const first = await request(
    `/api/files/${encodeURIComponent(roomKey)}/subtree?uid=root`
  )
  assert.strictEqual(first.response.status, 200, first.data.error)
  assert.notStrictEqual(first.data.unchanged, true)
  assert.strictEqual(first.data.version, 1)
  assert.ok(
    (first.data.children || []).some(
      child => child && child.data && child.data.uid === 'branch'
    )
  )

  const skipped = await request(
    `/api/files/${encodeURIComponent(roomKey)}/subtree?uid=root&knownVersion=1`
  )
  assert.strictEqual(skipped.response.status, 200, skipped.data.error)
  assert.strictEqual(skipped.data.unchanged, true)
  assert.strictEqual(skipped.data.version, 1)

  const alias = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/subtrees/root?knownVersion=1`
  )
  assert.strictEqual(alias.response.status, 200, alias.data.error)
  assert.strictEqual(alias.data.unchanged, true)

  const snapshot = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/snapshot`
  )
  assert.strictEqual(snapshot.response.status, 200, snapshot.data.error)
  assert.strictEqual(snapshot.data.version, 1)
  assert.ok(snapshot.data.tree.data.childCount >= 1)
  assert.strictEqual(snapshot.data.tree.data.subtreeVersion, 1)

  const located = await request(
    `/api/files/${encodeURIComponent(roomKey)}/locate?uid=branch`
  )
  assert.strictEqual(located.response.status, 200, located.data.error)
  assert.strictEqual(located.data.version, 1)
}

async function testAttachmentDetach(roomKey) {
  await insertChild(roomKey, 'attachment-a', 'Attachment A')
  await insertChild(roomKey, 'attachment-b', 'Attachment B')
  await insertChild(roomKey, 'attachment-c', 'Attachment C')
  await insertChild(roomKey, 'sop-attachment', 'SOP')
  const sharedId = `att-${crypto.randomUUID()}`
  const pool = getPool()
  await pool.query(
    `insert into node_attachments
       (id, room_key, node_uid, content_hash, file_name, mime_type, byte_size,
        status, error_message, extracted_text, extracted_chars, source_kind)
     values ($1, $2, 'attachment-a', $3, '共享附件.txt', 'text/plain', 20,
             'ready', '', '保留原始内容', 6, 'attachment')`,
    [sharedId, roomKey, `${roomKey}-attachment-hash`]
  )

  for (const [uid, status] of [
    ['attachment-a', 'ready'],
    ['attachment-b', 'ready'],
    ['attachment-c', 'processing'],
    ['sop-attachment', 'ready']
  ]) {
    const patched = await request(
      `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          attachmentId: uid === 'attachment-c' ? 'att-processing' : sharedId,
          attachmentUrl: `/api/files/${roomKey}/attachments/${sharedId}/content`,
          attachmentName: `${uid}.txt`,
          attachmentMimeType: 'text/plain',
          attachmentStatus: status,
          attachmentError: status === 'processing' ? '后台解析中' : '',
          attachmentExtractedText: status === 'ready' ? '截断预览' : '',
          attachmentProgress: status === 'processing' ? 42 : 100,
          confirm_sop_change: true
        })
      }
    )
    assert.strictEqual(patched.response.status, 200, patched.data.error)
  }

  const before = await serverNodes(roomKey)
  assert.strictEqual(
    before.nodes['sop-attachment'] && before.nodes['sop-attachment'].data.text,
    'SOP',
    'SOP root fixture must be present before attachment deletion checks'
  )
  assert.strictEqual(
    before.nodes['sop-attachment'].data.attachmentId,
    sharedId,
    'SOP root fixture must still point at the attachment before deletion checks'
  )
  const sopNeedsConfirmation = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=sop-attachment&base_version=${before.version}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(sopNeedsConfirmation.response.status, 400)
  assert.strictEqual(sopNeedsConfirmation.data.code, 'SOP_CONFIRM_REQUIRED')
  assert.strictEqual((await serverNodes(roomKey)).version, before.version)

  const checkpoint = await request(
    `/api/files/${encodeURIComponent(roomKey)}/versions`,
    { method: 'POST', body: JSON.stringify({ name: '附件删除前' }) }
  )
  assert.strictEqual(checkpoint.response.status, 201, checkpoint.data.error)
  const checkpointId = checkpoint.data.version.versionId

  assert.deepEqual(
    (await attachmentStore.listMeta(pool, roomKey, { nodeUid: 'attachment-a' })).map(
      item => item.id
    ),
    [sharedId]
  )
  assert.deepEqual(
    (await attachmentStore.listMeta(pool, roomKey, { nodeUid: 'attachment-b' })).map(
      item => item.id
    ),
    [sharedId]
  )

  const detached = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=attachment-a&base_version=${before.version}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(detached.response.status, 200, detached.data.error)
  assert.strictEqual(detached.data.detached, true)
  assert.strictEqual(detached.data.retained, true)
  assert.strictEqual(detached.data.revision, before.version + 1)
  assert.equal(detached.data.node.data.attachmentId, undefined)
  for (const field of [
    'attachmentUrl',
    'attachmentName',
    'attachmentMimeType',
    'attachmentStatus',
    'attachmentError',
    'attachmentExtractedText',
    'attachmentProgress'
  ]) {
    assert.equal(detached.data.node.data[field], undefined, `${field} must be cleared`)
  }
  const afterDetachOps = await fetchAllOperations(roomKey)
  assert.ok(
    afterDetachOps.operations.some(op => op.version === detached.data.revision),
    'detach must be a collaborative operation with a revision'
  )
  assert.deepEqual(
    await attachmentStore.listMeta(pool, roomKey, { nodeUid: 'attachment-a' }),
    [],
    'detached node listing must no longer include its former attachment'
  )
  assert.deepEqual(
    (await attachmentStore.listMeta(pool, roomKey, { nodeUid: 'attachment-b' })).map(
      item => item.id
    ),
    [sharedId],
    'shared file remains listed by the other node that still points to it'
  )
  assert.ok(await attachmentStore.getById(pool, roomKey, sharedId), 'stored row is retained')

  const currentAfterDetach = detached.data.revision
  const repeated = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=attachment-a&base_version=${currentAfterDetach}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(repeated.response.status, 200, repeated.data.error)
  assert.strictEqual(repeated.data.detached, false)
  assert.strictEqual(repeated.data.already_detached, true)
  assert.strictEqual(repeated.data.revision, currentAfterDetach)

  const mismatch = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/old-id?node_uid=attachment-b&base_version=${currentAfterDetach}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(mismatch.response.status, 409)
  assert.strictEqual(mismatch.data.code, 'ATTACHMENT_MISMATCH')
  assert.deepStrictEqual(mismatch.data.details, {
    node_uid: 'attachment-b',
    expected_attachment_id: 'old-id',
    current_attachment_id: sharedId
  })

  const restored = await request(
    `/api/files/${encodeURIComponent(roomKey)}/versions/${encodeURIComponent(
      checkpointId
    )}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedCurrentRevision: currentAfterDetach })
    }
  )
  assert.strictEqual(restored.response.status, 200, restored.data.error)
  assert.ok(restored.data.newRevision > currentAfterDetach)

  const staleAfterRestore = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=attachment-a&base_version=${currentAfterDetach}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(staleAfterRestore.response.status, 409)
  assert.strictEqual(staleAfterRestore.data.code, 'STALE_AFTER_VERSION_RESTORE')

  const validAfterRestore = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=attachment-a&base_version=${restored.data.newRevision}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(validAfterRestore.response.status, 200, validAfterRestore.data.error)
  assert.strictEqual(validAfterRestore.data.detached, true)
  assert.strictEqual(validAfterRestore.data.revision, restored.data.newRevision + 1)

  const processing = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/att-processing?node_uid=attachment-c&base_version=${validAfterRestore.data.revision}`,
    { method: 'DELETE' }
  )
  assert.strictEqual(processing.response.status, 200, processing.data.error)
  assert.strictEqual(processing.data.detached, true)
  assert.equal(processing.data.node.data.attachmentStatus, undefined)
  assert.equal(processing.data.node.data.attachmentProgress, undefined)
  const sopDetached = await request(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      sharedId
    )}?node_uid=sop-attachment&base_version=${processing.data.revision}&confirm_sop_change=1`,
    { method: 'DELETE' }
  )
  assert.strictEqual(sopDetached.response.status, 200, sopDetached.data.error)
  assert.strictEqual(sopDetached.data.detached, true)
  assert.ok(await attachmentStore.getById(pool, roomKey, sharedId), 'restore and detach retain file row')
}

async function testAttachmentDetachRoom(roomKey) {
  try {
    await testAttachmentDetach(roomKey)
  } finally {
    await getPool()
      .query('delete from node_attachments where room_key = $1', [roomKey])
      .catch(() => {})
  }
}

async function testUndoAndHistoricalSnapshot(roomKey) {
  const firstId = crypto.randomUUID()
  const added = await insertChild(roomKey, 'keep', 'Keep', {
    headers: { 'X-Operation-Id': firstId }
  })
  assert.strictEqual(added.data.version, 1)
  const secondId = crypto.randomUUID()
  const other = await insertChild(roomKey, 'gone', 'Gone', {
    headers: { 'X-Operation-Id': secondId }
  })
  assert.strictEqual(other.data.version, 2)

  const undone = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${secondId}/undo`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  assert.strictEqual(undone.response.status, 201, undone.data.error)
  assert.strictEqual(undone.data.event.type, 'operation.undone')
  const afterUndo = await serverNodes(roomKey)
  assert.ok(afterUndo.nodes.keep)
  assert.ok(!afterUndo.nodes.gone)
  assert.strictEqual(afterUndo.version, 3)

  const replay = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${secondId}/undo`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  assert.strictEqual(replay.response.status, 409)
  assert.strictEqual(replay.data.code, 'ALREADY_UNDONE')

  const redone = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${secondId}/redo`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  assert.strictEqual(redone.response.status, 201, redone.data.error)
  assert.strictEqual(redone.data.event.type, 'operation.redone')
  const afterRedo = await serverNodes(roomKey)
  assert.ok(afterRedo.nodes.gone)
  assert.strictEqual(afterRedo.version, 4)

  const historical = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/snapshot?version=1&depth=2`
  )
  assert.strictEqual(historical.response.status, 200, historical.data.error)
  assert.strictEqual(historical.data.version, 1)
  assert.strictEqual(historical.data.historical, true)
  const names = []
  const walk = node => {
    if (!node || !node.data) return
    names.push(node.data.text)
    ;(node.children || []).forEach(walk)
  }
  walk(historical.data.tree)
  assert.ok(names.includes('Keep'))
  assert.ok(!names.includes('Gone'))

  const sibling = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/operations/${firstId}/undo`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  assert.strictEqual(sibling.response.status, 201, sibling.data.error)
  const afterKeep = await serverNodes(roomKey)
  assert.ok(!afterKeep.nodes.keep)
  assert.ok(afterKeep.nodes.gone)
  assert.strictEqual(afterKeep.version, 5)

  const audit = await request(
    `/api/maps/${encodeURIComponent(roomKey)}/audit?limit=10`
  )
  assert.strictEqual(audit.response.status, 200, audit.data.error)
  assert.ok(audit.data.items.some(item => item.type === 'operation.undo'))
  assert.ok(audit.data.items.some(item => item.type === 'operation.redo'))
  assert.ok(audit.data.items.some(item => item.operationId === secondId))
}

async function testConcurrentInsertsAtSameParent(roomKey) {
  const first = await insertChild(roomKey, 'first', 'First', { index: 0 })
  assert.strictEqual(first.response.status, 200, first.data.error)
  assert.ok(first.data.position)
  const second = await insertChild(roomKey, 'second', 'Second', { index: 0 })
  assert.strictEqual(second.response.status, 200, second.data.error)
  assert.ok(second.data.position)
  assert.notStrictEqual(second.data.position, first.data.position)
  assert.strictEqual(second.data.index, 0)
  assert.ok(
    second.data.position < first.data.position,
    `${second.data.position} !< ${first.data.position}`
  )
  const loaded = await serverNodes(roomKey)
  assert.deepStrictEqual(loaded.nodes.root.children, ['second', 'first'])
}

async function main() {
  const health = await request('/api/health')
  if (!health.response.ok) {
    throw new Error(`collab server is not running at ${baseUrl}`)
  }

  if (process.env.ATTACHMENT_DELETE_ONLY === '1') {
    await withRoom('节点附件解绑', testAttachmentDetachRoom)
    console.log('node attachment delete integration passed')
    return
  }

  await withRoom('操作日志房间', testSmokeAndRename)
  await withRoom('幂等十次', testIdempotentTenTimes)
  await withRoom('规范化节点表', testNormalizedTableRoundtrip)
  await withRoom('双客户端重连', testDualClientReconnect)
  await withRoom('双客户端丢包', testDroppedEventsConverge)
  await withRoom('一千次版本', testThousandVersions)
  await withRoom('子树版本短路', testSubtreeKnownVersion)
  await withRoom('节点附件解绑', testAttachmentDetachRoom)
  await withRoom('撤销与历史快照', testUndoAndHistoricalSnapshot)
  await withRoom('同父并发插入', testConcurrentInsertsAtSameParent)
  console.log('room operations integration passed')
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
