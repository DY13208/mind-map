const http = require('http')
const { randomUUID } = require('crypto')

process.env.COLLAB_V2 = process.env.COLLAB_V2 || '1'
process.env.WECOM_AUTH_ENABLED = process.env.WECOM_AUTH_ENABLED || '0'

require('../bin/loadEnv')

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function emitAck(socket, event, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + ' timeout')), timeoutMs)
    socket.emit(event, payload, result => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

function connectClient(url) {
  const { io } = require('socket.io-client')
  return io(url, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
}

async function waitConnected(socket, label) {
  if (socket.connected) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' connect timeout')), 8000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function seedBushRows(count) {
  const { generateNKeysBetween } = require('../bin/fractionalIndex')
  const keys = generateNKeysBetween(null, null, count + 1)
  const rows = [
    {
      uid: 'root',
      parent_uid: null,
      position: keys[0],
      data: { uid: 'root', text: 'Root' },
      is_root: true
    }
  ]
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    rows.push({
      uid,
      parent_uid: parent,
      position: keys[i + 1],
      data: { uid, text: 'N' + i },
      is_root: false
    })
  }
  return rows
}

function graphHash(nodes) {
  const keys = Object.keys(nodes || {}).filter(uid => nodes[uid] && !nodes[uid].deleted).sort()
  const parts = keys.map(uid => {
    const node = nodes[uid]
    const children = (node.children || []).slice().sort((a, b) => {
      const pa = (nodes[a] && nodes[a].position) || ''
      const pb = (nodes[b] && nodes[b].position) || ''
      if (pa !== pb) return pa < pb ? -1 : 1
      return String(a).localeCompare(String(b))
    })
    return [
      uid,
      children.join(','),
      (node.data && node.data.text) || '',
      (node.data && node.data.note) || '',
      node.position || ''
    ].join('|')
  })
  let hash = 0
  const text = parts.join(';')
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  }
  return { hash: hash.toString(16), count: keys.length }
}

async function tryPg() {
  const { initSchema, upsertRoom, getPool, readRoomNodes } = require('../bin/storage')
  try {
    await initSchema()
    await getPool().query('select 1')
    return { initSchema, upsertRoom, getPool, readRoomNodes }
  } catch (err) {
    return { error: err }
  }
}

async function seedPgRoom(api, roomKey, count) {
  await api.getPool().query(
    `insert into rooms (room_key, title, cos_key, nodes, version, updated_at)
     values ($1, $2, $3, '{}'::jsonb, 0, now())
     on conflict (room_key) do update set title = excluded.title, updated_at = now()`,
    [roomKey, 'pg-' + count, 'test/' + roomKey]
  )
  const rows = seedBushRows(count)
  const client = await api.getPool().connect()
  try {
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = rows.slice(i, i + 2000)
      await client.query(
        `insert into room_nodes
           (room_key, uid, parent_uid, position, data, is_root, node_version, deleted_at, updated_at)
         select $1, x.uid, x.parent_uid, x.position, x.data, x.is_root, 0, null, now()
         from jsonb_to_recordset($2::jsonb)
           as x(uid text, parent_uid text, position text, data jsonb, is_root boolean)
         on conflict (room_key, uid) do update set
           parent_uid = excluded.parent_uid,
           position = excluded.position,
           data = excluded.data,
           is_root = excluded.is_root,
           deleted_at = null,
           updated_at = now()`,
        [roomKey, JSON.stringify(chunk)]
      )
    }
  } finally {
    client.release()
  }
}

async function startV2Server() {
  const { attachCollabV2 } = require('../bin/collabV2/socketServer')
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  const attached = attachCollabV2(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port
  return { server, url, presence: attached && attached.presence }
}

async function joinClient(url, roomKey, userId) {
  const socket = connectClient(url)
  const events = []
  socket.on('op:event', op => events.push(op))
  await waitConnected(socket, userId)
  const joined = await emitAck(socket, 'join', {
    roomKey,
    clientId: userId,
    userId,
    name: userId,
    lastServerRevision: 0
  })
  return { socket, events, joined, userId, roomKey }
}

async function listAllOps(roomKey) {
  const { listRoomOperations } = require('../bin/storage')
  const all = []
  let after = 0
  for (;;) {
    const chunk = await listRoomOperations(roomKey, after, 1000)
    if (!chunk.length) break
    all.push(...chunk)
    after = Number(chunk[chunk.length - 1].version) || after
    if (chunk.length < 1000) break
  }
  return all
}

async function submitOp(client, type, payload) {
  const started = process.hrtime.bigint()
  const result = await emitAck(client.socket, 'op', {
    opId: randomUUID(),
    type,
    roomKey: client.roomKey,
    userId: client.userId,
    clientId: client.userId,
    payload
  })
  return {
    result,
    ms: Number(process.hrtime.bigint() - started) / 1e6
  }
}

module.exports = {
  wait,
  emitAck,
  connectClient,
  tryPg,
  seedPgRoom,
  startV2Server,
  joinClient,
  submitOp,
  graphHash,
  seedBushRows,
  listAllOps
}
