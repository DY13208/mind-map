'use strict'
// PG integration helpers. Requires a scratch DB prepared with scripts/file-kb/bootstrap.sql,
// connection via standard PG* env vars (PGUSER=kb_app). Tests are skipped when KB_TEST_PG != 1.
const crypto = require('crypto')
const { createPool } = require('../../src/db')
const { migrate } = require('../../src/migrate')

const enabled = process.env.KB_TEST_PG === '1'

function loadDotEnv() {
  const file = require('path').join(__dirname, '..', '..', '..', '..', '.env')
  if (!require('fs').existsSync(file)) return
  for (const line of require('fs').readFileSync(file, 'utf8').split(/\n/)) {
    const m = /^(PGHOST|PGPORT|PGUSER|PGPASSWORD)=(.*)$/.exec(line.trim())
    if (m && (process.env[m[1]] == null || process.env[m[1]] === '')) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}

async function setup() {
  loadDotEnv()
  if (process.env.PGDATABASE && process.env.PGDATABASE !== 'kb_scratch') {
    throw new Error('file-kb pg tests refuse to use database ' + process.env.PGDATABASE)
  }
  process.env.PGDATABASE = 'kb_scratch'
  const pool = createPool({
    host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, max: 6, statementTimeoutMs: 15000
  })
  await migrate(pool, { log: () => {} })
  return pool
}

async function makeFile(pool, { owner = 'u_test', ext = 'pdf', storageKey } = {}) {
  const sha = crypto.randomBytes(32).toString('hex')
  const f = await pool.query(
    `insert into kb.files (owner_id, name, ext, mime, size, sha256, storage_key, created_by) values ($1,$2,$3,'',1,$4,$5,$1) returning *`,
    [owner, `t.${ext}`, ext, sha, storageKey || `objects/${sha.slice(0, 2)}/${sha}`])
  const r = await pool.query(`insert into kb.parse_runs (file_id) values ($1) returning id`, [f.rows[0].id])
  return { file: f.rows[0], runId: r.rows[0].id }
}

// Isolate tests: park every other active job far in the future during the test.
async function isolate(pool) {
  await pool.query(`update kb.jobs set state = 'cancelled' where state in ('queued','running')`)
}

module.exports = { enabled, setup, makeFile, isolate }
