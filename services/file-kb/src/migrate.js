'use strict'
// Applies src/migrations/*.sql in order. Only touches schema kb.
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, 'migrations')
const LOCK_KEY = 'kb.schema_migrations'

function listMigrations(dir = DIR) {
  return fs.readdirSync(dir).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map(f => ({ version: f.replace(/\.sql$/, ''), file: path.join(dir, f) }))
}

async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY])
    const schema = await client.query(
      `select 1 from information_schema.schemata where schema_name = 'kb'`)
    if (!schema.rows[0]) {
      throw new Error('schema kb does not exist; run scripts/file-kb/bootstrap.sql as DB admin first')
    }
    await client.query(`create table if not exists kb.schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`)
    const done = new Set((await client.query('select version from kb.schema_migrations')).rows.map(r => r.version))
    const applied = []
    for (const m of listMigrations()) {
      if (done.has(m.version)) continue
      const sql = fs.readFileSync(m.file, 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into kb.schema_migrations(version) values ($1)', [m.version])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw new Error(`migration ${m.version} failed: ${err.message}`)
      }
      applied.push(m.version)
      log(`[file-kb] migration applied: ${m.version}`)
    }
    return applied
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}

module.exports = { migrate, listMigrations }

if (require.main === module) {
  const { loadConfig } = require('./config')
  const { createPool } = require('./db')
  const pool = createPool(loadConfig().db)
  migrate(pool).then(a => { console.log(`[file-kb] migrations done (${a.length} new)`); return pool.end() })
    .catch(err => { console.error(err.message); pool.end(); process.exit(1) })
}
