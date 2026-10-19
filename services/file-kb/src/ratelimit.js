'use strict'
// In-memory per-user limits (single file-kb replica). Counters reset on restart.
function createLimiter({ maxConcurrent = 4, perMinute = 120, now = () => Date.now() } = {}) {
  const active = new Map()
  const windows = new Map()
  const limitedUntil = new Map()
  return {
    acquire(userId) {
      const n = active.get(userId) || 0
      if (n >= maxConcurrent) return { ok: false, code: 'too_many_concurrent_uploads' }
      active.set(userId, n + 1)
      return { ok: true, release: () => { const m = (active.get(userId) || 1) - 1; if (m <= 0) active.delete(userId); else active.set(userId, m) } }
    },
    take(userId, count = 1) {
      const t = now()
      let w = windows.get(userId)
      if (!w || t - w.start >= 60000) { w = { start: t, n: 0 }; windows.set(userId, w); limitedUntil.delete(userId) }
      if (w.n + count > perMinute) { limitedUntil.set(userId, w.start + 60000); return false }
      w.n += count
      return true
    },
    retryAfterMs(userId) {
      const until = limitedUntil.get(userId)
      if (!until) return 15000
      return Math.max(1000, until - now())
    }
  }
}
module.exports = { createLimiter }
