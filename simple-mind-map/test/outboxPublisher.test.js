const test = require('node:test')
const assert = require('node:assert/strict')
const { startOutboxPublisher } = require('../bin/outbox')

test('V2 publishes committed outbox rows without subscribing legacy awareness fanout', async () => {
  const rows = [{ id: 1, room_key: 'test-room', version: 2, event: { operationId: 'op-1' }, attempts: 0 }]
  const published = []
  const marked = []
  let subscriptions = 0
  let committed = false
  let resolveCommit
  const done = new Promise(resolve => { resolveCommit = resolve })
  const client = {
    async query(sql, args) {
      if (sql.includes('select id, room_key')) return { rows: rows.splice(0) }
      if (sql.includes('set published_at')) marked.push(args[0])
      if (sql === 'commit') { committed = true; resolveCommit() }
      return { rows: [] }
    }, release() {}
  }
  const publisher = startOutboxPublisher({
    pool: { connect: async () => client },
    bus: {
      publish: async event => published.push(event),
      subscribe: () => { subscriptions += 1; return () => {} }
    },
    onEvent: false,
    intervalMs: 60000
  })
  try {
    await done
    assert.equal(subscriptions, 0)
    assert.equal(published.length, 1)
    assert.equal(published[0].operationId, 'op-1')
    assert.deepEqual(marked, [1])
    assert.equal(committed, true)
  } finally { await publisher.stop() }
})

test('legacy publisher retains its event callback subscription', async () => {
  const callback = () => {}
  let subscribed
  let unsubscribed = false
  let resolveCommit
  const done = new Promise(resolve => { resolveCommit = resolve })
  const publisher = startOutboxPublisher({
    pool: { connect: async () => ({
      query: async sql => { if (sql === 'commit') resolveCommit(); return { rows: [] } },
      release() {}
    }) },
    bus: { subscribe: fn => { subscribed = fn; return () => { unsubscribed = true } } },
    onEvent: callback,
    intervalMs: 60000
  })
  await done
  assert.equal(subscribed, callback)
  await publisher.stop()
  assert.equal(unsubscribed, true)
})
