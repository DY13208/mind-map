#!/usr/bin/env node
// Compile brain-map content directly; independent of Wiki/Docmost/MCP pages.
const path = require('node:path')
const { mergeContractSpec } = require('../simple-mind-map/bin/wikiCompiler/contracts')
module.exports = { mergeContractSpec }
async function main() {
  require('../simple-mind-map/bin/loadEnv')
  const { Pool } = require('../simple-mind-map/node_modules/pg')
  const { WikiCompiler } = require('../simple-mind-map/bin/wikiCompiler')
  const args = process.argv.slice(2)
  const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i+1] }
  const env = { ...process.env }
  if (arg('--wiki-dir')) env.WIKI_COMPILER_OUTPUT_DIR = path.resolve(arg('--wiki-dir'))
  if (arg('--contracts')) env.WIKI_COMPILER_CONTRACTS_DIR = path.resolve(arg('--contracts'))
  if (arg('--room-id')) env.WIKI_COMPILER_COMPANY_ROOM_ID = arg('--room-id')
  const pool = new Pool({ connectionString: env.MIND_MAP_DATABASE_URL || env.DATABASE_URL || undefined })
  try {
    if (args.includes('--dry-run')) {
      const result = await pool.query(`select r.room_key, r.title from rooms r left join room_tombstones t using(room_key)
        where r.deleted_at is null and t.room_key is null order by r.room_key`)
      console.log('Dry run: '+result.rows.length+' rooms; output '+(env.WIKI_COMPILER_OUTPUT_DIR || 'data/wiki-compiler/wiki'))
      for (const row of result.rows) console.log(row.room_key+' '+row.title)
      return
    }
    const compiler = new WikiCompiler({ pool, env })
    await compiler.initialize()
    for (const id of await compiler.list()) await compiler.reconcile(id)
  } finally { await pool.end() }
}
if (require.main === module) main().catch(e => { console.error('Compile failed: '+e.message); process.exitCode=1 })
