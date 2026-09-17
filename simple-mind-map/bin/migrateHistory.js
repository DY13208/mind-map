#!/usr/bin/env node
require('./loadEnv')

async function main() {
  const { initSchema, getPool } = require('./storage')
  const { migrateHistorySchema, getSchemaVersion, HISTORY_SCHEMA_VERSION } = require('./collabHistory/migrate')
  await initSchema()
  const pool = getPool()
  const before = await getSchemaVersion(pool)
  const report = await migrateHistorySchema(pool)
  const after = await getSchemaVersion(pool)
  console.log(
    JSON.stringify(
      {
        ok: true,
        before,
        after,
        expected: HISTORY_SCHEMA_VERSION,
        report
      },
      null,
      2
    )
  )
  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
