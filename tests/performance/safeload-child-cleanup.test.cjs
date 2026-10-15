"use strict"
const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanupAll } = require('./safeload-cleanup.cjs')
test('child browser and PG pool close even when writing native evidence fails', async () => {
  const closed = []
  await assert.rejects(cleanupAll([
    () => { throw new Error('native evidence write failed') },
    async () => { closed.push('browser') },
    async () => { closed.push('pool') }
  ]), /native evidence write failed/)
  assert.deepEqual(closed, ['browser', 'pool'], 'evidence write failure skipped child resource shutdown')
})
