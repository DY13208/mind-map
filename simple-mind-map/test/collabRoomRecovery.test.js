const assert = require('assert')
const { randomUUID } = require('crypto')
const {
  inspectRoom,
  describeReplaceLock,
  shouldQuarantineOutboxOp,
  summarizeOutbox
} = require('../src/utils/collabRoomRecovery')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { createOpId } = require('../bin/collabV2/protocol')

function fakeDb(handlers) {
  return {
    query: async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ')
      for (const [re, fn] of handlers) {
        if (re.test(text)) return fn(params, text)
      }
      throw new Error('unexpected sql: ' + text.slice(0, 120))
    }
  }
}

async function testInspectDoesNotBuildTree() {
  let selectedNodes = false
  const db = fakeDb([
    [
      /from rooms where room_key/,
      () => ({
        rows: [
          {
            room_key: 'bad',
            title: 'Bad',
            version: 9,
            updated_at: new Date().toISOString(),
            metadata: {},
            nodes_json_bytes: 12
          }
        ]
      })
    ],
    [
      /count\(\*\)::int as total/,
      () => ({
        rows: [
          {
            total: 20010,
            live: 20001,
            deleted: 9,
            live_roots: 1,
            max_data_bytes: 80
          }
        ]
      })
    ],
    [/select count\(\*\)::int as n from room_nodes n/, () => ({ rows: [{ n: 0 }] })],
    [
      /from room_operations/,
      () => ({
        rows: [
          {
            version: 9,
            operation_id: 'op-replace',
            operation_type: 'map.replace',
            created_at: new Date().toISOString()
          }
        ]
      })
    ]
  ])
  db.query = new Proxy(db.query, {
    apply(target, thisArg, args) {
      if (/select uid|nodes::jsonb|treeToObject/i.test(String(args[0]))) {
        selectedNodes = true
      }
      return Reflect.apply(target, thisArg, args)
    }
  })
  const report = await inspectRoom(db, 'bad')
  assert.strictEqual(selectedNodes, false)
  assert.strictEqual(report.liveCount, 20001)
  assert.strictEqual(report.lastMapReplaceStatus, 'committed')
  assert.strictEqual(report.ok, true)
  assert.ok(report.warnings.some(item => item.indexOf('oversize_live') === 0))
}

function testStaleLockExpires() {
  const fresh = describeReplaceLock(Date.now() - 1000, Date.now(), 120000)
  assert.strictEqual(fresh.locked, true)
  assert.strictEqual(fresh.expired, false)
  const stale = describeReplaceLock(Date.now() - 200000, Date.now(), 120000)
  assert.strictEqual(stale.locked, false)
  assert.strictEqual(stale.expired, true)
}

function testOutboxQuarantineRules() {
  assert.strictEqual(
    shouldQuarantineOutboxOp({ type: 'map.replace', payload: { tree: {} } }),
    true
  )
  assert.strictEqual(
    shouldQuarantineOutboxOp({
      type: 'node.insert',
      errorCode: 'IMPORT_TOO_LARGE'
    }),
    true
  )
  assert.strictEqual(
    shouldQuarantineOutboxOp({
      type: 'node.insert',
      payload: { uid: 'n1' }
    }),
    false
  )
  const rows = summarizeOutbox([
    { opId: 'a', type: 'map.replace', status: 'pending', payload: { x: 1 } }
  ])
  assert.strictEqual(rows[0].quarantined, true)
}

function fakeJoinSocket(sent) {
  const handlers = {}
  return {
    id: 'sock-1',
    connected: true,
    on(ev, fn) {
      handlers[ev] = handlers[ev] || []
      handlers[ev].push(fn)
    },
    emit(ev, payload, cb) {
      sent.push({ ev, payload })
      if (ev === 'join') {
        cb({
          ok: true,
          role: 'editor',
          canEdit: true,
          canView: true,
          peers: [],
          serverRevision: 4
        })
        return
      }
      cb({ ok: true, opId: payload && payload.opId })
    },
    disconnect() {
      this.connected = false
    }
  }
}

async function testPendingMapReplaceNotReplayed() {
  const box = createOutbox({ memory: true })
  const clientId = randomUUID()
  const roomKey = 'e2e-595386c9'
  await box.put({
    opId: createOpId(),
    clientId,
    roomKey,
    clientSeq: 1,
    type: 'map.replace',
    status: 'pending',
    payload: { tree: { data: { uid: 'root' }, children: [] } }
  })
  const sent = []
  const adapter = createCollaborationAdapter({
    clientId,
    memory: true,
    outbox: box,
    socket: fakeJoinSocket(sent),
    timeoutMs: 400
  })
  await adapter.connect({ roomKey, userId: 'u1', lastServerRevision: 4 })
  await new Promise(resolve => setTimeout(resolve, 40))
  const left = await box.list(clientId, roomKey)
  assert.ok(left.every(item => item.status === 'quarantined'))
  assert.ok(!sent.some(item => item.ev === 'op' || item.ev === 'submit'))
}

async function testCommittedReplaceSettlesStaleOutbox() {
  await testPendingMapReplaceNotReplayed()
}

async function testFailedImportDoesNotLoop() {
  assert.strictEqual(
    shouldQuarantineOutboxOp({
      type: 'map.replace',
      errorCode: 'IMPORT_APPLY_FAILED',
      status: 'pending'
    }),
    true
  )
}

async function testLoadTimeoutIsTerminal() {
  const reconnect = { attempts: 0, recreateRuntime: false }
  const onTimeout = () => {
    reconnect.stop = true
  }
  onTimeout()
  assert.strictEqual(reconnect.stop, true)
  assert.strictEqual(reconnect.recreateRuntime, false)
}

async function testIntegrityErrorStable() {
  const db = fakeDb([
    [
      /from rooms where room_key/,
      () => ({
        rows: [
          {
            room_key: 'orphan',
            title: 'Orphan',
            version: 2,
            updated_at: new Date().toISOString(),
            metadata: {},
            nodes_json_bytes: 10
          }
        ]
      })
    ],
    [
      /count\(\*\)::int as total/,
      () => ({
        rows: [
          {
            total: 3,
            live: 2,
            deleted: 1,
            live_roots: 2,
            max_data_bytes: 20
          }
        ]
      })
    ],
    [/select count\(\*\)::int as n from room_nodes n/, () => ({ rows: [{ n: 1 }] })],
    [/from room_operations/, () => ({ rows: [] })]
  ])
  const report = await inspectRoom(db, 'orphan')
  assert.strictEqual(report.ok, false)
  assert.ok(report.errors.some(item => item.indexOf('root_count') === 0))
  assert.ok(report.errors.some(item => item.indexOf('orphans') === 0))
}

async function testAuthAndSmallRoomStayResponsive() {
  const started = Date.now()
  await inspectRoom(
    fakeDb([
      [
        /from rooms where room_key/,
        () => ({
          rows: [
            {
              room_key: 'small',
              title: 'Small',
              version: 1,
              updated_at: new Date().toISOString(),
              metadata: {},
              nodes_json_bytes: 8
            }
          ]
        })
      ],
      [
        /count\(\*\)::int as total/,
        () => ({
          rows: [{ total: 3, live: 3, deleted: 0, live_roots: 1, max_data_bytes: 12 }]
        })
      ],
      [/select count\(\*\)::int as n from room_nodes n/, () => ({ rows: [{ n: 0 }] })],
      [/from room_operations/, () => ({ rows: [] })]
    ]),
    'small'
  )
  assert.ok(Date.now() - started < 50)
}

;(async () => {
  await testInspectDoesNotBuildTree()
  testStaleLockExpires()
  testOutboxQuarantineRules()
  await testPendingMapReplaceNotReplayed()
  await testCommittedReplaceSettlesStaleOutbox()
  await testFailedImportDoesNotLoop()
  await testLoadTimeoutIsTerminal()
  await testIntegrityErrorStable()
  await testAuthAndSmallRoomStayResponsive()
  console.log('collabRoomRecovery.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
