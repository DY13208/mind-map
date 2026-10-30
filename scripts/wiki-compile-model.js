#!/usr/bin/env node
// Compile brain-map content directly; independent of Wiki/Docmost/MCP pages.
const path = require('node:path')
const { mergeContractSpec } = require('../simple-mind-map/bin/wikiCompiler/contracts')
module.exports = { mergeContractSpec }
async function main() {
  require('../simple-mind-map/bin/loadEnv')
  const { Pool } = require('../simple-mind-map/node_modules/pg')
  const { WikiCompiler } = require('../simple-mind-map/bin/wikiCompiler')
  const { readJson } = require('../simple-mind-map/bin/wikiCompiler/compiler')
  const { safeId } = require('../simple-mind-map/bin/knowledge/utils')
  const args = process.argv.slice(2)
  const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i+1] }
  const onlyRoom = arg('--only-room')
  if (args.includes('--only-room') && (!onlyRoom || onlyRoom.startsWith('--') || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(onlyRoom))) throw new Error('--only-room requires a valid room key')
  if (args.includes('--upgrade-attachment-index') && !onlyRoom) throw new Error('--upgrade-attachment-index requires --only-room; upgrade one room at a time')
  const env = { ...process.env }
  if (arg('--wiki-dir')) env.WIKI_COMPILER_OUTPUT_DIR = path.resolve(arg('--wiki-dir'))
  if (arg('--contracts')) env.WIKI_COMPILER_CONTRACTS_DIR = path.resolve(arg('--contracts'))
  if (arg('--room-id')) env.WIKI_COMPILER_COMPANY_ROOM_ID = arg('--room-id')
  const pool = new Pool({ connectionString: env.MIND_MAP_DATABASE_URL || env.DATABASE_URL || undefined })
  try {
    if (args.includes('--dry-run')) {
      const result = await pool.query(`select r.room_key, r.title from rooms r left join room_tombstones t using(room_key)
        where r.deleted_at is null and t.room_key is null and ($1::text is null or r.room_key=$1) order by r.room_key`, [onlyRoom])
      console.log('Dry run: '+result.rows.length+' rooms; output '+(env.WIKI_COMPILER_OUTPUT_DIR || 'data/wiki-compiler/wiki'))
      for (const row of result.rows) console.log(row.room_key+' '+row.title)
      return
    }
    const compiler = new WikiCompiler({ pool, env })
    await compiler.initialize()
    const ids = onlyRoom ? [onlyRoom] : await compiler.list()
    const report = { successful: [], failed: [], pending: [] }
    for (const id of ids) {
      try {
        if (args.includes('--upgrade-attachment-index')) {
          const compiled = await compiler.compiler.compile(id, { force: true })
          if (['busy', 'cooldown', 'archived'].includes(compiled.status)) {
            report.pending.push({ room_key: id, reason: compiled.status })
            process.exitCode = 1
            continue
          }
        }
        await compiler.reconcile(id)
        if (args.includes('--upgrade-attachment-index')) {
          const pointer = await readJson(path.join(compiler.outputDir, 'rooms', id, 'current.json'))
          const bundle = pointer && await readJson(path.join(compiler.outputDir, 'rooms', id, 'generations', safeId(pointer.generation), 'bundle.json'))
          const live = (await pool.query(`select r.version, coalesce(s.revision,0) as revision from rooms r
            left join knowledge_source_state s using(room_key) where r.room_key=$1 and r.deleted_at is null`, [id])).rows[0]
          if (!bundle || !live || bundle.attachmentSourceIndexVersion !== 1 || Number(bundle.version) !== Number(live.version) || Number(bundle.revision) !== Number(live.revision)) {
            report.pending.push({ room_key: id, reason: 'index_not_current' })
            process.exitCode = 1
            continue
          }
          report.successful.push({ room_key: id, generation: pointer.generation, version: bundle.version, source_revision: bundle.revision })
        } else report.successful.push(id)
      } catch (error) {
        report.failed.push({ room_key: id, error: error.message })
        process.exitCode = 1
      }
    }
    console.log(JSON.stringify(report))
  } finally { await pool.end() }
}
if (require.main === module) main().catch(e => { console.error('Compile failed: '+e.message); process.exitCode=1 })
