function createRemoteRenderScheduler(options = {}) {
  const requestFrame =
    options.requestFrame ||
    (callback => {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
      return setTimeout(callback, 16)
    })
  const cancelFrame =
    options.cancelFrame ||
    (handle => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
      else clearTimeout(handle)
    })
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const maxWaitMs = Math.max(1, Number(options.maxWaitMs) || 50)
  const now = options.now || Date.now
  const isBackground = options.isBackground || (() => false)
  const onFlush = typeof options.onFlush === 'function' ? options.onFlush : () => {}
  const dirtyUids = new Set()
  let frameId = null
  let timerId = null
  let scheduledAt = 0

  function clearScheduled() {
    if (frameId != null) cancelFrame(frameId)
    if (timerId != null) clearTimer(timerId)
    frameId = null
    timerId = null
  }

  function flush(reason = 'scheduled') {
    if (frameId != null) cancelFrame(frameId)
    if (timerId != null) clearTimer(timerId)
    frameId = null
    timerId = null
    if (!dirtyUids.size) return false
    const payload = {
      dirtyUids: Array.from(dirtyUids),
      reason,
      delayMs: Math.max(0, now() - scheduledAt)
    }
    dirtyUids.clear()
    scheduledAt = 0
    onFlush(payload)
    return true
  }

  function schedule(uids) {
    const list = Array.isArray(uids) ? uids : [uids]
    list.forEach(uid => {
      if (uid != null && String(uid)) dirtyUids.add(String(uid))
    })
    if (!dirtyUids.size) dirtyUids.add('__remote__')
    if (frameId != null || timerId != null) return
    scheduledAt = now()
    if (!isBackground()) frameId = requestFrame(() => flush('frame'))
    timerId = setTimer(() => flush(isBackground() ? 'background-timeout' : 'max-wait'), maxWaitMs)
  }

  function cancel() {
    clearScheduled()
    dirtyUids.clear()
    scheduledAt = 0
  }

  return {
    schedule,
    flushNow: () => flush('immediate'),
    cancel,
    isPending: () => frameId != null || timerId != null,
    getPendingUids: () => Array.from(dirtyUids)
  }
}

module.exports = { createRemoteRenderScheduler }
