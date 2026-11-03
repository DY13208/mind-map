const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/utils/mapTitleSync.js'), 'utf8')
  .replace(/^import .*\n/gm, '').replace(/export /g, '') + '\nmodule.exports = { MapTitleSync, resolveInitialMapRefTitles }'
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
    normalizeMapRef: ref => ref || null,
    withMirrorForwardSuppressed: fn => { map.mirrorForwardSuppressed = true; try { return fn() } finally { map.mirrorForwardSuppressed = false } } }
  vm.runInNewContext(source, context)
  const sync = new context.module.exports.MapTitleSync({ mindMap: map, roomKey: 'host', request,
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

test('push updates duplicate and collapsed map references while retaining unresolved node names', async () => {
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


test('refreshes mirror names without waiting for a subtree version change, including collapsed references', async () => {
  let title = 'Renamed bound node'
  const requests = []
  const x = setup(async (key, uid) => {
    requests.push([key, uid])
    return { exists: true, title: 'Enclosing map', nodeExists: true, nodeText: title }
  })
  try {
    x.root.children[1].children[0].data.mapRef = { mapId: 'child', nodeId: 'bound', syncMode: 'mirror', peerVersion: 10 }
    x.sync.scan()
    await delay(140)
    assert.equal(x.root.children[2].data.text, title)
    assert.equal(x.root.children[1].children[0].data.text, title)
    assert.equal(requests.filter(([key, uid]) => key === 'child' && uid === 'bound').length, 1)
    title = 'Renamed again'
    x.handlers['op:event']({ roomKey: 'child' })
    await delay(140)
    assert.equal(x.root.children[2].data.text, title)
    assert.equal(x.root.children[1].children[0].data.text, title)
  } finally { x.sync.stop() }
})

test('rendered mirror label refresh suppresses editing both source and host rooms', async () => {
  const x = setup(async () => ({ exists: true, title: 'Map title', nodeExists: true, nodeText: 'New node name' }))
  const data = x.root.children[2].data
  let renders = 0
  x.map.renderer.findNodeByUid = uid => uid === data.uid ? { getData: key => data[key] } : null
  x.map.renderer.setNodeDataRender = (live, patch) => {
    assert.equal(x.map.cooperate.isApplyingRemote, true)
    assert.equal(x.map.mirrorForwardSuppressed, true)
    Object.assign(data, patch)
    renders += 1
  }
  try {
    await delay(140)
    assert.equal(data.text, 'New node name')
    assert.equal(renders, 1)
    assert.equal(x.map.cooperate.isApplyingRemote, false)
    assert.equal(x.map.mirrorForwardSuppressed, false)
  } finally { x.sync.stop() }
})

test('delayed metadata refresh updates current tree after a collaboration snapshot replaces it', async () => {
  let resolveChild
  const x = setup(key => key === 'child' ? new Promise(resolve => { resolveChild = resolve }) : Promise.resolve({ exists: true, title: 'Host' }))
  try {
    await delay(140)
    const oldNode = x.root.children[0]
    const current = JSON.parse(JSON.stringify(x.root))
    x.map.renderer.renderTree = current
    resolveChild({ exists: true, title: 'Current name' })
    await delay(10)
    assert.equal(current.children[0].data.text, 'Current name')
    assert.equal(oldNode.data.text, 'Old map')
  } finally { x.sync.stop() }
})


function initialResolver() {
  const context = { module: { exports: {} }, setTimeout, clearTimeout,
    normalizeMapRef: ref => ref || null }
  vm.runInNewContext(source, context)
  return context.module.exports.resolveInitialMapRefTitles
}

test('initial preview resolves map and mirrored node titles before callers can paint, with duplicate request deduplication', async () => {
  const resolve = initialResolver()
  const tree = { data: { uid: 'root', text: 'Host' }, children: [
    { data: { uid: 'a', text: 'Old', mapRef: { mapId: 'child' } } },
    { data: { uid: 'b', text: 'Old node', mapRef: { mapId: 'child', nodeId: 'bound', syncMode: 'mirror' } } },
    { data: { uid: 'c', text: 'Old duplicate', mapRef: { mapId: 'child', nodeId: 'bound', syncMode: 'mirror' } } }
  ] }
  const calls = []
  await resolve(tree, { request: async (key, uid) => {
    calls.push([key, uid])
    return { exists: true, nodeExists: true, title: 'New map', nodeText: '<b>New node</b>' }
  } })
  assert.deepEqual(tree.children.map(node => node.data.text), ['New map', 'New node', 'New node'])
  assert.equal(calls.length, 2)
  assert.equal(tree.data.text, 'Host')
})

test('slow or inaccessible initial title lookups cannot stall opening or mutate the tree after timeout', async () => {
  const resolve = initialResolver()
  const slow = { data: { text: 'Last known', mapRef: { mapId: 'slow' } } }
  let finish
  await resolve(slow, { timeoutMs: 10, request: () => new Promise(yes => { finish = yes }) })
  assert.equal(slow.data.text, 'Last known')
  finish({ exists: true, title: 'Late response' })
  await delay(5)
  assert.equal(slow.data.text, 'Last known')
  await resolve(slow, { request: async () => { throw new Error('403') } })
  assert.equal(slow.data.text, 'Last known')
})

test('initial lookup ignores stale room attempts and bounds concurrent reference requests', async () => {
  const resolve = initialResolver()
  const tree = { data: {}, children: Array.from({ length: 9 }, (_, i) => ({ data: { text: 'Old', mapRef: { mapId: 'child' + i } } })) }
  let running = 0, peak = 0, current = true
  await resolve(tree, { concurrency: 3, isCurrent: () => current, request: async () => {
    running++; peak = Math.max(peak, running)
    await delay(5)
    running--; current = false
    return { exists: true, title: 'Wrong room' }
  } })
  assert.equal(peak, 3)
  assert.ok(tree.children.every(node => node.data.text === 'Old'))
})

test('room preview waits for initial labels before setData and abandons an outdated attempt', async () => {
  const sfc = fs.readFileSync(require('node:path').join(__dirname, '../src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
  const start = sfc.indexOf('    async applyPreview(')
  const end = sfc.indexOf('    async promptSopConfirmation(', start)
  const method = sfc.slice(start, end).trim().replace(/,$/, '')
  for (const cancel of [false, true]) {
    let finish, painted = false
    const stoppedAtPaint = new Error('observed first paint')
    const context = { resolveInitialMapRefTitles: tree => new Promise(yes => { finish = () => { tree.data.text = 'Fresh label'; yes(tree) } }),
      countNodes: () => 1, hasPartialPreviewTree: () => false }
    const methods = vm.runInNewContext(`({ ${method} })`, context)
    const owner = { _openAttemptId: 1, mindMap: { cooperate: { setPreviewApplied() {} } },
      applyAccess() {}, useCollabV2: () => false, enableHttpCollab() {},
      $bus: { $emit: (event, tree) => { if (event === 'setData') {
        painted = true
        assert.equal(tree.data.text, 'Fresh label')
        throw stoppedAtPaint
      } } } }
    const promise = methods.applyPreview.call(owner, { tree: { data: { text: 'Old label' } } }, true, 1)
    assert.equal(painted, false)
    if (cancel) owner._openAttemptId = 2
    finish()
    if (cancel) {
      assert.equal(await promise, false)
      assert.equal(painted, false)
    } else await assert.rejects(promise, err => err === stoppedAtPaint)
  }
})
