const { fromCommitted } = require('./protocol')

const SUPPORTED_EVENT_TYPES = new Set([
  'map.updated',
  'node.inserted',
  'node.updated',
  'node.moved',
  'node.reordered',
  'node.deleted',
  'node.restored',
  'batch.applied',
  'operation.undone',
  'operation.redone'
])

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function roomKeyOf(value) {
  const key = String(value || '').trim()
  return key && key.length <= 255 ? key : ''
}

function operationVersion(operation) {
  return nonNegativeInteger(operation && (operation.version || operation.serverRevision), 0)
}

function isIncrementalEvent(event, depth = 0, budget = { remaining: 2001 }) {
  if (!event || typeof event !== 'object' || depth > 4 || --budget.remaining < 0) return false
  const payload = event.payload || {}
  if (event.resnapshot === true || payload.resnapshot === true) return false
  if (!SUPPORTED_EVENT_TYPES.has(String(event.type || ''))) return false
  if (event.type !== 'batch.applied') return true
  // A batch carries committed child events, never replays the original requests
  // (which may contain failed MCP items). Unsupported children require recovery.
  return Array.isArray(payload.events) && payload.events.length <= 1000 &&
    payload.events.every(child => isIncrementalEvent(child, depth + 1, budget))
}

function requiresSnapshot(operation, clientOperation) {
  const event = (operation && operation.event) || {}
  const payload = event.payload || {}
  if (
    event.resnapshot === true ||
    payload.resnapshot === true ||
    event.type === 'map.replaced' ||
    clientOperation.type === 'map.replaced'
  ) return true
  return !isIncrementalEvent({ type: clientOperation.type, payload: clientOperation.payload })
}

function createOperationEventBridge(options = {}) {
  const {
    bus,
    io,
    listRoomOperationsContiguous,
    listActiveRoomHeads,
    getActiveRoomKeys,
    invalidateRoomState
  } = options
  const intervalMs = Math.max(250, nonNegativeInteger(options.intervalMs, 1000))
  const pageSize = Math.max(1, Math.min(500, nonNegativeInteger(options.pageSize, 100)))

  if (!bus || typeof bus.subscribe !== 'function') throw new TypeError('bus.subscribe is required')
  if (!io || typeof io.to !== 'function') throw new TypeError('io.to is required')
  if (typeof listRoomOperationsContiguous !== 'function') {
    throw new TypeError('listRoomOperationsContiguous is required')
  }
  if (typeof listActiveRoomHeads !== 'function') throw new TypeError('listActiveRoomHeads is required')
  if (typeof getActiveRoomKeys !== 'function') throw new TypeError('getActiveRoomKeys is required')

  const cursors = new Map()
  const inFlight = new Map()
  const pendingRooms = new Set()
  const recentWakeups = new Map()
  const pendingWakeupsByRoom = new Map()
  const recentLimit = 2048
  let running = false
  let unsubscribe = null
  let timer = null
  let reconciliation = null
  let listenerHealthy = false
  let lastBusHealthy = null
  let lastErrorCode = ''
  let lastHeadCheckAt = 0
  let laggingRoomsCount = 0

  const metrics = {
    notifications: 0,
    duplicateNotifications: 0,
    compensationRuns: 0,
    operationsSent: 0,
    resnapshotRequests: 0,
    unsupportedEvents: 0,
    failedDrains: 0,
    skippedDuplicateWakeups: 0,
    emptyDrains: 0,
    headChecks: 0,
    listenerRestarts: 0
  }

  function readBusStatus() {
    try {
      return typeof bus.status === 'function'
        ? bus.status() || {}
        : { name: bus.name || 'unknown' }
    } catch (err) {
      return { name: bus.name || 'unknown', ok: false }
    }
  }

  function refreshListenerHealth() {
    const current = readBusStatus()
    const healthy = current.ok !== false
    if (lastBusHealthy === false && healthy) metrics.listenerRestarts += 1
    lastBusHealthy = healthy
    listenerHealthy = !!unsubscribe && healthy
  }

  function wakeupSignature(event, roomKey) {
    if (!event || event.version == null || String(event.version).trim() === '') return ''
    const parsedVersion = Number(event.version)
    const operationId = String(event.operationId || '').trim()
    if (!Number.isFinite(parsedVersion) || parsedVersion < 0 || !operationId) return ''
    return JSON.stringify([roomKey, Math.floor(parsedVersion), operationId])
  }

  function trimRecentWakeups() {
    if (recentWakeups.size < recentLimit) return true
    for (const [signature, wakeup] of recentWakeups) {
      if (wakeup.pending) continue
      recentWakeups.delete(signature)
      if (recentWakeups.size < recentLimit) return true
    }
    return recentWakeups.size < recentLimit
  }

  function markWakeup(event, roomKey) {
    const signature = wakeupSignature(event, roomKey)
    if (signature) {
      const existing = recentWakeups.get(signature)
      if (existing) {
        metrics.duplicateNotifications += 1
        metrics.skippedDuplicateWakeups += 1
        if (existing.pending) existing.retryRequested = true
        return { duplicate: true, signature }
      }
      if (trimRecentWakeups()) {
        recentWakeups.set(signature, {
          roomKey,
          pending: true,
          retryRequested: false
        })
      } else {
        // Keep every wakeup live while bounding dedupe bookkeeping under pressure.
        metrics.notifications += 1
        return { duplicate: false, signature: '' }
      }
    }
    metrics.notifications += 1
    return { duplicate: false, signature }
  }

  function trackWakeup(roomKey, signature) {
    if (!signature) return
    let signatures = pendingWakeupsByRoom.get(roomKey)
    if (!signatures) {
      signatures = new Set()
      pendingWakeupsByRoom.set(roomKey, signatures)
    }
    signatures.add(signature)
  }

  function finishRoomWakeups(roomKey, succeeded) {
    const signatures = pendingWakeupsByRoom.get(roomKey)
    if (!signatures) return
    pendingWakeupsByRoom.delete(roomKey)

    const retrySignatures = []
    for (const signature of signatures) {
      const wakeup = recentWakeups.get(signature)
      if (!wakeup) continue
      if (succeeded) {
        wakeup.pending = false
        wakeup.retryRequested = false
      } else if (wakeup.retryRequested && running) {
        wakeup.pending = true
        wakeup.retryRequested = false
        retrySignatures.push(signature)
      } else {
        recentWakeups.delete(signature)
      }
    }

    if (retrySignatures.length) {
      for (const signature of retrySignatures) trackWakeup(roomKey, signature)
      Promise.resolve().then(() => {
        if (running && !inFlight.has(roomKey)) drainRoom(roomKey).catch(() => {})
      })
    }
  }

  function emitResnapshotRequired(roomKey, headVersion, details = {}) {
    const head = nonNegativeInteger(headVersion, 0)
    const payload = {
      roomKey,
      code: 'RESNAPSHOT_REQUIRED',
      reload: true,
      currentVersion: head,
      currentRevision: head,
      serverRevision: head,
      completeFromRevision: head,
      reason: details.reason || 'VERSION_GAP'
    }
    if (details.missingVersion != null) {
      payload.missingVersion = nonNegativeInteger(details.missingVersion, 0)
    }
    io.to('v2:' + roomKey).emit('sync:resnapshot-required', payload)
    metrics.resnapshotRequests += 1
    if (details.reason === 'UNSUPPORTED_OPERATION') metrics.unsupportedEvents += 1
    cursors.set(roomKey, head)
  }

  async function readHead(roomKey) {
    const rows = await listActiveRoomHeads([roomKey])
    const row = Array.isArray(rows) ? rows.find(item => roomKeyOf(item && item.roomKey) === roomKey) : null
    return row ? nonNegativeInteger(row.headVersion, 0) : null
  }

  async function drainToHead(roomKey, requestedHead) {
    let headVersion = requestedHead == null ? await readHead(roomKey) : nonNegativeInteger(requestedHead, 0)
    if (headVersion == null) return { empty: false }
    metrics.compensationRuns += 1
    let sentOperations = 0

    let afterVersion = nonNegativeInteger(cursors.get(roomKey), 0)
    while (running && afterVersion < headVersion) {
      const page = await listRoomOperationsContiguous(roomKey, afterVersion, {
        headVersion,
        limit: pageSize
      })
      if (!page || page.reload || page.ok === false) {
        emitResnapshotRequired(roomKey, page && (page.currentRevision || page.currentVersion) || headVersion, {
          reason: (page && page.reason) || 'VERSION_GAP',
          missingVersion: page && page.missingVersion
        })
        return { empty: false }
      }

      const operations = Array.isArray(page.operations) ? page.operations : []
      if (Number(page.fromVersion) !== afterVersion || !operations.length) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return { empty: false }
      }

      for (const committed of operations) {
        const version = operationVersion(committed)
        if (version !== afterVersion + 1 || version > headVersion) {
          emitResnapshotRequired(roomKey, headVersion, {
            reason: 'VERSION_GAP',
            missingVersion: afterVersion + 1
          })
          return { empty: false }
        }
        const operation = fromCommitted(committed, { roomKey })
        if (requiresSnapshot(committed, operation)) {
          emitResnapshotRequired(roomKey, headVersion, { reason: 'UNSUPPORTED_OPERATION' })
          return { empty: false }
        }
        if (typeof invalidateRoomState === 'function') {
          await invalidateRoomState(roomKey, version)
        }
        io.to('v2:' + roomKey).emit('op:event', operation)
        afterVersion = version
        cursors.set(roomKey, afterVersion)
        metrics.operationsSent += 1
        sentOperations += 1
      }

      const toVersion = nonNegativeInteger(page.toVersion, afterVersion)
      if (toVersion !== afterVersion) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return { empty: false }
      }
      if (afterVersion >= headVersion) {
        return { empty: sentOperations === 0 }
      }
      if (!page.hasMore) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return { empty: false }
      }
    }
    return { empty: sentOperations === 0 }
  }

  function drainRoom(roomKey, requestedHead) {
    const key = roomKeyOf(roomKey)
    if (!running || !key || !cursors.has(key)) return Promise.resolve()
    if (inFlight.has(key)) {
      pendingRooms.add(key)
      return inFlight.get(key)
    }
    let succeeded = true
    const task = (async () => {
      try {
        let nextHead = requestedHead
        do {
          pendingRooms.delete(key)
          const outcome = await drainToHead(key, nextHead)
          if (outcome && outcome.empty) metrics.emptyDrains += 1
          nextHead = undefined
        } while (running && pendingRooms.has(key))
      } catch (err) {
        succeeded = false
        metrics.failedDrains += 1
        lastErrorCode = String((err && err.code) || 'EVENT_DRAIN_FAILED').slice(0, 80)
      } finally {
        inFlight.delete(key)
        finishRoomWakeups(key, succeeded)
      }
      return succeeded
    })()
    inFlight.set(key, task)
    return task
  }

  async function reconcileActiveHeads() {
    if (!running || reconciliation) return reconciliation
    reconciliation = (async () => {
      refreshListenerHealth()
      const rawKeys = await getActiveRoomKeys()
      const keys = Array.from(new Set((rawKeys || []).map(roomKeyOf).filter(Boolean)))
      lastHeadCheckAt = Date.now()
      metrics.headChecks += 1
      const active = new Set(keys)
      for (const roomKey of cursors.keys()) {
        if (!active.has(roomKey) && !inFlight.has(roomKey)) {
          cursors.delete(roomKey)
          pendingRooms.delete(roomKey)
          clearRoomWakeups(roomKey)
        }
      }
      if (!keys.length) {
        laggingRoomsCount = 0
        return
      }
      const rows = await listActiveRoomHeads(keys)
      const heads = Array.isArray(rows) ? rows : []
      laggingRoomsCount = 0
      for (const row of heads) {
        const roomKey = roomKeyOf(row && row.roomKey)
        if (!roomKey || !active.has(roomKey) || !cursors.has(roomKey)) continue
        const headVersion = nonNegativeInteger(row.headVersion, 0)
        if (headVersion > Number(cursors.get(roomKey) || 0)) {
          laggingRoomsCount += 1
          drainRoom(roomKey, headVersion)
        }
      }
    })()
      .catch(err => {
        metrics.failedDrains += 1
        lastErrorCode = String((err && err.code) || 'HEAD_RECONCILIATION_FAILED').slice(0, 80)
      })
      .finally(() => {
        reconciliation = null
      })
    return reconciliation
  }

  function clearRoomWakeups(roomKey) {
    pendingWakeupsByRoom.delete(roomKey)
    for (const [signature, wakeup] of recentWakeups) {
      if (wakeup.roomKey === roomKey) recentWakeups.delete(signature)
    }
  }

  function onBusEvent(event) {
    const roomKey = roomKeyOf(event && (event.mapId || event.roomKey))
    if (!roomKey || !cursors.has(roomKey)) return
    const wakeup = markWakeup(event, roomKey)
    if (wakeup.duplicate) return
    trackWakeup(roomKey, wakeup.signature)
    drainRoom(roomKey).catch(() => {})
  }

  async function start() {
    if (running) return status()
    running = true
    listenerHealthy = false
    try {
      unsubscribe = bus.subscribe(onBusEvent)
      refreshListenerHealth()
    } catch (err) {
      lastErrorCode = String((err && err.code) || 'EVENT_LISTENER_FAILED').slice(0, 80)
      throw err
    }
    timer = setInterval(() => {
      reconcileActiveHeads().catch(() => {})
    }, intervalMs)
    if (timer.unref) timer.unref()
    await reconcileActiveHeads()
    return status()
  }

  async function stop() {
    running = false
    if (timer) clearInterval(timer)
    timer = null
    if (typeof unsubscribe === 'function') unsubscribe()
    unsubscribe = null
    listenerHealthy = false
    pendingRooms.clear()
    await Promise.allSettled(Array.from(inFlight.values()))
    inFlight.clear()
    pendingWakeupsByRoom.clear()
    recentWakeups.clear()
    return status()
  }

  function activateRoom(roomKey, initialRevision) {
    const key = roomKeyOf(roomKey)
    if (!key) return null
    if (!cursors.has(key)) cursors.set(key, nonNegativeInteger(initialRevision, 0))
    drainRoom(key).catch(() => {})
    return Number(cursors.get(key) || 0)
  }

  function status() {
    const busStatus = readBusStatus()
    const busHealthy = busStatus.ok !== false
    refreshListenerHealth()
    return {
      enabled: running,
      listenerHealthy: running && listenerHealthy && busHealthy,
      bus: { name: String(busStatus.name || bus.name || 'unknown'), ok: busHealthy },
      activeRooms: cursors.size,
      pendingDrains: inFlight.size,
      queueLength: pendingRooms.size,
      laggingRooms: laggingRoomsCount,
      lastHeadCheckAt,
      lastErrorCode,
      duplicateRatio: metrics.duplicateNotifications /
        (metrics.notifications + metrics.duplicateNotifications || 1),
      ...metrics
    }
  }

  return { start, stop, status, activateRoom }
}

module.exports = { createOperationEventBridge, SUPPORTED_EVENT_TYPES }
