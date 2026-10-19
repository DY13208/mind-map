'use strict'
// Own pg Pool for File KB. Never shares the app pool; connects as kb_app.
let Pool = null

function createPool(dbConfig) {
  if (!Pool) Pool = require('pg').Pool
  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    max: Math.min(dbConfig.max || 10, 10),
    application_name: 'file-kb',
    statement_timeout: dbConfig.statementTimeoutMs,
    idle_in_transaction_session_timeout: 30000,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  })
  pool.on('error', err => console.error('[file-kb][db] idle client error:', err.message))
  return pool
}

module.exports = { createPool }
