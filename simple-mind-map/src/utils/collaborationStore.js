/**
 * Client collaboration state machine for HTTP operation-log mode.
 * Keeps connection/version, pending optimistic ops, and a strict event buffer.
 */

import { createOperationId } from './operationId'

function now() {
  return Date.now()
}

function createId() {
  return createOperationId()
}

export function createCollaborationStore(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000)
  const maxPending = Math.max(10, Number(options.maxPending) || 200)
  const maxBuffer = Math.max(50, Number(options.maxBuffer) || 2000)
  const listeners = new Set()

  const state = {
    mapId: '',
    status: 'disconnected',
    lastAppliedVersion: 0,
    pendingOperations: new Map(),
    eventBuffer: new Map(),
    seenVersions: new Set(),
    retryTimers: new Map()
  }

  function emit() {
    const snap = getSnapshot()
    listeners.forEach(listener => {
      try {
        listener(snap)
      } catch (err) {
        // ignore listener errors
      }
    })
  }

  function clearRetry(operationId) {
    const timer = state.retryTimers.get(operationId)
    if (timer) clearTimeout(timer)
    state.retryTimers.delete(operationId)
  }

  function clearAllRetries() {
    state.retryTimers.forEach(timer => clearTimeout(timer))
    state.retryTimers.clear()
  }

  function getSnapshot() {
    const pending = []
    state.pendingOperations.forEach(item => {
      pending.push({
        operationId: item.operationId,
        type: item.type,
        status: item.status,
        attempts: item.attempts,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        error: item.error || null
      })
    })
    pending.sort((a, b) => a.createdAt - b.createdAt)
    return {
      mapId: state.mapId,
      status: state.status,
      lastAppliedVersion: state.lastAppliedVersion,
      pendingCount: pending.length,
      pendingOperations: pending,
      bufferedVersions: Array.from(state.eventBuffer.keys()).sort((a, b) => a - b)
    }
  }

  function reset(mapId = '', version = 0) {
    clearAllRetries()
    state.mapId = String(mapId || '')
    state.status = state.mapId ? 'connecting' : 'disconnected'
    state.lastAppliedVersion = Math.max(0, Number(version) || 0)
    state.pendingOperations.clear()
    state.eventBuffer.clear()
    state.seenVersions.clear()
    emit()
    return getSnapshot()
  }

  function setStatus(status) {
    const next = String(status || 'disconnected')
    if (state.status === next) return getSnapshot()
    state.status = next
    emit()
    return getSnapshot()
  }

  function setLastAppliedVersion(version) {
    const next = Number(version)
    if (!Number.isFinite(next) || next < 0) return getSnapshot()
    if (next > state.lastAppliedVersion) {
      state.lastAppliedVersion = next
      emit()
    }
    return getSnapshot()
  }

  function trackPending(input = {}) {
    const operationId = String(input.operationId || createId())
    while (state.pendingOperations.size >= maxPending) {
      const oldest = state.pendingOperations.keys().next().value
      clearRetry(oldest)
      state.pendingOperations.delete(oldest)
    }
    const entry = {
      operationId,
      type: String(input.type || 'unknown'),
      payload: input.payload || null,
      rollback: typeof input.rollback === 'function' ? input.rollback : null,
      send: typeof input.send === 'function' ? input.send : null,
      status: 'pending',
      attempts: Math.max(1, Number(input.attempts) || 1),
      createdAt: now(),
      updatedAt: now(),
      error: null
    }
    state.pendingOperations.set(operationId, entry)
    scheduleTimeout(operationId)
    emit()
    return entry
  }

  function scheduleTimeout(operationId) {
    clearRetry(operationId)
    const timer = setTimeout(() => {
      state.retryTimers.delete(operationId)
      const entry = state.pendingOperations.get(operationId)
      if (!entry || entry.status !== 'pending') return
      if (entry.send && entry.attempts < 3) {
        entry.attempts += 1
        entry.updatedAt = now()
        entry.error = 'timeout_retry'
        emit()
        scheduleTimeout(operationId)
        return
      }
      rejectPending(operationId, new Error('operation timeout'))
    }, timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    state.retryTimers.set(operationId, timer)
  }

  function confirmPending(operationId, version, extra = {}) {
    const id = String(operationId || '')
    const entry = state.pendingOperations.get(id)
    clearRetry(id)
    if (entry) {
      entry.status = 'confirmed'
      entry.updatedAt = now()
      entry.error = null
      state.pendingOperations.delete(id)
    }
    const next = Number(version)
    if (Number.isFinite(next) && next > 0) {
      if (!state.seenVersions.has(next)) state.seenVersions.add(next)
      if (next > state.lastAppliedVersion) state.lastAppliedVersion = next
    }
    emit()
    return { confirmed: !!entry, version: state.lastAppliedVersion, extra }
  }

  function rejectPending(operationId, error) {
    const id = String(operationId || '')
    const entry = state.pendingOperations.get(id)
    clearRetry(id)
    if (!entry) return { rejected: false }
    entry.status = 'rejected'
    entry.updatedAt = now()
    entry.error = error && error.message ? error.message : String(error || 'rejected')
    state.pendingOperations.delete(id)
    let rolledBack = false
    if (entry.rollback) {
      try {
        entry.rollback(error)
        rolledBack = true
      } catch (err) {
        // ignore rollback failures
      }
    }
    emit()
    return { rejected: true, rolledBack, error: entry.error }
  }

  function enqueueRemoteEvent(event = {}) {
    const version = Number(event.version)
    if (!Number.isFinite(version) || version <= 0) {
      return { accepted: false, reason: 'bad_version' }
    }
    if (version <= state.lastAppliedVersion || state.seenVersions.has(version)) {
      return { accepted: false, reason: 'duplicate_or_old' }
    }
    if (state.eventBuffer.size >= maxBuffer) {
      const first = Array.from(state.eventBuffer.keys()).sort((a, b) => a - b)[0]
      state.eventBuffer.delete(first)
    }
    state.eventBuffer.set(version, event)
    state.seenVersions.add(version)
    emit()
    return { accepted: true, version }
  }

  function drainReadyEvents() {
    const ready = []
    let cursor = state.lastAppliedVersion + 1
    while (state.eventBuffer.has(cursor)) {
      ready.push(state.eventBuffer.get(cursor))
      state.eventBuffer.delete(cursor)
      state.lastAppliedVersion = cursor
      cursor += 1
    }
    if (ready.length) emit()
    return ready
  }

  function hasGapBefore(version) {
    const target = Number(version)
    if (!Number.isFinite(target) || target <= state.lastAppliedVersion + 1) return false
    for (let v = state.lastAppliedVersion + 1; v < target; v++) {
      if (!state.eventBuffer.has(v) && !state.seenVersions.has(v)) return true
    }
    return !state.eventBuffer.has(state.lastAppliedVersion + 1)
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getPending(operationId) {
    return state.pendingOperations.get(String(operationId || '')) || null
  }

  return {
    createId,
    reset,
    setStatus,
    setLastAppliedVersion,
    trackPending,
    confirmPending,
    rejectPending,
    enqueueRemoteEvent,
    drainReadyEvents,
    hasGapBefore,
    subscribe,
    getSnapshot,
    getPending
  }
}

export default createCollaborationStore
