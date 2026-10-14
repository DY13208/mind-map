const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { beginHydration, invalidateHydration, invalidateHydrationSession } = require('../src/utils/hydrationLifecycle')
const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
const from = source.indexOf('  async hydrateFromHttp(')
const to = source.indexOf('\n  findTreeNode(', from)
const methods = vm.runInNewContext(`({${source.slice(from, to).replace('\n  async hydrateNodeData(', ',\n  async hydrateNodeData(')}})`, {
  console, Promise, Date, Map, Set, Number, Array, Error,
  beginHydration,
  clearHydratedSelection: value => value
})
const deletionStart = source.indexOf('  tombstoneDeletedUid(')
const deletionEnd = source.indexOf('\n  isRecentlyHttpDeleted(', deletionStart)
const deletionMethods = vm.runInNewContext(`({${source.slice(deletionStart, deletionEnd).replace('\n  reviveDeletedUid(', ',\n  reviveDeletedUid(')}})`, {
  invalidateHydration, Set, Map, Date
})
function fixture() {
  let calls = 0
  const data = { data: { uid: 'parent', childCount: 2 }, children: [] }
  const node = { nodeData: data, getData: key => data.data[key] }
  const context = {
    ...methods, ...deletionMethods,
    deletedUids: new Set(), abandonedInsertUids: new Set(), recentHttpDeleted: new Map(),
    dirtySubtrees: new Map(), hydratedUids: new Set(), hydrateFailedUids: new Set(), hydrateInflight: new Map(),
    isTombstonedUid(uid) { return this.deletedUids.has(uid) },
    forgetHttpUid(uid) { this.hydratedUids.delete(uid) }, markUidPushed() {}, flushPendingHttpRefresh() {},
    mergeHttpChildren(target, children) { target.children.push(...children) },
    httpFetchSubtree: async () => { calls++; return { total: 2, children: [{ data: { uid: 'child' } }], version: 2 } }
  }
  return { data, node, context,
    remove() { context.tombstoneDeletedUid('parent') },
    restore() { context.reviveDeletedUid('parent') }, get calls() { return calls } }
}
async function main() {
  const wide = fixture()
  const offsets = []
  wide.context.httpFetchSubtree = async (uid, options) => {
    offsets.push(options.offset || 0)
    const offset = options.offset || 0
    const size = offset ? 50 : 200
    return { total: 250, version: 5, offset, has_more: !offset,
      children: Array.from({ length: size }, (_, i) => ({ data: { uid: `child-${offset + i}` } })) }
  }
  await wide.context.hydrateNodeData(wide.data)
  await wide.context.hydrateNodeData(wide.data)
  assert.deepEqual(offsets, [0, 200])
  assert.equal(wide.data.children.length, 250)
  assert.equal(wide.data.data.hasMore, false)
  assert.equal(wide.context.hydratedUids.has('parent'), true)
  const leaf = fixture()
  let leafCalls = 0
  leaf.context.httpFetchSubtree = async () => { leafCalls++; return { total: 0, children: [], version: 5 } }
  for (let i = 0; i < 5; i++) await leaf.context.hydrateNodeData(leaf.data)
  assert.equal(leafCalls, 1)
  leaf.context.dirtySubtrees.set('parent', 6)
  await leaf.context.hydrateNodeData(leaf.data)
  assert.equal(leafCalls, 2)
  const changed = fixture()
  changed.context.dirtySubtrees.set('parent', 5)
  changed.context.httpFetchSubtree = async (uid, options) => ({ total: 250,
    version: options.offset ? 6 : 5, has_more: !options.offset,
    children: [{ data: { uid: 'mixed-version' } }] })
  await assert.rejects(changed.context.hydrateNodeData(changed.data), err => err.code === 'SUBTREE_PAGE_INCOMPLETE')
  assert.equal(changed.data.children.length, 0)
  assert.equal(changed.context.dirtySubtrees.get('parent'), 5)
  assert.equal(changed.context.hydratedUids.size, 0)
  for (const mode of ['rendered', 'raw']) {
    const read = f => mode === 'rendered' ? f.context.hydrateFromHttp(f.node) : f.context.hydrateNodeData(f.data)
    const deleted = fixture()
    deleted.remove()
    await read(deleted)
    assert.equal(deleted.calls, 0, `${mode}: deleted nodes must not produce an HTTP 404`)
    deleted.restore()
    await read(deleted)
    assert.equal(deleted.calls, 1, `${mode}: restoring a node permits fresh hydration`)
    const race = fixture()
    let finish
    race.context.httpFetchSubtree = () => new Promise(resolve => { finish = resolve })
    const pending = read(race)
    race.remove()
    finish({ total: 2, children: [{ data: { uid: 'stale-child' } }], version: 2, has_more: true })
    await pending
    assert.equal(race.data.children.length, 0, `${mode}: stale response must not resurrect a deleted subtree`)
    assert.equal(race.context.hydratedUids.size, 0)
    const aba = fixture()
    let oldResponse
    aba.context.httpFetchSubtree = () => new Promise(resolve => { oldResponse = resolve })
    const oldRead = read(aba)
    aba.remove()
    aba.restore()
    const newResponse = { total: 0, children: [], version: 4 }
    aba.context.httpFetchSubtree = () => newResponse
    await read(aba)
    oldResponse({ total: 2, children: [{ data: { uid: 'before-delete' } }], version: 2 })
    await oldRead
    assert.equal(aba.data.children.length, 0, `${mode}: delete/restore must not revive a stale read`)
    assert.equal(aba.data.data.subtreeVersion, 4, `${mode}: old completion must not overwrite restored version`)
    const roomSwitch = fixture()
    let finishRoom
    roomSwitch.context.httpRoomKey = 'room-a'
    roomSwitch.context.httpFetchSubtree = () => new Promise(resolve => { finishRoom = resolve })
    const beforeSwitch = read(roomSwitch)
    roomSwitch.context.httpRoomKey = 'room-b'
    finishRoom({ total: 1, children: [{ data: { uid: 'old-room' } }], version: 9 })
    await beforeSwitch
    assert.equal(roomSwitch.data.children.length, 0, `${mode}: old-room response must be discarded`)
    const roomAba = fixture()
    let finishAba
    roomAba.context.httpRoomKey = 'room-a'
    roomAba.context.httpFetchSubtree = () => new Promise(resolve => { finishAba = resolve })
    const beforeAba = read(roomAba)
    invalidateHydrationSession(roomAba.context)
    roomAba.context.httpRoomKey = 'room-b'
    invalidateHydrationSession(roomAba.context)
    roomAba.context.httpRoomKey = 'room-a'
    roomAba.context.dirtySubtrees.set('parent', 99)
    finishAba({ total: 0, children: [], version: 9 })
    await beforeAba
    assert.equal(roomAba.context.dirtySubtrees.get('parent'), 99, `${mode}: A-B-A must preserve new-session dirty state`)
    assert.equal(roomAba.context.hydratedUids.size, 0)
    const missing = fixture()
    missing.context.httpFetchSubtree = async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }) }
    await assert.rejects(read(missing), error => error.statusCode === 404, 'a genuine missing-node error stays visible')
  }
  const owner = { httpRoomKey: 'a' }
  const old = beginHydration(owner, 'n')
  invalidateHydrationSession(owner)
  const fresh = beginHydration(owner, 'n')
  old.release()
  invalidateHydration(owner, 'n')
  assert.equal(fresh.isCurrent(), false, 'old completion must not remove fresh session tracking')
  fresh.release()
  console.log('hydration: paging, empty leaf, mixed revisions, session ABA, deletion and restore passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
