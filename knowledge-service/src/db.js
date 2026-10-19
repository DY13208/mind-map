const { Pool } = require('pg')

function createPool(config) {
  if (!config.databaseUrl) {
    const err = new Error('未配置 KNOWLEDGE_DATABASE_URL、DATABASE_URL 或 PGHOST/PGDATABASE/PGUSER')
    err.code = 'DATABASE_NOT_CONFIGURED'
    throw err
  }
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    application_name: 'file-knowledge-service'
  })
  pool.on('connect', client => {
    client.query("set statement_timeout = '20000ms'").catch(() => {})
  })
  pool.on('error', err => {
    console.error('[file-knowledge] 数据库连接错误（不影响其他服务）:', err.message)
  })
  return pool
}

module.exports = { createPool }
