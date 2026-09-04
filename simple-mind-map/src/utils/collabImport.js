/* global module:readonly, process:readonly, setImmediate:readonly */

const DEFAULT_MAX_NODES = 20000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

function importMaxNodes() {
  const n = Number(process.env.COLLAB_IMPORT_MAX_NODES || DEFAULT_MAX_NODES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_NODES
}

function importMaxBytes() {
  const n = Number(process.env.COLLAB_IMPORT_MAX_BYTES || DEFAULT_MAX_BYTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES
}

function countTreeNodes(tree) {
  if (!tree) return 0
  let count = 0
  const stack = [tree]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count += 1
    const kids = node.children || []
    for (let i = 0; i < kids.length; i++) stack.push(kids[i])
  }
  return count
}

function estimateSerializedBytes(value) {
  try {
    return JSON.stringify(value || {}).length
  } catch (err) {
    return 0
  }
}

function inspectImportTree(tree, extra = {}) {
  const nodeCount = countTreeNodes(tree)
  const serializedBytes =
    extra.serializedBytes != null
      ? Number(extra.serializedBytes)
      : estimateSerializedBytes(tree)
  const maxNodes = extra.maxNodes != null ? Number(extra.maxNodes) : importMaxNodes()
  const maxBytes = extra.maxBytes != null ? Number(extra.maxBytes) : importMaxBytes()
  const tooLarge = nodeCount > maxNodes || serializedBytes > maxBytes
  return {
    nodeCount,
    serializedBytes,
    maxNodes,
    maxBytes,
    tooLarge
  }
}

function importTooLargeError(stats = {}) {
  const err = new Error('IMPORT_TOO_LARGE')
  err.code = 'IMPORT_TOO_LARGE'
  err.statusCode = 413
  err.nodeCount = stats.nodeCount
  err.serializedBytes = stats.serializedBytes
  err.maxNodes = stats.maxNodes
  err.maxBytes = stats.maxBytes
  return err
}

function yieldEventLoop() {
  return new Promise(resolve => {
    if (typeof setImmediate === 'function') setImmediate(resolve)
    else setTimeout(resolve, 0)
  })
}

function reconnectBackoffMs(attempt, extra = {}) {
  const base = Number(extra.baseMs) || 800
  const cap = Number(extra.capMs) || 15000
  const n = Math.max(0, Number(attempt) || 0)
  const exp = Math.min(cap, base * Math.pow(2, n))
  const jitter = Math.floor(Math.random() * Math.min(400, exp * 0.2))
  return Math.min(cap, exp + jitter)
}

function shouldStopReconnect(attempt, extra = {}) {
  const max = Number(extra.maxAttempts) != null ? Number(extra.maxAttempts) : 8
  return Number(attempt) >= max
}

function classifyCollabError(err, extra = {}) {
  const code = String((err && err.code) || extra.code || '')
  const msg = String((err && err.message) || extra.message || '')
  if (code === 'AUTH_TIMEOUT' || /认证服务响应超时/.test(msg)) {
    return { code: 'AUTH_TIMEOUT', message: msg || 'AUTH_TIMEOUT' }
  }
  if (
    code === 'ROOM_LOAD_TIMEOUT' ||
    extra.stage === 'hydrate' ||
    extra.stage === 'ROOM_LOAD'
  ) {
    return { code: 'ROOM_LOAD_TIMEOUT', message: msg || 'ROOM_LOAD_TIMEOUT' }
  }
  if (
    code === 'IMPORT_APPLY_FAILED' ||
    code === 'IMPORT_TOO_LARGE' ||
    extra.stage === 'IMPORT'
  ) {
    return {
      code: code || 'IMPORT_APPLY_FAILED',
      message: msg || 'IMPORT_APPLY_FAILED'
    }
  }
  if (code) return { code, message: msg || code }
  return { code: 'UNKNOWN', message: msg || 'UNKNOWN' }
}

function publishLargeImportTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof console !== 'undefined' && console.info) {
    console.info('IMPORT_LARGE_TRACE', next)
  }
  if (typeof window === 'undefined') return next
  window.__IMPORT_LARGE_TRACE__ = next
  window.__IMPORT_LARGE_TRACE_LOG__ = window.__IMPORT_LARGE_TRACE_LOG__ || []
  window.__IMPORT_LARGE_TRACE_LOG__.push(next)
  if (window.__IMPORT_LARGE_TRACE_LOG__.length > 40) {
    window.__IMPORT_LARGE_TRACE_LOG__.shift()
  }
  return next
}

const api = {
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_BYTES,
  importMaxNodes,
  importMaxBytes,
  countTreeNodes,
  estimateSerializedBytes,
  inspectImportTree,
  importTooLargeError,
  yieldEventLoop,
  reconnectBackoffMs,
  shouldStopReconnect,
  classifyCollabError,
  publishLargeImportTrace
}

module.exports = api
module.exports.default = api
