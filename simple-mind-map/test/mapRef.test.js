const assert = require('assert')
const { normalizeMapRef, mapRefEquals } = require('../src/utils/mapRef')
const { resolveRoomRef } = require('../bin/roomNodes')

function testNormalizeMapRef() {
  assert.strictEqual(normalizeMapRef(null), null)
  assert.strictEqual(normalizeMapRef('room-a'), null)
  assert.strictEqual(normalizeMapRef({}), null)
  assert.deepStrictEqual(normalizeMapRef({ mapId: 'room-a' }), {
    mapId: 'room-a',
    nodeId: null,
    type: 'map'
  })
  assert.deepStrictEqual(
    normalizeMapRef({ room_key: 'room-b', uid: 'node-1' }),
    {
      mapId: 'room-b',
      nodeId: 'node-1',
      type: 'node'
    }
  )
  assert.deepStrictEqual(
    normalizeMapRef({ map_id: ' room-c ', node_id: ' n2 ' }),
    {
      mapId: 'room-c',
      nodeId: 'n2',
      type: 'node'
    }
  )
}

function testMapRefEquals() {
  assert.strictEqual(
    mapRefEquals({ mapId: 'a' }, { room_key: 'a' }),
    true
  )
  assert.strictEqual(
    mapRefEquals({ mapId: 'a', nodeId: 'n1' }, { mapId: 'a' }),
    false
  )
  assert.strictEqual(mapRefEquals(null, null), true)
  assert.strictEqual(mapRefEquals({ mapId: 'a' }, null), false)
}

function fakeDb(handlers) {
  return {
    async query(sql, params) {
      for (const handler of handlers) {
        if (handler.match.test(sql)) return handler.run(sql, params)
      }
      throw new Error('unexpected query: ' + sql)
    }
  }
}

async function testResolveRoomRefById() {
  const rooms = {
    'room-live': { room_key: 'room-live', title: 'Renamed Title', version: 3 }
  }
  const nodes = {
    'room-live:n1': { uid: 'n1', data: { text: '<p>Hello</p>' } }
  }
  const db = fakeDb([
    {
      match: /room_tombstones/,
      run: (_sql, params) => ({
        rows: params[0] === 'room-gone' ? [{}] : []
      })
    },
    {
      match: /from rooms/,
      run: (_sql, params) => ({
        rows: rooms[params[0]] ? [rooms[params[0]]] : []
      })
    },
    {
      match: /from room_nodes/,
      run: (_sql, params) => {
        const row = nodes[`${params[0]}:${params[1]}`]
        return { rows: row ? [row] : [] }
      }
    }
  ])

  const mapOnly = await resolveRoomRef(db, 'room-live')
  assert.strictEqual(mapOnly.exists, true)
  assert.strictEqual(mapOnly.mapId, 'room-live')
  assert.strictEqual(mapOnly.title, 'Renamed Title')
  assert.strictEqual(mapOnly.nodeExists, true)

  const withNode = await resolveRoomRef(db, 'room-live', 'n1')
  assert.strictEqual(withNode.exists, true)
  assert.strictEqual(withNode.nodeExists, true)
  assert.strictEqual(withNode.nodeText, 'Hello')

  const missingNode = await resolveRoomRef(db, 'room-live', 'missing')
  assert.strictEqual(missingNode.exists, true)
  assert.strictEqual(missingNode.nodeExists, false)

  const deleted = await resolveRoomRef(db, 'room-gone')
  assert.strictEqual(deleted.exists, false)
  assert.strictEqual(deleted.deleted, true)

  const missingMap = await resolveRoomRef(db, 'room-never')
  assert.strictEqual(missingMap.exists, false)
}

testNormalizeMapRef()
testMapRefEquals()
testResolveRoomRefById()
  .then(() => {
    console.log('mapRef tests passed')
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
