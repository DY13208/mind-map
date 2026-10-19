'use strict'
class BreakerOpenError extends Error {
  constructor(retryInMs) { super('docling circuit breaker open'); this.code = 'BREAKER_OPEN'; this.retryInMs = retryInMs }
}
// Consecutive-failure breaker: threshold failures => open for openMs, then half-open (one trial).
function createBreaker({ threshold = 5, openMs = 60000, now = () => Date.now() } = {}) {
  let failures = 0
  let openUntil = 0
  let halfOpenInFlight = false
  return {
    before() {
      const t = now()
      if (openUntil > t) throw new BreakerOpenError(openUntil - t)
      if (openUntil && !halfOpenInFlight) { halfOpenInFlight = true; return }
      if (openUntil && halfOpenInFlight) throw new BreakerOpenError(1000)
    },
    success() { failures = 0; openUntil = 0; halfOpenInFlight = false },
    failure() {
      failures++
      halfOpenInFlight = false
      if (failures >= threshold || openUntil) openUntil = now() + openMs
    },
    state() {
      const t = now()
      return { failures, open: openUntil > t, retryInMs: Math.max(0, openUntil - t) }
    }
  }
}
module.exports = { createBreaker, BreakerOpenError }
