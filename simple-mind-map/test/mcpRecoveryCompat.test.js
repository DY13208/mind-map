const assert = require('assert')
const Y = require('yjs')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const mindDoc = require('../bin/mindDoc')
const { applyNodeCommand } = require('../bin/roomCommands')
const { planAfterOperations } = require('../bin/collabRecovery')

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

async function main() {
  const cases = [
    ['DirectApplier restores legacy nodes snapshots', testDirectRestoreReadsLegacyNodesSnapshot],
    ['roomCommands restores Direct rows snapshots', testRoomCommandsReadsDirectRowsSnapshot],
    ['Socket sequencer reports archived version gaps', testSequencerRequiresSnapshotWhenArchiveLeavesGap],
    ['client recovery rejects small version gaps', testRecoveryPlannerDoesNotApplyAcrossSmallVersionGap]
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
