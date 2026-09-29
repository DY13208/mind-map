const { createMemoryStore } = require('../collabV2/directStore')
const { applyDirect, isDirectType } = require('../collabV2/directApplier')
const { applyMapReplace } = require('../collabV2/slowPath')
const { applyUndoOrRedo } = require('../collabV2/undoApply')
const { normalizeType } = require('../collabV2/protocol')
const { cloneJson } = require('./canonical')
const { historyError } = require('./errors')

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

function createHistoryLookup(rows, extra = {}) {
  const list = (rows || []).map(asReplayOp)
  const byId = new Map(
    list.map(item => [String(item.operation_id), item])
  )
  return {
    async getOperation(id) {
      const hit = byId.get(String(id))
      if (hit) return hit
      if (typeof extra.getOperation === 'function') {
        const row = await extra.getOperation(id)
        return row ? asReplayOp(row) : null
      }
      return null
    },
    async listAfter(version) {
      const local = list.filter(item => Number(item.version) > Number(version))
      if (typeof extra.listAfter !== 'function') return local
      const more = (await extra.listAfter(version)) || []
      const seen = new Set(local.map(item => String(item.operation_id)))
      more.forEach(row => {
        const op = asReplayOp(row)
        const key = String(op.operation_id)
        if (!seen.has(key)) {
          seen.add(key)
          local.push(op)
        }
      })
      local.sort((a, b) => Number(a.version) - Number(b.version))
      return local
    }
  }
}

function lookupBeforeVersion(lookup, cutoffVersion) {
  return {
    getOperation(id) {
      return lookup.getOperation(id)
    },
    async listAfter(version) {
      const rows = await lookup.listAfter(version)
      // During live submission the undo/redo operation has not been persisted
      // when its safety checks run. A historical replay already has the whole
      // range in memory, so hide the operation currently being replayed (and
      // future operations) to preserve that same point-in-time view.
      return (rows || []).filter(
        row => Number(row.version || row.serverRevision || 0) < cutoffVersion
      )
    }
  }
}

function assertContinuousOps(rows, fromRevision) {
  const ordered = (rows || [])
    .slice()
    .sort(
      (a, b) =>
        Number(a.version || a.serverRevision) -
        Number(b.version || b.serverRevision)
    )
  if (!ordered.length) return ordered
  let expected = Number(fromRevision) + 1
  for (const row of ordered) {
    const version = Number(row.version || row.serverRevision)
    if (version !== expected) {
      throw historyError(
        'HISTORY_OPS_GAP',
        `operation log gap at revision ${expected}, got ${version}`,
        409
      )
    }
    expected = version + 1
  }
  return ordered
}

async function replayOperation(store, row, lookup) {
  const op = asReplayOp(row)
  const version = Number(op.version || 0)
  const type = op.type
  if (type === 'map.replace') {
    const replaced = applyMapReplace(store.graph, op, { payload: op.payload })
    const next = createMemoryStore(replaced.nodes)
    next.setMeta(store.getMeta())
    return next
  }
  if (type === 'operation.undo' || type === 'operation.redo') {
    try {
      await applyUndoOrRedo(store, op, {
        version,
        lookup: lookupBeforeVersion(lookup, version),
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
    } catch (error) {
      throw historyError(
        'HISTORY_REPLAY_FAILED',
        'cannot replay undo/redo: ' + (error && error.message),
        409
      )
    }
  }
  if (isDirectType(type)) {
    await applyDirect(store, op, { version })
    return store
  }
  throw historyError(
    'HISTORY_REPLAY_UNSUPPORTED',
    'unsupported historical operation: ' + type,
    409
  )
}

async function replayOperations(baseTree, baseMeta, rows, options = {}) {
  let store = createMemoryStore(cloneJson(baseTree || {}))
  store.setMeta(cloneJson(baseMeta || {}))
  const ordered = options.requireContinuous
    ? assertContinuousOps(rows, options.fromRevision)
    : (rows || [])
        .slice()
        .sort(
          (a, b) =>
            Number(a.version || a.serverRevision) -
            Number(b.version || b.serverRevision)
        )
  const lookup = createHistoryLookup(ordered, options.lookup || {})
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
  replayOperations,
  assertContinuousOps
}
