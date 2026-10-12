const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const { createFileSystem, createMemoryFileStore } = require('../bin/fileSystem')
const { createPgFileStore } = require('../bin/fileSystem/pgStore')

function frontend(cache = new Map()) {
  const timers = new Map()
  let timerId = 0
  const events = {}
  const ctx = vm.createContext({
    console,
    localStorage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener: (name, fn) => { events[name] = fn }, removeEventListener: name => { delete events[name] } }
  })
  vm.runInContext(fs.readFileSync(require.resolve('../../web/src/utils/personalExpandState.js'), 'utf8').replace(/export /g, ''), ctx)
  return { ctx, cache, timers, events }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const plain = value => JSON.parse(JSON.stringify(value))

test('user/map isolation, concurrent nodes merge, stale same-node writes lose without touching public data', async () => {
  const store = createMemoryFileStore()
  const engine = createFileSystem({ store })
  const one = (await engine.createRoom({ title: 'one', userId: 'a' })).room.roomKey
  const two = (await engine.createRoom({ title: 'two', userId: 'a' })).room.roomKey
  const before = JSON.stringify({ rooms: [...store.rooms], nodes: [...store.nodes], operations: store.operations })
  await Promise.all([
    engine.setUserViewState(one, 'a', { expand: { x: false }, expandBase: { x: 0 } }),
    engine.setUserViewState(one, 'a', { expand: { y: false }, expandBase: { y: 0 } }),
    engine.setUserViewState(two, 'a', { expand: { x: true }, expandBase: { x: 0 } })
  ])
  let view = await engine.getUserViewState(one, 'a')
  assert.deepEqual(view.expand, { x: false, y: false })
  assert.deepEqual(view.expandVersions, { x: 1, y: 1 })
  await engine.setUserViewState(one, 'a', { expand: { x: true }, expandBase: { x: 1 } })
  await engine.setUserViewState(one, 'a', { expand: { x: false, z: true }, expandBase: { x: 1, z: 0 } })
  view = await engine.getUserViewState(one, 'a')
  assert.deepEqual(view.expand, { x: true, y: false, z: true })
  assert.equal(view.expandVersions.x, 2)
  assert.equal((await engine.getUserViewState(two, 'a')).expand.x, true)
  store.members.push({ room_key: one, user_id: 'b', role: 'viewer' })
  await engine.setUserViewState(one, 'b', { expand: { x: false }, expandBase: { x: 0 } })
  assert.equal((await engine.getUserViewState(one, 'a')).expand.x, true)
  assert.equal((await engine.getUserViewState(one, 'b')).expand.x, false)
  assert.equal(JSON.stringify({ rooms: [...store.rooms], nodes: [...store.nodes], operations: store.operations }), before)
})

test('late load retains edited nodes and restores other nodes; writes are debounced and serialized', async () => {
  const { ctx, timers } = frontend()
  let loaded
  let ack
  let restored
  const writes = []
  const persistence = ctx.createPersonalExpandPersistence('map', 'a', () => new Promise(resolve => { loaded = resolve }),
    (room, patch) => { writes.push(plain(patch)); return new Promise(resolve => { ack = resolve }) }, state => { restored = plain(state) })
  persistence.record({ x: false })
  persistence.record({ x: true })
  assert.equal(timers.size, 1)
  loaded({ state: { expand: { x: false, y: false }, expandVersions: { x: 4, y: 2 } } })
  await settle()
  assert.deepEqual(restored, { x: true, y: false })
  const saving = persistence.flush()
  await settle()
  assert.deepEqual(writes, [{ expand: { x: true }, expandBase: { x: 4 } }])
  persistence.record({ x: false })
  persistence.flush()
  assert.equal(writes.length, 1)
  ack({ state: { expand: { x: true, y: false }, expandVersions: { x: 5, y: 2 } } })
  await saving
  const last = persistence.flush()
  await settle()
  assert.deepEqual(writes[1], { expand: { x: false }, expandBase: { x: 5 } })
  ack({ state: { expand: { x: false, y: false }, expandVersions: { x: 6, y: 2 } } })
  await last
  await persistence.stop()
})

test('failed writes survive reload, keep their old version, and closed maps cannot apply delayed loads', async () => {
  const cache = new Map()
  let restored
  const first = frontend(cache)
  const persistence = first.ctx.createPersonalExpandPersistence('map', 'a', async () => ({ state: { expandVersions: { x: 3 } } }),
    async () => { throw new Error('offline') }, state => { restored = plain(state) })
  await settle()
  persistence.record({ x: false })
  await persistence.flush()
  await persistence.stop()
  const second = frontend(cache)
  const writes = []
  const reloaded = second.ctx.createPersonalExpandPersistence('map', 'a', async () => ({ state: { expand: { x: true }, expandVersions: { x: 7 } } }),
    async (room, patch) => { writes.push(plain(patch)); return { state: { expand: { x: true }, expandVersions: { x: 7 } } } }, state => { restored = plain(state) })
  await settle()
  assert.equal(restored.x, false, 'cached unsent intent restores locally')
  await reloaded.flush()
  assert.deepEqual(writes[0].expandBase, { x: 3 }, 'never rebase an old journal over newer server state')
  await reloaded.stop()
  let finish
  let applied = false
  const abandoned = second.ctx.createPersonalExpandPersistence('other', 'a', () => new Promise(resolve => { finish = resolve }), async () => {}, () => { applied = true })
  await abandoned.stop()
  finish({ state: { expand: { x: false } } })
  await settle()
  assert.equal(applied, false)
})

test('tree refresh preserves existing personal flags, deleted UIDs ignored, added UIDs default', () => {
  const { ctx } = frontend()
  vm.runInContext(fs.readFileSync(require.resolve('../src/utils/personalNodeView.js'), 'utf8').replace(/export /g, ''), ctx)
  const current = { data: { uid: 'root' }, children: [{ data: { uid: 'x', expand: false } }] }
  const remote = { data: { uid: 'root', expand: false }, children: [
    { data: { uid: 'x', text: 'updated', expand: true } }, { data: { uid: 'new', expand: false } }
  ] }
  ctx.preservePersonalNodeView(remote, current)
  assert.equal(remote.children[0].data.expand, false)
  assert.equal(remote.children[0].data.text, 'updated')
  assert.equal(remote.children[1].data.expand, undefined)
  ctx.applyPersonalExpandState({ renderer: { renderTree: remote } }, { deleted: false })
  const shared = ctx.stripPersonalNodeView({ x: { data: { uid: 'x', expand: false, isActive: true, text: 'updated' }, children: [] } })
  assert.deepEqual(plain(shared.x.data), { uid: 'x', text: 'updated' })
})

test('PostgreSQL row locks merge concurrent first writes and reject stale versions', { skip: !process.env.PERSONAL_EXPAND_TEST_PG_PORT }, async () => {
  const { Pool } = require('pg')
  const schema = 'expand_test_' + process.pid
  const pool = new Pool({ host: '127.0.0.1', port: Number(process.env.PERSONAL_EXPAND_TEST_PG_PORT), database: 'cpd_expand_test', user: 'postgres', password: 'cpd-test-only', options: '-c search_path=' + schema })
  try {
    await pool.query('create schema ' + schema)
    await pool.query(`create table room_user_state (room_key text, user_id text, is_favorite boolean default false,
      last_opened_at timestamptz, view_state jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), primary key (room_key, user_id))`)
    const store = createPgFileStore(pool)
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.upsertUserState('map', 'a', { view_state: { expand: { ['n' + i]: false }, expandBase: { ['n' + i]: 0 } } })))
    let row = (await pool.query('select view_state from room_user_state')).rows[0].view_state
    assert.equal(Object.keys(row.expand).length, 12)
    await Promise.all([
      store.upsertUserState('map', 'a', { view_state: { expand: { n0: true }, expandBase: { n0: 1 } } }),
      store.upsertUserState('map', 'a', { view_state: { theme: 'dark' } })
    ])
    await store.upsertUserState('map', 'a', { view_state: { expand: { n0: false }, expandBase: { n0: 1 } } })
    row = (await pool.query('select view_state from room_user_state')).rows[0].view_state
    assert.equal(row.expand.n0, true)
    assert.equal(row.expandVersions.n0, 2)
    assert.equal(row.theme, 'dark')
  } finally {
    await pool.query('drop schema ' + schema + ' cascade')
    await pool.end()
  }
})

test('remote V2 insert leaves a collapsed parent collapsed', () => {
  const source = fs.readFileSync(require.resolve('../src/plugins/Cooperate.js'), 'utf8')
  const begin = source.indexOf('  applyV2PayloadInsert(')
  const end = source.indexOf('\n  ', source.indexOf('\n  }', begin) + 5)
  const method = vm.runInNewContext('({' + source.slice(begin, end) + '})', {
    payloadParentUid: payload => payload.parentUid,
    payloadNodeData: payload => payload.data || {},
    v2Trace() {}
  }).applyV2PayloadInsert
  const parent = { nodeData: { data: { uid: 'p', expand: false }, children: [] }, getData: key => parent.nodeData.data[key] }
  const context = {
    isGeneralizationUid: () => false, isTombstonedUid: () => false,
    markV2OriginApplied() {}, seedHttpRecords() {},
    mindMap: {
      renderer: { findNodeByUid: uid => uid === 'p' ? parent : null, setNodeData: (node, data) => Object.assign(node.nodeData.data, data) },
      command: { pause() {}, recovery() {} }, render() {}
    }
  }
  assert.equal(method.call(context, { uid: 'child', parentUid: 'p', data: { text: 'new', expand: false } }), true)
  assert.equal(parent.nodeData.data.expand, false)
  assert.equal(parent.nodeData.children[0].data.expand, true)
})

test('legacy Yjs expand-only edits send no update; text/structure changes still publish', () => {
  const source = fs.readFileSync(require.resolve('../src/plugins/Cooperate.js'), 'utf8')
  const start = source.indexOf('  updateChanges(data) {')
  const end = source.indexOf('\n  // 节点激活状态', start)
  const { ctx } = frontend()
  vm.runInContext(fs.readFileSync(require.resolve('../src/utils/personalNodeView.js'), 'utf8').replace(/export /g, ''), ctx)
  const writes = []
  Object.assign(ctx, { isSameObject: (a, b) => JSON.stringify(a) === JSON.stringify(b), applyObjectToYMap: (map, patch) => writes.push(plain(patch)) })
  const method = vm.runInContext('({' + source.slice(start, end) + '})', ctx).updateChanges
  const row = { data: { uid: 'x', text: 'old', expand: true }, children: [] }
  const context = { mindMap: { opt: {} }, currentData: { x: row }, recentDeleted: new Map(), ymap: {} }
  const next = ctx.stripPersonalNodeView({ x: { ...row, data: { ...row.data, expand: false } } })
  method.call(context, next)
  assert.equal(writes.length, 0)
  next.x.data.text = 'new'
  method.call(context, next)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].x.data.expand, undefined)
  assert.equal(writes[0].x.data.text, 'new')
})

test('personal commands bypass shared history and HTTP command scanning', () => {
  const { ctx } = frontend()
  vm.runInContext(fs.readFileSync(require.resolve('../src/utils/personalNodeView.js'), 'utf8').replace(/export /g, ''), ctx)
  const command = fs.readFileSync(require.resolve('../src/core/command/Command.js'), 'utf8')
  const start = command.indexOf('  exec(name, ...args) {')
  const end = command.indexOf('\n  //  添加命令', start)
  const exec = vm.runInContext('({' + command.slice(start, end) + '})', ctx).exec
  let histories = 0
  let events = 0
  const commands = {}
  for (const name of ['SET_NODE_EXPAND', 'SET_NODE_DATA', 'EXPAND_ALL', 'UNEXPAND_ALL', 'UNEXPAND_TO_LEVEL']) commands[name] = [() => {}]
  const context = { mindMap: { opt: {}, emit: () => events++ }, commands, addHistory: () => histories++ }
  exec.call(context, 'SET_NODE_EXPAND', {}, false)
  exec.call(context, 'SET_NODE_DATA', {}, { expand: false })
  exec.call(context, 'EXPAND_ALL')
  exec.call(context, 'UNEXPAND_ALL')
  exec.call(context, 'UNEXPAND_TO_LEVEL', 2)
  assert.equal(histories, 0)
  assert.equal(events, 10, 'personal persistence still receives command events')
  exec.call(context, 'SET_NODE_DATA', {}, { expand: false, text: 'new' })
  assert.equal(histories, 1, 'business changes remain in normal history')
  const cooperate = fs.readFileSync(require.resolve('../src/plugins/Cooperate.js'), 'utf8')
  const begin = cooperate.indexOf('  onAfterExecCommand(name) {')
  const finish = cooperate.indexOf('\n  flushLocalNow()', begin)
  const handler = vm.runInContext('({' + cooperate.slice(begin, finish) + '})', ctx).onAfterExecCommand
  handler.call({ mindMap: {} }, 'SET_NODE_EXPAND', {}, false)
  handler.call({ mindMap: {} }, 'SET_NODE_DATA', {}, { expand: false })
})

test('sub-map navigation uses defaults only without saved state; restoring selection cannot reveal hidden ancestors', async () => {
  const { ctx } = frontend()
  const vue = fs.readFileSync(require.resolve('../../web/src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
  const start = vue.indexOf('    async applyMapRefShallowExpand(')
  const end = vue.indexOf('    clearShallowExpandQuery()', start)
  const method = vm.runInContext('({' + vue.slice(start, end) + '})', ctx).applyMapRefShallowExpand
  let restored = 0
  const context = { mindMap: { renderer: {} }, personalExpandState: { branch: false }, restorePersonalExpandState: async () => restored++ }
  await method.call(context, 2)
  assert.equal(restored, 1)
  const root = { data: { uid: 'root' }, children: [{ data: { uid: 'branch', expand: false }, children: [{ data: { uid: 'leaf' } }] }] }
  assert.equal(ctx.isPersonalExpandNodeVisible({ renderer: { renderTree: root } }, 'leaf'), false)
  assert.equal(ctx.isPersonalExpandNodeVisible({ renderer: { renderTree: root } }, 'branch'), true)
  const summary = { uid: 'summary', expand: false, children: [{ data: { uid: 'summary-child' } }] }
  root.data.generalization = [summary]
  const state = ctx.collectPersonalExpandState({ renderer: { renderTree: root } })
  assert.equal(state.summary, false)
  ctx.applyPersonalExpandState({ renderer: { renderTree: root } }, { summary: true })
  assert.equal(summary.expand, true)
})
