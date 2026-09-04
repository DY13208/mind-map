const { historyConfig } = require('./config')
const { createHistoryEngine } = require('./engine')
const { createMemoryHistoryStore } = require('./memoryStore')
const { createPgHistoryStore } = require('./pgStore')
const { initHistorySchema } = require('./schema')
const {
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent,
  planPendingAfterRestore,
  quarantinePendingAfterRestore
} = require('./clientEpoch')

let engine = null

function attachHistoryEngine(next) {
  engine = next
  return engine
}

function getHistoryEngine() {
  return engine
}

function handleHistoryApi(req, res, options) {
  return require('./http').handleHistoryApi(req, res, options)
}

function createServerHistoryEngine(pool, config) {
  const store = pool ? createPgHistoryStore(pool) : createMemoryHistoryStore()
  engine = createHistoryEngine({ store, config: historyConfig(config) })
  return engine
}

async function onCommitted(event) {
  if (!engine) return null
  return engine.onCommitted(event)
}

module.exports = {
  historyConfig,
  createHistoryEngine,
  createMemoryHistoryStore,
  createPgHistoryStore,
  initHistorySchema,
  handleHistoryApi,
  attachHistoryEngine,
  getHistoryEngine,
  createServerHistoryEngine,
  onCommitted,
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent,
  planPendingAfterRestore,
  quarantinePendingAfterRestore
}
