const assert = require('assert')
const { replayOperations } = require('../bin/collabHistory/replayer')

async function main() {
  const base = { root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] } }
  // Events are grouped by parent, not in request order. Two identical labels
  // must retain their committed identities across checkpoints and later edits.
  const batch = {
    version: 1, operation_type: 'node.batch', operation_id: 'batch',
    payload: { ops: [
      { type: 'node.insert', payload: { parentUid: 'root', text: 'same' } },
      { type: 'node.insert', payload: { parentUid: 'a', text: 'child' } },
      { type: 'node.insert', payload: { parentUid: 'root', text: 'same' } }
    ] },
    event: { type: 'batch.applied', payload: { events: [
      { type: 'node.inserted', payload: { uid: 'a', parentUid: 'root', text: 'same' } },
      { type: 'node.inserted', payload: { uid: 'b', parentUid: 'root', text: 'same' } },
      { type: 'node.inserted', payload: { uid: 'child', parentUid: 'a', text: 'child' } }
    ] } }
  }
  const deletion = { version: 2, operation_type: 'node.delete', payload: { uid: 'b' } }
  const before = JSON.stringify(batch)
  const first = await replayOperations(base, {}, [batch])
  assert(first.tree.a && first.tree.b && first.tree.child)
  assert(first.tree.a.children.includes('child'))
  const replayed = await replayOperations(base, {}, [batch, deletion])
  assert(replayed.tree.a && replayed.tree.child)
  assert(!replayed.tree.b)
  const fromCheckpoint = await replayOperations(first.tree, {}, [deletion])
  assert.deepStrictEqual(replayed.tree, fromCheckpoint.tree)
  assert.deepStrictEqual((await replayOperations(base, {}, [batch, deletion])).tree, replayed.tree)
  assert.strictEqual(JSON.stringify(batch), before)
  const single = { version: 1, operation_type: 'node.insert', payload: { parentUid: 'root' },
    event: { type: 'node.inserted', payload: { uid: 'generated' } } }
  assert((await replayOperations(base, {}, [single])).tree.generated)
  await assert.rejects(replayOperations(base, {}, [{ ...single, event: null }]),
    error => error.code === 'HISTORY_REPLAY_FAILED')
  await assert.rejects(replayOperations(base, {}, [{ ...batch, event: null }]),
    error => error.code === 'HISTORY_REPLAY_FAILED')
  console.log('history generated identity regression passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
