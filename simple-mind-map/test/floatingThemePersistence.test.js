const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createEngine } = require('../bin/collabV2/engine')
const { movePositionPatch } = require('../src/utils/collabMove')

test('independent themes persist in one move and undo restores their original parent', async () => {
  const engine = createEngine()
  const roomKey = 'floating-theme'
  const access = { userId: 'A', role: 'editor', canEdit: true }
  const submit = (type, payload) => engine.submit({ roomKey, opId: randomUUID(),
    clientId: 'floating-test', type, payload }, access)
  await submit('node.insert', { uid: 'parent', parent: 'root', text: 'Parent' })
  await submit('node.insert', { uid: 'theme', parent: 'parent', text: 'Theme' })
  await submit('node.insert', { uid: 'leaf', parent: 'theme', text: 'Leaf' })
  const data = { isFloating: true, customLeft: 420, customTop: 600 }
  const moved = await submit('node.move', { uid: 'theme', parent: 'root', index: 1,
    patch: movePositionPatch({ getData: key => data[key] }) })
  const store = engine.getRoom(roomKey).store
  const row = await store.getLive('theme')
  assert.equal(row.parent_uid, 'root')
  assert.equal(row.data.isFloating, true)
  assert.equal(row.data.customLeft, 420)
  assert.equal((await store.getLive('leaf')).parent_uid, 'theme')
  await submit('operation.undo', { targetOperationId: moved.operation.opId })
  const restored = await store.getLive('theme')
  assert.equal(restored.parent_uid, 'parent')
  assert.ok(!restored.data.isFloating)
  assert.equal(restored.data.customLeft, undefined)
  assert.equal((await store.getLive('leaf')).parent_uid, 'theme')
})
