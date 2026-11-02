const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/utils/mapTitleSync.js'), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export class MapTitleSync', 'class MapTitleSync') + '\nmodule.exports = MapTitleSync'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function setup(request) {
  const handlers = {}, listeners = {}, emitted = [], updates = [], changes = []
  const socket = { connected: true, on: (name, fn) => { handlers[name] = fn }, emit: (name, body, cb) => { emitted.push([name, body]); if (cb) cb({ ok: true }) }, disconnect: () => { socket.connected = false } }
  const root = { data: { uid: 'root', text: 'Root text' }, children: [
    { data: { uid: 'ref', text: 'Old map', mapRef: { mapId: 'child', type: 'map' } }, children: [] },
    { data: { uid: 'collapsed', text: 'Parent' }, children: [
      { data: { uid: 'hidden', text: 'Old map', mapRef: { mapId: 'child', type: 'map' } }, children: [] }
    ] },
    { data: { uid: 'mirror', text: 'Bound node', mapRef: { mapId: 'child', nodeId: 'bound', syncMode: 'mirror' } }, children: [] }
  ] }
  const map = {
    cooperate: { isApplyingRemote: false },
    on: (name, fn) => { listeners[name] = fn }, off: name => { delete listeners[name] },
    renderer: { renderTree: root, findNodeByUid: () => null, setNodeDataRender: () => { throw Error('Unexpected rendered node') } }
  }
  const context = { module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    getRuntimeConfig: () => ({ collabApi: 'http://local' }),
    normalizeMapRef: ref => ref || null, isMirrorMapRef: ref => ref && ref.syncMode === 'mirror' }
  vm.runInNewContext(source, context)
  const sync = new context.module.exports({ mindMap: map, roomKey: 'host', request,
    createSocket: () => socket, onTitle: value => updates.push(value), onRoomChanged: key => changes.push(key) })
  sync.start()
  return { sync, map, socket, root, handlers, listeners, emitted, updates, changes }
}

test('keeps independently named maps initially; root edits update header immediately', async () => {
  const x = setup(async key => ({ exists: true, title: key === 'host' ? 'Independent title' : 'Child title' }))
  try {
    await delay(140)
    assert.equal(x.updates.find(u => u.roomKey === 'host').title, 'Independent title')
    x.root.data.text = '<b>New root</b>'
    x.listeners.data_change()
    assert.equal(x.updates.at(-1).title, 'New root')
    x.sync.schedule('host')
    await delay(140)
    assert.equal(x.updates.filter(u => u.roomKey === 'host').at(-1).title, 'New root', 'stale HTTP must not overwrite optimistic title')
  } finally { x.sync.stop() }
})

test('push updates duplicate and collapsed map references without editing node mirrors', async () => {
  let title = 'First'
  const x = setup(async () => ({ exists: true, title }))
  try {
    await delay(140)
    assert.equal(x.root.children[0].data.text, 'First')
    assert.equal(x.root.children[1].children[0].data.text, 'First')
    assert.equal(x.root.children[2].data.text, 'Bound node')
    title = 'Renamed remotely'
    x.handlers['op:event']({ roomKey: 'child' })
    await delay(140)
    assert.equal(x.root.children[0].data.text, title)
    assert.equal(x.changes.at(-1), 'child')
    assert.equal(x.map.cooperate.isApplyingRemote, false)
    assert.equal(x.emitted.filter(([name]) => name === 'map:watch').length, 2, 'deduplicate rooms')
  } finally { x.sync.stop() }
})

test('resolves node-bound references to node names rather than enclosing map titles', async () => {
  const x = setup(async (key, uid) => ({ exists: true, title: 'Map title', nodeExists: true, nodeText: uid ? 'Node title' : '' }))
  try {
    x.root.children[0].data.mapRef = { mapId: 'child', nodeId: 'n1', type: 'node' }
    x.sync.scan()
    await delay(140)
    assert.equal(x.root.children[0].data.text, 'Node title')
    assert.equal(x.root.children[1].children[0].data.text, 'Map title')
  } finally { x.sync.stop() }
})

test('does not apply delayed responses after disposal or removed references', async () => {
  let resolveChild
  const x = setup(key => key === 'child' ? new Promise(resolve => { resolveChild = resolve }) : Promise.resolve({ exists: true, title: 'Host' }))
  await delay(140)
  const refNode = x.root.children[0]
  delete refNode.data.mapRef
  x.sync.stop()
  resolveChild({ exists: true, title: 'Late' })
  await delay(10)
  assert.equal(refNode.data.text, 'Old map')
  assert.equal(Object.keys(x.listeners).length, 0)
  assert.equal(x.socket.connected, false)
})

test('reconnect resubscribes and refreshes; inaccessible maps keep previous names', async () => {
  let missing = true
  const x = setup(async () => ({ exists: !missing, title: 'Recovered' }))
  try {
    await delay(140)
    assert.equal(x.root.children[0].data.text, 'Old map')
    missing = false
    x.handlers.connect()
    await delay(140)
    assert.equal(x.root.children[0].data.text, 'Recovered')
    x.root.children = []
    x.sync.scan()
    assert.ok(x.emitted.some(([name, body]) => name === 'map:unwatch' && body.roomKey === 'child'))
  } finally { x.sync.stop() }
})
