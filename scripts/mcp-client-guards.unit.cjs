'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/plugins/Cooperate.js'), 'utf8')
function method(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from)
  return source.slice(from, to).trim()
}
const methods = vm.runInNewContext(`({${[
  method('  guardWritePayload(', '\n  largeMapDelay('),
  method('  observeGuardedIntentEvent(', '\n  interceptGuardedCommand('),
  method('  applyV2PayloadDelete(', '\n  applyV2PayloadRestore('),
  method('  async projectDeferredView(', '\n  async readWriteGuard(')
].join(',')}})`, {
  payloadParentUid: payload => payload.parentUid || payload.parent_uid || payload.parent || '',
  v2Trace() {},
  indexTreeNodesByUid(root) {
    const map = new Map(), visit = node => { map.set(node.data.uid, node); (node.children || []).forEach(visit) }
    visit(root); return map
  }
})
async function main() {
  const context = { ...methods,
    expectedFieldVersions: uid => ({ uid, '__fv.text': 9 }),
    _preparedDeleteGuards: new Map([['n', { uid: 'n', subtree_token: 'server-token' }]]),
    _preparedMoveLocations: new Map([
      ['n', { uid: 'n', parent_uid: 'old', position: 'old-pos' }],
      ['p', { uid: 'p', parent_uid: 'root', position: 'p-pos' }],
      ['a', { uid: 'a', parent_uid: 'p', position: 'anchor-pos' }]
    ]),
    _preparedMoveCommand: { name: 'INSERT_BEFORE', args: [null, { getData: () => 'a' }] }
  }
  const guarded = context.guardWritePayload('node.update', { uid: 'n', patch: { text: 'draft' }, expected: { '__fv.text': 2 } })
  assert.equal(guarded.expected['__fv.text'], 2, 'never rebase an editing baseline at submit')
  const deleted = context.guardWritePayload('node.delete', { uid: 'n', expected: { text: 'old' } })
  assert.equal(deleted.expected.subtree_token, 'server-token')
  const moved = context.guardWritePayload('node.move', { uid: 'n', parentUid: 'p', index: 0 })
  assert.equal(moved.expected.position, 'old-pos'); assert.equal(moved.expected.anchor_side, 'before')
  assert.equal(moved.expected.target_uid, 'p')
  const batch = context.guardWritePayload('node.batch', { ops: [
    { type: 'node.insert', payload: { uid: 'fresh' } },
    { type: 'node.update', payload: { uid: 'fresh', patch: { text: 'second' } } }
  ] })
  assert.equal(batch.ops[1].payload.expected, undefined)
  context._guardIntentWatch = { revision: 4, roots: new Set(['n']), nodes: new Map([
    ['root', { parent: null }], ['n', { parent: 'root' }], ['other', { parent: 'root' }], ['child', { parent: 'n' }]
  ]), conflict: false }
  context.observeGuardedIntentEvent('node.updated', { uid: 'other' }, 5)
  assert.equal(context._guardIntentWatch.conflict, false, 'unrelated room revisions do not reject delete intent')
  context.observeGuardedIntentEvent('node.updated', { uid: 'child' }, 6)
  assert.equal(context._guardIntentWatch.conflict, true, 'descendant mutation invalidates deletion intent')
  context._guardIntentWatch = null
  const child = { data: { uid: 'n', text: 'old', expand: false }, children: [] }
  const root = { data: { uid: 'root' }, children: [child] }
  let renderCount = 0, release
  Object.assign(context, {
    viewDeferred: true, _dragViewDeferred: true, pendingUids: new Set(),
    dirtyUIDSet: new Set(['n']), viewStructureDirtyUIDSet: new Set(['n']),
    httpRoomKey: 'room', collabV2Adapter: {}, lastAppliedVersion: 4,
    currentData: { root: { data: { uid: 'root' }, children: ['n', 'new'] },
      n: { data: { uid: 'n', text: 'remote', expand: true }, children: [] },
      new: { data: { uid: 'new', text: 'added' }, children: [] } },
    mindMap: { renderer: { renderTree: root }, render(done) { renderCount++; done() } },
    _v2RemoteApplyQueue: new Promise(resolve => { release = resolve })
  })
  await context.projectDeferredView()
  assert.equal(renderCount, 0); assert.equal(child.data.text, 'old')
  context._dragViewDeferred = false
  const projected = context.projectDeferredView()
  await Promise.resolve(); assert.equal(renderCount, 0, 'projection waits for prior authoritative applies')
  release(); await projected
  assert.equal(renderCount, 1); assert.equal(child.data.text, 'remote')
  assert.equal(child.data.expand, false, 'personal expansion survives projection')
  assert.equal(root.children.length, 2); assert.equal(context.renderedVersion, 4)
  assert.equal(context.viewDeferred, false); assert.equal(context.dirtyUIDSet.size, 0)
  let deletionRender = null
  Object.assign(context, {
    isGeneralizationUid: () => false, tombstoneDeletedUid() {}, purgeQueuedInserts() {}, removeLocalDeletedUids() {},
    requestRemoteApplyRender(uids) { deletionRender = uids },
    mindMap: { renderer: { findNodeByUid: () => ({ isRoot: false }) }, command: { pause() {}, recovery() {} } },
    collabV2Adapter: {}
  })
  assert.equal(context.applyV2PayloadDelete({ uid: 'n', parentUid: 'root', deletedUids: ['n'] }), true)
  assert.equal(deletionRender[1], 'root', 'delete projection must request its proved parent without throwing')
  console.log('PASS client preconditions, original edit baseline, batch inserts and deferred projection')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
