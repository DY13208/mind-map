"use strict"
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const { finishStrengthened } = require('./safeload-strengthened-run.cjs')
test('strengthened fixture cleanup runs even when its log path cannot be written', async () => {
  let cleanupCalls = 0
  const fixture = { runDir: path.join(os.tmpdir(), 'safeload-missing-' + crypto.randomUUID(), 'missing'),
    clean: value => value, async cleanup() { cleanupCalls++ } }
  await assert.rejects(finishStrengthened(undefined, fixture, ['test log']), /ENOENT/)
  assert.equal(cleanupCalls, 1, 'strengthened fixture cleanup was skipped after log write failure')
})
