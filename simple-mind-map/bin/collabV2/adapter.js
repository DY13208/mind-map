const { createOutbox } = require('./outbox')
const {
  shouldQuarantineOutboxOp,
  summarizeOutbox
} = require('../collabRoomRecovery')
const {
  isTerminalError,
  isRetryableError,
  dependsOnBlockedOp,
  shouldQuarantineError,
  writeClientHeartbeat,
  canClaimOrphan
} = require('../collabReliability')
const {
  createOpId,
  isOpId,
  normalizeOperation,
  isWriteType,
  isValidClientId,
  requireClientId,
  normalizeType,
  BATCH_CHUNK
} = require('./protocol')

function adapterTrace(stage, detail) {
  try {
    if (typeof window !== 'undefined') {
      const host = (window.location && window.location.hostname) || ''
      const on =
        window.__COLLAB_V2_TRACE__ === true ||
        (window.localStorage &&
          window.localStorage.getItem('COLLAB_V2_TRACE') === '1') ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        /^192\.168\./.test(host) ||
        /^10\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      if (!on) return
      if (!Array.isArray(window.__V2_TRACE_LOG__)) window.__V2_TRACE_LOG__ = []
      const row = { t: Date.now(), stage, ...(detail || {}) }
      window.__V2_TRACE_LOG__.push(row)
      if (window.__V2_TRACE_LOG__.length > 400) window.__V2_TRACE_LOG__.shift()
      if (console && console.info) console.info('[v2-trace]', stage, detail)
      return
    }
  } catch (err) {
    // ignore
  }
  try {
    require('./trace').collabTrace(stage, detail)
  } catch (err) {
    // ignore
  }
}

function sessionClientId() {
  try {
    if (typeof sessionStorage === 'undefined') return createOpId()
    const key = 'mind-map-collab-v2-client'
    let id = sessionStorage.getItem(key)
    if (!isValidClientId(id)) {
      id = createOpId()
      sessionStorage.setItem(key, id)
    }
    return id
  } catch (err) {
    return createOpId()
  }
}

const STAGES = {
  CLIENT_INIT: 'client_init',
  OUTBOX_PUT: 'outbox_put',
  SOCKET_CONNECT: 'socket_connect',
  SOCKET_JOIN: 'socket_join',
  SOCKET_EMIT: 'socket_emit',
  SERVER_ACL: 'server_acl',
  SERVER_APPLY: 'server_apply',
  PG_COMMIT: 'pg_commit',
  ACK_WAIT: 'ack_wait',
  REMOTE_APPLY: 'remote_apply',
  GAP_SYNC: 'gap_sync',
  RECONNECT: 'reconnect'
}

const CODE_ALIASES = {
  TIMEOUT: 'ACK_TIMEOUT',
  BAD_TYPE: 'UNSUPPORTED_OPERATION',
  NODE_DELETED: 'TARGET_DELETED',
  UNKNOWN: 'SYNC_FAILED',
  UNKNOWN_ERROR: 'SYNC_FAILED'
}

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|token|access_token|refresh_token|password|secret|api[-_]?key)$/i

function normalizeErrorCode(code, fallback) {
  const raw = String(code || '').trim()
  if (!raw) return fallback || 'SYNC_FAILED'
  if (CODE_ALIASES[raw]) return CODE_ALIASES[raw]
  return raw
}

const STICKY_ERROR_CODES = {
  FORBIDDEN: true,
  INVALID_CLIENT_ID: true,
  PG_COMMIT_FATAL: true
}

function isStickyErrorCode(code) {
  return !!STICKY_ERROR_CODES[String(code || '')]
}

const SKIPPABLE_GONE_CODES = {
  UID_REUSED: true,
  TARGET_DELETED: true,
  NODE_DELETED: true,
  PARENT_DELETED: true,
  DROPPED_DELETED: true,
  MOVE_CONFLICT: true
}

function isSkippableGoneError(code) {
  return !!SKIPPABLE_GONE_CODES[String(code || '')]
}

function insertUidsOf(op) {
  const type = normalizeType(op && op.type)
  const payload = (op && op.payload) || {}
  if (type === 'node.insert' || type === 'node.create') {
    return payload.uid ? [String(payload.uid)] : []
  }
  if (type === 'node.batch') {
    const uids = []
    ;(payload.ops || []).forEach(inner => {
      insertUidsOf(inner).forEach(id => uids.push(id))
    })
    return uids
  }
  return []
}

function opInsertsUid(op, uid) {
  const id = String(uid || '')
  if (!id) return false
  return insertUidsOf(op).indexOf(id) !== -1
}

function stripInsertUid(op, uid) {
  const type = normalizeType(op && op.type)
  const id = String(uid || '')
  if (!op || !id) return op
  if (type === 'node.insert' || type === 'node.create') {
    return String((op.payload || {}).uid || '') === id ? null : op
  }
  if (type === 'node.batch') {
    const ops = ((op.payload && op.payload.ops) || []).filter(
      inner => !opInsertsUid(inner, id)
    )
    if (!ops.length) return null
    return {
      ...op,
      payload: { ...(op.payload || {}), ops }
    }
  }
  return op
}

function undoTrace(stage, detail) {
  try {
    if (typeof window === 'undefined') return
    const on =
      window.__UNDO_TRACE__ === true ||
      (window.localStorage && window.localStorage.getItem('UNDO_TRACE') === '1')
    if (!on) return
    const row = { t: Date.now(), stage, ...(detail || {}) }
    if (!Array.isArray(window.__UNDO_TRACE_LOG__)) window.__UNDO_TRACE_LOG__ = []
    window.__UNDO_TRACE_LOG__.push(row)
    if (console && console.info) console.info('[undo-trace]', stage, row)
  } catch (err) {
    // ignore
  }
}

function isPgCommitCode(code, message) {
  const raw = String(code || '')
  if (raw === 'PG_ERROR' || raw === 'PG_COMMIT_FAILED') return true
  if (/^(ECONNREFUSED|ENOTFOUND|ECONNRESET|57P01|40001|40P01|23503|23505|53300)$/i.test(raw)) {
    return true
  }
  return /postgres|econnrefused|deadlock|serialization failure/i.test(String(message || ''))
}

function stageForCode(code, hint) {
  if (hint) return hint
  if (code === 'FORBIDDEN') return STAGES.SERVER_ACL
  if (code === 'ACK_TIMEOUT') return STAGES.ACK_WAIT
  if (code === 'REVISION_GAP') return STAGES.GAP_SYNC
  if (code === 'OUTBOX_FAILED') return STAGES.OUTBOX_PUT
  if (code === 'INVALID_CLIENT_ID') return STAGES.CLIENT_INIT
  if (isPgCommitCode(code)) return STAGES.PG_COMMIT
  if (code === 'VERSION_AHEAD' || code === 'STALE_BASE' || code === 'VERSION_CONFLICT') {
    return STAGES.SERVER_APPLY
  }
  if (
    code === 'CYCLE_REJECTED' ||
    code === 'TARGET_DELETED' ||
    code === 'UID_REUSED' ||
    code === 'DROPPED_DELETED' ||
    code === 'UNSUPPORTED_OPERATION' ||
    code === 'OP_REJECTED'
  ) {
    return STAGES.SERVER_APPLY
  }
  return STAGES.SERVER_APPLY
}

function sanitizeDetails(value, depth) {
  if (value == null) return value
  if (depth > 4) return undefined
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeDetails(item, (depth || 0) + 1))
  }
  const next = {}
  Object.keys(value).forEach(key => {
    if (SENSITIVE_KEY.test(key)) return
    next[key] = sanitizeDetails(value[key], (depth || 0) + 1)
  })
  return next
}

function revisionStorageKey(roomKey) {
  return 'mind-map-collab-v2-rev:' + String(roomKey || '')
}

function readPersistedRevision(roomKey) {
  try {
    if (typeof sessionStorage === 'undefined' || !roomKey) return 0
    return Math.max(0, Number(sessionStorage.getItem(revisionStorageKey(roomKey))) || 0)
  } catch (err) {
    return 0
  }
}

function persistRevision(roomKey, rev) {
  try {
    if (typeof sessionStorage === 'undefined' || !roomKey) return
    sessionStorage.setItem(revisionStorageKey(roomKey), String(Math.max(0, Number(rev) || 0)))
  } catch (err) {
    // ignore
  }
}

function createCollaborationAdapter(options = {}) {
  const listeners = new Set()
  const outbox = options.outbox || createOutbox(options)
  const state = {
    status: 'disconnected',
    phase: 'DISCONNECTED',
    roomKey: '',
    userId: '',
    clientId: isValidClientId(options.clientId)
      ? String(options.clientId).trim()
      : sessionClientId(),
    lastServerRevision: 0,
    serverRevision: 0,
    role: '',
    canEdit: true,
    canView: true,
    peers: [],
    saveState: 'idle',
    stage: STAGES.CLIENT_INIT,
    error: '',
    lastError: null,
    lastErrorCode: '',
    lastErrorMessage: '',
    currentError: null,
    lastErrorRecovered: false,
    lastOpId: '',
    clientSeq: 0,
    outboxPending: 0,
    seenOpIds: new Set(),
    pendingAcks: new Map(),
    undoStack: [],
    redoStack: [],
    outboxSending: 0,
    sendingOpId: '',
    drainPaused: false,
    aheadAttempts: 0,
    maxSendingObserved: 0,
    versionAheadCount: 0,
    droppedInsertOpIds: new Set(),
    lastSyncAt: 0,
    lastAckAt: 0,
    reconnectCount: 0,
    gapRecoveredOps: 0,
    snapshotRecoveryCount: 0,
    requiresConfirmation: null,
    heartbeatTimer: null
  }
  let socket = options.socket || null
  let connecting = null
  let drainLoop = null
  let draining = false
  let enqueueGate = Promise.resolve()

  function withEnqueueLock(fn) {
    const prev = enqueueGate
    let release
    enqueueGate = new Promise(resolve => {
      release = resolve
    })
    return Promise.resolve(prev).then(fn).finally(() => {
      release()
    })
  }

  let lastEmittedSaveState = state.saveState

  function saveStateTraceOn() {
    try {
      if (typeof process !== 'undefined' && process.env && process.env.SAVE_STATE_TRACE === '1') {
        return true
      }
      if (typeof window === 'undefined') return false
      if (window.__SAVE_STATE_TRACE__ === true) return true
      if (window.localStorage && window.localStorage.getItem('SAVE_STATE_TRACE') === '1') {
        return true
      }
    } catch (err) {
      // ignore
    }
    return false
  }

  function emit(reason) {
    const snap = getStatus()
    const nextSave = snap.saveState
    if (nextSave !== lastEmittedSaveState) {
      const row = {
        from: lastEmittedSaveState,
        to: nextSave,
        reason: reason || 'emit',
        opId: state.sendingOpId || state.lastOpId || '',
        outboxPending: Number(state.outboxPending || 0),
        outboxSending: Number(state.outboxSending || 0),
        pendingAcks: state.pendingAcks.size,
        presenceEvent: reason === 'presence:state',
        timestamp: Date.now()
      }
      lastEmittedSaveState = nextSave
      if (saveStateTraceOn()) {
        adapterTrace('SAVE_STATE_TRACE', row)
        try {
          if (typeof console !== 'undefined' && console.info) {
            console.info('SAVE_STATE_TRACE', row)
          }
        } catch (err) {
          // ignore
        }
      }
    }
    publishDebug()
    listeners.forEach(fn => {
      try {
        fn(snap)
      } catch (err) {
        // ignore
      }
    })
  }

  function getDiagnosticState() {
    const last = state.lastError
    return sanitizeDetails({
      errorCode: (last && last.code) || state.lastErrorCode || '',
      errorMessage: (last && last.message) || state.lastErrorMessage || state.error || '',
      stage: (last && last.stage) || state.stage || '',
      roomKey: state.roomKey,
      userId: state.userId,
      clientId: state.clientId,
      socketId: socket && socket.id ? socket.id : '',
      lastServerRevision: state.lastServerRevision,
      serverRevision: Number(state.serverRevision || state.lastServerRevision || 0),
      outboxPending: Number(state.outboxPending || 0),
      outboxSending: Number(state.outboxSending || 0),
      sendingOpId: state.sendingOpId || '',
      lastOpId: (last && last.opId) || state.lastOpId || '',
      baseRevision: (last && last.details && last.details.baseRevision) != null
        ? last.details.baseRevision
        : '',
      roomCurrentRevision:
        (last && last.details && last.details.roomCurrentRevision) != null
          ? last.details.roomCurrentRevision
          : '',
      clientSeq:
        (last && last.details && last.details.clientSeq) != null
          ? last.details.clientSeq
          : '',
      outboxIndex:
        (last && last.details && last.details.outboxIndex) != null
          ? last.details.outboxIndex
          : '',
      timestamp: (last && last.timestamp) || 0,
      status: state.status,
      phase: state.phase,
      saveState: deriveSaveState(),
      currentError: state.currentError
        ? {
            code: state.currentError.code,
            message: state.currentError.message,
            stage: state.currentError.stage,
            opId: state.currentError.opId,
            timestamp: state.currentError.timestamp
          }
        : null,
      lastErrorRecovered: !!state.lastErrorRecovered,
      lastError: last
        ? {
            code: last.code,
            message: last.message,
            stage: last.stage,
            opId: last.opId,
            timestamp: last.timestamp,
            details: last.details || {},
            recovered: !!state.lastErrorRecovered && !state.currentError
          }
        : null,
      lastSyncAt: Number(state.lastSyncAt || 0),
      lastAckAt: Number(state.lastAckAt || 0),
      reconnectCount: Number(state.reconnectCount || 0),
      gapRecoveredOps: Number(state.gapRecoveredOps || 0),
      snapshotRecoveryCount: Number(state.snapshotRecoveryCount || 0),
      originalBaseRevision:
        (last && last.details && last.details.originalBaseRevision) != null
          ? last.details.originalBaseRevision
          : '',
      sendBaseRevision:
        (last && last.details && last.details.sendBaseRevision) != null
          ? last.details.sendBaseRevision
          : ''
    })
  }

  function publishDebug() {
    try {
      if (typeof window === 'undefined') return
      const snap = getDiagnosticState()
      window.__COLLAB_V2_STATE__ = snap
      window.__COLLAB_V2_STATUS__ = getDiagnosticState
    } catch (err) {
      // ignore
    }
  }

  function recordError(input = {}) {
    const code = normalizeErrorCode(input.code, input.fallback || 'SYNC_FAILED')
    const stage = stageForCode(code, input.stage || state.stage)
    const lastError = {
      code,
      message: String(input.message || state.error || code),
      stage,
      opId: input.opId || state.lastOpId || '',
      timestamp: Date.now(),
      details: sanitizeDetails(input.details || {})
    }
    state.lastError = lastError
    state.lastErrorCode = lastError.code
    state.lastErrorMessage = lastError.message
    state.lastErrorRecovered = false
    state.currentError = lastError
    state.error = lastError.message
    state.stage = stage
    if (input.opId) state.lastOpId = input.opId
    return lastError
  }

  function recordDiagnosticError(input = {}) {
    const lastError = recordError(input)
    state.lastErrorRecovered = true
    clearCurrentError()
    return lastError
  }

  function clearCurrentError() {
    state.currentError = null
    state.error = ''
  }

  function maybeClearRecoveredError(opts = {}) {
    if (!isLive()) return false
    if (Number(state.outboxPending || 0) > 0) return false
    if (Number(state.outboxSending || 0) > 0) return false
    if (!opts.ignorePendingAcks && state.pendingAcks.size > 0) return false
    const activeCode = state.currentError && state.currentError.code
    if (activeCode && isStickyErrorCode(activeCode)) return false
    if (state.currentError) {
      state.lastErrorRecovered = true
      clearCurrentError()
      return true
    }
    if (state.lastError && !isStickyErrorCode(state.lastError.code)) {
      state.lastErrorRecovered = true
      clearCurrentError()
      return true
    }
    return false
  }

  function clearError() {
    clearCurrentError()
    state.lastError = null
    state.lastErrorCode = ''
    state.lastErrorMessage = ''
    state.lastErrorRecovered = false
  }

  function setStatus(status, extra = {}) {
    if (extra.stage) state.stage = extra.stage
    if (extra.saveState) state.saveState = extra.saveState
    if (extra.opId) state.lastOpId = extra.opId
    if (extra.error === '') {
      maybeClearRecoveredError({
        ignorePendingAcks: extra.saveState === 'saved'
      })
    } else if (extra.errorCode != null || extra.error) {
      recordError({
        code: extra.errorCode,
        message: extra.error || extra.errorCode,
        stage: extra.stage,
        opId: extra.opId,
        details: extra.details
      })
    }
    if (extra.phase) {
      state.phase = extra.phase
    } else if (status === 'connecting') {
      if (state.phase !== 'JOINING' && state.phase !== 'RESYNCING') {
        state.phase = 'CONNECTING'
      }
    } else if (status === 'live') {
      if (extra.saveState === 'resync') state.phase = 'RESYNCING'
      else state.phase = 'LIVE'
    } else if (status === 'reconnecting') {
      state.phase = 'OFFLINE'
    } else if (status === 'disconnected') {
      state.phase = extra.error ? 'ERROR' : 'DISCONNECTED'
    }
    if (state.status !== status) state.status = status
    emit()
  }

  function isLive() {
    return state.status === 'live' && state.phase === 'LIVE'
  }

  function assignLastServerRevision(rev, opts = {}) {
    const next = Math.max(0, Number(rev) || 0)
    if (opts.allowDecrease) {
      if (next !== Number(state.lastServerRevision || 0)) {
        state.lastServerRevision = next
        persistRevision(state.roomKey, next)
      }
    } else if (next > state.lastServerRevision) {
      state.lastServerRevision = next
      persistRevision(state.roomKey, next)
    }
    if (next > Number(state.serverRevision || 0)) state.serverRevision = next
  }

  function advanceRevision(rev) {
    assignLastServerRevision(rev, { allowDecrease: false })
  }

  function deriveSaveState() {
    const pendingAcks = state.pendingAcks.size
    const outboxPending = Number(state.outboxPending || 0)
    const sending = Number(state.outboxSending || 0)
    const current = state.currentError
    if (current && current.code) {
      if (
        state.phase === 'CONNECTING' ||
        state.phase === 'JOINING' ||
        state.phase === 'RESYNCING'
      ) {
        return 'resync'
      }
      if (state.phase === 'OFFLINE' || state.status === 'reconnecting') {
        return 'offline'
      }
      if (current.code === 'SOP_CONFIRM_REQUIRED') return 'requires_confirmation'
      return 'error'
    }
    if (state.phase === 'ERROR' && current && current.code) return 'error'
    if (state.phase === 'OFFLINE' || state.status === 'reconnecting') {
      return 'offline'
    }
    if (state.phase === 'DISCONNECTED' || state.status === 'disconnected') {
      if (pendingAcks || outboxPending) return 'offline'
      return current && current.code ? 'error' : 'idle'
    }
    if (
      state.phase === 'CONNECTING' ||
      state.phase === 'JOINING' ||
      state.phase === 'RESYNCING' ||
      state.status === 'connecting'
    ) {
      return 'resync'
    }
    if (pendingAcks > 0 || outboxPending > 0 || sending > 0) return 'saving'
    return 'saved'
  }

  function bumpOutboxPending(delta) {
    state.outboxPending = Math.max(0, Number(state.outboxPending || 0) + delta)
  }

  function getStatus() {
    return {
      status: state.status,
      phase: state.phase,
      roomKey: state.roomKey,
      userId: state.userId,
      clientId: state.clientId,
      lastServerRevision: state.lastServerRevision,
      serverRevision: Number(state.serverRevision || state.lastServerRevision || 0),
      role: state.role,
      canEdit: state.canEdit,
      canView: state.canView,
      peers: state.peers.slice(),
      saveState: deriveSaveState(),
      error: state.error,
      stage: state.stage,
      lastError: state.lastError,
      currentError: state.currentError,
      lastErrorRecovered: !!state.lastErrorRecovered,
      lastErrorCode: (state.lastError && state.lastError.code) || state.lastErrorCode || '',
      lastErrorMessage:
        (state.lastError && state.lastError.message) ||
        state.lastErrorMessage ||
        state.error ||
        '',
      lastOpId: state.lastOpId || '',
      pendingCount: state.pendingAcks.size,
      outboxPending: Number(state.outboxPending || 0),
      outboxSending: Number(state.outboxSending || 0),
      sendingOpId: state.sendingOpId || '',
      maxSendingObserved: Number(state.maxSendingObserved || 0),
      versionAheadCount: Number(state.versionAheadCount || 0),
      undoDepth: state.undoStack.length,
      redoDepth: state.redoStack.length,
      undoTop: state.undoStack.length
        ? {
            opId: state.undoStack[state.undoStack.length - 1].opId,
            type: state.undoStack[state.undoStack.length - 1].type,
            opIds: state.undoStack[state.undoStack.length - 1].opIds || []
          }
        : null,
      socketId: socket && socket.id ? socket.id : '',
      socketConnected: !!(socket && socket.connected),
      lastSync: state.lastSync || null,
      lastSyncAt: Number(state.lastSyncAt || 0),
      lastAckAt: Number(state.lastAckAt || 0),
      reconnectCount: Number(state.reconnectCount || 0),
      gapRecoveredOps: Number(state.gapRecoveredOps || 0),
      snapshotRecoveryCount: Number(state.snapshotRecoveryCount || 0),
      requiresConfirmation: state.requiresConfirmation || null,
      outboxInspect: state.outboxInspect || []
    }
  }

  function subscribe(listener) {
    if (typeof listener === 'function') listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function ackWait(opId) {
    return new Promise((resolve, reject) => {
      state.pendingAcks.set(opId, { resolve, reject })
    })
  }

  function settleAck(opId, err, result) {
    const wait = state.pendingAcks.get(opId)
    state.pendingAcks.delete(opId)
    if (!wait) return
    if (err) wait.reject(err)
    else wait.resolve(result)
  }

  async function applyRemoteOperation(op, meta = {}) {
    if (!op) return
    const opId = op.opId || op.operationId
    adapterTrace('10.remote.recv', {
      traceId: op.traceId || (op.payload && op.payload.traceId),
      opId,
      type: op.type,
      rev: op.serverRevision || op.version,
      roomKey: state.roomKey,
      clientId: op.clientId,
      userId: op.userId,
      local: !!meta.local
    })
    const rev = Number(op.serverRevision || op.version || 0)
    const opClientId = String(
      (op && op.clientId) || (op && op.event && op.event.clientId) || ''
    ).trim()
    if (opClientId && opClientId === state.clientId) {
      if (opId) state.seenOpIds.add(opId)
      advanceRevision(rev)
      adapterTrace('10.remote.echo-self', { opId, clientId: opClientId, rev })
      return
    }
    if (rev && rev > state.lastServerRevision + 1 && !meta.fromSync) {
      recordError({
        code: 'REVISION_GAP',
        message: 'revision gap ' + rev + ' > ' + (state.lastServerRevision + 1),
        stage: STAGES.GAP_SYNC,
        opId,
        details: { serverRevision: rev, lastServerRevision: state.lastServerRevision }
      })
      await resync()
      return
    }
    if (opId && state.seenOpIds.has(opId)) {
      advanceRevision(rev)
      return
    }
    if (opId) state.seenOpIds.add(opId)
    advanceRevision(rev)
    if (options.onRemoteOperation && !meta.local) {
      await options.onRemoteOperation(op)
    }
    if (!meta.local) kickDrain()
    emit()
  }

  function bindSocket(next) {
    if (!next || next._collabBound) {
      socket = next || socket
      return
    }
    next._collabBound = true
    socket = next
    socket.on('op:event', op => {
      applyRemoteOperation(op).catch(err => {
        recordError({
          code: (err && err.code) || 'REMOTE_APPLY_FAILED',
          message: (err && err.message) || 'remote apply failed',
          stage: STAGES.REMOTE_APPLY,
          opId: op && (op.opId || op.operationId),
          details: { type: op && op.type }
        })
        setStatus('live', { saveState: 'error' })
      })
    })
    if (!next._diagBound) {
      next._diagBound = true
      next.on('connect_error', err => {
        const code = normalizeErrorCode(
          err && (err.code || (err.data && err.data.code)),
          'SOCKET_CONNECT_FAILED'
        )
        if (code === 'INVALID_CLIENT_ID' || code === 'FORBIDDEN') {
          recordError({
            code,
            message: (err && err.message) || 'socket connect failed',
            stage: code === 'FORBIDDEN' ? STAGES.SERVER_ACL : STAGES.SOCKET_CONNECT
          })
          setStatus('disconnected', { saveState: 'error', phase: 'ERROR' })
          return
        }
        state.stage = STAGES.SOCKET_CONNECT
        setStatus('reconnecting', {
          saveState: 'offline',
          phase: 'OFFLINE',
          stage: STAGES.SOCKET_CONNECT
        })
      })
    }
    socket.on('presence:state', payload => {
      if (payload && payload.roomKey === state.roomKey) {
        state.peers = payload.peers || []
        emit('presence:state')
      }
    })
    socket.on('lock:denied', payload => {
      if (options.onLockDenied) options.onLockDenied(payload)
    })
    socket.on('disconnect', () => {
      if (state.status !== 'disconnected') {
        state.reconnectCount = Number(state.reconnectCount || 0) + 1
        state.stage = STAGES.RECONNECT
        setStatus('reconnecting', {
          saveState: 'offline',
          phase: 'OFFLINE',
          stage: STAGES.RECONNECT
        })
      }
    })
    socket.on('connect', () => {
      state.stage = STAGES.SOCKET_CONNECT
      if (state.roomKey) {
        joinRoom().then(() => retryPending()).catch(() => {})
      }
    })
  }

  async function joinRoom() {
    if (!socket) throw new Error('socket missing')
    setStatus('connecting', {
      saveState: 'saving',
      phase: 'JOINING',
      stage: STAGES.SOCKET_JOIN
    })
    requireClientId(state.clientId)
    const payload = {
      roomKey: state.roomKey,
      clientId: state.clientId,
      userId: state.userId,
      name: options.name,
      color: options.color,
      avatar: options.avatar,
      lastServerRevision: state.lastServerRevision
    }
    const result = await emitAck('join', payload)
    if (!result || !result.ok) {
      const err = new Error((result && result.error) || 'join failed')
      err.code = normalizeErrorCode(result && result.code, 'JOIN_FAILED')
      err.statusCode = result && result.statusCode
      err.stage =
        err.code === 'FORBIDDEN'
          ? STAGES.SERVER_ACL
          : err.code === 'ACK_TIMEOUT'
            ? STAGES.ACK_WAIT
            : STAGES.SOCKET_JOIN
      throw err
    }
    state.role = result.role || state.role
    state.canEdit = result.canEdit !== false
    state.canView = result.canView !== false
    state.peers = result.peers || []
    if (Number(result.serverRevision) > 0) {
      state.serverRevision = Number(result.serverRevision)
    }
    if (result.sync && result.sync.reload) {
      advanceRevision(result.sync.serverRevision || result.serverRevision || 0)
      if (options.onReloadRequired) await options.onReloadRequired(result.sync)
    } else if (result.sync && result.sync.operations) {
      await applySyncPage(result.sync)
    } else if (Number(result.serverRevision) > 0 && state.lastServerRevision <= 0) {
      advanceRevision(result.serverRevision)
    }
    const authRev = Number(result.serverRevision)
    if (Number.isFinite(authRev) && authRev >= 0) {
      state.serverRevision = Math.max(Number(state.serverRevision || 0), authRev)
      if (state.lastServerRevision > authRev) {
        adapterTrace('revision.clamp', {
          from: state.lastServerRevision,
          to: authRev,
          roomKey: state.roomKey,
          clientId: state.clientId
        })
        assignLastServerRevision(authRev, { allowDecrease: true })
      }
    }
    setStatus('live', { saveState: 'saved', error: '', errorCode: '', phase: 'LIVE' })
    startHeartbeat()
    await quarantineStaleImportOps()
    await claimOrphanOutbox()
    await rebaseUnsent(state.lastServerRevision)
    await refreshOutboxCounts()
    kickDrain()
    return result
  }

  async function applySyncPage(sync) {
    const ops = (sync && sync.operations) || []
    for (const op of ops) {
      await applyRemoteOperation(op, { fromSync: true })
    }
    if (sync && sync.hasMore) {
      const next = await emitAck('sync', {
        roomKey: state.roomKey,
        afterRevision: state.lastServerRevision
      })
      if (next && next.ok) await applySyncPage(next)
    }
  }

  function emitAck(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error('socket missing'))
        return
      }
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'ACK_TIMEOUT', error: 'socket timeout' })
      }, options.timeoutMs || 12000)
      socket.emit(event, payload, result => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  async function connect(input = {}) {
    state.roomKey = String(input.roomKey || state.roomKey)
    state.userId = String(input.userId || state.userId)
    if (isValidClientId(input.clientId)) {
      state.clientId = String(input.clientId).trim()
    } else if (!isValidClientId(state.clientId)) {
      state.clientId = sessionClientId()
    }
    if (!isValidClientId(state.clientId)) {
      const err = new Error('clientId 生成失败')
      err.code = 'INVALID_CLIENT_ID'
      setStatus('disconnected', {
        saveState: 'error',
        error: err.message,
        errorCode: err.code,
        phase: 'ERROR',
        stage: STAGES.CLIENT_INIT
      })
      throw err
    }
    const incomingRev =
      input.lastServerRevision != null ? Number(input.lastServerRevision) || 0 : 0
    state.lastServerRevision = Math.max(
      incomingRev,
      readPersistedRevision(state.roomKey),
      Number(state.lastServerRevision) || 0
    )
    state.stage = STAGES.CLIENT_INIT
    setStatus('connecting', {
      saveState: 'saving',
      error: '',
      phase: 'CONNECTING',
      stage: STAGES.SOCKET_CONNECT
    })
    if (!socket && typeof options.createSocket === 'function') {
      bindSocket(options.createSocket())
    } else if (socket) {
      bindSocket(socket)
    }
    if (connecting) return connecting
    connecting = joinRoom()
      .then(result => {
        connecting = null
        return result
      })
      .catch(err => {
        connecting = null
        setStatus('disconnected', {
          saveState: 'error',
          error: err.message,
          errorCode: err.code || 'JOIN_FAILED',
          phase: 'ERROR',
          stage: err.stage || STAGES.SOCKET_JOIN
        })
        throw err
      })
    return connecting
  }

  async function disconnect() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer)
      state.heartbeatTimer = null
    }
    state.roomKey = ''
    connecting = null
    if (socket && socket.disconnect) socket.disconnect()
    setStatus('disconnected', { saveState: 'idle', phase: 'DISCONNECTED' })
  }

  function pushUndo(entry) {
    state.undoStack.push(entry)
    if (state.undoStack.length > 200) state.undoStack.shift()
    state.redoStack = []
  }

  async function submitBatched(raw) {
    const ops = (raw.payload && raw.payload.ops) || []
    if (ops.length <= BATCH_CHUNK) return null
    const batchId = (raw.payload && raw.payload.batchId) || createOpId()
    const opIds = []
    let last = null
    const chunkCount = Math.ceil(ops.length / BATCH_CHUNK)
    for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
      last = await submitOperation({
        ...raw,
        opId: createOpId(),
        type: 'node.batch',
        payload: {
          ...(raw.payload || {}),
          ops: ops.slice(i, i + BATCH_CHUNK),
          batchId,
          chunkIndex: Math.floor(i / BATCH_CHUNK),
          chunkCount
        },
        skipUndoStack: true
      })
      opIds.push(last.opId)
    }
    pushUndo({
      opId: opIds[opIds.length - 1],
      opIds,
      type: 'node.batch',
      clientId: state.clientId,
      serverRevision: Number(last && last.serverRevision) || 0,
      groupId: batchId
    })
    return last
  }

  async function submitOperation(raw) {
    const batchOps = (raw && raw.payload && raw.payload.ops) || []
    if (
      normalizeType(raw && raw.type) === 'node.batch' &&
      !raw.skipUndoStack &&
      batchOps.length > BATCH_CHUNK
    ) {
      const chunked = await submitBatched(raw)
      if (chunked) return chunked
    }
    let wait
    await withEnqueueLock(async () => {
    const clientId = requireClientId(state.clientId)
    const op = normalizeOperation(raw, {
      roomKey: state.roomKey,
      userId: state.userId,
      clientId
    })
    op.clientId = clientId
    op.userId = state.userId || op.userId
    if (!op.opId) op.opId = createOpId()
    if (!isOpId(op.opId)) {
      const err = new Error('opId必须是UUID')
      err.code = 'BAD_OP_ID'
      setStatus(state.status, {
        saveState: 'error',
        error: err.message,
        errorCode: err.code,
        stage: STAGES.CLIENT_INIT,
        opId: op.opId
      })
      throw err
    }
    if (!isWriteType(op.type)) {
      const err = new Error('不支持的操作类型')
      err.code = 'UNSUPPORTED_OPERATION'
      setStatus(state.status, {
        saveState: 'error',
        error: err.message,
        errorCode: err.code,
        stage: STAGES.SERVER_APPLY,
        opId: op.opId
      })
      throw err
    }
    if (state.role === 'viewer' || state.canEdit === false) {
      const err = new Error('当前为只读权限，无法修改')
      err.code = 'FORBIDDEN'
      err.statusCode = 403
      setStatus(state.status, {
        saveState: 'error',
        error: err.message,
        errorCode: err.code,
        stage: STAGES.SERVER_ACL,
        opId: op.opId
      })
      throw err
    }
    state.clientSeq += 1
    op.clientSeq = state.clientSeq
    op.observedRevision = Number(state.lastServerRevision) || 0
    op.baseRevision = op.observedRevision
    op.status = 'pending'
    op.skipUndoStack = !!raw.skipUndoStack
    op.traceId = raw.traceId || op.traceId || (op.payload && op.payload.traceId) || ''
    state.lastOpId = op.opId
    state.stage = STAGES.OUTBOX_PUT
    try {
      await outbox.put(op)
    } catch (err) {
      recordError({
        code: 'OUTBOX_FAILED',
        message: (err && err.message) || 'outbox put failed',
        stage: STAGES.OUTBOX_PUT,
        opId: op.opId
      })
      setStatus(state.status, { saveState: 'error', phase: 'ERROR' })
      throw err
    }
    bumpOutboxPending(1)
    adapterTrace('3.outbox.put', {
      traceId: op.traceId,
      opId: op.opId,
      type: op.type,
      clientId: op.clientId,
      observedRevision: op.observedRevision,
      pendingCount: Number(state.outboxPending || 0)
    })
    setStatus(state.status === 'live' ? 'live' : state.status, {
      saveState: isLive() ? 'saving' : 'offline'
    })
    const waitInner = ackWait(op.opId)
    kickDrain()
    wait = waitInner
    })
    return wait
  }

  function beginSending(op) {
    state.sendingOpId = op.opId
    state.outboxSending = Number(state.outboxSending || 0) + 1
    if (state.outboxSending > Number(state.maxSendingObserved || 0)) {
      state.maxSendingObserved = state.outboxSending
    }
    emit('beginSending')
  }

  function endSending() {
    state.outboxSending = Math.max(0, Number(state.outboxSending || 0) - 1)
    if (!state.outboxSending) state.sendingOpId = ''
  }

  function logVersionAhead(op, err, extra = {}) {
    state.versionAheadCount = Number(state.versionAheadCount || 0) + 1
    const details = (err && err.details) || {}
    const roomCurrent =
      details.roomCurrentRevision != null
        ? Number(details.roomCurrentRevision)
        : details.currentVersion != null
          ? Number(details.currentVersion)
          : Number(err && err.currentVersion)
    const baseRevision = Number(
      op && op.baseRevision != null ? op.baseRevision : details.baseRevision
    )
    const row = {
      opId: op && op.opId,
      type: op && op.type,
      clientId: (op && op.clientId) || state.clientId,
      clientSeq: op && op.clientSeq,
      baseRevision,
      lastServerRevision: state.lastServerRevision,
      serverRevision: Number(state.serverRevision || state.lastServerRevision || 0),
      roomCurrentRevision: Number.isFinite(roomCurrent) ? roomCurrent : '',
      outboxIndex: extra.outboxIndex,
      outboxPending: Number(state.outboxPending || 0),
      baseAheadOfRoom:
        Number.isFinite(baseRevision) && Number.isFinite(roomCurrent)
          ? baseRevision > roomCurrent
          : null
    }
    adapterTrace('VERSION_AHEAD', row)
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[collab-v2] VERSION_AHEAD', row)
      }
    } catch (ignore) {
      // ignore
    }
    return row
  }

  function localStorageRef() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null
    } catch (err) {
      return null
    }
  }

  function startHeartbeat() {
    const storage = localStorageRef()
    writeClientHeartbeat(storage, state.clientId)
    if (state.heartbeatTimer) return
    state.heartbeatTimer = setInterval(() => {
      writeClientHeartbeat(localStorageRef(), state.clientId)
    }, 3000)
    if (state.heartbeatTimer.unref) state.heartbeatTimer.unref()
  }

  async function refreshOutboxCounts() {
    const rows = await outbox.list(state.clientId, state.roomKey)
    state.outboxInspect = summarizeOutbox(rows)
    state.outboxPending = (rows || []).filter(
      item =>
        item &&
        (item.status === 'pending' ||
          item.status === 'retryable' ||
          item.status === 'sending')
    ).length
  }

  async function claimOrphanOutbox() {
    const storage = localStorageRef()
    const rows = await outbox.list('', state.roomKey)
    for (const item of rows) {
      if (!canClaimOrphan(item, state, storage)) continue
      await outbox.update(item.opId, {
        clientId: state.clientId,
        claimedFrom: item.clientId,
        userId: item.userId || state.userId
      })
      adapterTrace('outbox.claim', {
        opId: item.opId,
        from: item.clientId,
        to: state.clientId
      })
    }
  }

  async function quarantineStaleImportOps() {
    const pending = await outbox.list(state.clientId, state.roomKey)
    const roomRows = await outbox.list('', state.roomKey)
    const rows = pending.concat(
      roomRows.filter(item => !pending.some(row => row.opId === item.opId))
    )
    state.outboxInspect = summarizeOutbox(rows)
    for (const item of rows) {
      if (!item || item.status === 'quarantined') continue
      const type = normalizeType(item.type)
      const code = item.errorCode || item.code || ''
      const knownSopOp = item.opId === '753eb6d8-3241-4e00-94dd-a7907dbd5454'
      if (
        !shouldQuarantineOutboxOp(item) &&
        type !== 'map.replace' &&
        !shouldQuarantineError(code, item) &&
        !knownSopOp &&
        String(item.error || '').indexOf('SOP_CONFIRM_REQUIRED') < 0 &&
        String(item.error || '').indexOf('confirm_sop_change') < 0
      ) {
        continue
      }
      await outbox.update(item.opId, {
        status: 'quarantined',
        error: item.error || code || 'OUTBOX_QUARANTINED',
        errorCode: code || (knownSopOp ? 'SOP_CONFIRM_REQUIRED' : 'OUTBOX_QUARANTINED')
      })
      adapterTrace('outbox.quarantine', {
        opId: item.opId,
        type: item.type,
        code: code || item.error,
        roomKey: state.roomKey
      })
    }
    return state.outboxInspect
  }

  async function rebaseUnsent(baseRevision) {
    const base = Math.max(0, Number(baseRevision != null ? baseRevision : state.lastServerRevision) || 0)
    const pending = await outbox.list(state.clientId, state.roomKey)
    for (const item of pending) {
      if (!item || item.status === 'sending') continue
      if (item.status === 'quarantined' || item.status === 'failed') continue
      if (shouldQuarantineOutboxOp(item) || normalizeType(item.type) === 'map.replace') {
        continue
      }
      const nextPayload = {
        ...(item.payload || {}),
        baseRevision: base,
        clientSeq: item.clientSeq
      }
      await outbox.update(item.opId, {
        originalBaseRevision:
          item.originalBaseRevision != null
            ? item.originalBaseRevision
            : item.observedRevision != null
              ? item.observedRevision
              : item.baseRevision,
        observedRevision:
          item.observedRevision != null ? item.observedRevision : item.baseRevision,
        baseRevision: base,
        sendBaseRevision: base,
        status: item.status === 'retryable' ? 'pending' : item.status,
        payload: nextPayload
      })
    }
  }

  async function pickDrainHead() {
    const pending = await outbox.list(state.clientId, state.roomKey)
    const active = pending.filter(
      item =>
        item &&
        item.status !== 'acked' &&
        item.status !== 'acknowledged' &&
        item.status !== 'quarantined' &&
        item.status !== 'failed'
    )
    const sending = active.filter(item => item.status === 'sending')
    if (sending.length > 1) {
      for (let i = 1; i < sending.length; i++) {
        await outbox.update(sending[i].opId, { status: 'pending' })
      }
    }
    const blocked = pending.filter(
      item => item && (item.status === 'quarantined' || item.status === 'failed')
    )
    const drainable = active.filter(
      item => !blocked.some(fail => dependsOnBlockedOp(item, fail))
    )
    const head =
      drainable.find(item => item.status === 'sending') ||
      drainable.find(item => item.status === 'pending' || item.status === 'retryable')
    return { head, pending: drainable, index: head ? drainable.indexOf(head) : -1 }
  }

  async function recoverVersionAhead(op, err, extra) {
    const row = logVersionAhead(op, err, extra)
    recordError({
      code: 'VERSION_AHEAD',
      message: (err && err.message) || 'baseVersion不能大于房间当前版本',
      stage: STAGES.SERVER_APPLY,
      opId: op && op.opId,
      details: { ...row, ...(err && err.details) }
    })
    state.aheadAttempts += 1
    state.drainPaused = true
    setStatus('live', {
      saveState: 'resync',
      phase: 'RESYNCING',
      stage: STAGES.GAP_SYNC
    })
    try {
      let authRev = Number(state.serverRevision || 0)
      const probe = socket
        ? await emitAck('sync', {
            roomKey: state.roomKey,
            afterRevision: 0,
            limit: 1
          })
        : await httpFallbackSync()
      if (probe && probe.ok !== false && probe.serverRevision != null) {
        authRev = Number(probe.serverRevision)
        state.serverRevision = Math.max(Number(state.serverRevision || 0), authRev)
      }
      if (state.lastServerRevision > authRev) {
        assignLastServerRevision(authRev, { allowDecrease: true })
      } else if (state.lastServerRevision < authRev) {
        await resync()
      }
      await rebaseUnsent(state.lastServerRevision)
    } finally {
      state.drainPaused = false
      if (state.phase !== 'ERROR') {
        setStatus('live', { saveState: 'saving', phase: 'LIVE' })
      }
    }
    return true
  }

  async function sendOp(op, extra = {}) {
    const sendBase = Math.max(0, Number(state.lastServerRevision) || 0)
    const originalBase =
      op.originalBaseRevision != null
        ? op.originalBaseRevision
        : op.observedRevision != null
          ? op.observedRevision
          : op.baseRevision
    op.originalBaseRevision = originalBase
    op.sendBaseRevision = sendBase
    op.baseRevision = sendBase
    op.payload = {
      ...(op.payload || {}),
      baseRevision: sendBase,
      clientSeq: op.clientSeq
    }
    beginSending(op)
    await outbox.update(op.opId, {
      status: 'sending',
      originalBaseRevision: originalBase,
      sendBaseRevision: sendBase,
      baseRevision: sendBase,
      payload: op.payload
    })
    adapterTrace('4.socket.emit', {
      traceId: op.traceId,
      opId: op.opId,
      type: op.type,
      clientSeq: op.clientSeq,
      baseRevision: sendBase,
      lastServerRevision: state.lastServerRevision,
      socketConnected: !!(socket && socket.connected),
      socketId: socket && socket.id,
      roomJoined: isLive(),
      phase: state.phase,
      status: state.status,
      outboxIndex: extra.outboxIndex
    })
    state.stage = STAGES.SOCKET_EMIT
    state.lastOpId = op.opId
    if (!socket || !socket.connected || !isLive()) {
      endSending()
      if (state.droppedInsertOpIds && state.droppedInsertOpIds.has(op.opId)) {
        state.droppedInsertOpIds.delete(op.opId)
        await outbox.remove(op.opId)
        bumpOutboxPending(-1)
        const err = new Error('dropped deleted insert')
        err.code = 'DROPPED_DELETED'
        settleAck(op.opId, err)
        return { skipped: true, err }
      }
      await outbox.update(op.opId, { status: 'pending', baseRevision: sendBase })
      setStatus(state.status === 'live' ? 'live' : state.status, {
        saveState: 'offline'
      })
      return { deferred: true }
    }
    state.stage = STAGES.ACK_WAIT
    const result = await emitAck('op', op)
    if (result && (result.code === 'TIMEOUT' || result.code === 'ACK_TIMEOUT')) {
      endSending()
      await outbox.update(op.opId, { status: 'retryable', baseRevision: sendBase })
      if (state.seenOpIds.has(op.opId)) {
        await outbox.remove(op.opId)
        bumpOutboxPending(-1)
        settleAck(op.opId, null, { opId: op.opId, duplicate: true })
        return { ok: true, duplicate: true }
      }
      recordError({
        code: 'ACK_TIMEOUT',
        message: (result && result.error) || 'socket timeout',
        stage: STAGES.ACK_WAIT,
        opId: op.opId,
        details: {
          clientSeq: op.clientSeq,
          baseRevision: sendBase,
          outboxIndex: extra.outboxIndex
        }
      })
      setStatus('live', { saveState: 'error', stage: STAGES.ACK_WAIT, opId: op.opId })
      return { timeout: true }
    }
    if (!result || !result.ok) {
      const err = new Error((result && result.error) || 'operation rejected')
      err.code = normalizeErrorCode(result && result.code, 'OP_REJECTED')
      err.statusCode = result && result.statusCode
      err.details = result && result.details
      err.currentVersion = result && result.currentVersion
      endSending()
      if (err.code === 'VERSION_AHEAD') {
        await outbox.update(op.opId, { status: 'retryable', error: err.message })
        return { ahead: true, err }
      }
      if (err.code === 'STALE_BASE' || err.code === 'VERSION_CONFLICT' || err.code === 'REVISION_GAP') {
        await outbox.update(op.opId, { status: 'retryable', error: err.message })
        return { stale: true, err }
      }
      if (
        isSkippableGoneError(err.code) ||
        (state.droppedInsertOpIds && state.droppedInsertOpIds.has(op.opId))
      ) {
        if (state.droppedInsertOpIds) state.droppedInsertOpIds.delete(op.opId)
        await outbox.remove(op.opId)
        bumpOutboxPending(-1)
        recordDiagnosticError({
          code: err.code,
          message: err.message,
          stage: STAGES.SERVER_APPLY,
          opId: op.opId,
          details: {
            statusCode: err.statusCode,
            baseRevision: sendBase,
            clientSeq: op.clientSeq,
            outboxIndex: extra.outboxIndex,
            skipped: true,
            ...(err.details || {})
          }
        })
        settleAck(op.opId, err)
        const pendingLeft = Number(state.outboxPending || 0)
        setStatus('live', {
          saveState: pendingLeft > 0 ? 'saving' : 'saved',
          error: '',
          phase: 'LIVE',
          stage: STAGES.SERVER_APPLY,
          opId: op.opId
        })
        adapterTrace('op.skipped.gone', {
          opId: op.opId,
          type: op.type,
          code: err.code,
          clientSeq: op.clientSeq
        })
        return { skipped: true, err }
      }
      const terminal = shouldQuarantineError(err.code, op) || isTerminalError(err.code)
      await outbox.update(op.opId, {
        status: terminal ? 'quarantined' : 'failed',
        error: err.message,
        errorCode: err.code,
        originalBaseRevision: originalBase,
        sendBaseRevision: sendBase
      })
      await refreshOutboxCounts()
      const stage =
        err.code === 'FORBIDDEN'
          ? STAGES.SERVER_ACL
          : isPgCommitCode(err.code, err.message)
            ? STAGES.PG_COMMIT
            : STAGES.SERVER_APPLY
      if (err.code === 'SOP_CONFIRM_REQUIRED') {
        state.requiresConfirmation = {
          opId: op.opId,
          type: op.type,
          originalBaseRevision: originalBase,
          sendBaseRevision: sendBase
        }
      }
      setStatus('live', {
        saveState:
          err.code === 'SOP_CONFIRM_REQUIRED' ? 'requires_confirmation' : 'error',
        error: err.message,
        errorCode: err.code,
        stage,
        opId: op.opId,
        details: {
          statusCode: err.statusCode,
          originalBaseRevision: originalBase,
          sendBaseRevision: sendBase,
          baseRevision: sendBase,
          clientSeq: op.clientSeq,
          outboxIndex: extra.outboxIndex,
          roomCurrentRevision:
            err.details && (err.details.roomCurrentRevision || err.details.currentVersion),
          ...(err.details || {})
        }
      })
      if (options.onRejected) options.onRejected(op, err)
      settleAck(op.opId, err)
      return { terminal: true, stopDrain: err.code === 'FORBIDDEN', err }
    }
    await outbox.remove(op.opId)
    bumpOutboxPending(-1)
    state.seenOpIds.add(op.opId)
    const rev = Number(result.serverRevision || 0)
    advanceRevision(rev)
    state.aheadAttempts = 0
    state.lastAckAt = Date.now()
    if (state.currentError && state.currentError.code === 'SOP_CONFIRM_REQUIRED') {
      // keep lastError; room continues
    }
    endSending()
    await refreshOutboxCounts()
    setStatus('live', { saveState: 'saved', error: '' })
    settleAck(op.opId, null, result)
    const kind = normalizeType(op.type)
    if (kind === 'operation.undo') {
      // stacks updated by undo()
    } else if (kind === 'operation.redo') {
      // stacks updated by redo()
    } else if (!result.duplicate && !op.skipUndoStack) {
      pushUndo({
        opId: op.opId,
        type: kind,
        clientId: op.clientId || state.clientId,
        serverRevision: Number(result.serverRevision || 0),
        groupId: (op.payload && op.payload.batchId) || op.opId
      })
    }
    return { ok: true, result }
  }

  function kickDrain() {
    if (state.drainPaused) return drainLoop
    if (draining || drainLoop) return drainLoop
    if (!socket || !socket.connected || !isLive()) return drainLoop
    draining = true
    drainLoop = runDrain()
      .catch(() => {})
      .finally(() => {
        draining = false
        drainLoop = null
        state.outboxSending = 0
        state.sendingOpId = ''
        if (!socket || !socket.connected || !isLive() || state.drainPaused) return
        outbox
          .list(state.clientId, state.roomKey)
          .then(rows => {
            const hasWork = (rows || []).some(
              item =>
                item &&
                (item.status === 'pending' ||
                  item.status === 'retryable' ||
                  item.status === 'sending')
            )
            if (
              hasWork &&
              !state.drainPaused &&
              socket &&
              socket.connected &&
              isLive()
            ) {
              kickDrain()
            }
          })
          .catch(() => {})
      })
    return drainLoop
  }

  async function runDrain() {
    while (!state.drainPaused && state.roomKey) {
      const picked = await pickDrainHead()
      const head = picked.head
      if (!head) break
      if (state.outboxSending > 1) {
        adapterTrace('drain.sending.overflow', { sending: state.outboxSending })
      }
      const outcome = await sendOp(head, { outboxIndex: picked.index })
      if (outcome && outcome.deferred) break
      if (outcome && outcome.timeout) {
        const waitMs = Math.min(Number(options.timeoutMs || 12000), 800)
        await new Promise(resolve => setTimeout(resolve, waitMs))
        continue
      }
      if (outcome && outcome.ahead) {
        const recovered = await recoverVersionAhead(head, outcome.err, {
          outboxIndex: picked.index
        })
        if (!recovered) break
        continue
      }
      if (outcome && outcome.stale) {
        try {
          await resync()
          await rebaseUnsent(state.lastServerRevision)
        } catch (err) {
          break
        }
        continue
      }
      if (outcome && outcome.skipped) continue
      if (outcome && outcome.terminal) {
        if (outcome.stopDrain) break
        continue
      }
    }
  }

  async function dropPendingInsertsForUid(uid) {
    const id = String(uid || '')
    if (!id || !state.roomKey) return 0
    const pending = await outbox.list(state.clientId, state.roomKey)
    let dropped = 0
    for (const item of pending) {
      if (!item || item.status === 'acked' || item.status === 'acknowledged') continue
      if (!opInsertsUid(item, id)) continue
      if (item.status === 'sending') {
        state.droppedInsertOpIds.add(item.opId)
        continue
      }
      const next = stripInsertUid(item, id)
      if (next) {
        await outbox.update(item.opId, {
          payload: next.payload,
          type: next.type
        })
        continue
      }
      await outbox.remove(item.opId)
      bumpOutboxPending(-1)
      const err = new Error('dropped deleted insert ' + id)
      err.code = 'DROPPED_DELETED'
      settleAck(item.opId, err)
      dropped += 1
    }
    if (dropped) emit()
    return dropped
  }

  async function retryPending() {
    return kickDrain()
  }

  async function undo() {
    const last = state.undoStack[state.undoStack.length - 1]
    undoTrace('adapter.undo', {
      hasEntry: !!last,
      undoDepth: state.undoStack.length,
      opId: last && last.opId,
      type: last && last.type,
      clientId: last && last.clientId,
      serverRevision: last && last.serverRevision,
      pending: state.outboxPending,
      sending: state.outboxSending
    })
    if (!last) {
      const err = new Error('没有可撤销的操作')
      err.code = 'UNDO_EMPTY'
      throw err
    }
    if (Number(state.outboxSending || 0) > 0 || state.pendingAcks.size > 0) {
      const err = new Error('请等待当前操作保存后再撤销')
      err.code = 'UNDO_PENDING'
      throw err
    }
    const ids = last.opIds && last.opIds.length ? last.opIds : [last.opId]
    let result = null
    try {
      for (let i = ids.length - 1; i >= 0; i--) {
        result = await submitOperation({
          type: 'operation.undo',
          payload: { targetOperationId: ids[i] },
          skipUndoStack: true
        })
      }
    } catch (err) {
      throw err
    }
    state.undoStack.pop()
    state.redoStack.push(last)
    return result
  }

  async function redo() {
    const last = state.redoStack[state.redoStack.length - 1]
    undoTrace('adapter.redo', {
      hasEntry: !!last,
      redoDepth: state.redoStack.length,
      opId: last && last.opId,
      type: last && last.type
    })
    if (!last) {
      const err = new Error('没有可重做的操作')
      err.code = 'REDO_EMPTY'
      throw err
    }
    if (Number(state.outboxSending || 0) > 0 || state.pendingAcks.size > 0) {
      const err = new Error('请等待当前操作保存后再重做')
      err.code = 'UNDO_PENDING'
      throw err
    }
    const ids = last.opIds && last.opIds.length ? last.opIds : [last.opId]
    let result = null
    try {
      for (let i = 0; i < ids.length; i++) {
        result = await submitOperation({
          type: 'operation.redo',
          payload: { targetOperationId: ids[i] },
          skipUndoStack: true
        })
      }
    } catch (err) {
      throw err
    }
    state.redoStack.pop()
    state.undoStack.push(last)
    return result
  }

  async function httpFallbackSync() {
    if (typeof options.httpSync !== 'function') return null
    return options.httpSync({
      roomKey: state.roomKey,
      afterRevision: state.lastServerRevision
    })
  }

  async function resync() {
    if (!state.roomKey) return
    setStatus(state.status, {
      saveState: 'saving',
      phase: 'RESYNCING',
      stage: STAGES.GAP_SYNC
    })
    let result = null
    if (socket) {
      try {
        result = await emitAck('sync', {
          roomKey: state.roomKey,
          afterRevision: state.lastServerRevision
        })
      } catch (err) {
        result = null
      }
    }
    if (!result || !result.ok) {
      result = await httpFallbackSync()
    }
    if (!result || result.ok === false) {
      const err = new Error((result && result.error) || 'sync failed')
      err.code = normalizeErrorCode(result && result.code, 'REVISION_GAP')
      recordError({
        code: err.code,
        message: err.message,
        stage: STAGES.GAP_SYNC,
        details: { afterRevision: state.lastServerRevision }
      })
      setStatus(state.status, { saveState: 'error', phase: 'ERROR' })
      throw err
    }
    let pages = 0
    const syncPages = []
    while (result && result.ok !== false) {
      if (result.reload) {
        advanceRevision(result.serverRevision || 0)
        state.snapshotRecoveryCount = Number(state.snapshotRecoveryCount || 0) + 1
        state.lastSyncAt = Date.now()
        state.lastSync = { pages: pages + 1, reload: true, syncPages }
        if (options.onReloadRequired) {
          await options.onReloadRequired({
            ...result,
            reason: 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
          })
        }
        await rebaseUnsent(state.lastServerRevision)
        setStatus('live', { saveState: 'saved', error: '', phase: 'LIVE' })
        return result
      }
      const fromRevision = Number(result.fromRevision || state.lastServerRevision || 0)
      const toRevision = Number(
        result.toRevision ||
          (result.operations && result.operations.length
            ? result.operations[result.operations.length - 1].serverRevision
            : fromRevision)
      )
      syncPages.push({
        fromRevision,
        toRevision,
        hasMore: !!result.hasMore,
        count: (result.operations || []).length
      })
      for (const op of result.operations || []) {
        await applyRemoteOperation(op, { fromSync: true })
        state.gapRecoveredOps = Number(state.gapRecoveredOps || 0) + 1
      }
      if (result.serverRevision) {
        state.serverRevision = Math.max(
          Number(state.serverRevision || 0),
          Number(result.serverRevision)
        )
      }
      pages += 1
      if (!result.hasMore || pages > 40) break
      result = socket
        ? await emitAck('sync', {
            roomKey: state.roomKey,
            afterRevision: state.lastServerRevision
          }).catch(() => null)
        : await httpFallbackSync()
      if (!result || result.ok === false) break
    }
    state.lastSync = {
      pages,
      fromRevision: syncPages[0] && syncPages[0].fromRevision,
      toRevision: syncPages.length
        ? syncPages[syncPages.length - 1].toRevision
        : state.lastServerRevision,
      hasMore: !!(syncPages.length && syncPages[syncPages.length - 1].hasMore),
      syncPages
    }
    state.lastSyncAt = Date.now()
    setStatus('live', { saveState: 'saved', error: '', phase: 'LIVE' })
    return result
  }

  function setPresence(next) {
    if (!socket || !isLive()) return
    socket.emit('presence', {
      roomKey: state.roomKey,
      ...next
    })
  }

  function updatePresence(patch) {
    setPresence(patch)
  }

  if (socket) bindSocket(socket)

  return {
    connect,
    disconnect,
    submitOperation,
    undo,
    undoLastLocalOperation: undo,
    redo,
    redoLastLocalOperation: redo,
    applyRemoteOperation,
    resync,
    setPresence,
    updatePresence,
    subscribe,
    getStatus,
    retryPending,
    dropPendingInsertsForUid,
    outbox,
    getClientId: () => state.clientId,
    getDebugState: getDiagnosticState,
    peekUndoTarget: () =>
      state.undoStack.length ? state.undoStack[state.undoStack.length - 1] : null,
    setLastServerRevision: value => {
      advanceRevision(value)
    }
  }
}

module.exports = { createCollaborationAdapter, sessionClientId }
