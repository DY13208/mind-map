'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm')
const src = fs.readFileSync('simple-mind-map/src/plugins/Cooperate.js', 'utf8').replace(/\r\n/g, '\n')
const start = src.indexOf('  applyV2PayloadRestore(payload = {}) {'), end = src.indexOf('\n  postRestoreDecorations(', start)
const sandbox = { payloadParentUid: p => p.parentUid, v2Trace() {},
  collabDelete: { buildSubtreeFromRows: (rows, uid) => ({ data: { uid }, children: [] }) } }
const m = vm.runInNewContext('({' + src.slice(start, end) + '})', sandbox)
function run(parentRaw) {
  const calls = { dirty: [], badge: 0, render: 0 }
  const parent = { nodeData: parentRaw, getData: k => parentRaw.data[k], updateExpandBtnNode() { calls.badge++ } }
  const ctx = Object.assign(Object.create(m), {
    reviveDeletedUid() {}, postRestoreDecorations() {}, markRemoteDirty: (u, p) => calls.dirty.push(u, p),
    requestRemoteApplyRender() { calls.render++ },
    mindMap: { command: { pause() {}, recovery() {} }, renderer: {
      findNodeByUid: uid => (uid === 'P' ? parent : null),
      setNodeData: (n, d) => Object.assign(n.nodeData.data, d) } } })
  assert.equal(ctx.applyV2PayloadRestore({ uid: 'X', parentUid: 'P', rows: [{ uid: 'X' }] }), true)
  return calls
}
// collapsed + unloaded (remote-pasted copy on receiver): stay collapsed, no partial insert
const lazy = { data: { uid: 'P', expand: false, childCount: 4, descendantCount: 12 }, children: [] }
let c = run(lazy)
assert.equal(lazy.data.expand, false); assert.equal(lazy.children.length, 0)
assert.equal(c.badge, 1); assert.equal(c.render, 0); assert.deepEqual([...c.dirty], ['X', 'P'])
// personally collapsed but loaded: insert data, keep collapsed
const loaded = { data: { uid: 'P', expand: false }, children: [{ data: { uid: 'Y' }, children: [] }] }
run(loaded)
assert.equal(loaded.data.expand, false); assert.equal(loaded.children.length, 2)
// expanded parent: unchanged behaviour
const open = { data: { uid: 'P', expand: true }, children: [] }
run(open); assert.equal(open.data.expand, true); assert.equal(open.children.length, 1)
console.log('PASS remote restore keeps collapsed parents collapsed; expanded parents unchanged')
