const assert = require('assert')
const { randomUUID } = require('crypto')
const { createOutbox } = require('../bin/collabV2/outbox')
const { createCollaborationAdapter } = require('../bin/collabV2/adapter')
const { tryPg, seedPgRoom, startV2Server, wait, graphHash } = require('./collabV2.pgHarness')

function createFakeIndexedDB() {
  const stores = new Map()
  function later(fn) {
    setTimeout(fn, 0)
  }
  function objectStore() {
    return {
      put(row) {
        stores.set(row.opId, row)
        const req = { result: row, onsuccess: null, onerror: null }
        later(() => req.onsuccess && req.onsuccess())
        return req
      },
      get(opId) {
        const req = { result: stores.get(opId) || undefined, onsuccess: null, onerror: null }
        later(() => req.onsuccess && req.onsuccess())
        return req
      },
      delete(opId) {
        stores.delete(opId)
        const req = { onsuccess: null, onerror: null }
        later(() => req.onsuccess && req.onsuccess())
        return req
      },
      getAll() {
        const req = { result: Array.from(stores.values()), onsuccess: null, onerror: null }
        later(() => req.onsuccess && req.onsuccess())
        return req
      }
    }
  }
  return {
    open() {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      later(() => {
        req.result = {
          objectStoreNames: { contains: name => name === 'outbox' },
          transaction() {
            const store = objectStore()
            const t = {
              objectStore() {
                return store
              },
              oncomplete: null,
              onerror: null
            }
            later(() => t.oncomplete && t.oncomplete())
            return t
          }
        }
        if (req.onupgradeneeded) req.onupgradeneeded()
        if (req.onsuccess) req.onsuccess()
      })
      return req
    }
  }
}

function connectSocket(url) {
  const { io } = require('socket.io-client')
  const socket = io(url, {
    path: '/collab-v2',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 8000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('connect_error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main() {
  const api = await tryPg()
  if (api.error) {
    console.log('skip collabV2 idb: PostgreSQL unavailable', api.error.message)
    return
  }
  const roomKey = 'pg-idb-' + Date.now()
  await seedPgRoom(api, roomKey, 6)
  const { server, url } = await startV2Server()
  const indexedDB = createFakeIndexedDB()
  const clientId = randomUUID()
  const sockets = []
  try {
    const socketA = await connectSocket(url)
    sockets.push(socketA)
    const adapterA = createCollaborationAdapter({
      clientId,
      indexedDB,
      socket: socketA,
      timeoutMs: 8000
    })
    await adapterA.connect({ url, roomKey, userId: 'A' })
    socketA.disconnect()
    await wait(30)

    const outbox = createOutbox({ indexedDB })
    await outbox.put({
      opId: randomUUID(),
      type: 'node.update',
      roomKey,
      userId: 'A',
      clientId,
      payload: { uid: 'n0', text: 'offline-idb' },
      status: 'pending',
      clientSeq: 1
    })
    assert.ok((await outbox.list(clientId, roomKey)).length >= 1)

    const socketResume = await connectSocket(url)
    sockets.push(socketResume)
    const adapterResume = createCollaborationAdapter({
      clientId,
      indexedDB,
      socket: socketResume,
      timeoutMs: 8000
    })
    await adapterResume.connect({ url, roomKey, userId: 'A' })
    await adapterResume.retryPending()
    await wait(120)
    const left = await createOutbox({ indexedDB }).list(clientId, roomKey)
    assert.strictEqual(left.length, 0, 'IndexedDB pending should drain after ACK')
    const table = await api.readRoomNodes(roomKey)
    const nodes = table.nodes || table
    assert.strictEqual(nodes.n0.data.text, 'offline-idb')
    console.log('collabV2 IndexedDB offline refresh ok', {
      roomKey,
      hash: graphHash(nodes).hash
    })
  } finally {
    sockets.forEach(socket => {
      try {
        socket.close()
      } catch (err) {}
    })
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
