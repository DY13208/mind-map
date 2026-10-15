"use strict"
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { stopProcess, finishRun } = require('./safeload-isolated-run.cjs')
function child(state) {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    // Invalid PID is deliberate: this exact exited-child double must never
    // reach a real signal. kill() provides an immediate diagnostic if it does.
    pid: undefined, kill() { throw new Error('shutdown attempted after recorded child exit') } }, state)
}
test('stopProcess accepts an already signal-terminated child without waiting or signaling it again', async () => {
  await assert.doesNotReject(stopProcess(child({ signalCode: 'SIGTERM' })))
})
test('fixture cleanup always runs even when stopping the legacy child fails', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeload-cleanup-unit-'))
  let cleanupCalls = 0
  const fixture = { runDir, clean: value => value, async cleanup() { cleanupCalls++ } }
  try {
    await assert.rejects(finishRun(child({}), fixture, []), /shutdown attempted/)
    assert.equal(cleanupCalls, 1, 'isolated fixture cleanup was skipped after child stop failure')
  } finally { fs.rmSync(runDir, { recursive: true, force: true }) }
})
