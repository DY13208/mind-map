'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const source = fs.readFileSync(path.join(__dirname, 'mcp-collab-performance.cjs'), 'utf8')
const start = source.indexOf('async function resourceSampler(phase = \'unspecified\') {')
const end = source.indexOf('\nfunction parseRedisInfo(', start)
assert(start >= 0 && end > start)

async function run(failExternalProbes) {
  const emitted = []
  let postgresClosed = false
  let redisClosed = false
  const context = {
    resourceSamplerRunning: false, resourceSampleCounter: 0,
    hostResourceSnapshot: async extended => {
      assert.equal(extended, false, 'load-time host capture must stay cheap')
      return { cpuUsagePct: 42, freeMemoryBytes: 1234 }
    },
    dockerOwned: new Map([['owned-test-api', {}]]),
    dockerAsync: async (_args, options) => {
      assert.equal(options.timeout, 8000)
      if (failExternalProbes) throw new Error('container probe timeout')
      return 'owned-test-api|5%|100MiB|1%|0|0'
    },
    pgModule: () => ({ Pool: class {
      constructor(options) {
        assert.equal(options.connectionTimeoutMillis, 3000)
        assert.equal(options.query_timeout, 4000)
      }
      async query() {
        if (failExternalProbes) throw new Error('postgres probe timeout')
        return { rows: [{ datname: 'owned-test-db', active: 2, waiting: 1 }] }
      }
      async end() { postgresClosed = true }
    } }),
    redisModule: () => ({ createClient: options => {
      assert.equal(options.socket.connectTimeout, 3000)
      return ({
      isOpen: true, on() {}, async connect() {},
      async info(section) { return section === 'keyspace' ? 'db13:keys=1' : 'used_memory:99' },
      async dbSize() { return 1 }, async disconnect() { redisClosed = true; this.isOpen = false }
      })
    } }),
    RESOURCE_PROBE_TIMEOUT_MS: { containers: 8000, postgresConnect: 3000, postgresQuery: 4000, redis: 3000 },
    PG: {}, REDIS_HOST: '127.0.0.1', REDIS_PORT: 1, REDIS_DB: 13,
    parseRedisInfo: text => ({ raw: text }), safePersistedError: () => 'probe_error', performance: require('node:perf_hooks').performance,
    append: (_file, row) => emitted.push(row), eventsPath: 'unused',
    setTimeout, clearTimeout
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, end), context)
  await context.resourceSampler('unit-phase')
  assert.equal(context.resourceSamplerRunning, false)
  assert(postgresClosed && redisClosed, 'all probe connections must close')
  assert.equal(emitted.length, 1)
  const sample = emitted[0]
  assert.equal(sample.type, 'resource-sample')
  assert.equal(sample.phase, 'unit-phase')
  assert.equal(sample.sampleIndex, 1)
  assert.equal(sample.host.cpuUsagePct, 42)
  assert.equal(sample.host.freeMemoryBytes, 1234)
  assert.equal(sample.partial, failExternalProbes)
  assert.equal(sample.resourceErrors.length, failExternalProbes ? 2 : 0)
  assert.equal(sample.containers && sample.containers.length, failExternalProbes ? null : 1)
  assert.equal(sample.postgres && sample.postgres.length, failExternalProbes ? null : 1)
  assert.equal(sample.redis.dbSize, 1)
  assert.equal(sample.probeTiming.containers.timeoutMs, 8000)
  assert.equal(sample.probeTiming.postgres.timeoutMs, 4000)
  assert.equal(sample.probeTiming.redis.timeoutMs, 3000)
  assert(sample.probeTiming.containers.durationMs >= 0 && sample.probeTiming.postgres.durationMs >= 0 && sample.probeTiming.redis.durationMs >= 0)
}
async function runSkipped() {
  const emitted = []
  const context = {
    resourceSamplerRunning: true, resourceSampleCounter: 0,
    append: (_file, row) => emitted.push(row), eventsPath: 'unused', setTimeout, clearTimeout
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, end), context)
  await context.resourceSampler()
  assert.equal(context.resourceSampleCounter, 1, 'overlapping sampler trigger should still count as an attempt')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'resource-sample-skipped')
  assert.deepEqual(Array.from(emitted[0].missingComponents), ['containers', 'postgres', 'redis'])
}
Promise.resolve().then(() => run(false)).then(() => run(true)).then(runSkipped).then(() => {
  console.log('PASS: bounded independent probes retain host CPU/memory and partial errors; all connections close')
}).catch(error => { console.error(error); process.exitCode = 1 })
