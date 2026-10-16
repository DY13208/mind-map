'use strict'

const DEFAULTS = Object.freeze({
  maxGlobal: 4,
  maxPerRoom: 1,
  maxQueuedGlobal: 1000,
  maxQueuedPerRoom: 100,
  maxWaitMs: 30000,
  maxQueuedBytes: 64 * 1024 * 1024
})

function gateError(code, message, retryAfterMs = 1000) {
  const error = new Error(message)
  error.code = code
  error.statusCode = 503
  error.retryAfterMs = Math.max(1, Number(retryAfterMs) || 1000)
  return error
}

function abortError() {
  const error = new Error('MCP 写入排队已取消')
  error.name = 'AbortError'
  error.code = 'MCP_WRITE_ABORTED'
  return error
}

function createMcpSubmitGate(options = {}) {
  const config = { ...DEFAULTS, ...(options || {}) }
  const activeByRoom = new Map()
  const queue = []
  let activeGlobal = 0
  let queuedBytes = 0
  const metrics = {
    submitted: 0,
    started: 0,
    completed: 0,
    failed: 0,
    queued: 0,
    rejected: 0,
    timedOut: 0,
    cancelled: 0,
    queueHighWater: 0,
    queuedBytesHighWater: 0
  }

  function activeRoom(roomKey) {
    return activeByRoom.get(roomKey) || 0
  }

  function removeWaiter(waiter) {
    const index = queue.indexOf(waiter)
    if (index < 0) return false
    queue.splice(index, 1)
    queuedBytes = Math.max(0, queuedBytes - waiter.estimatedBytes)
    waiter.estimatedBytes = 0
    waiter.task = null
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort)
    }
    return true
  }

  function settleStarted(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort)
    }
    queuedBytes = Math.max(0, queuedBytes - waiter.estimatedBytes)
    waiter.estimatedBytes = 0
    const task = waiter.task
    waiter.task = null
    activeGlobal += 1
    metrics.started += 1
    activeByRoom.set(waiter.roomKey, activeRoom(waiter.roomKey) + 1)
    Promise.resolve()
      .then(task)
      .then(
        value => {
          metrics.completed += 1
          waiter.resolve(value)
        },
        error => {
          metrics.failed += 1
          waiter.reject(error)
        }
      )
      .finally(() => {
        activeGlobal = Math.max(0, activeGlobal - 1)
        const next = activeRoom(waiter.roomKey) - 1
        if (next > 0) activeByRoom.set(waiter.roomKey, next)
        else activeByRoom.delete(waiter.roomKey)
        pump()
      })
  }

  function canStart(waiter) {
    return (
      activeGlobal < config.maxGlobal &&
      activeRoom(waiter.roomKey) < config.maxPerRoom
    )
  }

  function pump() {
    for (let i = 0; i < queue.length && activeGlobal < config.maxGlobal; ) {
      const waiter = queue[i]
      if (!canStart(waiter)) {
        i += 1
        continue
      }
      queue.splice(i, 1)
      settleStarted(waiter)
    }
  }

  function run(roomKey, task, runOptions = {}) {
    const key = String(roomKey || '')
    const signal = runOptions.signal
    metrics.submitted += 1
    if (signal && signal.aborted) {
      metrics.cancelled += 1
      return Promise.reject(abortError())
    }
    if (activeGlobal < config.maxGlobal && activeRoom(key) < config.maxPerRoom) {
      const waiter = { roomKey: key, task, resolve: null, reject: null, estimatedBytes: 0 }
      return new Promise((resolve, reject) => {
        waiter.resolve = resolve
        waiter.reject = reject
        settleStarted(waiter)
      })
    }

    const perRoomQueued = queue.reduce((sum, item) => sum + (item.roomKey === key ? 1 : 0), 0)
    const estimatedBytes = Math.max(0, Math.ceil(Number(runOptions.estimatedBytes) || 0))
    if (
      queue.length >= config.maxQueuedGlobal ||
      perRoomQueued >= config.maxQueuedPerRoom ||
      queuedBytes + estimatedBytes > config.maxQueuedBytes
    ) {
      metrics.rejected += 1
      return Promise.reject(gateError('MCP_WRITE_BUSY', 'MCP 写入队列繁忙，请稍后重试'))
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        roomKey: key,
        task,
        resolve,
        reject,
        signal,
        estimatedBytes,
        timer: null,
        abort: null
      }
      waiter.timer = setTimeout(() => {
        if (!removeWaiter(waiter)) return
        metrics.timedOut += 1
        reject(gateError('MCP_WRITE_QUEUE_TIMEOUT', 'MCP 写入排队超时，请使用相同 operation_id 重试'))
      }, Math.max(1, Number(config.maxWaitMs) || DEFAULTS.maxWaitMs))
      waiter.abort = () => {
        if (!removeWaiter(waiter)) return
        metrics.cancelled += 1
        reject(abortError())
      }
      if (signal) signal.addEventListener('abort', waiter.abort, { once: true })
      queue.push(waiter)
      metrics.queued += 1
      queuedBytes += estimatedBytes
      metrics.queueHighWater = Math.max(metrics.queueHighWater, queue.length)
      metrics.queuedBytesHighWater = Math.max(metrics.queuedBytesHighWater, queuedBytes)
      pump()
    })
  }

  function status() {
    const queuedByRoom = {}
    for (const item of queue) queuedByRoom[item.roomKey] = (queuedByRoom[item.roomKey] || 0) + 1
    return {
      activeGlobal,
      activeByRoom: Object.fromEntries(activeByRoom),
      queuedGlobal: queue.length,
      queuedByRoom,
      queuedBytes,
      queuedBytesLimit: config.maxQueuedBytes,
      limits: { ...config },
      metrics: { ...metrics }
    }
  }

  return { run, status }
}

module.exports = { createMcpSubmitGate, DEFAULTS }
