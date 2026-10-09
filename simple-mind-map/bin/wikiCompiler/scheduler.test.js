const test = require('node:test')
const assert = require('node:assert/strict')
test('debounces edits and reruns when an edit arrives during compilation', async t => {
  const { SyncScheduler } = require('./scheduler')
  let calls = 0, release
  const scheduler = new SyncScheduler({ debounceMs: 5, intervalMs: 300000,
    list: async () => ['r'], reconcile: async () => { calls++; if (calls === 1) await new Promise(r => { release = r }) }, log: () => {} })
  t.after(() => scheduler.stop())
  scheduler.notify('r'); scheduler.notify('r'); scheduler.notify('r')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls, 1)
  scheduler.notify('r')
  release()
  await scheduler.flush('r')
  assert.equal(calls, 2)
})
test('periodic reconciliation retries a failed room without blocking others', async t => {
  const { SyncScheduler } = require('./scheduler')
  const calls = [], errors = []
  let fail = true
  const scheduler = new SyncScheduler({ list: async () => ['bad', 'good'],
    reconcile: async id => { calls.push(id); if (id === 'bad' && fail) throw new Error('broken') },
    log: msg => errors.push(msg) })
  t.after(() => scheduler.stop())
  await scheduler.tick()
  assert.deepEqual(calls, ['bad', 'good'])
  fail = false
  await scheduler.tick()
  assert.deepEqual(calls, ['bad', 'good', 'bad', 'good'])
  assert.match(errors.join('\n'), /broken/)
})

test('a burst across rooms never reserves the whole shared database pool', async t => {
  const { SyncScheduler } = require('./scheduler')
  let active = 0, maximum = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const scheduler = new SyncScheduler({ list: async () => [], log: () => {},
    reconcile: async () => { active++; maximum = Math.max(maximum, active); await gate; active-- } })
  t.after(() => scheduler.stop())
  const jobs = ['a','b','c','d'].map(id => scheduler.flush(id))
  await new Promise(resolve => setImmediate(resolve))
  release()
  await Promise.all(jobs)
  assert.equal(maximum, 1)
})
