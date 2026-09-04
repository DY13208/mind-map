const { cloneJson } = require('../collabHistory/canonical')
const { canonicalizeNodes, validateNodeGraph } = require('../roomNodes')
const { DEFAULT_METADATA, newFolderId, normalizeTitle } = require('./model')

function nowIso() {
  return new Date().toISOString()
}

function createMemoryFileStore(seed = {}) {
  const rooms = new Map()
  const folders = new Map()
  const members = []
  const nodes = new Map()
  const operations = []
  const tombstones = new Set()
  let queryCount = 0

  function bump() {
    queryCount += 1
  }

  if (seed.rooms) {
    seed.rooms.forEach(room => {
      rooms.set(room.room_key, cloneJson(room))
      if (room.nodes) nodes.set(room.room_key, cloneJson(room.nodes))
    })
  }
  if (seed.members) members.push(...seed.members.map(cloneJson))
  if (seed.folders) {
    seed.folders.forEach(folder => folders.set(folder.id, cloneJson(folder)))
  }

  return {
    kind: 'memory',
    get queryCount() {
      return queryCount
    },
    resetQueryCount() {
      queryCount = 0
    },
    rooms,
    folders,
    members,
    nodes,
    operations,
    tombstones,
    async withTx(fn) {
      bump()
      const snap = {
        rooms: cloneJson([...rooms.entries()]),
        folders: cloneJson([...folders.entries()]),
        members: cloneJson(members),
        nodes: cloneJson([...nodes.entries()]),
        operations: cloneJson(operations)
      }
      try {
        return await fn()
      } catch (err) {
        rooms.clear()
        snap.rooms.forEach(([key, value]) => rooms.set(key, value))
        folders.clear()
        snap.folders.forEach(([key, value]) => folders.set(key, value))
        members.splice(0, members.length, ...snap.members)
        nodes.clear()
        snap.nodes.forEach(([key, value]) => nodes.set(key, value))
        operations.splice(0, operations.length, ...snap.operations)
        throw err
      }
    },
    async isDeleted(roomKey) {
      bump()
      return tombstones.has(String(roomKey || ''))
    },
    async getRoom(roomKey) {
      bump()
      const row = rooms.get(String(roomKey || ''))
      return row ? cloneJson(row) : null
    },
    async getNodes(roomKey) {
      bump()
      return cloneJson(nodes.get(String(roomKey || '')) || {})
    },
    async operationCount(roomKey) {
      bump()
      return operations.filter(op => op.room_key === roomKey).length
    },
    async insertRoom(row) {
      bump()
      const key = row.room_key
      if (rooms.has(key)) {
        const err = new Error('room exists')
        err.code = 'ROOM_ALREADY_EXISTS'
        err.statusCode = 409
        throw err
      }
      const next = {
        room_key: key,
        title: normalizeTitle(row.title),
        cos_key: row.cos_key || key + '.yjs',
        nodes: row.nodes || null,
        version: Number(row.version || 0),
        metadata: row.metadata || { ...DEFAULT_METADATA },
        folder_id: row.folder_id || null,
        owner_id: row.owner_id || '',
        created_at: row.created_at || nowIso(),
        updated_at: row.updated_at || nowIso(),
        content_updated_at: row.content_updated_at || nowIso()
      }
      rooms.set(key, next)
      return cloneJson(next)
    },
    async writeNodes(roomKey, graph) {
      bump()
      const canonical = canonicalizeNodes(graph || {})
      const tree = canonical.ok ? canonical.nodes : graph
      const check = validateNodeGraph(tree)
      if (!check.ok) {
        const err = new Error('invalid root tree')
        err.code = 'INVALID_HISTORY_TREE'
        err.statusCode = 400
        throw err
      }
      nodes.set(roomKey, cloneJson(tree))
      const room = rooms.get(roomKey)
      if (room) room.nodes = cloneJson(tree)
      return tree
    },
    async insertMember(row) {
      bump()
      members.push({
        room_key: row.room_key,
        user_id: row.user_id,
        role: row.role,
        created_at: nowIso(),
        updated_at: nowIso()
      })
      return row
    },
    async listMembersForRooms(roomKeys) {
      bump()
      const set = new Set(roomKeys)
      return members.filter(item => set.has(item.room_key)).map(cloneJson)
    },
    async listRooms(filter) {
      bump()
      return [...rooms.values()]
        .filter(row => !tombstones.has(row.room_key))
        .filter(row => {
          if (filter.folderId === undefined) return true
          if (filter.folderId === null) return !row.folder_id
          return row.folder_id === filter.folderId
        })
        .filter(row => {
          if (!filter.q) return true
          return String(row.title || '').toLowerCase().includes(String(filter.q).toLowerCase())
        })
        .map(cloneJson)
    },
    async updateTitle(roomKey, title) {
      bump()
      const row = rooms.get(roomKey)
      if (!row) return null
      row.title = normalizeTitle(title)
      row.updated_at = nowIso()
      return cloneJson(row)
    },
    async updateFolder(roomKey, folderId) {
      bump()
      const row = rooms.get(roomKey)
      if (!row) return null
      const version = row.version
      const nodeSnap = cloneJson(nodes.get(roomKey) || {})
      row.folder_id = folderId
      row.updated_at = nowIso()
      return {
        row: cloneJson(row),
        version,
        nodes: nodeSnap
      }
    },
    async getFolder(id) {
      bump()
      const row = folders.get(String(id || ''))
      if (!row || row.deleted_at) return null
      return cloneJson(row)
    },
    async folderNameTaken(name, parentId, exceptId) {
      bump()
      const needle = String(name || '').trim().toLowerCase()
      return [...folders.values()].some(
        item =>
          !item.deleted_at &&
          item.id !== exceptId &&
          (item.parent_id || null) === (parentId || null) &&
          String(item.name).trim().toLowerCase() === needle
      )
    },
    async insertFolder(row) {
      bump()
      const next = {
        id: row.id || newFolderId(),
        parent_id: row.parent_id || null,
        name: row.name,
        created_by: row.created_by || '',
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null
      }
      folders.set(next.id, next)
      return cloneJson(next)
    },
    async listFolders() {
      bump()
      return [...folders.values()].filter(item => !item.deleted_at).map(cloneJson)
    },
    async updateFolderName(id, name) {
      bump()
      const row = folders.get(id)
      if (!row || row.deleted_at) return null
      row.name = name
      row.updated_at = nowIso()
      return cloneJson(row)
    },
    async countRoomsInFolder(id) {
      bump()
      return [...rooms.values()].filter(
        row => row.folder_id === id && !tombstones.has(row.room_key)
      ).length
    },
    async deleteFolder(id) {
      bump()
      folders.delete(id)
      return true
    },
    async roomCountsByFolder() {
      bump()
      const counts = {}
      rooms.forEach(row => {
        if (!row.folder_id || tombstones.has(row.room_key)) return
        counts[row.folder_id] = (counts[row.folder_id] || 0) + 1
      })
      return counts
    }
  }
}

module.exports = { createMemoryFileStore }
