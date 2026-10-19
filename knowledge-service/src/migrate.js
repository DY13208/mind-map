const fs = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations')

function upFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql') && !name.endsWith('_down.sql'))
    .sort()
}

async function migrate(pool) {
  await pool.query('create schema if not exists knowledge')
  await pool.query(`
    create table if not exists knowledge.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `)
  for (const name of upFiles()) {
    const applied = await pool.query(
      'select 1 from knowledge.schema_migrations where version = $1',
      [name]
    )
    if (applied.rowCount) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query(
        'insert into knowledge.schema_migrations (version) values ($1) on conflict do nothing',
        [name]
      )
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}

async function rollback(pool) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_down.sql'), 'utf8')
  await pool.query(sql)
}

module.exports = { migrate, rollback, upFiles, MIGRATIONS_DIR }
