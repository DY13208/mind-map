const os = require('os')

function startAutoVersionWorker(engine, options = {}) {
  if (!engine || typeof engine.processDueAutoJobs !== 'function') {
    return { stop() {} }
  }
  const interval = Math.max(1000, Number(options.intervalMs || engine.config.autoJobPollMs || 5000))
  let stopped = false
  let running = false
  async function tick() {
    if (stopped || running) return
    running = true
    try {
      await engine.processDueAutoJobs(Date.now())
    } catch (err) {
      console.error('[history] auto job', err && err.message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => {
    tick().catch(() => {})
  }, interval)
  if (timer.unref) timer.unref()
  setImmediate(() => {
    tick().catch(() => {})
  })
  return {
    tick,
    stop() {
      stopped = true
      clearInterval(timer)
    },
    workerId: options.workerId || os.hostname()
  }
}

module.exports = { startAutoVersionWorker }
