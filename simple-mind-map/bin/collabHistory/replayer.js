const { createMemoryStore } = require('../collabV2/directStore')
const { applyDirect, isDirectType } = require('../collabV2/directApplier')
const { applyMapReplace } = require('../collabV2/slowPath')
const { applyUndoOrRedo } = require('../collabV2/undoApply')
const { normalizeType } = require('../collabV2/protocol')
const { cloneJson } = require('./canonical')

function asReplayOp(row) {
  const type = normalizeType(row.operation_type || row.type)
  return {
    type,
    opId: row.operation_id || row.opId,
    roomKey: row.room_key || row.roomKey,
    userId: row.actor_id || row.userId,
    clientId: row.client_id || row.clientId,
    payload: row.payload || {},
    version: Number(row.version || row.serverRevision || 0),
    operation_id: row.operation_id || row.opId,
    operation_type: type,
    inverse_payload: row.inverse_payload || row.inversePayload || null
  }
}

function createHistoryLookup(rows) {
  const list = (rows || []).map(asReplayOp)
  return {
    async getOperation(id) {
      return list.find(item => String(item.operation_id) === String(id)) || null
    },
    async listAfter(version) {
      return list.filter(item => Number(item.version) > Number(version))
    }
  }
}

async function replayOperation(store, row, lookup) {
  const op = asReplayOp(row)
  const version = Number(op.version || 0)
  if (op.type === 'map.replace') {
    const replaced = applyMapReplace(store.graph, op, { payload: op.payload })
    const next = createMemoryStore(replaced.nodes)
    next.setMeta(store.getMeta())
    return next
  }
  if (op.type === 'operation.undo' || op.type === 'operation.redo') {
    await applyUndoOrRedo(store, op, {
      version,
      lookup,
      applyReplace: generated => {
        const replaced = applyMapReplace(store.graph, generated, {
          payload: generated.payload
        })
        const fresh = createMemoryStore(replaced.nodes)
        fresh.setMeta(store.getMeta())
        Object.keys(store.graph).forEach(key => delete store.graph[key])
        Object.assign(store.graph, fresh.graph)
        return replaced
      }
    })
    return store
  }
  if (isDirectType(op.type)) {
    await applyDirect(store, op, { version })
    return store
  }
  return store
}

async function replayOperations(baseTree, baseMeta, rows) {
  let store = createMemoryStore(cloneJson(baseTree || {}))
  store.setMeta(cloneJson(baseMeta || {}))
  const lookup = createHistoryLookup(rows)
  const ordered = (rows || [])
    .slice()
    .sort((a, b) => Number(a.version || a.serverRevision) - Number(b.version || b.serverRevision))
  for (const row of ordered) {
    store = await replayOperation(store, row, lookup)
  }
  return {
    tree: cloneJson(store.graph),
    metadata: cloneJson(store.getMeta())
  }
}

module.exports = {
  asReplayOp,
  createHistoryLookup,
  replayOperation,
  replayOperations
}
