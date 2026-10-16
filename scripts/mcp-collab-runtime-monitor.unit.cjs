'use strict'

const assert = require('node:assert/strict')
const { createRuntimeMonitor } = require('./mcp-collab-runtime-monitor.cjs')

async function main() {
  const empty = createRuntimeMonitor('empty-monitor-unit', { timerIntervalMs: 500, histogramResolutionMs: 10 }).stop()
  assert.equal(empty.timerLateness.sampleCount, 0)
  assert.equal(empty.timerLateness.p95Ms, null)
  assert.equal(empty.timerLateness.maxMs, null)
  if (empty.eventLoopDelay.sampleCount === 0) {
    assert.equal(empty.eventLoopDelay.p95Ms, null)
    assert.equal(empty.eventLoopDelay.maxMs, null)
  }

  const monitor = createRuntimeMonitor('runtime-monitor-unit', { timerIntervalMs: 20, histogramResolutionMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 80))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
  await new Promise(resolve => setTimeout(resolve, 80))
  const result = monitor.stop()
  assert.equal(result.source, 'runtime-monitor-unit')
  assert(result.observedDurationMs >= 250)
  assert.match(result.eventLoopDelay.definition, /monitorEventLoopDelay/)
  assert(result.eventLoopDelay.sampleCount > 0, 'histogram sample count must be explicit and nonzero')
  assert(Number.isFinite(result.eventLoopDelay.maxMs) && result.eventLoopDelay.maxMs >= 80,
    `event-loop delay should capture the controlled blocking interval: ${result.eventLoopDelay.maxMs}`)
  assert.match(result.timerLateness.definition, /expected due time/)
  assert(result.timerLateness.sampleCount > 0)
  assert(result.timerLateness.maxMs >= 80, `timer lateness should capture the controlled blocking interval: ${result.timerLateness.maxMs}`)
  assert.deepEqual(monitor.stop(), result, 'stop must be idempotent and preserve its snapshot')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(monitor.stop(), result, 'monitor must remain stopped after its interval')
  console.log('PASS: event-loop delay and timer lateness have definitions, sample counts, controlled-block evidence, and idempotent cleanup.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
