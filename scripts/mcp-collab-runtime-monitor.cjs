'use strict'

const { performance, monitorEventLoopDelay } = require('node:perf_hooks')

const DEFAULT_TIMER_INTERVAL_MS = 100
const DEFAULT_HISTOGRAM_RESOLUTION_MS = 20
const MAX_RETAINED_TIMER_SAMPLES = 30000

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function finiteMs(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number / 1e6 : null
}

function createRuntimeMonitor(source, options = {}) {
  const timerIntervalMs = Number.isFinite(options.timerIntervalMs) && options.timerIntervalMs > 0
    ? options.timerIntervalMs : DEFAULT_TIMER_INTERVAL_MS
  const histogramResolutionMs = Number.isFinite(options.histogramResolutionMs) && options.histogramResolutionMs >= 10
    ? options.histogramResolutionMs : DEFAULT_HISTOGRAM_RESOLUTION_MS
  const histogram = monitorEventLoopDelay({ resolution: histogramResolutionMs })
  const startedAt = performance.now()
  const timerLatenessSamplesMs = []
  let timerCallbackCount = 0
  let missedTimerIntervals = 0
  let nextTimerDueAt = startedAt + timerIntervalMs
  let stopped = false
  let stoppedResult = null

  histogram.enable()
  const timer = setInterval(() => {
    const now = performance.now()
    const latenessMs = Math.max(0, now - nextTimerDueAt)
    timerCallbackCount += 1
    if (timerLatenessSamplesMs.length < MAX_RETAINED_TIMER_SAMPLES) timerLatenessSamplesMs.push(latenessMs)
    const missed = Math.floor(latenessMs / timerIntervalMs)
    missedTimerIntervals += missed
    nextTimerDueAt += (missed + 1) * timerIntervalMs
  }, timerIntervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop() {
      if (stopped) return stoppedResult
      stopped = true
      clearInterval(timer)
      const endedAt = performance.now()
      histogram.disable()
      const eventLoopSampleCount = Number(histogram.count) || 0
      const histogramMetric = (percentileValue) => eventLoopSampleCount
        ? finiteMs(histogram.percentile(percentileValue)) : null
      const sorted = timerLatenessSamplesMs.slice().sort((left, right) => left - right)
      stoppedResult = {
        source: String(source || 'unknown'),
        observedDurationMs: Number((endedAt - startedAt).toFixed(3)),
        eventLoopDelay: {
          definition: 'Node perf_hooks.monitorEventLoopDelay histogram in milliseconds; sampleCount is histogram.count.',
          resolutionMs: histogramResolutionMs,
          sampleCount: eventLoopSampleCount,
          minMs: eventLoopSampleCount ? finiteMs(histogram.min) : null,
          meanMs: eventLoopSampleCount ? finiteMs(histogram.mean) : null,
          p50Ms: histogramMetric(50),
          p95Ms: histogramMetric(95),
          p99Ms: histogramMetric(99),
          maxMs: eventLoopSampleCount ? finiteMs(histogram.max) : null
        },
        timerLateness: {
          definition: 'Nonnegative lateness of each observed timer callback versus its monotonic expected due time; missedIntervals counts skipped timer periods.',
          intervalMs: timerIntervalMs,
          sampleCount: timerLatenessSamplesMs.length,
          callbackCount: timerCallbackCount,
          droppedSampleCount: timerCallbackCount - timerLatenessSamplesMs.length,
          missedIntervals: missedTimerIntervals,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          p99Ms: percentile(sorted, 0.99),
          maxMs: sorted.length ? sorted[sorted.length - 1] : null
        }
      }
      return stoppedResult
    }
  }
}

module.exports = { createRuntimeMonitor }
