const { createMemoryStore } = require('../collabV2/directStore')
const { applyDirect, isDirectType } = require('../collabV2/directApplier')
const { applyMapReplace } = require('../collabV2/slowPath')
const { applyUndoOrRedo } = require('../collabV2/undoApply')
const { normalizeType } = require('../collabV2/protocol')
const { cloneJson } = require('./canonical')
const { historyError } = require('./errors')
const { isDeepStrictEqual } = require('node:util')

function asReplayOp(row) {
  const type = normalizeType(row.operation_type || row.type)
  return {
    type,
    opId: row.operation_id || row.opId,
    roomKey: row.room_key || row.roomKey,
    userId: row.actor_id || row.userId,
    clientId: row.client_id || row.clientId,
    payload: objectValue(row.payload),
    version: Number(row.version || row.serverRevision || 0),
    operation_id: row.operation_id || row.opId,
    operation_type: type,
    inverse_payload: row.inverse_payload || row.inversePayload || null,
    event: objectValue(row.event)
  }
}

function objectValue(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
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

function replayFailureContext(row) {
  const op = asReplayOp(row)
  const payload = op.payload || {}
  const targetOperationId =
    payload.targetOperationId ||
    payload.target_operation_id ||
    payload.targetOpId ||
    ''
  return {
    roomKey: String(op.roomKey || ''),
    revision: Number(op.version || 0),
    operationId: String(op.operation_id || ''),
    operationType: String(op.type || ''),
    targetOperationId: String(targetOperationId)
  }
}

function eventPayloadOf(operation) {
  const event = objectValue(operation && operation.event)
  if (event.payload && typeof event.payload === 'object') {
    return objectValue(event.payload)
  }
  // fromCommitted() flattens the event payload onto the public operation while
  // retaining the event envelope. This fallback also supports older adapters
  // that return only the flattened batch payload.
  return objectValue(operation && operation.payload)
}

function replayEventDataPatch(liveData, eventPayload) {
  const current = objectValue(liveData)
  const snapshot = objectValue(eventPayload && eventPayload.data)
  const patch = {}
  if (eventPayload && eventPayload.data && typeof eventPayload.data === 'object' && !Array.isArray(eventPayload.data)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(snapshot)])
    for (const key of keys) {
      if (key === 'uid' || key === '__fv' || isDeepStrictEqual(current[key], snapshot[key])) continue
      patch[key] = snapshot[key] === undefined ? null : cloneJson(snapshot[key])
    }
    return patch
  }
  // Older sanitized events may carry only their text/note fields. These are
  // snapshots too, so turn only real differences into a patch.
  for (const key of ['text', 'note']) {
    if (Object.prototype.hasOwnProperty.call(eventPayload || {}, key) &&
      !isDeepStrictEqual(current[key], eventPayload[key])) {
      patch[key] = eventPayload[key] === undefined ? null : cloneJson(eventPayload[key])
    }
  }
  return patch
}

async function avoidReplaySnapshotRestamping(store, operation) {
  const event = objectValue(operation && operation.event)
  const eventType = normalizeType(event.type)
  if (!['node.updated', 'node.moved', 'node.reordered'].includes(eventType)) return
  const eventPayload = objectValue(event.payload)
  if (Object.prototype.hasOwnProperty.call(eventPayload, 'patch')) return
  const uid = cleanUid(operation.payload && operation.payload.uid || eventPayload.uid)
  if (!uid || !eventPayload.data && !Object.prototype.hasOwnProperty.call(eventPayload, 'text') &&
    !Object.prototype.hasOwnProperty.call(eventPayload, 'note')) return
  const live = await store.getLive(uid)
  if (!live) return
  operation.payload = { ...operation.payload, patch: replayEventDataPatch(live.data, eventPayload) }
  delete operation.payload.data
  delete operation.payload.text
  delete operation.payload.note
}

function cleanUid(value) {
  return value == null ? '' : String(value).trim()
}

function insertedUidForReplay(row, operation, itemIndex = null) {
  const payload = objectValue(operation && operation.payload)
  const savedResult = objectValue(payload.__mcpResult)
  if (itemIndex != null && Array.isArray(savedResult.items)) {
    const item = savedResult.items.find(
      candidate => Number(candidate && candidate.index) === Number(itemIndex)
    )
    const uid = item && item.status === 'applied' && item.result && item.result.uid
    if (uid != null && cleanUid(uid)) return cleanUid(uid)
  }
  if (itemIndex == null && savedResult.uid != null && cleanUid(savedResult.uid)) {
    return cleanUid(savedResult.uid)
  }
  const event = objectValue(operation && operation.event || row && row.event)
  const eventPayload = objectValue(event.payload)
  const eventUid = eventPayload.uid || objectValue(eventPayload.data).uid
  if (eventUid != null && cleanUid(eventUid)) return cleanUid(eventUid)
  // A public sanitized node.inserted operation may not retain the event
  // envelope; its flattened payload is still canonical.
  const flatPayload = objectValue(operation && operation.payload)
  const flatUid = flatPayload.uid || objectValue(flatPayload.data).uid
  return cleanUid(flatUid)
}

function replayFailure(row, message, extra = {}) {
  return historyError(
    'HISTORY_REPLAY_FAILED',
    message,
    409,
    { details: { ...replayFailureContext(row), ...extra } }
  )
}

function canonicalInsertUid(row, operation, payload, itemIndex = null) {
  const resultUid = insertedUidForReplay(row, operation, itemIndex)
  const inputUid = cleanUid(payload.uid || objectValue(payload.data).uid)
  if (inputUid && resultUid && inputUid !== resultUid) {
    throw replayFailure(row, 'historical node.insert has conflicting canonical UIDs', {
      itemIndex,
      inputUid,
      resultUid
    })
  }
  const uid = resultUid || inputUid
  if (!uid) {
    throw replayFailure(row, 'historical node.insert is missing its canonical UID', {
      itemIndex
    })
  }
  return uid
}

const EVENT_OPERATION_TYPES = Object.freeze({
  'node.inserted': 'node.insert',
  'node.updated': 'node.update',
  'node.moved': 'node.move',
  'node.reordered': 'node.reorder',
  'node.deleted': 'node.delete',
  'node.restored': 'node.restore',
  'map.updated': 'map.meta.update',
  'operation.undone': 'operation.undo',
  'operation.redone': 'operation.redo'
})

function normalizeReplayRequest(child, row, index = null) {
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw replayFailure(row, 'historical batch contains an invalid operation', {
      itemIndex: index
    })
  }
  const type = normalizeType(child.type || child.operation_type || child.operationType)
  const sourcePayload = child.payload && typeof child.payload === 'object' && !Array.isArray(child.payload)
    ? { ...child.payload }
    : Object.fromEntries(
        Object.entries(child).filter(([key]) => ![
          'type', 'operation_type', 'operationType', 'depends_on'
        ].includes(key))
      )
  if (type === 'node.insert') {
    sourcePayload.uid = canonicalInsertUid(row, { ...asReplayOp(row), payload: objectValue(row && row.payload) }, sourcePayload, index)
    if (sourcePayload.data && typeof sourcePayload.data === 'object') {
      sourcePayload.data = { ...sourcePayload.data, uid: sourcePayload.uid }
    }
  }
  return { type, payload: sourcePayload }
}

function operationFromCommittedEvent(event, row, index = null) {
  const item = objectValue(event)
  const eventType = normalizeType(item.type)
  const type = EVENT_OPERATION_TYPES[eventType]
  if (!type) {
    throw replayFailure(row, 'historical batch contains an unsupported committed event: ' + eventType, {
      itemIndex: index,
      eventType
    })
  }
  const payload = cloneJson(objectValue(item.payload))
  if (type === 'node.insert') {
    payload.uid = canonicalInsertUid(row, asReplayOp(row), payload, null)
    if (payload.data && typeof payload.data === 'object') {
      payload.data = { ...payload.data, uid: payload.uid }
    }
  }
  if (['node.update', 'node.move', 'node.reorder', 'node.delete'].includes(type) && !cleanUid(payload.uid)) {
    throw replayFailure(row, 'historical committed event is missing its target UID', {
      itemIndex: index,
      eventType
    })
  }
  // This command is constructed only from the durable event of an operation
  // that already committed successfully. The event is the proof that any SOP
  // confirmation guard was satisfied at submission time; its canonical form
  // intentionally omits the request-only confirmation flag. Keep this
  // internal authorization confined to trusted history reconstruction.
  if (['node.insert', 'node.update', 'node.move', 'node.reorder', 'node.delete', 'node.restore'].includes(type)) {
    payload.confirm_sop_change = true
  }
  return {
    type,
    payload,
    // Preserve the durable event separately from the command payload. During
    // batch reconstruction this lets us derive snapshot deltas immediately
    // before each child is applied, against the state produced by prior
    // children in the same committed batch.
    event: { type: item.type, payload: cloneJson(item.payload || {}) }
  }
}

function committedEventOperations(events, row, out = []) {
  for (let index = 0; index < events.length; index += 1) {
    const event = objectValue(events[index])
    if (normalizeType(event.type) === 'batch.applied') {
      const nested = objectValue(event.payload).events
      if (!Array.isArray(nested)) {
        throw replayFailure(row, 'historical nested batch is missing committed events', {
          itemIndex: index
        })
      }
      committedEventOperations(nested, row, out)
    } else {
      out.push(operationFromCommittedEvent(event, row, index))
    }
  }
  return out
}

function replayableOperation(row) {
  const op = asReplayOp(row)
  const payload = objectValue(op.payload)
  if (op.type === 'node.insert') {
    const insertPayload = { ...payload }
    insertPayload.uid = canonicalInsertUid(row, op, insertPayload)
    if (insertPayload.data && typeof insertPayload.data === 'object') {
      insertPayload.data = { ...insertPayload.data, uid: insertPayload.uid }
    }
    return { ...op, payload: insertPayload }
  }

  const eventEnvelope = op.event && op.event.type ? objectValue(op.event) : { type: op.type, payload }
  const eventOperationType = EVENT_OPERATION_TYPES[normalizeType(eventEnvelope.type)]
  const declaredOperationType = EVENT_OPERATION_TYPES[op.type] || op.type
  if (
    eventOperationType &&
    eventOperationType === declaredOperationType &&
    !['operation.undo', 'operation.redo'].includes(eventOperationType)
  ) {
    const canonical = operationFromCommittedEvent(eventEnvelope, row)
    return { ...op, ...canonical }
  }

  if (op.type !== 'node.batch' && op.type !== 'batch.applied') return op

  const sourceChildren = Array.isArray(payload.ops) ? payload.ops : []
  const savedResult = objectValue(payload.__mcpResult)
  const resultItems = Array.isArray(savedResult.items) ? savedResult.items : null
  const eventPayload = eventPayloadOf(op)
  const event = objectValue(op.event)
  const events = Array.isArray(eventPayload.events) ? eventPayload.events : null
  let children

  if (events && events.length) {
    const appliedCount = resultItems
      ? resultItems.filter(item => item && item.status === 'applied').length
      : null
    if (appliedCount != null && appliedCount !== events.length) {
      throw replayFailure(row, 'historical batch result does not match its committed events', {
        appliedCount,
        eventCount: events.length
      })
    }
    children = committedEventOperations(events, row)
  } else if (events && Number(eventPayload.count) === 0) {
    children = []
  } else if (resultItems) {
    const appliedItems = resultItems.filter(item => item && item.status === 'applied')
    const byIndex = new Map()
    for (const item of appliedItems) {
      const index = Number(item.index)
      if (!Number.isInteger(index) || index < 0 || index >= sourceChildren.length || byIndex.has(index)) {
        throw replayFailure(row, 'historical batch result contains an invalid applied item index', {
          itemIndex: item.index
        })
      }
      byIndex.set(index, item)
    }
    children = Array.from(byIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([index]) => normalizeReplayRequest(sourceChildren[index], row, index))
  } else if (events) {
    // A persisted batch event is the success record. An empty events array
    // means no child mutation was committed, unless its count says that
    // committed events were lost from the history row.
    const declaredCount = Number(eventPayload.count)
    if (Number.isFinite(declaredCount) && declaredCount > 0) {
      throw replayFailure(row, 'historical batch is missing its committed child events', {
        declaredCount
      })
    }
    children = []
  } else if (event.type === 'batch.applied') {
    const declaredCount = Number(eventPayload.count)
    if (Number.isFinite(declaredCount) && declaredCount > 0) {
      throw replayFailure(row, 'historical batch is missing its committed child events', {
        declaredCount
      })
    }
    children = []
  } else {
    // Legacy all-or-nothing batches predate child event persistence. Their
    // presence in the committed operation log means the whole transaction
    // succeeded, so replay the complete request for those rows only.
    children = sourceChildren.map((child, index) => normalizeReplayRequest(child, row, index))
  }

  const replayPayload = { ...payload, ops: children }
  delete replayPayload.__mcpRequest
  delete replayPayload.__mcpResult
  delete replayPayload.requestDigest
  return { ...op, type: 'node.batch', payload: replayPayload }
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
        409,
        {
          details: {
            revision: version,
            expectedRevision: expected,
            operationId: String(row.operation_id || row.opId || ''),
            operationType: String(row.operation_type || row.type || '')
          }
        }
      )
    }
    expected = version + 1
  }
  return ordered
}

async function replayOperation(store, row, lookup) {
  const op = replayableOperation(row)
  await avoidReplaySnapshotRestamping(store, op)
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
        409,
        { cause: error, details: replayFailureContext(row) }
      )
    }
  }
  if (type === 'node.batch') {
    // History is a sequence of durable child events, not a new batch request.
    // Apply one child at a time so snapshot-to-patch conversion observes the
    // state left by the previous child, including repeated edits to one UID.
    for (const child of Array.isArray(op.payload && op.payload.ops) ? op.payload.ops : []) {
      await replayHistoricalChild(store, child, version)
    }
    return store
  }
  if (isDirectType(type)) {
    // Durable historical events predate public CAS tokens. This caller reads
    // committed operation rows from the history store, so replay uses its
    // existing internal ordering/conflict logic without requiring new-client
    // preconditions from persisted payloads.
    await applyDirect(store, op, { version, skipWritePreconditions: true })
    return store
  }
  throw historyError(
    'HISTORY_REPLAY_UNSUPPORTED',
    'unsupported historical operation: ' + type,
    409
  )
}

async function replayHistoricalChild(store, operation, version) {
  const type = normalizeType(operation && operation.type)
  if (type === 'node.batch') {
    for (const child of Array.isArray(operation.payload && operation.payload.ops) ? operation.payload.ops : []) {
      await replayHistoricalChild(store, child, version)
    }
    return
  }
  if (!isDirectType(type)) {
    const err = new Error('unsupported historical batch child operation: ' + type)
    err.code = 'HISTORY_REPLAY_UNSUPPORTED'
    throw err
  }
  await avoidReplaySnapshotRestamping(store, operation)
  await applyDirect(store, operation, {
    version,
    preserveBatchOrder: true,
    skipWritePreconditions: true
  })
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
    try {
      store = await replayOperation(store, row, lookup)
    } catch (error) {
      if (error && /^HISTORY_/.test(String(error.code || ''))) throw error
      throw historyError(
        'HISTORY_REPLAY_FAILED',
        'historical reconstruction failed',
        409,
        { cause: error, details: replayFailureContext(row) }
      )
    }
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
