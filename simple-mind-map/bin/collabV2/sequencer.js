const roomAcl = require('../roomAcl')
const {
  commitRoomOperation,
  commitDirectRoomOperation,
  getPool,
  listRoomOperations,
  getRoomVersion,
  safeRoomKey
} = require('../storage')
const {
  isOpId,
  requireClientId,
  normalizeOperation,
  toCommand,
  fromCommitted,
  isWriteType
} = require('./protocol')
const { applyDirect, isDirectType } = require('./directApplier')
const { createPgStore } = require('./directStore')
const { applyMapReplace, isSlowPathType, unsupportedOperation } = require('./slowPath')
const { applyUndoOrRedo, createPgLookup, evaluateRedo } = require('./undoApply')
const { collabTrace } = require('./trace')

async function peekReplaceUndo(roomKey, op) {
  if (op.type !== 'operation.undo' && op.type !== 'operation.redo') return false
  const lookup = createPgLookup(getPool(), roomKey)
  const targetId = op.payload && (op.payload.targetOperationId || op.payload.target_operation_id)
  const target = await lookup.getOperation(targetId)
  if (!target) return false
  if (op.type === 'operation.undo') {
    const inv = target.inverse_payload || target.inversePayload
    return !!(inv && inv.type === 'map.replace')
  }
  const later = await lookup.listAfter(Number(target.version || 0))
  const verdict = evaluateRedo(target, later, op.userId)
  const source = (verdict.ok && verdict.undoOp && (verdict.undoOp.inverse_payload || verdict.undoOp.inversePayload)) || {
    type: target.operation_type || target.operationType
  }
  return !!(source && source.type === 'map.replace')
}

async function submitOperation(req, raw) {
  const op = normalizeOperation(raw)
  op.roomKey = safeRoomKey(op.roomKey)
  const traceId = op.traceId || (op.payload && op.payload.traceId) || ''
  collabTrace('5.server.recv', {
    traceId,
    opId: op.opId,
    roomKey: op.roomKey,
    userId: op.userId,
    clientId: op.clientId,
    type: op.type
  })
  if (!op.roomKey) {
    const err = new Error('缺少 roomKey')
    err.statusCode = 400
    err.code = 'BAD_REQUEST'
    throw err
  }
  if (!isOpId(op.opId)) {
    const err = new Error('opId必须是UUID')
    err.statusCode = 400
    err.code = 'BAD_OP_ID'
    throw err
  }
  if (!isWriteType(op.type)) {
    throw unsupportedOperation(op.type, op.roomKey)
  }
  op.clientId = requireClientId(op.clientId)
  const access = await roomAcl.assertRoomAccess(
    getPool(),
    req,
    op.roomKey,
    'edit'
  )
  op.userId = access.userId || op.userId
  collabTrace('5.acl', {
    traceId,
    opId: op.opId,
    roomKey: op.roomKey,
    userId: op.userId,
    role: access.role,
    canEdit: !!access.canEdit
  })
  const command = toCommand(op)
  command.payload = {
    ...(command.payload || {}),
    clientSeq: op.clientSeq,
    baseRevision: op.baseRevision
  }
  let committed
  try {
    if (isSlowPathType(op.type) || (await peekReplaceUndo(op.roomKey, op))) {
      committed = await commitRoomOperation(
        op.roomKey,
        command,
        async ({ room, currentVersion, client }) => {
          if (op.type === 'operation.undo' || op.type === 'operation.redo') {
            const store = createPgStore(client, op.roomKey)
            return applyUndoOrRedo(store, op, {
              version: currentVersion + 1,
              lookup: createPgLookup(client, op.roomKey),
              applyReplace: generated => applyMapReplace(room.nodes || {}, generated, command)
            })
          }
          return applyMapReplace(room.nodes || {}, op, command)
        }
      )
    } else if (isDirectType(op.type) || op.type === 'operation.undo' || op.type === 'operation.redo') {
      committed = await commitDirectRoomOperation(
        op.roomKey,
        command,
        async ({ client, currentVersion, room }) => {
          const store = createPgStore(client, op.roomKey)
          if (store.setMeta) store.setMeta((room && room.metadata) || {})
          const version = currentVersion + 1
          const applied =
            op.type === 'operation.undo' || op.type === 'operation.redo'
              ? await applyUndoOrRedo(store, op, {
                  version,
                  lookup: createPgLookup(client, op.roomKey)
                })
              : await applyDirect(store, op, { version })
          return {
            ...applied,
            queryStats: store.stats
          }
        }
      )
    } else {
      throw unsupportedOperation(op.type, op.roomKey)
    }
  } catch (err) {
    if (err && err.code === 'NODE_DELETED') err.code = 'TARGET_DELETED'
    throw err
  }
  const queryStats = committed.queryStats || null
  const committedOp = committed.operation || {}
  const serverRevision = Number(
    committedOp.version || committedOp.serverRevision || 0
  )
  collabTrace('6.applier', {
    traceId,
    opId: op.opId,
    type: op.type,
    targetUid: op.targetId || (op.payload && op.payload.uid),
    queries: queryStats && queryStats.queries,
    writes: queryStats && queryStats.writes
  })
  collabTrace('7.pg.commit', {
    traceId,
    opId: op.opId,
    serverRevision,
    affectedRows: queryStats && queryStats.writes,
    duplicate: !!committed.duplicate,
    commitSuccess: true
  })
  if (queryStats && process.env.COLLAB_QUERY_STATS) {
    console.log('[COLLAB_QUERY_STATS]', {
      room: op.roomKey,
      type: op.type,
      queries: queryStats.queries,
      reads: queryStats.reads,
      writes: queryStats.writes,
      sql: queryStats.sql
    })
  }
  return {
    access,
    duplicate: !!committed.duplicate,
    operation: fromCommitted(committed.operation, {
      roomKey: op.roomKey,
      clientSeq: op.clientSeq,
      baseRevision: op.baseRevision,
      targetId: op.targetId,
      duplicate: !!committed.duplicate
    }),
    result: committed.result || {},
    queryStats
  }
}

async function listOperations(req, roomKey, afterRevision, limit) {
  const key = safeRoomKey(roomKey)
  await roomAcl.assertRoomAccess(getPool(), req, key, 'view')
  const current = await getRoomVersion(key)
  const after = Math.max(0, Number(afterRevision) || 0)
  const pageSize = Math.min(500, Math.max(1, Number(limit) || 500))
  const operations = await listRoomOperations(key, after, pageSize)
  const mapped = (operations || []).map(item =>
    fromCommitted(item, { roomKey: key })
  )
  const last = mapped.length ? Number(mapped[mapped.length - 1].serverRevision) : after
  const hasMore = last < Number(current || 0)
  return {
    reload: false,
    hasMore,
    fromRevision: after,
    toRevision: last,
    pageSize,
    serverRevision: Number(current || 0),
    operations: mapped
  }
}

module.exports = { submitOperation, listOperations }
