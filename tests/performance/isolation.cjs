const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '../..')
const configPath = path.join(repo, 'work/performance-tdd/isolation.json')

function readConfig() {
  if (!fs.existsSync(configPath)) throw new Error('BLOCKED_ENV: isolated database setup has not completed')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(config.pg.host, '127.0.0.1', 'isolated PG must use explicit loopback')
  assert.equal(config.pg.database, 'mcp_incremental_test', 'isolated database name mismatch')
  assert.equal(config.project, 'mindmap-performance-tdd-20261013', 'isolated project mismatch')
  assert.ok(config.identity && config.identity.length >= 16, 'isolated database identity missing')
  return config
}

function configureIsolatedEnvironment() {
  const config = readConfig()
  Object.assign(process.env, {
    MIND_MAP_SKIP_ROOT_ENV: '1', PERF_TDD_ISOLATED: '1',
    PGHOST: config.pg.host, PGPORT: String(config.pg.port),
    PGDATABASE: config.pg.database, PGUSER: config.pg.user, PGPASSWORD: config.pg.password,
    PGAPPNAME: 'mindmap-performance-tdd', REDIS_URL: config.redis,
    WECOM_AUTH_ENABLED: '0', ONEID_AUTH_ENABLED: '0', WORKBUDDY_AUTH_ENABLED: '0',
    KNOWLEDGE_COMPILER_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false',
    COLLAB_V2: '1', COLLAB_OUTBOX_PUBLISHER: '0',
    YIRAN_UPSTREAM: 'http://127.0.0.1:9', JOBHUB_UPSTREAM: 'http://127.0.0.1:9',
    BRIDGE_UPSTREAM: 'http://127.0.0.1:9', COGNEE_API: 'http://127.0.0.1:9'
  })
  assertIsolatedEnvironment()
  return config
}

function assertIsolatedEnvironment() {
  const config = readConfig()
  assert.equal(process.env.MIND_MAP_SKIP_ROOT_ENV, '1')
  assert.equal(process.env.PERF_TDD_ISOLATED, '1')
  assert.equal(process.env.PGHOST, config.pg.host)
  assert.equal(process.env.PGPORT, String(config.pg.port))
  assert.equal(process.env.PGDATABASE, config.pg.database)
  assert.equal(process.env.PGUSER, config.pg.user)
  return config
}

async function withIsolatedPg(callback) {
  const config = configureIsolatedEnvironment()
  const { Pool } = require(path.join(repo, 'simple-mind-map/node_modules/pg'))
  const pool = new Pool({ ...config.pg, max: 6 })
  try {
    const identity = await pool.query('select identity from performance_test_identity where singleton = true')
    assert.equal(identity.rows[0] && identity.rows[0].identity, config.identity, 'database is not the owned performance fixture')
    return await callback(pool, config)
  } finally {
    await pool.end()
  }
}

module.exports = { configureIsolatedEnvironment, assertIsolatedEnvironment, withIsolatedPg, readConfig, configPath }
