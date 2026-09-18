const { migrateHistorySchema, HISTORY_SCHEMA_VERSION } = require('./migrate')

async function initHistorySchema(db) {
  if (!db || typeof db.query !== 'function') return
  return migrateHistorySchema(db)
}

module.exports = { initHistorySchema, HISTORY_SCHEMA_VERSION }
