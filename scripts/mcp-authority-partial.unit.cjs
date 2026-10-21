'use strict'
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
async function main() {
  const { applyCollabEvent } = await import(pathToFileURL(path.resolve(__dirname, '../simple-mind-map/src/plugins/cooperateRecovery.js')))
  const initial = { root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: [] } }
  const event = { type: 'node.updated', payload: { uid: 'unloaded', patch: { note: 'authoritative note', __fv: { note: 3 } } } }
  assert.throws(() => applyCollabEvent(initial, event), /node not found/, 'immutable recovery keeps its missing-node contract')
  let nodes = applyCollabEvent(initial, event, { liveFieldUpdate: true, allowPartial: true })
  assert.equal(nodes.unloaded.partial, true); assert.equal(nodes.unloaded.data.note, 'authoritative note')
  assert.deepEqual(nodes.root.children, [], 'partial nodes are not fabricated into the visible tree')
  nodes = applyCollabEvent(nodes, { type: 'node.updated', payload: { uid: 'unloaded', patch: { text: 'second field', __fv: { note: 3, text: 1 } } } }, { liveFieldUpdate: true, allowPartial: true })
  assert.equal(nodes.unloaded.data.note, 'authoritative note'); assert.equal(nodes.unloaded.data.text, 'second field')
  nodes = applyCollabEvent(nodes, { type: 'node.inserted', payload: { uid: 'new', parentUid: 'hidden-parent', text: 'full canonical insert' } }, { allowPartial: true })
  assert.equal(nodes['hidden-parent'].partial, true); assert.equal(nodes.new.data.text, 'full canonical insert')
  assert.deepEqual(nodes['hidden-parent'].children, ['new'])
  assert.throws(() => applyCollabEvent(nodes, { type: 'node.updated', payload: { patch: { text: 'malformed' } } }, { allowPartial: true }), /node not found/)
  console.log('PASS partial authoritative patches survive lazy loading without relaxing malformed-event failures')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
