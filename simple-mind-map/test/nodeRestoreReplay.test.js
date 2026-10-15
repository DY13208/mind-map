const assert = require('node:assert/strict')
const { test } = require('node:test')
require('../../tests/performance/isolation.cjs').configureIsolatedEnvironment()
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { replayOperations } = require('../bin/collabHistory/replayer')

function graph() {
  return {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['left', 'middle', 'right'] },
    left: { position: '00000000', data: { uid: 'left', text: 'Left' }, children: [] },
    middle: { position: '00000001', data: { uid: 'middle', text: 'Middle', note: 'preserved' }, children: [] },
    right: { position: '00000002', data: { uid: 'right', text: 'Right' }, children: [] }
  }
}

test('Existing history contract: UID-only restore revives stored tombstone and original sibling order', async () => {
  const store = createMemoryStore(graph())
  await applyDirect(store, { type: 'node.delete', payload: { uid: 'middle' } }, { version: 1 })
  const restored = await applyDirect(store, { type: 'node.restore', payload: { uid: 'middle' } }, { version: 2 })
  assert.deepEqual(store.graph.root.children, ['left', 'middle', 'right'])
  assert.equal(store.graph.middle.data.note, 'preserved')
  assert.ok(!store.graph.middle.deleted)
  assert.equal(restored.event.payload.uid, 'middle')
  assert.equal((await store.getLive('middle')).parent_uid, 'root')
})

test('Existing history contract: insert-delete-UID-only restore replays without changing checkpoint input', async () => {
  const initial = { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } }
  const pristine = JSON.stringify(initial)
  const replayed = await replayOperations(initial, {}, [
    { version: 1, operation_type: 'node.insert', payload: { uid: 'restored', parent: 'root', text: 'Original' } },
    { version: 2, operation_type: 'node.delete', payload: { uid: 'restored' } },
    { version: 3, operation_type: 'node.restore', payload: { uid: 'restored' } }
  ], { requireContinuous: true, fromRevision: 0 })
  assert.equal(JSON.stringify(initial), pristine)
  assert.deepEqual(replayed.tree.root.children, ['restored'])
  assert.equal(replayed.tree.restored.data.text, 'Original')
  assert.ok(!replayed.tree.restored.deleted)
})

test('UID-only restore never revives missing or already live UID', async () => {
  const store = createMemoryStore(graph())
  const pristine = JSON.stringify(store.graph)
  await assert.rejects(applyDirect(store, { type: 'node.restore', payload: { uid: 'absent' } }, { version: 1 }), { code: 'NODE_DELETED' })
  await assert.rejects(applyDirect(store, { type: 'node.restore', payload: { uid: 'middle' } }, { version: 1 }), { code: 'NODE_DELETED' })
  assert.equal(JSON.stringify(store.graph), pristine)
})
