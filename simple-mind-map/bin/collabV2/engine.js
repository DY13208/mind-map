const {
  normalizeOperation,
  isOpId,
  isWriteType,
  requireClientId,
  toCommand
} = require('./protocol')
const { applyDirect, isDirectType } = require('./directApplier')
const { createMemoryStore } = require('./directStore')
const { applyMapReplace, unsupportedOperation } = require('./slowPath')
const { applyUndoOrRedo, createMemoryLookup } = require('./undoApply')

const GAP_PAGE = 500
const SOFT_LOCK_MS = 15000

function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}))
}

function createEngine(options = {}) {
  const rooms = new Map()
  const connections = new Map()
  const gapPage = Number(options.gapPage || GAP_PAGE)

  function roomState(roomKey) {
    let room = rooms.get(roomKey)
    if (!room) {
      room = {
        roomKey,
        nodes: options.createEmpty
          ? options.createEmpty(roomKey)
          : {
              root: {
                isRoot: true,
                data: { uid: 'root', text: '未命名' },
                children: []
              }
            },
        revision: 0,
        ops: [],
        opsById: new Map(),
        snapshots: new Map(),
        presence: new Map(),
        locks: new Map(),
        store: null
      }
      rooms.set(roomKey, room)
    }
    if (!room.store) room.store = createMemoryStore(room.nodes)
    room.nodes = room.store.graph
    return room
  }

  function snapshotIfNeeded(room) {
    if (room.revision === 1 || room.revision % 10000 === 0) {
      room.snapshots.set(room.revision, clone(room.nodes))
    }
  }

  async function submit(raw, access = {}) {
    const op = normalizeOperation(raw)
    if (!op.roomKey) {
      const err = new Error('缺少 roomKey')
      err.code = 'BAD_REQUEST'
      err.statusCode = 400
      throw err
    }
    if (!isOpId(op.opId)) {
      const err = new Error('opId必须是UUID')
      err.code = 'BAD_OP_ID'
      err.statusCode = 400
      throw err
    }
    if (!isWriteType(op.type)) {
      throw unsupportedOperation(op.type, op.roomKey)
    }
    op.clientId = requireClientId(op.clientId)
    if (!access.canEdit) {
      const err = new Error('没有权限执行该操作')
      err.code = 'FORBIDDEN'
      err.statusCode = 403
      throw err
    }
    const room = roomState(op.roomKey)
    const existing = room.opsById.get(op.opId)
    if (existing) {
      return { duplicate: true, operation: existing }
    }
    const base = Number(op.baseRevision)
    if (Number.isFinite(base) && base > room.revision) {
      const err = new Error('baseVersion不能大于房间当前版本')
      err.code = 'VERSION_AHEAD'
      err.statusCode = 409
      err.currentVersion = room.revision
      err.details = {
        opId: op.opId,
        clientId: op.clientId,
        clientSeq: op.clientSeq,
        baseRevision: base,
        baseVersion: base,
        roomCurrentRevision: room.revision,
        currentVersion: room.revision
      }
      throw err
    }
    const command = toCommand(op)
    command.payload = { ...(command.payload || {}), clientSeq: op.clientSeq }
    const nextRev = room.revision + 1
    let event
    let result = {}
    try {
      if (op.type === 'map.replace') {
        const replaced = applyMapReplace(room.nodes, op, command)
        room.store = createMemoryStore(replaced.nodes)
        room.nodes = room.store.graph
        event = {
          ...replaced.event,
          version: nextRev,
          operationId: op.opId,
          actorId: op.userId
        }
        result = replaced.result || {}
        command.inversePayload = replaced.inversePayload
      } else if (op.type === 'operation.undo' || op.type === 'operation.redo') {
        const applied = await applyUndoOrRedo(room.store, op, {
          version: nextRev,
          lookup: createMemoryLookup(room),
          applyReplace: generated => {
            const replaced = applyMapReplace(room.nodes, generated, command)
            room.store = createMemoryStore(replaced.nodes)
            room.nodes = room.store.graph
            return replaced
          }
        })
        event = {
          ...(applied.event || { type: op.type, payload: op.payload }),
          version: nextRev,
          operationId: op.opId,
          actorId: op.userId,
          mapId: op.roomKey
        }
        result = applied.result || {}
        command.inversePayload = applied.inversePayload
        room.nodes = room.store.graph
      } else if (isDirectType(op.type)) {
        const applied = await applyDirect(room.store, op, { version: nextRev })
        event = {
          ...(applied.event || { type: op.type, payload: op.payload }),
          version: nextRev,
          operationId: op.opId,
          actorId: op.userId,
          mapId: op.roomKey
        }
        result = applied.result || {}
        command.inversePayload = applied.inversePayload
        room.nodes = room.store.graph
      } else {
        throw unsupportedOperation(op.type, op.roomKey)
      }
    } catch (err) {
      if (err && err.code === 'NODE_DELETED') err.code = 'TARGET_DELETED'
      throw err
    }
    const stored = {
      opId: op.opId,
      roomKey: op.roomKey,
      userId: op.userId,
      clientId: op.clientId,
      clientSeq: op.clientSeq,
      type: event.type || op.type,
      targetId: op.targetId,
      payload: command.payload,
      event,
      createdAt: op.createdAt,
      serverRevision: nextRev,
      version: nextRev,
      operationId: op.opId,
      actorId: op.userId,
      actor_id: op.userId,
      operation_id: op.opId,
      operation_type: op.type,
      inverse_payload: command.inversePayload || null,
      inversePayload: command.inversePayload || null
    }
    room.nodes = room.store ? room.store.graph : room.nodes
    room.revision = nextRev
    room.ops.push(stored)
    room.opsById.set(op.opId, stored)
    snapshotIfNeeded(room)
    return { duplicate: false, operation: stored, result, nodes: room.nodes }
  }

  function replaceNodes(roomKey, nodes) {
    const room = roomState(roomKey)
    room.store = createMemoryStore(nodes)
    room.nodes = room.store.graph
    return room
  }

  function opsAfter(roomKey, afterRevision, limit = 500) {
    const room = roomState(roomKey)
    const after = Number(afterRevision) || 0
    const page = Math.min(gapPage, Math.max(1, Number(limit) || gapPage))
    const operations = room.ops
      .filter(item => item.serverRevision > after)
      .slice(0, page)
    const last = operations.length
      ? Number(operations[operations.length - 1].serverRevision)
      : after
    return {
      reload: false,
      hasMore: last < room.revision,
      serverRevision: room.revision,
      snapshotRevision: room.snapshots.size
        ? Math.max.apply(null, Array.from(room.snapshots.keys()))
        : 0,
      operations
    }
  }

  function setPresence(roomKey, clientId, state) {
    const room = roomState(roomKey)
    const prev = room.presence.get(clientId) || {}
    const next = {
      ...prev,
      ...state,
      clientId,
      updatedAt: Date.now()
    }
    room.presence.set(clientId, next)
    if (next.editingUid) {
      const owner = room.locks.get(next.editingUid)
      if (!owner || owner.clientId === clientId || Date.now() - owner.at > SOFT_LOCK_MS) {
        room.locks.set(next.editingUid, {
          clientId,
          userId: next.userId,
          name: next.name,
          at: Date.now()
        })
      }
    } else if (prev.editingUid && room.locks.get(prev.editingUid) && room.locks.get(prev.editingUid).clientId === clientId) {
      room.locks.delete(prev.editingUid)
    }
    return listPresence(roomKey)
  }

  function listPresence(roomKey) {
    const room = rooms.get(roomKey)
    if (!room) return []
    const now = Date.now()
    room.locks.forEach((lock, uid) => {
      if (now - lock.at > SOFT_LOCK_MS) room.locks.delete(uid)
    })
    return Array.from(room.presence.values()).map(item => ({
      ...item,
      editingLockedBy: item.editingUid
        ? room.locks.get(item.editingUid) || null
        : null
    }))
  }

  function lockOwner(roomKey, nodeId) {
    const room = rooms.get(roomKey)
    if (!room || !nodeId) return null
    const lock = room.locks.get(nodeId)
    if (!lock) return null
    if (Date.now() - lock.at > SOFT_LOCK_MS) {
      room.locks.delete(nodeId)
      return null
    }
    return lock
  }

  function removeConnection(clientId, roomKey) {
    const room = rooms.get(roomKey)
    if (!room) return
    const prev = room.presence.get(clientId)
    room.presence.delete(clientId)
    if (prev && prev.editingUid) room.locks.delete(prev.editingUid)
    connections.delete(clientId)
  }

  function getRoom(roomKey) {
    return roomState(roomKey)
  }

  return {
    rooms,
    connections,
    submit,
    opsAfter,
    setPresence,
    listPresence,
    lockOwner,
    removeConnection,
    getRoom,
    replaceNodes,
    SOFT_LOCK_MS
  }
}

module.exports = { createEngine, GAP_PAGE, GAP_RELOAD_AFTER: GAP_PAGE, SOFT_LOCK_MS }
