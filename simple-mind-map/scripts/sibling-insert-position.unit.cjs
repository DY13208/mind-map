const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const collect = require('../src/utils/collabInsertCollect')
const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { applyCollabEvents, applyCollabEvent: applyServerCollabEvent } = require('../bin/collabRecovery')
const { generateNKeysBetween } = require('../bin/fractionalIndex')
const renderSource = fs.readFileSync(path.join(__dirname, '../src/core/render/Render.js'), 'utf8')
const utilsSource = fs.readFileSync(path.join(__dirname, '../src/utils/index.js'), 'utf8')
const helper = name => {
  const start = utilsSource.indexOf(`export const ${name} =`)
  return utilsSource.slice(start, utilsSource.indexOf('\n}', start) + 2).replace('export ', '')
}
let uid = 0
const sandbox = {
  createUid: () => `new-${++uid}`,
  addDataToAppointNodes: children => children,
  createUidForAppointNodes: children => children,
  simpleDeepClone: data => JSON.parse(JSON.stringify(data)),
  formatDataToArray: data => !data ? [] : Array.isArray(data) ? data : [data]
}
vm.createContext(sandbox)
vm.runInContext(helper('getNodeUid') + '\n' + helper('getNodeDataIndex'), sandbox)
function method(name, next) {
  const start = renderSource.indexOf(`  ${name}(`)
  return vm.runInContext('({' + renderSource.slice(start, renderSource.indexOf(`\n  ${next}(`, start)) + '\n})', sandbox)[name]
}
const insertChildNodeData = method('insertChildNodeData', 'insertNode')
const insertNode = method('insertNode', 'insertMultiNode')
const insertChildNode = method('insertChildNode', 'insertMultiChildNode')
const runAfterHydrate = method('runAfterHydrate', 'insertChildNodeData')
function node(id, children = []) {
  const value = { uid: id, nodeData: { data: { uid: id, text: id }, children: children.map(child => child.nodeData) }, children }
  value.getData = key => key ? value.nodeData.data[key] : value.nodeData.data
  value.setData = patch => Object.assign(value.nodeData.data, patch)
  children.forEach(child => { child.parent = value; child.layerIndex = 2 })
  return value
}
function fixture() {
  const children = ['first', 'selected', 'last'].map(id => node(id))
  const parent = node('parent', children)
  const live = new Map(children.concat(parent).map(child => [child.uid, child]))
  const r = {
    activeNodeList: [children[1]], insertNode, insertChildNodeData,
    findNodeByUid: id => live.get(id), runAfterHydrate: () => false,
    textEdit: { hideEditTextBox() {} }, hasRichTextPlugin: () => false,
    getNewNodeBehavior: () => ({ focusNewNode: false, inserting: true }),
    clearActiveNodeList() { this.activeNodeList = [] },
    mindMap: {
      opt: { defaultInsertSecondLevelNodeText: 'Branch', defaultInsertBelowSecondLevelNodeText: 'Node' },
      render() {}, command: { recordContentChange() {}, isCountableNode: () => true }
    }
  }
  return { r, parent, children, live }
}
function order(parent) { return Array.from(parent.nodeData.children, item => item.data.uid) }

test('Enter inserts directly after the first, middle, or last selected sibling and preserves the index through server application and event replay', async () => {
  for (let index = 0; index < 3; index++) {
    const { r, parent, children } = fixture()
    const knownUids = collect.snapshotNodeDataUids([parent.nodeData])
    const initial = {
      parent: { isRoot: true, data: { uid: 'parent' }, children: children.map(child => child.uid) }
    }
    const positions = generateNKeysBetween(null, null, children.length)
    children.forEach((child, i) => { initial[child.uid] = { data: { uid: child.uid }, position: positions[i], children: [] } })
    r.activeNodeList = [children[index]]
    r.insertNode()
    const rows = collect.collectNewNodeDataInserts([parent.nodeData], { knownUids })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].index, index + 1)
    assert.equal(order(parent)[index + 1], rows[0].uid)
    const store = createMemoryStore(initial)
    const applied = await applyDirect(store, { type: 'node.insert', payload: rows[0] }, { version: 1 })
    assert.deepEqual(store.graph.parent.children, order(parent))
    const replayed = applyCollabEvents(initial, [{ event: applied.event }])
    assert.equal(replayed.type, 'apply')
    assert.deepEqual(replayed.nodes.parent.children, order(parent))
  }
})

test('a reused selected instance with an old parent resolves to its current sibling position', () => {
  const { r, parent, children } = fixture()
  const stale = node('selected')
  node('old-parent', [stale])
  // A render may have reset or replaced the old parent children before Enter.
  stale.parent.nodeData.children = []
  r.activeNodeList = [stale]
  r.insertNode()
  assert.equal(parent.nodeData.children.length, 4)
  assert.equal(order(parent)[1], children[1].uid)
  assert.match(order(parent)[2], /^new-/)
  assert.equal(stale.parent.nodeData.children.length, 0)
})

test('missing anchors never turn index -1 into an insertion at the top', () => {
  const { r, parent } = fixture()
  parent.nodeData.children.splice(1, 1)
  r.insertNode()
  assert.deepEqual(order(parent), ['first', 'last'])
})

test('a deleted selection cannot insert into a detached parent', () => {
  const { r, parent, live } = fixture()
  live.delete('selected')
  r.insertNode()
  assert.deepEqual(order(parent), ['first', 'selected', 'last'])
})

test('hydration keeps the original anchor if the user selects a different node while waiting', () => {
  const { r, parent, children } = fixture()
  let finish
  r.runAfterHydrate = (parents, after) => {
    r.runAfterHydrate = () => false
    finish = after
    return true
  }
  r.insertNode()
  r.activeNodeList = [children[0]]
  finish()
  assert.equal(order(parent)[1], 'selected')
  assert.match(order(parent)[2], /^new-/)
})

test('placement hydration can replace node instances before inserting below the current anchor', async () => {
  const { r, parent, children, live } = fixture()
  let ready
  let completed
  const done = new Promise(resolve => { completed = resolve })
  r.runAfterHydrate = runAfterHydrate
  r.mindMap.cooperate = {
    httpCollabMode: true, nodeNeedsHydrate: () => true,
    ensurePlacementParent: () => new Promise(resolve => { ready = resolve }),
    onHttpCommand: () => completed()
  }
  r.mindMap.command.pause = () => {}
  r.insertNode()
  const replacement = node('parent', [node('before'), ...children.map(child => node(child.uid))])
  replacement.children.forEach(child => live.set(child.uid, child))
  live.set('parent', replacement)
  ready()
  await done
  assert.deepEqual(order(parent), ['first', 'selected', 'last'])
  assert.equal(order(replacement)[2], 'selected')
  assert.match(order(replacement)[3], /^new-/)
  assert.equal(order(replacement)[4], 'last')
})


test('partial rendered siblings use the full hydrated data order for insertion', () => {
  const { r, parent } = fixture()
  const preceding = Array.from({ length: 40 }, (_, i) => node(`loaded-${i}`).nodeData)
  parent.nodeData.children.unshift(...preceding)
  r.insertNode()
  assert.equal(order(parent)[41], 'selected')
  assert.match(order(parent)[42], /^new-/)
  assert.equal(order(parent)[43], 'last')
})

const recoverySource = fs.readFileSync(path.join(__dirname, '../src/plugins/cooperateRecovery.js'), 'utf8')
const clientRecovery = vm.runInNewContext(recoverySource.replace(/export /g, '') + '\n({ applyCollabEvent })')

test('successive creation ACKs preserve sibling order when the initial client snapshot omits positions', async () => {
  const positions = generateNKeysBetween(null, null, 3)
  const initial = {
    parent: { isRoot: true, data: { uid: 'parent' }, children: ['first', 'selected', 'last'] },
    first: { data: { uid: 'first' }, position: positions[0], children: [] },
    selected: { data: { uid: 'selected' }, position: positions[1], children: [] },
    last: { data: { uid: 'last' }, position: positions[2], children: [] }
  }
  const store = createMemoryStore(initial)
  let client = JSON.parse(JSON.stringify(initial))
  for (const item of Object.values(client)) delete item.position
  let replay = JSON.parse(JSON.stringify(client))
  for (let i = 0; i < 3; i++) {
    const uid = `ack-new-${i}`
    const index = 2 + i
    const applied = await applyDirect(store, {
      type: 'node.insert', payload: { uid, parent: 'parent', index, text: uid }
    }, { version: i + 1 })
    client = clientRecovery.applyCollabEvent(client, applied.event)
    replay = applyServerCollabEvent(replay, applied.event)
    assert.deepEqual(replay.parent.children, store.graph.parent.children)
    assert.deepEqual(Array.from(client.parent.children), store.graph.parent.children,
      'a creation ACK must not sort newly positioned nodes above old siblings without positions')
    // Local creation reconciliation can receive the same insert from both ACK and broadcast.
    client = clientRecovery.applyCollabEvent(client, applied.event)
    assert.deepEqual(Array.from(client.parent.children), store.graph.parent.children)
  }
})


for (const [label, apply] of [['browser', clientRecovery.applyCollabEvent], ['server', applyServerCollabEvent]]) {
  test(`${label}: mixed sibling positions use the confirmed index; complete positions retain canonical order`, () => {
    const keys = generateNKeysBetween(null, null, 4)
    const initial = {
      p: { data: { uid: 'p' }, children: ['a', 'b', 'c'] },
      a: { data: { uid: 'a' }, children: [], position: keys[0] },
      b: { data: { uid: 'b' }, children: [] },
      c: { data: { uid: 'c' }, children: [] }
    }
    const event = { type: 'node.inserted', payload: { uid: 'n', parentUid: 'p', index: 2, position: keys[2], data: { uid: 'n' } } }
    const mixed = apply(initial, event)
    assert.deepEqual(Array.from(mixed.p.children), ['a', 'b', 'n', 'c'])
    const reindex = apply(initial, { ...event, payload: { ...event.payload, index: 0, reindex: true,
      siblingPositions: { a: keys[0], b: keys[1], c: keys[3] } } })
    assert.deepEqual(Array.from(reindex.p.children), ['a', 'b', 'n', 'c'], 'complete positions take priority over an obsolete index')
    const moved = apply(mixed, { type: 'node.reordered', payload: { uid: 'c', parentUid: 'p', index: 1, position: keys[1] } })
    assert.deepEqual(Array.from(moved.p.children), ['a', 'c', 'b', 'n'], 'reordering with incomplete positions preserves the target index')
  })
}


test('Enter maintains parent childCount and expand state just like Tab, including repeated insertions', () => {
  const viaEnter = fixture()
  const viaTab = fixture()
  viaEnter.parent.setData({ childCount: 3, expand: false })
  viaTab.parent.setData({ childCount: 3, expand: false })
  for (let i = 0; i < 3; i++) {
    viaEnter.r.insertNode(false)
    insertChildNode.call(viaTab.r, false, [viaTab.parent])
    assert.equal(viaTab.parent.getData('childCount'), 4 + i)
    assert.equal(viaEnter.parent.getData('childCount'), viaTab.parent.getData('childCount'))
    assert.equal(viaEnter.parent.getData('expand'), true)
    assert.equal(order(viaEnter.parent)[1], 'selected')
    assert.match(order(viaEnter.parent)[2], /^new-/)
  }
})

const cooperateSource = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
const projectStart = cooperateSource.indexOf('  projectCanonicalChildOrder(parentUid) {')
const projectEnd = cooperateSource.indexOf('\n  applyV2PayloadInsert(', projectStart)
const projectCanonicalChildOrder = vm.runInNewContext('({' + cooperateSource.slice(projectStart, projectEnd) + '\n})', {console}).projectCanonicalChildOrder

test('creation ACK must not rank a new node before previously lazy-loaded committed siblings missing from the canonical cache', () => {
  const children = ['a', 'b', 'new'].map(uid => ({ data: { uid } }))
  const parent = { nodeData: { children } }
  const instance = {
    currentData: { p: { children: ['new'] }, new: { position: 'M000000000000000' } },
    _pendingChildOrderParents: new Set(['p']),
    mindMap: { renderer: { findNodeByUid: () => parent } },
    isPersistAcked: uid => uid !== 'new',
    isTombstonedUid: () => false
  }
  assert.equal(projectCanonicalChildOrder.call(instance, 'p'), false)
  assert.deepEqual(children.map(child => child.data.uid), ['a', 'b', 'new'])
  assert.equal(instance._pendingChildOrderParents.has('p'), true, 'retain the deferred order until all committed siblings are represented')
  instance.currentData.p.children = ['a', 'new', 'b']
  assert.equal(projectCanonicalChildOrder.call(instance, 'p'), true)
  assert.deepEqual(children.map(child => child.data.uid), ['a', 'new', 'b'])
  assert.equal(instance._pendingChildOrderParents.has('p'), false)
})
