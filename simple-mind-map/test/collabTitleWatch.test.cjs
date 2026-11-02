const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../bin/collabV2/socketServer.js'), 'utf8')

function setup() {
  const aclEvents = new EventEmitter(), mcpEvents = new EventEmitter()
  const activated = [], checked = [], handlers = {}, joined = new Set()
  let denied = false, peersWritten = 0
  class Server {
    constructor() { this.handlers = {}; this.sockets = { sockets: new Map() } }
    use() {}
    on(name, handler) { this.handlers[name] = handler }
    to() { return { emit() {} } }
  }
  const bridge = { start: async () => {}, stop: async () => {}, activateRoom: (...args) => activated.push(args) }
  const mocks = {
    'socket.io': { Server },
    '../auth': { isAuthEnabled: () => false },
    '../roomAcl': { aclChangeEvents: aclEvents, assertRoomAccess: async (_, req, key, action) => {
      checked.push({ key, action, user: req.authUser.id })
      if (denied) throw Object.assign(Error('denied'), { statusCode: 403 })
      return { canEdit: false }
    } },
    '../storage': { getPool: () => ({}), getRoomVersion: async () => 3, safeRoomKey: key => key || '', isDeletedRoom: () => false },
    './flag': { isCollabV2Enabled: () => true, isCollabV2EventBridgeEnabled: () => true },
    './sequencer': {}, './protocol': {}, './trace': { collabTrace() {} },
    './presenceHub': { createPresenceHub: () => ({ list: () => [], setPeer: () => { peersWritten++ } }) },
    './mcpPresence': { changes: mcpEvents, prune() {}, list: () => [] },
    './operationEventBridge': { createOperationEventBridge: () => bridge }
  }
  const context = { module: { exports: {} }, require: name => {
    assert.ok(name in mocks, `Unexpected dependency ${name}`)
    return mocks[name]
  }, setInterval, clearInterval, setTimeout, clearTimeout, console, process }
  vm.runInNewContext(source, context)
  const attached = context.module.exports.attachCollabV2({})
  const socket = { id: 'observer', data: {}, request: {}, authUser: { id: 'viewer' }, connected: true,
    on: (name, handler) => { handlers[name] = handler }, join: async name => joined.add(name), leave: name => joined.delete(name),
    disconnect: () => { socket.connected = false; joined.clear() } }
  attached.io.sockets.sockets.set(socket.id, socket)
  attached.io.handlers.connection(socket)
  return { attached, socket, handlers, joined, activated, checked, aclEvents,
    deny: () => { denied = true }, peersWritten: () => peersWritten,
    stop: async () => { handlers.disconnect(); await attached.stop() } }
}

test('observer requires view access and receives room events without presence or edit access', async () => {
  const x = setup()
  try {
    let reply
    await x.handlers['map:watch']({ roomKey: 'source' }, value => { reply = value })
    assert.equal(reply.ok, true)
    assert.equal(x.checked[0].action, 'view')
    assert.equal(x.checked[0].user, 'viewer')
    assert.ok(x.joined.has('v2:source'))
    assert.equal(x.peersWritten(), 0)
    assert.equal(x.socket.data.rooms.size, 0)
    assert.equal(x.socket.data.editAccess.size, 0)
    assert.equal(x.activated[0][0], 'source')
    x.handlers['map:unwatch']({ roomKey: 'source' })
    assert.equal(x.joined.size, 0)
    assert.equal(x.socket.data.bridgeRooms.size, 0)
  } finally { await x.stop() }
})

test('denied observer never joins; revoked access disconnects an existing observer', async () => {
  const x = setup()
  try {
    await x.handlers['map:watch']({ roomKey: 'allowed' }, () => {})
    x.deny()
    let reply
    await x.handlers['map:watch']({ roomKey: 'private' }, value => { reply = value })
    assert.equal(reply.ok, false)
    assert.equal(reply.statusCode, 403)
    assert.equal(x.joined.has('v2:private'), false)
    x.aclEvents.emit('changed', 'allowed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(x.socket.connected, false)
  } finally { await x.stop() }
})
