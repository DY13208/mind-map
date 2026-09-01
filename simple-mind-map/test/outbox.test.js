const assert = require('assert')
const { compactEvent, createMemoryBus, createRedisStreamBus } = require('../bin/eventBus')
const { backoffMs, flushOutbox, fanoutDocumentChange } = require('../bin/outbox')

function testBackoffGrowsThenCaps() {
  assert.strictEqual(backoffMs(1), 400)
  assert.strictEqual(backoffMs(2), 800)
  assert.strictEqual(backoffMs(3), 1600)
  assert.ok(backoffMs(20) <= 60000)
}

function testMemoryBusDeliversToTwoSubscribers() {
  return Promise.resolve().then(async () => {
    const bus = createMemoryBus()
    const seen = []
    bus.subscribe(event => {
      seen.push(['a', event.version])
    })
    bus.subscribe(event => {
      seen.push(['b', event.version])
    })
    await bus.publish({
      mapId: 'room-1',
      version: 4,
      operationId: 'op-1',
      event: { type: 'node.inserted', mapId: 'room-1', version: 4 }
    })
    assert.deepStrictEqual(seen, [
      ['a', 4],
      ['b', 4]
    ])
    const compact = compactEvent({
      mapId: 'room-1',
      version: 4,
      event: { type: 'node.inserted', payload: { uid: 'n1' } }
    })
    assert.strictEqual(compact.type, 'event')
    assert.strictEqual(compact.eventType, 'node.inserted')
    await bus.close()
  })
}

function createFakePool(state) {
  return {
    connect: async () => ({
      query: async (sql, params = []) => {
        const text = String(sql)
        if (/^\s*begin/i.test(text) || /^\s*commit/i.test(text)) return { rows: [] }
        if (/rollback/i.test(text)) return { rows: [] }
        if (/skip locked/i.test(text)) {
          return {
            rows: state.rows
              .filter(row => !row.published_at)
              .map(row => ({ ...row }))
          }
        }
        if (/published_at = now()/i.test(text)) {
          const row = state.rows.find(item => item.id === params[0])
          if (row) row.published_at = new Date().toISOString()
          return { rowCount: 1, rows: [] }
        }
        if (/set attempts/i.test(text)) {
          const row = state.rows.find(item => item.id === params[0])
          if (row) {
            row.attempts = params[1]
            row.last_error = params[2]
          }
          return { rowCount: 1, rows: [] }
        }
        return { rows: [] }
      },
      release() {}
    })
  }
}

function testFlushRetriesThenPublishes() {
  return Promise.resolve().then(async () => {
    const state = {
      rows: [
        {
          id: 7,
          room_key: 'room-1',
          version: 2,
          event: { type: 'node.inserted', operationId: 'op' },
          attempts: 0
        }
      ]
    }
    let fails = 1
    const published = []
    const bus = {
      async publish(event) {
        if (fails > 0) {
          fails -= 1
          throw new Error('bus down')
        }
        published.push(event.version)
      }
    }
    const first = await flushOutbox(createFakePool(state), bus)
    assert.strictEqual(first, 1)
    assert.strictEqual(state.rows[0].attempts, 1)
    assert.ok(state.rows[0].last_error)
    assert.ok(!state.rows[0].published_at)

    const second = await flushOutbox(createFakePool(state), bus)
    assert.strictEqual(second, 1)
    assert.deepStrictEqual(published, [2])
    assert.ok(state.rows[0].published_at)
  })
}

function testFanoutIgnoresInvalidPayload() {
  fanoutDocumentChange({})
  fanoutDocumentChange({ mapId: 'x', version: 0 })
}

function createFakeRedisFactory() {
  const messages = []
  let seq = 0
  const make = () => ({
    isOpen: false,
    async connect() {
      this.isOpen = true
    },
    async quit() {
      this.isOpen = false
    },
    duplicate() {
      return make()
    },
    async xAdd(_key, _id, fields) {
      seq += 1
      const id = `${seq}-0`
      messages.push({ id, message: fields })
      return id
    },
    async xRead() {
      return null
    }
  })
  return { clientFactory: make, messages }
}

function testRedisBusPublishesToStream() {
  return Promise.resolve().then(async () => {
    const fake = createFakeRedisFactory()
    const bus = createRedisStreamBus({ clientFactory: fake.clientFactory })
    const seen = []
    bus.subscribe(event => {
      seen.push(event.version)
    })
    await bus.start()
    await bus.publish({
      mapId: 'room-1',
      version: 9,
      operationId: 'op-9',
      event: { type: 'node.inserted', mapId: 'room-1', version: 9 }
    })
    assert.deepStrictEqual(seen, [9])
    assert.strictEqual(fake.messages.length, 1)
    const stored = JSON.parse(fake.messages[0].message.json)
    assert.strictEqual(stored.version, 9)
    assert.strictEqual(stored.mapId, 'room-1')
    await bus.close()
  })
}

async function main() {
  testBackoffGrowsThenCaps()
  await testMemoryBusDeliversToTwoSubscribers()
  await testFlushRetriesThenPublishes()
  testFanoutIgnoresInvalidPayload()
  await testRedisBusPublishesToStream()
  console.log('outbox tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
