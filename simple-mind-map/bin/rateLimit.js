const WINDOW_MS = Math.max(
  1000,
  Number(process.env.COLLAB_RATE_WINDOW_MS || 10000)
)
const ROOM_LIMIT = Math.max(
  1,
  Number(process.env.COLLAB_RATE_LIMIT_PER_ROOM || 800)
)
const GLOBAL_LIMIT = Math.max(
  1,
  Number(process.env.COLLAB_RATE_LIMIT_GLOBAL || 8000)
)
const MAX_BODY_BYTES = Math.max(
  64 * 1024,
  Number(process.env.COLLAB_MAX_BODY_BYTES || 2 * 1024 * 1024)
)
const MAX_REPLACE_BODY_BYTES = Math.max(
  MAX_BODY_BYTES,
  Number(process.env.COLLAB_MAX_REPLACE_BODY_BYTES || 20 * 1024 * 1024)
)
const MAX_BATCH_OPS = Math.max(
  1,
  Number(process.env.COLLAB_MAX_BATCH_OPS || 100)
)
const MAX_PATCH_KEYS = Math.max(
  1,
  Number(process.env.COLLAB_MAX_PATCH_KEYS || 40)
)

const roomBuckets = new Map()
let globalBucket = []

function prune(bucket, now) {
  const cutoff = now - WINDOW_MS
  let i = 0
  while (i < bucket.length && bucket[i] < cutoff) i += 1
  if (i > 0) bucket.splice(0, i)
  return bucket
}

function hit(bucket, now, limit) {
  prune(bucket, now)
  if (bucket.length >= limit) {
    const err = new Error('请求过于频繁，请稍后重试')
    err.statusCode = 429
    err.code = 'RATE_LIMITED'
    err.retryAfterMs = Math.max(0, WINDOW_MS - (now - bucket[0]))
    throw err
  }
  bucket.push(now)
}

function assertRateLimit(roomKey) {
  const now = Date.now()
  const key = String(roomKey || '')
  if (!roomBuckets.has(key)) roomBuckets.set(key, [])
  hit(globalBucket, now, GLOBAL_LIMIT)
  hit(roomBuckets.get(key), now, ROOM_LIMIT)
}

function assertBatchSize(ops) {
  const list = Array.isArray(ops) ? ops : []
  if (list.length > MAX_BATCH_OPS) {
    const err = new Error(
      `批量操作数量超过限制（最多 ${MAX_BATCH_OPS}）`
    )
    err.statusCode = 413
    err.code = 'BATCH_TOO_LARGE'
    throw err
  }
}

function assertPatchSize(patch) {
  if (!patch || typeof patch !== 'object') return
  const keys = Object.keys(patch)
  if (keys.length > MAX_PATCH_KEYS) {
    const err = new Error(
      `单次修改字段过多（最多 ${MAX_PATCH_KEYS}）`
    )
    err.statusCode = 413
    err.code = 'PATCH_TOO_LARGE'
    throw err
  }
}

function bodyLimitForPath(pathname = '') {
  if (/\/replace$/.test(pathname) || /\/import/.test(pathname)) {
    return MAX_REPLACE_BODY_BYTES
  }
  return MAX_BODY_BYTES
}

function getRateLimitStatus() {
  const now = Date.now()
  prune(globalBucket, now)
  let roomsTracked = 0
  roomBuckets.forEach(bucket => {
    prune(bucket, now)
    if (bucket.length) roomsTracked += 1
  })
  return {
    windowMs: WINDOW_MS,
    roomLimit: ROOM_LIMIT,
    globalLimit: GLOBAL_LIMIT,
    globalInWindow: globalBucket.length,
    roomsTracked,
    maxBodyBytes: MAX_BODY_BYTES,
    maxReplaceBodyBytes: MAX_REPLACE_BODY_BYTES,
    maxBatchOps: MAX_BATCH_OPS,
    maxPatchKeys: MAX_PATCH_KEYS
  }
}

function _resetForTests() {
  roomBuckets.clear()
  globalBucket = []
}

module.exports = {
  assertRateLimit,
  assertBatchSize,
  assertPatchSize,
  bodyLimitForPath,
  getRateLimitStatus,
  MAX_BODY_BYTES,
  MAX_REPLACE_BODY_BYTES,
  MAX_BATCH_OPS,
  MAX_PATCH_KEYS,
  _resetForTests
}
