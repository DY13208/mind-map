const assert = require('assert')
const Y = require('yjs')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const mindDoc = require('../bin/mindDoc')
const { applyNodeCommand } = require('../bin/roomCommands')
const { planAfterOperations } = require('../bin/collabRecovery')
const { applyRestore: applyRestoreToHistoryTree } = require('../bin/collabUndo')

const node = (uid, text, children = [], extra = {}) => ({
  isRoot: uid === 'root',
  data: { uid, text, ...extra },
  children,
  position: extra.position || ''
})

function seedDoc(nodes) {
  const doc = new Y.Doc()
  mindDoc.applyObjectToDoc(doc, nodes, { replace: true })
  return doc
}

async function testDirectRestoreReadsLegacyNodesSnapshot() {
  const initial = {
    root: node('root', 'Root', ['parent']),
    parent: node('parent', 'Parent', ['child']),
    child: node('child', 'Child')
  }
  const store = createMemoryStore(initial)
  const legacySnapshot = {
    parent: JSON.parse(JSON.stringify(initial.parent)),
    child: JSON.parse(JSON.stringify(initial.child))
  }

  await applyDirect(
    store,
    { type: 'node.delete', payload: { uid: 'parent' } },
    { version: 1 }
  )
  await applyDirect(
    store,
    {
      type: 'node.restore',
      payload: {
        uid: 'parent',
        parentUid: 'root',
        index: 0,
        nodes: legacySnapshot
      }
    },
    { version: 2 }
  )

  assert.deepStrictEqual(store.graph.root.children, ['parent'])
  assert.deepStrictEqual(store.graph.parent.children, ['child'])
  assert.strictEqual(store.graph.child.data.text, 'Child')
}

function testRoomCommandsReadsDirectRowsSnapshot() {
  const doc = seedDoc({ root: node('root', 'Root') })
  const applied = applyNodeCommand(doc, {
    type: 'node.restore',
    payload: {
      uid: 'parent',
      parentUid: 'root',
      index: 0,
      rows: [
        {
          uid: 'parent',
          parent_uid: 'root',
          position: 'a0',
          data: { uid: 'parent', text: 'Parent' },
          is_root: false
        },
        {
          uid: 'child',
          parent_uid: 'parent',
          position: 'a0',
          data: { uid: 'child', text: 'Child' },
          is_root: false
        }
      ]
    }
  })
  const restored = mindDoc.readObject(doc)

  assert.deepStrictEqual(applied.result.restored.sort(), ['child', 'parent'])
  assert.deepStrictEqual(restored.root.children, ['parent'])
  assert.deepStrictEqual(restored.parent.children, ['child'])
  assert.strictEqual(restored.child.data.text, 'Child')
}

function testHistoryRestoreAcceptsBothInverseFormatsAndOrder() {
  const base = {
    root: node('root', 'Root', ['sibling']),
    sibling: node('sibling', 'Sibling', [], 'a0')
  }
  const legacy = applyRestoreToHistoryTree(base, {
    uid: 'parent',
    parentUid: 'root',
    index: 1,
    position: 'b0',
    nodes: {
      parent: node('parent', 'Parent', ['child-b', 'child-a']),
      'child-a': node('child-a', 'Child A', [], 'a0'),
      'child-b': node('child-b', 'Child B', [], 'a1')
    }
  })
  assert.deepStrictEqual(legacy.root.children, ['sibling', 'parent'])
  assert.deepStrictEqual(legacy.parent.children, ['child-b', 'child-a'])

  const directRows = applyRestoreToHistoryTree(base, {
    uid: 'parent',
    parentUid: 'root',
    index: 1,
    position: 'b0',
    rows: [
      { uid: 'child-b', parent_uid: 'parent', position: 'b0', data: { uid: 'child-b', text: 'Child B' } },
      { uid: 'parent', parent_uid: 'root', position: 'b0', data: { uid: 'parent', text: 'Parent' } },
      { uid: 'child-a', parent_uid: 'parent', position: 'a0', data: { uid: 'child-a', text: 'Child A' } }
    ]
  })
  assert.deepStrictEqual(directRows.root.children, ['sibling', 'parent'])
  assert.deepStrictEqual(directRows.parent.children, ['child-a', 'child-b'])
  assert.strictEqual(directRows.parent.position, 'b0')
}

async function testSequencerRequiresSnapshotWhenArchiveLeavesGap() {
  const storagePath = require.resolve('../bin/storage')
  const roomAclPath = require.resolve('../bin/roomAcl')
  const sequencerPath = require.resolve('../bin/collabV2/sequencer')
  const oldStorage = require.cache[storagePath]
  const oldRoomAcl = require.cache[roomAclPath]
  const oldSequencer = require.cache[sequencerPath]
  const currentVersion = 901
  const missingVersion = 900
  const fakeStorage = {
    commitRoomOperation: async () => {},
    commitDirectRoomOperation: async () => {},
    getPool: () => ({}),
    getRoomVersion: async () => currentVersion,
    listRoomOperations: async () => [
      {
        room_key: 'room',
        version: currentVersion,
        operation_id: 'op-901',
        operation_type: 'node.update',
        payload: { uid: 'n1', text: 'later' },
        event: { type: 'node.updated', payload: { uid: 'n1' } },
        inverse_payload: null
      }
    ],
    listRoomOperationsContiguous: async () => ({
      ok: false,
      reload: true,
      code: 'RESNAPSHOT_REQUIRED',
      roomKey: 'room',
      afterVersion: missingVersion - 1,
      currentVersion,
      currentRevision: currentVersion,
      completeFromRevision: currentVersion,
      serverRevision: currentVersion,
      missingVersion,
      reason: 'VERSION_GAP'
    }),
    safeRoomKey: value => value
  }
  const stubModule = (id, exports) => ({
    id,
    filename: id,
    loaded: true,
    exports
  })

  try {
    require.cache[storagePath] = stubModule(storagePath, fakeStorage)
    require.cache[roomAclPath] = stubModule(roomAclPath, {
      assertRoomAccess: async () => ({ canView: true })
    })
    delete require.cache[sequencerPath]
    const { listOperations } = require('../bin/collabV2/sequencer')
    const result = await listOperations({}, 'room', missingVersion - 1, 500)

    assert.strictEqual(result.reload, true)
    assert.strictEqual(result.code, 'RESNAPSHOT_REQUIRED')
    assert.deepStrictEqual(result.operations, [])
    assert.strictEqual(result.currentRevision, currentVersion)
    assert.strictEqual(result.completeFromRevision, currentVersion)
    assert.strictEqual(result.serverRevision, currentVersion)
    assert.strictEqual(result.missingVersion, missingVersion)
  } finally {
    if (oldStorage) require.cache[storagePath] = oldStorage
    else delete require.cache[storagePath]
    if (oldRoomAcl) require.cache[roomAclPath] = oldRoomAcl
    else delete require.cache[roomAclPath]
    if (oldSequencer) require.cache[sequencerPath] = oldSequencer
    else delete require.cache[sequencerPath]
  }
}

async function testSequencerPinsHeadForContiguousPages() {
  const storagePath = require.resolve('../bin/storage')
  const roomAclPath = require.resolve('../bin/roomAcl')
  const sequencerPath = require.resolve('../bin/collabV2/sequencer')
  const oldStorage = require.cache[storagePath]
  const oldRoomAcl = require.cache[roomAclPath]
  const oldSequencer = require.cache[sequencerPath]
  let receivedOptions
  const fakeStorage = {
    commitRoomOperation: async () => {},
    commitDirectRoomOperation: async () => {},
    getPool: () => ({}),
    getRoomVersion: async () => 99,
    listRoomOperationsContiguous: async (_roomKey, _after, options) => {
      receivedOptions = options
      return {
        ok: true,
        reload: false,
        currentRevision: 7,
        completeFromRevision: 3,
        toVersion: 5,
        hasMore: true,
        operations: [
          { room_key: 'room', version: 4, operation_id: 'op-4', operation_type: 'node.update', event: {} },
          { room_key: 'room', version: 5, operation_id: 'op-5', operation_type: 'node.update', event: {} }
        ]
      }
    },
    safeRoomKey: value => value
  }
  const stubModule = (id, exports) => ({ id, filename: id, loaded: true, exports })

  try {
    require.cache[storagePath] = stubModule(storagePath, fakeStorage)
    require.cache[roomAclPath] = stubModule(roomAclPath, {
      assertRoomAccess: async () => ({ canView: true })
    })
    delete require.cache[sequencerPath]
    const { listOperations } = require('../bin/collabV2/sequencer')
    const result = await listOperations({}, 'room', 3, 2, { headVersion: 7 })

    assert.deepStrictEqual(receivedOptions, { headVersion: 7, limit: 2 })
    assert.strictEqual(result.currentRevision, 7)
    assert.strictEqual(result.serverRevision, 7)
    assert.strictEqual(result.toVersion, 5)
    assert.strictEqual(result.hasMore, true)
    assert.deepStrictEqual(result.operations.map(op => op.serverRevision), [4, 5])
  } finally {
    if (oldStorage) require.cache[storagePath] = oldStorage
    else delete require.cache[storagePath]
    if (oldRoomAcl) require.cache[roomAclPath] = oldRoomAcl
    else delete require.cache[roomAclPath]
    if (oldSequencer) require.cache[sequencerPath] = oldSequencer
    else delete require.cache[sequencerPath]
  }
}

function testRecoveryPlannerDoesNotApplyAcrossSmallVersionGap() {
  const plan = planAfterOperations(899, {
    currentVersion: 901,
    hasMore: false,
    operations: [
      {
        version: 901,
        event: {
          type: 'node.updated',
          payload: { uid: 'n1', patch: { text: 'later' } }
        }
      }
    ]
  })

  assert.strictEqual(plan.type, 'resnapshot')
  assert.strictEqual(plan.version, 901)
}

function testRecoveryPlannerRequiresFullContiguousPage() {
  const gap = planAfterOperations(899, {
    currentRevision: 901,
    completeFromRevision: 899,
    hasMore: false,
    operations: [
      { version: 900, event: { type: 'node.updated', payload: { uid: 'n1' } } },
      { version: 901, event: { type: 'node.updated', payload: { uid: 'n2' } } }
    ]
  })
  assert.strictEqual(gap.type, 'apply')
  assert.strictEqual(gap.version, 901)

  const reload = planAfterOperations(899, {
    reload: true,
    code: 'RESNAPSHOT_REQUIRED',
    currentRevision: 901,
    completeFromRevision: 901,
    operations: []
  })
  assert.strictEqual(reload.type, 'resnapshot')
  assert.strictEqual(reload.version, 901)
  assert.strictEqual(reload.reason, 'AUTHORITATIVE_SNAPSHOT_RECOVERY')
}

async function main() {
  const cases = [
    ['DirectApplier restores legacy nodes snapshots', testDirectRestoreReadsLegacyNodesSnapshot],
    ['roomCommands restores Direct rows snapshots', testRoomCommandsReadsDirectRowsSnapshot],
    ['history reconstruction restores both formats and sibling order', testHistoryRestoreAcceptsBothInverseFormatsAndOrder],
    ['Socket sequencer reports archived version gaps', testSequencerRequiresSnapshotWhenArchiveLeavesGap],
    ['Socket sequencer pins the operation head while paging', testSequencerPinsHeadForContiguousPages],
    ['client recovery rejects small version gaps', testRecoveryPlannerDoesNotApplyAcrossSmallVersionGap],
    ['client recovery accepts only complete contiguous pages', testRecoveryPlannerRequiresFullContiguousPage]
  ]
  const failures = []
  for (const [name, run] of cases) {
    try {
      await run()
      console.log(`PASS ${name}`)
    } catch (err) {
      failures.push({ name, err })
      console.error(`FAIL ${name}: ${err.message}`)
    }
  }
  if (failures.length) {
    process.exitCode = 1
    console.error(`${failures.length} recovery compatibility case(s) failed`)
  } else {
    console.log('MCP recovery compatibility tests ok')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
