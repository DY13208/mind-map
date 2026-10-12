const { fromCommitted } = require('./protocol')

const SUPPORTED_EVENT_TYPES = new Set([
  'map.updated',
  'node.inserted',
  'node.updated',
  'node.moved',
  'node.reordered',
  'node.deleted',
  'node.restored',
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

function requiresSnapshot(operation, clientOperation) {
  const event = (operation && operation.event) || {}
  const payload = event.payload || {}
  if (
    event.resnapshot === true ||
    payload.resnapshot === true ||
    event.type === 'map.replaced' ||
    clientOperation.type === 'map.replaced'
  ) return true
  return !SUPPORTED_EVENT_TYPES.has(String(clientOperation.type || ''))
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

  function markWakeup(event, roomKey) {
    const version = nonNegativeInteger(event && event.version, 0)
    const operationId = String((event && event.operationId) || '')
    const signature = version || operationId ? `${roomKey}:${version}:${operationId}` : ''
    if (signature && recentWakeups.has(signature)) {
      metrics.duplicateNotifications += 1
      return
    }
    metrics.notifications += 1
    if (signature) {
      recentWakeups.set(signature, Date.now())
      if (recentWakeups.size > recentLimit) {
        recentWakeups.delete(recentWakeups.keys().next().value)
      }
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
    if (headVersion == null) return
    metrics.compensationRuns += 1

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
        return
      }

      const operations = Array.isArray(page.operations) ? page.operations : []
      if (Number(page.fromVersion) !== afterVersion || !operations.length) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return
      }

      for (const committed of operations) {
        const version = operationVersion(committed)
        if (version !== afterVersion + 1 || version > headVersion) {
          emitResnapshotRequired(roomKey, headVersion, {
            reason: 'VERSION_GAP',
            missingVersion: afterVersion + 1
          })
          return
        }
        const operation = fromCommitted(committed, { roomKey })
        if (requiresSnapshot(committed, operation)) {
          emitResnapshotRequired(roomKey, headVersion, { reason: 'UNSUPPORTED_OPERATION' })
          return
        }
        if (typeof invalidateRoomState === 'function') {
          await invalidateRoomState(roomKey, version)
        }
        io.to('v2:' + roomKey).emit('op:event', operation)
        afterVersion = version
        cursors.set(roomKey, afterVersion)
        metrics.operationsSent += 1
      }

      const toVersion = nonNegativeInteger(page.toVersion, afterVersion)
      if (toVersion !== afterVersion) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return
      }
      if (afterVersion >= headVersion) return
      if (!page.hasMore) {
        emitResnapshotRequired(roomKey, headVersion, {
          reason: 'VERSION_GAP',
          missingVersion: afterVersion + 1
        })
        return
      }
    }
  }

  function drainRoom(roomKey, requestedHead) {
    const key = roomKeyOf(roomKey)
    if (!running || !key || !cursors.has(key)) return Promise.resolve()
    if (inFlight.has(key)) {
      pendingRooms.add(key)
      return inFlight.get(key)
    }
    const task = (async () => {
      let nextHead = requestedHead
      do {
        pendingRooms.delete(key)
        await drainToHead(key, nextHead)
        nextHead = undefined
      } while (running && pendingRooms.has(key))
    })()
      .catch(err => {
        metrics.failedDrains += 1
        lastErrorCode = String((err && err.code) || 'EVENT_DRAIN_FAILED').slice(0, 80)
      })
      .finally(() => {
        inFlight.delete(key)
      })
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

  function onBusEvent(event) {
    const roomKey = roomKeyOf(event && (event.mapId || event.roomKey))
    if (!roomKey || !cursors.has(roomKey)) return
    markWakeup(event, roomKey)
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
      ...metrics
    }
  }

  return { start, stop, status, activateRoom }
}

module.exports = { createOperationEventBridge, SUPPORTED_EVENT_TYPES }
