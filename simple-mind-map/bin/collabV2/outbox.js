const { assertStructuredCloneSafeOperation } = require('./../collabSpecialObjects')

const DB_NAME = 'mind-map-collab-v2'
const STORE = 'outbox'
const VERSION = 1

function memoryOutbox() {
  const rows = new Map()
  return {
    driver: 'memory',
    async put(op) {
      assertStructuredCloneSafeOperation(op)
      rows.set(op.opId, { ...op, status: op.status || 'pending' })
      return op
    },
    async get(opId) {
      return rows.get(opId) || null
    },
    async remove(opId) {
      rows.delete(opId)
    },
    async list(clientId, roomKey) {
      return Array.from(rows.values())
        .filter(item => {
          if (clientId && item.clientId !== clientId) return false
          if (roomKey && item.roomKey !== roomKey) return false
          return item.status !== 'acknowledged'
        })
        .sort((a, b) => (a.clientSeq || 0) - (b.clientSeq || 0))
    },
    async update(opId, patch) {
      const cur = rows.get(opId)
      if (!cur) return null
      const next = { ...cur, ...patch }
      rows.set(opId, next)
      return next
    },
    async clear(clientId) {
      Array.from(rows.keys()).forEach(id => {
        const item = rows.get(id)
        if (!clientId || item.clientId === clientId) rows.delete(id)
      })
    }
  }
}

function openIdb(indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'opId' })
        store.createIndex('clientRoom', ['clientId', 'roomKey'], { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbOutbox(indexedDB) {
  let dbPromise = null
  function db() {
    if (!dbPromise) dbPromise = openIdb(indexedDB)
    return dbPromise
  }
  function tx(mode, fn) {
    return db().then(
      database =>
        new Promise((resolve, reject) => {
          const t = database.transaction(STORE, mode)
          const store = t.objectStore(STORE)
          const result = fn(store)
          t.oncomplete = () => resolve(result)
          t.onerror = () => reject(t.error)
        })
    )
  }
  return {
    driver: 'indexeddb',
    async put(op) {
      assertStructuredCloneSafeOperation(op)
      const row = { ...op, status: op.status || 'pending' }
      await tx('readwrite', store => store.put(row))
      return row
    },
    async get(opId) {
      const database = await db()
      return new Promise((resolve, reject) => {
        const t = database.transaction(STORE, 'readonly')
        const req = t.objectStore(STORE).get(opId)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    },
    async remove(opId) {
      await tx('readwrite', store => store.delete(opId))
    },
    async list(clientId, roomKey) {
      const database = await db()
      return new Promise((resolve, reject) => {
        const t = database.transaction(STORE, 'readonly')
        const req = t.objectStore(STORE).getAll()
        req.onsuccess = () => {
          const rows = (req.result || [])
            .filter(item => {
              if (clientId && item.clientId !== clientId) return false
              if (roomKey && item.roomKey !== roomKey) return false
              return item.status !== 'acknowledged'
            })
            .sort((a, b) => (a.clientSeq || 0) - (b.clientSeq || 0))
          resolve(rows)
        }
        req.onerror = () => reject(req.error)
      })
    },
    async update(opId, patch) {
      const database = await db()
      return new Promise((resolve, reject) => {
        const t = database.transaction(STORE, 'readwrite')
        const store = t.objectStore(STORE)
        const req = store.get(opId)
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) {
            resolve(null)
            return
          }
          const next = { ...cur, ...patch }
          store.put(next)
          resolve(next)
        }
        req.onerror = () => reject(req.error)
      })
    },
    async clear(clientId) {
      const rows = await this.list(clientId)
      await Promise.all(rows.map(item => this.remove(item.opId)))
    }
  }
}

function createOutbox(options = {}) {
  if (options.driver === 'memory' || options.memory) return memoryOutbox()
  const indexedDB =
    options.indexedDB ||
    (typeof window !== 'undefined' && (window.indexedDB || window.webkitIndexedDB))
  if (!indexedDB) return memoryOutbox()
  try {
    return idbOutbox(indexedDB)
  } catch (err) {
    return memoryOutbox()
  }
}

module.exports = { createOutbox, memoryOutbox }
