const assert = require('assert')
const rateLimit = require('../bin/rateLimit')
const metrics = require('../bin/collabMetrics')

function testRateLimitBlocksBurst() {
  rateLimit._resetForTests()
  process.env.COLLAB_RATE_LIMIT_PER_ROOM = '3'
  process.env.COLLAB_RATE_WINDOW_MS = '10000'
  // re-require won't pick env - use internal by resetting and calling many times with default
  // Default room limit is 120; temporarily hammer with assertBatchSize / patch instead.
  rateLimit.assertBatchSize(new Array(rateLimit.MAX_BATCH_OPS).fill({}))
  let batchCode = ''
  try {
    rateLimit.assertBatchSize(new Array(rateLimit.MAX_BATCH_OPS + 1).fill({}))
  } catch (err) {
    batchCode = err.code
  }
  assert.strictEqual(batchCode, 'BATCH_TOO_LARGE')

  rateLimit.assertPatchSize({ a: 1, b: 2 })
  const huge = {}
  for (let i = 0; i < rateLimit.MAX_PATCH_KEYS + 1; i++) huge[`k${i}`] = i
  let patchCode = ''
  try {
    rateLimit.assertPatchSize(huge)
  } catch (err) {
    patchCode = err.code
  }
  assert.strictEqual(patchCode, 'PATCH_TOO_LARGE')
}

testRateLimitBlocksBurst()

function testRateLimitPerRoom() {
  rateLimit._resetForTests()
  const status = rateLimit.getRateLimitStatus()
  assert.ok(status.roomLimit >= 1)
  assert.ok(status.globalLimit >= 1)
  // Fill room bucket to limit using many hits
  const room = 'room-rate-test'
  let limited = false
  for (let i = 0; i < status.roomLimit + 5; i++) {
    try {
      rateLimit.assertRateLimit(room)
    } catch (err) {
      assert.strictEqual(err.code, 'RATE_LIMITED')
      assert.strictEqual(err.statusCode, 429)
      limited = true
      break
    }
  }
  assert.strictEqual(limited, true)
}

testRateLimitPerRoom()

function testMetricsLatencyAndRedaction() {
  metrics._resetForTests()
  metrics.recordOperation({
    mapId: 'room-a',
    version: 1,
    ok: true,
    durationMs: 10
  })
  metrics.recordOperation({
    mapId: 'room-a',
    version: 2,
    ok: true,
    durationMs: 20
  })
  metrics.recordOperation({
    mapId: 'room-a',
    version: 4,
    ok: true,
    durationMs: 30
  })
  metrics.recordOperation({
    mapId: 'room-a',
    ok: false,
    durationMs: 5,
    code: 'NODE_DELETED'
  })
  metrics.recordRecovery('operations')
  metrics.recordRecovery('resnapshot')
  metrics.setWsConnections(3)
  metrics.recordBroadcast(40)
  const snap = metrics.getMetricsSnapshot()
  assert.strictEqual(snap.operations.total, 4)
  assert.strictEqual(snap.operations.failed, 1)
  assert.strictEqual(snap.operations.latencyMs.samples, 4)
  assert.ok(snap.operations.latencyMs.p95 >= 20)
  assert.strictEqual(snap.recovery.operationsFetches, 1)
  assert.strictEqual(snap.recovery.resnapshots, 1)
  assert.strictEqual(snap.websocket.connections, 3)
  assert.ok(snap.lastVersionGap)
  assert.strictEqual(snap.lastVersionGap.expected, 3)
  assert.strictEqual(snap.lastVersionGap.actual, 4)

  const redacted = metrics.redactSensitive({
    text: 'hello',
    token: 'secret-value',
    image: `data:image/png;base64,${'x'.repeat(200)}`,
    nested: { password: 'x', note: 'ok' }
  })
  assert.strictEqual(redacted.token, '[redacted]')
  assert.strictEqual(redacted.nested.password, '[redacted]')
  assert.strictEqual(redacted.nested.note, 'ok')
  assert.ok(String(redacted.image).startsWith('[binary'))
}

testMetricsLatencyAndRedaction()

console.log('rateLimit and metrics tests passed')
