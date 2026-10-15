'use strict'

const fs = require('fs')
const path = require('path')
const migration = fs.readFileSync(path.join(__dirname, '../migrations/010_node_count_cache_generation.up.sql'), 'utf8')

// pg executes this multi-statement query in one implicit transaction. Respect
// the caller's search_path so isolated schemas and the normal schema use it.
async function installNodeCountsGeneration(db) {
  await db.query(migration)
}

module.exports = { installNodeCountsGeneration }
