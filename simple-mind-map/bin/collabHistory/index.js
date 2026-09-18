const { historyConfig } = require('./config')
const { createHistoryEngine } = require('./engine')
const { createMemoryHistoryStore } = require('./memoryStore')
const { createPgHistoryStore } = require('./pgStore')
const { initHistorySchema } = require('./schema')
const { startAutoVersionWorker } = require('./autoJobs')
const {
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent,
  planPendingAfterRestore,
  quarantinePendingAfterRestore
} = require('./clientEpoch')

let engine = null
let autoWorker = null

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

function startHistoryWorkers(nextEngine, options) {
  if (autoWorker && typeof autoWorker.stop === 'function') autoWorker.stop()
  autoWorker = startAutoVersionWorker(nextEngine || engine, options)
  return autoWorker
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
  startHistoryWorkers,
  onCommitted,
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent,
  planPendingAfterRestore,
  quarantinePendingAfterRestore
}
