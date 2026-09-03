const assert = require('assert')
const { randomUUID } = require('crypto')

process.env.COLLAB_V2 = '1'
process.env.COLLAB_TEST_ACL = '1'
process.env.WECOM_AUTH_ENABLED = process.env.WECOM_AUTH_ENABLED || '0'

const { tryPg, seedPgRoom, startV2Server, wait, emitAck } = require('./collabV2.pgHarness')
const roomAcl = require('../bin/roomAcl')

function connectAuthed(url, userId) {
  const { io } = require('socket.io-client')
  return io(url, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { userId, name: userId }
  })
}

async function join(url, roomKey, userId) {
  const socket = connectAuthed(url, userId)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(userId + ' connect timeout')), 8000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
  const joined = await emitAck(socket, 'join', {
    roomKey,
    clientId: userId,
    userId,
    name: userId,
    lastServerRevision: 0
  })
  return { socket, joined, userId }
}

async function submit(client, type, payload) {
  return emitAck(client.socket, 'op', {
    opId: randomUUID(),
    type,
    roomKey: client.roomKey,
    userId: client.userId,
    clientId: client.userId,
    payload
  })
}

async function main() {
  const api = await tryPg()
  if (api.error) {
    console.log('skip collabV2 ACL: PostgreSQL unavailable', api.error.message)
    return
  }
  const roomKey = 'pg-acl-' + Date.now()
  await seedPgRoom(api, roomKey, 8)
  const pool = api.getPool()
  await roomAcl.initSchema(pool)
  await pool.query(
    `insert into room_members (room_key, user_id, role)
     values ($1, 'owner', 'owner'), ($1, 'editor', 'editor'), ($1, 'viewer', 'viewer')
     on conflict (room_key, user_id) do update set role = excluded.role`,
    [roomKey]
  )
  const { server, url } = await startV2Server()
  const clients = []
  try {
    const owner = await join(url, roomKey, 'owner')
    owner.roomKey = roomKey
    const editor = await join(url, roomKey, 'editor')
    editor.roomKey = roomKey
    const viewer = await join(url, roomKey, 'viewer')
    viewer.roomKey = roomKey
    clients.push(owner, editor, viewer)
    assert.strictEqual(owner.joined.ok, true, JSON.stringify(owner.joined))
    assert.strictEqual(editor.joined.ok, true, JSON.stringify(editor.joined))
    assert.strictEqual(viewer.joined.ok, true, JSON.stringify(viewer.joined))
    assert.strictEqual(viewer.joined.canEdit, false)

    const ownerWrite = await submit(owner, 'node.update', { uid: 'n0', text: 'owner-ok' })
    assert.strictEqual(ownerWrite.ok, true, JSON.stringify(ownerWrite))
    const editorWrite = await submit(editor, 'node.update', { uid: 'n1', text: 'editor-ok' })
    assert.strictEqual(editorWrite.ok, true, JSON.stringify(editorWrite))
    const viewerWrite = await submit(viewer, 'node.update', { uid: 'n2', text: 'viewer-no' })
    assert.strictEqual(viewerWrite.ok, false)
    assert.strictEqual(viewerWrite.code, 'FORBIDDEN')

    await pool.query(
      `update room_members set role = 'viewer' where room_key = $1 and user_id = 'editor'`,
      [roomKey]
    )
    const demoted = await submit(editor, 'node.update', { uid: 'n1', text: 'after-demote' })
    assert.strictEqual(demoted.ok, false)
    assert.strictEqual(demoted.code, 'FORBIDDEN')

    let strangerErr = ''
    try {
      await join(url, roomKey, 'stranger')
    } catch (err) {
      strangerErr = err.code || err.message
    }
    const stranger = connectAuthed(url, 'stranger')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stranger connect timeout')), 8000)
      stranger.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      stranger.once('connect_error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
    const strangerJoin = await emitAck(stranger, 'join', {
      roomKey,
      clientId: 'stranger',
      userId: 'stranger',
      lastServerRevision: 0
    })
    assert.strictEqual(strangerJoin.ok, false)
    assert.ok(strangerJoin.code === 'FORBIDDEN' || strangerJoin.statusCode === 403)
    stranger.close()
    clients.push({ socket: stranger })

    console.log('collabV2 ACL socket integration ok', { roomKey })
  } finally {
    clients.forEach(item => item.socket && item.socket.close())
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
