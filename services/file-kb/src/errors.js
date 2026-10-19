'use strict'

// Matches the frontend upload queue bases. Retry-After is the real wait for
// this limiter, not a fixed 1s placeholder.
const RETRY_AFTER_MS = {
  too_many_concurrent_uploads: 3000,
  rate_limited: 15000,
  queue_full: 20000
}

function retryAfterMsFor(code, override) {
  const value = Number(override)
  if (Number.isFinite(value) && value > 0) return Math.min(60000, Math.round(value))
  return RETRY_AFTER_MS[code] || 10000
}

function httpError(status, code, message) {
  const err = new Error(message || code)
  err.status = status
  err.code = code
  if (status === 429) err.retryAfterMs = retryAfterMsFor(code)
  return err
}

module.exports = { httpError, retryAfterMsFor, RETRY_AFTER_MS }
