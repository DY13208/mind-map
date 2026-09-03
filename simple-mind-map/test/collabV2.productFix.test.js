const assert = require('assert')
const { randomUUID } = require('crypto')
const { applyCollabEvent } = require('../bin/collabRecovery')
const { createEngine } = require('../bin/collabV2/engine')

function seed() {
  return {
    root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: ['n1'] },
    n1: {
      isRoot: false,
      data: { uid: 'n1', text: 'Alpha' },
      children: []
    }
  }
}

;(async () => {
  let nodes = seed()
  nodes = applyCollabEvent(nodes, {
    type: 'node.inserted',
    payload: { uid: 'p1', parentUid: 'n1', text: 'Pasted', data: { uid: 'p1', text: 'Pasted' } }
  })
  assert.ok(nodes.p1, 'paste insert writes currentData')
  assert.ok(nodes.n1.children.includes('p1'), 'paste insert attaches to parent')

  nodes = applyCollabEvent(nodes, {
    type: 'node.moved',
    payload: { uid: 'p1', parentUid: 'root', index: 1 }
  })
  assert.ok(!nodes.n1.children.includes('p1'), 'move removes from old parent')
  assert.ok(nodes.root.children.includes('p1'), 'move attaches to new parent')

  const engine = createEngine()
  const roomKey = 'product-fix'
  engine.getRoom(roomKey)
  const access = { userId: 'u1', role: 'editor', canEdit: true }
  await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'product-fix-client',
      type: 'node.insert',
      payload: { uid: 'n1', parent: 'root', text: 'Alpha' }
    },
    access
  )
  const add = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'product-fix-client',
      type: 'node.update',
      payload: {
        uid: 'n1',
        generalization: [{ uid: 'g1', text: '概要', range: [0, 0] }]
      }
    },
    access
  )
  assert.strictEqual(add.operation.event.type, 'node.updated')
  assert.strictEqual(add.operation.inversePayload.type, 'node.update')

  const remove = await engine.submit(
    {
      roomKey,
      opId: randomUUID(),
      clientId: 'product-fix-client',
      type: 'node.update',
      payload: { uid: 'n1', generalization: null }
    },
    access
  )
  assert.strictEqual(remove.operation.inversePayload.type, 'node.update')
  const inverse = remove.operation.inversePayload.payload || {}
  const patch = inverse.patch || inverse
  const gen = patch.generalization
  assert.ok(Array.isArray(gen) && gen[0] && gen[0].uid === 'g1', 'delete 概要 inverse restores same uid')
  assert.notStrictEqual(remove.operation.inversePayload.type, 'node.insert')
  assert.notStrictEqual(remove.operation.inversePayload.type, 'node.restore')

  console.log('collabV2.productFix.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
