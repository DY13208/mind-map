const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyDirect } = require('../bin/collabV2/directApplier')
const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
const start = source.indexOf('  flushHttpMove(')
const end = source.indexOf('  flushHttpReparentChildren(', start)
const { flushHttpMove } = vm.runInNewContext('({' + source.slice(start, end) + '})', {
  collabMove: require('../src/utils/collabMove'), v2Trace() {}, console
})
for (const mode of ['single', 'batch', 'legacy']) {
  test('move sends cleared coordinates through ' + mode, async () => {
    const sent = []
    const moves = [{ uid: 'a', parent: 'b', index: 0 }]
    if (mode === 'batch') moves.push({ uid: 'c', parent: 'b', index: 1 })
    await flushHttpMove.call({
      httpPatchNode: (uid, payload) => { sent.push(payload); return Promise.resolve() },
      collabV2Adapter: mode !== 'legacy',
      submitV2: (type, payload) => { sent.push(payload); return Promise.resolve() },
      collectMovesFromCommand: () => moves, cleanupDragArtifacts() {}
    }, 'MOVE_NODE_TO', [])
    const payloads = mode === 'batch' ? sent[0].ops.map(op => op.payload) : sent
    payloads.forEach(payload => {
      const patch = mode === 'legacy' ? payload : payload.patch
      assert.equal(patch.customLeft, null)
      assert.equal(patch.customTop, null)
    })
  })
}
test('server persists cleared coordinates and undo restores prior coordinates and parent', async () => {
  const store = createMemoryStore({
    root: { isRoot: true, data: { uid: 'root' }, children: ['a', 'b'] },
    a: { data: { uid: 'a', customLeft: 100, customTop: 200 }, children: [] },
    b: { data: { uid: 'b' }, children: [] }
  })
  const result = await applyDirect(store, { type: 'node.move', payload: {
    uid: 'a', parent: 'b', index: 0, patch: { customLeft: null, customTop: null }
  } }, { version: 2 })
  const moved = await store.getLive('a')
  assert.equal(moved.parent_uid, 'b')
  assert.ok(moved.data.customLeft == null)
  assert.ok(moved.data.customTop == null)
  await applyDirect(store, result.inversePayload, { version: 3 })
  const restored = await store.getLive('a')
  assert.equal(restored.parent_uid, 'root')
  assert.equal(restored.data.customLeft, 100)
  assert.equal(restored.data.customTop, 200)
})
